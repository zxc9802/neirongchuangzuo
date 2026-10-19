import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAIHandler } from '../services/ai/server.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';

const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ6kAAAAASUVORK5CYII=';
const config={apiKey:'test',baseUrl:'https://api.openlux.ai/v1',chatModel:'gpt-6-luna',imageModel:'gpt-image-2.5-sunburst-c',imageTextModel:'claude-opus-5-5',
  imageBillingGroup:'Gpt-Image-3',chatBillingGroup:'Codex-Gpt-3',imageTextBillingGroup:'AWS-Bedrock-2',limits:{imageDaily:null,chatDaily:100,perMinute:10000}};
const pricing={data:[{model_name:config.imageModel,quota_type:1,model_price:.16,enable_groups:['Gpt-Image-3']},
  {model_name:config.chatModel,quota_type:0,model_ratio:.05,completion_ratio:5,enable_groups:['Codex-Gpt-3']}],group_ratio:{'Gpt-Image-3':.13787,'Codex-Gpt-3':.07353}};
const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
async function fixture(t,{invalid=false,missingUsage=false,automatic=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'qiya-cost-http-')), credits=createCreditsLedger({storageDir:join(root,'credits'),databaseUrl:null,costMode:true});
  let calls=0;
  const handler=createAIHandler({credits,config:{...config,autoTextBilling:automatic},storageDir:join(root,'ai'),cleanupIntervalMs:0,fetchImpl:async(url,options)=>{
    if(url.endsWith('/api/pricing_new'))return json(automatic?{data:[{...pricing.data[1],enable_groups:['current-group']}],group_ratio:{'current-group':.1}}:pricing);if(url.endsWith('/api/status'))return json({data:{usd_exchange_rate:6.72396,quota_per_unit:500000}});
    if(url.startsWith('https://www.openlux.ai/api/log/token?'))return json({success:true,data:{total:1,items:[{id:1,type:2,quota:17,group:'current-group',other:JSON.stringify({request_id:'automatic-request'})}]}});
    calls++;
    if(automatic){assert.equal(JSON.parse(options.body).stream,true);return new Response('data: '+JSON.stringify({choices:[{delta:{content:'## 方案\n\n**重点**'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream','x-api-request-id':'automatic-request'}});}
    return options.body instanceof FormData ? json({data:[{b64_json:invalid?'bm90LWltYWdl':image}]})
      : json({id:'model-response',choices:[{message:{content:'测试回答'}}],...missingUsage?{}:{usage:{prompt_tokens:1000,completion_tokens:100}}});
  }});
  await Promise.all([credits.ready,handler.ready]);const app=createServer((req,res)=>{req.authenticatedUserId='alice';void handler(req,res);});app.listen(0,'127.0.0.1');await once(app,'listening');
  const base='http://127.0.0.1:'+app.address().port;
  t.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));await handler.shutdown();await credits.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});});
  return {credits,base,calls:()=>calls,post:async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}};
}
const input=()=>({requestId:randomUUID(),prompt:'保持实拍主体',images:[{dataUrl:'data:image/png;base64,'+image}],ratio:'3:4',quality:'high'});
async function waitTask(base,id) {
  for(let i=0;i<100;i++){const r=await fetch(base+'/api/ai/images/'+id),b=await r.json();if(['completed','failed','settling'].includes(b.task?.status))return b.task;await delay(20);}throw Error('Task did not finish');
}
test('actual HTTP image generation bills -3 channel cost rather than 50 points per image',async t=>{
  const f=await fixture(t),body=input();const submitted=await f.post('/api/ai/images',body);assert.equal(submitted.status,202);
  const task=await waitTask(f.base,body.requestId);assert.equal(task.status,'completed');assert.equal(task.billing.chargedPoints,19);assert.equal(task.billing.costCny,.148325);
  assert.equal((await f.credits.snapshot('alice')).available,981);assert.equal(f.calls(),1);
  await f.post('/api/ai/images',body);assert.equal(f.calls(),1);assert.equal((await f.credits.snapshot('alice')).available,981);
});
test('provider expense is still charged when its returned image is unusable',async t=>{
  const f=await fixture(t,{invalid:true}),body=input();await f.post('/api/ai/images',body);const task=await waitTask(f.base,body.requestId);
  assert.equal(task.status,'failed');assert.equal(task.billing.chargedPoints,19);assert.equal((await f.credits.snapshot('alice')).held,0);
});
test('chat costs accumulate across requests instead of rounding each tiny answer to one point',async t=>{
  const f=await fixture(t);
  for(let i=0;i<5;i++){const response=await f.post('/api/ai/chat',{requestId:randomUUID(),messages:[{role:'user',content:'你好'}]});assert.equal(response.status,200);}
  assert.equal((await f.credits.snapshot('alice')).available,999);assert.equal(f.calls(),5);
});
test('missing provider usage keeps the answer behind cost confirmation without another paid call',async t=>{
  const f=await fixture(t,{missingUsage:true}),body={requestId:randomUUID(),messages:[{role:'user',content:'你好'}]};
  const response=await f.post('/api/ai/chat',body);assert.equal(response.status,202);assert.equal(response.data.status,'settling');assert.equal(response.data.text,undefined);
  await f.post('/api/ai/chat',body);assert.equal(f.calls(),1);assert.ok((await f.credits.snapshot('alice')).held>0);
});

test('automatic group chat exposes normal JSON text after SSE parsing and real receipt settlement',async t=>{
  const f=await fixture(t,{automatic:true}),body={requestId:randomUUID(),messages:[{role:'user',content:'排版测试'}]};
  const response=await f.post('/api/ai/chat',body);assert.equal(response.status,200);assert.equal(response.data.text,'## 方案\n\n**重点**');
  const settled=await f.credits.reservation('alice',body.requestId);assert.equal(settled.status,'settled');
  assert.equal(Object.values(settled.costItems)[0].evidence.quota,17);assert.equal(Object.values(settled.costItems)[0].metadata.group,'auto');
  await f.post('/api/ai/chat',body);assert.equal(f.calls(),1);
});
