import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {downloadTrustedMediaToFile} from '@/lib/server/media-response';
import {execMediaCommand,probeMedia} from '@/lib/engine/ffmpeg';
import {logServerError} from '@/lib/server/safe-log';
import {CosService} from '@/lib/cos';
import {EffectStore,effectDirectory,type StoredAsset,type EffectVersion} from './store';
import {validateEffectBackground, EFFECT_SAMPLE} from './contract';
import {classifyTemplate, prepareSemanticScenes} from './semantics';
export function runEffectProcess(input:string,onMessage:(message:string)=>void) {
  return new Promise<void>((resolve,reject)=>{
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:process.env.NODE_ENV,MOTION_AGENT_API_KEY:process.env.MOTION_AGENT_API_KEY,MOTION_AGENT_BASE_URL:process.env.MOTION_AGENT_BASE_URL,MOTION_AGENT_MODEL:process.env.MOTION_AGENT_MODEL,REMOTION_BROWSER_EXECUTABLE:process.env.REMOTION_BROWSER_EXECUTABLE};
    const child=spawn(process.execPath,[path.resolve('scripts/generate-library-effect.mjs'),input],{env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    let pending='',errors='',settled=false;
    const stop=()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){stop();reject(error);}else resolve();};
    const timer=setTimeout(()=>finish(new Error('Effect generation timed out')),10*60_000);
    child.stdout.on('data',chunk=>{pending+=chunk;const lines=pending.split('\n');pending=lines.pop()||'';for(const line of lines)try{const e=JSON.parse(line);if(typeof e.message==='string')onMessage(e.message.slice(0,120));}catch{}});
    child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-1800);});
    child.on('error',finish);child.on('close',code=>finish(code===0?undefined:new Error(`Effect worker failed (${code}): ${errors}`)));
  });
}
export async function probeEffectAsset(file:string,kind:StoredAsset['kind']) {
  if(kind==='video')return probeMedia(file);
  const data=JSON.parse(await execMediaCommand('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',file]));
  return {width:Number(data.streams?.[0]?.width)||undefined,height:Number(data.streams?.[0]?.height)||undefined,durationSeconds:0};
}
async function prepareAsset(asset:StoredAsset,id:string):Promise<StoredAsset> {
  const dir=effectDirectory(id),file=path.join(dir,asset.id+(asset.kind==='image'?'.jpg':'.mp4'));
  const raw=path.join(dir,asset.id+'.input');
  if(!fs.existsSync(file)){
    await downloadTrustedMediaToFile({source:asset.source,outputPath:raw,maxBytes:asset.kind==='image'?10*1024*1024:100*1024*1024});
    const probe=await probeEffectAsset(raw,asset.kind);if(!probe.width||!probe.height||probe.width>16384||probe.height>16384)throw new Error('Invalid asset dimensions');
    if(asset.kind==='image')await execMediaCommand('ffmpeg',['-v','error','-y','-i',raw,'-frames:v','1','-vf',"scale='min(1280,iw)':-2",'-q:v','3',file]);
    else await execMediaCommand('ffmpeg',['-v','error','-y','-i',raw,'-t','15','-an','-vf',"scale='min(960,iw)':-2,fps=24",'-c:v','libx264','-preset','fast','-crf','25','-pix_fmt','yuv420p','-movflags','+faststart',file]);
    fs.rmSync(raw,{force:true});
  }
  const probe=await probeEffectAsset(file,asset.kind);
  const pixel=path.join(dir,asset.id+'.rgb');
  await execMediaCommand('ffmpeg',['-v','error','-y','-i',file,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24',pixel]);
  const color=fs.readFileSync(pixel).subarray(0,3).toString('hex');fs.rmSync(pixel,{force:true});
  return {...asset,source:file,width:probe.width!,height:probe.height!,duration:asset.kind==='video'?probe.durationSeconds:0,description:`${asset.kind==='image'?'图片':'无声循环视频'}，${probe.width}×${probe.height}${asset.kind==='video'?`，${probe.durationSeconds.toFixed(1)}秒`:''}。默认仅作风格参考，用户明确要求展示时才通过 Asset 加入画面。平均色 #${color.slice(0,6)}`};
}
export async function runLibraryEffect(id:string) {
  let row=await EffectStore.get(id);if(!row)return;
  let queue=Promise.resolve();
  const update=(message:string)=>{queue=queue.then(async()=>{row=await EffectStore.save({...row!,message});});};
  try {
    const dir=effectDirectory(id);fs.mkdirSync(dir,{recursive:true});
    update('正在准备参考素材');await queue;
    const assets:StoredAsset[]=[];for(const asset of row.assets)assets.push(await prepareAsset(asset,id));
    row=await EffectStore.save({...row,assets,message:'正在判断模板是否需要理解内容'});
    const semantics=await classifyTemplate({messages:row.messages.slice(-16),assets:assets.map(a=>({description:a.description})),currentCode:row.versions.at(-1)?.sourceCode||''});
    row=await EffectStore.save({...row,message:semantics.required?'需要理解内容，正在准备图解示例':'无需额外内容分析，正在设计动效'});
    const sample=semantics.required?{...EFFECT_SAMPLE,headline:'经验变成团队能力',line1:'沉淀销冠经验',line2:'让新人也能复用',highlight:'复用'}:EFFECT_SAMPLE;
    const prepared=await prepareSemanticScenes({effect:{id,revision:row.revision+1},policy:semantics,scenes:[sample],captions:[{start:0,end:6,text:'把销冠的经验沉淀成知识库，让新人也能复用。'}]});
    const input=path.join(dir,'agent-input.json');
    fs.writeFileSync(input,JSON.stringify({dir,semantics,previewScenes:prepared.scenes,messages:row.messages.slice(-16),assets:assets.map(a=>({...a,url:a.source})),currentCode:row.versions.at(-1)?.sourceCode||'',backgroundColor:row.versions.at(-1)?.backgroundColor,name:row.name}),{mode:0o600});
    await runEffectProcess(input,update);await queue;
    const result=JSON.parse(fs.readFileSync(path.join(dir,'agent-result.json'),'utf8'));
    const backgroundColor=validateEffectBackground(result.backgroundColor);
    const revision=row.revision+1,preview=path.join(dir,`preview-${revision}.mp4`);
    fs.copyFileSync(path.join(dir,'candidate.mp4'),preview);
    fs.copyFileSync(path.join(dir,'agent-evidence.json'),path.join(dir,`agent-evidence-${revision}.json`));
    let storedPreview=preview;
    const storedAssets:StoredAsset[]=[];
    for(const a of assets)storedAssets.push({...a,source:CosService.isConfigured()?await CosService.uploadFile(a.source,`jobs/${id}/${path.basename(a.source)}`):a.source});
    if(CosService.isConfigured())storedPreview=await CosService.uploadFile(preview,`jobs/${id}/${path.basename(preview)}`);
    const version:EffectVersion={revision,sourceCode:result.sourceCode,compiled:result.compiled,preview:storedPreview,assets:storedAssets,backgroundColor,semantics};
    await EffectStore.save({...row,revision,status:'ready',message:'动效已生成，可预览并继续修改',error:undefined,assets:storedAssets,versions:[...row.versions,version],messages:[...row.messages,{role:'assistant',content:result.summary||'动效已完成并通过试渲染。可以预览、继续修改或保存应用。'}]});
  }catch(error){await queue.catch(()=>{});logServerError('motion-library.generate',error);await EffectStore.save({...row!,status:'failed',message:'生成失败，可调整描述后重试',error:row!.revision?'本次生成未完成，之前可用的版本已保留。请重试或调整描述。':'本次生成未完成，请重试或调整描述。'});}
}
