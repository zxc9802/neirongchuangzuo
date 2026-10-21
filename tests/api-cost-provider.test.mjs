import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createCreditsLedger } from '../services/credits/store.mjs';
import { createProviderPrices,openluxRate,tokenCostCny } from '../services/credits/provider-costs.mjs';
import { createApiCostMeter } from '../services/credits/meter.mjs';

const card={type:'tokens',inputCnyMillion:20,outputCnyMillion:100,cacheRatio:.05,write5Ratio:1.25,write1hRatio:2,modelName:'claude',group:'AWS-Bedrock-2',fx:6.724};
const reply=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
async function ledger(t){const root=await mkdtemp(join(tmpdir(),'qiya-cost-provider-'));const x=createCreditsLedger({storageDir:root,databaseUrl:null,costMode:true});await x.ready;t.after(async()=>{await x.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});});return x;}

test('token cost distinguishes cache hits, five minute writes and one hour writes',()=>{
  const usage={prompt_tokens:1000,completion_tokens:100,prompt_tokens_details:{cached_tokens:200,cache_write_tokens:300},claude_cache_creation_1_h_tokens:100,claude_cache_creation_5_m_tokens:200};
  assert.ok(Math.abs(tokenCostCny(usage,card)-.0292)<1e-12);
  assert.throws(()=>tokenCostCny({},card),{code:'COST_USAGE_MISSING'});
  assert.throws(()=>tokenCostCny({prompt_tokens:1,completion_tokens:0,prompt_tokens_details:{cached_tokens:2}},card));
});
test('a missing or wrong group never silently uses the cheapest public channel',()=>{
  const pricing={data:[{model_name:'image',quota_type:1,model_price:.16,enable_groups:['Gpt-Image-3']}],group_ratio:{'Gpt-Image-3':.13787}};
  const rate=openluxRate(pricing,{data:{usd_exchange_rate:6.72396}},'image','Gpt-Image-3');
  assert.ok(Math.abs(rate.requestCny-.148325178432)<1e-12);
  assert.throws(()=>openluxRate(pricing,{data:{usd_exchange_rate:6.72396}},'image','Gpt-Image-1'));
});
test('Claude text costs use the confirmed Bedrock group and retain the billed group in the receipt',async t=>{
  const x=await ledger(t),scope={userId:'alice',taskId:'bedrock-task'};await x.reserveCost(scope);
  const config={imageModel:'gpt-image-2.5-sunburst-c',imageTextModel:'claude-opus-5-5',chatModel:'gpt-6-luna',
    imageBillingGroup:'Gpt-Image-3',imageTextBillingGroup:'AWS-Bedrock-2',chatBillingGroup:'Codex-Gpt-3'};
  const pricing={data:[{model_name:config.imageTextModel,quota_type:0,model_ratio:2,completion_ratio:5,cache_ratio:.05,
    enable_groups:['AWS-Bedrock-2','AWS-Claude-3']}],group_ratio:{'AWS-Bedrock-2':.58824,'AWS-Claude-3':1.1}};
  const fetchImpl=async url=>url.endsWith('/api/pricing_new')?reply(pricing):url.endsWith('/api/status')?reply({data:{usd_exchange_rate:6.72396}})
    :reply({id:'bedrock-response',choices:[{message:{content:'{}'}}],usage:{prompt_tokens:100000,completion_tokens:10000}});
  const prices=createProviderPrices({config,fetchImpl}),rate=await prices.openlux(config.imageTextModel);
  assert.equal(rate.group,'AWS-Bedrock-2');assert.ok(Math.abs(rate.inputCnyMillion-4*.58824*6.72396)<1e-12);
  const meter=createApiCostMeter({credits:x,config,prices,fetchImpl});
  await meter.run(scope,()=>meter.fetch('https://api.openlux.ai/v1/chat/completions',{method:'POST',body:JSON.stringify({model:config.imageTextModel,messages:[],max_tokens:20000})}));
  const record=await x.settleCost(scope),items=Object.values(record.costItems);
  assert.equal(items.length,1);assert.equal(items[0].metadata.group,'AWS-Bedrock-2');
  assert.equal(record.settledUnits,Math.round(rate.inputCnyMillion*.15*1e6));
  assert.equal(record.chargedPoints,Math.ceil(record.settledUnits/8000));
});
test('all task calls including a malformed model answer contribute their real usage once',async t=>{
  const x=await ledger(t),scope={userId:'alice',taskId:'task'};await x.reserveCost(scope);
  const meter=createApiCostMeter({credits:x,prices:{openlux:async()=>card},fetchImpl:async()=>reply({id:'provider',choices:[{message:{content:'not json'}}],usage:{prompt_tokens:1000,completion_tokens:100}})});
  for(let i=0;i<2;i++)await meter.run(scope,()=>meter.fetch('https://api.openlux.ai/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'claude',messages:[{role:'user',content:'hi'}],max_tokens:1000})}));
  const done=await x.settleCost(scope);assert.equal(done.settledUnits,60000);assert.equal(done.chargedPoints,8);
});
test('SSE usage is billed before returning an unchanged response for model parsing',async t=>{
  const x=await ledger(t),scope={userId:'alice',taskId:'task'};await x.reserveCost(scope);
  const stream='data: '+JSON.stringify({id:'provider',choices:[{delta:{content:'{}'},finish_reason:'stop'}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:1000,completion_tokens:100}})+'\n\ndata: [DONE]\n\n';
  const meter=createApiCostMeter({credits:x,prices:{openlux:async()=>card},fetchImpl:async()=>new Response(stream,{headers:{'Content-Type':'text/event-stream'}})});
  const response=await meter.run(scope,()=>meter.fetch('https://api.openlux.ai/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'claude',messages:[],max_tokens:1000})}));
  assert.equal(await response.text(),stream);assert.equal((await x.settleCost(scope)).chargedPoints,4);
});
test('missing usage freezes its quote and cannot be claimed as a free API call',async t=>{
  const x=await ledger(t),scope={userId:'alice',taskId:'task'};await x.reserveCost(scope);
  const meter=createApiCostMeter({credits:x,prices:{openlux:async()=>card},fetchImpl:async()=>reply({choices:[]})});
  await meter.run(scope,()=>meter.fetch('https://api.openlux.ai/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'claude',messages:[],max_tokens:1000})}));
  await assert.rejects(x.settleCost(scope),{code:'COST_CONFIRMATION_PENDING'});
  assert.ok((await x.snapshot('alice')).held>0);
});
test('insufficient reservation stops a paid call before dispatch',async t=>{
  const x=await ledger(t),scope={userId:'alice',taskId:'task'};await x.reserveCost(scope);let calls=0;
  const meter=createApiCostMeter({credits:x,prices:{openlux:async()=>({...card,type:'request',requestCny:9})},fetchImpl:async()=>{calls++;return reply({});}});
  const form=new FormData();form.set('model','image');
  await assert.rejects(meter.run(scope,()=>meter.fetch('https://api.openlux.ai/v1/images/edits',{method:'POST',body:form})),{code:'INSUFFICIENT_POINTS',providerNotDispatched:true});
  assert.equal(calls,0);assert.equal((await x.settleCost(scope)).chargedPoints,0);
});
test('fal final units use the exact submitted endpoint tariff, including queue parent paths',async t=>{
  const x=await ledger(t),scope={userId:'alice',taskId:'task'};await x.reserveCost(scope);
  const meter=createApiCostMeter({credits:x,prices:{fal:async()=>({unit_price:1,fx:6.724})},fetchImpl:async url=>url.includes('/requests/')?new Response('{}',{headers:{'x-fal-billable-units':'.04'}}):reply({request_id:'fal-request'})});
  await meter.run(scope,()=>meter.fetch('https://queue.fal.run/openai/gpt-image-2.5/sunburst/edit',{method:'POST',headers:{Authorization:'Key test'},body:'{"num_images":1}'}));
  await meter.run(scope,()=>meter.fetch('https://queue.fal.run/openai/gpt-image-2.5/requests/fal-request'));
  const done=await x.settleCost(scope);assert.equal(done.settledUnits,268960);assert.equal(done.chargedPoints,34);
});

test('fal OpenRouter translation bills fractional units once, not one cent per request',async t=>{
  const x=await ledger(t),scope={userId:'alice',taskId:'translation'};await x.reserveCost(scope);
  const meter=createApiCostMeter({credits:x,prices:{fal:async model=>{
    assert.equal(model,'openrouter/router');return {unit_price:.01,fx:6.718};
  }},fetchImpl:async url=>url.includes('/requests/')?new Response('{"output":"{}"}',{headers:{'x-fal-billable-units':'0.00232000'}}):reply({request_id:'translation-request'})});
  await meter.run(scope,()=>meter.fetch('https://queue.fal.run/openrouter/router',{method:'POST',headers:{Authorization:'Key test'},body:'{"model":"openai/gpt-6-luna","prompt":"Translate"}'}));
  for(let i=0;i<2;i++)await meter.run(scope,()=>meter.fetch('https://queue.fal.run/openrouter/router/requests/translation-request'));
  const done=await x.settleCost(scope);assert.equal(done.settledUnits,Math.round(.0000232*6.718*1e6));
  assert.equal(Object.keys(done.costItems).length,1);
});
