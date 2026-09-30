export const VISUAL_LAYOUTS = ['flow', 'branch', 'merge', 'compare', 'equation', 'list'] as const;
export const VISUAL_ICONS = ['person', 'team', 'book', 'chip', 'gear', 'company', 'check', 'chat', 'document', 'chart', 'money', 'none'] as const;
export type VisualLayout = typeof VISUAL_LAYOUTS[number];
export interface SemanticPolicy {required: boolean; reason: string; layouts: VisualLayout[]}
export interface VisualPlan {
  layout: VisualLayout;
  nodes: {label: string; icon: typeof VISUAL_ICONS[number]; emphasis: boolean}[];
}
export function validateSemanticPolicy(value: unknown): SemanticPolicy {
  const p = value as SemanticPolicy;
  if (!p || typeof p.required !== 'boolean' || typeof p.reason !== 'string' || !p.reason.trim() || p.reason.length > 160 ||
    !Array.isArray(p.layouts) || p.layouts.some(l => !VISUAL_LAYOUTS.includes(l)) || (p.required && !p.layouts.length)) throw new Error('模板内容分析判断格式无效');
  return {required: p.required, reason: p.reason.trim(), layouts: p.required ? [...new Set([...p.layouts, 'list' as const])] : []};
}
export function validateVisualPlan(value: unknown): VisualPlan {
  const p = value as VisualPlan;
  if (!p || !VISUAL_LAYOUTS.includes(p.layout) || !Array.isArray(p.nodes) || p.nodes.length < 1 || p.nodes.length > 4 ||
    (['branch', 'merge', 'equation'].includes(p.layout) && p.nodes.length < 3)) throw new Error('图解结构无效');
  const nodes = p.nodes.map(n => {
    if (!n || typeof n.label !== 'string' || !n.label.trim() || [...n.label.trim()].length > 14 || /[\x00-\x1f]/.test(n.label) ||
      !VISUAL_ICONS.includes(n.icon) || typeof n.emphasis !== 'boolean') throw new Error('图解节点无效');
    return {label: n.label.trim(), icon: n.icon, emphasis: n.emphasis};
  });
  return {layout: p.layout, nodes};
}
