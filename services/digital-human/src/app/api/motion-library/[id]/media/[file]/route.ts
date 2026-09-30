import {canAccessEffect} from '@/lib/motion-library/access';
import path from 'node:path';
import {NextRequest} from 'next/server';
import {resolveAccessContext,unauthorizedResponse,taskNotFoundResponse} from '@/lib/access-control';
import {servePrivateMedia,isTrustedTaskOutputSource} from '@/lib/server/media-response';
import {EffectStore} from '@/lib/motion-library/store';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(req:NextRequest,ctx:{params:Promise<{id:string;file:string}>}){
  const access=await resolveAccessContext(req);if(access.isolated&&!access.userId)return unauthorizedResponse();
  const {id,file}=await ctx.params,row=await EffectStore.get(id);if(!row||!canAccessEffect(access,row))return taskNotFoundResponse();
  const preview=row.versions.find(v=>file===`preview-${v.revision}.mp4`);
  const asset=row.versions.flatMap(v=>v.assets).find(a=>file===a.id+(a.kind==='image'?'.jpg':'.mp4'));
  const source=preview?.preview||asset?.source;
  if(!source||!isTrustedTaskOutputSource(source,id,[file])||path.basename(file)!==file)return taskNotFoundResponse();
  return servePrivateMedia(req,source,{contentType:file.endsWith('.jpg')?'image/jpeg':'video/mp4'});
}
export const HEAD=GET;
