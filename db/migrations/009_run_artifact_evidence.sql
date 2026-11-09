ALTER TABLE workspace.run_attempts ADD CONSTRAINT attempt_run_identity UNIQUE(project_id,id,run_id);
CREATE TABLE workspace.run_preparations (
  project_id uuid NOT NULL,attempt_id uuid NOT NULL,run_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,attempt_id),UNIQUE(project_id,attempt_id,run_id),
  FOREIGN KEY(project_id,attempt_id,run_id) REFERENCES workspace.run_attempts(project_id,id,run_id)
);
CREATE TABLE workspace.run_artifacts (
  project_id uuid NOT NULL,run_id uuid NOT NULL,attempt_id uuid NOT NULL,
  manifest jsonb NOT NULL,manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),byte_size bigint NOT NULL CHECK(byte_size>0 AND byte_size<=8388608),
  created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,run_id),
  FOREIGN KEY(project_id,attempt_id,run_id) REFERENCES workspace.run_preparations(project_id,attempt_id,run_id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['run_preparations','run_artifacts'] LOOP
    EXECUTE format('ALTER TABLE workspace.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE workspace.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY evidence_read ON workspace.%I FOR SELECT TO workspace_app USING(workspace.can_read(project_id))',t);
    EXECUTE format('CREATE POLICY evidence_insert ON workspace.%I FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id))',t);
    EXECUTE format('GRANT SELECT,INSERT ON workspace.%I TO workspace_app',t);
    EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.%I FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation()',t);
  END LOOP;
END; $$;
