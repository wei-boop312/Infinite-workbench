import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkspacePrototype, contentHash } from "../apps/api/src/workspacePrototype.ts";
import { compilePreparedResize, recordedCompilerPin } from "../apps/worker/src/compileResize.ts";
import { WorkspaceObjectSchema, WorkspaceWorkflowSchema } from "../packages/contracts/src/workspace.ts";

function setup() {
  const workspace = new WorkspacePrototype(recordedCompilerPin(process.cwd()));
  const projectId = randomUUID(), assetId = randomUUID(), sourceId = randomUUID(), toolId = randomUUID();
  const workflow = { id: randomUUID(), workflowId: randomUUID(), projectId, version: 1, nodes: [
    { id: "source", type: "input.asset", config: {} },
    { id: "resize", type: "comfy.execute", config: { templateId: "core_image_resize_v2" } },
    { id: "output", type: "output.asset", config: {} },
  ], edges: [
    { source: "source", sourcePort: "asset", target: "resize", targetPort: "asset" },
    { source: "resize", sourcePort: "asset", target: "output", targetPort: "asset" },
  ] };
  workspace.publishWorkflow(projectId, workflow);
  const template = { id: randomUUID(), templateId: randomUUID(), projectId, version: 1,
    workflowVersionId: workflow.id, operation: "image.resize", parameters: "resize-parameters-v1" };
  workspace.publishTemplate(projectId, template);
  workspace.registerReadyAsset(projectId, { id: assetId, projectId, sha256: "a".repeat(64), state: "ready", mime: "image/png" });
  const image = { id: sourceId, projectId, revision: 1, type: "image", assetVersionId: assetId, x: 0, y: 0, width: 320, height: 240 };
  const tool = { id: toolId, projectId, revision: 1, type: "tool", templateVersionId: template.id, x: 400, y: 0, width: 240, height: 160 };
  workspace.appendObjectRevision(projectId, image, 0); workspace.appendObjectRevision(projectId, tool, 0);
  const request = { id: randomUUID(), projectId, taskLineId: randomUUID(), sourceObjectId: sourceId, sourceObjectRevision: 1,
    toolObjectId: toolId, toolObjectRevision: 1, templateVersionId: template.id };
  const binding = workspace.bind(projectId, request);
  return { workspace, projectId, assetId, image, tool, workflow, template, request, binding };
}

