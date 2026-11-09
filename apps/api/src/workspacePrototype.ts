import { createHash, randomUUID } from "node:crypto";
import {
  WorkspaceAssetSchema, WorkspaceObjectSchema, WorkspaceWorkflowSchema,
  WorkspaceTemplateSchema, WorkspaceBindingRequestSchema, WorkspaceParametersSchema,
  DisplayEdgeSchema,
  type WorkspaceAsset, type WorkspaceObject, type WorkspaceWorkflow,
  type WorkspaceTemplate, type WorkspaceBindingRequest, type WorkspaceParameters,
} from "@canvas/contracts";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error("NON_JSON_VALUE");
}
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function detached<T>(value: T): T { return structuredClone(value); }
function sameProject(projectId: string, resource: { projectId: string } | undefined) {
  if (!resource || resource.projectId !== projectId) throw new Error("NOT_FOUND");
}

export function validateWorkflow(graph: WorkspaceWorkflow): void {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) throw new Error("DUPLICATE_NODE");
    ids.add(node.id);
    if (node.type === "comfy.execute" && node.config.templateId !== "core_image_resize_v2") throw new Error("UNSUPPORTED_TEMPLATE");
    if (node.type !== "comfy.execute" && node.config.templateId !== undefined) throw new Error("INVALID_NODE_CONFIG");
  }
  const incoming = new Map<string, number>(graph.nodes.map(n => [n.id, 0]));
  const adjacent = new Map<string, string[]>(graph.nodes.map(n => [n.id, []]));
  const seenEdges = new Set<string>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error("MISSING_NODE");
    const key = `${edge.source}:${edge.sourcePort}:${edge.target}:${edge.targetPort}`;
    if (seenEdges.has(key)) throw new Error("DUPLICATE_EDGE");
    seenEdges.add(key);
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
    adjacent.get(edge.source)!.push(edge.target);
  }
  const degree = new Map(incoming);
  const queue = [...degree].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!; visited++;
    for (const next of adjacent.get(id)!) {
      degree.set(next, degree.get(next)! - 1);
      if (degree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== ids.size) throw new Error("WORKFLOW_CYCLE");
  const counts = (type: string) => graph.nodes.filter(n => n.type === type).length;
  if (graph.nodes.length !== 3 || counts("input.asset") !== 1 || counts("comfy.execute") !== 1 || counts("output.asset") !== 1) {
    throw new Error("UNSUPPORTED_GRAPH_SHAPE");
  }
  for (const node of graph.nodes) {
    const expectedInput = node.type === "input.asset" ? 0 : 1;
    const expectedOutput = node.type === "output.asset" ? 0 : 1;
    if (incoming.get(node.id) !== expectedInput || adjacent.get(node.id)!.length !== expectedOutput) throw new Error("INVALID_PORT_MAPPING");
  }
}

export type PinnedBinding = WorkspaceBindingRequest & {
  workflowVersionId: string; workflowHash: string; templateHash: string;
  source: WorkspaceObject; tool: WorkspaceObject; asset: WorkspaceAsset;
};
export type PreparedRun = {
  id: string; projectId: string; state: "prepared_not_submitted";
  snapshot: {
    schemaVersion: 1; binding: PinnedBinding;
    workflow: WorkspaceWorkflow; template: WorkspaceTemplate; parameters: WorkspaceParameters;
    compilerPin: CompilerPin;
  };
  snapshotHash: string; executionAuthorized: false;
};
export type CompilerPin = { version: "2.15.2"; sourceTreeSha256: string; registrySha256: string; registryKind: "recorded-fixture-not-live" };

/** TASK-02/03 contract harness only. No DB, authentication, HTTP or execution. */
export class WorkspacePrototype {
  private compilerPin: CompilerPin;
  constructor(pin: CompilerPin) {
    if (pin.version !== "2.15.2" || pin.registryKind !== "recorded-fixture-not-live" ||
      !/^[a-f0-9]{64}$/.test(pin.sourceTreeSha256) || !/^[a-f0-9]{64}$/.test(pin.registrySha256)) throw new Error("INVALID_COMPILER_PIN");
    this.compilerPin = detached(pin);
  }
  private assets = new Map<string, WorkspaceAsset>();
  private objects = new Map<string, WorkspaceObject[]>();
  private workflows = new Map<string, WorkspaceWorkflow>();
  private templates = new Map<string, WorkspaceTemplate>();
  private bindings = new Map<string, PinnedBinding>();
  private runs = new Map<string, { requestHash: string; run: PreparedRun }>();
  private displayEdges = new Map<string, ReturnType<typeof DisplayEdgeSchema.parse>>();

  registerReadyAsset(projectId: string, raw: unknown) {
    const asset = WorkspaceAssetSchema.parse(raw); sameProject(projectId, asset);
    if (this.assets.has(asset.id)) { sameProject(projectId, this.assets.get(asset.id)); throw new Error("IMMUTABLE_ASSET_VERSION"); }
    this.assets.set(asset.id, detached(asset));
  }

