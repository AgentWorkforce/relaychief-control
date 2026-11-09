import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "./database.js";

export type AuditActor = { kind: "operator" };

/** Records an operator action. Never pass secret values as `target`. */
export async function recordAudit(
  executor: SqlExecutor,
  input: {
    organizationId?: string | null;
    workspaceId?: string | null;
    actor: AuditActor;
    action: string;
    target?: string | null;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO chief_audit_events (id, organization_id, workspace_id, actor_kind, action, target)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      input.organizationId ?? null,
      input.workspaceId ?? null,
      input.actor.kind,
      input.action,
      input.target ?? null,
    ],
  );
}
