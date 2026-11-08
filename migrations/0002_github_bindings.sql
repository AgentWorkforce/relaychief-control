-- The GitHub App installation connection each workspace uses. Written only by an
-- operator; connection and provider keys never come from a browser request.
CREATE TABLE chief_github_bindings (
  workspace_id text PRIMARY KEY,
  organization_id text NOT NULL,
  connection_id text NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 256),
  provider_config_key text NOT NULL CHECK (length(provider_config_key) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
