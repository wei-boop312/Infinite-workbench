CREATE TABLE workspace.canvas_operations (
  project_id uuid NOT NULL REFERENCES workspace.projects(id),id uuid NOT NULL,actor_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,id)
);
ALTER TABLE workspace.canvas_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.canvas_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY operation_read ON workspace.canvas_operations FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY operation_insert ON workspace.canvas_operations FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND actor_id=workspace.actor_id());
GRANT SELECT,INSERT ON workspace.canvas_operations TO workspace_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.canvas_operations FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
