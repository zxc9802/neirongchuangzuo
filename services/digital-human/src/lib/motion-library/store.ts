import type {SemanticPolicy} from './visual';
import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import {getAppConfig} from '@/lib/config';
import {CosService} from '@/lib/cos';
import {isEffectId, type LibraryEffect, type EffectAsset, type EffectMessage} from './contract';
export interface StoredAsset extends Omit<EffectAsset,'url'> {source:string}
export interface EffectVersion {revision:number; sourceCode:string; compiled:string; preview:string; assets:StoredAsset[]; backgroundColor?:string; semantics?:SemanticPolicy}
export interface StoredEffect {
  id:string; userId?:string; name:string; status:LibraryEffect['status']; message:string; error?:string;
  saved:boolean; revision:number; updatedAt:number; messages:EffectMessage[]; assets:StoredAsset[]; versions:EffectVersion[];
}
const root=globalThis as typeof globalThis & {effectStore?:{loaded:boolean;rows:StoredEffect[];queue:Promise<unknown>;active:Set<string>}};
const state=root.effectStore??={loaded:false,rows:[],queue:Promise.resolve(),active:new Set()};
const file=()=>path.join(getAppConfig().storageDir,'..','state','motion-library.json');
export function effectDirectory(id:string){if(!isEffectId(id))throw new Error('Invalid effect ID');return path.join(getAppConfig().storageDir,id);}
function serial<T>(fn:()=>Promise<T>):Promise<T>{const next=state.queue.then(fn,fn);state.queue=next.catch(()=>{});return next;}
async function load(){
  if(state.loaded)return;
  const local:StoredEffect[]=fs.existsSync(file())?JSON.parse(fs.readFileSync(file(),'utf8')):[];
  const remote=CosService.isConfigured()?await CosService.getJsonFromCos<StoredEffect[]>('_system/motion-library.json'):[];
  const rows=new Map(local.map(r=>[r.id,r]));for(const r of remote||[])if(!rows.has(r.id)||r.updatedAt>rows.get(r.id)!.updatedAt)rows.set(r.id,r);
  state.rows=[...rows.values()].map(r=>r.status==='building'?{...r,status:'failed',error:'生成因服务重启中断，可继续修改重试',message:'生成已中断'}:r);state.loaded=true;
}
export const EffectStore={
  list:()=>serial(async()=>{await load();return structuredClone(state.rows).sort((a,b)=>b.updatedAt-a.updatedAt);}),
  get:(id:string)=>serial(async()=>{await load();return structuredClone(state.rows.find(r=>r.id===id));}),
  save:(row:StoredEffect)=>serial(async()=>{await load();const next={...row,updatedAt:Date.now()},i=state.rows.findIndex(r=>r.id===row.id);if(i<0)state.rows.push(next);else state.rows[i]=next;
    fs.mkdirSync(path.dirname(file()),{recursive:true});fs.writeFileSync(file()+'.tmp',JSON.stringify(state.rows),{mode:0o600});fs.renameSync(file()+'.tmp',file());
    if(CosService.isConfigured())await CosService.saveJsonToCos('_system/motion-library.json',state.rows);return structuredClone(next);}),
  claim:(id:string)=>{if(state.active.has(id))return false;state.active.add(id);return true;},
  release:(id:string)=>{state.active.delete(id);},
};
export function publicEffect(row:StoredEffect, detail=false, revision=row.revision):LibraryEffect {
  const version=row.versions.find(v=>v.revision===revision);
  const assets=(version?.assets||row.assets).map(({source,...a})=>({...a,url:`/api/motion-library/${row.id}/media/${a.id}${a.kind==='image'?'.jpg':'.mp4'}`}));
  return {id:row.id,name:row.name,status:row.status,message:row.message,error:row.error,saved:row.saved,semantics:version?.semantics,revision,updatedAt:row.updatedAt,messages:detail?row.messages:[],assets,previewUrl:version?`/api/motion-library/${row.id}/media/preview-${revision}.mp4`:undefined,...(detail&&version?{template:{compiled:version.compiled,assets,backgroundColor:version.backgroundColor,semantics:version.semantics}}:{})};
}
