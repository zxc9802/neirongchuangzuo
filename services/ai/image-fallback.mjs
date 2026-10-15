import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const FAL_IMAGE_MODEL = 'openai/gpt-image-2.5/sunburst/edit';
const RETRYABLE = new Set(['PROVIDER_ERROR', 'PROVIDER_AUTH', 'PROVIDER_LIMIT', 'UPSTREAM_RESPONSE', 'UPSTREAM_UNCERTAIN', 'EMPTY_RESULT', 'INVALID_IMAGE', 'DOWNLOAD_TIMEOUT', 'FOOD_RENDER_PROVIDER_ERROR', 'FOOD_RENDER_INVALID_OUTPUT', 'PROVIDER_UNCERTAIN']);
const uncertain = error => ['UPSTREAM_UNCERTAIN', 'PROVIDER_UNCERTAIN'].includes(error?.code);
const failure = (message, code, status = 502) => Object.assign(new Error(message), { code, status });
const digest = value => createHash('sha256').update(value).digest('hex');

async function readJSON(response) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 48 * 1024 * 1024) throw failure('备用图片服务返回内容过大。', 'FAL_INVALID_OUTPUT');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('备用图片服务返回内容无法读取。', 'FAL_INVALID_OUTPUT'); }
}

function queueURL(raw, requestId, status = false) {
  let url;
  try { url = new URL(raw); } catch { throw failure('备用图片任务地址无效。', 'FAL_INVALID_OUTPUT'); }
  if (url.origin !== 'https://queue.fal.run' || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith(`/requests/${requestId}${status ? '/status' : ''}`)
    || !url.pathname.startsWith('/openai/gpt-image-2.5/')) throw failure('备用图片任务地址无效。', 'FAL_INVALID_OUTPUT');
  return url.href;
}

export async function falImage({ config, ledger, id, form, fetchImpl = fetch, sleepImpl = sleep,
  timeoutMs = 600_000, pollMs = 2_000, now = Date.now, isStopping = () => false }) {
  const model = config.falImageModel || FAL_IMAGE_MODEL;
  if (model !== FAL_IMAGE_MODEL) throw failure('备用图片模型配置无效。', 'FAL_INVALID_CONFIG', 503);
  const image_urls = await Promise.all(form.getAll('image').map(async file => `data:${file.type || 'image/png'};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`));
  const [width, height] = String(form.get('size')).split('x').map(Number);
  const input = { prompt: String(form.get('prompt')), image_urls, image_size: { width, height },
    quality: String(form.get('quality') || 'high'), num_images: 1, output_format: 'png', background: 'opaque', enable_safety_checker: true };
  const headers = { Authorization: `Key ${config.falImageKey}` };
  const deadline = now() + timeoutMs;
  async function request(url, method = 'GET', body) {
    const remaining = deadline - now();
    if (remaining <= 0 || isStopping()) throw failure('备用图片任务仍在处理中，请稍后查看原任务。', 'UPSTREAM_UNCERTAIN');
    const response = await fetchImpl(url, { method, redirect: 'error', headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(Math.min(remaining, 60_000)) });
    if (!response.ok) {
      await response.body?.cancel();
      throw failure('备用图片服务暂时不可用，请稍后查询任务。', 'FAL_PROVIDER_ERROR', response.status === 429 ? 429 : 502);
    }
    return readJSON(response);
  }
  let submitted;
  try { submitted = await request(`https://queue.fal.run/${model}`, 'POST', input); }
  catch (error) {
    if (error.code === 'FAL_PROVIDER_ERROR') throw error;
    throw failure('备用图片请求未收到确认，已停止重复提交。', 'UPSTREAM_UNCERTAIN');
  }
  const requestId = submitted.request_id;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(requestId || '')) throw failure('备用图片请求未收到有效任务编号。', 'UPSTREAM_UNCERTAIN');
  await ledger.recordProviderRequest(id, requestId);
  const base = `https://queue.fal.run/openai/gpt-image-2.5/requests/${requestId}`;
  const statusURL = queueURL(submitted.status_url || `${base}/status`, requestId, true);
  const resultURL = queueURL(submitted.response_url || base, requestId);
  let completed = false;
  for (;;) {
    if (now() >= deadline || isStopping()) throw failure('备用图片任务尚未取得结果，请稍后查询原任务。', 'UPSTREAM_UNCERTAIN');
    let output;
    try { output = await request(completed ? resultURL : statusURL); }
    catch (error) {
      if (error.code === 'FAL_INVALID_OUTPUT') throw error;
      // Only reads are repeated; an accepted generation is never submitted again.
      await sleepImpl(Math.min(pollMs, Math.max(1, deadline - now()))); continue;
    }
    if (!completed) {
      if (output.error || ['FAILED', 'CANCELLED'].includes(output.status)) throw failure('备用图片生成失败。', 'FAL_PROVIDER_ERROR');
      if (output.status === 'COMPLETED') completed = true;
      else if (!['IN_QUEUE', 'IN_PROGRESS'].includes(output.status)) throw failure('备用图片任务状态无效。', 'FAL_INVALID_OUTPUT');
      else await sleepImpl(Math.min(pollMs, Math.max(1, deadline - now())));
      continue;
    }
    if (output.error || !Array.isArray(output.images) || output.images.length !== 1 || typeof output.images[0]?.url !== 'string') throw failure('备用图片未返回完整结果。', 'FAL_INVALID_OUTPUT');
    return { data: { data: [{ url: output.images[0].url }], usage: output.usage }, providerRequestId: requestId, provider: 'fal' };
  }
}

// The first call is already reserved by the caller. Every retry has a new ID;
// points are settled by the owning task, independent of provider attempts.
export async function imageWithFallback({ config, ledger, id, form, dispatch, primary, consume,
  fetchImpl = fetch, sleepImpl = sleep, isStopping = () => false, timeoutMs, pollMs, now }) {
  const enabled = !!config.falImageKey;
  const signature = digest(JSON.stringify({ prompt: form.get('prompt'), size: form.get('size'), parent: id }));
  const attempts = enabled ? 5 : 1;
  for (let index = 0; index < attempts; index++) {
    const fallback = index === 4;
    const attemptId = index === 0 ? id : `image-${digest(`${id}:${index}`).slice(0, 56)}`;
    let sent = false, info;
    if (index > 0) {
      const reservation = await dispatch(() => ledger.reserve({ id: attemptId, kind: 'image', model: fallback ? config.falImageModel || FAL_IMAGE_MODEL : config.imageModel, fingerprint: signature }));
      if (reservation.created === false) throw failure('该图片已有调用记录，请查看原任务。', 'REQUEST_ALREADY_RECORDED', 409);
    }
    try {
      await dispatch(() => ledger.markDispatched(attemptId)); sent = true;
      info = fallback ? await falImage({ config, ledger, id: attemptId, form, fetchImpl, sleepImpl, isStopping, timeoutMs, pollMs, now }) : await primary(form);
      const result = await consume(info);
      if (index > 0) await ledger.finish(attemptId, { status: 'completed', usage: info.data?.usage, providerRequestId: info.providerRequestId });
      return { ...result, attemptId, provider: fallback ? 'fal' : 'primary' };
    } catch (error) {
      if (!enabled) throw error;
      await ledger.finish(attemptId, { status: !sent ? 'cancelled' : uncertain(error) ? 'uncertain' : 'failed', code: error.code || 'IMAGE_RESULT_FAILED', usage: info?.data?.usage, providerRequestId: info?.providerRequestId });
      if (!sent || fallback || !RETRYABLE.has(error.code)) throw error;
      await sleepImpl(1000 * (index + 1));
    }
  }
}
