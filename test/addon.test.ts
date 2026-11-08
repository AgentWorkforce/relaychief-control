import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { relayControlIntrospector } from "../src/auth/introspection.js";
import { ChiefRegistry } from "../src/chief/registry.js";
import { migrate } from "../src/migrations.js";
import { ADMIN_TOKEN, startControl, tenant } from "./harness.js";

const SLOT = "slot-aaaaaaaa";

async function chiefWithCredential(t: test.TestContext) {
  const app = await startControl({
    operations: (database) => ({
      registry: new ChiefRegistry({
        database,
        repositories: {
          list: async () => ({ connected: true, repositories: [{ id: "1", fullName: "Acme/one" }] }),
        },
      }),
    }),
  });
  t.after(() => app.stop());
  const operator = (path: string, body: unknown) =>
    app.api(`/api/v1/operator/${path}`, { method: "POST", token: ADMIN_TOKEN, body });
  await operator("chief-slots", { slotId: SLOT });
  const created = await app.api(`/api/v1/workspaces/${tenant.workspaceId}/chiefs`, {
    method: "POST",
    token: tenant.ownerToken,
    body: {
      requestId: randomUUID(),
      repositoryIds: ["1"],
      placement: "default",
      budgetDollars: 10,
      maxConcurrentTasks: 1,
      allowedActions: ["investigate"],
    },
  });
  assert.equal(created.status, 202);
  const issued = await operator(`chiefs/${created.body.id}/service-credential`, {});
  return { app, id: created.body.id as string, token: issued.body.token as string };
}

// The expected value is computed from the literal canonical text, independently
// of the service, and matches relay-chief's sorted-key form.
function fixture(id: string) {
  const assignment = {
    protocol: "relay-chief.assignment.v1",
    workspaceId: tenant.workspaceId,
    taskId: "task-1",
    projectId: id,
    organizationId: tenant.organizationId,
    chiefId: id,
    resourceKeys: ["b", "a"],
  };
  const text =
    `{"chiefId":"${id}","organizationId":"${tenant.organizationId}","projectId":"${id}",` +
    `"protocol":"relay-chief.assignment.v1","resourceKeys":["b","a"],"taskId":"task-1",` +
    `"workspaceId":"${tenant.workspaceId}"}`;
  return { assignment, assignmentDigest: createHash("sha256").update(text).digest("hex") };
}

test("operator routes exist only on the admin listener", async (t) => {
  const app = await startControl();
  t.after(() => app.stop());
  const response = await app.publicApi("/api/v1/operator/chief-slots", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { slotId: SLOT },
  });
  assert.equal(response.status, 404);
});

test("an assignment is immutable, bound to the credential, and replays safely", async (t) => {
  const { app, id, token } = await chiefWithCredential(t);
  const body = fixture(id);
  const put = (task: string, payload: unknown, credential: string | undefined = token) =>
    app.api(`/chief/v1/projects/${id}/tasks/${task}/assignment`, {
      method: "PUT",
      ...(credential ? { token: credential } : {}),
      body: payload,
    });

  assert.equal((await put("task-1", body, "")).status, 401);
  assert.equal((await put("task-1", body, tenant.ownerToken)).status, 401);

  const created = await put("task-1", body);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { created: true, taskId: "task-1", assignmentDigest: body.assignmentDigest });
  assert.equal((await put("task-1", body)).status, 200);

  const changed = { ...body.assignment, resourceKeys: ["c"] };
  const digest = createHash("sha256")
    .update(
      `{"chiefId":"${id}","organizationId":"${tenant.organizationId}","projectId":"${id}",` +
        `"protocol":"relay-chief.assignment.v1","resourceKeys":["c"],"taskId":"task-1",` +
        `"workspaceId":"${tenant.workspaceId}"}`,
    )
    .digest("hex");
  const conflict = await put("task-1", { assignment: changed, assignmentDigest: digest });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "assignment_conflict");

  const stored = await app.database.query<{ digest: string }>(
    "SELECT digest FROM chief_assignments WHERE chief_id = $1",
    [id],
  );
  assert.deepEqual(stored.rows, [{ digest: body.assignmentDigest }]);
});

test("an assignment with a wrong digest or identity is refused", async (t) => {
  const { app, id, token } = await chiefWithCredential(t);
  const body = fixture(id);
  const put = (task: string, payload: unknown) =>
    app.api(`/chief/v1/projects/${id}/tasks/${task}/assignment`, { method: "PUT", token, body: payload });

  const digest = await put("task-1", { ...body, assignmentDigest: "0".repeat(64) });
  assert.equal(digest.body.error, "assignment_digest_mismatch");
  assert.equal((await put("task-2", body)).body.error, "assignment_identity_mismatch");
  const foreign = await put("task-1", { ...body, assignment: { ...body.assignment, workspaceId: "someone-else" } });
  assert.equal(foreign.body.error, "assignment_identity_mismatch");
  assert.equal((await put("task-1", { assignmentDigest: body.assignmentDigest })).status, 400);
  assert.equal(
    (await app.database.query("SELECT 1 FROM chief_assignments")).rows.length,
    0,
  );
});

test("the introspection client sends the audience and fails closed", async () => {
  const calls: { url: string; authorization: string | null; body: unknown }[] = [];
  let reply: () => Response = () =>
    Response.json({ active: true, principal_type: "desktop-user", org: "o", workspace: "w", role: "admin" });
  const introspect = relayControlIntrospector({
    relayControlUrl: "https://control.example",
    secret: "s".repeat(32),
    audience: "https://chief.example",
    fetch: (async (url: URL, init: RequestInit) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)),
      });
      return reply();
    }) as typeof fetch,
  });

  assert.equal((await introspect("sh_at_x", "w")).active, true);
  assert.deepEqual(calls[0], {
    url: "https://control.example/internal/v1/auth/introspect",
    authorization: `Bearer ${"s".repeat(32)}`,
    body: { token: "sh_at_x", aud: "https://chief.example", workspace: "w" },
  });

  reply = () => Response.json({ active: false, reason: "expired" });
  assert.deepEqual(await introspect("sh_at_x", "w"), { active: false, reason: "expired" });
  for (const failure of [
    () => new Response("no", { status: 500 }),
    () => Response.json({ active: true }),
    () => new Response("not json"),
  ]) {
    reply = failure;
    await assert.rejects(introspect("sh_at_x", "w"), { code: "identity_unavailable" });
  }
});

test("migrations apply once and health needs no add-on peers", async (t) => {
  const app = await startControl();
  t.after(() => app.stop());
  assert.deepEqual(await migrate(app.database), []);
  assert.equal((await app.publicApi("/healthz")).status, 200);
  assert.equal((await app.publicApi("/readyz")).status, 200);
});