describe("双层工作区迁移契约 FR-05/06 TASK-02/03", () => {
  it("普通对象不能携带节点配置，专业节点不能伪装对象", () => {
    const f = setup();
    expect(WorkspaceObjectSchema.safeParse({ ...f.image, nodes: [] }).success).toBe(false);
    expect(WorkspaceObjectSchema.safeParse(f.workflow.nodes[0]).success).toBe(false);
    expect(WorkspaceWorkflowSchema.safeParse({ ...f.workflow, nodes: [{ ...f.workflow.nodes[0], type: "python.exec" }] }).success).toBe(false);
  });
  it("普通展示连线不进入运行快照或变为执行边", () => {
    const f = setup(); const before = f.workspace.prepareRun(f.projectId, f.binding.id, { width: 256, height: 256 }, "before");
    f.workspace.addDisplayEdge(f.projectId, { id: randomUUID(), projectId: f.projectId, sourceObjectId: f.image.id, targetObjectId: f.tool.id, kind: "display" });
    const after = f.workspace.prepareRun(f.projectId, f.binding.id, { width: 256, height: 256 }, "after");
    expect(after.snapshotHash).toBe(before.snapshotHash);
    expect(() => f.workspace.addDisplayEdge(f.projectId, { id: randomUUID(), projectId: f.projectId, sourceObjectId: f.image.id, targetObjectId: f.tool.id, kind: "workflow" })).toThrow();
  });
  it("环、未知节点和无效端口在发布前拒绝", () => {
    const f = setup();
    const cyclic = structuredClone(f.workflow); cyclic.id = randomUUID(); cyclic.version = 2;
    cyclic.edges.push({ source: "output", sourcePort: "asset", target: "source", targetPort: "asset" });
    expect(() => f.workspace.publishWorkflow(f.projectId, cyclic)).toThrow("WORKFLOW_CYCLE");
    expect(() => f.workspace.publishWorkflow(f.projectId, { ...cyclic, edges: [{ ...cyclic.edges[0], source: "missing" }] })).toThrow("MISSING_NODE");
    expect(() => f.workspace.publishWorkflow(f.projectId, { ...cyclic, edges: [{ ...cyclic.edges[0], targetPort: "text" }] })).toThrow();
  });
  it("版本不可覆盖；发布新版本不修改已绑定运行", () => {
    const f = setup(); const first = f.workspace.prepareRun(f.projectId, f.binding.id, { width: 256, height: 256 }, "run1");
    expect(() => f.workspace.publishWorkflow(f.projectId, f.workflow)).toThrow("IMMUTABLE_WORKFLOW_VERSION");
    expect(() => f.workspace.publishTemplate(f.projectId, f.template)).toThrow("IMMUTABLE_TEMPLATE_VERSION");
    f.workspace.publishWorkflow(f.projectId, { ...f.workflow, id: randomUUID(), version: 2 });
    const second = f.workspace.prepareRun(f.projectId, f.binding.id, { width: 256, height: 256 }, "run2");
    expect(second.snapshotHash).toBe(first.snapshotHash);
  });
  it("编辑源对象只标inputChanged；新绑定固定新输入，旧运行不漂移", () => {
    const f = setup(); const first = f.workspace.prepareRun(f.projectId, f.binding.id, { width: 256, height: 256 }, "run1");
    const secondAsset = randomUUID();
    f.workspace.registerReadyAsset(f.projectId, { id: secondAsset, projectId: f.projectId, sha256: "b".repeat(64), state: "ready", mime: "image/png" });
    f.workspace.appendObjectRevision(f.projectId, { ...f.image, revision: 2, assetVersionId: secondAsset }, 1);
    expect(f.workspace.references(f.projectId, { objectId: f.image.id })[0].inputChanged).toBe(true);
    expect(f.workspace.references(f.projectId, { workflowVersionId: f.workflow.id })[0].id).toBe(f.binding.id);
    const updated = f.workspace.bind(f.projectId, { ...f.request, id: randomUUID(), sourceObjectRevision: 2 });
    expect(updated.asset.id).toBe(secondAsset); expect(first.snapshot.binding.asset.id).toBe(f.assetId);
    expect(f.workspace.prepareRun(f.projectId, f.binding.id, { width: 256, height: 256 }, "run1")).toEqual(first);
  });
  it("跨项目读取、绑定和不ready资产均拒绝", () => {
    const f = setup(), other = randomUUID();
    expect(() => f.workspace.bind(other, { ...f.request, id: randomUUID(), projectId: other })).toThrow("NOT_FOUND");
    expect(() => f.workspace.references(other, { objectId: f.image.id })).toThrow("NOT_FOUND");
    expect(() => f.workspace.prepareRun(other, f.binding.id, { width: 256, height: 256 }, "x")).toThrow("NOT_FOUND");
    expect(() => f.workspace.registerReadyAsset(f.projectId, { id: randomUUID(), projectId: f.projectId, sha256: "a".repeat(64), state: "uploading", mime: "image/png" })).toThrow();
  });
  it("相同幂等键只生成一次；异参重用拒绝且输出副本不污染服务端", () => {
    const f = setup(); const r = f.workspace.prepareRun(f.projectId, f.binding.id, { width: 256, height: 256 }, "once");
    r.snapshot.parameters.width = 512;
    expect(f.workspace.prepareRun(f.projectId, f.binding.id, { width: 256, height: 256 }, "once").snapshot.parameters.width).toBe(256);
    expect(() => f.workspace.prepareRun(f.projectId, f.binding.id, { width: 512, height: 256 }, "once")).toThrow("IDEMPOTENCY_CONFLICT");
    expect(() => f.workspace.prepareRun(f.projectId, f.binding.id, { width: 4096, height: 4096 }, "large")).toThrow();
  });
  it("对象修订冲突和对象类型改变拒绝", () => {
    const f = setup();
    expect(() => f.workspace.appendObjectRevision(f.projectId, { ...f.image, revision: 2 }, 0)).toThrow("REVISION_CONFLICT");
    expect(() => f.workspace.appendObjectRevision(f.projectId, { ...f.tool, id: f.image.id, revision: 2 }, 1)).toThrow("OBJECT_TYPE_IMMUTABLE");
  });
  it("规范hash不依赖字段顺序，非JSON数据不接受", () => {
    expect(contentHash({ width: 256, height: 128 })).toBe(contentHash({ height: 128, width: 256 }));
    expect(() => contentHash({ value: Number.NaN })).toThrow("NON_JSON_VALUE");
  });
  it("历史编译环境指纹变化时拒绝沿用旧快照", () => {
    const f = setup(); const run = f.workspace.prepareRun(f.projectId, f.binding.id, { width: 256, height: 256 }, "pin");
    run.snapshot.compilerPin.registrySha256 = "c".repeat(64);
    run.snapshotHash = contentHash(run.snapshot);
    expect(() => compilePreparedResize(run, { pythonExecutable: process.env.WORKSPACE_PYTHON ?? "D:/python/python.exe", root: process.cwd() })).toThrow("COMPILER_ENVIRONMENT_CHANGED");
  });
  it("真实调用保留的Python编译器产生256×256图，但不提交执行", () => {
    const f = setup(); const run = f.workspace.prepareRun(f.projectId, f.binding.id, { width: 256, height: 256 }, "compile");
    const pythonExecutable = process.env.WORKSPACE_PYTHON ?? "D:/python/python.exe";
    const output = compilePreparedResize(run, { pythonExecutable, root: process.cwd() });
    expect(output.compiled.ui_workflow.nodes).toHaveLength(3);
    expect(output.compiled.ui_workflow.links).toHaveLength(2);
    const scale = Object.values(output.compiled.api_prompt).find((n: any) => n.class_type === "ImageScale") as any;
    expect(scale.inputs.width).toBe(256); expect(scale.inputs.height).toBe(256);
    expect(output.provenance.asset_version_id).toBe(f.assetId);
    expect(output.provenance.registry_kind).toBe("recorded-fixture-not-live");
    expect(output.submitted).toBe(false); expect(output.execution_authorized).toBe(false);
    run.snapshot.parameters.width = 512;
    expect(() => compilePreparedResize(run, { pythonExecutable, root: process.cwd() })).toThrow("INVALID_SNAPSHOT");
  });
});
