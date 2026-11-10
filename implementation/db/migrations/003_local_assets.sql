CREATE TABLE workspace.asset_files (
  project_id uuid NOT NULL, id uuid NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0 AND byte_size<=8388608),
  mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')), original_name text NOT NULL CHECK(length(original_name)<=240),
  width integer NOT NULL CHECK(width>0), height integer NOT NULL CHECK(height>0),
  PRIMARY KEY(project_id,id), FOREIGN KEY(project_id,id) REFERENCES workspace.asset_versions(project_id,id)
);
ALTER TABLE workspace.asset_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.asset_files FORCE ROW LEVEL SECURITY;
CREATE POLICY asset_file_read ON workspace.asset_files FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY asset_file_write ON workspace.asset_files FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id));
GRANT SELECT,INSERT ON workspace.asset_files TO workspace_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.asset_files FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
