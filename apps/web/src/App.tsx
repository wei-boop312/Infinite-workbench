import {
  createContext,
  memo,
  lazy,
  Suspense,
  useCallback,
  useContext,
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
import type { Asset, CanvasDocument, ConstraintSnapshot, RunBatchAggregate } from "@canvas/contracts";
import { executeMockRun } from "@canvas/testing/browser";
import { assetRepository, formatAssetBytes, type AssetUsage } from "./assets/assetRepository";
import { documentToSnapshot, snapshotFingerprint, snapshotToDocument } from "./canvas/document";
import { layoutCanvas } from "./canvas/autoLayout";
import { validateConnection } from "./canvas/graphRules";
import { createHistoryState, historyReducer } from "./canvas/history";
import { LocalCanvasRepository, RevisionConflictError } from "./canvas/localRepository";
import {
  createId,
  createAssetNode,
  createConstraintNode,
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
import { AssetLibrary } from "./components/AssetLibrary";
import { ConstraintInspector } from "./components/ConstraintInspector";
import {
  constraintRepository,
  type ConstraintDraft,
} from "./constraints/constraintRepository";
import {
  createProjectPackage,
  parseProjectPackage,
  remapProjectPackage,
  type PortableProject,
} from "./projects/projectPackage";
import {
  loadImportedProjects,
  registerImportedProject,
  type ImportedProject,
} from "./projects/projectRegistry";
import { mockObjectStorage } from "./storage/mockObjectStorage";
import {
  ResumableUploadManager,
  type RemoteStorageUsage,
  type UploadSession,
} from "./storage/objectStorage";

const KIND_LABEL: Record<StudioKind, string> = {
  image: "图片资产",
  video: "视频资产",
  constraint: "人工约束",
  action: "AI 工具",
  output: "结果版本",
  text: "文字资产",
};

const AssetPreviewContext = createContext<Record<string, string>>({});
const RunPanel = lazy(() => import("./components/RunPanel"));

function loadRunReferences(projectId: string): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(`ai-commerce-canvas.run-references.${projectId}`) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] > 0));
  } catch { return {}; }
}

function nodeSize(node: CanvasNode): { width: number; height: number } {
  const width = node.measured?.width ?? Number.parseFloat(String(node.style?.width ?? (node.type === "group" ? 520 : 220)));
  const height = node.measured?.height ?? Number.parseFloat(String(node.style?.height ?? (node.type === "group" ? 340 : 160)));
  return { width, height };
}

