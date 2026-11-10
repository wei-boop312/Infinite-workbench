-- Local development authentication only. Production OIDC remains a separate adapter.
CREATE SCHEMA workspace_auth;
REVOKE ALL ON SCHEMA workspace_auth FROM PUBLIC;
CREATE TABLE workspace_auth.users (
  id uuid PRIMARY KEY, username text NOT NULL UNIQUE CHECK(username ~ '^[a-z][a-z0-9_-]{2,39}$'),
  password_salt text NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_auth.sessions (
  token_hash text PRIMARY KEY CHECK(length(token_hash)=64), user_id uuid NOT NULL REFERENCES workspace_auth.users(id),
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX local_sessions_user ON workspace_auth.sessions(user_id);
REVOKE ALL ON ALL TABLES IN SCHEMA workspace_auth FROM PUBLIC, workspace_app;
