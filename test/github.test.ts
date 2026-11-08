import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { GithubBindings, NangoGithubRepositories, nangoClient, type NangoClient } from "../src/chief/github.js";
import { ChiefRegistry } from "../src/chief/registry.js";
import { loadConfig } from "../src/config.js";
import { ADMIN_TOKEN, startControl, tenant } from "./harness.js";

const repo = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, full_name: `Acme/${name}`, private: true, ...extra,
});
const context = { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId };
const binding = { organizationId: tenant.organizationId, connectionId: "conn-1", providerConfigKey: "github-app" };

async function harness(t: test.TestContext, get: NangoClient["get"]) {
  const app = await startControl({
    operations: (database) => {
      const githubBindings = new GithubBindings(database);
      return {
        githubBindings,
        registry: new ChiefRegistry({
          database,
          repositories: new NangoGithubRepositories({ binding: (c) => githubBindings.get(c), nango: { get } }),
        }),
      };
    },
  });
  t.after(() => app.stop());
  const path = `/api/v1/operator/workspaces/${tenant.workspaceId}/github-binding`;
  const bind = (body: unknown = binding, token = ADMIN_TOKEN) => app.api(path, { method: "PUT", token, body });
  const catalog = () => app.api(`/api/v1/workspaces/${tenant.workspaceId}/chiefs/repositories`, { token: tenant.ownerToken });
  return { app, path, bind, catalog };
}

test("the catalog pages through the installation and drops archived and disabled repositories", async () => {
  const pages: Record<string, unknown[]> = {
    "1": [repo(2, "zeta"), ...Array.from({ length: 98 }, (_, i) => repo(100 + i, `r${i}`)), repo(3, "gone", { archived: true })],
    "2": [repo(1, "alpha"), repo(4, "off", { disabled: true })],
  };
  const seen: unknown[] = [];
  const source = new NangoGithubRepositories({
    binding: async () => ({ connectionId: "conn-1", providerConfigKey: "github-app" }),
    nango: {
      get: async (input) => {
        seen.push(input);
        return { data: { total_count: 102, repositories: pages[input.params.page!] } };
      },
    },
  });
  const result = await source.list(context);
  assert.equal(result.connected, true);
  assert.equal(result.repositories.length, 100);
  assert.deepEqual(result.repositories[0], { id: "1", fullName: "Acme/alpha" });
  assert.equal(result.repositories.some((r) => r.fullName === "Acme/gone" || r.fullName === "Acme/off"), false);
  assert.deepEqual(seen[1], {
    connectionId: "conn-1", providerConfigKey: "github-app", endpoint: "/installation/repositories",
    params: { per_page: "100", page: "2" },
  });
});

test("an unbound workspace is not connected and a chief cannot be created", async (t) => {
  let calls = 0;
  const h = await harness(t, async () => { calls += 1; return { data: {} }; });
  const catalog = await h.catalog();
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body, { connected: false, repositories: [] });
  const created = await h.app.api(`/api/v1/workspaces/${tenant.workspaceId}/chiefs`, {
    method: "POST", token: tenant.ownerToken,
    body: { requestId: randomUUID(), repositoryIds: ["1"], region: "us-east-1", budgetDollars: 10, maxConcurrentTasks: 1, allowedActions: ["investigate"] },
  });
  assert.equal(created.status, 409);
  assert.equal(created.body.error, "github_disconnected");
  assert.equal(calls, 0);
});

test("a bound workspace can create a chief from its GitHub catalog", async (t) => {
  const h = await harness(t, async () => ({ data: { total_count: 1, repositories: [repo(1, "one")] } }));
  assert.equal((await h.bind()).status, 200);
  const catalog = await h.catalog();
  assert.deepEqual(catalog.body, { connected: true, repositories: [{ id: "1", fullName: "Acme/one" }] });
  const created = await h.app.api(`/api/v1/workspaces/${tenant.workspaceId}/chiefs`, {
    method: "POST", token: tenant.ownerToken,
    body: { requestId: randomUUID(), repositoryIds: ["1"], region: "us-east-1", budgetDollars: 10, maxConcurrentTasks: 1, allowedActions: ["investigate"] },
  });
  assert.equal(created.status, 202, created.text);
});

