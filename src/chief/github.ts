import { z } from "zod";
import { recordAudit } from "../audit.js";
import type { Database } from "../database.js";
import { ChiefError, type RepositoryCatalog, type RepositorySource, type WorkspaceContext } from "./registry.js";

export type GithubBinding = { connectionId: string; providerConfigKey: string };

export type NangoClient = {
  get(input: GithubBinding & { endpoint: string; params: Record<string, string> }): Promise<{ data: unknown }>;
};

export type NangoGraphql = {
  post(input: GithubBinding & { endpoint: string; body: unknown }): Promise<{ data: unknown }>;
};

const bindingSchema = z.strictObject({
  organizationId: z.string().min(1).max(500),
  connectionId: z.string().min(1).max(256),
  providerConfigKey: z.string().min(1).max(256),
});

const pageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(
    z.object({
      id: z.number().int().positive().safe(),
      full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      private: z.boolean(),
      archived: z.boolean().optional(),
      disabled: z.boolean().optional(),
    }),
  ),
});

/** Operator-recorded workspace bindings, always read within the workspace's own organization. */
export class GithubBindings {
  constructor(private readonly database: Database) {}

  async get(context: WorkspaceContext): Promise<GithubBinding | null> {
    const result = await this.database.query<{ connection_id: string; provider_config_key: string }>(
      `SELECT connection_id, provider_config_key FROM chief_github_bindings
        WHERE workspace_id = $1 AND organization_id = $2`,
      [context.workspaceId, context.organizationId],
    );
    const row = result.rows[0];
    return row ? { connectionId: row.connection_id, providerConfigKey: row.provider_config_key } : null;
  }

  async set(workspaceId: string, raw: unknown) {
    const parsed = bindingSchema.safeParse(raw);
    if (!parsed.success) throw new ChiefError(400, "invalid_github_binding", "Check the organization, connection and provider key.");
    const { organizationId, connectionId, providerConfigKey } = parsed.data;
    return this.database.transaction(async (tx) => {
      const saved = await tx.query(
        `INSERT INTO chief_github_bindings (workspace_id, organization_id, connection_id, provider_config_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id) DO UPDATE
           SET connection_id = EXCLUDED.connection_id,
               provider_config_key = EXCLUDED.provider_config_key,
               updated_at = now()
         WHERE chief_github_bindings.organization_id = EXCLUDED.organization_id
         RETURNING workspace_id`,
        [workspaceId, organizationId, connectionId, providerConfigKey],
      );
      if (saved.rows.length !== 1) {
        throw new ChiefError(409, "github_binding_organization_conflict", "This workspace is bound under another organization.");
      }
      await recordAudit(tx, {
        organizationId,
        workspaceId,
        actor: { kind: "operator" },
        action: "chief.github_binding_set",
        target: workspaceId,
      });
      return { workspaceId, organizationId, providerConfigKey };
    });
  }
}

function unavailable(): ChiefError {
  return new ChiefError(503, "github_unavailable", "GitHub repository discovery is unavailable.");
}

/** Lists what the workspace's GitHub App installation can reach. An incomplete catalog never authorizes. */
export class NangoGithubRepositories implements RepositorySource {
  constructor(
    private readonly options: {
      binding(context: WorkspaceContext): Promise<GithubBinding | null>;
      nango: NangoClient;
    },
  ) {}

  async list(context: WorkspaceContext): Promise<RepositoryCatalog> {
    const binding = await this.options.binding(context);
    if (!binding) return { connected: false, repositories: [] };
    const repositories = new Map<string, { id: string; fullName: string }>();
    for (let page = 1; page <= 100; page += 1) {
      let data: z.infer<typeof pageSchema>;
      try {
        const response = await this.options.nango.get({
          ...binding,
          endpoint: "/installation/repositories",
          params: { per_page: "100", page: String(page) },
        });
        data = pageSchema.parse(response.data);
      } catch {
        // Provider bodies and parse details never reach the caller.
        throw unavailable();
      }
      if (data.repositories.length === 0 && data.total_count > (page - 1) * 100) throw unavailable();
      for (const repository of data.repositories) {
        if (repository.archived || repository.disabled) continue;
        repositories.set(String(repository.id), { id: String(repository.id), fullName: repository.full_name });
      }
      if (page * 100 >= data.total_count) {
        return {
          connected: true,
          repositories: [...repositories.values()].sort((left, right) => left.fullName.localeCompare(right.fullName)),
        };
      }
    }
    throw unavailable();
  }
}

/** Calls GitHub through Nango's proxy with the server-held secret key. */
export function nangoClient(config: { host: string; secretKey: string }): NangoClient & NangoGraphql {
  async function send(url: URL, binding: GithubBinding, init: { method: string; body?: string; contentType?: string }) {
    const response = await fetch(url, {
      method: init.method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.secretKey}`,
        "connection-id": binding.connectionId,
        "provider-config-key": binding.providerConfigKey,
        ...(init.contentType ? { "content-type": init.contentType } : {}),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("nango_proxy_failed");
    }
    return { data: await response.json() };
  }
  return {
    get({ endpoint, params, ...binding }) {
      const url = new URL(`/proxy${endpoint}`, config.host);
      url.search = new URLSearchParams(params).toString();
      return send(url, binding, { method: "GET" });
    },
    post({ endpoint, body, ...binding }) {
      return send(new URL(`/proxy${endpoint}`, config.host), binding, {
        method: "POST",
        body: JSON.stringify(body),
        contentType: "application/json",
      });
    },
  };
}
