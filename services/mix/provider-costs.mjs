import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openluxRate } from '../credits/provider-costs.mjs';
import { CreditsError } from '../credits/store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const pending = () => new CreditsError('模型调用费用尚未确认，已保留原调用，请稍后继续。', 503, 'COST_USAGE_MISSING');
const unavailable = () => new CreditsError('混剪供应商报价暂不可用，尚未发送模型请求。', 503, 'COST_PRICING_UNAVAILABLE');
const scopePattern = /^(job:[a-f0-9]{32}|index:[a-f0-9]{32}:[1-9][0-9]*|browser:[a-f0-9]{32}:[a-f0-9]{64}:(vector|description))$/;
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9_:@.-]{1,200}$/.test(value) ? value : undefined;
const callId = (owner, scope, url, payload, key = '') => hash(owner + '\n' + scope + '\n' + key + '\n' + url + '\n' + JSON.stringify(payload));
const falTtsModel = 'fal-ai/index-tts-2/text-to-speech';
// Historical Qwen receipts may only be queried/settled, never newly dispatched.
const retiredFalModels = ['fal-ai/qwen-3-tts/text-to-speech/1.7b', 'fal-ai/qwen-3-tts/clone-voice/1.7b'];

// Only the private Python worker can call this adapter. Prices and actual charges
// are obtained here; browser bodies never supply a fee, URL credential or owner ID.
export function createMixProviderCosts({ credits, dataDir, env = process.env, fetchImpl = fetch }) {
  const locks = new Map();
  let priceCache, pricePending;
  async function prices() {
    if (priceCache?.until > Date.now()) return priceCache;
    if (!pricePending) pricePending = Promise.all(['pricing_new', 'status'].map(async name => {
      for (const host of ['api.openlux.ai', 'www.openlux.ai']) {
        try {
          const response = await fetchImpl('https://' + host + '/api/' + name, { redirect: 'error', signal: AbortSignal.timeout(30000) });
          if (response.ok) return await response.json();
        } catch { /* Public pricing reads can safely use the provider's other host. */ }
      }
      throw unavailable();
    })).then(([pricing, status]) => {
      const fx = status.data?.usd_exchange_rate, quotaUnit = status.data?.quota_per_unit;
      if (!(fx > 0) || !(quotaUnit > 0) || status.data?.currency_type !== 'USD') throw unavailable();
      return priceCache = { pricing, status, fx, quotaUnit, until: Date.now() + 300000 };
    }).finally(() => { pricePending = null; });
    return pricePending;
  }
  function folder(owner, scope) {
    if (!/^[a-f0-9]{64}$/.test(owner || '') || !scopePattern.test(scope || '')) throw new CreditsError('混剪费用任务标识无效。');
    return join(dataDir, 'cost-calls', owner, hash(scope));
  }
  async function save(path, record) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
  }
  async function serialized(id, operation) {
    const previous = locks.get(id) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    locks.set(id, result);
    try { return await result; } finally { if (locks.get(id) === result) locks.delete(id); }
  }
  function target(url, payload) {
    if ([falTtsModel, ...retiredFalModels].some(model => url === 'https://queue.fal.run/' + model)) {
      if (!env.MIX_FAL_KEY) throw unavailable();
      const model = url.slice('https://queue.fal.run/'.length);
      return { provider: 'fal', model, retired: model !== falTtsModel, key: env.MIX_FAL_KEY, asynchronous: true };
    }
    const embedding = (env.EMBEDDING_URL || 'https://api.openlux.ai/v1beta/models/gemini-embedding-2-preview:generateContent').replace(/:generateContent$/, ':embedContent');
    const llm = env.LLM_URL || 'https://api.openlux.ai/v1beta/models/gemini-3.7-flash:generateContent';
    const rerank = env.RERANK_URL || 'https://api.302.ai/v1/reranks';
    const tts = (env.INDEXTTS_BASE_URL || env.TTS_BASE_URL || 'https://api.302.ai').replace(/\/$/, '') + '/302/index_tts2/task';
    if (![embedding, llm, rerank, tts].includes(url)) throw new CreditsError('混剪模型地址不在服务端配置中。');
    const host = new URL(url).hostname;
    const provider = host === 'api.openlux.ai' ? 'openlux' : ['api.302.ai', 'api.302ai.cn'].includes(host) ? '302' : null;
    if (!provider) throw unavailable();
    const model = url === tts ? 'index-tts2' : /\/models\/([^/:]+):/.exec(url)?.[1] || payload.model;
    if (url === rerank && model !== 'qwen3-rerank') throw unavailable();
    const key = url === tts ? env.INDEXTTS_302_API_KEY || env.TTS_API_KEY : url === rerank ? env.RERANK_API_KEY : env.OPENLUX_API_KEY;
    if (!key) throw unavailable();
    return { provider, model, key, asynchronous: url === tts };
  }
  async function quote(spec, payload) {
    const catalog = await prices();
    if (spec.provider === 'fal') {
      const url = new URL('https://api.fal.ai/v1/models/pricing'); url.searchParams.set('endpoint_id', spec.model);
      const response = await fetchImpl(url, { headers: { Authorization: 'Key ' + spec.key }, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw unavailable();
      const rate = (await response.json()).prices?.find(item => item.endpoint_id === spec.model);
      if (!rate || rate.currency !== 'USD' || !Number.isFinite(rate.unit_price) || rate.unit_price < 0
        || rate.unit !== 'seconds') throw unavailable();
      // Safety hold for speech duration, never a settled estimate. IndexTTS's
      // result header supplies the actual generated audio seconds.
      const units = Math.max(10, [...String(payload.prompt || '')].length);
      return { quoteCny: rate.unit_price * units * catalog.fx, unitPrice: rate.unit_price, fx: catalog.fx };
    }
    if (spec.provider === '302') {
      // Safety holds, never settled prices. 302's actual API record is the receipt.
      return { quoteCny: (spec.asynchronous ? 0.1 : 0.01) * catalog.fx, fx: catalog.fx, quotaUnit: catalog.quotaUnit };
    }
    const model = catalog.pricing.data?.find(row => row.model_name === spec.model);
    const rates = (model?.enable_groups || []).map(group => openluxRate(catalog.pricing, catalog.status, spec.model, group));
    if (!rates.length) throw unavailable();
    // Auto-routing can choose different billing groups for different calls. Hold
    // against the highest published rate; settle only the matched actual bill.
    const bytes = Buffer.byteLength(JSON.stringify(payload)), output = payload.generationConfig?.maxOutputTokens || 8192;
    const upper = Math.max(...rates.map(rate => rate.type === 'request' ? rate.requestCny
      : ((bytes + 1024) * rate.inputCnyMillion + output * rate.outputCnyMillion) / 1e6));
    return { quoteCny: Math.max(0.008, upper), fx: catalog.fx, quotaUnit: catalog.quotaUnit };
  }
  async function actual(record, spec) {
    if (record.httpStatus >= 400 && [400, 401, 402, 403, 404, 422].includes(record.httpStatus)) return 0;
    if (record.provider === 'fal') {
      if (!Number.isFinite(record.billableUnits) || record.billableUnits < 0) throw pending();
      return record.billableUnits * record.unitPrice * record.fx;
    }
    if (record.provider === 'openlux' && Number.isSafeInteger(record.response?.quota) && record.response.quota >= 0)
      return record.response.quota / record.quotaUnit * record.fx;
    if (!record.requestId && !record.taskId) throw pending();
    for (let page = 1; page <= 10; page++) {
      const url = new URL(record.provider === 'openlux' ? 'https://api.openlux.ai/api/log/token' : new URL('/dashboard/api-record', record.url));
      if (record.provider === 'openlux') {
        // This provider's token-log API requires key in the query, even with Bearer.
        // Never persist the URL or return upstream errors containing it.
        url.searchParams.set('key', spec.key);
        url.searchParams.set('start_timestamp', String(Math.floor(record.started / 1000) - 5));
        url.searchParams.set('page_size', '100');
      } else {
        url.searchParams.set('start_time', String(Math.floor(record.started / 1000) - 5));
        url.searchParams.set('limit', '100');
      }
      url.searchParams.set('page', String(page));
      const response = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + spec.key }, redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw pending();
      const data = await response.json(), items = record.provider === 'openlux' ? data.data?.items : data.items;
      if (!Array.isArray(items)) throw pending();
      const found = items.find(item => {
        let other = {};
        try { other = typeof item.other === 'string' ? JSON.parse(item.other) : item.other || {}; } catch { /* Missing evidence cannot match. */ }
        return [item.request_id, item.task_id, other.request_id].some(id => id && [record.requestId, record.taskId].includes(id));
      });
      if (found) {
        if (record.provider === 'openlux' && (found.type === 2 || record.httpStatus >= 400 && found.type === 5 && found.quota === 0)
          && found.model_name === record.model && Number.isSafeInteger(found.quota) && found.quota >= 0)
          return found.quota / record.quotaUnit * record.fx;
        if (record.provider === '302' && typeof found.cost === 'number' && Number.isFinite(found.cost) && found.cost >= 0
          && (!found.currency || ['USD', 'PTC'].includes(found.currency))) return found.cost * record.fx;
        throw pending();
      }
      if (items.length < 100) break;
    }
    throw pending();
  }
  async function falResult(path, record, spec) {
    if (!record.taskId || record.httpStatus >= 400) throw pending();
    if (record.result !== undefined && (record.settled || Number.isFinite(record.billableUnits))) return;
    // Queue receipts omit the endpoint subpath. Construct reads locally; never
    // send credentials to URLs supplied by an upstream response or a browser.
    const base = 'https://queue.fal.run/' + spec.model.split('/').slice(0, 2).join('/') + '/requests/' + record.taskId;
    const options = { headers: { Authorization: 'Key ' + spec.key }, redirect: 'error', signal: AbortSignal.timeout(30000) };
    const status = await fetchImpl(base + '/status', options);
    if (!status.ok) throw pending();
    const data = await status.json();
    if (!['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'].includes(data.status) || data.request_id !== record.taskId) throw pending();
    record.queueStatus = data.status;
    await save(path, record);
    if (data.status !== 'COMPLETED') return;
    const result = await fetchImpl(base, options);
    if (result.headers.get('x-fal-request-id') !== record.taskId) throw pending();
    const rawUnits = result.headers.get('x-fal-billable-units');
    if (rawUnits !== null && rawUnits.trim() && Number.isFinite(Number(rawUnits)) && Number(rawUnits) >= 0) record.billableUnits = Number(rawUnits);
    record.resultStatus = result.status;
    record.result = await result.json();
    await save(path, record);
  }
  async function reconcile(userId, path, record, spec) {
    const scope = { userId, taskId: record.creditId };
    let saved = await credits.reservation(userId, record.creditId);
    if (saved?.status === 'settled') {
      record.chargedPoints = saved.chargedPoints; record.costMicros = saved.settledUnits; record.settled = true;
      await save(path, record);
      return saved;
    }
    if (record.dispatched && record.response === undefined) throw pending();
    let costCny = record.actualCny;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { if (costCny === undefined) costCny = await actual(record, spec); break; }
      catch { if (attempt === 2) throw pending(); await delay(250 * 2 ** attempt); }
    }
    record.actualCny = costCny;
    await save(path, record);
    saved = await credits.finishCostCall({ ...scope, receiptId: 'provider', costCny, ...(record.requestId ? { providerRequestId: record.requestId } : {}) });
    saved = await credits.settleCost(scope);
    record.chargedPoints = saved.chargedPoints; record.costMicros = saved.settledUnits; record.settled = true;
    await save(path, record);
    return saved;
  }
  return {
    async request(userId, owner, scope, url, payload, callKey = '') {
      const directory = folder(owner, scope), spec = target(url, payload);
      if (callKey && !requestId(callKey)) throw new CreditsError('模型调用标识无效。');
      const id = callId(owner, scope, url, payload, callKey);
      return serialized(id, async () => {
        await mkdir(directory, { recursive: true });
        const path = join(directory, id + '.json');
        let record;
        try { record = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        let attempt = record?.attempt || 1;
        const discarded = record?.invalidated ? record : null;
        const previous = record && !record.dispatched ? await credits.reservation(userId, record.creditId) : null;
        if (discarded || previous?.status === 'settled' || record?.settled && record.httpStatus >= 400 && record.costMicros === 0) { attempt++; record = null; }
        if (!record) {
          if (spec.retired) throw new CreditsError('Qwen 配音已停用，请新建 IndexTTS 混剪任务。', 409, 'MIX_TTS_RETIRED');
          const rate = await quote(spec, payload);
          if (discarded) await save(join(directory, hash(discarded.creditId) + '.json'), discarded);
          record = { creditId: 'mix-call:' + id + ':' + attempt, attempt, provider: spec.provider, model: spec.model, url, started: Date.now(), ...rate };
          await save(path, record);
        }
        if (!record.dispatched) {
          if (spec.retired) throw new CreditsError('Qwen 配音已停用，请新建 IndexTTS 混剪任务。', 409, 'MIX_TTS_RETIRED');
          await credits.reserveCost({ userId, taskId: record.creditId });
          await credits.prepareCostCall({ userId, taskId: record.creditId, receiptId: 'provider', quoteCny: record.quoteCny,
            provider: record.provider, metadata: { model: record.model, currency: 'USD', fx: record.fx } });
          record.dispatched = true;
          await save(path, record); // Crash/timeout after this point must never POST again.
          try {
            const response = await fetchImpl(url, { method: 'POST', headers: { Authorization: (spec.provider === 'fal' ? 'Key ' : 'Bearer ') + spec.key, 'Content-Type': 'application/json' },
              body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(210000) });
            record.httpStatus = response.status;
            record.requestId = requestId(response.headers.get('x-api-request-id') || response.headers.get('x-request-id') || response.headers.get('request-id'));
            await save(path, record);
            record.response = await response.json();
          } catch { throw pending(); }
          record.taskId = requestId(record.response?.task_id || record.response?.request_id);
          await save(path, record);
        }
        if (record.response === undefined) throw pending();
        if (spec.provider === 'fal' && record.httpStatus < 400) {
          await falResult(path, record, spec);
          if (record.queueStatus === 'COMPLETED') await reconcile(userId, path, record, spec);
          return { request_id: record.taskId, status: record.queueStatus, ...(record.result !== undefined
            ? { result: record.result, result_status: record.resultStatus } : {}) };
        }
        if (!spec.asynchronous || record.httpStatus >= 400) await reconcile(userId, path, record, spec);
        if (record.httpStatus >= 400) throw new CreditsError('混剪模型请求失败 HTTP ' + record.httpStatus, record.httpStatus,
          record.actualCny === 0 ? 'MIX_PROVIDER_REJECTED' : 'MIX_PROVIDER_FAILED');
        return record.response;
      });
    },
    async reject(userId, owner, scope, url, payload) {
      const directory = folder(owner, scope), id = callId(owner, scope, url, payload);
      target(url, payload);
      await serialized(id, async () => {
        const path = join(directory, id + '.json'), record = JSON.parse(await readFile(path, 'utf8'));
        const saved = await credits.reservation(userId, record.creditId);
        if (saved?.status !== 'settled') throw pending();
        record.invalidated = true;
        await save(path, record);
      });
      return { invalidated: true };
    },
    async close(userId, owner, scope) {
      const directory = folder(owner, scope);
      let names;
      try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return { chargedPoints: 0, costMicros: 0 }; throw error; }
      let chargedPoints = 0, costMicros = 0;
      const seen = new Set();
      for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
        await serialized(name.slice(0, -5), async () => {
          const path = join(directory, name), record = JSON.parse(await readFile(path, 'utf8'));
          if (seen.has(record.creditId)) return;
          seen.add(record.creditId);
          if (!record.dispatched) {
            const saved = await credits.reservation(userId, record.creditId);
            if (saved?.status === 'reserved') {
              if (saved.costItems.provider) await credits.finishCostCall({ userId, taskId: record.creditId, receiptId: 'provider', costCny: 0 });
              await credits.settleCost({ userId, taskId: record.creditId });
            }
            return;
          }
          const spec = target(record.url, { model: record.model });
          if (record.provider === 'fal' && record.httpStatus < 400) {
            await falResult(path, record, spec);
            if (record.queueStatus !== 'COMPLETED') throw pending();
          }
          const saved = await reconcile(userId, path, record, spec);
          chargedPoints += saved.chargedPoints; costMicros += saved.settledUnits;
        });
      }
      return { chargedPoints, costMicros };
    },
  };
}
