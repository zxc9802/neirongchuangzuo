import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import {NextRequest, NextResponse} from 'next/server.js';
import * as contract from '../src/lib/motion/contract.ts';
import {normalizeTranscription, scenesFromCueGroups, motionSummaryGroups} from '../src/lib/motion/analyze.ts';
import {publicMotion} from '../src/lib/motion/store.ts';
import * as generationLimit from '../src/lib/server/generation-limit.ts';
import {isExternallyBilledUser} from '../src/lib/main-app-billing.ts';
import {cropOverflow, motionVideoStyle, panMotionCrop} from '../src/lib/motion/crop.ts';
const edit = {title:'标题', subtitle:'副标题', fit:'cover', crop:{x:0.5,y:0.5,zoom:1}, captions:[{start:0,end:3,text:'收入没有增加'}], scenes:[{start:0,end:3,headline:'收入变化',line1:'收入没有增加',line2:'',highlight:'没有增加'}]};

test('crop settings persist through validation and serialization, and old tasks stay centered', () => {
  const crop={x:0.1,y:0.9,zoom:1.75};
  const edited=contract.validateMotionEdit({...edit,crop},3,true);
  assert.deepEqual(edited.crop,crop);
  assert.deepEqual(publicMotion({...edited,id:'motion_test'}).crop,crop);
  assert.deepEqual(contract.validateMotionEdit({...edit,crop:undefined},3).crop,contract.DEFAULT_MOTION_CROP);
  assert.deepEqual(publicMotion({...edit,crop:undefined}).crop,contract.DEFAULT_MOTION_CROP);
  for(const invalid of [null,{},[],{...crop,x:-0.01},{...crop,y:1.01},{...crop,zoom:0.99},{...crop,zoom:3.01},{...crop,x:NaN},{...crop,zoom:Infinity},{...crop,y:'0.5'}]) {
    assert.throws(()=>contract.validateMotionEdit({...edit,crop:invalid},3),contract.MotionInputError);
  }
});

test('crop dragging uses the actual portrait or landscape overflow and clamps at the frame edges', () => {
  const portrait=cropOverflow(720,1280,270,230,1);
  assert.deepEqual(portrait,{x:0,y:250});
  assert.deepEqual(panMotionCrop(edit.crop,100,125,portrait),{x:0.5,y:0,zoom:1});
  assert.deepEqual(panMotionCrop(edit.crop,-100,-1000,portrait),{x:0.5,y:1,zoom:1});
  const landscape=cropOverflow(1920,1080,270,230,1);
  assert.ok(landscape.x>138 && landscape.x<139); assert.equal(landscape.y,0);
  assert.deepEqual(panMotionCrop(edit.crop,landscape.x,100,landscape),{x:0,y:0.5,zoom:1});
  const zoomed=cropOverflow(720,1280,270,230,2);
  assert.deepEqual(zoomed,{x:270,y:730});
  assert.deepEqual(panMotionCrop({...edit.crop,zoom:2},-270,730,zoomed),{x:1,y:0,zoom:2});
  const scaled=cropOverflow(720,1280,540,460,2);
  assert.deepEqual(panMotionCrop({...edit.crop,zoom:2},-30,40,zoomed),panMotionCrop({...edit.crop,zoom:2},-60,80,scaled));
});

test('the crop preview and render transform use the same anchor, with contain mode preserving the whole image', () => {
  assert.deepEqual(motionVideoStyle('cover',{x:0.25,y:0.8,zoom:1.5}),{width:'100%',height:'100%',objectFit:'cover',objectPosition:'25% 80%',transform:'scale(1.5)',transformOrigin:'25% 80%'});
  assert.deepEqual(motionVideoStyle('contain',{x:0.25,y:0.8,zoom:3}),motionVideoStyle('contain',edit.crop));
  assert.deepEqual(motionVideoStyle('cover'),motionVideoStyle('cover',edit.crop));
});

