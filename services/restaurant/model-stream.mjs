import { RestaurantError } from './rules.mjs';
import { structuredOutputError } from './structured-output.mjs';

export async function readCompletionStream(body, maximumBytes = 2 * 1024 * 1024) {
  const decoder = new TextDecoder();
  let pending = '', data = [], size = 0, content = '', refusal = '', id, model, usage, finishReason, ended = false, invalid = false, providerError = false;
  const event = () => {
    const raw = data.join('\n').trim(); data = [];
    if (!raw) return;
    if (raw === '[DONE]') { ended = true; return; }
    let value;
    try { value = JSON.parse(raw); } catch { invalid = true; return; }
    if (value.error) { providerError = true; return; }
    id = value.id || id; model = value.model || model; usage = value.usage || usage;
    const choice = value.choices?.find(item => item.index === 0) || value.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (typeof choice?.delta?.refusal === 'string') refusal += choice.delta.refusal;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  };
  const line = value => {
    if (!value) event();
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maximumBytes) throw new RestaurantError('模型返回过大，已停止接收。', 502, 'MODEL_INVALID_OUTPUT');
    pending += decoder.decode(chunk, { stream: true });
    let split;
    while ((split = pending.indexOf('\n')) >= 0) { line(pending.slice(0, split).replace(/\r$/, '')); pending = pending.slice(split + 1); }
  }
  pending += decoder.decode();
  if (pending) line(pending.replace(/\r$/, ''));
  event();
  const payload = { id, model, usage, choices: [{ message: { content, ...(refusal ? { refusal } : {}) }, finish_reason: finishReason }] };
  if (providerError) throw Object.assign(new RestaurantError('内容分析服务暂时不可用，请稍后重试。', 502, 'PROVIDER_ERROR'), { streamComplete: true, providerPayload: payload });
  if (!ended && !finishReason) throw Object.assign(new Error('Incomplete model stream'), { code: 'MODEL_STREAM_INCOMPLETE' });
  if (invalid) throw Object.assign(structuredOutputError('invalid_json'), { streamComplete: true, providerPayload: payload });
  return payload;
}
