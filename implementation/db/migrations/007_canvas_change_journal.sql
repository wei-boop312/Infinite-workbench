CREATE TABLE workspace.canvas_changes (
  project_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),
  kind text NOT NULL CHECK(kind IN ('editor','run_output')),
  object_id uuid NOT NULL,object_revision bigint NOT NULL,actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,revision),
  FOREIGN KEY(project_id) REFERENCES workspace.projects(id),
  FOREIGN KEY(project_id,object_id,object_revision) REFERENCES workspace.object_revisions(project_id,object_id,revision)
);
ALTER TABLE workspace.canvas_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.canvas_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY change_read ON workspace.canvas_changes FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY change_insert ON workspace.canvas_changes FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND actor_id=workspace.actor_id());
GRANT SELECT,INSERT ON workspace.canvas_changes TO workspace_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.canvas_changes FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
