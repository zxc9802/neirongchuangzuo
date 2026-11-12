import { VIDEO_DIRECTORS, DEFAULT_VIDEO_DIRECTOR } from '../../design/video-catalog.js';
import { setTimeout as delay } from 'node:timers/promises';

export function directorSelection(id = DEFAULT_VIDEO_DIRECTOR) {
  const selected = VIDEO_DIRECTORS.find(model => model.id === id);
  if (!selected) throw Object.assign(new Error('请选择 Gemini 或 Kimi 编导。'), { status: 400, code: 'DIRECTOR_MODEL_INVALID' });
  return selected;
}

export function directorRequest(config, selected, system, content, maxTokens) {
  const base = config.baseUrl.replace(/\/$/, '');
  if (selected.id === 'gemini') {
    return { url: 'https://queue.fal.run/openrouter/router/openai/v1/chat/completions', queue: true, body: {
      model: selected.model, messages: [{ role: 'system', content: system }, { role: 'user', content }],
      stream: false, max_tokens: maxTokens, temperature: 1, top_p: 1,
      reasoning: { effort: 'high', exclude: true }, response_format: { type: 'json_object' },
    } };
  }
  return { url: base + '/chat/completions', body: { model: selected.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    stream: true, stream_options: { include_usage: true }, response_format: { type: 'json_object' },
    max_tokens: maxTokens, temperature: 1, top_p: .95, reasoning_effort: 'max',
  } };
}

export async function fetchDirector(request, config, { fetchImpl, signal, onQueued } = {}) {
  const headers = { Authorization: request.queue ? `Key ${config.falKey}` : `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
  const response = await fetchImpl(request.url, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(request.body), signal });
  if (!request.queue || !response.ok) return response;
  const job = await response.json();
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(job.request_id)) {
    throw Object.assign(new Error('编导提交结果未获确认，请核对原任务后再试。'), { code: 'DIRECTOR_SUBMISSION_UNCERTAIN' });
  }
  await onQueued?.(job.request_id);
  // Queue URLs use the application prefix, not the submitted compatibility route.
  const resultUrl = `https://queue.fal.run/openrouter/router/requests/${job.request_id}`;
  while (true) {
    const status = await fetchImpl(resultUrl + '/status', { redirect: 'error', headers, signal });
    if (!status.ok) throw Object.assign(new Error(`编导任务状态查询失败（HTTP ${status.status}），请核对原任务。`), { code: 'DIRECTOR_FAL_STATUS_ERROR' });
    const state = await status.json();
    if (state.status === 'COMPLETED') break;
    if (!['IN_QUEUE', 'IN_PROGRESS'].includes(state.status)) throw Object.assign(new Error('编导任务未完成，请核对原任务。'), { code: 'DIRECTOR_FAL_JOB_FAILED' });
    await delay(1000, undefined, { signal });
  }
  const result = await fetchImpl(resultUrl, { redirect: 'error', headers, signal });
  const resultHeaders = new Headers(result.headers); resultHeaders.set('x-request-id', job.request_id);
  return new Response(result.body, { status: result.status, headers: resultHeaders });
}
