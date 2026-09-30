import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {NextRequest,NextResponse} from 'next/server.js';
import {canAccessEffect} from '../src/lib/motion-library/access.ts';
import {canAccessTask} from '../src/lib/access-control.ts';
import {compileEffect} from '../scripts/motion-library/compile.mjs';
import {validateEffectRef,validateEffectBackground} from '../src/lib/motion-library/contract.ts';
import {publicEffect} from '../src/lib/motion-library/store.ts';
import {MotionInputError,validateMotionEdit} from '../src/lib/motion/contract.ts';
import {probeEffectAsset} from '../src/lib/motion-library/pipeline.ts';
import {getBuiltinEffect,publicBuiltinEffect,listBuiltinEffects} from '../src/lib/motion-library/builtins.ts';
const id='effect_11111111-1111-4111-8111-111111111111';
const source="import React from 'react'; import {interpolate} from 'remotion'; import {Asset} from '@motion'; export default function Effect({frame,scene,assets}) {const opacity=interpolate(frame,[0,15],[0,1]);return <div style={{opacity}}><Asset asset={assets[0]}/><span>{scene.headline}</span></div>}";
test('still image metadata works without a video duration',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'effect-image-')),file=path.join(dir,'image.ppm');
  try{fs.writeFileSync(file,Buffer.concat([Buffer.from('P6\n2 2\n255\n'),Buffer.alloc(12,150)]));
    assert.deepEqual(await probeEffectAsset(file,'image'),{width:2,height:2,durationSeconds:0});
    await assert.rejects(probeEffectAsset(file,'video'),/duration/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('effect compiler accepts dynamic Remotion animation with owned assets and rejects execution or network escape paths',()=>{
  assert.match(compileEffect(source),/exports.default/);
  assert.match(compileEffect(source.replace('style={{opacity}}','style={{opacity,position:"absolute",top:0}}')),/top: 0/);
  for(const bad of [
    source.replace("'remotion'","'node:fs'"),source.replace('const opacity=', 'fetch("/api/private");const opacity='),
    source.replace('const opacity=', 'globalThis.location="x";const opacity='),source.replace('const opacity=', 'import("x");const opacity='),
    source.replace('const opacity=', 'top.location="x";const opacity='),
    source.replace('const opacity=', 'new Function("x");const opacity='),source.replace('const opacity=', 'while(true){}const opacity='),
    source.replace('assets[0]','assets["constructor"]'),source.replace('assets[0]','assets.constructor'),source.replace('assets[0]','assets["con"+"structor"]'),
    source.replace('<span>','<span onClick={()=>1}>'),source.replace('<span>','<span dangerouslySetInnerHTML={{__html:"x"}}>'),
    source.replace('<span>','<iframe>').replace('</span>','</iframe>'),source.replace('style={{opacity}}','style={{background:"url(https://external.invalid/x)"}}'),
    source.replace('style={{opacity}}','{...scene}'),source.replace('export default','export'),
  ])assert.throws(()=>compileEffect(bad));
});
test('library serialization strips private paths and includes code only for an authorized detail response',()=>{
  const row={id,userId:'owner',name:'测试',status:'ready',message:'ok',saved:true,revision:1,updatedAt:1,messages:[{role:'user',content:'描述'}],assets:[],versions:[{revision:1,sourceCode:'private source',compiled:'compiled',backgroundColor:'#082448',preview:'/private/preview.mp4',assets:[{id:'asset_x',source:'/private/asset.jpg',name:'图',kind:'image',width:20,height:10,duration:0,description:'图'}]}]};
  const listing=publicEffect(row);assert.equal(listing.template,undefined);assert.deepEqual(listing.messages,[]);assert.doesNotMatch(JSON.stringify(listing),/private|owner/);
  assert.equal(publicEffect(row,true).template.compiled,'compiled');assert.equal(publicEffect(row,true).template.backgroundColor,'#082448');
  const legacy=structuredClone(row);delete legacy.versions[0].backgroundColor;assert.equal(publicEffect(legacy,true).template.backgroundColor,undefined);assert.equal(publicEffect(row,true).assets[0].url,`/api/motion-library/${id}/media/asset_x.jpg`);
});
test('effect background accepts only a plain hex color and supports existing versions',()=>{
  assert.equal(validateEffectBackground('#082448'),'#082448');assert.equal(validateEffectBackground(undefined),undefined);
  for(const value of [null,22,'red','#123','url(https://external.invalid/image)','linear-gradient(red,blue)','#082448;background:red'])assert.throws(()=>validateEffectBackground(value));
});
test('motion keeps an explicit immutable effect revision and rejects malformed references',()=>{
  const ref={id,revision:2};assert.deepEqual(validateEffectRef(ref),ref);
  for(const r of [{id:'../../other',revision:1},{id,revision:0},{id,revision:1.5},{id,revision:'1'}])assert.throws(()=>validateEffectRef(r));
  const edit={title:'标题',subtitle:'副标题',fit:'cover',captions:[],scenes:[],effect:ref};assert.deepEqual(validateMotionEdit(edit,6).effect,ref);assert.equal(validateMotionEdit({...edit,effect:undefined},6).effect,undefined);
});
function load(file,deps){const code=ts.transpileModule(fs.readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const module={exports:{}};new Function('require','module','exports',code)(n=>{if(n==='next/server')return {NextRequest,NextResponse};if(n==='node:crypto')return {default:{randomUUID:()=>id.slice(7)},randomUUID:()=>id.slice(7)};assert.ok(n in deps,`Missing mock ${n}`);return deps[n];},module,module.exports);return module.exports;}
test('library edit and apply enforce session, ownership, saved versions and upload claims',async()=>{
  let access={isolated:true,userId:null},locked=false,releaseCount=0,runs=0,claims=true,saved=0;
  let row={id,userId:'owner',name:'我的动效',status:'ready',revision:1,saved:true,assets:[],messages:[],versions:[{revision:1,compiled:'one'}]};
  const deps={
    'server-only':{},'@/lib/motion-library/access':{canAccessEffect},
    '@/lib/access-control':{resolveAccessContext:async()=>access,canAccessTask,unauthorizedResponse:()=>NextResponse.json({},{status:401}),taskNotFoundResponse:()=>NextResponse.json({},{status:404})},
    '@/lib/server/upload-policy':{resolveOwnedUpload:async({key,userId})=>key===`key-${userId}`?{source:'private',size:12}:null,claimPendingUploads:()=>claims},
    '@/lib/server/generation-limit':{acquireGenerationSlot:()=>()=>{releaseCount++},GenerationLimitError:class extends Error{}},
    '@/lib/main-app-billing':{isExternallyBilledUser:()=>true},'@/lib/motion/contract':{MotionInputError},'@/lib/server/safe-log':{logServerError:()=>{}},
    './store':{EffectStore:{get:async()=>structuredClone(row),claim:()=>{if(locked)return false;locked=true;return true;},release:()=>{locked=false},save:async r=>{saved++;row=r;return r;}},publicEffect:r=>({id:r.id,status:r.status,saved:r.saved})},
    './pipeline':{runLibraryEffect:async()=>{runs++}},'./builtins':{getBuiltinEffect},
  };
  const service=load('../src/lib/motion-library/service.ts',deps);
  const previous={};for(const k of ['MOTION_AGENT_API_KEY','MOTION_AGENT_BASE_URL','MOTION_AGENT_MODEL']){previous[k]=process.env[k];process.env[k]='test';}
  const patch=body=>service.editLibrary(new NextRequest('http://localhost/api/motion-library/'+id,{method:'PATCH',body:JSON.stringify(body)}),id);
  try{
    assert.equal((await patch({action:'save'})).status,401);access={isolated:true,userId:'other'};assert.equal((await patch({action:'save'})).status,404);
    await assert.rejects(service.ownedEffectVersion({id,revision:1},access),MotionInputError);
    access.isAdmin=true;assert.equal((await patch({action:'save'})).status,404);
    assert.equal((await patch({action:'generate',prompt:'cross-account'})).status,404);
    await assert.rejects(service.ownedEffectVersion({id,revision:1},access),MotionInputError);
    for(const builtin of listBuiltinEffects()){
      const resolved=await service.ownedEffectVersion({id:builtin.id,revision:1},access);assert.equal(resolved.row.id,builtin.id);assert.ok(resolved.version.compiled);
      const latest=await service.ownedEffectVersion({id:builtin.id,revision:builtin.revision},access);assert.equal(latest.version.revision,builtin.revision);
      await assert.rejects(service.ownedEffectVersion({id:builtin.id,revision:99},access),MotionInputError);
      for(const action of ['save','generate'])assert.equal((await service.editLibrary(new NextRequest('http://localhost/api/motion-library/'+builtin.id,{method:'PATCH',body:JSON.stringify({action,prompt:'change fixed template'})}),builtin.id)).status,400);
    }
    assert.equal(saved,0);assert.equal(runs,0);
    access.userId='owner';await assert.rejects(service.ownedEffectVersion({id,revision:99},access),MotionInputError);
    row.saved=false;await assert.rejects(service.ownedEffectVersion({id,revision:1},access),MotionInputError);row.saved=true;
    assert.equal((await patch({action:'generate',prompt:'test',uploads:[{kind:'image',key:'key-other'}]})).status,400);
    assert.equal(saved,0);claims=false;assert.equal((await patch({action:'generate',prompt:'test',uploads:[]})).status,400);assert.equal(releaseCount,1);claims=true;
    assert.equal((await patch({action:'save'})).status,200);assert.equal(runs,0);
    assert.equal((await patch({action:'generate',prompt:'test',uploads:[]})).status,202);await new Promise(r=>setImmediate(r));assert.equal(runs,1);assert.equal(releaseCount,2);
    assert.equal((await patch({action:'generate',prompt:'again'})).status,409);
    locked=false;row=undefined;
    const created=await service.editLibrary(new NextRequest('http://localhost/api/motion-library',{method:'POST',body:JSON.stringify({action:'generate',prompt:'create',userId:'other',uploads:[]})}));
    assert.equal(created.status,202);assert.equal(row.userId,'owner');
  }finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('library media denies other accounts, unknown files and untrusted sources before serving bytes',async()=>{
  let access={isolated:true,userId:null},trusted=true,served=0;
  const row={userId:'owner',versions:[{revision:1,preview:'/private/preview-1.mp4',assets:[{id:'asset_image',kind:'image',source:'/private/asset_image.jpg'}]}]};
  const route=load('../src/app/api/motion-library/[id]/media/[file]/route.ts',{
    'node:path':{default:path},'@/lib/motion-library/access':{canAccessEffect},
    '@/lib/access-control':{resolveAccessContext:async()=>access,canAccessTask,unauthorizedResponse:()=>NextResponse.json({},{status:401}),taskNotFoundResponse:()=>NextResponse.json({},{status:404})},
    '@/lib/motion-library/store':{EffectStore:{get:async()=>row}},
    '@/lib/server/media-response':{isTrustedTaskOutputSource:()=>trusted,servePrivateMedia:async()=>{served++;return NextResponse.json({ok:true});}},
  });
  const get=(file='preview-1.mp4')=>route.GET(new NextRequest('http://localhost/media'),{params:Promise.resolve({id,file})});
  assert.equal((await get()).status,401);access.userId='other';assert.equal((await get()).status,404);assert.equal(served,0);
  access.isAdmin=true;assert.equal((await get()).status,404);assert.equal((await get('asset_image.jpg')).status,404);assert.equal(served,0);
  access.userId='owner';for(const file of ['../preview-1.mp4','agent-input.json','preview-2.mp4'])assert.equal((await get(file)).status,404);
  trusted=false;assert.equal((await get()).status,404);assert.equal(served,0);
  trusted=true;assert.equal((await get()).status,200);assert.equal((await get('asset_image.jpg')).status,200);assert.equal(served,2);
});

test('library list and revision detail stay private for owners, admins and local samples',async()=>{
  let access={isolated:true,userId:null,isAdmin:false};
  const rows=[{id,userId:'owner',revision:1,versions:[{revision:1}]},{id:'effect_other',userId:'other',revision:1,versions:[{revision:1}]},{id:'effect_local',revision:1,versions:[{revision:1}]}];
  const deps={
    '@/lib/motion-library/access':{canAccessEffect},
    '@/lib/motion-library/builtins':{listBuiltinEffects,publicBuiltinEffect},
    '@/lib/access-control':{resolveAccessContext:async()=>access,canAccessTask,unauthorizedResponse:()=>NextResponse.json({},{status:401}),taskNotFoundResponse:()=>NextResponse.json({},{status:404})},
    '@/lib/motion-library/store':{EffectStore:{list:async()=>rows,get:async id=>rows.find(r=>r.id===id)},publicEffect:r=>({id:r.id})},
    '@/lib/motion-library/service':{editLibrary:()=>{throw new Error('Unexpected write');}},
  };
  const list=load('../src/app/api/motion-library/route.ts',deps),detail=load('../src/app/api/motion-library/[id]/route.ts',deps);
  const req=new NextRequest('http://localhost/api/motion-library?userId=owner');
  const get=(target,revision=1)=>detail.GET(new NextRequest('http://localhost/api/motion-library/'+target+'?revision='+revision),{params:Promise.resolve({id:target})});
  assert.equal((await list.GET(req)).status,401);assert.equal((await get(id)).status,401);
  for(const [userId,isAdmin,expected] of [['owner',false,id],['other',false,'effect_other'],['other',true,'effect_other'],['admin',true,null]]){
    access={isolated:true,userId,isAdmin};
    const response=await list.GET(req);assert.equal(response.headers.get('Cache-Control'),'no-store');
    const body=await response.json();assert.deepEqual(body.effects.map(r=>r.id),expected?[expected]:[]);
    assert.deepEqual(body.builtins.map(r=>r.id),['builtin_green_text','builtin_green_diagram']);
    for(const builtin of body.builtins){assert.equal(builtin.builtin,true);assert.equal(builtin.template,undefined);assert.equal((await get(builtin.id)).status,200);}
    const diagram=await get('builtin_green_diagram',2);assert.equal(diagram.status,200);assert.equal((await diagram.json()).effect.template.semantics.required,true);
    assert.equal((await get('builtin_green_diagram',99)).status,404);assert.equal((await get('builtin_green_text',2)).status,404);
    for(const r of rows)assert.equal((await get(r.id)).status,r.userId===userId?200:404);
  }
  access={isolated:false,userId:null,isAdmin:true};
  assert.deepEqual((await (await list.GET(req)).json()).effects.map(r=>r.id),['effect_local']);
  assert.equal((await get(id)).status,404);assert.equal((await get('effect_local')).status,200);
});

test('fixed templates retain legacy source parity and expose the semantic diagram as a new revision',()=>{
  for(const [id,name] of [['builtin_green_text','GreenText'],['builtin_green_diagram','GreenDiagram']]){
    const ref={id,revision:1};assert.deepEqual(validateEffectRef(ref),ref);
    assert.throws(()=>validateEffectRef({...ref,revision:99}));
    const fixed=getBuiltinEffect(id);assert.equal(fixed.versions[0].compiled,compileEffect(fs.readFileSync(new URL(`../src/remotion/templates/${name}.tsx`,import.meta.url),'utf8')));
    assert.deepEqual(fixed.assets,[]);assert.equal(publicBuiltinEffect(id,true).template.backgroundColor,'#194b36');
  }
  assert.throws(()=>validateEffectRef({id:'builtin_green_text',revision:2}));
  const semantic=publicBuiltinEffect('builtin_green_diagram',true);
  assert.deepEqual(validateEffectRef({id:semantic.id,revision:2}),{id:semantic.id,revision:2});
  assert.equal(semantic.template.compiled,compileEffect(fs.readFileSync(new URL('../src/remotion/templates/GreenSemanticDiagram.tsx',import.meta.url),'utf8')));
  assert.equal(semantic.semantics.required,true);assert.equal(semantic.template.semantics.required,true);
  assert.equal(publicBuiltinEffect('builtin_green_diagram',true,1).semantics,undefined);
  assert.equal(publicBuiltinEffect('builtin_green_diagram',true,99),undefined);
  assert.equal(getBuiltinEffect('builtin_arbitrary'),undefined);assert.throws(()=>validateEffectRef({id:'builtin_arbitrary',revision:1}));
  const edit={title:'固定标题',subtitle:'固定副标题',fit:'cover',effect:{id:'builtin_green_diagram',revision:1},captions:[{start:0,end:6,text:'企业知识库帮助新人上手'}],scenes:[{start:0,end:6,headline:'企业知识库',line1:'数字员工',line2:'新人上手',highlight:'上手'}]};
  for(const diagramLayout of ['flow','branch','merge','equation'])assert.equal(validateMotionEdit({...edit,scenes:[{...edit.scenes[0],diagramLayout}]},6,true).scenes[0].diagramLayout,diagramLayout);
  assert.throws(()=>validateMotionEdit({...edit,scenes:[{...edit.scenes[0],diagramLayout:'script'}]},6,true),/图解结构/);
});
