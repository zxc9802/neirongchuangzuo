import { RestaurantError } from './rules.mjs';

export function structuredOutputError(issue) {
  return Object.assign(new RestaurantError('内容分析暂未完成，请稍后重试。', 502, 'MODEL_INVALID_OUTPUT'), { outputIssue: issue });
}

export function parseStructuredOutput(payload) {
  const choice = payload?.choices?.[0];
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
    throw new RestaurantError('内容分析服务未接受这组素材，请调整后重试。', 502, 'MODEL_REFUSED');
  }
  if (['length', 'max_tokens'].includes(choice?.finish_reason)) throw structuredOutputError('truncated');
  const raw = choice?.message?.content;
  const content = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('') : '';
  let source = content.trim().replace(/^\uFEFF/, '');
  if (!source) throw structuredOutputError('empty');
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) source = fenced[1].trim();
  let result;
  try { result = JSON.parse(source); }
  catch (initialError) {
    const first = source.indexOf('{'), last = source.lastIndexOf('}');
    if (first < 0 || last <= first || source.slice(0, first).trim().endsWith('[') || source.slice(last + 1).trim().startsWith(']')) throw Object.assign(structuredOutputError('invalid_json'), { parseError: initialError.message });
    try { result = JSON.parse(source.slice(first, last + 1)); }
    catch (error) { throw Object.assign(structuredOutputError('invalid_json'), { parseError: error.message }); }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw structuredOutputError('invalid_schema');
  return result;
}
