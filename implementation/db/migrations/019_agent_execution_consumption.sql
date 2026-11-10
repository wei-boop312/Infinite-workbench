CREATE TABLE workspace.agent_execution_consumptions (
  project_id uuid NOT NULL,id uuid NOT NULL,actor_id uuid NOT NULL,grant_id uuid NOT NULL,proposal_id uuid NOT NULL,run_id uuid NOT NULL,
  nonce uuid,payload jsonb NOT NULL,content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,id),UNIQUE(project_id,proposal_id),UNIQUE(project_id,run_id),
  FOREIGN KEY(project_id,grant_id) REFERENCES workspace.agent_review_grants(project_id,id),
  FOREIGN KEY(project_id,proposal_id) REFERENCES workspace.agent_review_proposals(project_id,id),
  FOREIGN KEY(project_id,run_id) REFERENCES workspace.runs(project_id,id)
);
CREATE UNIQUE INDEX agent_execution_nonce_once ON workspace.agent_execution_consumptions(project_id,nonce) WHERE nonce IS NOT NULL;
ALTER TABLE workspace.agent_review_approvals ADD CONSTRAINT agent_approval_nonce_identity UNIQUE(project_id,proposal_id,nonce);
ALTER TABLE workspace.agent_execution_consumptions ADD CONSTRAINT consumed_approval_identity FOREIGN KEY(project_id,proposal_id,nonce) REFERENCES workspace.agent_review_approvals(project_id,proposal_id,nonce);
ALTER TABLE workspace.agent_execution_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.agent_execution_consumptions FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_consumption_read ON workspace.agent_execution_consumptions FOR SELECT TO workspace_app USING(workspace.can_read(project_id));
CREATE POLICY execution_consumption_insert ON workspace.agent_execution_consumptions FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND actor_id=workspace.actor_id() AND EXISTS(SELECT 1 FROM workspace.agent_review_grants g WHERE g.project_id=agent_execution_consumptions.project_id AND g.id=grant_id) AND EXISTS(SELECT 1 FROM workspace.agent_review_proposals p WHERE p.project_id=agent_execution_consumptions.project_id AND p.id=proposal_id));
GRANT SELECT,INSERT ON workspace.agent_execution_consumptions TO workspace_app;
CREATE FUNCTION workspace.guard_agent_execution_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g record;p record;s jsonb;
BEGIN
  SELECT payload,content_hash,actor_id INTO g FROM workspace.agent_review_grants WHERE project_id=NEW.project_id AND id=NEW.grant_id;
  SELECT payload,content_hash,grant_id,actor_id INTO p FROM workspace.agent_review_proposals WHERE project_id=NEW.project_id AND id=NEW.proposal_id;
  SELECT snap.payload INTO s FROM workspace.runs r JOIN workspace.run_snapshots snap ON snap.project_id=r.project_id AND snap.id=r.snapshot_id WHERE r.project_id=NEW.project_id AND r.id=NEW.run_id;
  IF g.payload IS NULL OR p.payload IS NULL OR s IS NULL OR g.actor_id<>NEW.actor_id OR p.actor_id<>NEW.actor_id OR p.grant_id<>NEW.grant_id
    OR g.payload->>'mode' IS DISTINCT FROM 'local_resize_execute' OR p.payload->>'mode' IS DISTINCT FROM 'local_resize_execute'
    OR g.payload->>'policyVersion' IS DISTINCT FROM 'local-agent-execute-v1' OR p.payload->>'policyVersion' IS DISTINCT FROM 'local-agent-execute-v1'
    OR g.payload->>'level'='L0' OR (g.payload->>'expiresAt')::timestamptz<=now()
    OR EXISTS(SELECT 1 FROM workspace.agent_review_revocations WHERE project_id=NEW.project_id AND grant_id=NEW.grant_id)
    OR NOT workspace.can_edit(NEW.project_id)
    THEN RAISE EXCEPTION 'AGENT_EXECUTION_DENIED'; END IF;
  IF (g.payload->>'level'='L1' AND (NEW.nonce IS NULL OR NOT EXISTS(SELECT 1 FROM workspace.agent_review_approvals a WHERE a.project_id=NEW.project_id AND a.proposal_id=NEW.proposal_id AND a.nonce=NEW.nonce AND a.approval_hash=p.payload->>'approvalHash')))
    OR (g.payload->>'level' IS DISTINCT FROM 'L1' AND NEW.nonce IS NOT NULL)
    THEN RAISE EXCEPTION 'AGENT_APPROVAL_REQUIRED'; END IF;
  IF NEW.payload IS DISTINCT FROM s->'agentExecution' OR s->>'schemaVersion' IS DISTINCT FROM '3'
    OR NEW.payload->>'mode' IS DISTINCT FROM 'local_resize_execute' OR NEW.payload->>'policyVersion' IS DISTINCT FROM 'local-agent-execute-v1'
    OR NEW.payload->>'consumptionId' IS DISTINCT FROM NEW.id::text OR NEW.payload->>'grantId' IS DISTINCT FROM NEW.grant_id::text OR NEW.payload->>'proposalId' IS DISTINCT FROM NEW.proposal_id::text
    OR NEW.payload->>'grantHash' IS DISTINCT FROM g.content_hash OR NEW.payload->>'proposalHash' IS DISTINCT FROM p.content_hash OR NEW.payload->>'approvalHash' IS DISTINCT FROM p.payload->>'approvalHash'
    OR NEW.payload->>'nonce' IS DISTINCT FROM NEW.nonce::text
    OR s->'authorization'->>'actorId' IS DISTINCT FROM NEW.actor_id::text OR s->'authorization'->>'providerCost' IS DISTINCT FROM '0'
    OR s->'parameters' IS DISTINCT FROM p.payload->'arguments'->'parameters' OR s->'binding'->>'id' IS DISTINCT FROM p.payload->'arguments'->>'bindingId'
    THEN RAISE EXCEPTION 'AGENT_CONSUMPTION_INTEGRITY_FAILED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_consumption_guard BEFORE INSERT ON workspace.agent_execution_consumptions FOR EACH ROW EXECUTE FUNCTION workspace.guard_agent_execution_consumption();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.agent_execution_consumptions FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
