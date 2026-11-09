// Concurrency against real Postgres. PGlite has a single connection, so the
// other suites cannot exercise parallel transactions. Set TEST_DATABASE_URL to
// run these; each test creates and drops its own database, so nothing already
// in that server is touched.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { ChiefError, ChiefRegistry, type RepositoryCatalog } from "../src/chief/registry.js";
import { PostgresDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";

const serverUrl = process.env.TEST_DATABASE_URL?.trim();
const skip = serverUrl ? false : "TEST_DATABASE_URL is not set";
const context = { organizationId: "org-acme", workspaceId: "workspace-primary" };
const catalog: RepositoryCatalog = {
  connected: true,
  repositories: Array.from({ length: 40 }, (_, index) => ({
    id: String(index + 1),
    fullName: `Acme/repo-${index + 1}`,
  })),
};
const setup = (repositoryIds: string[], requestId: string = randomUUID()) => ({
  requestId,
  repositoryIds,
  placement: "dev-1",
  budgetDollars: 10,
  maxConcurrentTasks: 1,
  allowedActions: ["investigate"],
});
/** Waits for every call, so a failure cannot close the pool under the others. */
async function settled<T>(calls: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(calls);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    const reasons = [...new Set(failures.map(({ reason }) => String(reason?.code ? `${reason.code}: ${reason.message}` : reason)))];
    assert.fail(`${failures.length} of ${results.length} calls failed: ${reasons.join("; ")}`);
  }
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}
const range = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

async function fixture(t: test.TestContext) {
  const name = `chief_concurrency_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(serverUrl!);
  url.pathname = `/${name}`;
  const database = new PostgresDatabase(url.toString());
  t.after(async () => {
    await database.close();
    // The pool resolves before the server has finished closing its backends,
    // and terminating one of those surfaces as an unhandled client error.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const open = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1", [name]);
      if (open.rowCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await migrate(database);
  const registry = new ChiefRegistry({ database, repositories: { list: async () => catalog } });
  const count = async (sql: string) =>
    Number((await database.query<{ count: string }>(`SELECT count(*)::text AS count ${sql}`)).rows[0]!.count);
  const invariants = async () => {
    assert.equal(
      await count("FROM chief_slots s JOIN chiefs c ON c.id = s.chief_id WHERE c.state = 'awaiting_capacity'"),
      0,
      "a chief with a slot is still waiting for capacity",
    );
    assert.equal(
      await count("FROM chiefs c LEFT JOIN chief_slots s ON s.chief_id = c.id WHERE s.chief_id IS NULL AND c.state <> 'awaiting_capacity'"),
      0,
      "a chief left waiting for capacity has moved on without a slot",
    );
  };
  return { database, registry, count, invariants };
}

test("identical concurrent requests create one chief and claim one slot", { skip }, async (t) => {
  const { registry, count, invariants } = await fixture(t);
  await Promise.all(range(3).map((n) => registry.registerSlot({ slotId: `slot-0000000${n}` })));
  const body = setup(["1"]);
  const results = await settled(range(25).map(() => registry.create(context, body)));
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(await count("FROM chiefs"), 1);
  assert.equal(await count("FROM chief_slots WHERE state = 'assigned'"), 1);
  await invariants();
});

test("distinct concurrent requests never claim more slots than exist", { skip }, async (t) => {
  const { registry, count, invariants } = await fixture(t);
  await Promise.all(range(5).map((n) => registry.registerSlot({ slotId: `slot-0000000${n}` })));
  await settled(range(25).map((n) => registry.create(context, setup([String(n)]))));
  assert.equal(await count("FROM chiefs"), 25);
  assert.equal(await count("FROM chief_slots WHERE state = 'assigned'"), 5);
  assert.equal(await count("FROM chief_slots WHERE state = 'free'"), 0);
  assert.equal(await count("FROM chiefs WHERE state = 'awaiting_capacity'"), 20);
  await invariants();
});

test("concurrent requests for one repository leave exactly one chief", { skip }, async (t) => {
  const { registry, count, invariants } = await fixture(t);
  await Promise.all(range(3).map((n) => registry.registerSlot({ slotId: `slot-0000000${n}` })));
  const results = await Promise.allSettled(range(20).map(() => registry.create(context, setup(["7"]))));
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one request wins");
  for (const { reason } of rejected) {
    assert.ok(reason instanceof ChiefError, String(reason));
    assert.equal(reason.status, 409);
  }
  assert.equal(await count("FROM chiefs"), 1);
  assert.equal(await count("FROM chief_repositories"), 1);
  assert.equal(await count("FROM chief_slots WHERE state = 'assigned'"), 1);
  await invariants();
});

test("slots registered during concurrent creates leave no free slot beside a waiting chief", { skip }, async (t) => {
  const { registry, count, invariants } = await fixture(t);
  await settled<unknown>([
    ...range(20).map((n) => registry.create(context, setup([String(n)]))),
    ...range(8).map((n) => registry.registerSlot({ slotId: `slot-0000000${n}` })),
  ]);
  assert.equal(await count("FROM chief_slots"), 8);
  assert.equal(await count("FROM chief_slots WHERE state = 'assigned'"), 8);
  assert.equal(await count("FROM chiefs WHERE state = 'awaiting_capacity'"), 12);
  await invariants();
});
