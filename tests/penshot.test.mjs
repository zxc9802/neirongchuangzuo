import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createPenShotPlanner, selectPlannerMode, applyPenShotLayout } from '../services/video-creator/penshot.mjs';
import { createDirectorModel } from '../services/video-creator/model.mjs';

test('planner defaults to the existing path and rejects unknown modes', () => {
  assert.equal(selectPlannerMode(), 'native');
  assert.equal(selectPlannerMode('penshot'), 'penshot');
  assert.throws(() => selectPlannerMode('other'), { code:'PLANNER_MODE_INVALID' });
});

test('PenShot submits once, polls its own task and reads the real result envelope', async () => {
  const calls=[], queued=[], stages=[];
  const planner=createPenShotPlanner({baseUrl:'http://127.0.0.1:8008',pollIntervalMs:0,fetchImpl:async(url,options)=>{
    calls.push({url,...options});
    if(options.method==='POST')return Response.json({success:true,status:'pending',task_id:'TSK_123'});
    if(url.endsWith('/status/TSK_123'))return Response.json({status:stages.length?'success':(stages.push('processing'),'processing')});
    assert.ok(url.endsWith('/result/TSK_123'));
    return Response.json({success:true,data:{instructions:{fragments:[{fragment_id:'f1',duration:3,prompt:'真实产品特写'}]},fragment_sequence:{fragments:[]}}});
  }});
  const result=await planner.generate('完整剧本',{operationId:'op-1',onQueued:id=>queued.push(id)});
  assert.deepEqual(queued,['TSK_123']);assert.equal(result.instructions.fragments[0].prompt,'真实产品特写');
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
  const body=JSON.parse(calls[0].body);assert.equal(body.script_id,'op-1');assert.equal(body.script,'完整剧本');
  assert.equal(body.config.enable_llm,true);assert.equal(calls[0].redirect,'error');
});

for(const failure of ['submit','poll','result','empty'])test(`PenShot ${failure} failure never resubmits or silently falls back`,async()=>{
  let posts=0;
  const planner=createPenShotPlanner({baseUrl:'http://127.0.0.1:8008',fetchImpl:async(url,options)=>{
    if(options.method==='POST'){posts++;return failure==='submit'?Response.json({}):Response.json({task_id:'TSK_123'});}
    if(url.includes('/status/'))return failure==='poll'?new Response('error',{status:503}):Response.json({status:'success'});
    if(failure==='result')return Response.json({success:false});
    return Response.json({success:true,data:{instructions:{fragments:[]}}});
  }});
  await assert.rejects(planner.generate('剧本'));assert.equal(posts,1);
});

test('unconfigured PenShot is rejected before image reads or paid model calls',async()=>{
  let calls=0;
  const model=createDirectorModel({config:{apiKey:'fixture',baseUrl:'http://test.invalid/v1'},fetchImpl:async()=>{calls++;}});
  assert.equal(model.penshotEnabled,false);
  await assert.rejects(model.generate({plannerMode:'penshot'}),{code:'PENSHOT_NOT_CONFIGURED'});
  assert.equal(calls,0);
});

test('cancellation interrupts polling and retains the accepted task ID',async()=>{
  const controller=new AbortController();let queued,posts=0;
  const planner=createPenShotPlanner({baseUrl:'http://127.0.0.1:8008',fetchImpl:async(_url,options)=>{
    if(options.method==='POST'){posts++;return Response.json({task_id:'TSK_123'});}
    controller.abort();return Response.json({status:'processing'});
  }});
  await assert.rejects(planner.generate('剧本',{signal:controller.signal,onQueued:id=>{queued=id;}}),{name:'AbortError'});
  assert.equal(queued,'TSK_123');assert.equal(posts,1);
});

test('PenShot owns shot ordering and relative timing; format conversion cannot silently replace its layout',()=>{
  const board={instructions:{fragments:[{fragment_id:'f1',duration:2},{fragment_id:'f2',duration:3}]}};
  const candidate={kind:'script',script:{shots:[{penshotFragmentId:'f1'},{penshotFragmentId:'f2'}]}};
  const result=applyPenShotLayout(structuredClone(candidate),board,30);
  assert.deepEqual(result.script.shots.map(s=>[s.start,s.end]),[[0,12],[12,30]]);
  for(const shots of [candidate.script.shots.toReversed(),candidate.script.shots.slice(1),[{},{}]]) {
    assert.throws(()=>applyPenShotLayout({kind:'script',script:{shots}},board,30),{code:'DIRECTOR_INVALID_OUTPUT'});
  }
});

test('full PenShot route keeps observation, real shot layout, selected materials and factual review',async t=>{
  const root=await mkdtemp(join(tmpdir(),'penshot-route-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'product.jpg');await sharp({create:{width:96,height:96,channels:3,background:'#ffc900'}}).jpeg().toFile(path);
  const assets=['product','unused'].map(id=>({id,type:'image',purpose:'reference',name:id+'.jpg',path}));
  const candidate={kind:'script',assets:assets.map(a=>({id:a.id,description:'黄色产品',role:a.id==='unused'?'未选用：相似角度':'产品主体',adopt:'可见外形'})),
    script:{title:'产品细节',globalDirection:'真实产品展示',shots:[{penshotFragmentId:'f1',start:0,end:99,visual:'黄色产品特写',camera:'缓慢推近',referenceIds:['product'],voiceover:'',evidence:[{assetId:'product',factIndexes:[0],use:'detail'}]}]}};
  const calls=[],attempts=[];let writing=0;
  const completion=value=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
  const model=createDirectorModel({config:{baseUrl:'https://test.invalid/v1',apiKey:'fixture-key',penshotUrl:'http://127.0.0.1:8008',videoObservationModel:'observer',imageTextModel:'reviewer'},fetchImpl:async(url,options)=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
    if(url.includes(':8008/')) {
      if(options.method==='POST'){assert.match(body.script,/不强制使用全部/);return Response.json({task_id:'TSK_real'});}
      if(url.includes('/status/'))return Response.json({status:'success'});
      return Response.json({success:true,data:{instructions:{fragments:[{fragment_id:'f1',duration:4,prompt:'黄色产品特写',camera:{movement:'push_in'}}]}}});
    }
    if(body.model==='observer')return completion({observations:assets.map(a=>({id:a.id,kinds:['detail'],facts:['黄色产品'],uncertain:[]}))});
    if(body.model==='reviewer')return completion({passed:true,issues:[]});
    writing++;
    if(writing===1)return completion({script:'只展示黄色产品，4秒，素材product；unused相似角度不选用。'});
    assert.match(JSON.stringify(body.messages),/TSK_real/);assert.match(JSON.stringify(body.messages),/penshotFragmentId/);
    assert.equal(body.messages[1].content.some(p=>p.type==='image_url'),false);
    return completion(candidate);
  }});
  const result=await model.generate({plannerMode:'penshot',directorModel:'kimi',operationId:'op-1',skill:'signature',settings:{duration:4,ratio:'9:16',resolution:'720p',language:'zh',generateAudio:false},assets,history:[],message:'展示真实产品'},{onAttempt:a=>attempts.push(a)});
  assert.deepEqual(result.script.referenceImageIds,['product']);assert.equal(result.script.shots[0].end,4);
  assert.equal(result.quality.passed,true);assert.equal(writing,2);
  assert.equal(calls.filter(c=>c.url.endsWith('/storyboard')).length,1);
  assert.equal(attempts.findLast(a=>a.stage==='penshot').providerRequestId,'TSK_real');
});