  appendObjectRevision(projectId: string, raw: unknown, baseRevision: number) {
    const object = WorkspaceObjectSchema.parse(raw); sameProject(projectId, object);
    if(object.type==='file')throw new Error("DOCUMENTS_REQUIRE_PERSISTENT_ADAPTER");
    if(object.type==='task')throw new Error("TASK_CARDS_REQUIRE_PERSISTENT_ADAPTER");
    const history = this.objects.get(object.id) ?? [];
    if (history.length) sameProject(projectId, history[0]);
    if ((history.at(-1)?.revision ?? 0) !== baseRevision || object.revision !== baseRevision + 1) throw new Error("REVISION_CONFLICT");
    if (history[0] && history[0].type !== object.type) throw new Error("OBJECT_TYPE_IMMUTABLE");
    if (object.type === "image") sameProject(projectId, this.assets.get(object.assetVersionId));
    if (object.type === "tool") sameProject(projectId, this.templates.get(object.templateVersionId));
    this.objects.set(object.id, [...history, detached(object)]);
  }

  publishWorkflow(projectId: string, raw: unknown) {
    const graph = WorkspaceWorkflowSchema.parse(raw); sameProject(projectId, graph); validateWorkflow(graph);
    if (this.workflows.has(graph.id)) { sameProject(projectId, this.workflows.get(graph.id)); throw new Error("IMMUTABLE_WORKFLOW_VERSION"); }
    if ([...this.workflows.values()].some(v => v.projectId === projectId && v.workflowId === graph.workflowId && v.version === graph.version)) throw new Error("VERSION_CONFLICT");
    this.workflows.set(graph.id, detached(graph)); return contentHash(graph);
  }

  publishTemplate(projectId: string, raw: unknown) {
    const template = WorkspaceTemplateSchema.parse(raw); sameProject(projectId, template);
    sameProject(projectId, this.workflows.get(template.workflowVersionId));
    if (this.templates.has(template.id)) { sameProject(projectId, this.templates.get(template.id)); throw new Error("IMMUTABLE_TEMPLATE_VERSION"); }
    if ([...this.templates.values()].some(v => v.projectId === projectId && v.templateId === template.templateId && v.version === template.version)) throw new Error("VERSION_CONFLICT");
    this.templates.set(template.id, detached(template)); return contentHash(template);
  }

  private revision(projectId: string, id: string, revision: number): WorkspaceObject {
    const object = this.objects.get(id)?.find(v => v.revision === revision); sameProject(projectId, object);
    return object!;
  }

  bind(projectId: string, raw: unknown): PinnedBinding {
    const request = WorkspaceBindingRequestSchema.parse(raw); sameProject(projectId, request);
    if (this.bindings.has(request.id)) { sameProject(projectId, this.bindings.get(request.id)); throw new Error("IMMUTABLE_BINDING"); }
    const source = this.revision(projectId, request.sourceObjectId, request.sourceObjectRevision);
    const tool = this.revision(projectId, request.toolObjectId, request.toolObjectRevision);
    const template = this.templates.get(request.templateVersionId); sameProject(projectId, template);
    if (source.type !== "image" || tool.type !== "tool" || tool.templateVersionId !== template!.id) throw new Error("INVALID_BINDING");
    const workflow = this.workflows.get(template!.workflowVersionId)!; sameProject(projectId, workflow);
    const asset = this.assets.get(source.assetVersionId)!; sameProject(projectId, asset);
    const binding = { ...request, workflowVersionId: workflow.id, workflowHash: contentHash(workflow),
      templateHash: contentHash(template), source: detached(source), tool: detached(tool), asset: detached(asset) };
    this.bindings.set(request.id, binding); return detached(binding);
  }

  references(projectId: string, filter: { objectId?: string; workflowVersionId?: string }) {
    if ((filter.objectId === undefined) === (filter.workflowVersionId === undefined)) throw new Error("ONE_REFERENCE_FILTER_REQUIRED");
    if (filter.objectId) sameProject(projectId, this.objects.get(filter.objectId)?.at(-1));
    if (filter.workflowVersionId) sameProject(projectId, this.workflows.get(filter.workflowVersionId));
    return [...this.bindings.values()].filter(b => b.projectId === projectId &&
      (filter.objectId ? [b.sourceObjectId, b.toolObjectId].includes(filter.objectId) : b.workflowVersionId === filter.workflowVersionId))
      .map(b => ({ ...detached(b), inputChanged: this.objects.get(b.sourceObjectId)!.at(-1)!.revision !== b.sourceObjectRevision }));
  }

  addDisplayEdge(projectId: string, raw: unknown) {
    const edge = DisplayEdgeSchema.parse(raw); sameProject(projectId, edge);
    for (const id of [edge.sourceObjectId, edge.targetObjectId]) sameProject(projectId, this.objects.get(id)?.at(-1));
    if (this.displayEdges.has(edge.id)) throw new Error("EDGE_EXISTS");
    this.displayEdges.set(edge.id, detached(edge));
  }

  prepareRun(projectId: string, bindingId: string, rawParameters: unknown, idempotencyKey: string): PreparedRun {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) throw new Error("INVALID_IDEMPOTENCY_KEY");
    const binding = this.bindings.get(bindingId); sameProject(projectId, binding);
    const parameters = WorkspaceParametersSchema.parse(rawParameters);
    const requestHash = contentHash({ bindingId, parameters });
    const key = `${projectId}:${idempotencyKey}`; const existing = this.runs.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
      return detached(existing.run);
    }
    const snapshot = detached({ schemaVersion: 1 as const, binding: binding!,
      workflow: this.workflows.get(binding!.workflowVersionId)!, template: this.templates.get(binding!.templateVersionId)!, parameters,
      compilerPin: this.compilerPin });
    const run: PreparedRun = { id: randomUUID(), projectId, state: "prepared_not_submitted", snapshot,
      snapshotHash: contentHash(snapshot), executionAuthorized: false };
    this.runs.set(key, { requestHash, run }); return detached(run);
  }
}
