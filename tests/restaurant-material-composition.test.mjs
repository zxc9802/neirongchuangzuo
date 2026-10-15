import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {unzipSync} from 'fflate';
import {validateMaterialStoryboard,prepareMaterialComposition,finishMaterialPage,materialEditPrompt,materialClaimIssues,repairMaterialCopy} from '../services/restaurant/content-materials.mjs';
import {contentReferences} from '../services/restaurant/content-references.mjs';
import {createRestaurantHandler} from '../services/restaurant/server.mjs';
import {createRestaurantModel} from '../services/restaurant/model.mjs';
import {createApiCostMeter} from '../services/credits/meter.mjs';
import {createRestaurantStore} from '../services/restaurant/store.mjs';

const style={name:'真实暖光',mood:'轻松聚餐',palette:['红木','暖白'],lighting:'保留自然灯光',tone:'克制对比',texture:'实拍',instructions:'保持真实环境'};
const graphicStyle={accent:'#b84932',paper:'#342820',ink:'light',typography:'solid'};
const analysis=Array.from({length:4},(_,i)=>({imageId:`photo-${i+1}`,usable:true,imageType:i===1?'food':'interior',qualityScore:90,
  privacyRisk:'none',textRisk:'none',visibleObjects:i===1?['面条','青菜汤']:['桌椅','灯光'],visibleTexts:[],riskReasons:[],possibleScene:['用餐'],rejectionReason:''}));
