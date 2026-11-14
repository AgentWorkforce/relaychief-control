import { createHash } from "node:crypto";
import { z } from "zod";
import type { GithubBinding, GithubBindings, NangoClient, NangoGraphql } from "./github.js";
import type { ChiefAuthority } from "./operations.js";
import { ChiefError, type ChiefRegistry, type WorkspaceContext } from "./registry.js";

type ProjectContext = WorkspaceContext & { projectId: string };

/** The source identity relay-chief's control-plane client requires on every record. */
const SOURCE_ID = "project-sessions-v1";
const MAX_SEEN = 170;
const MAX_PAGES = 5;
const MAX_LINKS = 10;
const SUMMARY_BODY_LIMIT = 4_000;

const issueSchema = z.array(
  z.object({
    number: z.number().int().positive().safe(),
    title: z.string(),
    body: z.string().nullish(),
    html_url: z.string().url().max(2_000),
    updated_at: z.string().min(1).max(64),
    pull_request: z.unknown().optional(),
  }),
);
type Issue = z.infer<typeof issueSchema>[number];
type Changed = Issue & { repository: string; updatedMs: number; identity: string };

const linkedSchema = z.object({
  headRefName: z.string().min(1).max(255),
  closingIssuesReferences: z.object({
    nodes: z.array(z.object({ number: z.number().int().positive().safe(), repository: z.object({ nameWithOwner: z.string() }) })),
  }),
});

const candidatesSchema = z.object({
  repository: z.object({
    issue: z.object({
      closedByPullRequestsReferences: z.object({
        nodes: z.array(z.object({ number: z.number().int().positive().safe(), state: z.enum(["OPEN", "CLOSED", "MERGED"]) })),
      }),
    }),
  }),
});

const contextSchema = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    name: z.string().min(1),
    status: z.string(),
    conclusion: z.string().nullable(),
    startedAt: z.string().nullable(),
    isRequired: z.boolean(),
  }),
  z.object({
    __typename: z.literal("StatusContext"),
    context: z.string().min(1),
    state: z.string(),
    createdAt: z.string(),
    isRequired: z.boolean(),
  }),
]);

const pullRequestSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      number: z.number().int().positive().safe(),
      state: z.enum(["OPEN", "CLOSED", "MERGED"]),
      headRefOid: z.string().regex(/^[a-f0-9]{40,64}$/),
      baseRef: z.object({ refUpdateRule: z.object({ requiredStatusCheckContexts: z.array(z.string().nullable()).nullable() }).nullable() }).nullable(),
      commits: z.object({
        nodes: z.array(
          z.object({
            commit: z.object({
              oid: z.string(),
              statusCheckRollup: z.object({
                contexts: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(contextSchema) }),
              }).nullable(),
            }),
          }),
        ),
      }),
    }),
  }),
});

const PULL_REQUEST_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
number state headRefOid baseRef{refUpdateRule{requiredStatusCheckContexts}}
commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){pageInfo{hasNextPage}nodes{__typename
...on CheckRun{name status conclusion startedAt isRequired(pullRequestNumber:$number)}
...on StatusContext{context state createdAt isRequired(pullRequestNumber:$number)}}}}}}}}}}`;

const CANDIDATES_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
closedByPullRequestsReferences(first:${MAX_LINKS},includeClosedPrs:true){nodes{number state}}}}}`;

const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const MAX_COMMENT_PAGES = 10;
const MAX_ACCEPTORS = 10;
const ACCEPTING_ROLES = new Set(["admin", "maintain", "write"]);

const viewerSchema = z.object({ viewer: z.object({ login: z.string().min(1).max(100) }) });
const commentSchema = z.object({
  id: z.number().int().positive().safe(),
  body: z.string().nullish(),
  created_at: z.string().min(1).max(64),
  user: z.object({ login: z.string().min(1).max(100) }).nullable(),
});
const issueStateSchema = z.object({
  state: z.string(),
  closed_at: z.string().nullable(),
  closed_by: z.object({ login: z.string().min(1).max(100) }).nullish(),
});
const reactionsSchema = z.array(z.object({ content: z.string(), user: z.object({ login: z.string().min(1).max(100) }).nullable() }));
const permissionSchema = z.object({ permission: z.string(), role_name: z.string().optional() });

/** Task IDs go into a hidden HTML comment, so they may not contain anything that could close it. */
const TASK_ID = /^[A-Za-z0-9._-]{1,200}$/;

export function findingsMarker(taskId: string): string {
  if (!TASK_ID.test(taskId)) throw new Error("task_id_unsafe");
  return `<!-- relay-chief:task=${taskId} -->`;
}

