ALTER TABLE workspace.run_attempts ADD COLUMN execution_fenced boolean NOT NULL DEFAULT false;
CREATE TABLE workspace.run_archive_claims (
  project_id uuid NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,attempt_id uuid NOT NULL,
  actor_id uuid NOT NULL,worker_id uuid NOT NULL,token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,status text NOT NULL CHECK(status IN ('claimed','completed','failed')),
  claim_order bigint GENERATED ALWAYS AS IDENTITY,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,id),FOREIGN KEY(project_id,attempt_id,run_id) REFERENCES workspace.run_attempts(project_id,id,run_id)
);
CREATE INDEX archive_run_claim_order ON workspace.run_archive_claims(project_id,run_id,claim_order DESC);
ALTER TABLE workspace.run_archive_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.run_archive_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_claim_read ON workspace.run_archive_claims FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY archive_claim_insert ON workspace.run_archive_claims FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND actor_id=workspace.actor_id());
CREATE POLICY archive_claim_update ON workspace.run_archive_claims FOR UPDATE TO workspace_app USING(workspace.can_edit(project_id)) WITH CHECK(workspace.can_edit(project_id));
GRANT SELECT,INSERT,UPDATE ON workspace.run_archive_claims TO workspace_app;
GRANT USAGE,SELECT ON SEQUENCE workspace.run_archive_claims_claim_order_seq TO workspace_app;
CREATE FUNCTION workspace.guard_archive_claim() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ARCHIVE_CLAIM_IMMUTABLE'; END IF;
  IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'ARCHIVE_CLAIM_IMMUTABLE'; END IF;
  IF NEW.status<>OLD.status AND NOT (OLD.status='claimed' AND NEW.status IN ('completed','failed')) THEN RAISE EXCEPTION 'ARCHIVE_TRANSITION_INVALID'; END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION workspace.guard_archive_claim() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace.guard_archive_claim() TO workspace_app;
CREATE TRIGGER guard_archive_claim BEFORE UPDATE OR DELETE ON workspace.run_archive_claims FOR EACH ROW EXECUTE FUNCTION workspace.guard_archive_claim();
CREATE OR REPLACE FUNCTION workspace.guard_run_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
  IF OLD.execution_fenced AND NOT NEW.execution_fenced THEN RAISE EXCEPTION 'ATTEMPT_FENCE_IMMUTABLE'; END IF;
  IF NEW.project_id<>OLD.project_id OR NEW.id<>OLD.id OR NEW.run_id<>OLD.run_id OR NEW.actor_id<>OLD.actor_id
    OR NEW.worker_id<>OLD.worker_id OR NEW.token_hash<>OLD.token_hash OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'ATTEMPT_IDENTITY_IMMUTABLE'; END IF;
  IF OLD.request_payload IS NOT NULL AND (NEW.request_payload IS DISTINCT FROM OLD.request_payload OR NEW.request_hash IS DISTINCT FROM OLD.request_hash) THEN RAISE EXCEPTION 'ATTEMPT_REQUEST_IMMUTABLE'; END IF;
  IF OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id THEN RAISE EXCEPTION 'ATTEMPT_PROVIDER_ID_IMMUTABLE'; END IF;
  IF OLD.response_payload IS NOT NULL AND NEW.response_payload IS DISTINCT FROM OLD.response_payload THEN RAISE EXCEPTION 'ATTEMPT_RESPONSE_IMMUTABLE'; END IF;
  IF NEW.stage<>OLD.stage AND NOT (
    (OLD.stage='claimed' AND NEW.stage IN ('submitted','failed','cancelled')) OR
    (OLD.stage='submitted' AND NEW.stage IN ('returned','unknown','failed','cancelled')) OR
    (OLD.stage='returned' AND NEW.stage IN ('completed','unknown','failed')) OR
    (OLD.stage='unknown' AND NEW.stage='completed' AND EXISTS(
      SELECT 1 FROM workspace.run_archive_claims c JOIN workspace.run_artifacts a ON a.project_id=c.project_id AND a.run_id=c.run_id AND a.attempt_id=c.attempt_id
      WHERE c.project_id=NEW.project_id AND c.run_id=NEW.run_id AND c.attempt_id=NEW.id AND c.actor_id=workspace.actor_id() AND c.status='claimed' AND c.expires_at>now()))
  ) THEN RAISE EXCEPTION 'ATTEMPT_TRANSITION_INVALID'; END IF;
  RETURN NEW;
END; $$;