test('motion rejects invalid, overlapping, out-of-bounds and non-finite caption timing', () => {
  for (const captions of [[{start:0,end:4,text:'a'}], [{start:2,end:1,text:'a'}], [{start:NaN,end:3,text:'a'}], [{start:0,end:2,text:'a'},{start:1,end:3,text:'b'}]]) assert.throws(() => contract.validateMotionEdit({...edit,captions},3,true), contract.MotionInputError);
  assert.deepEqual(contract.validateMotionEdit(edit,3,true), edit);
});
test('motion validates render completeness, line length and grounded highlight text', () => {
  for (const value of [{...edit,title:'a'.repeat(23)}, {...edit,fit:'stretch'}, {...edit,captions:[]}, {...edit,scenes:[]}, {...edit,scenes:[{...edit.scenes[0],highlight:'增加10倍'}]}, {...edit,scenes:[{...edit.scenes[0],line1:'字'.repeat(27)}]}]) assert.throws(() => contract.validateMotionEdit(value,3,true));
  assert.equal(contract.validateMotionEdit({...edit,scenes:[]},3).scenes.length,0);
});
test('SRT import keeps supplied timestamps and strips markup instead of estimating timing', () => {
  const cues = contract.parseSrt('\uFEFF1\r\n00:00:01,230 --> 00:00:03,500\r\n<b>你好</b>\r\n世界\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,200\r\n第二句');
  assert.deepEqual(cues,[{start:1.23,end:3.5,text:'你好 世界'},{start:4,end:5.2,text:'第二句'}]);
  assert.throws(() => contract.parseSrt('文字没有时间戳'));
});
test('word timestamps keep pauses and group captions without changing the audio clock', () => {
  const cues = normalizeTranscription({words:[{start:0.1,end:0.5,word:'收入'},{start:0.6,end:1.1,word:'没有增加。'},{start:3,end:4,word:'下一句'}]},5);
  assert.deepEqual(cues,[{start:0.1,end:1.1,text:'收入没有增加。'},{start:3,end:4,text:'下一句'}]);
  assert.throws(() => normalizeTranscription({text:'no timestamps'},5));
  assert.throws(() => normalizeTranscription({segments:[{start:0,end:50,text:'bad'}]},5));
});
test('summary cue anchors must cover every caption in order', () => {
  const captions=[{start:0,end:1,text:'甲'},{start:2,end:3,text:'乙'},{start:4,end:5,text:'丙'}];
  const group={headline:'话题',line1:'甲乙',line2:'',highlight:''};
  const scenes=scenesFromCueGroups([{...group,first:0,last:1},{...group,first:2,last:2}],captions);
  assert.deepEqual(scenes.map(s=>[s.start,s.end]),[[0,4],[4,5]]);
  for(const groups of [[{...group,first:1,last:2}], [{...group,first:0,last:1}], [{...group,first:0,last:0},{...group,first:0,last:2}], [{...group,first:0,last:99}]]) assert.throws(()=>scenesFromCueGroups(groups,captions));
});
test('motion serialization never exposes source paths, storage URLs or user identifiers', () => {
  const p=publicMotion({...edit,id:'motion_x',userId:'private-user',source:'/private/input.mp4',output:'https://bucket/private.mp4',status:'completed',createdAt:1,updatedAt:2,name:'clip',duration:3,progress:100,message:'ok'});
  assert.equal(p.sourceUrl,'/api/motion/motion_x/media/source');
  assert.equal(p.finalUrl,'/api/motion/motion_x/media/final?v=2');
  assert.doesNotMatch(JSON.stringify(p),/private-user|bucket|\/private/);
  assert.equal(publicMotion({...p,status:'rendering',source:'/input',output:'/output'}).finalUrl,undefined);
});
function loadRoute(file, deps) {
  const code=ts.transpileModule(fs.readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',code)(name=>{if(name==='next/server')return {NextRequest,NextResponse}; assert.ok(name in deps,`Unexpected dependency ${name}`);return deps[name];},module,module.exports);
  return module.exports;
}
test('motion edit endpoints enforce login, ownership, valid timing and one active operation', async () => {
  let access={isolated:true,userId:null,isAdmin:false}, locked=false, releases=0, runs=0, finish;
  let project={...edit,id:'motion_test',userId:'owner',duration:3,status:'ready',source:'source',createdAt:1,updatedAt:1};
  const deps={
    '@/lib/access-control':{resolveAccessContext:async()=>access, canAccessTask:(a,p)=>a.userId===p.userId,unauthorizedResponse:()=>NextResponse.json({}, {status:401}),taskNotFoundResponse:()=>NextResponse.json({}, {status:404})},
    '@/lib/server/generation-limit':{acquireGenerationSlot:()=>()=>{releases++},GenerationLimitError:class extends Error{}},
    '@/lib/main-app-billing':{isExternallyBilledUser},
    '@/lib/server/safe-log':{logServerError:()=>{}}, '@/lib/motion/contract':contract,
    '@/lib/motion/store':{publicMotion:p=>({id:p.id,status:p.status}),MotionStore:{get:async()=>project,save:async p=>(project=p),claim:()=>{if(locked)return false;locked=true;return true;},release:()=>{locked=false}}},
    '@/lib/motion/pipeline':{runMotion:()=>{runs++;return new Promise(resolve=>{finish=resolve})}},
  };
  const route=loadRoute('../src/app/api/motion/[id]/route.ts',deps);
  const ctx={params:Promise.resolve({id:'motion_test'})};
  const patch=body=>route.PATCH(new NextRequest('http://localhost/api/motion/motion_test',{method:'PATCH',body:JSON.stringify(body)}),ctx);
  for(const action of ['render','prepare']) assert.equal((await patch({...edit,action})).status,401);
  access={...access,userId:'stranger'};
  for(const action of ['render','prepare']) assert.equal((await patch({...edit,action})).status,404);
  assert.equal((await route.GET(new NextRequest('http://localhost'),ctx)).status,404);
  access={...access,userId:'owner'};
  assert.equal((await patch({...edit,crop:{x:2,y:0.5,zoom:1},action:'save'})).status,400);
  const selectedCrop={x:0.2,y:0.35,zoom:1.4};
  assert.equal((await patch({...edit,crop:selectedCrop,action:'save'})).status,200);
  assert.deepEqual(project.crop,selectedCrop);
  assert.equal((await patch({...edit,captions:[{start:0,end:9,text:'bad'}],action:'render'})).status,400);
  assert.equal(locked,false); assert.equal(runs,0);
  assert.equal((await patch({...edit,crop:selectedCrop,action:'render'})).status,202);
  assert.deepEqual(project.crop,selectedCrop);
  assert.equal(runs,1);
  assert.equal((await patch({...edit,action:'render'})).status,409);
  assert.equal((await patch({...edit,action:'save'})).status,409);
  finish(); await new Promise(resolve=>setImmediate(resolve)); assert.equal(releases,1); assert.equal(locked,false);
});
test('motion media is private and final downloads require a completed trusted output', async () => {
  let access={isolated:true,userId:null}, status='completed', trusted=true, served=0;
  const route=loadRoute('../src/app/api/motion/[id]/media/[kind]/route.ts',{
    '@/lib/access-control':{resolveAccessContext:async()=>access,canAccessTask:(a,p)=>a.userId===p.userId,unauthorizedResponse:()=>NextResponse.json({}, {status:401}),taskNotFoundResponse:()=>NextResponse.json({}, {status:404})},
    '@/lib/motion/store':{MotionStore:{get:async()=>({id:'motion_test',userId:'owner',source:'input',output:'output',status})}},
    '@/lib/server/upload-policy':{isOwnedUploadSource:()=>trusted},
    '@/lib/server/media-response':{isTrustedTaskOutputSource:()=>trusted,servePrivateMedia:async()=>{served++;return new Response('media')}},
  });
  const get=kind=>route.GET(new NextRequest('http://localhost/api/motion/motion_test/media/final'),{params:Promise.resolve({id:'motion_test',kind})});
  assert.equal((await get('final')).status,401); access.userId='other'; assert.equal((await get('source')).status,404);
  access.userId='owner'; status='rendering'; assert.equal((await get('final')).status,404); status='completed'; trusted=false; assert.equal((await get('final')).status,404);
  trusted=true; assert.equal((await get('final')).status,200); assert.equal(served,1);
});

test('motion create and render apply the external quota only to external accounts', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'motion-quota-test-'));
  const saved=process.env.GENERATION_LIMIT_PATH;
  process.env.GENERATION_LIMIT_PATH=path.join(tmp,'limits.json');
  try {
    for (const user of [null, {id:'admin',role:'admin'}, {id:'internal',role:'user',billingAudience:'internal'}, {id:'external',role:'user',billingAudience:'external'}, {id:'ordinary',role:'user'}]) {
      const access={isolated:!!user,userId:user?.id || null,isAdmin:!user || user.role==='admin',session:user ? {user} : null};
      const ledger=Array.from({length:6},()=>({userId:`motion:${access.userId || 'local'}`,at:Date.now()}));
      fs.writeFileSync(process.env.GENERATION_LIMIT_PATH,JSON.stringify(ledger));
      let project={...edit,id:'motion_quota',userId:access.userId,duration:3,status:'ready',source:'source',createdAt:1,updatedAt:1};
      let claims=0,runs=0,locked=false;
      const deps={
        'node:crypto':{default:crypto},
        '@/lib/access-control':{resolveAccessContext:async()=>access,canAccessTask:()=>true,unauthorizedResponse:()=>NextResponse.json({}, {status:401}),taskNotFoundResponse:()=>NextResponse.json({}, {status:404})},
        '@/lib/server/generation-limit':generationLimit,
        '@/lib/main-app-billing':{isExternallyBilledUser},
        '@/lib/server/upload-policy':{resolveOwnedUpload:async()=>({source:'source'}),claimPendingUpload:()=>{claims++;return true}},
        '@/lib/server/safe-log':{logServerError:()=>{}}, '@/lib/motion/contract':contract,
        '@/lib/motion/store':{publicMotion:p=>({id:p.id,status:p.status}),MotionStore:{get:async()=>project,save:async p=>(project=p),claim:()=>{if(locked)return false;locked=true;return true},release:()=>{locked=false}}},
        '@/lib/motion/pipeline':{runMotion:async()=>{runs++}},
      };
      const createRoute=loadRoute('../src/app/api/motion/route.ts',deps);
      const editRoute=loadRoute('../src/app/api/motion/[id]/route.ts',deps);
      const expected=isExternallyBilledUser(user) ? 429 : 202;
      const created=await createRoute.POST(new NextRequest('http://localhost/api/motion',{method:'POST',body:JSON.stringify({...edit,uploadKey:'uploaded-video',name:'video.mp4'})}));
      assert.equal(created.status,expected,`create for ${user?.id || 'local'}`);
      await new Promise(resolve=>setImmediate(resolve));
      project={...project,duration:3,status:'ready'};
      const rendered=await editRoute.PATCH(new NextRequest('http://localhost/api/motion/motion_quota',{method:'PATCH',body:JSON.stringify({...edit,action:'render'})}),{params:Promise.resolve({id:project.id})});
      assert.equal(rendered.status,expected,`render for ${user?.id || 'local'}`);
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(claims,expected===202 ? 1 : 0);
      assert.equal(runs,expected===202 ? 2 : 0);
      assert.equal(locked,false);
      assert.deepEqual(JSON.parse(fs.readFileSync(process.env.GENERATION_LIMIT_PATH,'utf8')),ledger);
    }
  } finally {
    if(saved===undefined)delete process.env.GENERATION_LIMIT_PATH;else process.env.GENERATION_LIMIT_PATH=saved;
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});

