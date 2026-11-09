ALTER TABLE workspace.run_outputs ALTER COLUMN object_id DROP NOT NULL;
ALTER TABLE workspace.run_outputs ALTER COLUMN object_revision DROP NOT NULL;
ALTER TABLE workspace.run_outputs ADD CONSTRAINT output_placement_pair CHECK((object_id IS NULL)=(object_revision IS NULL));
ALTER TABLE workspace.run_outputs ADD CONSTRAINT output_asset_identity UNIQUE(project_id,run_id,asset_version_id);
CREATE TABLE workspace.run_output_placements (
  project_id uuid NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,asset_version_id uuid NOT NULL,
  object_id uuid NOT NULL,object_revision bigint NOT NULL,actor_id uuid NOT NULL,
  placement_order bigint GENERATED ALWAYS AS IDENTITY,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,id),UNIQUE(project_id,object_id),
  FOREIGN KEY(project_id,run_id,asset_version_id) REFERENCES workspace.run_outputs(project_id,run_id,asset_version_id),
  FOREIGN KEY(project_id,object_id,object_revision) REFERENCES workspace.object_revisions(project_id,object_id,revision)
);
CREATE INDEX result_placement_order ON workspace.run_output_placements(project_id,run_id,placement_order DESC);
CREATE TABLE workspace.run_placement_requests (
  project_id uuid NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,actor_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,id),FOREIGN KEY(project_id,run_id) REFERENCES workspace.runs(project_id,id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['run_output_placements','run_placement_requests'] LOOP
    EXECUTE format('ALTER TABLE workspace.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE workspace.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY placement_read ON workspace.%I FOR SELECT TO workspace_app USING(workspace.can_read(project_id))',t);
    EXECUTE format('CREATE POLICY placement_insert ON workspace.%I FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND actor_id=workspace.actor_id())',t);
    EXECUTE format('GRANT SELECT,INSERT ON workspace.%I TO workspace_app',t);
    EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.%I FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation()',t);
  END LOOP;
END; $$;
GRANT USAGE,SELECT ON SEQUENCE workspace.run_output_placements_placement_order_seq TO workspace_app;
-- Invoker permissions and underlying forced RLS apply to every candidate.
-- A changed/deleted result card becomes unplaced without modifying its receipt.
CREATE VIEW workspace.current_run_outputs WITH(security_invoker=true) AS
SELECT o.project_id,o.run_id,o.attempt_id,o.asset_version_id,o.sha256,o.created_at,
  live.object_id,live.object_revision,(live.object_id IS NULL) AS unplaced
FROM workspace.run_outputs o LEFT JOIN LATERAL (
  SELECT candidate.object_id,candidate.object_revision FROM (
    SELECT o.object_id,o.object_revision,0::bigint AS placement_order
    UNION ALL
    SELECT p.object_id,p.object_revision,p.placement_order FROM workspace.run_output_placements p WHERE p.project_id=o.project_id AND p.run_id=o.run_id
  ) candidate
  JOIN workspace.objects c ON c.project_id=o.project_id AND c.id=candidate.object_id
  JOIN workspace.object_revisions r ON r.project_id=c.project_id AND r.object_id=c.id AND r.revision=c.current_revision
  WHERE coalesce((r.payload->>'deleted')::boolean,false)=false AND r.payload->>'type'='image' AND r.payload->>'assetVersionId'=o.asset_version_id::text
  ORDER BY candidate.placement_order DESC LIMIT 1
) live ON true;
GRANT SELECT ON workspace.current_run_outputs TO workspace_app;
