import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ChiefRegistry, READINESS_CHECKS, type RelayAgentIssuer } from "../src/chief/registry.js";
import { relayControlAgentIssuer, secretCipher } from "../src/chief/relay-agents.js";
import { loadConfig } from "../src/config.js";
import { open, seal } from "../src/crypto.js";
import { ADMIN_TOKEN, startControl, tenant } from "./harness.js";

const key = { id: "k1", key: randomBytes(32) };
const RELAY_WORKSPACE = "100000000000000001";
const workers = [{ agentId: "worker-1", address: "worker@machine", actions: ["investigate"] }];

async function harness(t: test.TestContext, options: { configured?: boolean; issuer?: RelayAgentIssuer["issue"] } = {}) {
  const issued: unknown[][] = [];
  let count = 0;
  const issue: RelayAgentIssuer["issue"] = options.issuer ?? (async (workspaceId, chiefId) => {
    issued.push([workspaceId, chiefId]);
    count += 1;
    return { agentId: "agent-1", token: `relay-token-${count}`, relayWorkspaceId: RELAY_WORKSPACE };
  });
  const app = await startControl({
    operations: (database) => ({
      registry: new ChiefRegistry({
        database,
        repositories: { list: async () => ({ connected: true, repositories: [{ id: "1", fullName: "Acme/one" }] }) },
        ...(options.configured === false ? {} : { relayAgents: { issue }, tokenCipher: secretCipher(key) }),
      }),
    }),
  });
  t.after(() => app.stop());
  const operator = (path: string, body: unknown) => app.api(`/api/v1/operator/${path}`, { method: "POST", token: ADMIN_TOKEN, body });
  await operator("chief-slots", { slotId: "slot-aaaaaaaa" });
  const created = await app.api(`/api/v1/workspaces/${tenant.workspaceId}/chiefs`, {
    method: "POST", token: tenant.ownerToken,
    body: { requestId: randomUUID(), repositoryIds: ["1"], region: "us-east-1", budgetDollars: 10, maxConcurrentTasks: 1, allowedActions: ["investigate"] },
  });
  assert.equal(created.status, 202, created.text);
  const id = created.body.id as string;
  const credential = await operator(`chiefs/${id}/service-credential`, {});
  assert.equal(credential.status, 201, credential.text);
  const token = credential.body.token as string;
  const bind = (body: unknown = { workers }) => operator(`chiefs/${id}/identities`, body);
  const fetchRelay = (bearer: string = token) => app.api(`/chief/v1/projects/${id}/relay-credential`, { token: bearer });
  const config = async () => (await app.database.query<{ config: any }>("SELECT config FROM chiefs WHERE id = $1", [id])).rows[0]!.config;
  return { app, id, token, operator, bind, fetchRelay, config, issued };
}

test("binding without a caller registers the agent and the slot can fetch its token", async (t) => {
  const h = await harness(t);
  assert.equal((await h.fetchRelay()).status, 409);
  const bound = await h.bind();
  assert.equal(bound.status, 200, bound.text);
  assert.deepEqual(h.issued, [[tenant.workspaceId, h.id]]);
  const config = await h.config();
  assert.equal(config.relayCallerId, "agent-1");
  // Relay names its workspace differently from Control, and a chief refuses to run on a mismatch.
  assert.notEqual(RELAY_WORKSPACE, tenant.workspaceId);
  assert.equal(config.relayWorkspaceId, RELAY_WORKSPACE);
  assert.equal(config.workspaceId, tenant.workspaceId);
  assert.equal(config.revision, 2);
  const fetched = await h.fetchRelay();
  assert.equal(fetched.status, 200, fetched.text);
  assert.deepEqual(fetched.body, { agentId: "agent-1", token: "relay-token-1" });
});

test("the token is encrypted at rest and never in an operator response", async (t) => {
  const h = await harness(t);
  const bound = await h.bind();
  assert.equal(bound.text.includes("relay-token-1"), false);
  const row = (await h.app.database.query<{ token_ciphertext: string }>("SELECT token_ciphertext FROM chief_relay_credentials")).rows[0]!;
  assert.equal(row.token_ciphertext.includes("relay-token-1"), false);
  assert.equal(open(row.token_ciphertext, key), "relay-token-1");
});

test("a repeat bind reuses the agent rather than rotating its token", async (t) => {
  const h = await harness(t);
  await h.bind();
  const again = await h.bind({ workers: [{ ...workers[0], agentId: "worker-2", address: "two@machine" }] });
  assert.equal(again.status, 200, again.text);
  assert.equal(h.issued.length, 1);
  assert.equal((await h.fetchRelay()).body.token, "relay-token-1");
});

