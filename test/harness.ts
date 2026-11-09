import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../src/app.js";
import type { Introspector } from "../src/auth/introspection.js";
import type { ChiefOperations } from "../src/chief/operations.js";
import type { ChiefBackend } from "../src/chief/routes.js";
import { ChiefRegistry } from "../src/chief/registry.js";
import type { Database, SqlExecutor, SqlResult } from "../src/database.js";
import { migrate } from "../src/migrations.js";

export const ADMIN_TOKEN = "admin-token-that-is-at-least-32-bytes";

export class PGliteDatabase implements Database {
  constructor(readonly client = new PGlite()) {}
  async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<SqlResult<T>> {
    const result = params.length > 0 ? await this.client.query<T>(sql, params) : await this.client.query<T>(sql);
    return { rows: result.rows };
  }
  async transaction<T>(run: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return this.client.transaction(async (transaction) =>
      run({
        query: async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          const result = params.length > 0 ? await transaction.query<R>(sql, params) : await transaction.query<R>(sql);
          return { rows: result.rows };
        },
        exec: async (sql: string) => {
          await transaction.exec(sql);
        },
      }),
    ) as Promise<T>;
  }
  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }
  async close(): Promise<void> {
    await this.client.close();
  }
}

export const tenant = {
  organizationId: "org-acme",
  workspaceId: "workspace-primary",
  otherWorkspaceId: "workspace-other",
  ownerToken: "sh_at_owner",
  otherOwnerToken: "sh_at_other_owner",
  memberToken: "sh_at_member",
};

const sessions: Record<string, { workspace: string; role: "owner" | "member" }> = {
  [tenant.ownerToken]: { workspace: tenant.workspaceId, role: "owner" },
  [tenant.otherOwnerToken]: { workspace: tenant.otherWorkspaceId, role: "owner" },
  [tenant.memberToken]: { workspace: tenant.workspaceId, role: "member" },
};

/** Answers as relay-control's introspection endpoint does. */
const introspect: Introspector = async (token, workspaceId) => {
  const session = sessions[token];
  if (!session) return { active: false, reason: "unknown" };
  if (session.workspace !== workspaceId) return { active: false, reason: "workspace" };
  return {
    active: true,
    principal_type: "desktop-user",
    org: tenant.organizationId,
    workspace: session.workspace,
    role: session.role,
  };
};

async function listen(listener: RequestListener): Promise<{ server: Server; origin: string }> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export type Api = (
  path: string,
  options?: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> },
) => Promise<{ status: number; body: any; text: string }>;

function client(origin: (path: string) => string): Api {
  return async (path, options = {}) => {
    const response = await fetch(`${origin(path)}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { status: response.status, body, text };
  };
}

export async function startControl(
  options: { chief?: ChiefBackend; operations?: (database: Database) => ChiefOperations } = {},
) {
  const database = new PGliteDatabase();
  await migrate(database);
  const operations = options.operations?.(database) ?? { registry: new ChiefRegistry({ database }) };
  const app = createApp({
    database,
    introspect,
    adminToken: ADMIN_TOKEN,
    browserOrigins: ["https://control.selfhosted.company"],
    operations,
    ...(options.chief ? { chief: options.chief } : {}),
  });
  const publicListener = await listen(app.public);
  const adminListener = await listen(app.admin);
  return {
    database,
    /** Operator paths go to the admin listener, everything else to the public one. */
    api: client((path) => (path.startsWith("/api/v1/operator/") ? adminListener.origin : publicListener.origin)),
    publicApi: client(() => publicListener.origin),
    async stop() {
      await new Promise((resolve) => publicListener.server.close(resolve));
      await new Promise((resolve) => adminListener.server.close(resolve));
      await database.close();
    },
  };
}
