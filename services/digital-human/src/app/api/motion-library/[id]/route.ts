import {canAccessEffect} from '@/lib/motion-library/access';
import {NextRequest,NextResponse} from 'next/server';
import {resolveAccessContext,unauthorizedResponse,taskNotFoundResponse} from '@/lib/access-control';
import {EffectStore,publicEffect} from '@/lib/motion-library/store';
import {editLibrary} from '@/lib/motion-library/service';
import {publicBuiltinEffect} from '@/lib/motion-library/builtins';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(req:NextRequest,ctx:Context){
  const access=await resolveAccessContext(req);if(access.isolated&&!access.userId)return unauthorizedResponse();
  const id=(await ctx.params).id,builtin=publicBuiltinEffect(id,true);
  if(builtin){const selected=req.nextUrl.searchParams.has('revision')?publicBuiltinEffect(id,true,Number(req.nextUrl.searchParams.get('revision'))):builtin;if(!selected)return taskNotFoundResponse();return NextResponse.json({effect:selected},{headers:{'Cache-Control':'no-store'}});}
  const row=await EffectStore.get(id);if(!row||!canAccessEffect(access,row))return taskNotFoundResponse();
  const revision=req.nextUrl.searchParams.has('revision')?Number(req.nextUrl.searchParams.get('revision')):row.revision;
  if(revision!==0&&!row.versions.some(v=>v.revision===revision))return taskNotFoundResponse();
  return NextResponse.json({effect:publicEffect(row,true,revision)},{headers:{'Cache-Control':'no-store'}});
}
export const PATCH=async(req:NextRequest,ctx:Context)=>editLibrary(req,(await ctx.params).id);
