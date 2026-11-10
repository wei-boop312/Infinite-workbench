CREATE TABLE workspace.run_cancellations (
  project_id uuid NOT NULL,run_id uuid NOT NULL,requested_by uuid NOT NULL,
  reason text NOT NULL CHECK(length(reason)<=500),created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,run_id),FOREIGN KEY(project_id,run_id) REFERENCES workspace.runs(project_id,id)
);
ALTER TABLE workspace.run_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.run_cancellations FORCE ROW LEVEL SECURITY;
CREATE POLICY cancellation_read ON workspace.run_cancellations FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY cancellation_insert ON workspace.run_cancellations FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND requested_by=workspace.actor_id());
GRANT SELECT,INSERT ON workspace.run_cancellations TO workspace_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.run_cancellations FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
ALTER TABLE workspace.run_events ALTER COLUMN attempt_id DROP NOT NULL;
ALTER TABLE workspace.run_attempts DROP CONSTRAINT run_attempts_stage_check;
ALTER TABLE workspace.run_attempts ADD CONSTRAINT run_attempts_stage_check CHECK(stage IN ('claimed','submitted','returned','completed','unknown','failed','cancelled'));
CREATE OR REPLACE FUNCTION workspace.guard_run_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.project_id<>OLD.project_id OR NEW.id<>OLD.id OR NEW.run_id<>OLD.run_id OR NEW.actor_id<>OLD.actor_id
    OR NEW.worker_id<>OLD.worker_id OR NEW.token_hash<>OLD.token_hash OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'ATTEMPT_IDENTITY_IMMUTABLE'; END IF;
  IF OLD.request_payload IS NOT NULL AND (NEW.request_payload IS DISTINCT FROM OLD.request_payload OR NEW.request_hash IS DISTINCT FROM OLD.request_hash) THEN RAISE EXCEPTION 'ATTEMPT_REQUEST_IMMUTABLE'; END IF;
  IF OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id THEN RAISE EXCEPTION 'ATTEMPT_PROVIDER_ID_IMMUTABLE'; END IF;
  IF OLD.response_payload IS NOT NULL AND NEW.response_payload IS DISTINCT FROM OLD.response_payload THEN RAISE EXCEPTION 'ATTEMPT_RESPONSE_IMMUTABLE'; END IF;
  IF NEW.stage<>OLD.stage AND NOT (
    (OLD.stage='claimed' AND NEW.stage IN ('submitted','failed','cancelled')) OR
    (OLD.stage='submitted' AND NEW.stage IN ('returned','unknown','failed','cancelled')) OR
    (OLD.stage='returned' AND NEW.stage IN ('completed','unknown','failed'))
  ) THEN RAISE EXCEPTION 'ATTEMPT_TRANSITION_INVALID'; END IF;
  RETURN NEW;
END; $$;