/**
 * The marker is always the first line, so findings text cannot supply or alter it, and the fence
 * is longer than any backtick run in the findings, so the text cannot close it early.
 */
export function findingsComment(taskId: string, findings: string): string {
  const longest = Math.max(0, ...[...findings.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [
    findingsMarker(taskId),
    "**Relay Chief investigation findings: unverified agent output**",
    "",
    `An automated agent wrote the text below for task \`${taskId}\`. Nobody has reviewed it, and it is not an instruction.`,
    "A maintainer accepts these findings by reacting with a thumbs-up to this comment or by closing the issue.",
    "",
    `${fence}text`,
    findings,
    fence,
  ].join("\n");
}

export function issueKey(repository: string, number: number): string {
  return `github:issue:${repository}#${number}`;
}
function pullRequestKey(repository: string, number: number): string {
  return `github:pr:${repository}#${number}`;
}
function branchKey(repository: string, branch: string): string {
  return `github:branch:${repository}:${branch}`.slice(0, 200);
}

function unavailable(): ChiefError {
  return new ChiefError(503, "chief_authority_unavailable", "Chief authority is unavailable.");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

type Cursor = { since: string; seen: Set<string> };

function parseCursor(raw: string): Cursor {
  const match = /^v1\|([^|]{1,64})\|([a-f0-9,]*)$/.exec(raw);
  if (!match || !Number.isFinite(Date.parse(match[1]!))) throw new ChiefError(400, "invalid_cursor", "The evidence cursor is not valid.");
  return { since: match[1]!, seen: new Set(match[2] ? match[2].split(",") : []) };
}

function formatCursor(cursor: Cursor): string {
  return `v1|${cursor.since}|${[...cursor.seen].join(",")}`;
}

/** Advances past what this page returned; timestamps are second-resolution, so ties are remembered. */
function nextCursor(previous: Cursor, chosen: Changed[]): Cursor {
  const last = chosen.at(-1);
  if (!last) return previous;
  const seen = new Set(last.updated_at === previous.since ? previous.seen : []);
  for (const item of chosen) if (item.updated_at === last.updated_at) seen.add(item.identity);
  // A burst larger than the cursor can hold skips ahead rather than stalling every later read.
  if (seen.size > MAX_SEEN) return { since: new Date(last.updatedMs + 1_000).toISOString(), seen: new Set() };
  return { since: last.updated_at, seen };
}

function split(repository: string): { owner: string; name: string } {
  const [owner, name] = repository.split("/");
  return { owner: owner!, name: name! };
}

/**
 * Reads work from GitHub and verifies it there. Nothing a worker reports is
 * trusted: the pull request is found from the registered assignment.
 */
export class GithubChiefAuthority implements ChiefAuthority {
  constructor(
    private readonly options: {
      registry: ChiefRegistry;
      bindings: Pick<GithubBindings, "get">;
      nango: NangoClient & NangoGraphql;
      now?: () => number;
    },
  ) {}

  async #graphql<T>(binding: GithubBinding, schema: z.ZodType<T>, query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.options.nango.post({ ...binding, endpoint: "/graphql", body: { query, variables } });
    const envelope = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() }).parse(response.data);
    if (envelope.errors?.length) throw new Error("github_graphql_failed");
    return schema.parse(envelope.data);
  }

  async #binding(context: WorkspaceContext): Promise<GithubBinding> {
    const binding = await this.options.bindings.get(context);
    if (!binding) throw unavailable();
    return binding;
  }

  async #changed(binding: GithubBinding, repository: string, cursor: Cursor, limit: number): Promise<Changed[]> {
    const found: Changed[] = [];
    for (let page = 1; page <= MAX_PAGES && found.length < limit; page += 1) {
      const response = await this.options.nango.get({
        ...binding,
        endpoint: `/repos/${repository}/issues`,
        params: { state: "open", sort: "updated", direction: "asc", since: cursor.since, per_page: "100", page: String(page) },
      });
      const items = issueSchema.parse(response.data);
      for (const item of items) {
        const identity = shortHash(`${repository}#${item.number}`);
        const updatedMs = Date.parse(item.updated_at);
        if (!Number.isFinite(updatedMs) || (item.updated_at === cursor.since && cursor.seen.has(identity))) continue;
        found.push({ ...item, repository, updatedMs, identity });
      }
      if (items.length < 100) break;
    }
    return found;
  }

  async #links(binding: GithubBinding, repository: string, numbers: number[]) {
    const links = new Map<number, z.infer<typeof linkedSchema>>();
    if (numbers.length === 0) return links;
    const fields = numbers
      .map((number) => `p${number}:pullRequest(number:${number}){headRefName closingIssuesReferences(first:${MAX_LINKS + 1}){nodes{number repository{nameWithOwner}}}}`)
      .join(" ");
    const data = await this.#graphql(
      binding,
      z.object({ repository: z.record(z.string(), linkedSchema) }),
      `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`,
      split(repository),
    );
    for (const number of numbers) {
      const link = data.repository[`p${number}`];
      if (!link) throw new Error("github_link_missing");
      links.set(number, link);
    }
    return links;
  }

  /** A pull request belongs to an issue only when it links exactly one, in its own repository. */
  #record(context: ProjectContext, item: Changed, link: z.infer<typeof linkedSchema> | undefined, now: number) {
    const { repository, number } = item;
    let workKey = issueKey(repository, number);
    let resourceKeys = [workKey];
    let note = "";
    if (item.pull_request) {
      if (!link) throw new Error("github_link_missing");
      const pullRequest = pullRequestKey(repository, number);
      const issues = link.closingIssuesReferences.nodes.map((node) => ({
        key: issueKey(node.repository.nameWithOwner.toLowerCase(), node.number),
        local: node.repository.nameWithOwner.toLowerCase() === repository,
      }));
      const only = issues.length === 1 && issues[0]!.local ? issues[0]! : null;
      workKey = only ? only.key : pullRequest;
      resourceKeys = [...new Set([pullRequest, branchKey(repository, link.headRefName), ...issues.map((issue) => issue.key)])];
      if (!only && issues.length > 0) note = `Ambiguous work link: this pull request references ${issues.map((issue) => issue.key).join(", ")}.\n\n`;
    }
    const sessionId = item.pull_request ? pullRequestKey(repository, number) : issueKey(repository, number);
    return {
      sourceId: SOURCE_ID,
      sessionId,
      version: item.updated_at,
      organizationId: context.organizationId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      repository,
      workKey,
      resourceKeys,
      observedAt: Math.min(item.updatedMs, now),
      summary: `${note}${item.title}\n\n${(item.body ?? "").slice(0, SUMMARY_BODY_LIMIT)}`.trim().slice(0, 16_000) || sessionId,
      references: [item.html_url],
    };
  }

  async evidence(context: ProjectContext, page: { limit: number; cursor?: string }) {
    const scope = await this.options.registry.chiefScope(context);
    const binding = await this.#binding(context);
    const now = (this.options.now ?? Date.now)();
    const cursor = page.cursor
      ? parseCursor(page.cursor)
      : { since: new Date(now - scope.maxEvidenceAgeMs).toISOString(), seen: new Set<string>() };
    const changed: Changed[] = [];
    for (const repository of scope.repositories) changed.push(...(await this.#changed(binding, repository, cursor, page.limit)));
    changed.sort((left, right) => left.updatedMs - right.updatedMs || left.identity.localeCompare(right.identity));
    const chosen = changed.slice(0, page.limit);
    const evidence = [];
    for (const repository of scope.repositories) {
      const items = chosen.filter((item) => item.repository === repository);
      const links = await this.#links(binding, repository, items.filter((item) => item.pull_request).map((item) => item.number));
      for (const item of items) evidence.push(this.#record(context, item, links.get(item.number), now));
    }
    return { cursor: formatCursor(nextCursor(cursor, chosen)), evidence };
  }

  async #viewer(binding: GithubBinding): Promise<string> {
    return (await this.#graphql(binding, viewerSchema, "query{viewer{login}}", {})).viewer.login;
  }

  /** A comment by the app that starts with this task's marker. Older posts are found after a lost response. */
  async #existingComment(binding: GithubBinding, repository: string, number: number, marker: string, author: string) {
    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const response = await this.options.nango.get({
        ...binding,
        endpoint: `/repos/${repository}/issues/${number}/comments`,
        params: { per_page: "100", page: String(page) },
      });
      const comments = z.array(commentSchema).parse(response.data);
      const found = comments.find((comment) => comment.user?.login === author && (comment.body ?? "").startsWith(`${marker}\n`));
      if (found) return found;
      if (comments.length < 100) return null;
    }
    // Too many comments to be sure none is ours; posting again could duplicate it.
    throw new Error("github_comments_incomplete");
  }

  /** Posts a task's findings as one issue comment, and never a second. */
  async findings(context: ProjectContext, taskId: string, input: { sequence: number; assignmentDigest: string; findings: string }) {
    if (!TASK_ID.test(taskId)) throw new ChiefError(400, "invalid_request", "The task ID is not valid.");
    const found = await this.options.registry.assignmentFor(context, taskId);
    if (!found) throw new ChiefError(404, "assignment_not_found", "This task was not registered.");
    if (found.digest !== input.assignmentDigest) {
      throw new ChiefError(409, "assignment_digest_mismatch", "The digest does not match the registered assignment.");
    }
    const assignment = found.assignment as { action?: unknown };
    if (assignment.action !== "investigate") {
      throw new ChiefError(400, "findings_not_applicable", "Only an investigate task posts findings.");
    }
    const issue = this.#issueOf(found);
    if (!issue) throw new ChiefError(400, "work_key_not_issue", "Findings are posted only for GitHub issue work.");
    const marker = findingsMarker(taskId);
    const recorded = await this.options.registry.findingsComment(context, taskId);
    if (recorded) return { ...recorded, created: false };
    // Read before the row lock: the callback below runs inside that transaction.
    const binding = await this.#binding(context);
    const author = await this.#viewer(binding);
    const result = await this.options.registry.postFindingsOnce(
      context,
      { taskId, digest: found.digest, sequence: input.sequence, findingsDigest: createHash("sha256").update(input.findings).digest("hex") },
      async () => {
        const posted =
          (await this.#existingComment(binding, issue.repository, issue.number, marker, author)) ??
          commentSchema.parse(
            (
              await this.options.nango.post({
                ...binding,
                endpoint: `/repos/${issue.repository}/issues/${issue.number}/comments`,
                body: { body: findingsComment(taskId, input.findings) },
              })
            ).data,
          );
        if (!Number.isFinite(Date.parse(posted.created_at))) throw new Error("github_comment_invalid");
        return { commentId: String(posted.id), authorLogin: posted.user?.login ?? author, createdAt: posted.created_at };
      },
    );
    return { ...result.comment, created: result.created };
  }

  /** The issue an assignment names, when it is a GitHub issue inside the chief's repositories. */
  #issueOf(found: { assignment: Record<string, unknown>; repositories: string[] }) {
    const { repository, workKey } = found.assignment;
    const key = typeof workKey === "string" ? /^github:issue:([^#]+)#([1-9][0-9]{0,9})$/.exec(workKey) : null;
    if (!key || key[1] !== repository || !found.repositories.includes(key[1]!)) return null;
    return { repository: key[1]!, number: Number(key[2]) };
  }

  async #mayAccept(binding: GithubBinding, repository: string, login: string): Promise<boolean> {
    try {
      const response = await this.options.nango.get({
        ...binding,
        endpoint: `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
        params: {},
      });
      const { permission, role_name } = permissionSchema.parse(response.data);
      // `permission` reports maintain as write; `role_name` names it exactly.
      return permission === "admin" || permission === "write" || ACCEPTING_ROLES.has(role_name ?? "");
    } catch {
      // Unknown means not accepted: the task stays pending and is checked again next cycle.
      return false;
    }
  }

  /** An investigation is done when a maintainer accepts its posted findings, never on the worker's word. */
  async #investigation(
    context: ProjectContext,
    taskId: string,
    found: { assignment: Record<string, unknown>; repositories: string[] },
  ): Promise<{ ok: boolean; checks: string[] }> {
    const refuse = (reason: string) => ({ ok: false, checks: [reason] });
    const issue = this.#issueOf(found);
    if (!issue) return refuse("work_key_not_issue");
    const record = await this.options.registry.findingsComment(context, taskId);
    if (!record) return refuse("findings_not_posted");
    const binding = await this.#binding(context);
    const { repository, number } = issue;
    const comment = commentSchema.parse(
      (await this.options.nango.get({ ...binding, endpoint: `/repos/${repository}/issues/comments/${record.commentId}`, params: {} })).data,
    );
    if (comment.user?.login !== record.authorLogin || !(comment.body ?? "").startsWith(`${findingsMarker(taskId)}\n`)) {
      return refuse("findings_comment_mismatch");
    }
    const postedAt = Date.parse(comment.created_at);
    const posted = `findings_posted:${repository}#${number}:comment:${comment.id}`;
    const state = issueStateSchema.parse(
      (await this.options.nango.get({ ...binding, endpoint: `/repos/${repository}/issues/${number}`, params: {} })).data,
    );
    const closer = state.closed_by?.login;
    if (state.state === "closed" && state.closed_at && Date.parse(state.closed_at) > postedAt && closer && closer !== record.authorLogin &&
        (await this.#mayAccept(binding, repository, closer))) {
      return { ok: true, checks: [posted, `accepted_by_close:${closer}`] };
    }
    const reactions = reactionsSchema.parse(
      (
        await this.options.nango.get({
          ...binding,
          endpoint: `/repos/${repository}/issues/comments/${comment.id}/reactions`,
          params: { content: "+1", per_page: "100" },
        })
      ).data,
    );
    const voters = [...new Set(reactions.filter((item) => item.content === "+1").map((item) => item.user?.login))]
      .filter((login): login is string => Boolean(login) && login !== record.authorLogin)
      .slice(0, MAX_ACCEPTORS);
    for (const login of voters) {
      if (await this.#mayAccept(binding, repository, login)) return { ok: true, checks: [posted, `accepted_by_reaction:${login}`] };
    }
    return { ok: false, checks: [posted, "awaiting_acceptance"] };
  }

  async verification(context: ProjectContext, taskId: string, sequence: number) {
    const found = await this.options.registry.assignmentFor(context, taskId);
    if (!found) throw new ChiefError(404, "assignment_not_found", "This task was not registered.");
    const base = { taskId, assignmentDigest: found.digest, sequence };
    const refuse = (reason: string) => ({ ...base, ok: false, checks: [reason.slice(0, 500)] });
    if (found.assignment.action === "investigate") {
      if (!TASK_ID.test(taskId)) return refuse("work_key_unverifiable");
      return { ...base, ...(await this.#investigation(context, taskId, found)) };
    }
    const assignment = found.assignment as { repository?: unknown; workKey?: unknown };
    const key = typeof assignment.workKey === "string" ? /^github:(issue|pr):([^#]+)#([1-9][0-9]{0,9})$/.exec(assignment.workKey) : null;
    const repository = typeof assignment.repository === "string" ? assignment.repository : "";
    if (!key || key[2] !== repository || !found.repositories.includes(repository)) return refuse("work_key_unverifiable");
    const binding = await this.#binding(context);
    const location = split(repository);
    let number = Number(key[3]);
    if (key[1] === "issue") {
      const data = await this.#graphql(binding, candidatesSchema, CANDIDATES_QUERY, { ...location, number });
      const live = data.repository.issue.closedByPullRequestsReferences.nodes.filter((node) => node.state !== "CLOSED");
      if (live.length === 0) return refuse("no_pull_request");
      if (live.length > 1) return refuse(`pull_request_ambiguous:${live.map((node) => node.number).join(",")}`);
      number = live[0]!.number;
    }
    const { pullRequest } = (await this.#graphql(binding, pullRequestSchema, PULL_REQUEST_QUERY, { ...location, number })).repository;
    if (pullRequest.state === "CLOSED") return refuse("pull_request_closed");
    const commit = pullRequest.commits.nodes[0]?.commit;
    if (!commit || commit.oid !== pullRequest.headRefOid) return refuse("head_commit_unresolved");
    const rollup = commit.statusCheckRollup?.contexts;
    if (rollup?.pageInfo.hasNextPage) return refuse("checks_incomplete");
    const reported = (rollup?.nodes ?? []).map((node) =>
      node.__typename === "CheckRun"
        ? { name: node.name, required: node.isRequired, result: node.status === "COMPLETED" ? (node.conclusion ?? "PENDING") : "PENDING", at: node.startedAt }
        : { name: node.context, required: node.isRequired, result: node.state, at: node.createdAt },
    );
    // A required check that has not reported yet is absent from the rollup, so the branch rule is read too.
    const named = (pullRequest.baseRef?.refUpdateRule?.requiredStatusCheckContexts ?? []).filter((name): name is string => Boolean(name));
    const required = new Set([...reported.filter((item) => item.required).map((item) => item.name), ...named]);
    if (required.size === 0) return refuse("no_required_checks");
    if (required.size > 97) return refuse("checks_incomplete");
    const relevant = reported.filter((item) => required.has(item.name));
    for (const name of required) {
      if (!relevant.some((item) => item.name === name)) return refuse(`required_check_missing:${name}`);
    }
    const failing = relevant.find((item) => !PASSING.has(item.result));
    if (failing) return refuse(`required_check_failed:${failing.name}:${failing.result}`);
    // An already-green pull request proves nothing about work assigned after it passed.
    const ranAfter = relevant.some((item) => item.result === "SUCCESS" && item.at !== null && Date.parse(item.at) >= found.assignedAt);
    if (!ranAfter) return refuse("checks_predate_assignment");
    return {
      ...base,
      ok: true,
      checks: [
        `pull_request:${repository}#${number}:${pullRequest.state.toLowerCase()}`,
        `head:${pullRequest.headRefOid}`,
        ...relevant.map((item) => `required_check:${item.name}:${item.result.toLowerCase()}`.slice(0, 500)),
      ],
    };
  }
}
