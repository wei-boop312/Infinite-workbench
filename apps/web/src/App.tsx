import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import type { CanvasDocument } from "@canvas/contracts";
import { executeMockRun } from "@canvas/testing/browser";
import { documentToSnapshot, snapshotFingerprint, snapshotToDocument } from "./canvas/document";
import { layoutCanvas } from "./canvas/autoLayout";
import { validateConnection } from "./canvas/graphRules";
import { createHistoryState, historyReducer } from "./canvas/history";
import { LocalCanvasRepository, RevisionConflictError } from "./canvas/localRepository";
import {
  createId,
  createImageNode,
  createStressNodes,
  createTextNode,
  semanticEdges,
  semanticNodes,
  type CanvasEdge,
  type CanvasNode,
  type CanvasSnapshot,
  type GroupNode,
  type StudioKind,
  type StudioNode,
} from "./canvas/model";

const KIND_LABEL: Record<StudioKind, string> = {
  image: "图片资产",
  video: "视频资产",
  constraint: "人工约束",
  action: "AI 工具",
  output: "结果版本",
  text: "文字资产",
};

function nodeSize(node: CanvasNode): { width: number; height: number } {
  const width = node.measured?.width ?? Number.parseFloat(String(node.style?.width ?? (node.type === "group" ? 520 : 220)));
  const height = node.measured?.height ?? Number.parseFloat(String(node.style?.height ?? (node.type === "group" ? 340 : 160)));
  return { width, height };
}

const StudioCard = memo(function StudioCard({ data, selected }: NodeProps<StudioNode>) {
  const acceptsInputs = data.kind === "action";
  const hasGenericInput = data.kind === "output" || data.kind === "video";
  const hasOutput = data.kind !== "video";
  const outputDataClass = data.kind === "text" ? "port-data-text" : data.kind === "constraint" ? "port-data-constraint" : "port-data-image";
  return (
    <article className={`studio-node kind-${data.kind} ${selected ? "is-selected" : ""}`} style={{ "--accent": data.accent } as CSSProperties}>
      <NodeResizer minWidth={180} minHeight={116} isVisible={selected} lineClassName="resize-line" handleClassName="resize-handle" />
      {acceptsInputs && (
        <>
          <Handle id="product" className="port port-product port-data-image" type="target" position={Position.Left} style={{ top: 48 }} title="只接受图片" />
          <Handle id="constraint" className="port port-constraint port-data-mixed" type="target" position={Position.Left} style={{ top: 82 }} title="接受文字或约束" />
        </>
      )}
      {hasGenericInput && <Handle id="input" className="port port-input port-data-image" type="target" position={Position.Left} title="只接受图片" />}
      <header>
        <span>{KIND_LABEL[data.kind]}</span>
        {data.badge && <em>{data.badge}</em>}
      </header>
      {data.kind === "text" ? (
        <div className="text-preview">{data.body || "空文字节点"}</div>
      ) : (
        <div className="node-preview" aria-hidden="true"><i /><i /><i /></div>
      )}
      <strong>{data.title}</strong>
      <small>{data.subtitle}</small>
      {hasOutput && <Handle id="output" className={`port port-output ${outputDataClass}`} type="source" position={Position.Right} title={`${KIND_LABEL[data.kind]}输出`} />}
    </article>
  );
});

const GroupCard = memo(function GroupCard({ data, selected }: NodeProps<GroupNode>) {
  return (
    <section className={`group-node ${selected ? "is-selected" : ""}`} style={{ "--accent": data.accent } as CSSProperties}>
      <NodeResizer minWidth={360} minHeight={240} isVisible={selected} lineClassName="resize-line" handleClassName="resize-handle" />
      <strong>{data.title}</strong>
      <span>分组容器</span>
    </section>
  );
});

