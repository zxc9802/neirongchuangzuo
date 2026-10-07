import { randomUUID } from 'node:crypto';
import { createRequestLedger } from '../ai/request-ledger.mjs';
import { RestaurantError, fingerprint, validateAnalysis, validateDirections, validateCopy, validateAudit } from './rules.mjs';
import { ANALYSIS_PROMPT, RECOMMEND_PROMPT, COPY_PROMPT, COPY_REWRITE_PROMPT, AUDIT_PROMPT } from './prompts.mjs';

/** Separate durable provider-attempt budget. User package charges live in the store. */
export function createRestaurantModel({ config, storageDir, fetchImpl = fetch, now = Date.now, timeoutMs = 90_000, ledger: injectedLedger } = {}) {
  const ledger = injectedLedger ?? createRequestLedger({ storageDir, now, limits: config.limits });
  const ready = ledger.ready;
  async function call(prompt, input, photos = []) {
    if (!config.apiKey) throw new RestaurantError('尚未配置内容分析接口，请联系管理员。', 503, 'MODEL_NOT_CONFIGURED');
    const id = randomUUID();
    const body = { model: config.chatModel, messages: [{ role: 'system', content: prompt }, { role: 'user', content: photos.length ? [{ type: 'text', text: JSON.stringify(input) }, ...photos.map(photo => ({ type: 'image_url', image_url: { url: photo.dataUrl, detail: 'high' } }))] : JSON.stringify(input) }], response_format: { type: 'json_object' }, temperature: 0.3 };
    await ledger.reserve({ id, kind: 'chat', model: config.chatModel, fingerprint: fingerprint(body) });
    const controller = new AbortController(); let dispatched = false, responseReceived = false, responseOK = false, bodyComplete = false, timer;
    try {
      await ledger.markDispatched(id); dispatched = true;
      timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      responseReceived = true;
      responseOK = response.ok;
      if (!response.ok) throw new RestaurantError(response.status === 429 || response.status === 402 ? '内容分析服务额度不足或请求过于频繁。' : '内容分析服务暂时不可用，请联系管理员。', 502, 'PROVIDER_ERROR');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new RestaurantError('模型返回过大，已停止接收。', 502, 'MODEL_INVALID_OUTPUT'); chunks.push(chunk); }
      bodyComplete = true;
      let payload, result;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof payload.choices?.[0]?.message?.content !== 'string' || payload.choices?.[0]?.finish_reason === 'length') throw new Error('truncated');
        result = JSON.parse(payload.choices[0].message.content);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('schema');
      } catch { throw new RestaurantError('模型没有返回完整的结构化结果，任务已停止。', 502, 'MODEL_INVALID_OUTPUT'); }
      await ledger.finish(id, { status: 'completed', usage: payload.usage, providerRequestId: payload.id });
      return result;
    } catch (cause) {
      const uncertain = dispatched && (!responseReceived || controller.signal.aborted || (responseOK && !bodyComplete && cause.code !== 'MODEL_INVALID_OUTPUT'));
      await ledger.finish(id, { status: uncertain ? 'uncertain' : dispatched ? 'failed' : 'cancelled', code: uncertain ? 'PROVIDER_UNCERTAIN' : cause.code || 'PROVIDER_ERROR' }).catch(() => {});
      if (uncertain) throw new RestaurantError('模型请求结果未确认，上游可能已执行。请管理员核对调用记录后再重新发起，系统不会自动重复请求。', 502, 'PROVIDER_UNCERTAIN');
      throw cause;
    } finally { clearTimeout(timer); }
  }
  return {
    ready,
    enabled: Boolean(config.apiKey),
    async analyse(photos, profile) { return validateAnalysis(await call(ANALYSIS_PROMPT, { profile, images: photos.map(photo => ({ imageId: photo.id, width: photo.width, height: photo.height })) }, photos), photos.map(photo => photo.id)); },
    async recommend(analysis, profile) { return validateDirections(await call(RECOMMEND_PROMPT, { profile, images: analysis }), analysis, profile); },
    async write({ profile, analysis, direction, facts, photos = [], draft, qualityIssues = [] }) {
      const input = { profile, images: analysis, direction, confirmedFacts: facts, visualImageIds: photos.map(photo => photo.id), ...(draft ? { draft, qualityIssues } : {}) };
      return validateCopy(await call(draft ? COPY_REWRITE_PROMPT : COPY_PROMPT, input, photos), analysis.map(item => item.imageId));
    },
    async audit({ photos = [], ...input }) { return validateAudit(await call(AUDIT_PROMPT, { ...input, visualImageIds: photos.map(photo => photo.id) }, photos)); },
    usage: () => ledger.summary(),
    close: () => injectedLedger ? Promise.resolve() : ledger.close(),
  };
}
