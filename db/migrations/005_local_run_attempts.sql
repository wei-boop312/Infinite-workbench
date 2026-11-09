CREATE TABLE workspace.run_attempts (
  project_id uuid NOT NULL, id uuid NOT NULL, run_id uuid NOT NULL, actor_id uuid NOT NULL, worker_id uuid NOT NULL,
  token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'), lease_expires_at timestamptz NOT NULL,
  stage text NOT NULL CHECK(stage IN ('claimed','submitted','returned','completed','unknown','failed')),
  request_payload jsonb, request_hash text, provider_request_id text, response_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,id), UNIQUE(project_id,run_id),
  FOREIGN KEY(project_id,run_id) REFERENCES workspace.runs(project_id,id)
);
ALTER TABLE workspace.run_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.run_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY attempt_read ON workspace.run_attempts FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY attempt_insert ON workspace.run_attempts FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id));
CREATE POLICY attempt_update ON workspace.run_attempts FOR UPDATE TO workspace_app USING(workspace.can_edit(project_id)) WITH CHECK(workspace.can_edit(project_id));
GRANT SELECT,INSERT,UPDATE ON workspace.run_attempts TO workspace_app;
CREATE FUNCTION workspace.guard_run_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.project_id<>OLD.project_id OR NEW.id<>OLD.id OR NEW.run_id<>OLD.run_id OR NEW.actor_id<>OLD.actor_id
    OR NEW.worker_id<>OLD.worker_id OR NEW.token_hash<>OLD.token_hash OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'ATTEMPT_IDENTITY_IMMUTABLE'; END IF;
  IF OLD.request_payload IS NOT NULL AND (NEW.request_payload IS DISTINCT FROM OLD.request_payload OR NEW.request_hash IS DISTINCT FROM OLD.request_hash) THEN RAISE EXCEPTION 'ATTEMPT_REQUEST_IMMUTABLE'; END IF;
  IF OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id THEN RAISE EXCEPTION 'ATTEMPT_PROVIDER_ID_IMMUTABLE'; END IF;
  IF OLD.response_payload IS NOT NULL AND NEW.response_payload IS DISTINCT FROM OLD.response_payload THEN RAISE EXCEPTION 'ATTEMPT_RESPONSE_IMMUTABLE'; END IF;
  IF NEW.stage<>OLD.stage AND NOT (
    (OLD.stage='claimed' AND NEW.stage IN ('submitted','failed')) OR
    (OLD.stage='submitted' AND NEW.stage IN ('returned','unknown','failed')) OR
    (OLD.stage='returned' AND NEW.stage IN ('completed','unknown','failed'))
  ) THEN RAISE EXCEPTION 'ATTEMPT_TRANSITION_INVALID'; END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION workspace.guard_run_attempt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace.guard_run_attempt() TO workspace_app;
CREATE TRIGGER guard_attempt BEFORE UPDATE ON workspace.run_attempts FOR EACH ROW EXECUTE FUNCTION workspace.guard_run_attempt();
ALTER TABLE workspace.runs ADD COLUMN event_sequence bigint NOT NULL DEFAULT 0;
CREATE TABLE workspace.run_events (
  project_id uuid NOT NULL,run_id uuid NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),
  actor_id uuid NOT NULL,attempt_id uuid NOT NULL,stage text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,run_id,sequence),
  FOREIGN KEY(project_id,run_id) REFERENCES workspace.runs(project_id,id),
  FOREIGN KEY(project_id,attempt_id) REFERENCES workspace.run_attempts(project_id,id)
);
ALTER TABLE workspace.run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.run_events FORCE ROW LEVEL SECURITY;
CREATE POLICY event_read ON workspace.run_events FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY event_insert ON workspace.run_events FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id));
GRANT SELECT,INSERT ON workspace.run_events TO workspace_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.run_events FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
CREATE FUNCTION workspace.log_run_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ DECLARE next_sequence bigint; BEGIN
  IF TG_OP='UPDATE' AND NEW.stage=OLD.stage THEN RETURN NEW; END IF;
  UPDATE workspace.runs SET event_sequence=event_sequence+1 WHERE project_id=NEW.project_id AND id=NEW.run_id RETURNING event_sequence INTO next_sequence;
  IF next_sequence IS NULL THEN RAISE EXCEPTION 'EXECUTION_PERMISSION_DENIED'; END IF;
  INSERT INTO workspace.run_events VALUES(NEW.project_id,NEW.run_id,next_sequence,workspace.actor_id(),NEW.id,NEW.stage,now());
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION workspace.log_run_attempt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace.log_run_attempt() TO workspace_app;
CREATE TRIGGER log_attempt AFTER INSERT OR UPDATE OF stage ON workspace.run_attempts FOR EACH ROW EXECUTE FUNCTION workspace.log_run_attempt();
