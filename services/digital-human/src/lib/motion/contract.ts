import {validateVisualPlan, type VisualPlan} from '../motion-library/visual';
import {validateEffectRef, type EffectRef} from "../motion-library/contract";
export type MotionStatus = "analyzing" | "ready" | "rendering" | "completed" | "failed";
export interface MotionCaption { start: number; end: number; text: string }
export interface MotionTaskSource { taskId: string; name: string; duration: number; sourceUrl: string }
export interface MotionScene {
  visual?: VisualPlan;
  start: number; end: number; headline: string; line1: string; line2: string; highlight: string;
  diagramLayout?: 'flow' | 'branch' | 'merge' | 'equation';
}
export interface MotionCrop { x: number; y: number; zoom: number }
export const DEFAULT_MOTION_CROP: MotionCrop = {x: 0.5, y: 0.5, zoom: 1};
export interface MotionEdit {
  title: string; subtitle: string; fit: "contain" | "cover";
  crop: MotionCrop;
  effect?: EffectRef;
  captions: MotionCaption[]; scenes: MotionScene[];
}
export interface MotionProject extends MotionEdit {
  id: string; name: string; createdAt: number; updatedAt: number;
  status: MotionStatus; progress: number; message: string; duration: number;
  width?: number; height?: number; error?: string;
  sourceUrl: string; finalUrl?: string;
}
export const MOTION_LAYOUT = { width: 1080, height: 1920, top: 456, speaker: 920, bottom: 544, fps: 30 };
export const MAX_MOTION_SECONDS = 600;
export class MotionInputError extends Error {}

function text(value: unknown, label: string, max: number, optional = false): string {
  if (typeof value !== "string" || (!optional && !value.trim()) || [...value.trim()].length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    throw new MotionInputError(`${label}${optional ? "" : "不能为空，且"}最多 ${max} 字`);
  }
  return value.trim().replace(/[\r\n]+/g, " ");
}
function timeline<T>(value: unknown, duration: number, label: string, max: number, parse: (row: Record<string, unknown>) => T): (T & {start: number; end: number})[] {
  if (!Array.isArray(value) || value.length > max) throw new MotionInputError(`${label}格式或数量无效`);
  let previousEnd = 0;
  return value.map((row, i) => {
    if (!row || typeof row !== "object" || typeof row.start !== "number" || typeof row.end !== "number" ||
      !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.end - row.start < 0.1 ||
      row.end > duration + 0.05 || row.start < previousEnd - 0.001) {
      throw new MotionInputError(`${label}第 ${i + 1} 段时间无效：不能重叠或超出视频时长`);
    }
    previousEnd = row.end;
    return { ...parse(row), start: row.start, end: Math.min(row.end, duration) };
  });
}
export function validateMotionEdit(value: unknown, duration: number, requireContent = false): MotionEdit {
  if (!value || typeof value !== "object") throw new MotionInputError("请填写动效内容");
  const row = value as Record<string, unknown>;
  if (row.fit !== "contain" && row.fit !== "cover") throw new MotionInputError("请选择画面适配方式");
  const crop = row.crop === undefined ? {...DEFAULT_MOTION_CROP} : row.crop as MotionCrop;
  if (!crop || typeof crop !== "object" || Array.isArray(crop) ||
    ![crop.x, crop.y, crop.zoom].every(n => typeof n === "number" && Number.isFinite(n)) ||
    crop.x < 0 || crop.x > 1 || crop.y < 0 || crop.y > 1 || crop.zoom < 1 || crop.zoom > 3) {
    throw new MotionInputError("裁剪位置无效，缩放范围为 100%–300%，请重新调整画面");
  }
  let effect: EffectRef | undefined;
  try {effect = validateEffectRef(row.effect);} catch {throw new MotionInputError("请选择已保存的动效");}
  const captions = timeline(row.captions, duration, "字幕", 1200, c => ({text: text(c.text, "字幕", 80)}));
  const scenes = timeline(row.scenes, duration, "底部总结", 150, s => {
    const result = {headline: text(s.headline, "总结标题", 18), line1: text(s.line1, "总结第一行", 26), line2: text(s.line2, "总结第二行", 26, true), highlight: text(s.highlight ?? "", "高亮词", 12, true)};
    if (result.highlight && !(result.line1 + result.line2).includes(result.highlight)) throw new MotionInputError("高亮词必须出现在总结正文中");
    if(s.diagramLayout!==undefined&&!['flow','branch','merge','equation'].includes(s.diagramLayout as string))throw new MotionInputError('请选择有效的图解结构');
    let visual: VisualPlan | undefined;
    try { if (s.visual !== undefined) visual = validateVisualPlan(s.visual); } catch { throw new MotionInputError('图解内容无效，请重新分析'); }
    return {...result,...(visual ? {visual} : {}),...(s.diagramLayout?{diagramLayout:s.diagramLayout as MotionScene['diagramLayout']}:{})};
  });
  if (requireContent && (!captions.length || !scenes.length)) throw new MotionInputError("请先补充字幕和底部总结");
  return {title: text(row.title, "顶部第一行标题", 22), subtitle: text(row.subtitle, "顶部第二行标题", 26), fit: row.fit, crop: {x: crop.x, y: crop.y, zoom: crop.zoom}, captions, scenes, ...(effect ? {effect} : {})};
}
export function parseSrt(srt: string): MotionCaption[] {
  const stamp = (s: string) => { const p = s.replace(",", ".").split(":").map(Number); return p[0] * 3600 + p[1] * 60 + p[2]; };
  const blocks = srt.replace(/^\uFEFF/, "").trim().split(/\r?\n\s*\r?\n/);
  return blocks.map((block, i) => {
    const lines = block.split(/\r?\n/);
    const at = lines.findIndex(l => l.includes("-->"));
    const match = lines[at]?.match(/^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*$/);
    if (!match || !lines.slice(at + 1).join("").trim()) throw new MotionInputError(`SRT 第 ${i + 1} 段格式无效`);
    return {start: stamp(match[1]), end: stamp(match[2]), text: lines.slice(at + 1).join(" ").replace(/<[^>]*>/g, "")};
  });
}
