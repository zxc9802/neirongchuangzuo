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
import { validateDirectorResult, createDirectorModel } from '../services/video-creator/model.mjs';
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
  for(const i of [0,2]){const next=structuredClone(shots);next[i].referenceIds=['food'];assert.throws(()=>assertSalesPlan(next,plan,assets),e=>e.outputIssue==='invalid_schema');}
  const persona=structuredClone(shots);persona[0].referenceIds=['actor','food'];persona[1].referenceIds=['food'];persona[2].referenceIds=['actor'];
  assert.doesNotThrow(()=>assertSalesPlan(persona,plan,assets));
  const isolated=structuredClone(persona);isolated[0].referenceIds=['actor'];assert.throws(()=>assertSalesPlan(isolated,plan,assets),e=>e.outputIssue==='invalid_schema');
  persona[1].referenceIds=['actor'];assert.throws(()=>assertSalesPlan(persona,plan,assets),e=>e.outputIssue==='invalid_schema');
  assert.throws(()=>assertSalesPlan(shots,{cast:[]},assets));
  const input={skill:'ai-sales',settings:SALES_SETTINGS,assets};
  const output={kind:'script',script:{title:'产品介绍',plan,shots},assets:assets.map(a=>({id:a.id,description:'参考素材',role:'参考用途',adopt:'保留素材特征'}))};
  const result=validateDirectorResult(output,input);
  assert.deepEqual(result.script.referenceImageIds,['actor','food']);
  assert.match(result.script.videoPrompt,/声音参考1/);
  assert.doesNotThrow(()=>validateDirectorResult(output,{...input,fixedNarration:'看看这款产品！看看这款产品。看看这款产品'}));
  assert.throws(()=>validateDirectorResult(output,{...input,fixedNarration:'不能修改我的定稿'}),e=>e.code==='DIRECTOR_INVALID_OUTPUT');
  const missing=structuredClone(output);missing.script.shots[0].referenceIds=['food'];
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


test('fixed sales copy uses non-thinking Doubao planning with headroom; other modes retain their request options',async t=>{
  const root=await mkdtemp(join(tmpdir(),'sales-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const image=join(root,'photo.jpg');await sharp({create:{width:100,height:100,channels:3,background:'#888'}}).jpeg().toFile(image);
  const inputAssets=assets.map(a=>({...a,path:image}));
  const output={kind:'script',script:{title:'创作挑战',plan,shots},assets:assets.map(a=>({id:a.id,description:'参考素材',role:'参考用途',adopt:'保留素材特征'}))};
  for(const scenario of [{skill:'ai-sales',copy:'看看这款产品看看这款产品看看这款产品',model:'doubao-seed-2-1-pro-260915',disabled:true},{skill:'ai-sales',copy:'',model:'doubao-seed-2-1-pro-260915'},{skill:'store-discovery',copy:'',model:'doubao-seed-2-1-pro-260915'},{skill:'ai-sales',copy:'看看这款产品看看这款产品看看这款产品',model:'claude-opus-5-5'}]){
    let body;
    const director=createDirectorModel({config:{apiKey:'test',baseUrl:'https://test.invalid',videoDirectorModel:scenario.model},fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}),{headers:{'Content-Type':'application/json'}});}});
    const generated = await director.generate({skill:scenario.skill,fixedNarration:scenario.copy,settings:SALES_SETTINGS,assets:inputAssets,history:[],message:'创作挑战'});
    if(scenario.skill==='ai-sales'){assert.match(body.messages[0].content,/匿名行业案例/);assert.match(generated.script.videoPrompt,/不能出现可辨认的具体店名/);}
    else assert.doesNotMatch(body.messages[0].content,/匿名行业案例/);
    assert.equal(body.max_tokens,scenario.skill==='ai-sales'?32768:16384);
    assert.deepEqual(body.thinking,scenario.disabled?{type:'disabled'}:undefined);
  }
});

test('sales rechecks editorial rejection without replanning, but still blocks confirmed factual defects',async t=>{
  const root=await mkdtemp(join(tmpdir(),'sales-review-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'photo.jpg');await sharp({create:{width:80,height:80,channels:3,background:'#888'}}).jpeg().toFile(path);
  const input={skill:'ai-sales',settings:SALES_SETTINGS,groundingVersion:1,assets:assets.map(a=>({...a,path})),history:[],message:'创作挑战'};
  const observations=assets.map(a=>({id:a.id,kinds:[a.type==='audio'?'voice':a.purpose==='character'?'character':'scene'],facts:['参考素材'],uncertain:[]}));
  const output={kind:'script',script:{title:'AI创作挑战',plan,shots:shots.map(s=>({...s,evidence:s.referenceIds.map(id=>({assetId:id,factIndexes:[0],use:id==='actor'?'character':'scene'}))}))},assets:assets.map(a=>({id:a.id,description:'参考素材',role:'参考用途',adopt:'保留特征'}))};
  for(const factual of [false,true]){
    let plans=0,reviews=0;const sent=[];
    const model=createDirectorModel({config:{apiKey:'test',baseUrl:'https://test.invalid',videoDirectorModel:'doubao',imageTextModel:'claude'},fetchImpl:async(_url,opts)=>{
      const body=JSON.parse(opts.body);sent.push(body);let value;
      if(sent.length===1)value={observations};
      else if(Array.isArray(body.messages[1].content)){plans++;value=output;}
      else {reviews++;value=factual||reviews===1?{passed:false,issues:[{shot:1,reason:factual?'编造门店区域':'合成说明正确，但负面约束可以精简'}]}:{passed:true,issues:[]};}
      return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
    }});
    if(factual){await assert.rejects(model.generate(input),e=>e.outputIssue==='quality_rejected');assert.equal(plans,2);assert.equal(reviews,4);}
    else {const result=await model.generate(input);assert.equal(result.quality.passed,true);assert.equal(plans,1);assert.equal(reviews,2);assert.match(sent.at(-1).messages[1].content,/previousReview/);}
  }
});