const task={contentType:'consumption-scene',profileSnapshot:{name:'测试餐厅'},contentFacts:{occasion:'朋友聚餐'},analysis};
const pairs=[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
const plan=()=>({version:4,theme:'朋友聚餐',visualStyle:style,graphicStyle,pages:pairs.map((pair,i)=>({role:`聚餐细节${i+1}`,headline:'',subtitle:'',factKeys:[],
  text:{mode:'none',x:.05,y:.1,width:.9,size:50},compositionInstructions:'以真实大场景配局部细节，修饰拼接接缝',materials:pair.map((id,j)=>({sourceImageId:analysis[id].imageId,
    subject:j?'局部细节':'真实空间',crop:{x:j?.2:0,y:0,width:j?.6:1,height:1},placement:j?{x:.55,y:.62,width:.4,height:.3}:{x:0,y:0,width:1,height:1},treatment:'frame',editInstructions:'保留原主体'}))}))});

test('composition rejects unrelated references, unsafe crops, made-up people and duplicate full designs',()=>{
  assert.equal(validateMaterialStoryboard(plan(),task,6).pages.length,6);
  for(const mutate of [p=>p.pages[0].materials[0].sourceImageId='type-reference-1',p=>p.pages[0].materials[0].crop.width=1.3,
    p=>p.pages[0].materials[0].placement={x:0,y:0,width:2,height:1},p=>p.pages[1]=p.pages[0]]) {
    const raw=plan();mutate(raw);assert.throws(()=>validateMaterialStoryboard(raw,task,6),{code:'INVALID_GALLERY_STORYBOARD'});
  }
  const raw=plan();raw.pages[0].materials[0].treatment='cutout';
  assert.throws(()=>validateMaterialStoryboard(raw,{...task,analysis:analysis.map((a,i)=>i? a:{...a,imageType:'people'})},6),{code:'INVALID_GALLERY_STORYBOARD'});
  const mixed=plan();
  for(const [i,page]of mixed.pages.entries())if(i!==0 && i!==3){page.materials=page.materials.slice(0,1);page.materials[0].crop={x:i*.03,y:0,width:.8,height:1};page.text={mode:'none'};}
  assert.equal(validateMaterialStoryboard(mixed,task,6).pages.filter(p=>p.materials.length>1).length,2,'natural detail pages may accompany real composed covers');
  mixed.pages[2].text={mode:'none',x:0,y:0,width:0,size:0};
  assert.equal(validateMaterialStoryboard(mixed,task,6).pages[2].text.size,64,'unused zero-size fields from a no-text model response do not reject the valid composition');
  mixed.pages[3].materials=mixed.pages[3].materials.slice(0,1);
  assert.throws(()=>validateMaterialStoryboard(mixed,task,6),{code:'INVALID_GALLERY_STORYBOARD'},'a set must not silently regress to single-photo filter edits');
  const claim=plan();claim.pages[0].headline='炭火湘味音乐吧';
  assert.ok(materialClaimIssues(validateMaterialStoryboard(claim,task,6),{...task,profileSnapshot:{name:'湘聚'}}).length,'a shop name or stage cannot substantiate food technique or music services');
  assert.deepEqual(materialClaimIssues(validateMaterialStoryboard(claim,task,6),{...task,profileSnapshot:{name:'湘聚',features:'炭火湘味音乐吧'}}),[]);
  assert.deepEqual(materialClaimIssues(validateMaterialStoryboard(claim,task,6),{...task,profileSnapshot:{name:'炭火湘味音乐吧'}}),[],'the confirmed brand itself may appear without inferring a separate service claim');
});

test('actual crops use original pixel coordinates and composition records each original, not inferred shot IDs',async()=>{
  const bytes=await sharp({create:{width:800,height:600,channels:3,background:'#ce3030'}}).composite([{input:await sharp({create:{width:400,height:600,channels:3,background:'#3030ce'}}).png().toBuffer(),left:400,top:0}]).png().toBuffer();
  const board=validateMaterialStoryboard(plan(),task,6),page=board.pages[0];
  page.materials[0].crop={x:.5,y:0,width:.5,height:1};
  const source=analysis.map(a=>({id:a.imageId,bytes}));
  const prepared=await prepareMaterialComposition(page,source,graphicStyle);
  assert.deepEqual(prepared.parts[0].crop,{left:400,top:0,width:400,height:600});
  const pixel=await sharp(prepared.parts[0].bytes).resize(1,1).raw().toBuffer();assert.ok(pixel[2]>180 && pixel[0]<70);
  const result=await finishMaterialPage(prepared.draft.bytes,page,board,{requestId:'known-provider-request'});
  const meta=await sharp(result.bytes).metadata();assert.equal(meta.width,1080);assert.equal(meta.height,1440);
  assert.deepEqual(result.composition.sourceImageIds,['photo-1','photo-2']);assert.equal(result.composition.materials[0].crop.x,.5);
  assert.equal(result.composition.requestId,'known-provider-request');
  assert.match(materialEditPrompt({page,visualStyle:style}),/rough collage/);
});

test('unsupported factual copy is corrected without replanning crops, placements or style',()=>{
  const raw=plan();raw.pages[0].headline='炭火湘味音乐吧';const board=validateMaterialStoryboard(raw,task,6);
  const corrected={pages:board.pages.map(p=>({imageId:p.imageId,role:p.role,headline:p.imageId==='page-01'?'烤串与用餐氛围':p.headline,subtitle:p.subtitle,factKeys:p.factKeys}))};
  const result=repairMaterialCopy(corrected,board,task);assert.deepEqual(result.pages.map(p=>p.materials),board.pages.map(p=>p.materials));assert.deepEqual(result.visualStyle,board.visualStyle);
  assert.deepEqual(materialClaimIssues(result,task),[]);corrected.pages[0].headline='炭火烤串';assert.throws(()=>repairMaterialCopy(corrected,board,task),{code:'INVALID_GALLERY_STORYBOARD'});
});

test('consumption reference set contains exactly the four newly provided images, separated from source IDs',async()=>{
  const refs=await contentReferences('consumption-scene');assert.equal(refs.images.length,4);assert.equal(refs.binding.revision,'consumption-scene-v2');
  const root='C:/Users/Administrator/AppData/Roaming/LarkShell/sdk_storage/30d98e89a7194d6e2e05f1fef8b06a74/resources/images/';
  // Packaged reference remains reproducible even on CI without the original attachment directory.
  assert.deepEqual(refs.images.map(a=>a.id),['type-reference-1','type-reference-2','type-reference-3','type-reference-4']);
  for(const image of refs.images){assert.equal(image.role,'style-only-never-source');assert.equal((await sharp(image.bytes).metadata()).format,'jpeg');}
  const file='img_v3_0216f_2485dddc-e986-412f-8eb3-d71622f8addg.jpg';
  const original=await readFile(root+file).catch(()=>null);if(original)assert.deepEqual(refs.images[0].bytes,original);
  assert.equal((await contentReferences('store-intro')).images.length,6);
  assert.equal((await contentReferences('signature-dish')).images.length,5);
});

test('Image 2.5 receives only the real material collage and crops, with integrated approved type',async t=>{
  const root=await mkdtemp(join(tmpdir(),'material-image-model-'));
  const board=validateMaterialStoryboard(plan(),task,6),page={...board.pages[0],headline:'和朋友约一餐',text:{mode:'headline',x:.08,y:.1,width:.8,size:60,instructions:'圆润手写感，轻量无边框'}};
  const bytes=await sharp({create:{width:600,height:800,channels:3,background:'#b47645'}}).jpeg().toBuffer();
  const source=analysis.map(a=>({id:a.imageId,bytes})),{draft,parts}=await prepareMaterialComposition(page,source,graphicStyle);
  const calls=[];
  const model=createRestaurantModel({storageDir:root,config:{apiKey:'test-only-not-a-secret',baseUrl:'https://image-provider.example/v1',imageModel:'gpt-image-2.5-sunburst-c',imageTextModel:'claude-opus-5-5',limits:{image:null,chat:null,perMinute:null}},
    fetchImpl:async(url,options)=>{calls.push({url,body:options.body});assert.equal(options.body.get('model'),'gpt-image-2.5-sunburst-c');return Response.json({data:[{b64_json:bytes.toString('base64')}],usage:{input_tokens:100,output_tokens:200}},{headers:{'x-request-id':'mock-material-provider'}});}});
  await model.ready;t.after(async()=>{await model.close?.();await rm(root,{recursive:true,force:true});});
  const rendered=await model.renderContentPage({draft,parts,page,visualStyle:style,taskId:'fixture-task',attempt:0});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://image-provider.example/v1/images/edits');assert.equal(calls[0].body.getAll('image').length,3);
  const prompt=calls[0].body.get('prompt');assert.match(prompt,/Typography is part of your integrated composition/);assert.match(prompt,/和朋友约一餐/);assert.match(prompt,/圆润手写感/);
  assert.doesNotMatch(prompt,/approved text will be typeset separately/);assert.equal((await sharp(rendered.bytes).metadata()).height,1440);
});

test('a missing cost scope is a known unsent request, never an uncertain provider charge',async()=>{
  let sent=0;const meter=createApiCostMeter({credits:{costMode:true},fetchImpl:async()=>{sent++;return Response.json({});}});
  await assert.rejects(meter.fetch('https://api.openlux.ai/v1/chat/completions',{method:'POST',body:'{}'}),{code:'COST_PROVIDER_NOT_CONFIGURED',providerNotDispatched:true});
  assert.equal(sent,0);
});

test('one-click delivers six source-based compositions, retries only rejected pages and exports six JPEGs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'material-composition-')),renders=[],facts=[],reviewCalls=[];let copyRepairs=0,forceBlock=false;
  const model={enabled:true,ready:Promise.resolve(),analyse:async photos=>photos.map(p=>analysis.find(a=>a.imageId===p.id)),
    async planContentSet(input){assert.equal(input.contentType,'consumption-scene');assert.equal(input.referenceSet.count,4);assert.ok(input.photos.some(p=>p.id==='type-reference-sheet-1'));const raw=plan();raw.pages[0].headline='炭火湘味音乐吧';return raw;},
    async repairContentCopy(input){copyRepairs++;assert.ok(input.issues.length);assert.ok(input.pages.every(p=>!p.materials),'copy repair cannot replan photographic regions');return {pages:input.pages.map(p=>({...p,headline:p.imageId==='page-01'?'用餐空间与灯光':p.headline}))};},
    async auditContentFacts(input){facts.push(input);assert.deepEqual(input.pages[0].evidence.map(m=>m.sourceImageId),['photo-1','photo-2']);return {status:'passed',errors:[],warnings:[]};},
    async renderContentPage(input){assert.ok(copyRepairs>=1,'unconfirmed factual text must be repaired before any image request');assert.equal(input.parts.length,2);renders.push([input.page.imageId,input.attempt]);return {bytes:input.draft.bytes,requestId:'mock-'+renders.length};},
    async reviewContentSet(input){reviewCalls.push(input);if(forceBlock)return {status:'blocked',reviseImageIds:['page-04'],errors:['该页文字需要修正'],warnings:[]};return reviewCalls.length===1?{status:'blocked',reviseImageIds:['page-03'],errors:['局部边缘粗糙'],warnings:[]}:{status:'passed',reviseImageIds:[],errors:[],warnings:[]};},
    async write(){throw Error('optional copy not available');}};
  const storage=createRestaurantStore({dataDir:root,databaseUrl:''});
  const handler=createRestaurantHandler({dataDir:root,databaseUrl:'',store:storage,model,requireAuth:false,cleanupIntervalMs:0,logger:{warn(){}}});await handler.ready;
  const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await handler.shutdown();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,id=randomUUID();
  const images=await Promise.all(analysis.map(async(a,i)=>({name:i+'.jpg',dataUrl:'data:image/jpeg;base64,'+(await sharp({create:{width:300,height:400,channels:3,background:{r:50+i*30,g:70,b:100}}}).jpeg().toBuffer()).toString('base64')})));
  const body={requestId:id,rightsConfirmed:true,autoGenerate:true,contentType:task.contentType,contentProfile:task.profileSnapshot,contentFacts:task.contentFacts,images};
  assert.equal((await fetch(base+'/api/restaurant/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,202);
  let result;const deadline=Date.now()+20000;
  do{result=(await(await fetch(base+'/api/restaurant/tasks/'+id)).json()).task;if(['failed','completed'].includes(result.status))break;await new Promise(r=>setTimeout(r,30));}while(Date.now()<deadline);
  assert.equal(result.status,'completed',result.error);assert.equal(result.galleryStoryboard.version,4);assert.equal(renders.length,7);
  assert.deepEqual(renders.filter(r=>r[1]!==0),[['page-03',1]]);assert.equal(facts.length,1);assert.equal(copyRepairs,1);assert.equal(reviewCalls.length,2);
  const files=result.files.filter(f=>f.role==='image');assert.equal(files.length,6);assert.equal(files[0].composition.materials.length,2);
  const zip=Buffer.from(await(await fetch(base+result.files.find(f=>f.role==='zip').url)).arrayBuffer());assert.equal(Object.keys(unzipSync(zip)).filter(n=>n.endsWith('.jpg')).length,6);
  await fetch(base+'/api/restaurant/tasks/'+id);assert.equal(renders.length,7,'refresh does not rerender or charge more pages');
  const forkId=randomUUID(),forkBody={requestId:forkId,autoGenerate:true,outputCount:6},forkUrl=base+'/api/restaurant/tasks/'+id+'/fork';
  const postFork=()=>fetch(forkUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(forkBody)});
  const fork=await postFork();assert.equal(fork.status,202);assert.equal((await fork.json()).task.status,'analysing','fork acknowledges the background workflow instead of waiting for image generation');
  assert.equal((await postFork()).status,202);
  let child;const forkDeadline=Date.now()+15000;
  do{child=(await(await fetch(base+'/api/restaurant/tasks/'+forkId)).json()).task;if(['failed','completed'].includes(child.status))break;await new Promise(r=>setTimeout(r,30));}while(Date.now()<forkDeadline);
  assert.equal(child.status,'completed',child.error);assert.equal(child.files.filter(f=>f.role==='image').length,6);assert.equal(renders.length,13,'repeated fork submit creates exactly one new set');
  forceBlock=true;const recoveryId=randomUUID(),recoveryBody={...body,requestId:recoveryId};
  assert.equal((await fetch(base+'/api/restaurant/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(recoveryBody)})).status,202);
  let recovery;const failedDeadline=Date.now()+15000;
  do{recovery=(await(await fetch(base+'/api/restaurant/tasks/'+recoveryId)).json()).task;if(recovery.status==='failed')break;await new Promise(r=>setTimeout(r,30));}while(Date.now()<failedDeadline);
  assert.equal(recovery.status,'failed');assert.equal(recovery.code,'CONTENT_PAGE_REVIEW_FAILED');const beforeRecovery=renders.length;
  forceBlock=false;
  assert.equal((await fetch(base+'/api/restaurant/tasks/'+recoveryId+'/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,202);
  const recoveryDeadline=Date.now()+15000;
  do{recovery=(await(await fetch(base+'/api/restaurant/tasks/'+recoveryId)).json()).task;if(['failed','completed'].includes(recovery.status))break;await new Promise(r=>setTimeout(r,30));}while(Date.now()<recoveryDeadline);
  assert.equal(recovery.status,'completed',recovery.error);assert.equal(renders.length,beforeRecovery+1,'all six known pages resume and only the rejected page is regenerated');
  assert.deepEqual(renders.at(-1),['page-04',3],'a later retry uses a new supplier attempt ID instead of replaying attempt 1');assert.equal(recovery.files.filter(f=>f.role==='image').length,6);
});
