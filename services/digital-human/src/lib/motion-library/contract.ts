import type {SemanticPolicy} from './visual';
export interface EffectRef {id: string; revision: number}
export interface EffectAsset {id: string; name: string; kind: 'image' | 'video'; url: string; width: number; height: number; duration: number; description: string}
export interface EffectTemplate {compiled: string; assets: EffectAsset[]; backgroundColor?: string; semantics?: SemanticPolicy}
export interface EffectMessage {role: 'user' | 'assistant'; content: string}
export interface LibraryEffect {
  builtin?: boolean;
  semantics?: SemanticPolicy;
  id: string; name: string; status: 'building' | 'ready' | 'failed'; message: string; error?: string;
  revision: number; saved: boolean; updatedAt: number; messages: EffectMessage[];
  assets: EffectAsset[]; previewUrl?: string; template?: EffectTemplate;
}
export const EFFECT_SAMPLE = {start: 0, end: 6, headline: '让好想法被看见', line1: '把复杂信息讲清楚', line2: '让每一次表达更有力量', highlight: '表达'};
export const isEffectId = (id: unknown): id is string => typeof id === 'string' && /^effect_[a-f0-9-]{36}$/.test(id);
export const isBuiltinEffectId = (id: unknown): boolean => id === 'builtin_green_text' || id === 'builtin_green_diagram';
export function validateEffectBackground(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error('动效背景色必须为六位十六进制颜色');
  return value;
}
export function validateEffectRef(value: unknown): EffectRef | undefined {
  if (value === undefined || value === null) return undefined;
  const r = value as EffectRef;
  if ((!isEffectId(r.id) && !isBuiltinEffectId(r.id)) || !Number.isInteger(r.revision) || r.revision < 1 || (isBuiltinEffectId(r.id) && r.revision > (r.id==='builtin_green_diagram'?2:1))) throw new Error('请选择已保存的动效');
  return {id: r.id, revision: r.revision};
}
