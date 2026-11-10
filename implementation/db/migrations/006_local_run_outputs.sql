CREATE TABLE workspace.run_outputs (
  project_id uuid NOT NULL,run_id uuid NOT NULL,attempt_id uuid NOT NULL,
  asset_version_id uuid NOT NULL,object_id uuid NOT NULL,object_revision bigint NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,run_id),UNIQUE(project_id,asset_version_id),
  FOREIGN KEY(project_id,run_id) REFERENCES workspace.runs(project_id,id),
  FOREIGN KEY(project_id,attempt_id) REFERENCES workspace.run_attempts(project_id,id),
  FOREIGN KEY(project_id,asset_version_id) REFERENCES workspace.asset_versions(project_id,id),
  FOREIGN KEY(project_id,object_id,object_revision) REFERENCES workspace.object_revisions(project_id,object_id,revision)
);
ALTER TABLE workspace.run_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.run_outputs FORCE ROW LEVEL SECURITY;
CREATE POLICY output_read ON workspace.run_outputs FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY output_insert ON workspace.run_outputs FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id));
GRANT SELECT,INSERT ON workspace.run_outputs TO workspace_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.run_outputs FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
