ALTER TABLE workspace.asset_versions ADD COLUMN kind text NOT NULL DEFAULT 'image' CHECK(kind IN ('image','document'));
ALTER TABLE workspace.asset_versions ADD CONSTRAINT asset_kind_identity UNIQUE(project_id,id,kind);
ALTER TABLE workspace.asset_files ADD COLUMN kind text NOT NULL DEFAULT 'image' CHECK(kind='image');
ALTER TABLE workspace.asset_files ADD CONSTRAINT image_asset_kind FOREIGN KEY(project_id,id,kind) REFERENCES workspace.asset_versions(project_id,id,kind);
CREATE TABLE workspace.asset_documents (
  project_id uuid NOT NULL,id uuid NOT NULL,byte_size bigint NOT NULL CHECK(byte_size>0 AND byte_size<=2097152),
  mime text NOT NULL CHECK(mime IN ('text/plain','text/markdown','text/csv')),original_name text NOT NULL CHECK(length(original_name) BETWEEN 1 AND 240),
  character_count integer NOT NULL CHECK(character_count>=0),line_count integer NOT NULL CHECK(line_count>0),has_bom boolean NOT NULL,
  kind text NOT NULL DEFAULT 'document' CHECK(kind='document'),PRIMARY KEY(project_id,id),
  FOREIGN KEY(project_id,id,kind) REFERENCES workspace.asset_versions(project_id,id,kind)
);
ALTER TABLE workspace.asset_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.asset_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY document_read ON workspace.asset_documents FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY document_insert ON workspace.asset_documents FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id));
GRANT SELECT,INSERT ON workspace.asset_documents TO workspace_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.asset_documents FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
ALTER TABLE workspace.object_revisions ADD COLUMN asset_kind text GENERATED ALWAYS AS (CASE payload->>'type' WHEN 'image' THEN 'image' WHEN 'file' THEN 'document' ELSE NULL END) STORED;
ALTER TABLE workspace.object_revisions ADD CONSTRAINT object_asset_kind FOREIGN KEY(project_id,asset_version_id,asset_kind) REFERENCES workspace.asset_versions(project_id,id,kind);
ALTER TABLE workspace.object_revisions ADD CONSTRAINT object_asset_payload CHECK(payload->>'type' NOT IN ('image','file') OR (asset_version_id IS NOT NULL AND (asset_version_id IS NOT DISTINCT FROM (payload->>'assetVersionId')::uuid)));
