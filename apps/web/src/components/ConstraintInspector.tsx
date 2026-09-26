import { useState } from "react";
import type { Asset, ConstraintSnapshot } from "@canvas/contracts";
import {
  defaultConstraintDraft,
  draftFromSnapshot,
  type ConstraintDraft,
} from "../constraints/constraintRepository";

type ConstraintInspectorProps = {
  snapshot: ConstraintSnapshot | null;
  assets: Asset[];
  onSave: (draft: ConstraintDraft) => void;
};

export function ConstraintInspector({ snapshot, assets, onSave }: ConstraintInspectorProps) {
  const [draft, setDraft] = useState(() => draftFromSnapshot(snapshot));
  const [error, setError] = useState("");

  const updateRegion = (id: string, patch: Partial<ConstraintDraft["editableRegions"][number]>) => {
    setDraft((current) => ({
      ...current,
      editableRegions: current.editableRegions.map((region) => region.id === id ? { ...region, ...patch } : region),
    }));
  };

  return (
    <aside className="constraint-inspector" aria-label="人工约束" onPointerDown={(event) => event.stopPropagation()}>
      <header>
        <div><span>人工约束</span><strong>{snapshot ? "基于已保存快照创建新版本" : "尚未生成快照"}</strong></div>
        {snapshot && <em>{snapshot.id.slice(-8)}</em>}
      </header>
      <fieldset>
        <legend>不可修改项</legend>
        <label className="check-row"><input type="checkbox" checked={draft.productLocked} onChange={(event) => setDraft({ ...draft, productLocked: event.target.checked })} />锁定商品主体像素</label>
        <label className="check-row"><input type="checkbox" checked={draft.brandLocked} onChange={(event) => setDraft({ ...draft, brandLocked: event.target.checked })} />锁定品牌标识与标准色</label>
      </fieldset>
      <fieldset>
        <legend>可编辑区域</legend>
        {draft.editableRegions.map((region, index) => (
          <div className="region-row" key={region.id}>
            <input aria-label={`区域 ${index + 1} 描述`} value={region.description} onChange={(event) => updateRegion(region.id, { description: event.target.value })} />
            <select aria-label={`区域 ${index + 1} 蒙版`} value={region.maskAssetId ?? ""} onChange={(event) => updateRegion(region.id, { maskAssetId: event.target.value || undefined })}>
              <option value="">无蒙版资产</option>
              {assets.filter((asset) => asset.kind === "image").map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName}</option>)}
            </select>
            {draft.editableRegions.length > 1 && <button aria-label={`删除区域 ${index + 1}`} onClick={() => setDraft({ ...draft, editableRegions: draft.editableRegions.filter((item) => item.id !== region.id) })}>删除</button>}
          </div>
        ))}
        <button className="secondary" onClick={() => setDraft({
          ...draft,
          editableRegions: [...draft.editableRegions, { id: `region-${crypto.randomUUID()}`, description: "新的可编辑区域" }],
        })}>＋ 添加区域</button>
      </fieldset>
      <fieldset className="brand-fields">
        <legend>品牌规则</legend>
        <label>语气<input value={draft.brandTone} onChange={(event) => setDraft({ ...draft, brandTone: event.target.value })} /></label>
        <label>禁用词<input value={draft.forbiddenTerms} onChange={(event) => setDraft({ ...draft, forbiddenTerms: event.target.value })} /></label>
      </fieldset>
      <fieldset>
        <legend>输出规格</legend>
        <div className="output-spec-row">
          <label>宽<input aria-label="输出宽度" type="number" min="64" max="8192" value={draft.outputWidth} onChange={(event) => setDraft({ ...draft, outputWidth: Number(event.target.value) })} /></label>
          <span>×</span>
          <label>高<input aria-label="输出高度" type="number" min="64" max="8192" value={draft.outputHeight} onChange={(event) => setDraft({ ...draft, outputHeight: Number(event.target.value) })} /></label>
          <label>格式<select aria-label="输出格式" value={draft.outputFormat} onChange={(event) => setDraft({ ...draft, outputFormat: event.target.value as ConstraintDraft["outputFormat"] })}>
            <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option><option value="mp4">MP4</option>
          </select></label>
        </div>
      </fieldset>
      {error && <p className="constraint-error" role="alert">{error}</p>}
      <button className="constraint-save" onClick={() => {
        try {
          onSave(draft);
          setError("");
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : "约束快照保存失败");
        }
      }}>保存为新约束快照</button>
      <small>快照创建后不可修改；后续调整会生成新版本，AI 执行只能引用明确快照。</small>
    </aside>
  );
}

export { defaultConstraintDraft };
