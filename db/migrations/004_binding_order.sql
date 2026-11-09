-- Existing binding payloads remain unchanged; order is explicit for new binds.
ALTER TABLE workspace.bindings ADD COLUMN binding_order bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX binding_tool_lookup ON workspace.bindings(project_id,((payload->>'toolObjectId')),binding_order DESC);
