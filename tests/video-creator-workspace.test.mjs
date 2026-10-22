import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCreatorStore } from '../services/video-creator/store.mjs';
import { applyWorkspaceChanges } from '../services/video-creator/workspace.mjs';
import { createWorkspaceSync } from '../design/video-creator-sync.js';
const draft = (id,text='内容')=>({id,input:text,prompt:'',title:text,skill:'store-discovery'});
const change=(collection,id,value,revision=0)=>({collection,id,value,revision});
test('workspace persistence isolates accounts, rejects stale writes and keeps deletion tombstones after restart',async t=>{
  const root=await mkdtemp(join(tmpdir(),'creator-workspace-'));let store=createCreatorStore(root);await store.ready;
  t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true});});
  let doc=await store.updateWorkspace('alice',[change('drafts','draft1',draft('draft1'))]);
  assert.equal((await store.readWorkspace('bob')).revision,0);
  await assert.rejects(store.updateWorkspace('alice',[change('drafts','draft1',draft('draft1','其他设备'))]),e=>e.status===409);
  assert.equal(doc.entries['drafts/draft1'].value.input,'内容');
  doc=await store.updateWorkspace('alice',[change('drafts','draft1',null,doc.entries['drafts/draft1'].revision)]);
  await store.close();store=createCreatorStore(root);await store.ready;
  assert.equal((await store.readWorkspace('alice')).entries['drafts/draft1'].value,null);
  await assert.rejects(store.updateWorkspace('alice',[change('drafts','draft1',draft('draft1'))]),e=>e.status===409);
});
test('folder trees and moves reject cycles and deletion of populated folders atomically',()=>{
  let doc={revision:0,entries:{}};
  doc=applyWorkspaceChanges(doc,[change('folders','parent',{id:'parent',name:'门店',parentId:null}),change('folders','child',{id:'child',name:'环境',parentId:'parent'}),change('asset-meta','photo',{id:'photo',folderId:'child'})]);
  assert.throws(()=>applyWorkspaceChanges(doc,[change('folders','parent',{id:'parent',name:'门店',parentId:'child'},1)]),e=>e.status===400);
  assert.throws(()=>applyWorkspaceChanges(doc,[change('folders','child',null,2)]),e=>e.status===400);
  const next=applyWorkspaceChanges(doc,[change('asset-meta','photo',{id:'photo',folderId:null},3),change('folders','child',null,2)]);
  assert.equal(next.entries['folders/child'].value,null);assert.ok(doc.entries['folders/child'].value);
});
function devices(t) {
  let remote={revision:0,entries:{}}, offline=false;
  const make=(seed={},protect=()=>null)=>{
    const local=structuredClone(seed),conflicts=[];
    const sync=createWorkspaceSync({read:(k,f)=>structuredClone(local[k]??f),write:(k,v)=>{local[k]=structuredClone(v);},protect,conflict:(...v)=>conflicts.push(v),
      request:async(_path,opts)=>{if(offline)throw Error('offline');if(opts)remote=applyWorkspaceChanges(remote,JSON.parse(opts.body).changes);return structuredClone(remote);}});
    t.after(()=>sync.close());return {local,sync,conflicts};
  };return {make,setOffline:v=>offline=v,read:()=>remote};
}
test('two browsers merge independent favorites and preserve simultaneous draft edits as a conflict copy',async t=>{
  const d=devices(t),a=d.make();a.sync.set('drafts',[draft('one')]);await a.sync.sync();
  const b=d.make({},()=> 'one');await b.sync.sync();assert.equal(b.local.drafts[0].input,'内容');
  a.sync.set('drafts',[draft('one','A版本')]);await a.sync.sync();
  b.sync.set('drafts',[draft('one','B版本')]);await b.sync.sync();
  assert.equal(b.local.drafts.length,2);assert.ok(b.local.drafts.some(x=>x.input==='A版本'));assert.ok(b.local.drafts.some(x=>x.input==='B版本'));
  a.sync.set('favorites',['videoA']);b.sync.set('favorites',['videoB']);await a.sync.sync();await b.sync.sync();await a.sync.sync();
  assert.deepEqual(a.local.favorites.sort(),['videoA','videoB']);
});
test('offline edits survive reload, migrate once, and deleted prompts do not resurrect',async t=>{
  const d=devices(t),a=d.make({prompts:[{id:'prompt',title:'提示词',prompt:'原始内容'}]});await a.sync.sync();
  d.setOffline(true);a.sync.set('drafts',[draft('offline','离线草稿')]);await a.sync.sync();assert.equal(a.sync.status,'offline');a.sync.close();
  const b=d.make(a.local);d.setOffline(false);await b.sync.sync();assert.equal(b.local.drafts[0].input,'离线草稿');
  b.sync.set('prompts',[]);await b.sync.sync();await a.sync.sync();
  const c=d.make();await c.sync.sync();assert.deepEqual(c.local.prompts,[]);assert.equal(d.read().entries['prompts/prompt'].value,null);
});
test('remote updates do not silently replace a draft currently being edited',async t=>{
  const d=devices(t),a=d.make();a.sync.set('drafts',[draft('one')]);await a.sync.sync();
  const b=d.make({},()=> 'one');await b.sync.sync();
  a.sync.set('drafts',[draft('one','远端更新')]);await a.sync.sync();await b.sync.sync();assert.equal(b.local.drafts[0].input,'内容');
  b.sync.set('drafts',[draft('one','本机继续编辑')]);await b.sync.sync();assert.equal(b.local.drafts.length,2);
});
