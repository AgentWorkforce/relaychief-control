import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { GithubChiefAuthority } from "../src/chief/authority.js";
import { GithubBindings } from "../src/chief/github.js";
import { ChiefRegistry, digestOf } from "../src/chief/registry.js";
import { ADMIN_TOKEN, startControl, tenant } from "./harness.js";

const NOW = Date.now();
const LATER = new Date(NOW + 60_000).toISOString();
const SHA = "a".repeat(40);
const issue = (number: number, updated_at: string, extra: Record<string, unknown> = {}) => ({
  number, title: `Item ${number}`, body: `Body ${number}`, html_url: `https://github.com/acme/one/issues/${number}`, updated_at, ...extra,
});
const pr = (number: number, updated_at: string) => issue(number, updated_at, { pull_request: {} });
const link = (numbers: [number, string?][], headRefName = "fix/branch") => ({
  headRefName,
  closingIssuesReferences: { nodes: numbers.map(([number, repo]) => ({ number, repository: { nameWithOwner: repo ?? "Acme/One" } })) },
});
const run = (name: string, conclusion: string | null = "SUCCESS", extra: Record<string, unknown> = {}) => ({
  __typename: "CheckRun", name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion, startedAt: LATER, isRequired: true, ...extra,
});
const pullRequest = (contexts: unknown[], extra: Record<string, unknown> = {}, named: string[] | null = null) => ({
  repository: {
    pullRequest: {
      number: 7, state: "OPEN", headRefOid: SHA,
      baseRef: { refUpdateRule: named ? { requiredStatusCheckContexts: named } : null },
      commits: { nodes: [{ commit: { oid: SHA, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: contexts } } } }] },
      ...extra,
    },
  },
});

type Fake = {
  issues: Record<string, unknown[] | (() => unknown)>;
  links: Record<string, unknown>;
  candidates: { number: number; state: string }[];
  pull: unknown;
  errors?: unknown[];
  gets: { endpoint: string; params: Record<string, string> }[];
};

async function harness(t: test.TestContext, overrides: Partial<Fake> = {}) {
  const fake: Fake = { issues: {}, links: {}, candidates: [], pull: pullRequest([run("ci")]), gets: [], ...overrides };
  const app = await startControl({
    operations: (database) => {
      const githubBindings = new GithubBindings(database);
      const registry = new ChiefRegistry({
        database,
        repositories: { list: async () => ({ connected: true, repositories: [{ id: "1", fullName: "Acme/One" }, { id: "2", fullName: "Acme/Two" }] }) },
        identities: () => ({ relayCallerId: "caller-1", workers: [{ agentId: "w", address: "w@m", actions: ["investigate"] }] }),
      });
      return {
        registry,
        githubBindings,
        authority: new GithubChiefAuthority({
          registry,
          bindings: githubBindings,
          now: () => NOW,
          nango: {
            get: async ({ endpoint, params }) => {
              fake.gets.push({ endpoint, params });
              const reply = fake.issues[endpoint] ?? [];
              if (typeof reply === "function") return { data: reply() };
              // GitHub's `since` is inclusive: only items updated at or after it come back.
              return { data: reply.filter((item) => Date.parse((item as { updated_at: string }).updated_at) >= Date.parse(params.since!)) };
            },
            post: async ({ body }) => {
              const query = (body as { query: string }).query;
              const data = query.includes("statusCheckRollup")
                ? fake.pull
                : query.includes("closedByPullRequestsReferences")
                  ? { repository: { issue: { closedByPullRequestsReferences: { nodes: fake.candidates } } } }
                  : { repository: fake.links };
              return { data: { data, ...(fake.errors ? { errors: fake.errors } : {}) } };
            },
          },
        }),
      };
    },
  });
  t.after(() => app.stop());
  const operator = (path: string, body: unknown, method = "POST") => app.api(`/api/v1/operator/${path}`, { method, token: ADMIN_TOKEN, body });
  await operator("chief-slots", { slotId: "slot-aaaaaaaa" });
  const created = await app.api(`/api/v1/workspaces/${tenant.workspaceId}/chiefs`, {
    method: "POST", token: tenant.ownerToken,
    body: { requestId: randomUUID(), repositoryIds: ["1", "2"], region: "us-east-1", budgetDollars: 10, maxConcurrentTasks: 1, allowedActions: ["investigate"] },
  });
  assert.equal(created.status, 202, created.text);
  const id = created.body.id as string;
  const issued = await operator(`chiefs/${id}/service-credential`, {});
  assert.equal(issued.status, 201, issued.text);
  const token = issued.body.token as string;
  const bind = () => operator(`workspaces/${tenant.workspaceId}/github-binding`, { organizationId: tenant.organizationId, connectionId: "c", providerConfigKey: "k" }, "PUT");
  await bind();
  const evidence = (query = "") => app.api(`/chief/v1/projects/${id}/evidence${query}`, { token });
  const assign = async (workKey: string, repository = "acme/one", taskId = "task-1") => {
    const assignment = {
      protocol: "relay-chief.assignment.v1", taskId, chiefId: id, organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId, projectId: id, repository, workKey,
    };
    const assignmentDigest = digestOf(assignment);
    const saved = await app.api(`/chief/v1/projects/${id}/tasks/${taskId}/assignment`, { method: "PUT", token, body: { assignmentDigest, assignment } });
    assert.equal(saved.status, 201, saved.text);
    return assignmentDigest;
  };
  const verify = (taskId = "task-1", sequence = 3) => app.api(`/chief/v1/projects/${id}/tasks/${taskId}/verification?sequence=${sequence}`, { token });
  return { app, fake, id, evidence, assign, verify };
}

