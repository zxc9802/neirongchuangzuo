import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCreditsLedger } from '../services/credits/store.mjs';
import { createApiCostMeter } from '../services/credits/meter.mjs';
import { arkRate, tokenCostCny } from '../services/credits/provider-costs.mjs';
import { loadArkApiKey } from '../services/runtime-settings.mjs';

const model='doubao-seed-2-1-pro-260915',url='https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const scope={userId:'alice',taskId:'ark-director'};
const body=JSON.stringify({model,max_completion_tokens:65536,messages:[{role:'user',content:'真实产品分镜'}]});
async function ledger(t) {
  const root=await mkdtemp(join(tmpdir(),'ark-cost-')),credits=createCreditsLedger({storageDir:root,databaseUrl:null,costMode:true});
  await credits.ready;await credits.reserveCost(scope);
  t.after(async()=>{await credits.close();await rm(root,{recursive:true,force:true});});return credits;
}

test('Ark credentials prefer deployment environment and survive updates in private persistent storage',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ark-private-'));t.after(()=>rm(root,{recursive:true,force:true}));
  assert.equal(loadArkApiKey({},root),'');
  const folder=join(root,'data','.secrets');await mkdir(folder,{recursive:true});await writeFile(join(folder,'ark-api-key'),'private-fixture-key\n');
  assert.equal(loadArkApiKey({WORKSPACE_DATA_DIR:'data'},root),'private-fixture-key');
  assert.equal(loadArkApiKey({WORKSPACE_DATA_DIR:'data',ARK_API_KEY:'environment-fixture'},root),'environment-fixture');
});

test('Ark bills observed cached input and reasoning-inclusive output once',async t=>{
  const credits=await ledger(t);let calls=0;
  const usage={prompt_tokens:1000,completion_tokens:100,prompt_tokens_details:{cached_tokens:200},completion_tokens_details:{reasoning_tokens:60}};
  assert.equal(tokenCostCny(usage,arkRate(model)),.00804);
  assert.throws(()=>arkRate('unpriced-model'),{code:'COST_PRICING_UNAVAILABLE'});
  const meter=createApiCostMeter({credits,fetchImpl:async()=>{
    calls++;return new Response('data: '+JSON.stringify({choices:[{delta:{content:'{}'},finish_reason:'stop'}]})+'\n\ndata: '+JSON.stringify({choices:[],usage})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream','x-request-id':'ark-request-1'}});
  }});
  await meter.run(scope,()=>meter.fetch(url,{method:'POST',body}));
  const done=await credits.settleCost(scope),items=Object.values(done.costItems);
  assert.equal(calls,1);assert.equal(items.length,1);assert.equal(items[0].provider,'ark');
  assert.equal(items[0].providerRequestId,'ark-request-1');assert.equal(items[0].metadata.model,model);
  assert.equal(done.settledUnits,8040);
});

test('Ark missing usage remains uncertain rather than recording a free call',async t=>{
  const credits=await ledger(t),meter=createApiCostMeter({credits,fetchImpl:async()=>Response.json({id:'ark-no-usage',choices:[]})});
  await meter.run(scope,()=>meter.fetch(url,{method:'POST',body}));
  const saved=await credits.reservation(scope.userId,scope.taskId);
  assert.equal(Object.values(saved.costItems)[0].status,'uncertain');
});
