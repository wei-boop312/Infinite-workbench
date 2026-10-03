import { useEffect, useRef, useState } from "react";
import type {
  Asset, ConstraintSnapshot, CreateRunBatchRequest, ProjectBudgetSnapshot,
  ResolveBillingUnknownRequest, RunBatchAggregate, RunJob,
} from "@canvas/contracts";
import { money, parseMoney, RUN_STATUS_LABEL, StudioRunClient } from "../runs/runClient";
import "./RunPanel.css";

type Props = {
  projectId: string;
  assets: Asset[];
  constraints: ConstraintSnapshot[];
  missingOriginalAssetIds: Set<string>;
  onClose: () => void;
  onBatches: (batches: RunBatchAggregate[]) => void;
  onAddResults: (batch: RunBatchAggregate) => void;
};
type Decision = { kind: "retry" | "billing"; job: RunJob; batch: RunBatchAggregate };

function latestJobs(jobs: RunJob[]): RunJob[] {
  return jobs.filter((job) => !jobs.some((other) => other.outputIndex === job.outputIndex && other.attempt > job.attempt));
}

const AUDIT_LABEL: Record<string, string> = {
  "batch-created": "创建预估", "confirmation-rejected": "确认被拒绝", "batch-confirmed": "人工确认",
  "budget-reserved": "预留预算", "jobs-created": "创建输出任务", "batch-dispatched": "执行排队任务",
  "job-leased": "领取任务", "job-lease-expired": "任务租约到期", "dispatch-throttled": "等待执行额度",
  "job-started": "任务开始", "job-succeeded": "任务成功", "job-failed": "任务失败", "job-timed-out": "任务超时",
  "billing-unknown": "计费待核对", "billing-resolution-rejected": "核账被拒绝", "billing-resolved-charged": "确认已扣费",
  "billing-resolved-not-charged": "确认未扣费", "cost-settled": "成本结算", "job-retry-created": "人工重试",
  "batch-cancelled": "取消批次", "budget-released": "释放预算",
};

