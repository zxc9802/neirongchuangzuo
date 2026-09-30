import {canAccessEffect} from '@/lib/motion-library/access';
import 'server-only';
import crypto from 'node:crypto';
import {NextRequest,NextResponse} from 'next/server';
import {resolveAccessContext,unauthorizedResponse,taskNotFoundResponse,type AccessContext} from '@/lib/access-control';
import {resolveOwnedUpload,claimPendingUploads} from '@/lib/server/upload-policy';
import {acquireGenerationSlot,GenerationLimitError} from '@/lib/server/generation-limit';
import {isExternallyBilledUser} from '@/lib/main-app-billing';
import {MotionInputError} from '@/lib/motion/contract';
import {logServerError} from '@/lib/server/safe-log';
import {EffectStore,publicEffect,type StoredAsset,type StoredEffect} from './store';
import {runLibraryEffect} from './pipeline';
import type {EffectRef} from './contract';
import {getBuiltinEffect} from './builtins';
export async function ownedEffectVersion(ref:EffectRef, access:AccessContext) {
  const builtin=getBuiltinEffect(ref.id);
  const builtinVersion=builtin?.versions.find(v=>v.revision===ref.revision);
  if(builtin&&builtinVersion&&(!access.isolated||access.userId))return {row:builtin,version:builtinVersion};
  const row=await EffectStore.get(ref.id),version=row?.versions.find(v=>v.revision===ref.revision);
  if(!row||!canAccessEffect(access,row)||!row.saved||!version)throw new MotionInputError('所选动效不可用，请从自己的动效库重新选择');
  return {row,version};
}
export async function editLibrary(req:NextRequest,id?:string) {
  const access=await resolveAccessContext(req);if(access.isolated&&!access.userId)return unauthorizedResponse();
  let release:(()=>void)|undefined,claimed:string|undefined;
  try {
    if(id&&getBuiltinEffect(id))return NextResponse.json({error:'内置固定模板无需生成或保存，请直接应用到成片'},{status:400});
    let row=id?await EffectStore.get(id):undefined;
    if(id&&(!row||!canAccessEffect(access,row)))return taskNotFoundResponse();
    if(row&&(row.status==='building'||!EffectStore.claim(row.id)))return NextResponse.json({error:'动效正在生成，请稍候'},{status:409});
    if(row)claimed=row.id;
    const raw=await req.text();if(raw.length>20000)throw new MotionInputError('描述内容过长');
    const body=JSON.parse(raw);
    if(body.action==='save'){
      if(!row?.revision||row.status!=='ready')throw new MotionInputError('请先完成动效生成');
      const next=await EffectStore.save({...row,saved:true});return NextResponse.json({effect:publicEffect(next,true)});
    }
    if(body.action!=='generate')throw new MotionInputError('无效操作');
    if(!process.env.MOTION_AGENT_API_KEY||!process.env.MOTION_AGENT_BASE_URL||!process.env.MOTION_AGENT_MODEL)throw new MotionInputError('动效创作服务尚未配置');
    const prompt=typeof body.prompt==='string'?body.prompt.trim():'';
    if(!prompt||prompt.length>4000)throw new MotionInputError('请填写 1–4000 字的动效需求');
    const uploads=body.uploads??[];if(!Array.isArray(uploads)||uploads.length+(row?.assets.length||0)>4)throw new MotionInputError('每个动效最多使用 4 个素材');
    const added:StoredAsset[]=[];
    for(const item of uploads){
      if(!item||!['image','video'].includes(item.kind))throw new MotionInputError('素材类型无效');
      const uploaded=await resolveOwnedUpload({key:item.key,userId:access.userId,folder:item.kind==='image'?'thumbnails':'videos'});
      if(!uploaded||uploaded.size>(item.kind==='image'?10:100)*1024*1024)throw new MotionInputError('素材无效或过大，图片最多 10 MB、视频最多 100 MB');
      added.push({id:`asset_${crypto.randomUUID()}`,name:typeof item.name==='string'?item.name.slice(0,120):'参考素材',kind:item.kind,source:uploaded.source,width:0,height:0,duration:0,description:''});
    }
    release=acquireGenerationSlot(`motion:${access.userId||'local'}`,{enforceHourlyLimit:isExternallyBilledUser(access.session?.user)||access.session?.user.billingAudience==='standalone'});
    if(!claimPendingUploads({keys:uploads.map((a:{key:string})=>a.key),userId:access.userId}))throw new MotionInputError('素材上传凭证已过期或已使用，请重新上传');
    if(!row){row={id:`effect_${crypto.randomUUID()}`,userId:access.userId||undefined,name:typeof body.name==='string'&&body.name.trim()?body.name.trim().slice(0,40):'我的动效',status:'building',message:'正在准备动效',saved:false,revision:0,updatedAt:Date.now(),messages:[],assets:[],versions:[]};EffectStore.claim(row.id);claimed=row.id;}
    const next=await EffectStore.save({...row,name:typeof body.name==='string'&&body.name.trim()?body.name.trim().slice(0,40):row.name,status:'building',message:'正在设计动效',error:undefined,assets:[...row.assets,...added],messages:[...row.messages,{role:'user',content:prompt}]});
    const done=release;release=undefined;claimed=undefined;
    void runLibraryEffect(next.id).catch(e=>logServerError('motion-library.crash',e)).finally(()=>{done();EffectStore.release(next.id);});
    return NextResponse.json({effect:publicEffect(next,true)},{status:202});
  }catch(error){
    if(error instanceof MotionInputError||error instanceof SyntaxError||error instanceof GenerationLimitError)return NextResponse.json({error:error instanceof SyntaxError?'提交格式无效':error.message},{status:error instanceof GenerationLimitError?error.status:400});
    logServerError('motion-library.edit',error);return NextResponse.json({error:'动效操作失败，请重试'},{status:500});
  }finally{release?.();if(claimed)EffectStore.release(claimed);}
}
