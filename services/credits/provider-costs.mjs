import { CreditsError } from './store.mjs';

const unavailable = message => new CreditsError(message, 503, 'COST_PRICING_UNAVAILABLE');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function openluxRate(pricing, status, modelName, group) {
  const model = pricing?.data?.find(item => item.model_name === modelName), factor = pricing?.group_ratio?.[group];
  const fx = status?.data?.usd_exchange_rate;
  if (!model || !model.enable_groups?.includes(group) || !Number.isFinite(factor) || factor <= 0 || !Number.isFinite(fx) || fx <= 0) throw unavailable('模型计费分组未配置或报价暂不可用，请联系管理员。');
  if (model.quota_type === 1 && Number.isFinite(model.model_price) && model.model_price > 0)
    return { type: 'request', requestCny: model.model_price * factor * fx, modelName, group, fx };
  if (model.quota_type !== 0 || !Number.isFinite(model.model_ratio) || model.model_ratio <= 0 || !Number.isFinite(model.completion_ratio)) throw unavailable('该模型的计费方式暂未支持。');
  const inputCnyMillion = 2 * model.model_ratio * factor * fx;
  return { type: 'tokens', inputCnyMillion, outputCnyMillion: inputCnyMillion * model.completion_ratio,
    cacheRatio: model.cache_ratio ?? 1, write5Ratio: model.cache_creation_5m_ratio ?? model.cache_creation_ratio ?? 1,
    write1hRatio: model.cache_creation_1h_ratio ?? model.cache_creation_ratio ?? 1,
    steps: model.step_ratios || [], modelName, group, fx };
}