const ISSUES = "/repos/acme/one/issues";
const T1 = new Date(NOW - 60_000).toISOString();
const T2 = new Date(NOW - 30_000).toISOString();

test("evidence matches the chief's schema and derives work from GitHub links", async (t) => {
  const h = await harness(t, {
    issues: { [ISSUES]: [issue(1, T1), pr(2, T1), pr(3, T1), pr(4, T1), pr(5, T1)] },
    links: {
      p2: link([[1]], "fix/one"), p3: link([]),
      p4: link([[1], [9]]), p5: link([[6, "other/repo"]]),
    },
  });
  const page = await h.evidence();
  assert.equal(page.status, 200, page.text);
  const byId = new Map<string, any>(page.body.evidence.map((item: any) => [item.sessionId, item]));
  const first = byId.get("github:issue:acme/one#1");
  assert.deepEqual(Object.keys(first).sort(), [
    "observedAt", "organizationId", "projectId", "references", "repository", "resourceKeys",
    "sessionId", "sourceId", "summary", "version", "workKey", "workspaceId",
  ]);
  assert.equal(first.sourceId, "project-sessions-v1");
  assert.equal(first.workKey, "github:issue:acme/one#1");
  assert.equal(first.projectId, h.id);
  assert.equal(first.observedAt, Date.parse(T1));

  const linked = byId.get("github:pr:acme/one#2");
  assert.equal(linked.workKey, "github:issue:acme/one#1");
  assert.deepEqual(linked.resourceKeys, ["github:pr:acme/one#2", "github:branch:acme/one:fix/one", "github:issue:acme/one#1"]);
  assert.equal(byId.get("github:pr:acme/one#3").workKey, "github:pr:acme/one#3");

  const ambiguous = byId.get("github:pr:acme/one#4");
  assert.equal(ambiguous.workKey, "github:pr:acme/one#4");
  assert.match(ambiguous.summary, /^Ambiguous work link/);
  assert(ambiguous.resourceKeys.includes("github:issue:acme/one#9"));

  const foreign = byId.get("github:pr:acme/one#5");
  assert.equal(foreign.workKey, "github:pr:acme/one#5");
  assert.match(foreign.summary, /other\/repo#6/);
});

test("the first read starts at the evidence age limit and later reads never repeat a tie", async (t) => {
  const h = await harness(t, { issues: { [ISSUES]: [issue(1, T1), issue(2, T2), issue(3, T2)] } });
  const first = await h.evidence("?limit=2");
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body.evidence.map((item: any) => item.sessionId).sort().length, 2);
  assert.equal(h.fake.gets[0]!.params.since, new Date(NOW - 3_600_000).toISOString());
  const next = await h.evidence(`?limit=2&cursor=${encodeURIComponent(first.body.cursor)}`);
  assert.equal(next.status, 200, next.text);
  assert.equal(next.body.evidence.length, 1);
  assert.equal(h.fake.gets.at(-1)!.params.since, T2);
  const seen = [...first.body.evidence, ...next.body.evidence].map((item: any) => item.sessionId);
  assert.equal(new Set(seen).size, 3);
  const drained = await h.evidence(`?limit=2&cursor=${encodeURIComponent(next.body.cursor)}`);
  assert.equal(drained.body.evidence.length, 0);
  assert.ok(drained.body.cursor);
  assert.equal((await h.evidence("?cursor=not-a-cursor")).status, 400);
});

test("evidence merges repositories oldest first within the limit", async (t) => {
  const h = await harness(t, {
    issues: {
      [ISSUES]: [issue(1, T2)],
      "/repos/acme/two/issues": [issue(2, T1)],
    },
  });
  const page = await h.evidence("?limit=1");
  assert.equal(page.body.evidence.length, 1);
  assert.equal(page.body.evidence[0].repository, "acme/two");
});

