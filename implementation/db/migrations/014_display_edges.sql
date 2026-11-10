CREATE TABLE workspace.display_edges (
  project_id uuid NOT NULL REFERENCES workspace.projects(id),id uuid NOT NULL,current_revision bigint NOT NULL CHECK(current_revision>0),
  PRIMARY KEY(project_id,id)
);
CREATE TABLE workspace.display_edge_revisions (
  project_id uuid NOT NULL,edge_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),source_object_id uuid NOT NULL,target_object_id uuid NOT NULL,
  payload jsonb NOT NULL,content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),PRIMARY KEY(project_id,edge_id,revision),
  FOREIGN KEY(project_id,edge_id) REFERENCES workspace.display_edges(project_id,id),
  FOREIGN KEY(project_id,source_object_id) REFERENCES workspace.objects(project_id,id),
  FOREIGN KEY(project_id,target_object_id) REFERENCES workspace.objects(project_id,id),
  CHECK(source_object_id<>target_object_id),CHECK((payload->>'kind') IS NOT DISTINCT FROM 'display'),
  CHECK(source_object_id IS NOT DISTINCT FROM (payload->>'sourceObjectId')::uuid AND target_object_id IS NOT DISTINCT FROM (payload->>'targetObjectId')::uuid)
);
ALTER TABLE workspace.display_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.display_edges FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace.display_edge_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.display_edge_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY edge_read ON workspace.display_edges FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY edge_insert ON workspace.display_edges FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id));
CREATE POLICY edge_update ON workspace.display_edges FOR UPDATE TO workspace_app USING(workspace.can_edit(project_id)) WITH CHECK(workspace.can_edit(project_id));
CREATE POLICY edge_revision_read ON workspace.display_edge_revisions FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY edge_revision_insert ON workspace.display_edge_revisions FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id));
GRANT SELECT,INSERT,UPDATE ON workspace.display_edges TO workspace_app;
GRANT SELECT,INSERT ON workspace.display_edge_revisions TO workspace_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.display_edge_revisions FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
ALTER TABLE workspace.canvas_changes DROP CONSTRAINT canvas_changes_kind_check;
ALTER TABLE workspace.canvas_changes ALTER COLUMN object_id DROP NOT NULL;
ALTER TABLE workspace.canvas_changes ALTER COLUMN object_revision DROP NOT NULL;
ALTER TABLE workspace.canvas_changes ADD COLUMN edge_id uuid;
ALTER TABLE workspace.canvas_changes ADD COLUMN edge_revision bigint;
ALTER TABLE workspace.canvas_changes ADD CONSTRAINT canvas_edge_revision FOREIGN KEY(project_id,edge_id,edge_revision) REFERENCES workspace.display_edge_revisions(project_id,edge_id,revision);
ALTER TABLE workspace.canvas_changes ADD CONSTRAINT canvas_change_target CHECK(
  (kind IN ('editor','run_output') AND object_id IS NOT NULL AND object_revision IS NOT NULL AND edge_id IS NULL AND edge_revision IS NULL) OR
  (kind='editor_edge' AND object_id IS NULL AND object_revision IS NULL AND edge_id IS NOT NULL AND edge_revision IS NOT NULL)
);
