import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createProviderPrices, tokenCostCny, tokenQuoteCny } from './provider-costs.mjs';
import { readCompletionStream } from '../restaurant/model-stream.mjs';
import { CreditsError } from './store.mjs';

const cleanId = value => typeof value === 'string' && /^[A-Za-z0-9_:@.-]{1,200}$/.test(value) ? value : undefined;
const notReady = () => new CreditsError('该服务的实际费用核对尚未配置，暂未发送付费请求。',503,'COST_PROVIDER_NOT_CONFIGURED');

export function createApiCostMeter({ credits, config = {}, fetchImpl = fetch, prices = createProviderPrices({config,fetchImpl}) } = {}) {
  const context = new AsyncLocalStorage();
  const enabled = credits?.costMode === true;
  async function finish(scope,receiptId,details) {
    const record = await credits.finishCostCall({...scope,receiptId,...details});
    if (record.shortfallPoints) throw new CreditsError('API费用已记录，积分不足，结果等待结算。',402,'INSUFFICIENT_POINTS');
    return record;
  }
  async function pending(scope,id,providerRequestId) { await finish(scope,id,{uncertain:true,...providerRequestId?{providerRequestId}:{}}); }
  return {
    enabled,
    run(scope,operation) { return enabled ? context.run(scope,operation) : operation(); },
    async fetch(url,options = {}) {
      if (!enabled) return fetchImpl(url,options);
      const target = new URL(url), method = options.method || 'GET', scope = context.getStore();
      if (scope?.legacy || scope?.aggregate) return fetchImpl(url,options);
      const openlux = target.hostname === 'api.openlux.ai' && method === 'POST';
      const fal = target.hostname === 'queue.fal.run';
      if (!openlux && !fal) {
        if (method==='POST' && ['api.302.ai','api.302ai.cn','openspeech.bytedance.com'].includes(target.hostname)) throw notReady();
        return fetchImpl(url,options);
      }
      if (!scope) throw Object.assign(notReady(),{providerNotDispatched:true});
      if (fal && method === 'GET') {
        const response = await fetchImpl(url,options);
        const requestId = cleanId(/\/requests\/([^/]+)/.exec(target.pathname)?.[1]);
        if (requestId && !target.pathname.endsWith('/status') && response.ok) {
          const saved = await credits.reservation(scope.userId,scope.taskId);
          const found = Object.entries(saved?.costItems||{}).find(([,item])=>item.providerRequestId===requestId);
          if (found && ['pending','uncertain'].includes(found[1].status)) {
            const units = Number(response.headers.get('x-fal-billable-units'));
            if (response.headers.has('x-fal-billable-units') && Number.isFinite(units) && units>=0) {
              const rate = found[1].metadata;
              if (!rate || !Number.isFinite(rate.unitPrice) || !Number.isFinite(rate.fx)) throw notReady();
              await finish(scope,found[0],{costCny:units*rate.unitPrice*rate.fx,providerRequestId:requestId});
            } else await pending(scope,found[0],requestId);
          }
        }
        return response;
      }
      if (method !== 'POST') return fetchImpl(url,options);
      let body, rate, quoteCny, provider;
      try { if (openlux) {
        body = options.body instanceof FormData ? {model:options.body.get('model')} : JSON.parse(options.body);
        rate = await prices.openlux(body.model); provider = 'openlux';
        quoteCny = rate.type === 'request' ? rate.requestCny : tokenQuoteCny(body,rate);
      } else {
        body = JSON.parse(options.body); provider = 'fal';
        const model = target.pathname.slice(1), key = String(new Headers(options.headers).get('Authorization') || '').replace(/^Key /,'');
        rate = await prices.fal(model,key);
        // This hold is a safety budget, never a settled per-image price.
        quoteCny = Math.max(0.008,(body.num_images || 1)*rate.fx);
      } } catch(error) { error.providerNotDispatched=true; throw error; }
      const receiptId = randomUUID();
      const metadata = provider==='fal' ? {model:target.pathname.slice(1),currency:'USD',unitPrice:rate.unit_price,fx:rate.fx} : {model:rate.modelName,group:rate.group,currency:'CNY',fx:rate.fx};
      try { await credits.prepareCostCall({...scope,receiptId,quoteCny,provider,metadata}); }
      catch(error) { error.providerNotDispatched=true; throw error; }
      let response;
      try { response = await fetchImpl(url,options); }
      catch(error) { await pending(scope,receiptId); throw error; }
      const requestId = cleanId(response.headers.get('x-request-id') || response.headers.get('request-id'));
      if (!response.ok) {
        if ([400,401,402,403,422].includes(response.status)) await finish(scope,receiptId,{costCny:0,...requestId?{providerRequestId:requestId}:{}});
        else await pending(scope,receiptId,requestId);
        return response;
      }
      if (openlux && rate.type==='request') {
        await finish(scope,receiptId,{costCny:rate.requestCny,...requestId?{providerRequestId:requestId}:{}}); return response;
      }
      let payload;
      try {
        payload = response.headers.get('content-type')?.includes('text/event-stream')
          ? await readCompletionStream(response.clone().body) : await response.clone().json();
      } catch(error) { payload=error.providerPayload; }
      if (fal) {
        await pending(scope,receiptId,cleanId(payload?.request_id)); return response;
      }
      try {
        const costCny = tokenCostCny(payload?.usage,rate);
        await finish(scope,receiptId,{costCny,...requestId || cleanId(payload?.id)?{providerRequestId:requestId || cleanId(payload.id)}:{}});
      } catch(error) {
        if (error.code==='COST_USAGE_MISSING') await pending(scope,receiptId,requestId);
        else throw error;
      }
      return response;
    },
  };
}
