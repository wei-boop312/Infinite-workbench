CREATE TABLE workspace.document_fact_sets (
  project_id uuid NOT NULL,asset_id uuid NOT NULL,current_revision bigint NOT NULL CHECK(current_revision>0),PRIMARY KEY(project_id,asset_id),
  FOREIGN KEY(project_id,asset_id) REFERENCES workspace.asset_documents(project_id,id)
);
CREATE TABLE workspace.document_fact_revisions (
  project_id uuid NOT NULL,asset_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),payload jsonb NOT NULL,
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,asset_id,revision),FOREIGN KEY(project_id,asset_id) REFERENCES workspace.document_fact_sets(project_id,asset_id)
);
CREATE TABLE workspace.document_fact_requests (
  project_id uuid NOT NULL REFERENCES workspace.projects(id),id uuid NOT NULL,actor_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,PRIMARY KEY(project_id,id)
);
ALTER TABLE workspace.document_fact_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.document_fact_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace.document_fact_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.document_fact_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace.document_fact_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.document_fact_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY fact_set_read ON workspace.document_fact_sets FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY fact_set_insert ON workspace.document_fact_sets FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id));
CREATE POLICY fact_set_update ON workspace.document_fact_sets FOR UPDATE TO workspace_app USING(workspace.can_edit(project_id)) WITH CHECK(workspace.can_edit(project_id));
CREATE POLICY fact_revision_read ON workspace.document_fact_revisions FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY fact_revision_insert ON workspace.document_fact_revisions FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND created_by=workspace.actor_id());
CREATE POLICY fact_request_read ON workspace.document_fact_requests FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY fact_request_insert ON workspace.document_fact_requests FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND actor_id=workspace.actor_id());
GRANT SELECT,INSERT,UPDATE ON workspace.document_fact_sets TO workspace_app;
GRANT SELECT,INSERT ON workspace.document_fact_revisions,workspace.document_fact_requests TO workspace_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.document_fact_revisions FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.document_fact_requests FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
