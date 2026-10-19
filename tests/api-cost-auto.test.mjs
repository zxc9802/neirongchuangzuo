import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCreditsLedger } from '../services/credits/store.mjs';
import { createProviderPrices } from '../services/credits/provider-costs.mjs';
import { createApiCostMeter } from '../services/credits/meter.mjs';
import { readCompletionStream } from '../services/restaurant/model-stream.mjs';

const json = data => new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}});
const card = {type:'receipt',modelName:'gpt-6-luna',group:'auto',fx:7,unitPrice:7/500000,quoteCny:.1};
const config = {apiKey:'sk-test-secret',autoTextBilling:true,chatBillingGroup:'retired-group'};
const scope = {userId:'alice',taskId:'automatic-text'};
const body = JSON.stringify({model:'gpt-6-luna',messages:[{role:'user',content:'测试'}],max_completion_tokens:128});
const stream = 'data: '+JSON.stringify({choices:[{delta:{content:'## 方案'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
async function wallet(t) {
  const dir=await mkdtemp(join(tmpdir(),'qiya-auto-cost-'));const credits=createCreditsLedger({storageDir:dir,databaseUrl:null,costMode:true});
  await credits.ready;await credits.reserveCost(scope);t.after(async()=>{await credits.close();await rm(dir,{recursive:true,force:true});});return credits;
}
test('automatic text uses supplier request IDs and actual quotas across changing groups',async t=>{
  const credits=await wallet(t);let calls=0;
  const meter=createApiCostMeter({credits,config,sleep:async()=>{},prices:{openluxAuto:async()=>card,openluxReceipt:async id=>({quota:id==='api-1'?250:500,logIds:[id==='api-1'?1:2],groups:[id==='api-1'?'Azure-Gpt-3':'Openai-Gpt-1']})},fetchImpl:async(url,options)=>{
    const sent=JSON.parse(options.body);assert.equal(sent.stream,true);assert.equal(sent.stream_options.include_usage,true);
    calls++;return new Response(stream,{headers:{'Content-Type':'text/event-stream','x-api-request-id':`api-${calls}`,'x-request-id':'unrelated-upstream'}});
  }});
  for(let i=0;i<2;i++) {
    const response=await meter.run(scope,()=>meter.fetch('https://api.openlux.ai/v1/chat/completions',{method:'POST',body}));
    assert.equal((await readCompletionStream(response.body)).choices[0].message.content,'## 方案');
  }
  const done=await credits.settleCost(scope),items=Object.values(done.costItems);
  assert.equal(done.settledUnits,10500);assert.equal(done.chargedPoints,2);assert.equal(items[0].metadata.group,'auto');
  assert.equal(items[0].evidence.groups,'Azure-Gpt-3');assert.equal(items[1].evidence.groups,'Openai-Gpt-1');
  assert.equal(items[0].providerRequestId,'api-1');assert.equal(calls,2);
});
test('late consumption records reconcile once without repeating a paid request',async t=>{
  const credits=await wallet(t);let available=false,calls=0;
  const meter=createApiCostMeter({credits,config,sleep:async()=>{},prices:{openluxAuto:async()=>card,openluxReceipt:async()=>available?{quota:1000,logIds:[123],groups:['Openai-Gpt-1']}:null},fetchImpl:async()=>{calls++;return new Response(stream,{headers:{'Content-Type':'text/event-stream','x-api-request-id':'late'}});}});
  await meter.run(scope,()=>meter.fetch('https://api.openlux.ai/v1/chat/completions',{method:'POST',body}));
  await assert.rejects(credits.settleCost(scope),{code:'COST_CONFIRMATION_PENDING'});assert.ok((await credits.snapshot('alice')).held>0);
  available=true;await meter.reconcile(scope);await meter.reconcile(scope);
  const result=await credits.settleCost(scope);assert.equal(result.settledUnits,14000);assert.equal(calls,1);assert.equal(Object.values(result.costItems)[0].evidence.logIds,'123');
});
test('no exact receipt means no guessed cost from tokens, routing family or unrelated records',async t=>{
  const credits=await wallet(t);
  // A provider may ignore stream=true; keep its response but never infer its charged group.
  const heldMeter=createApiCostMeter({credits,config,sleep:async()=>{},prices:{openluxAuto:async()=>card,openluxReceipt:async id=>{assert.equal(id,'missing');return null;}},fetchImpl:async()=>new Response(JSON.stringify({id:'unrelated-body-id',usage:{prompt_tokens:1000,completion_tokens:100}}),{headers:{'Content-Type':'application/json','x-api-request-id':'missing','x-routing-group':'openai'}})});
  await heldMeter.run(scope,()=>heldMeter.fetch('https://api.openlux.ai/v1/chat/completions',{method:'POST',body}));
  await assert.rejects(credits.settleCost(scope),{code:'COST_CONFIRMATION_PENDING'});
  assert.equal(Object.values((await credits.reservation(scope.userId,scope.taskId)).costItems)[0].costMicros,0);
});
test('automatic preflight uses the highest current tariff only as a refundable budget',async()=>{
  const prices=createProviderPrices({config,fetchImpl:async url=>url.endsWith('/api/pricing_new')?json({data:[{model_name:'gpt-6-luna',quota_type:0,model_ratio:2,completion_ratio:5,enable_groups:['cheap','expensive']}],group_ratio:{cheap:.1,expensive:.5}}):json({data:{usd_exchange_rate:7,quota_per_unit:500000}})});
  const quote=await prices.openluxAuto({model:'gpt-6-luna',messages:[],max_tokens:1000});
  assert.equal(quote.group,'auto');assert.ok(Math.abs(quote.quoteCny-.070028)<1e-10);assert.equal(quote.unitPrice,7/500000);
});
test('receipt lookup pages the bounded time window and matches exact IDs, never token counts',async()=>{
  const pages=[];const prices=createProviderPrices({config,fetchImpl:async raw=>{
    const url=new URL(raw);assert.equal(url.origin,'https://www.openlux.ai');assert.equal(url.searchParams.get('key'),'test-secret');
    assert.equal(url.searchParams.get('start_timestamp'),'995');assert.equal(url.searchParams.get('end_timestamp'),'1020');
    const page=Number(url.searchParams.get('page'));pages.push(page);
    const row=(id,request_id,quota=1,type=2)=>({id,type,quota,group:'automatic-group',other:JSON.stringify({request_id})});
    return json({success:true,data:{total:101,items:page===1?Array.from({length:100},(_,i)=>row(i+1,'different')):[row(101,'exact',57)]}});
  }});
  const receipt=await prices.openluxReceipt('exact',1000000,1010000);assert.equal(receipt.quota,57);assert.deepEqual(pages,[1,2]);
  assert.equal(await prices.openluxReceipt('not-exact',1000000,1010000),null);
});