export default function RunPanel(props: Props) {
  const { projectId, assets, constraints, missingOriginalAssetIds } = props;
  const [batches, setBatches] = useState<RunBatchAggregate[]>([]);
  const [budget, setBudget] = useState<ProjectBudgetSnapshot | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [constraintId, setConstraintId] = useState("");
  const [outputs, setOutputs] = useState(2);
  const [ceiling, setCeiling] = useState("2.00");
  const [scenario, setScenario] = useState<CreateRunBatchRequest["mockScenario"]>("success");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [resolution, setResolution] = useState<"charged" | "not-charged">("not-charged");
  const [actualCost, setActualCost] = useState("0.20");
  const [evidence, setEvidence] = useState("");
  const [decisionId, setDecisionId] = useState("");
  const [decisionSubmitted, setDecisionSubmitted] = useState(false);
  const alive = useRef(false);
  const pending = useRef(false);
  const clientRef = useRef<StudioRunClient | null>(null);
  const contextRef = useRef({ projectId, assets, constraints });
  const callbacksRef = useRef(props);
  const batchesRef = useRef(batches);
  const decisionRef = useRef<HTMLElement | null>(null);
  batchesRef.current = batches;
  contextRef.current = { projectId, assets, constraints };
  callbacksRef.current = props;
  const inputAssets = assets.filter((asset) => asset.kind === "image" && asset.purpose !== "mask" && !missingOriginalAssetIds.has(asset.id));
  const batch = batches.find((item) => item.batch.id === selectedBatchId);
  const pendingKey = `ai-commerce-canvas.pending-run.${projectId}`;

  const applyBatches = (records: RunBatchAggregate[]) => {
    if (!alive.current) return;
    setBatches(records);
    batchesRef.current = records;
    callbacksRef.current.onBatches(records);
    setSelectedBatchId((current) => records.some((item) => item.batch.id === current) ? current : records[0]?.batch.id ?? "");
  };
  const refresh = async (client: StudioRunClient) => {
    const [records, nextBudget] = await Promise.all([client.list(projectId), client.budget(projectId)]);
    if (!alive.current) return;
    applyBatches(records);
    setBudget(nextBudget);
  };
  const run = async (action: (client: StudioRunClient) => Promise<RunBatchAggregate | void>, refreshAfter = true) => {
    if (pending.current || !clientRef.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action(clientRef.current);
      if (!alive.current) return;
      if (result) {
        applyBatches([result, ...batchesRef.current.filter((item) => item.batch.id !== result.batch.id)]);
        setSelectedBatchId(result.batch.id);
      }
      if (refreshAfter) await refresh(clientRef.current);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "操作失败，请刷新记录。");
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const client = new StudioRunClient(controller.signal);
    clientRef.current = client;
    pending.current = true;
    setBusy(true);
    void client.register(contextRef.current).then(() => refresh(client)).then(() => {
      if (alive.current && !controller.signal.aborted) setReady(true);
    }).catch((failure) => {
      if (alive.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "任务服务加载失败。");
    }).finally(() => {
      if (!controller.signal.aborted) {
        pending.current = false;
        if (alive.current) setBusy(false);
      }
    });
    return () => { alive.current = false; controller.abort(); clientRef.current = null; };
    // This component is keyed by project, so requests cannot update a different project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!inputAssets.some((asset) => asset.id === assetId)) setAssetId(inputAssets[0]?.id ?? "");
    if (!constraints.some((item) => item.id === constraintId)) setConstraintId(constraints.at(-1)?.id ?? "");
  }, [assets, constraints, missingOriginalAssetIds, assetId, constraintId]);

  useEffect(() => {
    if (decision) decisionRef.current?.focus({ preventScroll: false });
  }, [decision]);

  useEffect(() => {
    if (!ready || !batches.some((item) => item.jobs.some((job) => job.status === "running"))) return;
    const timer = window.setInterval(() => {
      if (pending.current) return;
      void run(async (client) => {
        for (const record of batchesRef.current.filter((item) => item.jobs.some((job) => job.status === "running"))) {
          await client.action(record, "reconcile");
        }
      });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [batches, ready]);

  const create = () => run(async (client) => {
    if (!assetId || !constraintId) throw new Error("请先导入商品图片，并保存一个人工约束快照。");
    if (!Number.isInteger(outputs) || outputs < 1 || outputs > 10) throw new Error("输出数量必须在 1–10 之间。");
    await client.register(contextRef.current);
    const fields = {
      projectId, constraintSnapshotId: constraintId, tool: "product-retouch" as const,
      inputAssetIds: [assetId], expectedOutputs: outputs, maxCostMinor: parseMoney(ceiling),
      currency: "CNY", mockScenario: scenario,
    };
    const fingerprint = JSON.stringify(fields);
    let stored: { fingerprint: string; key: string } | null = null;
    try { stored = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null"); } catch { /* Invalid pending drafts can be replaced. */ }
    const key = stored?.fingerprint === fingerprint && typeof stored.key === "string"
      ? stored.key : `user-action-${crypto.randomUUID()}`;
    sessionStorage.setItem(pendingKey, JSON.stringify({ fingerprint, key }));
    const created = await client.create({ ...fields, idempotencyKey: key });
    sessionStorage.removeItem(pendingKey);
    return created;
  });
  const openDecision = (kind: Decision["kind"], job: RunJob) => {
    if (!batch) return;
    setDecision({ kind, job, batch });
    setDecisionId(`billing-${crypto.randomUUID()}`);
    setResolution("not-charged"); setEvidence(""); setDecisionSubmitted(false);
    setActualCost((job.estimatedCostMinor / 100).toFixed(2));
  };
  const submitDecision = () => run(async (client) => {
    if (!decision) return;
    if (decision.kind === "retry") {
      const result = await client.retry(decision.job.id, decision.job.estimatedCostMinor, decision.batch.batch.currency);
      if (alive.current) setDecision(null);
      return result;
    }
    if (!evidence.trim()) throw new Error("请填写账单或工单的证据引用。");
    const base = {
      resolutionId: decisionId, expectedReservedMinor: decision.job.estimatedCostMinor,
      expectedCurrency: decision.batch.batch.currency, evidenceRef: evidence.trim(),
    };
    const request: ResolveBillingUnknownRequest = resolution === "charged"
      ? { ...base, resolution, actualCostMinor: parseMoney(actualCost) } : { ...base, resolution };
    if (request.resolution === "charged" && request.actualCostMinor <= 0) throw new Error("已扣费金额需要大于零。");
    setDecisionSubmitted(true);
    const result = await client.resolve(decision.job.id, request);
    if (alive.current) setDecision(null);
    return result;
  });

  return (
    <aside className="run-panel" aria-label="任务与预算" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <header><div><span>本地模拟 · 真实费用 ¥0</span><strong>任务与预算</strong></div>
        <button aria-label="关闭任务面板" onClick={props.onClose}>×</button></header>
      <p className="run-hint">先确定商品与约束，再查看预估并人工确认。这里的金额只演练预算，结果是模拟记录。</p>
      {budget && <dl className="run-budget">
        <div><dt>可用模拟预算</dt><dd>{money(budget.availableMinor)}</dd></div>
        <div><dt>预留</dt><dd>{money(budget.reservedMinor)}</dd></div>
        <div><dt>已结算</dt><dd>{money(budget.spentMinor)}</dd></div>
      </dl>}
      {error && <p className="run-error" role="alert">{error}</p>}
      {message && <p role="status" className="run-hint">{message}</p>}
      <button className="run-secondary" disabled={busy} onClick={() => void run(async (client) => {
        await client.register(contextRef.current); setReady(true); await refresh(client);
      }, false)}>{busy ? "正在同步…" : "刷新任务记录"}</button>
      <fieldset disabled={busy || !ready || Boolean(decision)} className="run-form">
        <legend>新建产品精修批次</legend>
        <label>商品图片<select aria-label="任务商品图片" value={assetId} onChange={(event) => setAssetId(event.target.value)}>
          <option value="">请选择已导入图片</option>
          {inputAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName}</option>)}
        </select></label>
        <label>人工约束快照<select aria-label="任务约束快照" value={constraintId} onChange={(event) => setConstraintId(event.target.value)}>
          <option value="">请先保存约束</option>
          {constraints.map((item, index) => <option key={item.id} value={item.id}>版本 {index + 1} · {item.editableRegions.map((region) => region.description).join("、")}</option>)}
        </select></label>
        <div className="run-fields"><label>输出数量<input aria-label="任务输出数量" type="number" min="1" max="10" value={outputs} onChange={(event) => setOutputs(Number(event.target.value))} /></label>
          <label>批次上限（元）<input aria-label="任务成本上限" inputMode="decimal" value={ceiling} onChange={(event) => setCeiling(event.target.value)} /></label></div>
        <details><summary>模拟运行情况</summary><select aria-label="模拟运行情况" value={scenario} onChange={(event) => setScenario(event.target.value as CreateRunBatchRequest["mockScenario"])}>
          <option value="success">全部成功</option><option value="partial-failure">部分失败</option>
          <option value="failed">全部失败</option><option value="slow">慢任务</option><option value="billing-unknown">计费待核对</option>
        </select></details>
        <button className="run-primary" disabled={!assetId || !constraintId} onClick={() => void create()}>查看批次预估</button>
        {(!assetId || !constraintId) && <small>通过工具栏导入图片，并在约束节点保存快照后，即可创建预估。</small>}
      </fieldset>
      {batches.length > 0 && <label className="run-batch-select">批次记录<select aria-label="选择任务批次" value={selectedBatchId} onChange={(event) => { setSelectedBatchId(event.target.value); setDecision(null); }}>
        {batches.map((item) => <option key={item.batch.id} value={item.batch.id}>{item.batch.id.slice(-6)} · {RUN_STATUS_LABEL[item.batch.status]} · {item.batch.expectedOutputs} 个输出</option>)}
      </select></label>}
      {batch && <section className="run-batch" aria-label="当前批次">
        <div className="run-batch-title"><strong>{RUN_STATUS_LABEL[batch.batch.status]}</strong><span>{batch.batch.id.slice(-8)}</span></div>
        <dl className="run-summary"><div><dt>服务端预估</dt><dd>{money(batch.batch.estimatedCostMinor)}</dd></div>
          <div><dt>批次成本上限</dt><dd>{money(batch.batch.maxCostMinor)}</dd></div>
          <div><dt>冻结约束</dt><dd>{batch.batch.constraintSnapshotId.slice(-8)}</dd></div></dl>
        {(() => {
          const constraint = constraints.find((item) => item.id === batch.batch.constraintSnapshotId);
          return constraint ? <p className="run-hint">
            {constraint.lockedPaths.includes("product.pixels") ? "商品主体已锁定" : "商品主体未锁定"} · 可编辑：{constraint.editableRegions.map((item) => item.description).join("、")} · {constraint.outputSpec.width}×{constraint.outputSpec.height} {constraint.outputSpec.format.toUpperCase()}
          </p> : null;
        })()}
        <div className="run-actions">
          {batch.batch.status === "awaiting_confirmation" && <button className="run-primary" disabled={busy} onClick={() => void run((client) => client.action(batch, "confirm"))}>确认模拟成本并排队</button>}
          {batch.jobs.some((job) => job.status === "queued") && batch.batch.status !== "billing_unknown" && <button className="run-primary" disabled={busy} onClick={() => void run((client) => client.action(batch, "dispatch"))}>执行排队任务</button>}
          {batch.jobs.some((job) => job.status === "running") && <button disabled={busy} onClick={() => void run((client) => client.action(batch, "reconcile"))}>检查运行状态</button>}
          {["awaiting_confirmation", "queued"].includes(batch.batch.status) && <button disabled={busy} onClick={() => void run((client) => client.action(batch, "cancel"))}>取消批次</button>}
          {batch.jobs.some((job) => job.status === "succeeded") && <button disabled={busy} onClick={() => { props.onAddResults(batch); setMessage("已把模拟结果记录添加到画布，未生成图片文件。"); }}>结果回到画布</button>}
        </div>
        {batch.jobs.length > 0 && <div className="run-progress" role="status">输出进度：{latestJobs(batch.jobs).filter((job) => job.status === "succeeded").length} / {batch.batch.expectedOutputs} 成功</div>}
        <div className="run-jobs">{latestJobs(batch.jobs).map((job) => <article className={`run-job status-${job.status}`} key={job.id} aria-label={`输出 ${job.outputIndex + 1} 任务`}>
          <div><strong>输出 {job.outputIndex + 1} · 第 {job.attempt} 次</strong><span>{RUN_STATUS_LABEL[job.status]}</span></div>
          <small>{job.actualCostMinor !== undefined ? `实际模拟成本 ${money(job.actualCostMinor)}` : `预留 ${money(job.estimatedCostMinor)}`}</small>
          {job.billingEvidenceRef && <small>核账证据：{job.billingEvidenceRef}</small>}
          {["failed", "timed_out"].includes(job.status) && <button disabled={busy || batch.batch.status === "billing_unknown"} onClick={() => openDecision("retry", job)}>人工重试输出 {job.outputIndex + 1}</button>}
          {job.status === "billing_unknown" && <button disabled={busy} onClick={() => openDecision("billing", job)}>核对输出 {job.outputIndex + 1} 计费</button>}
        </article>)}</div>
        <details className="run-audit"><summary>账本与操作记录（{batch.audit.length}）</summary>
          {batch.ledger.map((entry) => <p key={entry.id}>{entry.settlement === "estimated" ? "预估" : entry.settlement === "reserved" ? "冻结" : entry.settlement === "settled" ? "结算" : entry.settlement === "released" ? "释放" : "待核对"} · {money(entry.settlement === "estimated" ? entry.estimatedMinor : entry.actualMinor ?? entry.reservedMinor)}</p>)}
          {batch.audit.slice(-8).map((event) => <p key={event.id}>{AUDIT_LABEL[event.eventType] ?? event.eventType} · {event.actorId === "local-designer" ? "本地设计师" : "系统"}</p>)}
        </details>
      </section>}
      {decision && <section ref={decisionRef} tabIndex={-1} className="run-decision" role="alertdialog" aria-label={decision.kind === "retry" ? "确认任务重试" : "确认计费核账"}>
        <strong>{decision.kind === "retry" ? "确认重试成本" : "人工核对模拟计费"}</strong>
        <p>输出 {decision.job.outputIndex + 1} · 当前预留 {money(decision.job.estimatedCostMinor)} · 批次上限 {money(decision.batch.batch.maxCostMinor)}</p>
        {decision.kind === "billing" ? <>
          <label>核账结论<select aria-label="核账结论" value={resolution} disabled={decisionSubmitted} onChange={(event) => setResolution(event.target.value as "charged" | "not-charged")}>
            <option value="not-charged">确认未扣费，释放预留</option><option value="charged">确认已扣费，按实际金额结算</option>
          </select></label>
          {resolution === "charged" && <label>核实扣费（元）<input aria-label="核实扣费金额" inputMode="decimal" disabled={decisionSubmitted} value={actualCost} onChange={(event) => setActualCost(event.target.value)} /></label>}
          <label>账单或工单引用<input aria-label="核账证据引用" maxLength={160} disabled={decisionSubmitted} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label>
          <small>当前为模拟演练。结论提交后保留证据，不会自动重试。</small>
        </> : <p>这次重试预计 {money(decision.job.estimatedCostMinor)}，将创建新尝试，原失败记录保留。</p>}
        <div className="run-actions"><button className="run-primary" disabled={busy || (decision.kind === "billing" && !evidence.trim())} onClick={() => void submitDecision()}>{decision.kind === "retry" ? "确认重试" : "提交核账结论"}</button>
          <button disabled={busy} onClick={() => setDecision(null)}>返回任务</button></div>
      </section>}
      {!batches.length && ready && <p className="run-hint">此项目还没有批次。创建预估后，确认按钮才会冻结模拟预算。</p>}
    </aside>
  );
}
