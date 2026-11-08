import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { Introspector } from "./auth/introspection.js";
import { handleChiefOperator, handleChiefService, type ChiefOperations } from "./chief/operations.js";
import { ChiefError } from "./chief/registry.js";
import { handleChiefRoutes, type ChiefBackend } from "./chief/routes.js";
import { secureEqual } from "./crypto.js";
import type { Database } from "./database.js";

const SESSION_COOKIE = "agent_relay_session";
const BODY_LIMIT = 1024 * 1024;

export type AppInput = {
  database: Database;
  introspect: Introspector;
  adminToken: string;
  browserOrigins: string[];
  operations: ChiefOperations;
  /** Defaults to the registry; tests replace it to exercise the gateway alone. */
  chief?: ChiefBackend;
};

function json(response: ServerResponse, status: number, body: unknown, noStore = false): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...(noStore ? { "cache-control": "no-store" } : {}),
  });
  response.end(JSON.stringify(body));
}

function bearer(request: IncomingMessage): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "");
  return match?.[1]?.trim() || null;
}

function cookie(request: IncomingMessage, name: string): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

async function requestObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size <= BODY_LIMIT) chunks.push(buffer);
  }
  const invalid = new ChiefError(400, "invalid_request", "Body must be a JSON object of at most 1 MiB.");
  if (size > BODY_LIMIT) throw invalid;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid;
  return parsed as Record<string, unknown>;
}

function publicPath(pathname: string): string {
  if (pathname === "/cloud/api/v1") return "/api/v1";
  return pathname.startsWith("/cloud/api/v1/") ? pathname.slice("/cloud".length) : pathname;
}

function guarded(run: (request: IncomingMessage, response: ServerResponse) => Promise<void>): RequestListener {
  return (request, response) => {
    run(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
      } else if (error instanceof ChiefError) {
        json(response, error.status, { error: error.code, message: error.message }, true);
      } else {
        json(response, 503, { error: "chief_unavailable", message: "Chief service is temporarily unavailable." }, true);
      }
    });
  };
}

/** Two listeners: `admin` carries the operator routes and must stay internal. */
export function createApp(input: AppInput): { public: RequestListener; admin: RequestListener } {
  const url = (request: IncomingMessage) => new URL(request.url ?? "/", "http://chief.invalid");
  const operatorAuthorized = (request: IncomingMessage) => {
    const token = bearer(request);
    return token !== null && secureEqual(token, input.adminToken);
  };
  const deps = { operations: input.operations, operatorAuthorized, bearer, requestObject, json };

  async function workspaceAccess(request: IncomingMessage, workspaceId: string, admin: boolean) {
    // Cookies are only honored on /cloud paths, the same as relay-control.
    const cloud = url(request).pathname.startsWith("/cloud/");
    const token = bearer(request) ?? (cloud ? cookie(request, SESSION_COOKIE) : null);
    if (!token) throw new ChiefError(401, "unauthorized", "Authentication required");
    const result = await input.introspect(token, workspaceId);
    if (!result.active) {
      throw result.reason === "workspace"
        ? new ChiefError(404, "workspace_not_found", "Workspace not found")
        : new ChiefError(401, "unauthorized", "Invalid or expired token");
    }
    if (result.principal_type !== "desktop-user") {
      throw new ChiefError(401, "unauthorized", "User token required");
    }
    if (result.workspace !== workspaceId) throw new ChiefError(404, "workspace_not_found", "Workspace not found");
    if (admin && result.role !== "owner" && result.role !== "admin") {
      throw new ChiefError(403, "forbidden", "Workspace admin role required");
    }
    return { workspace: { id: result.workspace, organizationId: result.org } };
  }

  return {
    public: guarded(async (request, response) => {
      const location = url(request);
      const path = publicPath(location.pathname);
      if (path === "/healthz") return json(response, 200, { ok: true });
      if (path === "/readyz") {
        await input.database.query("SELECT 1");
        return json(response, 200, { ok: true });
      }
      if (await handleChiefService(request, response, path, location, deps)) return;
      const handled = await handleChiefRoutes(request, response, path, {
        backend: input.chief ?? input.operations.registry,
        workspaceAccess,
        requestObject,
        json,
        csrfAllowed: (incoming) =>
          Boolean(bearer(incoming)) || input.browserOrigins.includes(incoming.headers.origin ?? ""),
      });
      if (!handled) json(response, 404, { error: "not_found", message: "Route not found" });
    }),
    admin: guarded(async (request, response) => {
      const path = url(request).pathname;
      if (!(await handleChiefOperator(request, response, path, deps))) {
        json(response, 404, { error: "not_found", message: "Route not found" });
      }
    }),
  };
}
