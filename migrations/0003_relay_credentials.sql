-- A chief's platform-issued Relay agent. The token is encrypted; only the chief's
-- own service credential can read it back.
CREATE TABLE chief_relay_credentials (
  chief_id text PRIMARY KEY REFERENCES chiefs(id) ON DELETE RESTRICT,
  agent_id text NOT NULL,
  token_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
