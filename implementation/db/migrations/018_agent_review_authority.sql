CREATE TABLE workspace.agent_review_grants (
  project_id uuid NOT NULL REFERENCES workspace.projects(id),id uuid NOT NULL,actor_id uuid NOT NULL,payload jsonb NOT NULL,
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),PRIMARY KEY(project_id,id)
);
CREATE TABLE workspace.agent_review_state (
  project_id uuid NOT NULL,grant_id uuid NOT NULL,proposal_count integer NOT NULL CHECK(proposal_count BETWEEN 0 AND 8),PRIMARY KEY(project_id,grant_id),
  FOREIGN KEY(project_id,grant_id) REFERENCES workspace.agent_review_grants(project_id,id)
);
CREATE TABLE workspace.agent_review_revocations (
  project_id uuid NOT NULL,grant_id uuid NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason)<=240),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,grant_id),
  FOREIGN KEY(project_id,grant_id) REFERENCES workspace.agent_review_grants(project_id,id)
);
CREATE TABLE workspace.agent_review_proposals (
  project_id uuid NOT NULL,id uuid NOT NULL,grant_id uuid NOT NULL,actor_id uuid NOT NULL,payload jsonb NOT NULL,
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),PRIMARY KEY(project_id,id),
  FOREIGN KEY(project_id,grant_id) REFERENCES workspace.agent_review_grants(project_id,id)
);
CREATE TABLE workspace.agent_review_approvals (
  project_id uuid NOT NULL,proposal_id uuid NOT NULL,actor_id uuid NOT NULL,approval_hash text NOT NULL CHECK(approval_hash ~ '^[a-f0-9]{64}$'),nonce uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,proposal_id),UNIQUE(project_id,nonce),FOREIGN KEY(project_id,proposal_id) REFERENCES workspace.agent_review_proposals(project_id,id)
);
ALTER TABLE workspace.agent_review_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.agent_review_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace.agent_review_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.agent_review_state FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace.agent_review_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.agent_review_revocations FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace.agent_review_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.agent_review_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace.agent_review_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.agent_review_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY review_grant_read ON workspace.agent_review_grants FOR SELECT TO workspace_app USING(workspace.can_read(project_id) AND actor_id=workspace.actor_id());
CREATE POLICY review_grant_insert ON workspace.agent_review_grants FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND actor_id=workspace.actor_id());
CREATE POLICY review_state_read ON workspace.agent_review_state FOR SELECT TO workspace_app USING(workspace.can_read(project_id) AND EXISTS(SELECT 1 FROM workspace.agent_review_grants g WHERE g.project_id=agent_review_state.project_id AND g.id=grant_id));
CREATE POLICY review_state_insert ON workspace.agent_review_state FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND EXISTS(SELECT 1 FROM workspace.agent_review_grants g WHERE g.project_id=agent_review_state.project_id AND g.id=grant_id));
CREATE POLICY review_state_update ON workspace.agent_review_state FOR UPDATE TO workspace_app USING(workspace.can_read(project_id) AND EXISTS(SELECT 1 FROM workspace.agent_review_grants g WHERE g.project_id=agent_review_state.project_id AND g.id=grant_id)) WITH CHECK(workspace.can_read(project_id) AND EXISTS(SELECT 1 FROM workspace.agent_review_grants g WHERE g.project_id=agent_review_state.project_id AND g.id=grant_id));
CREATE POLICY review_revoke_read ON workspace.agent_review_revocations FOR SELECT TO workspace_app USING(workspace.can_read(project_id) AND actor_id=workspace.actor_id());
CREATE POLICY review_revoke_insert ON workspace.agent_review_revocations FOR INSERT TO workspace_app WITH CHECK(workspace.can_read(project_id) AND actor_id=workspace.actor_id() AND EXISTS(SELECT 1 FROM workspace.agent_review_grants g WHERE g.project_id=agent_review_revocations.project_id AND g.id=grant_id));
CREATE POLICY review_proposal_read ON workspace.agent_review_proposals FOR SELECT TO workspace_app USING(workspace.can_read(project_id) AND actor_id=workspace.actor_id());
CREATE POLICY review_proposal_insert ON workspace.agent_review_proposals FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND actor_id=workspace.actor_id() AND EXISTS(SELECT 1 FROM workspace.agent_review_grants g WHERE g.project_id=agent_review_proposals.project_id AND g.id=grant_id));
CREATE POLICY review_approval_read ON workspace.agent_review_approvals FOR SELECT TO workspace_app USING(workspace.can_read(project_id) AND actor_id=workspace.actor_id());
CREATE POLICY review_approval_insert ON workspace.agent_review_approvals FOR INSERT TO workspace_app WITH CHECK(workspace.can_edit(project_id) AND actor_id=workspace.actor_id() AND EXISTS(SELECT 1 FROM workspace.agent_review_proposals p WHERE p.project_id=agent_review_approvals.project_id AND p.id=proposal_id));
GRANT SELECT,INSERT ON workspace.agent_review_grants,workspace.agent_review_revocations,workspace.agent_review_proposals,workspace.agent_review_approvals TO workspace_app;
GRANT SELECT,INSERT,UPDATE ON workspace.agent_review_state TO workspace_app;
CREATE FUNCTION workspace.guard_agent_review_counter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum integer;
BEGIN
  IF NOT workspace.can_edit(NEW.project_id) THEN RAISE EXCEPTION 'AGENT_AUTHORITY_DENIED'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.proposal_count<>0 THEN RAISE EXCEPTION 'AGENT_COUNTER_INVALID'; END IF;
  ELSE
    IF NEW.project_id<>OLD.project_id OR NEW.grant_id<>OLD.grant_id OR NEW.proposal_count<>OLD.proposal_count+1 THEN RAISE EXCEPTION 'AGENT_COUNTER_INVALID'; END IF;
    SELECT (payload->>'maxActions')::integer INTO maximum FROM workspace.agent_review_grants WHERE project_id=NEW.project_id AND id=NEW.grant_id;
    IF maximum IS NULL OR NEW.proposal_count>maximum THEN RAISE EXCEPTION 'AGENT_ACTION_LIMIT'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_counter_guard BEFORE INSERT OR UPDATE ON workspace.agent_review_state FOR EACH ROW EXECUTE FUNCTION workspace.guard_agent_review_counter();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.agent_review_grants FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.agent_review_revocations FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.agent_review_proposals FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON workspace.agent_review_approvals FOR EACH ROW EXECUTE FUNCTION workspace.reject_history_mutation();