test("evidence fails closed on provider errors without detail", async (t) => {
  const h = await harness(t, { issues: { [ISSUES]: () => ({ message: "leaked-provider-detail" }) } });
  const page = await h.evidence();
  assert.equal(page.status, 503);
  assert.equal(page.text.includes("leaked-provider-detail"), false);
});

test("a green pull request verifies against the registered assignment", async (t) => {
  const h = await harness(t);
  const digest = await h.assign("github:pr:acme/one#7");
  const result = await h.verify();
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.assignmentDigest, digest);
  assert.equal(result.body.sequence, 3);
  assert.deepEqual(result.body.checks, ["pull_request:acme/one#7:open", `head:${SHA}`, "required_check:ci:success"]);
});

test("an issue resolves to its one live pull request", async (t) => {
  const h = await harness(t, { candidates: [{ number: 7, state: "OPEN" }, { number: 8, state: "CLOSED" }] });
  await h.assign("github:issue:acme/one#1");
  const result = await h.verify();
  assert.equal(result.body.ok, true, result.text);

  h.fake.candidates = [];
  assert.deepEqual((await h.verify()).body.checks, ["no_pull_request"]);
  h.fake.candidates = [{ number: 7, state: "OPEN" }, { number: 8, state: "MERGED" }];
  const ambiguous = await h.verify();
  assert.equal(ambiguous.body.ok, false);
  assert.deepEqual(ambiguous.body.checks, ["pull_request_ambiguous:7,8"]);
});

test("verification refuses anything short of proof", async (t) => {
  const old = "2020-01-01T00:00:00Z";
  const h = await harness(t);
  await h.assign("github:pr:acme/one#7");
  const cases: [unknown, string][] = [
    [pullRequest([run("ci", null)]), "required_check_failed:ci:PENDING"],
    [pullRequest([run("ci", "FAILURE")]), "required_check_failed:ci:FAILURE"],
    [pullRequest([run("ci"), run("lint", "CANCELLED")]), "required_check_failed:lint:CANCELLED"],
    [pullRequest([run("optional", "SUCCESS", { isRequired: false })]), "no_required_checks"],
    [pullRequest([run("ci")], {}, ["ci", "deploy"]), "required_check_missing:deploy"],
    [pullRequest([run("ci", "SUCCESS", { startedAt: old })]), "checks_predate_assignment"],
    [pullRequest([run("ci", "SKIPPED")]), "checks_predate_assignment"],
    [pullRequest([run("ci")], { state: "CLOSED" }), "pull_request_closed"],
    [pullRequest([run("ci")], { headRefOid: "b".repeat(40) }), "head_commit_unresolved"],
    [pullRequest([run("ci")], { commits: { nodes: [{ commit: { oid: SHA, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: true }, nodes: [run("ci")] } } } }] } }), "checks_incomplete"],
    [pullRequest([], { commits: { nodes: [{ commit: { oid: SHA, statusCheckRollup: null } }] } }), "no_required_checks"],
  ];
  for (const [pull, reason] of cases) {
    h.fake.pull = pull;
    const result = await h.verify();
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.ok, false, reason);
    assert.deepEqual(result.body.checks, [reason]);
  }
});

test("a merged pull request and a status context both count", async (t) => {
  const status = { __typename: "StatusContext", context: "legacy", state: "SUCCESS", createdAt: LATER, isRequired: true };
  const h = await harness(t, { pull: pullRequest([status], { state: "MERGED" }, ["legacy"]) });
  await h.assign("github:pr:acme/one#7");
  const result = await h.verify();
  assert.equal(result.body.ok, true, result.text);
  assert.equal(result.body.checks[0], "pull_request:acme/one#7:merged");
});

test("the assignment bounds what can be verified", async (t) => {
  const h = await harness(t);
  assert.equal((await h.verify("unregistered")).status, 404);
  await h.assign("session:free-text", "acme/one", "task-free");
  assert.deepEqual((await h.verify("task-free")).body.checks, ["work_key_unverifiable"]);
  await h.assign("github:pr:other/repo#7", "other/repo", "task-outside");
  assert.deepEqual((await h.verify("task-outside")).body.checks, ["work_key_unverifiable"]);
  await h.assign("github:pr:acme/two#7", "acme/one", "task-mixed");
  assert.deepEqual((await h.verify("task-mixed")).body.checks, ["work_key_unverifiable"]);
  assert.equal(h.fake.gets.length, 0);
});

test("GitHub errors never produce a verdict", async (t) => {
  const h = await harness(t, { errors: [{ message: "leaked-provider-detail" }] });
  await h.assign("github:pr:acme/one#7");
  const result = await h.verify();
  assert.equal(result.status, 503);
  assert.equal(result.text.includes("leaked-provider-detail"), false);
  h.fake.errors = undefined;
  h.fake.pull = { repository: { pullRequest: { state: "OPEN" } } };
  assert.equal((await h.verify()).status, 503);
});