const StudioCard = memo(function StudioCard({ data, selected }: NodeProps<StudioNode>) {
  const assetPreviews = useContext(AssetPreviewContext);
  const assetPreview = data.assetId ? assetPreviews[data.assetId] : undefined;
  const isVideoAsset = data.kind === "video" && Boolean(data.assetId);
  const acceptsInputs = data.kind === "action";
  const hasGenericInput = data.kind === "output" || (data.kind === "video" && !isVideoAsset);
  const hasOutput = data.kind !== "video" || isVideoAsset;
  const outputDataClass = data.kind === "text"
    ? "port-data-text"
    : data.kind === "constraint"
      ? "port-data-constraint"
      : data.kind === "video"
        ? "port-data-video"
        : "port-data-image";
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
      {assetPreview ? (
        <div className="asset-node-preview">
          <img src={assetPreview} alt={data.title} />
          {data.kind === "video" && <i>▶</i>}
        </div>
      ) : data.kind === "text" ? (
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
const BUILT_IN_PROJECTS = [
  { documentId: "phase-1-demo", projectId: "project-main-image", label: "商品主图工作台" },
  { documentId: "phase-1-campaign", projectId: "project-campaign", label: "活动套图工作台" },
] as const;
const ACTIVE_DOCUMENT_KEY = "ai-commerce-canvas.active-document";
const uploadManager = new ResumableUploadManager(mockObjectStorage);

type SaveState = "loading" | "dirty" | "saving" | "saved" | "conflict" | "error";

function CanvasKernel() {
  const [history, dispatch] = useReducer(historyReducer, initialSnapshot, createHistoryState);
  const [viewport, setViewport] = useState<Viewport>(initialViewport);
  const [importedProjects, setImportedProjects] = useState<ImportedProject[]>(loadImportedProjects);
  const [documentId, setDocumentId] = useState(() => {
    const stored = localStorage.getItem(ACTIVE_DOCUMENT_KEY);
    return stored && ([...BUILT_IN_PROJECTS, ...importedProjects].some((project) => project.documentId === stored))
      ? stored
      : "phase-1-demo";
  });
  const [savedRevision, setSavedRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [conflict, setConflict] = useState<CanvasDocument | null>(null);
  const [saveFailure, setSaveFailure] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [lastAction, setLastAction] = useState("阶段 3 任务与模拟预算工作台已加载");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetPreviewUrls, setAssetPreviewUrls] = useState<Record<string, string>>({});
  const [missingOriginalAssetIds, setMissingOriginalAssetIds] = useState<Set<string>>(() => new Set());
  const [restoringAssetIds, setRestoringAssetIds] = useState<Set<string>>(() => new Set());
  const [assetCatalogRevision, setAssetCatalogRevision] = useState(0);
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  const [runReferences, setRunReferences] = useState<{ projectId: string; counts: Record<string, number> } | null>(null);
  const [assetImporting, setAssetImporting] = useState(false);
  const [assetError, setAssetError] = useState("");
  const [assetUsage, setAssetUsage] = useState<AssetUsage | null>(null);
  const [storageQuota, setStorageQuota] = useState<number | null>(null);
  const [uploadSessions, setUploadSessions] = useState<Record<string, UploadSession>>({});
  const [remoteUsage, setRemoteUsage] = useState<RemoteStorageUsage | null>(null);
  const [backupAllBusy, setBackupAllBusy] = useState(false);
  const [constraintSnapshots, setConstraintSnapshots] = useState<ConstraintSnapshot[]>([]);
  const [pendingMaskAssetIds, setPendingMaskAssetIds] = useState<Set<string>>(() => new Set());
  const [pendingProjectPackage, setPendingProjectPackage] = useState<PortableProject | null>(null);
  const [packageBusy, setPackageBusy] = useState(false);
  const [packageError, setPackageError] = useState("");
  const clipboardRef = useRef<CanvasSnapshot | null>(null);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const packageInputRef = useRef<HTMLInputElement>(null);
  const uploadControllersRef = useRef(new Map<string, AbortController>());
  const activeProjectIdRef = useRef("");
  const lastSavedFingerprint = useRef("");
  const currentRef = useRef({ snapshot: history.present, viewport, revision: savedRevision });
  const repository = useMemo(() => new LocalCanvasRepository(documentId), [documentId]);
  const availableProjects = useMemo(() => [...BUILT_IN_PROJECTS, ...importedProjects], [importedProjects]);
  const activeProject = availableProjects.find((project) => project.documentId === documentId);
  const projectId = activeProject?.projectId ?? "project-recovery";
  const { screenToFlowPosition, setViewport: setFlowViewport, fitView: fitCanvasView } = useReactFlow<CanvasNode, CanvasEdge>();

  const { nodes, edges } = history.present;
  currentRef.current = { snapshot: history.present, viewport, revision: savedRevision };
  activeProjectIdRef.current = projectId;

  useEffect(() => {
    localStorage.setItem(ACTIVE_DOCUMENT_KEY, documentId);
  }, [documentId]);

  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];
    setAssets([]);
    setAssetPreviewUrls({});
    setMissingOriginalAssetIds(new Set());
    setAssetError("");
    void assetRepository.list(projectId).then(async (projectAssets) => {
      const previews: Record<string, string> = {};
      const missingOriginals = new Set<string>();
      for (const asset of projectAssets) {
        if (cancelled) return;
        const original = await assetRepository.getBlob(asset.id, "original");
        if (!original) missingOriginals.add(asset.id);
        const blob = asset.proxyStorageKey
          ? await assetRepository.getBlob(asset.id, "proxy")
          : asset.kind === "image"
            ? original
            : null;
        if (cancelled) return;
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        createdUrls.push(url);
        previews[asset.id] = url;
      }
      if (cancelled) return;
      setAssets(projectAssets);
      setAssetPreviewUrls(previews);
      setMissingOriginalAssetIds(missingOriginals);
    }).catch((error) => {
      if (!cancelled) setAssetError(error instanceof Error ? error.message : "资产库加载失败");
    });
    return () => {
      cancelled = true;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [assetCatalogRevision, projectId]);

  useEffect(() => {
    setConstraintSnapshots(constraintRepository.list(projectId));
    setPendingMaskAssetIds(new Set());
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    for (const controller of uploadControllersRef.current.values()) controller.abort();
    uploadControllersRef.current.clear();
    setUploadSessions({});
    setBackupAllBusy(false);
    setRestoringAssetIds(new Set());
    void Promise.all([
      mockObjectStorage.listSessions(projectId),
      mockObjectStorage.usage(),
    ]).then(async ([sessions, usage]) => {
      if (cancelled) return;
      const normalized = await Promise.all(sessions.map((session) => ["queued", "hashing", "uploading"].includes(session.status)
        ? mockObjectStorage.setStatus(session.id, "paused")
        : Promise.resolve(session)));
      if (cancelled) return;
      setUploadSessions(Object.fromEntries(normalized.map((session) => [session.assetId, session])));
      setRemoteUsage(usage);
    }).catch(() => {
      if (!cancelled) setRemoteUsage(null);
    });
    return () => {
      cancelled = true;
      for (const controller of uploadControllersRef.current.values()) controller.abort();
      uploadControllersRef.current.clear();
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      assetRepository.usage(projectId),
      navigator.storage?.estimate?.() ?? Promise.resolve({}),
    ]).then(([usage, estimate]) => {
      if (cancelled) return;
      setAssetUsage(usage);
      setStorageQuota(typeof estimate.quota === "number" ? estimate.quota : null);
    }).catch(() => {
      if (!cancelled) setAssetUsage(null);
    });
    return () => { cancelled = true; };
  }, [assets, projectId]);

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

  const addConstraintNode = useCallback(() => {
    setRunPanelOpen(false);
    const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const deselected = nodes.map((node) => ({ ...node, selected: false }));
    commit({ nodes: [...deselected, createConstraintNode(position)], edges }, "已添加人工约束节点；请选择它定义锁定项与可编辑区域");
  }, [commit, edges, nodes, screenToFlowPosition]);

  const addAssetToCanvas = useCallback((asset: Asset) => {
    const current = currentRef.current.snapshot;
    const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const deselected = current.nodes.map((node) => ({ ...node, selected: false }));
    commit({ nodes: [...deselected, createAssetNode(asset, position)], edges: current.edges }, `已把 ${asset.originalName} 添加到画布；文档仅保存 assetId`);
  }, [commit, screenToFlowPosition]);

  const importAssetFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setRunPanelOpen(false);
    setAssetImporting(true);
    setAssetError("");
    try {
      const result = await assetRepository.importFiles(projectId, files);
      const imported = result.assets;
      if (result.errors.length) setAssetError(result.errors.join("；"));
      if (!imported.length) {
        setLastAction(`资产导入失败：${result.errors.join("；")}`);
        setAssetLibraryOpen(true);
        return;
      }
      const knownAssetIds = new Set(assets.map((asset) => asset.id));
      const addedCount = imported.filter((asset) => !knownAssetIds.has(asset.id)).length;
      const current = currentRef.current.snapshot;
      const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const importedNodes = imported.map((asset, index) => createAssetNode(asset, {
        x: center.x + (index % 3) * 270,
        y: center.y + Math.floor(index / 3) * 210,
      }));
      commit({
        nodes: [...current.nodes.map((node) => ({ ...node, selected: false })), ...importedNodes],
        edges: current.edges,
      }, `资产就绪：新增 ${addedCount} 个，复用 ${imported.length - addedCount} 个${result.errors.length ? `，${result.errors.length} 个失败` : ""}；画布只保存引用`);
      setAssetCatalogRevision((revision) => revision + 1);
      setAssetLibraryOpen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "资产导入失败";
      setAssetError(message);
      setLastAction(`资产导入失败：${message}`);
      setAssetLibraryOpen(true);
    } finally {
      setAssetImporting(false);
      if (assetInputRef.current) assetInputRef.current.value = "";
    }
  }, [assets, commit, projectId, screenToFlowPosition]);

  const saveMaskAsset = useCallback(async (sourceAssetId: string, blob: Blob, width: number, height: number) => {
    const mask = await assetRepository.saveMask(projectId, sourceAssetId, blob, width, height);
    setPendingMaskAssetIds((current) => new Set(current).add(mask.id));
    setAssetCatalogRevision((revision) => revision + 1);
    setLastAction(`已创建不可变蒙版资产 ${mask.id.slice(-8)}；保存约束快照后才会进入任务输入`);
    return mask;
  }, [projectId]);

  const backupAsset = useCallback(async (asset: Asset) => {
    if (uploadControllersRef.current.has(asset.id)) return;
    const blob = await assetRepository.getBlob(asset.id, "original");
    if (!blob) {
      setLastAction(`无法备份 ${asset.originalName}：本地原文件不存在`);
      return;
    }
    if (activeProjectIdRef.current !== asset.projectId) return;
    const controller = new AbortController();
    uploadControllersRef.current.set(asset.id, controller);
    const now = new Date().toISOString();
    setUploadSessions((current) => current[asset.id] ? current : {
      ...current,
      [asset.id]: {
        id: `pending-${asset.id}`,
        projectId: asset.projectId,
        assetId: asset.id,
        fingerprint: asset.contentFingerprint ?? "",
        mimeType: asset.mimeType,
        totalBytes: blob.size,
        chunkSize: 4 * 1024 * 1024,
        totalParts: Math.ceil(blob.size / (4 * 1024 * 1024)),
        uploadedParts: [],
        uploadedBytes: 0,
        status: asset.contentFingerprint ? "queued" : "hashing",
        createdAt: now,
        updatedAt: now,
      },
    });
    try {
      const result = await uploadManager.upload(asset, blob, {
        signal: controller.signal,
        onHashProgress: (processedBytes, totalBytes) => {
          if (activeProjectIdRef.current !== asset.projectId) return;
          setUploadSessions((current) => ({
            ...current,
            [asset.id]: {
              ...(current[asset.id] ?? {
                id: `pending-${asset.id}`,
                projectId: asset.projectId,
                assetId: asset.id,
                fingerprint: "",
                mimeType: asset.mimeType,
                chunkSize: 4 * 1024 * 1024,
                totalParts: Math.ceil(totalBytes / (4 * 1024 * 1024)),
                uploadedParts: [],
                createdAt: now,
              }),
              totalBytes,
              uploadedBytes: processedBytes,
              status: "hashing",
              updatedAt: new Date().toISOString(),
            },
          }));
        },
        onProgress: (session) => {
          if (activeProjectIdRef.current !== asset.projectId) return;
          setUploadSessions((current) => ({ ...current, [asset.id]: session }));
        },
      });
      if (activeProjectIdRef.current === asset.projectId) {
        setLastAction(result.status === "reused"
          ? `假远端已复用相同内容：${asset.originalName}，未重复写入对象`
          : result.status === "paused"
            ? `已暂停 ${asset.originalName}，完成的分片会在继续时复用`
            : `已完成 ${asset.originalName} 的分片备份；0 次外网请求`);
      }
    } catch (error) {
      if (activeProjectIdRef.current !== asset.projectId) return;
      const message = error instanceof Error ? error.message : "分片备份失败";
      if (controller.signal.aborted) {
        setUploadSessions((current) => ({
          ...current,
          [asset.id]: { ...current[asset.id], status: "paused", error: undefined, updatedAt: new Date().toISOString() },
        }));
        setLastAction(`已暂停 ${asset.originalName}；如仍在内容校验阶段，继续时会重新校验`);
      } else {
        setUploadSessions((current) => ({
          ...current,
          [asset.id]: current[asset.id]
            ? { ...current[asset.id], status: "failed", error: message, updatedAt: new Date().toISOString() }
            : current[asset.id],
        }));
        setLastAction(`备份失败：${message}；已完成分片不会丢失，可直接重试`);
      }
    } finally {
      uploadControllersRef.current.delete(asset.id);
      try {
        const usage = await mockObjectStorage.usage();
        if (activeProjectIdRef.current === asset.projectId) setRemoteUsage(usage);
      } catch {
        // 备份结果已持久化；配额摘要可在下次打开资产库时恢复。
      }
    }
  }, []);

  const pauseAssetBackup = useCallback((assetId: string) => {
    uploadControllersRef.current.get(assetId)?.abort();
  }, []);

  const restoreAssetFromBackup = useCallback(async (asset: Asset) => {
    const session = uploadSessions[asset.id];
    if (!session?.objectKey || !["completed", "reused"].includes(session.status)) {
      setAssetError("该资产没有可用的完整备份对象");
      return;
    }
    setRestoringAssetIds((current) => new Set(current).add(asset.id));
    setAssetError("");
    try {
      const blob = await mockObjectStorage.getObject(session.objectKey);
      if (!blob) throw new Error("假远端对象不存在");
      await assetRepository.restoreOriginal(asset.projectId, asset.id, blob);
      setMissingOriginalAssetIds((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
      setAssetCatalogRevision((revision) => revision + 1);
      setLastAction(`已从备份恢复 ${asset.originalName}；assetId 和所有画布引用保持不变`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "本地资产恢复失败";
      setAssetError(message);
      setLastAction(`本地资产恢复失败：${message}`);
    } finally {
      setRestoringAssetIds((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
    }
  }, [uploadSessions]);

  const backupAllAssets = useCallback(async () => {
    setBackupAllBusy(true);
    try {
      for (const asset of assets) {
        if (missingOriginalAssetIds.has(asset.id)) continue;
        const status = uploadSessions[asset.id]?.status;
        if (status === "completed" || status === "reused") continue;
        await backupAsset(asset);
      }
    } finally {
      setBackupAllBusy(false);
    }
  }, [assets, backupAsset, missingOriginalAssetIds, uploadSessions]);

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

  const exportProjectPackage = useCallback(async () => {
    setPackageBusy(true);
    setPackageError("");
    try {
      const current = currentRef.current;
      const document = snapshotToDocument(documentId, projectId, current.revision, current.snapshot, current.viewport);
      const blob = await createProjectPackage({
        projectName: activeProject?.label ?? "画布恢复项目",
        document,
        constraints: constraintSnapshots,
        assets,
      }, (assetId, role) => assetRepository.getBlob(assetId, role));
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = `${documentId}-${new Date().toISOString().slice(0, 10)}.canvaspack`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setLastAction(`项目包已导出：${assets.length} 个资产、${constraintSnapshots.length} 个约束快照，画布引用保持完整`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "项目包导出失败";
      setPackageError(message);
      setLastAction(`项目包导出失败：${message}`);
    } finally {
      setPackageBusy(false);
    }
  }, [activeProject?.label, assets, constraintSnapshots, documentId, projectId]);

  const inspectProjectPackage = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setPackageBusy(true);
    setPackageError("");
    try {
      const parsed = await parseProjectPackage(file);
      setPendingProjectPackage(parsed);
      setLastAction(`项目包校验通过：${parsed.assets.length} 个资产、${parsed.constraints.length} 个约束快照；等待确认导入`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "项目包无法读取";
      setPendingProjectPackage(null);
      setPackageError(message);
      setLastAction(`项目包导入被拒绝：${message}`);
    } finally {
      setPackageBusy(false);
      if (packageInputRef.current) packageInputRef.current.value = "";
    }
  }, []);

  const importProjectPackage = useCallback(async () => {
    if (!pendingProjectPackage) return;
    setPackageBusy(true);
    setPackageError("");
    const suffix = crypto.randomUUID();
    const importedDocumentId = `import-${suffix}`;
    const importedProjectId = `project-import-${suffix}`;
    const remapped = remapProjectPackage(pendingProjectPackage, importedDocumentId, importedProjectId);
    const importedRepository = new LocalCanvasRepository(importedDocumentId);
    let assetsRestored = false;
    try {
      await assetRepository.restore(importedProjectId, remapped.assets);
      assetsRestored = true;
      constraintRepository.replace(importedProjectId, remapped.constraints);
      importedRepository.save(remapped.document, 0);
      const entry: ImportedProject = {
        documentId: importedDocumentId,
        projectId: importedProjectId,
        label: `${remapped.projectName}（导入）`,
        importedAt: new Date().toISOString(),
      };
      const nextProjects = registerImportedProject(entry);
      setImportedProjects(nextProjects);
      setPendingProjectPackage(null);
      setAssetLibraryOpen(false);
      setConflict(null);
      setDocumentId(importedDocumentId);
      setLastAction(`已导入独立项目副本：${remapped.assets.length} 个资产、${remapped.constraints.length} 个约束快照；原项目未被覆盖`);
    } catch (error) {
      constraintRepository.remove(importedProjectId);
      importedRepository.remove();
      if (assetsRestored) {
        await Promise.all(remapped.assets.map(({ asset }) => assetRepository.remove(importedProjectId, asset.id).catch(() => false)));
      }
      const message = error instanceof Error ? error.message : "项目包导入失败";
      setPackageError(message);
      setLastAction(`项目包导入失败，已回滚本次写入：${message}`);
    } finally {
      setPackageBusy(false);
    }
  }, [pendingProjectPackage]);

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
  const selectedConstraint = nodes.find((node): node is StudioNode => node.type === "studio" && Boolean(node.selected) && node.data.kind === "constraint");
  const rememberRunReferences = useCallback((records: RunBatchAggregate[]) => {
    const counts: Record<string, number> = {};
    for (const { batch } of records) {
      if (batch.projectId !== projectId) continue;
      for (const id of batch.inputAssetIds) counts[id] = (counts[id] ?? 0) + 1;
    }
    setRunReferences({ projectId, counts });
    try { localStorage.setItem(`ai-commerce-canvas.run-references.${projectId}`, JSON.stringify(counts)); }
    catch { setLastAction("任务引用已保护；浏览器无法保存引用摘要，请保留当前标签页并检查存储空间"); }
  }, [projectId]);

  const addRunResults = useCallback((record: RunBatchAggregate) => {
    if (record.batch.projectId !== activeProjectIdRef.current) return;
    if (record.batch.tool !== "product-retouch") { setLastAction("生成资产尚未接入画布缓存，不能转换为模拟画布结果"); return; }
    const current = currentRef.current.snapshot;
    const existingIds = new Set(current.nodes.map((node) => node.id));
    const results = record.jobs.filter((job) => job.status === "succeeded" && !existingIds.has(`run-result-${job.id}`));
    if (!results.length) { setLastAction("这些模拟结果已经在画布上，无需重复添加"); return; }
    const toolId = `run-tool-${record.batch.id}`;
    const anchor = screenToFlowPosition({ x: window.innerWidth / 3, y: window.innerHeight / 2 });
    const rightmost = current.nodes.filter((node) => !node.parentId)
      .reduce((right, node) => Math.max(right, node.position.x + nodeSize(node).width), anchor.x);
    const center = { x: rightmost + 80, y: anchor.y };
    const additions: CanvasNode[] = [];
    if (!existingIds.has(toolId)) additions.push({
      id: toolId, type: "studio", position: center,
      data: { kind: "action", title: "产品精修批次", subtitle: "已冻结输入与人工约束 · 本地模拟", badge: "模拟任务", accent: "#a78bfa", runBatchId: record.batch.id, constraintSnapshotId: record.batch.constraintSnapshotId },
      style: { width: 250, height: 170 },
    });
    const tool = current.nodes.find((node) => node.id === toolId);
    const position = { ...(tool?.position ?? center) };
    let parentId = tool?.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = current.nodes.find((node) => node.id === parentId);
      if (!parent) break;
      position.x += parent.position.x; position.y += parent.position.y; parentId = parent.parentId;
    }
    const relatedCount = current.nodes.filter((node) => node.type === "studio" && node.data.runBatchId === record.batch.id && node.data.kind === "output").length;
    const lineages: CanvasEdge[] = results.map((job, index) => {
      const target = `run-result-${job.id}`;
      additions.push({
        id: target, type: "studio", position: { x: position.x + 330, y: position.y + (relatedCount + index) * 200 }, selected: true,
        data: { kind: "output", title: `模拟精修结果 ${job.outputIndex + 1}`, subtitle: "模拟结果记录 · 未生成图片", badge: `第 ${job.attempt} 次`, accent: "#34d399", runJobId: job.id, runBatchId: record.batch.id, constraintSnapshotId: record.batch.constraintSnapshotId },
        style: { width: 240, height: 160 },
      });
      return { id: `run-lineage-${job.id}`, source: toolId, sourceHandle: "output", target, targetHandle: "input", type: "smoothstep", deletable: false, selectable: false, className: "edge-lineage", data: { kind: "lineage", runJobId: job.id } };
    });
    commit({ nodes: [...current.nodes.map((node) => ({ ...node, selected: false })), ...additions], edges: [...current.edges, ...lineages] }, `已放置 ${results.length} 个模拟结果记录；批次与约束来源已保留，未生成图片`);
    window.setTimeout(() => void fitCanvasView({ nodes: [{ id: toolId }, ...results.map((job) => ({ id: `run-result-${job.id}` }))], padding: 0.3, duration: 200 }), 0);
  }, [commit, fitCanvasView, screenToFlowPosition]);

  const assetReferenceCounts = useMemo(() => {
    const counts: Record<string, number> = { ...(runReferences?.projectId === projectId ? runReferences.counts : loadRunReferences(projectId)) };
    for (const node of nodes) {
      if (node.type !== "studio" || !node.data.assetId) continue;
      counts[node.data.assetId] = (counts[node.data.assetId] ?? 0) + 1;
    }
    for (const snapshot of constraintSnapshots) {
      for (const region of snapshot.editableRegions) {
        if (!region.maskAssetId) continue;
        counts[region.maskAssetId] = (counts[region.maskAssetId] ?? 0) + 1;
      }
    }
    for (const asset of assets) {
      if (!asset.sourceAssetId) continue;
      counts[asset.sourceAssetId] = (counts[asset.sourceAssetId] ?? 0) + 1;
    }
    for (const maskAssetId of pendingMaskAssetIds) counts[maskAssetId] = (counts[maskAssetId] ?? 0) + 1;
    return counts;
  }, [assets, constraintSnapshots, nodes, pendingMaskAssetIds, projectId, runReferences]);
  const activeConstraintSnapshot = selectedConstraint?.data.constraintSnapshotId
    ? constraintSnapshots.find((snapshot) => snapshot.id === selectedConstraint.data.constraintSnapshotId) ?? null
    : null;
  const saveConstraintSnapshot = useCallback((draft: ConstraintDraft) => {
    if (!selectedConstraint) return;
    const snapshot = constraintRepository.save(projectId, draft);
    setConstraintSnapshots((current) => [...current, snapshot]);
    const savedMaskIds = new Set(snapshot.editableRegions.flatMap((region) => region.maskAssetId ? [region.maskAssetId] : []));
    setPendingMaskAssetIds((current) => new Set([...current].filter((assetId) => !savedMaskIds.has(assetId))));
    commit({
      nodes: nodes.map((node) => node.id === selectedConstraint.id
        ? {
            ...node,
            data: {
              ...node.data,
              constraintSnapshotId: snapshot.id,
              badge: "已确认",
              subtitle: `${snapshot.editableRegions.length} 个可编辑区域 · ${snapshot.outputSpec.width}×${snapshot.outputSpec.height} ${snapshot.outputSpec.format.toUpperCase()}`,
            },
          } as CanvasNode
        : node),
      edges,
    }, `已保存不可变约束快照 ${snapshot.id.slice(-8)}`);
  }, [commit, edges, nodes, projectId, selectedConstraint]);
  const removeAsset = useCallback(async (asset: Asset) => {
    const references = assetReferenceCounts[asset.id] ?? 0;
    if (references > 0) throw new Error(`该资产仍被 ${references} 处引用，不能删除`);
    const removed = await assetRepository.remove(projectId, asset.id);
    if (!removed) throw new Error("资产不存在或不属于当前项目");
    setAssetCatalogRevision((revision) => revision + 1);
    setLastAction(`已移除未使用资产 ${asset.originalName}`);
  }, [assetReferenceCounts, projectId]);
  const cleanupUnusedAssets = useCallback(async () => {
    const unused = assets.filter((asset) => (assetReferenceCounts[asset.id] ?? 0) === 0);
    for (const asset of unused) await assetRepository.remove(projectId, asset.id);
    if (unused.length) {
      setAssetCatalogRevision((revision) => revision + 1);
      setLastAction(`已清理 ${unused.length} 个未使用资产；所有被引用的原图和蒙版均已保留`);
    }
    return unused.length;
  }, [assetReferenceCounts, assets, projectId]);
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
          <span className="eyebrow">PHASE 3 · TASKS & BUDGET</span>
          <h1>AI 电商视觉工作台</h1>
          <p>人工约束 → 成本预估 → 确认执行 → 结果回画布；当前仅本地模拟，真实 AI 与 MCP 未启用。</p>
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
              {availableProjects.map((project) => <option key={project.documentId} value={project.documentId}>{project.label}</option>)}
              {!activeProject && <option value={documentId}>恢复副本</option>}
            </select>
          </label>
          <span className="safe-badge">无真实 API</span>
          {!online && <span className="offline-badge">离线草稿</span>}
          <span className="asset-count">{assets.length} 资产</span>
          <span className={`save-badge state-${saveState}`}>{saveLabel[saveState]}</span>
          <strong>{stats.nodes}</strong><small>节点</small>
          <strong>{stats.edges}</strong><small>连线</small>
        </div>
      </header>

      <section className="toolbar" aria-label="画布编辑工具">
        <input
          ref={assetInputRef}
          className="hidden-asset-input"
          aria-label="导入本地资产"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm,video/quicktime"
          multiple
          onChange={(event) => void importAssetFiles(Array.from(event.target.files ?? []))}
        />
        <input
          ref={packageInputRef}
          className="hidden-asset-input"
          aria-label="选择画布项目包"
          type="file"
          accept=".canvaspack,application/x-ai-commerce-canvas-package"
          onChange={(event) => void inspectProjectPackage(event.target.files?.[0])}
        />
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
            <button className="asset-action" disabled={assetImporting} onClick={() => assetInputRef.current?.click()}>{assetImporting ? "导入中…" : "导入资产"}</button>
            <button className="asset-action" onClick={() => { setRunPanelOpen(false); setAssetLibraryOpen((open) => !open); }}>资产库 {assets.length}</button>
            <button className="asset-action" onClick={() => addNode("image")}>＋ 图片占位</button>
            <button className="asset-action" onClick={() => addNode("text")}>＋ 文字</button>
            <button className="constraint-action" onClick={addConstraintNode}>＋ 约束</button>
          </span>
          <span className="tool-group">
            <button className="package-action" disabled={packageBusy} onClick={() => void exportProjectPackage()}>{packageBusy ? "处理中…" : "导出项目包"}</button>
            <button className="package-action" disabled={packageBusy} onClick={() => packageInputRef.current?.click()}>导入项目包</button>
          </span>
          <span className="tool-group test-tools">
            <button onClick={() => switchScene("semantic")}>业务样例</button>
            <button onClick={() => switchScene("100")}>100 节点</button>
            <button onClick={() => switchScene("500")}>500 节点</button>
            <button className="mock-run" onClick={runMockExecutor}>运行假任务</button>
          </span>
          <span className="tool-group">
            <button className="constraint-action" onClick={() => { setAssetLibraryOpen(false); setRunPanelOpen((open) => !open); }}>任务与预算</button>
          </span>
        </div>
        <p>{lastAction}</p>
      </section>

      <section
        className="canvas-frame"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          void importAssetFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <AssetPreviewContext.Provider value={assetPreviewUrls}>
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
        </AssetPreviewContext.Provider>

        <AssetLibrary
          open={assetLibraryOpen}
          assets={assets}
          previewUrls={assetPreviewUrls}
          importing={assetImporting}
          error={assetError}
          referenceCounts={assetReferenceCounts}
          usage={assetUsage}
          storageQuota={storageQuota}
          uploadSessions={uploadSessions}
          remoteUsage={remoteUsage}
          backupAllBusy={backupAllBusy}
          missingOriginalAssetIds={missingOriginalAssetIds}
          restoringAssetIds={restoringAssetIds}
          onClose={() => setAssetLibraryOpen(false)}
          onChooseFiles={() => assetInputRef.current?.click()}
          onAddToCanvas={addAssetToCanvas}
          onRemove={removeAsset}
          onCleanup={cleanupUnusedAssets}
          onBackup={backupAsset}
          onPauseBackup={pauseAssetBackup}
          onBackupAll={backupAllAssets}
          onRestore={restoreAssetFromBackup}
        />

        {runPanelOpen && <Suspense fallback={<aside className="inspector" role="status">正在加载任务面板…</aside>}>
          <RunPanel key={projectId} projectId={projectId} assets={assets} constraints={constraintSnapshots}
            missingOriginalAssetIds={missingOriginalAssetIds} onClose={() => setRunPanelOpen(false)}
            onBatches={rememberRunReferences} onAddResults={addRunResults} />
        </Suspense>}

        {selectedText && !runPanelOpen && (
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

        {selectedConstraint && !runPanelOpen && (
          <ConstraintInspector
            key={`${selectedConstraint.id}:${selectedConstraint.data.constraintSnapshotId ?? "draft"}`}
            snapshot={activeConstraintSnapshot}
            assets={assets}
            previewUrls={assetPreviewUrls}
            onSave={saveConstraintSnapshot}
            onSaveMask={saveMaskAsset}
          />
        )}

        {!selectedText && !selectedConstraint && !assetLibraryOpen && !runPanelOpen && (
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

        {(pendingProjectPackage || packageError) && (
          <section className="package-panel" role={pendingProjectPackage ? "alertdialog" : "alert"} aria-label={pendingProjectPackage ? "确认导入项目包" : "项目包错误"}>
            <span>{pendingProjectPackage ? "项目包已通过完整性校验" : "项目包操作失败"}</span>
            {pendingProjectPackage ? (
              <>
                <strong>将“{pendingProjectPackage.projectName}”导入为独立项目副本？</strong>
                <p>
                  {pendingProjectPackage.assets.length} 个资产 · {pendingProjectPackage.constraints.length} 个约束快照 · {formatAssetBytes(pendingProjectPackage.packageBytes)}。资产与约束编号会安全重建，现有项目不会被覆盖。
                </p>
                <div>
                  <button className="primary" disabled={packageBusy} onClick={() => void importProjectPackage()}>{packageBusy ? "正在导入…" : "确认导入副本"}</button>
                  <button disabled={packageBusy} onClick={() => setPendingProjectPackage(null)}>取消</button>
                </div>
              </>
            ) : (
              <>
                <strong>{packageError}</strong>
                <p>未写入或覆盖任何项目数据。</p>
                <div><button onClick={() => setPackageError("")}>知道了</button></div>
              </>
            )}
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