const nodeTypes = { studio: StudioCard, group: GroupCard };
const initialSnapshot: CanvasSnapshot = { nodes: semanticNodes, edges: semanticEdges };
const initialViewport: Viewport = { x: 0, y: 0, zoom: 1 };
const PROJECTS = [
  { documentId: "phase-1-demo", projectId: "project-main-image", label: "商品主图工作台" },
  { documentId: "phase-1-campaign", projectId: "project-campaign", label: "活动套图工作台" },
] as const;

type SaveState = "loading" | "dirty" | "saving" | "saved" | "conflict" | "error";

function CanvasKernel() {
  const [history, dispatch] = useReducer(historyReducer, initialSnapshot, createHistoryState);
  const [viewport, setViewport] = useState<Viewport>(initialViewport);
  const [documentId, setDocumentId] = useState("phase-1-demo");
  const [savedRevision, setSavedRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [conflict, setConflict] = useState<CanvasDocument | null>(null);
  const [saveFailure, setSaveFailure] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [lastAction, setLastAction] = useState("阶段 1 可靠画布已加载");
  const [online, setOnline] = useState(() => navigator.onLine);
  const clipboardRef = useRef<CanvasSnapshot | null>(null);
  const lastSavedFingerprint = useRef("");
  const currentRef = useRef({ snapshot: history.present, viewport, revision: savedRevision });
  const repository = useMemo(() => new LocalCanvasRepository(documentId), [documentId]);
  const activeProject = PROJECTS.find((project) => project.documentId === documentId);
  const projectId = activeProject?.projectId ?? "project-recovery";
  const { screenToFlowPosition, setViewport: setFlowViewport, fitView: fitCanvasView } = useReactFlow<CanvasNode, CanvasEdge>();

  const { nodes, edges } = history.present;
  currentRef.current = { snapshot: history.present, viewport, revision: savedRevision };

  const loadDocument = useCallback((document: CanvasDocument, message: string) => {
    const snapshot = documentToSnapshot(document);
    dispatch({ type: "reset", next: snapshot });
    setViewport(document.viewport);
    void setFlowViewport(document.viewport, { duration: 180 });
    setSavedRevision(document.revision);
    lastSavedFingerprint.current = snapshotFingerprint(snapshot, document.viewport);
    setSaveState("saved");
    setConflict(null);
    setLastAction(message);
  }, [setFlowViewport]);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(() => {
    setLoaded(false);
    setSaveState("loading");
    const stored = repository.load();
    if (stored) {
      loadDocument(stored, `已恢复本地修订 r${stored.revision}`);
    } else {
      dispatch({ type: "reset", next: initialSnapshot });
      setViewport(initialViewport);
      setSavedRevision(0);
      lastSavedFingerprint.current = "";
      setSaveState("dirty");
    }
    setLoaded(true);

    return repository.subscribe((remote) => {
      const current = currentRef.current;
      if (remote.revision <= current.revision) return;
      const currentFingerprint = snapshotFingerprint(current.snapshot, current.viewport);
      if (currentFingerprint === lastSavedFingerprint.current) {
        loadDocument(remote, `已同步另一标签页的修订 r${remote.revision}`);
      } else {
        setConflict(remote);
        setSaveState("conflict");
        setLastAction(`检测到修订冲突：本地 r${current.revision} / 另一标签 r${remote.revision}`);
      }
    });
  }, [loadDocument, repository]);

  useEffect(() => {
    if (!loaded || conflict) return;
    const fingerprint = snapshotFingerprint(history.present, viewport);
    if (fingerprint === lastSavedFingerprint.current) {
      setSaveState("saved");
      return;
    }
    setSaveState("dirty");
    const timer = window.setTimeout(() => {
      setSaveState("saving");
      try {
        const draft = snapshotToDocument(documentId, projectId, savedRevision, history.present, viewport);
        const saved = repository.save(draft, savedRevision);
        setSavedRevision(saved.revision);
        lastSavedFingerprint.current = fingerprint;
        setSaveFailure("");
        setSaveState("saved");
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          setConflict(error.remote);
          setSaveState("conflict");
        } else {
          setSaveFailure(error instanceof Error ? error.message : "未知本地保存错误");
          setSaveState("error");
          setLastAction("自动保存失败；当前修改仍保留在内存中，可重试或下载恢复文件");
        }
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [conflict, documentId, history.present, loaded, projectId, repository, retryNonce, savedRevision, viewport]);

  const commit = useCallback((next: CanvasSnapshot, message: string) => {
    dispatch({ type: "commit", next });
    setLastAction(message);
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const next = { nodes: applyNodeChanges(changes, nodes), edges };
    const selectionOnly = changes.every((change) => change.type === "select");
    const activeGesture = changes.some((change) =>
      (change.type === "position" && change.dragging === true)
      || (change.type === "dimensions" && change.resizing === true));
    const dimensionsOnly = changes.every((change) => change.type === "dimensions");

    if (selectionOnly || (dimensionsOnly && !activeGesture && !history.gestureBase)) {
      dispatch({ type: "transient", next });
    } else if (activeGesture) {
      dispatch({ type: "gesture", next });
    } else if (history.gestureBase) {
      dispatch({ type: "gesture-commit", next });
    } else {
      dispatch({ type: "commit", next });
    }
  }, [edges, history.gestureBase, nodes]);

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    const next = { nodes, edges: applyEdgeChanges(changes, edges) };
    if (changes.every((change) => change.type === "select")) dispatch({ type: "transient", next });
    else dispatch({ type: "commit", next });
  }, [edges, nodes]);

  const onConnect = useCallback((connection: Connection) => {
    const validation = validateConnection(connection, nodes, edges);
    if (!validation.valid) {
      setLastAction(`连接被拒绝：${validation.reason}`);
      return;
    }
    commit({
      nodes,
      edges: addEdge({ ...connection, type: "smoothstep", className: "edge-workflow", data: { kind: "workflow", dataType: validation.dataType } }, edges),
    }, "已建立用户工作流连线");
  }, [commit, edges, nodes]);

  const isConnectionValid = useCallback((connection: Connection | CanvasEdge) =>
    validateConnection(connection, nodes, edges).valid, [edges, nodes]);

  const autoArrange = useCallback(() => {
    commit({ nodes: layoutCanvas(nodes, edges), edges }, "已按工作流依赖自动整理顶层节点");
    window.setTimeout(() => void fitCanvasView({ padding: 0.18, duration: 260 }), 0);
  }, [commit, edges, fitCanvasView, nodes]);

  const addNode = useCallback((kind: "image" | "text") => {
    const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const deselected = nodes.map((node) => ({ ...node, selected: false }));
    const node = kind === "image" ? createImageNode(position) : createTextNode(position);
    commit({ nodes: [...deselected, node], edges }, kind === "image" ? "已添加图片资产节点" : "已添加文字资产节点");
  }, [commit, edges, nodes, screenToFlowPosition]);

  const selectedClosure = useCallback(() => {
    const selectedIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (node.parentId && selectedIds.has(node.parentId) && !selectedIds.has(node.id)) {
          selectedIds.add(node.id);
          changed = true;
        }
      }
    }
    return selectedIds;
  }, [nodes]);

  const copySelection = useCallback(() => {
    const ids = selectedClosure();
    if (!ids.size) return false;
    clipboardRef.current = {
      nodes: structuredClone(nodes.filter((node) => ids.has(node.id))),
      edges: structuredClone(edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.data?.kind !== "lineage")),
    };
    setLastAction(`已复制 ${ids.size} 个节点到画布剪贴板`);
    return true;
  }, [edges, nodes, selectedClosure]);

  const pasteSelection = useCallback(() => {
    const clipboard = clipboardRef.current;
    if (!clipboard?.nodes.length) return;
    const idMap = new Map(clipboard.nodes.map((node) => [node.id, createId(node.type === "group" ? "group" : "node")]));
    const pastedNodes = clipboard.nodes.map((node) => ({
      ...structuredClone(node),
      id: idMap.get(node.id)!,
      parentId: node.parentId ? idMap.get(node.parentId) : undefined,
      position: node.parentId ? node.position : { x: node.position.x + 44, y: node.position.y + 44 },
      selected: true,
    })) as CanvasNode[];
    const pastedEdges = clipboard.edges.map((edge) => ({
      ...structuredClone(edge),
      id: createId("edge"),
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
      selected: false,
    }));
    commit({
      nodes: [...nodes.map((node) => ({ ...node, selected: false })), ...pastedNodes],
      edges: [...edges, ...pastedEdges],
    }, `已粘贴 ${pastedNodes.length} 个节点`);
  }, [commit, edges, nodes]);

  const duplicateSelection = useCallback(() => {
    const copied = copySelection();
    if (copied) window.setTimeout(() => pasteSelection(), 0);
  }, [copySelection, pasteSelection]);

  const deleteSelection = useCallback(() => {
    const ids = selectedClosure();
    if (!ids.size) return;
    commit({
      nodes: nodes.filter((node) => !ids.has(node.id)),
      edges: edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)),
    }, `已删除 ${ids.size} 个画布节点；正式生成谱系将由后端独立保存`);
  }, [commit, edges, nodes, selectedClosure]);

  const groupSelection = useCallback(() => {
    const selected = nodes.filter((node) => node.selected && !node.parentId && node.type !== "group");
    if (selected.length < 2) {
      setLastAction("至少选择两个未分组节点才能建立分组");
      return;
    }
    const minX = Math.min(...selected.map((node) => node.position.x));
    const minY = Math.min(...selected.map((node) => node.position.y));
    const maxX = Math.max(...selected.map((node) => node.position.x + nodeSize(node).width));
    const maxY = Math.max(...selected.map((node) => node.position.y + nodeSize(node).height));
    const groupId = createId("group");
    const groupPosition = { x: minX - 32, y: minY - 58 };
    const group: GroupNode = {
      id: groupId,
      type: "group",
      position: groupPosition,
      selected: true,
      data: { kind: "group", title: `设计分组 ${nodes.filter((node) => node.type === "group").length + 1}`, accent: "#64748b" },
      style: { width: maxX - minX + 64, height: maxY - minY + 90 },
    };
    const selectedIds = new Set(selected.map((node) => node.id));
    const groupedChildren = nodes
      .filter((node) => selectedIds.has(node.id))
      .map((node) => ({
        ...node,
        parentId: groupId,
        extent: "parent" as const,
        position: { x: node.position.x - groupPosition.x, y: node.position.y - groupPosition.y },
        selected: false,
      }));
    const untouched = nodes.filter((node) => !selectedIds.has(node.id)).map((node) => ({ ...node, selected: false }));
    commit({ nodes: [group, ...untouched, ...groupedChildren], edges }, `已将 ${selected.length} 个节点编为一组`);
  }, [commit, edges, nodes]);

  const ungroupSelection = useCallback(() => {
    const groups = nodes.filter((node): node is GroupNode => node.type === "group" && Boolean(node.selected));
    if (!groups.length) {
      setLastAction("请选择一个分组容器后再解散");
      return;
    }
    const groupMap = new Map(groups.map((group) => [group.id, group]));
    const groupIds = new Set(groupMap.keys());
    const nextNodes = nodes
      .filter((node) => !groupIds.has(node.id))
      .map((node) => {
        const parent = node.parentId ? groupMap.get(node.parentId) : undefined;
        if (!parent) return { ...node, selected: false };
        return {
          ...node,
          parentId: undefined,
          extent: undefined,
          position: { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y },
          selected: true,
        } as CanvasNode;
      });
    commit({ nodes: nextNodes, edges }, `已解散 ${groups.length} 个分组，子节点位置保持不变`);
  }, [commit, edges, nodes]);

  const switchScene = useCallback((mode: "semantic" | "100" | "500") => {
    const next = mode === "semantic"
      ? { nodes: semanticNodes, edges: semanticEdges }
      : { nodes: createStressNodes(Number(mode)), edges: [] };
    commit(next, mode === "semantic" ? "已恢复业务样例" : `已加载 ${mode} 个轻量节点`);
  }, [commit]);

  const runMockExecutor = useCallback(() => {
    const result = executeMockRun({
      projectId,
      tool: "product-retouch",
      inputAssetIds: ["asset-product-demo"],
      constraints: { productLocked: true, brandLocked: true, editableRegion: "background-only" },
      maxCost: 0,
    });
    setLastAction(`假任务完成：${result.outputAssetIds.length} 个输出 · ${result.networkCalls} 次网络调用 · ¥${result.actualCost}`);
  }, [projectId]);

  const updateSelectedText = useCallback((field: "title" | "body", value: string, final: boolean) => {
    const next: CanvasSnapshot = {
      nodes: nodes.map((node) => node.type === "studio" && node.selected && node.data.kind === "text"
        ? { ...node, data: { ...node.data, [field]: value } }
        : node),
      edges,
    };
    dispatch({ type: final ? "gesture-commit" : "gesture", next });
  }, [edges, nodes]);

  const acceptRemote = useCallback(() => {
    if (conflict) loadDocument(conflict, `已载入另一标签页的修订 r${conflict.revision}`);
  }, [conflict, loadDocument]);

  const keepRecoveryCopy = useCallback(() => {
    if (!conflict) return;
    const current = snapshotToDocument(documentId, projectId, savedRevision, history.present, viewport);
    const recovered = repository.saveRecoveryCopy(current);
    setDocumentId(recovered.id);
    setConflict(null);
    setLastAction(`当前修改已另存为恢复副本 ${recovered.id}`);
  }, [conflict, documentId, history.present, projectId, repository, savedRevision, viewport]);

  const downloadRecovery = useCallback(() => {
    const document = snapshotToDocument(documentId, projectId, savedRevision, history.present, viewport);
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `${documentId}-recovery.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setLastAction("已下载当前画布恢复文件");
  }, [documentId, history.present, projectId, savedRevision, viewport]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
      } else if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        dispatch({ type: "redo" });
      } else if (modifier && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelection();
      } else if (modifier && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteSelection();
      } else if (modifier && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelection();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelection, deleteSelection, duplicateSelection, pasteSelection]);

  const selectedText = nodes.find((node): node is StudioNode => node.type === "studio" && Boolean(node.selected) && node.data.kind === "text");
  const stats = useMemo(() => ({ nodes: nodes.length, edges: edges.length }), [edges.length, nodes.length]);
  const saveLabel: Record<SaveState, string> = {
    loading: "正在恢复",
    dirty: "等待保存",
    saving: "保存中",
    saved: `已保存 r${savedRevision}`,
    conflict: "存在冲突",
    error: "保存失败",
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">PHASE 1 · RELIABLE CANVAS CORE</span>
          <h1>AI 电商视觉工作台</h1>
          <p>画布编辑与 AI 执行彻底隔离；当前只启用本地持久化和假执行器。</p>
        </div>
        <div className="status-cluster">
          <label className="project-switcher">
            <span>项目</span>
            <select
              aria-label="切换项目"
              value={documentId}
              onChange={(event) => {
                setConflict(null);
                setDocumentId(event.target.value);
                setLastAction("正在切换项目并恢复独立草稿");
              }}
            >
              {PROJECTS.map((project) => <option key={project.documentId} value={project.documentId}>{project.label}</option>)}
              {!activeProject && <option value={documentId}>恢复副本</option>}
            </select>
          </label>
          <span className="safe-badge">无真实 API</span>
          {!online && <span className="offline-badge">离线草稿</span>}
          <span className={`save-badge state-${saveState}`}>{saveLabel[saveState]}</span>
          <strong>{stats.nodes}</strong><small>节点</small>
          <strong>{stats.edges}</strong><small>连线</small>
        </div>
      </header>

      <section className="toolbar" aria-label="画布编辑工具">
        <div className="toolbar-actions">
          <span className="tool-group">
            <button disabled={!history.past.length} onClick={() => dispatch({ type: "undo" })}>撤销</button>
            <button disabled={!history.future.length} onClick={() => dispatch({ type: "redo" })}>重做</button>
            <button onClick={duplicateSelection}>复制</button>
            <button onClick={deleteSelection}>删除</button>
          </span>
          <span className="tool-group">
            <button onClick={groupSelection}>建立分组</button>
            <button onClick={ungroupSelection}>解散分组</button>
            <button onClick={autoArrange}>自动整理</button>
          </span>
          <span className="tool-group">
            <button className="asset-action" onClick={() => addNode("image")}>＋ 图片</button>
            <button className="asset-action" onClick={() => addNode("text")}>＋ 文字</button>
          </span>
          <span className="tool-group test-tools">
            <button onClick={() => switchScene("semantic")}>业务样例</button>
            <button onClick={() => switchScene("100")}>100 节点</button>
            <button onClick={() => switchScene("500")}>500 节点</button>
            <button className="mock-run" onClick={runMockExecutor}>运行假任务</button>
          </span>
        </div>
        <p>{lastAction}</p>
      </section>

      <section className="canvas-frame">
        <ReactFlow<CanvasNode, CanvasEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isConnectionValid}
          onMoveEnd={(_, nextViewport) => setViewport(nextViewport)}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.05}
          maxZoom={3}
          onlyRenderVisibleElements
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode="Shift"
          deleteKeyCode={null}
          panOnScroll
          panOnDrag={[1, 2]}
          nodesFocusable
          edgesFocusable
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="#343842" />
          <MiniMap pannable zoomable nodeColor={(node) => (node.data as { accent?: string }).accent ?? "#64748b"} maskColor="rgba(8, 10, 14, 0.72)" />
          <Controls showInteractive={false} />
        </ReactFlow>

        {selectedText && (
          <aside className="inspector" onPointerDown={(event) => event.stopPropagation()}>
            <span>文字资产</span>
            <label>
              标题
              <input
                value={selectedText.data.title}
                onChange={(event) => updateSelectedText("title", event.target.value, false)}
                onBlur={(event) => updateSelectedText("title", event.target.value, true)}
              />
            </label>
            <label>
              正文
              <textarea
                value={selectedText.data.body ?? ""}
                onChange={(event) => updateSelectedText("body", event.target.value, false)}
                onBlur={(event) => updateSelectedText("body", event.target.value, true)}
              />
            </label>
            <small>文字会进入约束快照；当前不会触发模型。</small>
          </aside>
        )}

        {!selectedText && (
          <aside className="legend">
            <strong>两类关系</strong>
            <span><i className="workflow-line" />工作流连线：用户可编辑</span>
            <span><i className="lineage-line" />生成谱系：系统锁定</span>
          </aside>
        )}

        {conflict && (
          <section className="conflict-panel" role="alertdialog" aria-label="修订冲突恢复">
            <span>检测到另一标签页的更新</span>
            <strong>本地 r{savedRevision} 与新修订 r{conflict.revision} 发生冲突</strong>
            <p>不会静默覆盖。可以把当前修改另存为恢复副本，或载入另一标签页的版本。</p>
            <div>
              <button className="primary" onClick={keepRecoveryCopy}>保留当前为副本</button>
              <button onClick={acceptRemote}>载入另一标签版本</button>
            </div>
          </section>
        )}

        {saveState === "error" && !conflict && (
          <section className="save-error-panel" role="alert" aria-label="自动保存失败恢复">
            <span>自动保存失败</span>
            <strong>当前修改仍保留在本标签页内存中</strong>
            <p>{saveFailure || "浏览器存储暂时不可用"}</p>
            <div>
              <button className="primary" onClick={() => setRetryNonce((value) => value + 1)}>立即重试</button>
              <button onClick={downloadRecovery}>下载恢复文件</button>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

export default function App() {
  return <ReactFlowProvider><CanvasKernel /></ReactFlowProvider>;
}