test('zero-length ASR words stay in the transcript at the adjacent speech timestamp', () => {
  const cues=normalizeTranscription({words:[{start:0.1,end:0.3,word:'反'},{start:0.3,end:0.3,word:'应'},{start:0.3,end:0.8,word:'很快'}]},1);
  assert.deepEqual(cues,[{start:0.1,end:0.8,text:'反应很快'}]);
});

test('segment transcript preserves percent signs and complete sentence boundaries', () => {
  const cues=normalizeTranscription({segments:[{start:0,end:1,text:'20%的人创造80%的业绩'}],words:[{start:0,end:1,word:'20的人创造80的业绩'}]},2);
  assert.equal(cues[0].text,'20%的人创造80%的业绩');
});

test('Chinese ASR defaults to simplified text without changing timing, English or numbers', () => {
  const segments=[{start:0.12,end:3.5,text:'為什麽找我們做企業AI落地？20%創造80%的業績。'}];
  assert.deepEqual(normalizeTranscription({segments},4),[{start:0.12,end:3.5,text:'为什么找我们做企业AI落地？20%创造80%的业绩。'}]);
  assert.deepEqual(normalizeTranscription({words:[{start:0,end:1,word:'團隊'},{start:1,end:2,word:'串聯工具'}]},3),[{start:0,end:2,text:'团队串联工具'}]);
});

test('summary text and highlights convert together so simplified highlights remain grounded', () => {
  const captions=[{start:1,end:4,text:'團隊創造80%的業績'}];
  const scenes=scenesFromCueGroups([{first:0,last:0,headline:'企業AI的價值',line1:'團隊創造80%的業績',line2:'工具串聯起來',highlight:'80%的业绩'}],captions);
  assert.deepEqual(scenes,[{start:1,end:4,headline:'企业AI的价值',line1:'团队创造80%的业绩',line2:'工具串联起来',highlight:'80%的业绩'}]);
  assert.equal(captions[0].text,'團隊創造80%的業績');
});

test('summary groups are fixed to one or two adjacent sentences, not an entire monologue', () => {
  const cues=Array.from({length:8},(_,i)=>({start:i*2.5,end:(i+1)*2.5,text:`句子${i}`}));
  assert.deepEqual(motionSummaryGroups(cues).map(g=>[g.first,g.last]),[[0,1],[2,3],[4,5],[6,7]]);
  assert.equal(motionSummaryGroups([{start:0,end:9,text:'长句'},{start:9,end:18,text:'长句2'}]).length,2);
});