test("provider failures and incomplete catalogs answer 503 without provider detail", async (t) => {
  let reply: () => Promise<{ data: unknown }> = async () => { throw new Error("leaked-provider-detail"); };
  const h = await harness(t, () => reply());
  await h.bind();
  for (const next of [
    reply,
    async () => ({ data: { repositories: "leaked-provider-detail" } }),
    async () => ({ data: { total_count: 5, repositories: [] } }),
  ]) {
    reply = next;
    const catalog = await h.catalog();
    assert.equal(catalog.status, 503);
    assert.equal(catalog.body.error, "chief_unavailable");
    assert.equal(catalog.text.includes("leaked-provider-detail"), false);
  }
});

test("only the operator can bind, and a workspace cannot move between organizations", async (t) => {
  const h = await harness(t, async () => ({ data: { total_count: 0, repositories: [] } }));
  assert.equal((await h.bind(binding, "wrong-token")).status, 403);
  assert.equal((await h.bind({ ...binding, extra: true })).status, 400);
  assert.equal((await h.bind({ organizationId: tenant.organizationId })).status, 400);
  assert.equal((await h.app.api(h.path)).status, 401);
  assert.equal((await h.app.api(h.path, { token: ADMIN_TOKEN })).status, 405);
  assert.equal((await h.app.publicApi(h.path, { method: "PUT", token: ADMIN_TOKEN, body: binding })).status, 404);

  const saved = await h.bind();
  assert.equal(saved.status, 200);
  assert.equal(saved.text.includes("conn-1"), false);
  const moved = await h.bind({ ...binding, organizationId: "org-other" });
  assert.equal(moved.status, 409);
  assert.equal(moved.body.error, "github_binding_organization_conflict");
  assert.equal((await h.bind({ ...binding, connectionId: "conn-2" })).status, 200);
  const audit = await h.app.database.query("SELECT action FROM chief_audit_events WHERE action = 'chief.github_binding_set'");
  assert.equal(audit.rows.length, 2);
});

test("a binding is only read inside its own organization", async (t) => {
  const h = await harness(t, async () => ({ data: { total_count: 0, repositories: [] } }));
  await h.bind();
  const bindings = new GithubBindings(h.app.database);
  assert.equal((await bindings.get(context))?.connectionId, "conn-1");
  assert.equal(await bindings.get({ ...context, organizationId: "org-other" }), null);
});

test("the Nango client sends the binding as headers, keeps the secret out of the URL and refuses failures", async (t) => {
  const requests: { url: string; headers: Record<string, unknown> }[] = [];
  let status = 200;
  const server = createServer((request, response) => {
    requests.push({ url: request.url!, headers: request.headers });
    response.writeHead(status, status === 302 ? { location: "http://127.0.0.1:1/elsewhere" } : { "content-type": "application/json" });
    response.end(JSON.stringify({ total_count: 0, repositories: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = nangoClient({ host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secretKey: "nango-secret" });
  const input = { endpoint: "/installation/repositories", connectionId: "conn-1", providerConfigKey: "github-app", params: { per_page: "100", page: "1" } };
  assert.deepEqual((await client.get(input)).data, { total_count: 0, repositories: [] });
  assert.equal(requests[0]!.url, "/proxy/installation/repositories?per_page=100&page=1");
  assert.equal(requests[0]!.headers.authorization, "Bearer nango-secret");
  assert.equal(requests[0]!.headers["connection-id"], "conn-1");
  assert.equal(requests[0]!.headers["provider-config-key"], "github-app");
  for (status of [401, 500, 302]) await assert.rejects(client.get(input));
  assert.equal(requests.length, 4);
});

test("Nango configuration is optional and a host alone is refused", () => {
  const env = {
    DATABASE_URL: "postgres://localhost/chief",
    RELAYCONTROL_URL: "http://control.internal",
    RELAYCONTROL_INTROSPECT_SECRET: "s".repeat(32),
    RELAYCHIEF_CONTROL_PUBLIC_ORIGIN: "https://chief.example.com",
    RELAYCHIEF_CONTROL_ADMIN_TOKEN: "a".repeat(32),
  };
  assert.equal(loadConfig(env).nango, null);
  assert.deepEqual(loadConfig({ ...env, NANGO_SECRET_KEY: "key" }).nango, { host: "https://api.nango.dev", secretKey: "key" });
  assert.deepEqual(loadConfig({ ...env, NANGO_SECRET_KEY: "key", NANGO_HOST: "https://nango.internal/" }).nango, { host: "https://nango.internal", secretKey: "key" });
  assert.throws(() => loadConfig({ ...env, NANGO_HOST: "https://nango.internal" }), /requires NANGO_SECRET_KEY/);
});
