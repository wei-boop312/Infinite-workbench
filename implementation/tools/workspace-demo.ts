import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkspacePrototype } from "../apps/api/src/workspacePrototype.ts";
import { compilePreparedResize, recordedCompilerPin } from "../apps/worker/src/compileResize.ts";
import { workspaceJsonSchemas } from "../packages/contracts/src/workspace.ts";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const workspace = new WorkspacePrototype(recordedCompilerPin(process.cwd())), projectId = id(1);
workspace.publishWorkflow(projectId, { id: id(2), workflowId: id(3), projectId, version: 1, nodes: [
  { id: "source", type: "input.asset", config: {} },
  { id: "resize", type: "comfy.execute", config: { templateId: "core_image_resize_v2" } },
  { id: "output", type: "output.asset", config: {} },
], edges: [
  { source: "source", sourcePort: "asset", target: "resize", targetPort: "asset" },
  { source: "resize", sourcePort: "asset", target: "output", targetPort: "asset" },
] });
workspace.publishTemplate(projectId, { id: id(4), templateId: id(5), projectId, workflowVersionId: id(2), version: 1, operation: "image.resize", parameters: "resize-parameters-v1" });
workspace.registerReadyAsset(projectId, { id: id(6), projectId, sha256: "a".repeat(64), mime: "image/png", state: "ready" });
workspace.appendObjectRevision(projectId, { id: id(7), projectId, revision: 1, type: "image", assetVersionId: id(6), x: 0, y: 0, width: 320, height: 240 }, 0);
workspace.appendObjectRevision(projectId, { id: id(8), projectId, revision: 1, type: "tool", templateVersionId: id(4), x: 400, y: 0, width: 240, height: 160 }, 0);
workspace.bind(projectId, { id: id(9), projectId, taskLineId: id(10), sourceObjectId: id(7), sourceObjectRevision: 1, toolObjectId: id(8), toolObjectRevision: 1, templateVersionId: id(4) });
const run = workspace.prepareRun(projectId, id(9), { width: 256, height: 256 }, "demo-resize-256");
const compiled = compilePreparedResize(run, { pythonExecutable: process.env.WORKSPACE_PYTHON ?? "D:/python/python.exe", root: process.cwd() });
const directory = resolve("docs/evidence/2026-11-09/prototype"); mkdirSync(directory, { recursive: true });
for (const [name, value] of Object.entries({ "prepared-run": run, "comfy-ui-workflow": compiled.compiled.ui_workflow,
  "comfy-api-prompt": compiled.compiled.api_prompt, "compile-report": compiled,
  ...workspaceJsonSchemas(),
})) writeFileSync(resolve(directory, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
console.log(JSON.stringify({ state: run.state, snapshotHash: run.snapshotHash, nodes: compiled.compiled.ui_workflow.nodes.length,
  links: compiled.compiled.ui_workflow.links.length, submitted: false, registry: "recorded-fixture-not-live", directory }, null, 2));