export function tokenCostCny(usage, rate) {
  if (rate.type !== 'tokens') throw unavailable('缺少Token计费单价。');
  const input = count(usage?.prompt_tokens ?? usage?.input_tokens), output = count(usage?.completion_tokens ?? usage?.output_tokens);
  if (input === null || output === null) throw new CreditsError('供应商未返回完整用量，费用等待确认。', 503, 'COST_USAGE_MISSING');
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const cached = count(details.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
  const write1 = count(usage.claude_cache_creation_1_h_tokens ?? usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const write5 = count(usage.claude_cache_creation_5_m_tokens ?? usage.cache_creation?.ephemeral_5m_input_tokens
    ?? Math.max(0, (details.cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0) - (write1 ?? 0)));
  if ([cached,write1,write5].some(v => v === null) || cached + write1 + write5 > input) throw new CreditsError('供应商缓存用量不完整，费用等待确认。', 503, 'COST_USAGE_MISSING');
  const step = rate.steps?.find(item => item.step_size >= input) || rate.steps?.at(-1);
  const inputScale = step?.prompt_step_ratio ?? 1, outputScale = step?.completion_step_ratio ?? 1, cacheScale = step?.cache_step_ratio ?? inputScale;
  return ((input - cached - write1 - write5) * inputScale + cached * rate.cacheRatio * cacheScale
    + write5 * rate.write5Ratio * inputScale + write1 * rate.write1hRatio * inputScale) * rate.inputCnyMillion / 1e6
    + output * rate.outputCnyMillion * outputScale / 1e6;
}

export function tokenQuoteCny(body, rate) {
  const images = (body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(part => part.type === 'image_url').length;
  const text = JSON.stringify((body.messages || []).map(m => ({...m,content:Array.isArray(m.content)?m.content.filter(p=>p.type!=='image_url'):m.content})));
  // Opus 5.5 caps each image at 4,784 visual tokens: platform.claude.com/docs/en/build-with-claude/vision.
  const imageBound = /^claude/.test(body.model || rate.modelName) ? 5_000 : 16_000;
  const inputBound = Buffer.byteLength(text,'utf8') + (body.messages?.length || 0)*256 + images*imageBound;
  const outputBound = body.max_tokens ?? body.max_completion_tokens ?? 8192;
  if (!Number.isSafeInteger(outputBound) || outputBound <= 0) throw unavailable('缺少模型输出上限，无法预留费用。');
  const cacheBound=JSON.stringify(body.messages||[]).includes('"ttl":"1h"') ? Math.max(1,rate.write5Ratio,rate.write1hRatio) : Math.max(1,rate.write5Ratio);
  const step = rate.steps?.find(item=>item.step_size>=inputBound) || rate.steps?.at(-1);
  return Math.max(0.008,inputBound*rate.inputCnyMillion*(step?.prompt_step_ratio??1)*cacheBound/1e6
    + outputBound*rate.outputCnyMillion*(step?.completion_step_ratio??1)/1e6);
}

export function createProviderPrices({ config = {}, fetchImpl = fetch, now = Date.now } = {}) {
  let cache, expires = 0, pending;
  const receiptReads = new Map();
  async function publicPrices() {
    if (cache && now() < expires) return cache;
    if (pending) return pending;
    pending = Promise.all(['https://www.openlux.ai/api/pricing_new','https://www.openlux.ai/api/status'].map(async url => {
      const response = await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw unavailable('计费报价暂时无法读取，请稍后重试。');
      return response.json();
    })).then(([pricing,status])=>{cache={pricing,status};expires=now()+300000;return cache;}).finally(()=>{pending=null;});
    return pending;
  }
  return {
    async openluxAuto(body) {
      const { pricing, status } = await publicPrices();
      const model = pricing?.data?.find(row => row.model_name === body.model);
      const rates = (model?.enable_groups || []).flatMap(group => {
        try { return [openluxRate(pricing, status, body.model, group)]; } catch { return []; }
      });
      const quotaPerUnit = status?.data?.quota_per_unit, fx = status?.data?.usd_exchange_rate;
      if (!rates.length || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) throw unavailable('模型实时预算暂不可用，请稍后重试。');
      return { type: 'receipt', modelName: body.model, group: 'auto', fx, unitPrice: fx / quotaPerUnit,
        quoteCny: Math.max(.008, ...rates.map(rate => rate.type === 'request' ? rate.requestCny : tokenQuoteCny(body, rate))) };
    },
    async openluxReceipt(requestId, startedAt, responseAt = now()) {
      if (!requestId || !config.apiKey || !Number.isFinite(startedAt)) return null;
      const start = Math.floor(startedAt / 1000) - 5, end = Math.ceil(responseAt / 1000) + 10;
      const key = `${start}:${end}`, old = receiptReads.get(key);
      if (old && old.expires > now()) return (await old.promise).get(requestId) || null;
      const promise = (async () => {
        const rows = new Map(), seen = new Set();
        for (let page = 1; page <= 20; page++) {
          const url = new URL('https://www.openlux.ai/api/log/token');
          url.searchParams.set('key', config.apiKey.replace(/^sk-/, ''));
          url.searchParams.set('page', String(page)); url.searchParams.set('page_size', '100');
          url.searchParams.set('start_timestamp', String(start)); url.searchParams.set('end_timestamp', String(end));
          let data;
          try {
            const response = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error(); data = await response.json();
          } catch { throw unavailable('实际消费记录暂时无法读取，费用等待核对。'); }
          if (data.success !== true || !Array.isArray(data.data?.items)) throw unavailable('实际消费记录暂时无法读取，费用等待核对。');
          for (const row of data.data.items) {
            if (row.type !== 2 || seen.has(row.id) || !Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.quota) || row.quota < 0) continue;
            seen.add(row.id); let other; try { other = JSON.parse(row.other || '{}'); } catch { continue; }
            const id = other.request_id; if (typeof id !== 'string') continue;
            const item = rows.get(id) || { quota: 0, logIds: [], groups: [] };
            item.quota += row.quota; item.logIds.push(row.id); item.groups.push(String(row.group || ''));
            rows.set(id, item);
          }
          if (page * 100 >= data.data.total || data.data.items.length < 100) return rows;
        }
        // A truncated window must not be treated as a complete receipt.
        throw unavailable('消费记录较多，费用等待核对。');
      })();
      receiptReads.set(key, { expires: now() + 500, promise });
      if (receiptReads.size > 30) receiptReads.delete(receiptReads.keys().next().value);
      return (await promise).get(requestId) || null;
    },
    async openlux(model) {
      const group = model === config.imageModel ? config.imageBillingGroup : model === config.imageTextModel ? config.imageTextBillingGroup : config.chatBillingGroup;
      if (!group) throw unavailable('该模型的计费分组尚未配置，请联系管理员。');
      const {pricing,status} = await publicPrices(); return openluxRate(pricing,status,model,group);
    },
    async fx() { return (await publicPrices()).status.data.usd_exchange_rate; },
    async fal(model,key) {
      const url = new URL('https://api.fal.ai/v1/models/pricing'); url.searchParams.set('endpoint_id',model);
      const response = await fetchImpl(url,{headers:{Authorization:'Key '+key},redirect:'error',signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw unavailable('备用模型报价无法读取，请联系管理员。');
      const data = await response.json(), rate = data.prices?.find(row=>row.endpoint_id===model);
      if (!rate || rate.currency !== 'USD' || !Number.isFinite(rate.unit_price) || rate.unit_price < 0) throw unavailable('备用模型报价不完整。');
      return {...rate,fx:await this.fx()};
    },
  };
}
