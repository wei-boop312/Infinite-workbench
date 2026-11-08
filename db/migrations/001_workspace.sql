-- PostgreSQL-compatible local development schema. Execute with a migration
-- owner; application transactions SET LOCAL ROLE workspace_app (NOBYPASSRLS).
CREATE ROLE workspace_app NOLOGIN NOBYPASSRLS;
CREATE SCHEMA workspace;
REVOKE ALL ON SCHEMA workspace FROM PUBLIC;
GRANT USAGE ON SCHEMA workspace TO workspace_app;

CREATE TABLE workspace.projects (
  id uuid PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace.project_members (
  project_id uuid NOT NULL REFERENCES workspace.projects(id), user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','creator','designer','viewer')),
  PRIMARY KEY(project_id,user_id)
);
CREATE INDEX project_members_user ON workspace.project_members(user_id,project_id);
CREATE FUNCTION workspace.actor_id() RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog AS $$ SELECT nullif(current_setting('app.actor_id',true),'')::uuid $$;
CREATE FUNCTION workspace.can_read(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM workspace.project_members m JOIN workspace.projects p2 ON p2.id=m.project_id WHERE m.project_id=p AND m.user_id=workspace.actor_id() AND p2.deleted_at IS NULL)
$$;
CREATE FUNCTION workspace.can_edit(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM workspace.project_members m JOIN workspace.projects p2 ON p2.id=m.project_id WHERE m.project_id=p AND m.user_id=workspace.actor_id() AND m.role IN ('owner','creator','designer') AND p2.deleted_at IS NULL)
$$;
ALTER TABLE workspace.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.project_members FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_self ON workspace.project_members FOR SELECT TO workspace_app USING(user_id=workspace.actor_id());
GRANT SELECT ON workspace.project_members TO workspace_app;
ALTER TABLE workspace.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.projects FORCE ROW LEVEL SECURITY;
-- The owner may see its tombstone metadata so UPDATE can complete under RLS.
-- Child can_read/can_edit still require deleted_at IS NULL for every actor.
CREATE POLICY project_read ON workspace.projects FOR SELECT TO workspace_app USING(EXISTS(
  SELECT 1 FROM workspace.project_members m WHERE m.project_id=projects.id AND m.user_id=workspace.actor_id()
  AND (projects.deleted_at IS NULL OR m.role='owner')
));
CREATE POLICY project_edit ON workspace.projects FOR UPDATE TO workspace_app USING(workspace.can_edit(id))
  WITH CHECK(EXISTS(SELECT 1 FROM workspace.project_members m WHERE m.project_id=projects.id AND m.user_id=workspace.actor_id() AND m.role IN ('owner','creator','designer')));
GRANT SELECT, UPDATE(name,deleted_at) ON workspace.projects TO workspace_app;
CREATE FUNCTION workspace.guard_project_delete() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog AS $$ BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NOT EXISTS(
    SELECT 1 FROM workspace.project_members WHERE project_id=OLD.id AND user_id=workspace.actor_id() AND role='owner'
  ) THEN RAISE EXCEPTION 'PROJECT_DELETE_OWNER_ONLY'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER project_delete_owner BEFORE UPDATE OF deleted_at ON workspace.projects FOR EACH ROW EXECUTE FUNCTION workspace.guard_project_delete();

CREATE TABLE workspace.canvases (
  project_id uuid PRIMARY KEY REFERENCES workspace.projects(id), revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE workspace.edit_leases (
  project_id uuid PRIMARY KEY REFERENCES workspace.projects(id), holder_id uuid NOT NULL,
  token_hash text NOT NULL CHECK(length(token_hash)=64), fencing_token bigint NOT NULL CHECK(fencing_token>0), expires_at timestamptz NOT NULL
);
CREATE TABLE workspace.asset_versions (
  project_id uuid NOT NULL REFERENCES workspace.projects(id), id uuid NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), state text NOT NULL CHECK(state='ready'),
  storage_key text NOT NULL, PRIMARY KEY(project_id,id)
);
CREATE TABLE workspace.objects (
  project_id uuid NOT NULL REFERENCES workspace.projects(id), id uuid NOT NULL,
  current_revision bigint NOT NULL CHECK(current_revision>0), PRIMARY KEY(project_id,id)
);
CREATE TABLE workspace.object_revisions (
  project_id uuid NOT NULL, object_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
  asset_version_id uuid, payload jsonb NOT NULL, content_hash text NOT NULL CHECK(length(content_hash)=64),
  PRIMARY KEY(project_id,object_id,revision),
  FOREIGN KEY(project_id,object_id) REFERENCES workspace.objects(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,asset_version_id) REFERENCES workspace.asset_versions(project_id,id)
);
ALTER TABLE workspace.objects ADD CONSTRAINT current_revision_exists FOREIGN KEY(project_id,id,current_revision)
  REFERENCES workspace.object_revisions(project_id,object_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE workspace.workflow_versions (
  project_id uuid NOT NULL REFERENCES workspace.projects(id), id uuid NOT NULL, workflow_id uuid NOT NULL,
  version bigint NOT NULL CHECK(version>0), payload jsonb NOT NULL, content_hash text NOT NULL CHECK(length(content_hash)=64),
  PRIMARY KEY(project_id,id), UNIQUE(project_id,workflow_id,version)
);
CREATE TABLE workspace.template_versions (
  project_id uuid NOT NULL, id uuid NOT NULL, template_id uuid NOT NULL, workflow_version_id uuid NOT NULL,
  version bigint NOT NULL CHECK(version>0), payload jsonb NOT NULL, content_hash text NOT NULL CHECK(length(content_hash)=64),
  PRIMARY KEY(project_id,id), UNIQUE(project_id,template_id,version),
  FOREIGN KEY(project_id,workflow_version_id) REFERENCES workspace.workflow_versions(project_id,id)
);
CREATE TABLE workspace.bindings (
  project_id uuid NOT NULL, id uuid NOT NULL, template_version_id uuid NOT NULL,
  object_id uuid NOT NULL, object_revision bigint NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(project_id,id),
  FOREIGN KEY(project_id,template_version_id) REFERENCES workspace.template_versions(project_id,id),
  FOREIGN KEY(project_id,object_id,object_revision) REFERENCES workspace.object_revisions(project_id,object_id,revision)
);
CREATE TABLE workspace.run_snapshots (
  project_id uuid NOT NULL REFERENCES workspace.projects(id), id uuid NOT NULL,
  payload jsonb NOT NULL, content_hash text NOT NULL CHECK(length(content_hash)=64), PRIMARY KEY(project_id,id)
);
CREATE TABLE workspace.budgets (
  project_id uuid PRIMARY KEY REFERENCES workspace.projects(id), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  limit_amount numeric(20,8) NOT NULL CHECK(limit_amount>=0), reserved_amount numeric(20,8) NOT NULL DEFAULT 0 CHECK(reserved_amount>=0),
  spent_amount numeric(20,8) NOT NULL DEFAULT 0 CHECK(spent_amount>=0), CHECK(reserved_amount+spent_amount<=limit_amount)
);
CREATE TABLE workspace.runs (
  project_id uuid NOT NULL, id uuid NOT NULL, snapshot_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','running','unknown','archiving','succeeded','failed','cancel_requested','cancelled')),
  idempotency_key text NOT NULL, request_hash text NOT NULL CHECK(length(request_hash)=64),
  reserved_amount numeric(20,8) NOT NULL CHECK(reserved_amount>=0), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,id), UNIQUE(project_id,idempotency_key),
  FOREIGN KEY(project_id,snapshot_id) REFERENCES workspace.run_snapshots(project_id,id)
);
CREATE TABLE workspace.outbox (
  project_id uuid NOT NULL, id uuid NOT NULL, run_id uuid NOT NULL, event_type text NOT NULL,
  payload jsonb NOT NULL, dispatched_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,id), FOREIGN KEY(project_id,run_id) REFERENCES workspace.runs(project_id,id)
);
CREATE INDEX pending_outbox ON workspace.outbox(created_at) WHERE dispatched_at IS NULL;
CREATE INDEX runs_state_created ON workspace.runs(project_id,state,created_at);
CREATE FUNCTION workspace.reject_history_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_HISTORY'; END; $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['asset_versions','object_revisions','workflow_versions','template_versions','bindings','run_snapshots'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.%I FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['canvases','edit_leases','asset_versions','objects','object_revisions','workflow_versions','template_versions','bindings','run_snapshots','budgets','runs','outbox'] LOOP
    EXECUTE format('ALTER TABLE workspace.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE workspace.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY read_project ON workspace.%I FOR SELECT TO workspace_app USING(workspace.can_read(project_id))',t);
    EXECUTE format('CREATE POLICY insert_project ON workspace.%I FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id))',t);
    EXECUTE format('CREATE POLICY update_project ON workspace.%I FOR UPDATE TO workspace_app USING(workspace.can_edit(project_id)) WITH CHECK(workspace.can_edit(project_id))',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON workspace.%I TO workspace_app',t);
  END LOOP;
END; $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA workspace FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA workspace TO workspace_app;
