import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { canUseAiSales, SALES_SETTINGS } from '../design/ai-sales-policy.js';
import { assertSalesMaterials, assertSalesPlan } from '../services/video-creator/sales.mjs';
import { createVideoCreatorHandler } from '../services/video-creator/server.mjs';
import { validateDirectorResult } from '../services/video-creator/model.mjs';
import { createPreviewServer } from '../preview.mjs';

const assets=[{id:'actor',type:'image',purpose:'character'},{id:'food',type:'image',purpose:'reference'},{id:'voice',type:'audio',purpose:'voice'}];
const plan={objective:'展示实拍产品',audience:'附近顾客',perspective:'角色演示',storyArc:'人物介绍、产品展示、邀请到店',visualStyle:'自然明亮',cast:[{name:'主持人',role:'展示产品',appearance:'按人物照片',referenceIds:['actor']}],audio:{voiceDirection:'参考上传音色',music:'轻柔',ambience:'环境声'},keep:['实拍产品'],avoid:['虚构价格']};
const shots=Array.from({length:3},(_,i)=>({start:i*10,end:(i+1)*10,referenceIds:['actor','food'],visual:'人物正面在实拍场景展示产品',action:'人物指向产品并面对镜头讲话',voiceover:'看看这款产品',caption:''}));
test('only verified exact accounts have sales access, not nickname, phone or admin-looking roles',()=>{
  for(const account of ['义鹏','admin'])assert.equal(canUseAiSales({id:'user',account}),true);
  for(const user of [null,{account:'admin'},{id:'other',account:'other',nickname:'义鹏',role:'admin'},{id:'x',account:'毛义鹏'},{id:'x',account:'18257218250'}])assert.equal(canUseAiSales(user),false);
});
test('sales requires character, voice and real materials; validates on-screen plan before provider submission',()=>{
  assert.doesNotThrow(()=>assertSalesMaterials(assets,SALES_SETTINGS));
  for(const a of assets)assert.throws(()=>assertSalesMaterials(assets.filter(x=>x!==a),SALES_SETTINGS),e=>e.code==='SALES_MATERIALS_REQUIRED');
  assert.throws(()=>assertSalesMaterials(assets,{generateAudio:false}),e=>e.code==='SALES_AUDIO_REQUIRED');
  assert.doesNotThrow(()=>assertSalesPlan(shots,plan,assets));
  for(const i of [0,1,2]){const next=structuredClone(shots);next[i].referenceIds=['food'];assert.throws(()=>assertSalesPlan(next,plan,assets),e=>e.outputIssue==='invalid_schema');}
  assert.throws(()=>assertSalesPlan(shots,{cast:[]},assets));
  const input={skill:'ai-sales',settings:SALES_SETTINGS,assets};
  const output={kind:'script',script:{title:'产品介绍',plan,shots},assets:assets.map(a=>({id:a.id,description:'参考素材',role:'参考用途',adopt:'保留素材特征'}))};
  const result=validateDirectorResult(output,input);
  assert.deepEqual(result.script.referenceImageIds,['actor','food']);
  assert.match(result.script.videoPrompt,/声音参考1/);
  assert.doesNotThrow(()=>validateDirectorResult(output,{...input,fixedNarration:'看看这款产品！看看这款产品。看看这款产品'}));
  assert.throws(()=>validateDirectorResult(output,{...input,fixedNarration:'不能修改我的定稿'}),e=>e.code==='DIRECTOR_INVALID_OUTPUT');
  const missing=structuredClone(output);missing.script.shots[1].referenceIds=['food'];
  assert.throws(()=>validateDirectorResult(missing,input),e=>e.code==='DIRECTOR_INVALID_OUTPUT');
  assert.doesNotThrow(()=>validateDirectorResult(missing,{...input,skill:'store-discovery'}));
});
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
test('server uses authenticated account, never forged permission headers',async t=>{
  const backend=createServer((req,res)=>{res.setHeader('Content-Type','application/json');const account=req.headers.cookie?.split('=')[1];res.end(JSON.stringify({success:true,data:{authMode:'standalone',user:{id:'u-'+account,account,nickname:'义鹏'}}}));});
  const stub=async(req,res)=>res.end(JSON.stringify({allowed:req.aiSalesAllowed}));stub.shutdown=async()=>{};
  const server=createPreviewServer({backendUrl:await listen(backend),authRequired:true,credits:{ready:Promise.resolve()},createVideoCreator:()=>stub});const base=await listen(server);
  t.after(async()=>{await server.shutdown();backend.closeAllConnections();await new Promise(r=>backend.close(r));});
  for(const account of ['admin','ordinary']){const res=await fetch(base+'/api/video-creator/config',{headers:{cookie:'account='+account,'x-ai-sales-allowed':'true'}});assert.equal((await res.json()).allowed,account==='admin');}
});
test('sales API is gated, separates histories, survives reload, refuses direct generation without approved script',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ai-sales-'));let calls=0;
  const handler=createVideoCreatorHandler({storageDir:root,aiConfig:{},config:{enabled:true,publicOrigin:'http://localhost',signingSecret:'test'},provider:{},director:{enabled:true,generate:async()=>{calls++;return{};}},voice:async(input,path)=>{await writeFile(path,'test');return{duration:10};}});
  await handler.ready;
  const app=createServer((req,res)=>{req.authenticatedUserId='same-test-owner';req.aiSalesAllowed=req.headers.cookie==='account=admin';void handler(req,res);});const base=await listen(app);
  t.after(async()=>{await handler.shutdown();app.closeAllConnections();await new Promise(r=>app.close(r));await rm(root,{recursive:true,force:true});});
  const call=(path,body,admin=true,method=body?'POST':'GET')=>fetch(base+'/api/video-creator'+path,{method,headers:{cookie:admin?'account=admin':'account=other','Content-Type':'application/json','x-ai-sales-allowed':'true'},body:body&&JSON.stringify(body)});
  const id=randomUUID(),request={requestId:id,skill:'ai-sales',settings:SALES_SETTINGS};
  assert.equal((await call('/conversations',request,false)).status,403);
  assert.equal((await call('/conversations',request)).status,201);
  assert.equal((await call('/conversations/'+id,null,false)).status,403);
  assert.equal((await call('/conversations/'+id,{skill:'store-discovery',settings:SALES_SETTINGS},true,'PATCH')).status,409);
  assert.equal((await (await call('/conversations?module=video')).json()).conversations.length,0);
  assert.equal((await (await call('/conversations?module=ai-sales')).json()).conversations.length,1);
  assert.equal((await (await call('/conversations',null,false)).json()).conversations.length,0);
  assert.equal((await call('/tasks?module=ai-sales',null,false)).status,403);
  assert.equal((await (await call('/config',null,false)).json()).skills.some(s=>s.id==='ai-sales'),false);
  assert.equal((await call('/conversations/'+id+'/script',{requestId:randomUUID(),settings:SALES_SETTINGS,message:'生成'})).status,400);
  assert.equal(calls,0);
  const img=await sharp({create:{width:200,height:200,channels:3,background:'#888'}}).jpeg().toBuffer();
  for(const purpose of ['reference','character','voice']){
    const res=await fetch(base+`/api/video-creator/conversations/${id}/assets/${randomUUID()}`,{method:'PUT',headers:{cookie:'account=admin','Content-Type':purpose==='voice'?'audio/mpeg':'image/jpeg','X-Asset-Purpose':purpose},body:purpose==='voice'?Buffer.from('voice'):img});assert.equal(res.status,200,await res.text());
  }
  const generate=await call('/conversations/'+id+'/generate',{requestId:randomUUID(),settings:SALES_SETTINGS,prompt:'只生成空镜'});
  assert.equal(generate.status,409);assert.equal((await generate.json()).code,'SALES_SCRIPT_REQUIRED');
});
