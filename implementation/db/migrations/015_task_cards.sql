ALTER TABLE workspace.object_revisions ADD COLUMN task_run_id uuid GENERATED ALWAYS AS (CASE WHEN payload->>'type'='task' THEN (payload->>'runId')::uuid ELSE NULL END) STORED;
ALTER TABLE workspace.object_revisions ADD CONSTRAINT task_card_run FOREIGN KEY(project_id,task_run_id) REFERENCES workspace.runs(project_id,id);
ALTER TABLE workspace.object_revisions ADD CONSTRAINT task_card_reference CHECK(payload->>'type'<>'task' OR task_run_id IS NOT NULL);
