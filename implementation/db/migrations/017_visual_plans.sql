CREATE TABLE workspace.visual_plans (
  project_id uuid NOT NULL REFERENCES workspace.projects(id),id uuid NOT NULL,current_revision bigint NOT NULL CHECK(current_revision>0),PRIMARY KEY(project_id,id)
);
CREATE TABLE workspace.visual_plan_revisions (
  project_id uuid NOT NULL,plan_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),payload jsonb NOT NULL,
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,plan_id,revision),FOREIGN KEY(project_id,plan_id) REFERENCES workspace.visual_plans(project_id,id)
);
CREATE TABLE workspace.visual_plan_fact_refs (
  project_id uuid NOT NULL,plan_id uuid NOT NULL,plan_revision bigint NOT NULL,asset_id uuid NOT NULL,fact_revision bigint NOT NULL,fact_id uuid NOT NULL,
  PRIMARY KEY(project_id,plan_id,plan_revision,asset_id,fact_revision,fact_id),
  FOREIGN KEY(project_id,plan_id,plan_revision) REFERENCES workspace.visual_plan_revisions(project_id,plan_id,revision),
  FOREIGN KEY(project_id,asset_id,fact_revision) REFERENCES workspace.document_fact_revisions(project_id,asset_id,revision)
);
CREATE TABLE workspace.visual_plan_asset_refs (
  project_id uuid NOT NULL,plan_id uuid NOT NULL,plan_revision bigint NOT NULL,asset_id uuid NOT NULL,
  PRIMARY KEY(project_id,plan_id,plan_revision,asset_id),FOREIGN KEY(project_id,plan_id,plan_revision) REFERENCES workspace.visual_plan_revisions(project_id,plan_id,revision),
  FOREIGN KEY(project_id,asset_id) REFERENCES workspace.asset_files(project_id,id)
);
CREATE TABLE workspace.visual_plan_requests (
  project_id uuid NOT NULL REFERENCES workspace.projects(id),id uuid NOT NULL,actor_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL,
  PRIMARY KEY(project_id,id)
);
ALTER TABLE workspace.visual_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.visual_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace.visual_plan_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.visual_plan_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace.visual_plan_fact_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.visual_plan_fact_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace.visual_plan_asset_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.visual_plan_asset_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace.visual_plan_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.visual_plan_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_read ON workspace.visual_plans FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY plan_insert ON workspace.visual_plans FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id));
CREATE POLICY plan_update ON workspace.visual_plans FOR UPDATE TO workspace_app USING(workspace.can_edit(project_id)) WITH CHECK(workspace.can_edit(project_id));
CREATE POLICY plan_revision_read ON workspace.visual_plan_revisions FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY plan_revision_insert ON workspace.visual_plan_revisions FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND created_by=workspace.actor_id());
CREATE POLICY plan_fact_read ON workspace.visual_plan_fact_refs FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY plan_fact_insert ON workspace.visual_plan_fact_refs FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id));
CREATE POLICY plan_asset_read ON workspace.visual_plan_asset_refs FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY plan_asset_insert ON workspace.visual_plan_asset_refs FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id));
CREATE POLICY plan_request_read ON workspace.visual_plan_requests FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY plan_request_insert ON workspace.visual_plan_requests FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND actor_id=workspace.actor_id());
GRANT SELECT,INSERT,UPDATE ON workspace.visual_plans TO workspace_app;
GRANT SELECT,INSERT ON workspace.visual_plan_revisions,workspace.visual_plan_fact_refs,workspace.visual_plan_asset_refs,workspace.visual_plan_requests TO workspace_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.visual_plan_revisions FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.visual_plan_fact_refs FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.visual_plan_asset_refs FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.visual_plan_requests FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
ALTER TABLE workspace.object_revisions ADD COLUMN source_plan_id uuid GENERATED ALWAYS AS (CASE WHEN payload->>'type'='text' THEN (payload->'planSource'->>'planId')::uuid ELSE NULL END) STORED;
ALTER TABLE workspace.object_revisions ADD COLUMN source_plan_revision bigint GENERATED ALWAYS AS (CASE WHEN payload->>'type'='text' THEN (payload->'planSource'->>'revision')::bigint ELSE NULL END) STORED;
ALTER TABLE workspace.object_revisions ADD CONSTRAINT object_plan_reference FOREIGN KEY(project_id,source_plan_id,source_plan_revision) REFERENCES workspace.visual_plan_revisions(project_id,plan_id,revision);
ALTER TABLE workspace.object_revisions ADD CONSTRAINT object_plan_source CHECK(NOT(payload ? 'planSource') OR ((payload->>'type') IS NOT DISTINCT FROM 'text' AND source_plan_id IS NOT NULL AND source_plan_revision IS NOT NULL AND source_plan_revision>0));