test("an explicit caller still works and retires any platform token", async (t) => {
  const h = await harness(t);
  await h.bind();
  assert.equal((await h.bind({ relayCallerId: "hand-registered", workers })).status, 200);
  assert.equal((await h.config()).relayCallerId, "hand-registered");
  assert.equal((await h.fetchRelay()).status, 409);
  assert.equal(h.issued.length, 1);
});

test("a ready chief is not re-registered", async (t) => {
  const h = await harness(t);
  await h.bind({ relayCallerId: "hand-registered", workers });
  const binding = await h.app.api("/api/v1/operator/chief-slots/slot-aaaaaaaa/binding", { token: ADMIN_TOKEN });
  const ready = await h.operator(`chiefs/${h.id}/ready`, {
    configurationDigest: binding.body.configurationDigest, attestedBy: "operator",
    checks: READINESS_CHECKS.map((name) => ({ name, passed: true })),
  });
  assert.equal(ready.status, 200, ready.text);
  const refused = await h.bind();
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "chief_already_ready");
  assert.equal(h.issued.length, 0);
});

test("the credential route is only for that chief's own service credential", async (t) => {
  const h = await harness(t);
  await h.bind();
  assert.equal((await h.fetchRelay("sh_chief_wrong")).status, 401);
  assert.equal((await h.fetchRelay(tenant.ownerToken)).status, 401);
  assert.equal((await h.app.api(`/chief/v1/projects/${h.id}/relay-credential`)).status, 401);
});

test("without registration configured, a caller is required", async (t) => {
  const h = await harness(t, { configured: false });
  const answer = await h.bind();
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error, "relay_identity_unavailable");
  assert.equal((await h.bind({ relayCallerId: "hand-registered", workers })).status, 200);
});

test("an agent that matches a worker is refused", async (t) => {
  const h = await harness(t, { issuer: async () => ({ agentId: "worker-1", token: "t", relayWorkspaceId: "relay-ws" }) });
  assert.equal((await h.bind()).status, 400);
});

test("the issuer sends its secret and maps relay-control's answers", async (t) => {
  const requests: { url: string; authorization?: string; body: string }[] = [];
  let status = 200;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ url: request.url!, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ agentId: "a", agentName: "n", token: "t", relayWorkspaceId: "w" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const issuer = relayControlAgentIssuer({ relayControlUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: "relay-secret" });
  assert.deepEqual(await issuer.issue("ws-1", "chief-1"), { agentId: "a", token: "t", relayWorkspaceId: "w" });
  assert.deepEqual(requests[0], { url: "/internal/v1/chief/workspaces/ws-1/relay-agents", authorization: "Bearer relay-secret", body: '{"chiefId":"chief-1"}' });
  status = 409;
  await assert.rejects(issuer.issue("ws-1", "chief-1"), { status: 409, code: "relay_agent_conflict" });
  status = 502;
  await assert.rejects(issuer.issue("ws-1", "chief-1"), { status: 503, code: "relay_identity_unavailable" });
});

test("sealed values refuse the wrong key and tampering", () => {
  const sealed = seal("value", key);
  assert.equal(open(sealed, key), "value");
  assert.throws(() => open(sealed, { id: "k2", key: key.key }));
  assert.throws(() => open(sealed, { id: "k1", key: randomBytes(32) }));
  assert.throws(() => open(`${sealed.slice(0, -2)}AA`, key));
});

test("relay identity configuration is all or nothing", () => {
  const env = {
    DATABASE_URL: "postgres://localhost/chief",
    RELAYCONTROL_URL: "http://control.internal",
    RELAYCONTROL_INTROSPECT_SECRET: "s".repeat(32),
    RELAYCHIEF_CONTROL_PUBLIC_ORIGIN: "https://chief.example.com",
    RELAYCHIEF_CONTROL_ADMIN_TOKEN: "a".repeat(32),
  };
  const full = { RELAYCHIEF_CONTROL_RELAY_SECRET: "r".repeat(32), RELAYCHIEF_CONTROL_ENCRYPTION_KEY_ID: "k1", RELAYCHIEF_CONTROL_ENCRYPTION_KEY: "ab".repeat(32) };
  assert.equal(loadConfig(env).relayIdentity, null);
  assert.equal(loadConfig({ ...env, ...full }).relayIdentity?.key.id, "k1");
  for (const name of Object.keys(full)) {
    const partial: Record<string, string> = { ...env, ...full };
    delete partial[name];
    assert.throws(() => loadConfig(partial), new RegExp(name));
  }
  assert.throws(() => loadConfig({ ...env, ...full, RELAYCHIEF_CONTROL_ENCRYPTION_KEY: "short" }), /64 hex/);
});
