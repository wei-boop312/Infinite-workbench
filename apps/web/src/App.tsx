import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";
import {
  addEdge,
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
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { executeMockRun } from "@canvas/testing";

type StudioKind = "image" | "video" | "constraint" | "action" | "output";
type StudioNodeData = {
  kind: StudioKind;
  title: string;
  subtitle: string;
  badge?: string;
  accent: string;
};
type StudioNode = Node<StudioNodeData, "studio">;

const KIND_LABEL: Record<StudioKind, string> = {
  image: "图片资产",
  video: "视频资产",
  constraint: "人工约束",
  action: "AI 工具",
  output: "结果版本",
};

const StudioCard = memo(function StudioCard({ data, selected }: NodeProps<StudioNode>) {
  const acceptsInputs = data.kind === "action";
  const hasGenericInput = data.kind === "output" || data.kind === "video";
  const hasOutput = data.kind !== "video";
  return (
    <article className={`studio-node kind-${data.kind} ${selected ? "is-selected" : ""}`} style={{ "--accent": data.accent } as CSSProperties}>
      <NodeResizer minWidth={180} minHeight={116} isVisible={selected} lineClassName="resize-line" handleClassName="resize-handle" />
      {acceptsInputs && (
        <>
          <Handle id="product" className="port port-product" type="target" position={Position.Left} style={{ top: 48 }} />
          <Handle id="constraint" className="port port-constraint" type="target" position={Position.Left} style={{ top: 82 }} />
        </>
      )}
      {hasGenericInput && <Handle id="input" className="port port-input" type="target" position={Position.Left} />}
      <header>
        <span>{KIND_LABEL[data.kind]}</span>
        {data.badge && <em>{data.badge}</em>}
      </header>
      <div className="node-preview" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <strong>{data.title}</strong>
      <small>{data.subtitle}</small>
      {hasOutput && <Handle id="output" className="port port-output" type="source" position={Position.Right} />}
    </article>
  );
});

const nodeTypes = { studio: StudioCard };

const semanticNodes: StudioNode[] = [
  { id: "product", type: "studio", position: { x: 80, y: 120 }, data: { kind: "image", title: "商品原图", subtitle: "资产 ID · 不存 Base64", badge: "已锁定", accent: "#60a5fa" }, style: { width: 210, height: 160 } },
  { id: "brand", type: "studio", position: { x: 90, y: 360 }, data: { kind: "constraint", title: "品牌与文案约束", subtitle: "人决定不可修改项", badge: "人工确认", accent: "#f59e0b" }, style: { width: 220, height: 148 } },
  { id: "retouch", type: "studio", position: { x: 430, y: 220 }, data: { kind: "action", title: "产品精修", subtitle: "模型、预算和范围执行前确认", badge: "假执行器", accent: "#a78bfa" }, style: { width: 250, height: 180 } },
  { id: "output-a", type: "studio", position: { x: 820, y: 100 }, data: { kind: "output", title: "精修结果 A", subtitle: "不可变生成谱系", badge: "版本 1", accent: "#34d399" }, style: { width: 220, height: 160 } },
  { id: "output-b", type: "studio", position: { x: 820, y: 330 }, data: { kind: "output", title: "精修结果 B", subtitle: "可继续局部修改", badge: "版本 2", accent: "#34d399" }, style: { width: 220, height: 160 } },
  { id: "video", type: "studio", position: { x: 1180, y: 230 }, data: { kind: "video", title: "视频镜头占位", subtitle: "时长、帧率与代理文件", badge: "阶段 7", accent: "#fb7185" }, style: { width: 230, height: 170 } },
];

const semanticEdges: Edge[] = [
  { id: "workflow-product", source: "product", target: "retouch", targetHandle: "product", type: "smoothstep", animated: true, className: "edge-workflow" },
  { id: "workflow-brand", source: "brand", target: "retouch", targetHandle: "constraint", type: "smoothstep", animated: true, className: "edge-workflow" },
  { id: "lineage-a", source: "retouch", sourceHandle: "output", target: "output-a", targetHandle: "input", type: "smoothstep", deletable: false, selectable: false, className: "edge-lineage" },
  { id: "lineage-b", source: "retouch", sourceHandle: "output", target: "output-b", targetHandle: "input", type: "smoothstep", deletable: false, selectable: false, className: "edge-lineage" },
  { id: "workflow-video", source: "output-b", sourceHandle: "output", target: "video", targetHandle: "input", type: "smoothstep", className: "edge-workflow" },
];

function stressNodes(count: number): StudioNode[] {
  const columns = Math.ceil(Math.sqrt(count));
  const kinds: StudioKind[] = ["image", "constraint", "action", "output", "video"];
  const accents = ["#60a5fa", "#f59e0b", "#a78bfa", "#34d399", "#fb7185"];
  return Array.from({ length: count }, (_, index) => {
    const kind = kinds[index % kinds.length];
    return {
      id: `stress-${count}-${index}`,
      type: "studio",
      position: { x: (index % columns) * 230, y: Math.floor(index / columns) * 165 },
      data: { kind, title: `节点 ${index + 1}`, subtitle: index % 3 === 0 ? "仅渲染视口内元素" : "轻量验证数据", accent: accents[index % accents.length] },
      style: { width: 190, height: 126 },
    };
  });
}

function CanvasSpike() {
  const [nodes, setNodes, onNodesChange] = useNodesState<StudioNode>(semanticNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(semanticEdges);
  const [mode, setMode] = useState<"semantic" | "100" | "500">("semantic");
  const [lastAction, setLastAction] = useState("语义样例已加载");

  const onConnect = useCallback((connection: Connection) => {
    setEdges((current) => addEdge({ ...connection, type: "smoothstep", className: "edge-workflow" }, current));
    setLastAction("已建立用户工作流连线");
  }, [setEdges]);

  const switchMode = useCallback((next: "semantic" | "100" | "500") => {
    setMode(next);
    if (next === "semantic") {
      setNodes(semanticNodes);
      setEdges(semanticEdges);
      setLastAction("语义样例已加载");
      return;
    }
    const amount = Number(next);
    setNodes(stressNodes(amount));
    setEdges([]);
    setLastAction(`已加载 ${amount} 个轻量节点；可拖动、框选和缩放`);
  }, [setEdges, setNodes]);

  const stats = useMemo(() => ({ nodes: nodes.length, edges: edges.length }), [edges.length, nodes.length]);

  const runMockExecutor = useCallback(() => {
    const result = executeMockRun({
      projectId: "phase-0-local",
      tool: "product-retouch",
      inputAssetIds: ["asset-product-demo"],
      constraints: { productLocked: true, brandLocked: true, editableRegion: "background-only" },
      maxCost: 0,
    });
    setLastAction(`假任务完成：${result.outputAssetIds.length} 个输出 · ${result.networkCalls} 次网络调用 · ¥${result.actualCost}`);
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">PHASE 0 · FOUNDATION SPIKE</span>
          <h1>无限画布底座验证台</h1>
          <p>只验证画布能力，不连接模型、不保存密钥、不产生费用。</p>
        </div>
        <div className="status-cluster">
          <span className="safe-badge">无 API 调用</span>
          <strong>{stats.nodes}</strong><small>节点</small>
          <strong>{stats.edges}</strong><small>连线</small>
        </div>
      </header>
      <section className="toolbar" aria-label="验证场景">
        <div>
          <button className={mode === "semantic" ? "active" : ""} onClick={() => switchMode("semantic")}>业务样例</button>
          <button className={mode === "100" ? "active" : ""} onClick={() => switchMode("100")}>100 节点</button>
          <button className={mode === "500" ? "active" : ""} onClick={() => switchMode("500")}>500 节点</button>
          <button className="mock-run" disabled={mode !== "semantic"} onClick={runMockExecutor}>运行假任务</button>
        </div>
        <p>{lastAction}</p>
      </section>
      <section className="canvas-frame">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.05}
          maxZoom={3}
          onlyRenderVisibleElements
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode="Shift"
          deleteKeyCode={["Backspace", "Delete"]}
          panOnScroll
          panOnDrag={[1, 2]}
          nodesFocusable
          edgesFocusable
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="#343842" />
          <MiniMap pannable zoomable nodeColor={(node) => (node.data as StudioNodeData).accent} maskColor="rgba(8, 10, 14, 0.72)" />
          <Controls showInteractive={false} />
        </ReactFlow>
        <aside className="legend">
          <strong>两类关系</strong>
          <span><i className="workflow-line" />工作流连线：用户可编辑</span>
          <span><i className="lineage-line" />生成谱系：系统锁定</span>
        </aside>
      </section>
    </main>
  );
}

export default function App() {
  return <ReactFlowProvider><CanvasSpike /></ReactFlowProvider>;
}
