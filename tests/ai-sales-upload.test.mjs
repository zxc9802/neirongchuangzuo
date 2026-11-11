import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountAiSales, disposeAiSales } from '../design/ai-sales.js';

const settle = async () => { for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve)); };
const photo = name => new File(['photo'], name || '产品.jpg', {type:'image/jpeg'});
const transfer = files => ({types:['Files'], files, dropEffect:'none'});

async function fixture(t, {assets=[],operations=[],beforeUpload=async()=>{}}={}) {
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  const session={id:'test',assets,operations,tasks:[],version:0}, uploads=[];
  const storage=new Map([['qiya-ai-sales-persona-v2:user',JSON.stringify({conversationId:session.id})]]);
  const originals=Object.fromEntries(['document','window','localStorage','workspaceUser','fetch'].map(key=>[key,globalThis[key]]));
  let active=0,peak=0;
  Object.assign(globalThis,{document,window,workspaceUser:{id:'user',account:'zxc9911'},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},fetch:async(url,options={})=>{
    if(url.endsWith('/config'))return Response.json({directorEnabled:true,generationEnabled:true});
    if(url.endsWith('/quote'))return Response.json({points:3750,unlimited:true});
    if(url.endsWith('/sales-preset'))return Response.json({assets:[]});
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
  return {root,uploads,session,peak:()=>peak,zone:role=>root.querySelector(`[data-sales-drop="${role}"]`),event(type,target,fields={}) {
    const event=new window.Event(type,{bubbles:true,cancelable:true});
    Object.assign(event,{dataTransfer:transfer([]),...fields});target.dispatchEvent(event);return event;
  }};
}

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
