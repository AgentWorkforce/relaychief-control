-- Relay Chief registry: one chief per project, pre-provisioned slots bound by an
-- operator. This service only ever sees an opaque slot ID; the mapping to a host
-- lives with the infrastructure. Organization and workspace IDs come from
-- relay-control introspection and are plain values here.

CREATE TABLE chiefs (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  name text NOT NULL,
  repository text NOT NULL,
  request_id uuid NOT NULL,
  digest text NOT NULL,
  config jsonb NOT NULL,
  placement text NOT NULL,
  state text NOT NULL DEFAULT 'awaiting_capacity'
    CHECK (state IN ('awaiting_capacity', 'awaiting_binding', 'ready')),
  readiness jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  -- Idempotency is bound to the authenticated tenant plus the request ID.
  UNIQUE (organization_id, workspace_id, request_id)
);

CREATE INDEX chiefs_workspace_idx ON chiefs (organization_id, workspace_id, created_at DESC);
CREATE INDEX chiefs_capacity_idx ON chiefs (created_at) WHERE state = 'awaiting_capacity';

CREATE TABLE chief_repositories (
  workspace_id text NOT NULL,
  repository_id text NOT NULL,
  repository text NOT NULL,
  chief_id text NOT NULL REFERENCES chiefs(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, repository_id),
  UNIQUE (workspace_id, repository)
);

CREATE TABLE chief_slots (
  slot_id text PRIMARY KEY CHECK (slot_id ~ '^slot-[a-z0-9]{8,32}$'),
  state text NOT NULL DEFAULT 'free' CHECK (state IN ('free', 'assigned')),
  chief_id text UNIQUE REFERENCES chiefs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  assigned_at timestamptz,
  CONSTRAINT chief_slot_assignment CHECK ((state = 'free') = (chief_id IS NULL))
);

-- A slot is single-use because its data volume keeps the previous chief's
-- ledger. Nothing may reassign or remove an assigned slot; a wipe-and-reuse path
-- has to be introduced deliberately, by changing this trigger.
CREATE FUNCTION chief_slot_single_use() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'assigned' THEN
    RAISE EXCEPTION 'chief slot % is single-use', OLD.slot_id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chief_slot_single_use
  BEFORE UPDATE OR DELETE ON chief_slots
  FOR EACH ROW EXECUTE FUNCTION chief_slot_single_use();

-- Scoped to one chief, unlike workspace API tokens. Stored only as a hash.
CREATE TABLE chief_service_credentials (
  id uuid PRIMARY KEY,
  chief_id text NOT NULL REFERENCES chiefs(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX chief_service_credentials_active_idx
  ON chief_service_credentials (chief_id) WHERE revoked_at IS NULL;

-- Immutable: written before the chief sends the assignment.
CREATE TABLE chief_assignments (
  chief_id text NOT NULL REFERENCES chiefs(id) ON DELETE RESTRICT,
  task_id text NOT NULL,
  digest text NOT NULL,
  assignment jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chief_id, task_id)
);

CREATE TABLE chief_audit_events (
  id uuid PRIMARY KEY,
  organization_id text,
  workspace_id text,
  actor_kind text NOT NULL,
  actor_id text,
  action text NOT NULL,
  target text,
  created_at timestamptz NOT NULL DEFAULT now()
);
