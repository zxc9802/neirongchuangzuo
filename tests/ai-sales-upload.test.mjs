import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountAiSales, disposeAiSales } from '../design/ai-sales.js';
import { SALES_SCENE_CHARACTER_RULES } from '../design/ai-sales-policy.js';

const settle = async () => { for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve)); };
const photo = name => new File(['photo'], name || '产品.jpg', {type:'image/jpeg'});
const transfer = files => ({types:['Files'], files, dropEffect:'none'});

async function fixture(t, {assets=[],operations=[],savedDirector,beforeUpload=async()=>{},beforeScript=async()=>({status:'queued'}),afterScript=async()=>{},afterVideo=async()=>{},beforePoll=async()=>{}}={}) {
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  const session={id:'test',assets,operations,tasks:[],version:0}, uploads=[],scriptRequests=[],videoRequests=[],jobPolls=[];
  const storage=new Map([['qiya-ai-sales-persona-v2:user',JSON.stringify({conversationId:session.id,directorMode:savedDirector})]]);
  const originals=Object.fromEntries(['document','window','localStorage','workspaceUser','fetch','setInterval'].map(key=>[key,globalThis[key]]));
  let active=0,peak=0,poll;
  globalThis.setInterval=(callback,ms,...args)=>{if(ms===4000)poll=callback;return originals.setInterval(callback,ms,...args);};
  Object.assign(globalThis,{document,window,workspaceUser:{id:'user',account:'zxc9911'},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},fetch:async(url,options={})=>{
    if(url.endsWith('/config'))return Response.json({directorEnabled:true,generationEnabled:true});
    if(url.endsWith('/quote'))return Response.json({points:3750,unlimited:true});
    if(url.endsWith('/sales-preset'))return Response.json({assets:[]});
    if(url.endsWith('/generate') && options.method==='POST') {
      const body=JSON.parse(options.body);videoRequests.push(body);
      let task=session.tasks.find(t=>t.id===body.requestId);
      if(!task){task={...body,id:body.requestId,status:'running'};session.tasks.push(task);}
      await afterVideo(task,body);return Response.json({task});
    }
    if(url.endsWith('/script') && options.method==='POST') {
      const body=JSON.parse(options.body);scriptRequests.push(body);
      let operation=session.operations.find(o=>o.id===body.requestId);
      if(!operation){operation={id:body.requestId,message:body.message,directorModel:body.directorModel,...await beforeScript(body)};session.operations.push(operation);}
      await afterScript(operation);
      return Response.json({operation,jobId:operation.id});
    }
    if(url.includes('/operations/')){jobPolls.push(url);await beforePoll();return Response.json({operation:session.operations.find(o=>o.id===url.split('/').at(-1))});}
    if(url.includes('/assets/') && options.method==='DELETE') {
      session.assets=session.assets.filter(a=>a.id!==url.split('/').at(-1));session.version++;
      return Response.json({conversation:session});
    }
    if(url.includes('/assets/') && options.method==='PUT') {
      uploads.push({file:options.body,purpose:options.headers['X-Asset-Purpose']});active++;peak=Math.max(peak,active);
      try { await beforeUpload(options.body); } finally { active--; }
      session.assets.push({id:url.split('/').at(-1),name:options.body.name,type:options.body.type.startsWith('audio/')?'audio':'image',purpose:options.headers['X-Asset-Purpose'],url:'/test.jpg'});
      session.version++;return Response.json({conversation:session});
    }
    if(url.endsWith('/conversations/test'))return Response.json({conversation:session});
    if(url.includes('/conversations?'))return Response.json({conversations:[]});
    throw new Error('Unexpected request: '+url);
  }});
  t.after(()=>{disposeAiSales();for(const [key,value] of Object.entries(originals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  const root=document.querySelector('main');
  mountAiSales(root,{toast:()=>{}});await settle();
  return {root,uploads,session,scriptRequests,videoRequests,jobPolls,async poll(){poll();await settle();},async reload(){disposeAiSales();root.innerHTML='';mountAiSales(root,{toast:()=>{}});await settle();},peak:()=>peak,zone:role=>root.querySelector(`[data-sales-drop="${role}"]`),event(type,target,fields={}) {
    const event=new window.Event(type,{bubbles:true,cancelable:true});
    Object.assign(event,{dataTransfer:transfer([]),...fields});target.dispatchEvent(event);return event;
  }};
}

const readyAssets=()=>[
  {id:'actor',type:'image',purpose:'character',name:'人物.jpg'},
  {id:'voice',type:'audio',purpose:'voice',name:'声音.wav'},
  {id:'scene',type:'image',purpose:'reference',name:'场景.jpg'},
];

test('legacy Gemini drafts migrate to Doubao and the PenShot entry is removed',async t=>{
  const ui=await fixture(t,{assets:readyAssets(),savedDirector:'gemini'});
  assert.equal(ui.root.querySelector('[data-director=doubao]').getAttribute('aria-pressed'),'true');
  assert.equal(ui.root.querySelector('[data-director=gemini]'),null);
  assert.equal(ui.root.querySelector('[data-planner]'),null);assert.doesNotMatch(ui.root.textContent,/PenShot|尚未配置/);
  ui.event('click',ui.root.querySelector('[data-sales=script]'));await settle();
  assert.equal(ui.scriptRequests[0].directorModel,'doubao');
});

test('script job polling survives a transient read failure and a page reload without resubmitting',async t=>{
  let fail=false;
  const ui=await fixture(t,{assets:readyAssets(),beforePoll:async()=>{if(fail)throw new Error('poll interrupted');}});
  ui.event('click',ui.root.querySelector('[data-sales=script]'));await settle();
  const jobId=ui.scriptRequests[0].requestId;
  fail=true;await ui.poll();
  assert.match(ui.root.querySelector('#sales-error').textContent,/poll interrupted/);
  fail=false;await ui.reload();await ui.poll();
  assert.equal(ui.jobPolls.at(-1),'/api/video-creator/conversations/test/operations/'+jobId);
  Object.assign(ui.session.operations[0],{status:'completed',result:{kind:'script',script:{title:'异步完成',shots:[]}}});
  await ui.poll();
  assert.match(ui.root.querySelector('#sales-script').textContent,/异步完成/);
  assert.equal(ui.root.querySelector('#sales-error').textContent,'');
  assert.equal(ui.scriptRequests.length,1);
});
for(const mode of ['kimi','haiku'])test(`sales defaults to Doubao, remembers ${mode} and dispatches the chosen director only on request`,async t=>{
  const ui=await fixture(t,{assets:readyAssets()});
  assert.equal(ui.root.querySelector('[data-director=doubao]').getAttribute('aria-pressed'),'true');
  ui.event('click',ui.root.querySelector(`[data-director=${mode}]`));await ui.reload();
  assert.equal(ui.root.querySelector(`[data-director=${mode}]`).getAttribute('aria-pressed'),'true');
  if(mode==='haiku')assert.match(ui.root.querySelector('#sales-mode-hint').textContent,/Claude Haiku 5.5/);
  assert.equal(ui.scriptRequests.length,0);
  ui.event('click',ui.root.querySelector('[data-sales=script]'));await settle();
  assert.equal(ui.scriptRequests[0].directorModel,mode);
  assert.ok(ui.root.querySelector('[data-director=direct]').disabled);
  ui.event('click',ui.root.querySelector('[data-director=doubao]'));
  assert.equal(ui.root.querySelector(`[data-director=${mode}]`).getAttribute('aria-pressed'),'true');
});
test('direct mode saves editable requirements and sends real image references without requesting a script',async t=>{
  const ui=await fixture(t,{assets:readyAssets()});
  ui.event('click',ui.root.querySelector('[data-director=direct]'));
  assert.ok(ui.root.querySelector('[data-sales=script]').hidden);
  assert.equal(ui.root.querySelector('[data-sales=generate]').disabled,false);
  const prompt=ui.root.querySelector('#sales-direct-prompt');
  assert.match(prompt.value,/图片1：出镜人物/);assert.match(prompt.value,/图片2：真实产品/);assert.match(prompt.value,/声音参考1/);
  assert.ok(prompt.value.includes(SALES_SCENE_CHARACTER_RULES));assert.doesNotMatch(prompt.value,/sceneFusionException/);
  prompt.value+='\n用产品特写开场';ui.event('input',prompt);await ui.reload();
  assert.equal(ui.root.querySelector('[data-director=direct]').getAttribute('aria-pressed'),'true');
  assert.match(ui.root.querySelector('#sales-direct-prompt').value,/用产品特写开场/);
  ui.event('click',ui.root.querySelector('[data-sales=generate]'));await settle();
  assert.equal(ui.scriptRequests.length,0);assert.equal(ui.videoRequests.length,1);
  const request=ui.videoRequests[0];assert.equal(request.directGeneration,true);assert.equal(request.scriptId,undefined);
  assert.deepEqual(request.referenceImageIds,['actor','scene']);assert.match(request.prompt,/用产品特写开场/);
  assert.ok(ui.root.querySelector('[data-sales=generate]').disabled);
});
for(const reload of [false,true])test(`a completed sales video can be generated again from the same script${reload?' after reload':''}`,async t=>{
  const script={title:'可重复生成的脚本',shots:[],videoPrompt:'同一份分镜提示词',referenceImageIds:['actor','scene']};
  const ui=await fixture(t,{assets:readyAssets(),beforeScript:async()=>({status:'completed',result:{kind:'script',script}})});
  ui.event('click',ui.root.querySelector('[data-sales=script]'));await settle();
  ui.event('click',ui.root.querySelector('[data-sales=generate]'));await settle();
  assert.equal(ui.videoRequests.length,1);
  assert.ok(ui.root.querySelector('[data-sales=generate]').disabled);
  const first=ui.videoRequests[0];ui.session.tasks[0].status='completed';
  if(reload)await ui.reload();else await ui.poll();
  assert.equal(ui.root.querySelector('[data-sales=generate]').disabled,false);
  assert.equal(ui.root.querySelector('[data-sales=generate]').textContent,'再次生成视频');
  ui.event('click',ui.root.querySelector('[data-sales=generate]'));await settle();
  assert.equal(ui.videoRequests.length,2);
  const second=ui.videoRequests[1];assert.notEqual(second.requestId,first.requestId);
  assert.equal(second.scriptId,first.scriptId);assert.equal(second.prompt,first.prompt);
  assert.deepEqual(second.referenceImageIds,first.referenceImageIds);
  assert.equal(ui.scriptRequests.length,1);
});
test('a lost second video response retries its unconfirmed ID instead of creating a third render',async t=>{
  let loseResponse=false;
  const script={title:'同一脚本',shots:[],videoPrompt:'保持同一份分镜',referenceImageIds:['actor','scene']};
  const ui=await fixture(t,{assets:readyAssets(),beforeScript:async()=>({status:'completed',result:{kind:'script',script}}),afterVideo:async()=>{if(loseResponse){loseResponse=false;throw new Error('连接中断');}}});
  ui.event('click',ui.root.querySelector('[data-sales=script]'));await settle();
  ui.event('click',ui.root.querySelector('[data-sales=generate]'));await settle();
  ui.session.tasks[0].status='completed';await ui.poll();
  loseResponse=true;ui.event('click',ui.root.querySelector('[data-sales=generate]'));await settle();
  assert.match(ui.root.querySelector('#sales-error').textContent,/连接中断/);
  assert.equal(ui.videoRequests.length,2);assert.equal(ui.session.tasks.length,2);
  assert.notEqual(ui.videoRequests[1].requestId,ui.videoRequests[0].requestId);
  ui.event('click',ui.root.querySelector('[data-sales=generate]'));await settle();
  assert.equal(ui.videoRequests.length,3);
  assert.equal(ui.videoRequests[2].requestId,ui.videoRequests[1].requestId);
  assert.equal(ui.session.tasks.length,2);
  await ui.reload();ui.event('click',ui.root.querySelector('[data-sales=generate]'));await settle();
  assert.equal(ui.videoRequests.length,3);assert.ok(ui.root.querySelector('[data-sales=generate]').disabled);
});
for(const status of ['uncertain','settling'])test(`${status} video outcomes stay locked instead of launching another paid task`,async t=>{
  const ui=await fixture(t,{assets:readyAssets(),savedDirector:'direct'});
  ui.event('click',ui.root.querySelector('[data-sales=generate]'));await settle();
  ui.session.tasks[0].status=status;await ui.poll();
  assert.equal(ui.root.querySelector('[data-sales=generate]').disabled,true);
  ui.event('click',ui.root.querySelector('[data-sales=generate]'));await settle();
  assert.equal(ui.videoRequests.length,1);
});
test('direct generation also creates a fresh render after completion without calling a director',async t=>{
  const ui=await fixture(t,{assets:readyAssets(),savedDirector:'direct'});
  ui.event('click',ui.root.querySelector('[data-sales=generate]'));await settle();
  ui.session.tasks[0].status='completed';await ui.reload();
  assert.equal(ui.root.querySelector('[data-sales=generate]').disabled,false);
  ui.event('click',ui.root.querySelector('[data-sales=generate]'));await settle();
  assert.equal(ui.videoRequests.length,2);assert.equal(ui.scriptRequests.length,0);
  assert.notEqual(ui.videoRequests[1].requestId,ui.videoRequests[0].requestId);
  assert.equal(ui.videoRequests[1].prompt,ui.videoRequests[0].prompt);
});
for(const reload of [false,true])test(`retrying a failed script creates a new operation${reload?' after reload':''}`,async t=>{
  let calls=0;
  const ui=await fixture(t,{assets:readyAssets(),beforeScript:async()=>++calls===1
    ?{status:'failed',error:'编导输出达到长度上限，未返回完整脚本。'}:{status:'queued'}});
  ui.event('click',ui.root.querySelector('[data-sales=script]'));await settle();
  assert.match(ui.root.querySelector('#sales-error').textContent,/长度上限/);
  if(reload)await ui.reload();
  ui.event('click',ui.root.querySelector('[data-sales=script]'));await settle();
  assert.notEqual(ui.scriptRequests[1].requestId,ui.scriptRequests[0].requestId);
  assert.equal(ui.session.operations.length,2);
  assert.equal(ui.session.operations.at(-1).status,'queued');
  assert.equal(ui.root.querySelector('#sales-error').textContent,'');
});

test('failed scripts allow deleting and replacing materials after reload',async t=>{
  const ui=await fixture(t,{assets:readyAssets(),operations:[{id:'failed',status:'failed',error:'编导输出达到长度上限'}]});
  await ui.reload();
  assert.equal(ui.zone('reference').querySelector('input').disabled,false);
  const remove=ui.root.querySelector('[data-sales=remove][data-id=scene]');assert.ok(remove);
  ui.event('click',remove);await settle();
  assert.equal(ui.session.assets.some(a=>a.id==='scene'),false);
  ui.event('drop',ui.zone('reference'),{dataTransfer:transfer([photo('新场景.jpg')])});await settle();
  assert.equal(ui.uploads.length,1);
  assert.equal(ui.session.operations[0].id,'failed');
});

test('a lost script response reuses its request ID until the outcome is known',async t=>{
  let requests=0;
  const ui=await fixture(t,{assets:readyAssets(),afterScript:async()=>{if(++requests===1)throw new Error('连接中断');}});
  ui.event('click',ui.root.querySelector('[data-sales=script]'));await settle();
  assert.match(ui.root.querySelector('#sales-error').textContent,/连接中断/);
  ui.event('click',ui.root.querySelector('[data-sales=script]'));await settle();
  assert.equal(ui.scriptRequests.length,2);
  assert.equal(ui.scriptRequests[1].requestId,ui.scriptRequests[0].requestId);
  assert.equal(ui.session.operations.length,1);
  assert.equal(ui.root.querySelector('#sales-error').textContent,'');
});

test('dropping a batch uploads every image once with at most three transfers in flight',async t=>{
  const releases=[];
  const ui=await fixture(t,{beforeUpload:()=>new Promise(resolve=>releases.push(resolve))});
  const zone=ui.zone('reference'),files=Array.from({length:5},(_,i)=>photo(`产品${i}.jpg`));
  assert.ok(zone.querySelector('input').hasAttribute('multiple'));
  assert.match(zone.textContent,/拖入多张图片/);
  const drop=ui.event('drop',zone.querySelector('input'),{dataTransfer:transfer(files)});
  await settle();
  assert.equal(drop.defaultPrevented,true);assert.equal(ui.uploads.length,3);assert.equal(ui.peak(),3);
  assert.equal(ui.event('dragover',zone).dataTransfer.dropEffect,'none');
  ui.event('drop',zone,{dataTransfer:transfer([photo('重复.jpg')])});
  assert.equal(ui.uploads.length,3);
  releases[2]();await settle();releases[0]();await settle();
  for(const release of releases)release();await settle();
  assert.deepEqual(ui.uploads.map(item=>item.file),files);
  assert.ok(ui.uploads.every(item=>item.purpose==='reference'));
  assert.equal(ui.root.querySelectorAll('#sales-materials figure').length,5);
  assert.equal(zone.querySelector('input').disabled,false);
  assert.equal(zone.getAttribute('aria-disabled'),'false');
});

test('a retained script remains visible after incomplete review without enabling video generation',async t=>{
  const ui=await fixture(t,{assets:[
    {id:'actor',type:'image',purpose:'character',name:'人物.jpg'},
    {id:'voice',type:'audio',purpose:'voice',name:'声音.wav'},
    {id:'scene',type:'image',purpose:'reference',name:'场景.jpg'},
  ],operations:[{id:'draft-op',status:'failed',error:'质量审核未完成，脚本已保留。',draftResult:{
    kind:'script',text:'已完成编排',script:{title:'保留的创作挑战',shots:[{start:0,end:30,visual:'真实门店',voiceover:'一起看看'}]},
  }}]});
  assert.match(ui.root.querySelector('#sales-script').textContent,/保留的创作挑战/);
  assert.match(ui.root.querySelector('#sales-script').textContent,/待审核脚本/);
  assert.equal(ui.root.querySelector('#sales-status').textContent,'待审核脚本');
  assert.equal(ui.root.querySelector('[data-sales=generate]').disabled,true);
});

test('file drag feedback follows zones and children, while outside drops cannot navigate away',async t=>{
  const ui=await fixture(t),zone=ui.zone('reference'),child=zone.querySelector('span');
  const enter=ui.event('dragenter',child);
  assert.equal(enter.defaultPrevented,true);assert.equal(enter.dataTransfer.dropEffect,'copy');
  assert.ok(zone.classList.contains('is-dragover'));
  ui.event('dragleave',child,{relatedTarget:zone.querySelector('input')});
  assert.ok(zone.classList.contains('is-dragover'));
  ui.event('dragover',ui.zone('voice'));
  assert.equal(zone.classList.contains('is-dragover'),false);
  ui.event('dragleave',ui.zone('voice'),{relatedTarget:ui.root});
  assert.equal(ui.root.querySelector('.is-dragover'),null);
  const text=ui.event('dragover',zone,{dataTransfer:{types:['text/plain']}});
  assert.equal(text.defaultPrevented,false);
  assert.equal(ui.event('drop',ui.root,{dataTransfer:transfer([photo()])}).defaultPrevented,true);
  ui.event('drop',zone);await settle();assert.equal(ui.uploads.length,0);
});

test('invalid batch type, size or total count is rejected before any file uploads',async t=>{
  const ui=await fixture(t,{assets:[{id:'actor',name:'人物.jpg',purpose:'character',type:'image',url:'/actor.jpg'}]});
  const oversized=photo();Object.defineProperty(oversized,'size',{value:50*1024*1024});
  for(const [files,error] of [
    [[photo(),new File(['text'],'说明.txt',{type:'text/plain'})],/图片支持/],
    [[photo(),oversized],/小于50MB/],
    [Array.from({length:30},()=>photo()),/最多上传30张/],
  ]) {
    ui.event('drop',ui.zone('reference'),{dataTransfer:transfer(files)});await settle();
    assert.match(ui.root.querySelector('#sales-error').textContent,error);assert.equal(ui.uploads.length,0);
  }
});

test('portrait and audio accept single drops, reject batches and never replace existing files',async t=>{
  const ui=await fixture(t),audio=new File(['audio'],'参考.wav',{type:'audio/wav'});
  for(const [role,file] of [['character',photo('人物.jpg')],['voice',audio]]) {
    ui.event('drop',ui.zone(role),{dataTransfer:transfer([file,file])});await settle();
    assert.match(ui.root.querySelector('#sales-error').textContent,/各支持1个文件/);
    ui.event('drop',ui.zone(role),{dataTransfer:transfer([file])});await settle();
    ui.event('drop',ui.zone(role),{dataTransfer:transfer([file])});await settle();
    assert.match(ui.root.querySelector('#sales-error').textContent,/先移除已有/);
  }
  assert.deepEqual(ui.uploads.map(item=>item.purpose),['character','voice']);
});

test('script-locked materials refuse drops and disposing removes drag handlers',async t=>{
  const ui=await fixture(t,{operations:[{id:'script',status:'completed'}]}),zone=ui.zone('reference');
  assert.equal(zone.getAttribute('aria-disabled'),'true');
  assert.equal(ui.event('dragover',zone).dataTransfer.dropEffect,'none');
  ui.event('drop',zone,{dataTransfer:transfer([photo()])});await settle();assert.equal(ui.uploads.length,0);
  disposeAiSales();
  assert.equal(ui.event('drop',zone,{dataTransfer:transfer([photo()])}).defaultPrevented,false);
});

test('a failed dropped upload unlocks controls and the multiple file picker still works',async t=>{
  let fail=true;
  const ui=await fixture(t,{beforeUpload:async()=>{if(fail)throw new Error('上传连接中断');}}),zone=ui.zone('reference');
  ui.event('drop',zone,{dataTransfer:transfer([photo()])});await settle();
  assert.match(ui.root.querySelector('#sales-error').textContent,/上传连接中断/);
  const input=zone.querySelector('input');assert.equal(input.disabled,false);fail=false;
  const files=[photo('产品一.jpg'),photo('产品二.jpg')];Object.defineProperty(input,'files',{value:files});input.value='picked';
  ui.event('change',input);await settle();
  assert.equal(input.value,'');assert.deepEqual(ui.uploads.slice(1).map(item=>item.file),files);
  assert.equal(ui.root.querySelectorAll('#sales-materials figure').length,2);
});
