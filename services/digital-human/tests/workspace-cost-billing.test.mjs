import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'dh-actual-cost-'));
const saved=Object.fromEntries(['AUTH_DATABASE_URL','WORKSPACE_DATA_DIR','NODE_ENV','CREDITS_BILLING_MODE'].map(key=>[key,process.env[key]]));
delete process.env.AUTH_DATABASE_URL;
process.env.WORKSPACE_DATA_DIR=root;process.env.NODE_ENV='test';process.env.CREDITS_BILLING_MODE='api_cost';
const billing=await import('../src/lib/main-app-billing.ts');
const {getWorkspaceCreditsLedger}=await import('../src/lib/server/workspace-credits.ts');
const ledger=getWorkspaceCreditsLedger();await ledger.ready;
const workers=await import('../src/lib/server/task-worker.ts');
const publicData=await import('../src/lib/server/public-data.ts');
test.after(async()=>{
  await ledger.close();
  for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())));fs.rmSync(root,{recursive:true,force:true});
});
const user=id=>({id,role:'member',billingAudience:'standalone'});
const reserve=(id,seconds=30)=>billing.reserveMainAppCredits({user:user(id),taskId:id+'-task',estimatedDuration:seconds});
const settle=(id,seconds)=>billing.settleMainAppCredits({userId:id,requestId:id+'-task',actualDuration:seconds,source:'workspace',chargedPoints:1});
function loadSource(relative,deps){
  const code=ts.transpileModule(fs.readFileSync(new URL(relative,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},module,module.exports);
  return module.exports;
}

test('80 seconds of digital human or audio costs 8 CNY and 1000 shared credits, exactly once',async()=>{
  const reserved=await reserve('eighty',80);assert.equal(reserved.mode,'api_cost');assert.equal(reserved.reservedPoints,1000);
  assert.equal(reserved.costCny,8);
  const result=await settle('eighty',80);assert.equal(result.chargedPoints,1000);assert.equal(result.costCny,8);
  assert.equal((await settle('eighty',80)).chargedPoints,1000);assert.equal((await ledger.snapshot('eighty')).available,0);
  assert.equal(billing.calculateRequiredPoints(30,'workspace'),333,'old reservations retain the old rate');
  assert.equal(billing.calculateRequiredPoints(30,'workspace','api_cost'),375);
  assert.equal(billing.calculateRequiredPoints(30,'main-app'),600,'external SSO contract remains unchanged');
});
test('fractional seconds accumulate and unlimited accounts record cost without deducting points',async()=>{
  await reserve('fractions',1);
  assert.equal((await settle('fractions',1)).chargedPoints,13);
  await billing.reserveMainAppCredits({user:user('fractions'),taskId:'fraction-second',estimatedDuration:1});
  const next=await billing.settleMainAppCredits({userId:'fractions',requestId:'fraction-second',source:'workspace',actualDuration:1});
  assert.equal(next.chargedPoints,12);assert.equal((await ledger.snapshot('fractions')).available,975);
  await ledger.setUnlimited('unlimited',true);await reserve('unlimited',180);
  const free=await settle('unlimited',180);assert.equal(free.chargedPoints,0);assert.equal(free.costCny,18);
  assert.equal((await ledger.snapshot('unlimited')).available,1000);
});
test('actual audio extends its budget before lip-sync and cancellation restores unused funds',async()=>{
  const reservation=await reserve('coverage',6);
  const taskBilling={...reservation,isExternalUser:true,status:'reserved'};
  assert.equal(reservation.reservedPoints,75);
  assert.equal(await billing.extendTaskCreditCoverage({userId:'coverage',billing:taskBilling,durationSeconds:30}),375);
  await assert.rejects(billing.extendTaskCreditCoverage({userId:'coverage',billing:taskBilling,durationSeconds:90}),error=>error.status===402);
  assert.equal((await ledger.snapshot('coverage')).held,375);
  await billing.releaseMainAppCredits({userId:'coverage',requestId:reservation.requestId,source:'workspace'});
  assert.equal((await ledger.snapshot('coverage')).available,1000);
  await assert.rejects(billing.assertWorkspaceReservationActive('coverage',reservation.requestId),error=>error.code==='BILLING_RESERVATION_CLOSED');
  await assert.rejects(reserve('too-long',81),error=>error.status===402);
  assert.equal((await ledger.snapshot('too-long')).held,0);
});
test('MP3 and complete digital-human pipelines settle their single aggregate receipt using measured duration',async()=>{
  const savedCwd=process.cwd();process.chdir(root);
  try{for(const outputType of ['audio','video']){
    const id='pipeline-'+outputType,reservation=await reserve(id,6);
    const source=path.join(root,id+'.mp4'),speaker=path.join(root,id+'.wav');fs.writeFileSync(source,'fixture');fs.writeFileSync(speaker,'fixture');
    let task={id:reservation.requestId,userId:id,status:'pending',createdAt:Date.now(),updatedAt:Date.now(),progress:0,logs:[],
      billing:{...reservation,isExternalUser:true,status:'reserved'},
      inputs:{outputType,videoPath:source,scriptText:'fixture',speakerAudioUrl:speaker,videoFit:'smart',lipsyncProvider:'veed'},results:{}};
    const TaskStore={get:()=>task,isDeleted:()=>false,addLog:(_id,message)=>task.logs.push({message}),
      update:(_id,value)=>task={...task,...value,results:{...task.results,...value.results}}};
    const probe={durationSeconds:30,width:160,height:120,fps:30,hasAudio:true};let ttsCalls=0,mouths=0;
    const deps={path,fs,crypto,
      '../server/safe-log':{logServerError:()=>undefined},
      './task-execution':{withTaskExecution:async(_id,action)=>action()},'../server/task-worker':workers,
      '../store/task-store':{TaskStore},'../config':{getAppConfig:()=>({storageDir:path.join(root,'jobs'),publicBaseUrl:'https://example.test',indexttsSpeakerAudioUrl:speaker})},
      './indextts':{generateIndexTTS:async(_script,options)=>{ttsCalls++;const file=path.join(options.outDir,'voice-track.wav');fs.writeFileSync(file,'fixture');return{finalWavPath:file,rawDuration:30,selectedDuration:30};}},
      './face-lipsync':{prepareFaceLipsync:async options=>({videoPath:source,audioPath:options.audioPath,durationSeconds:30.9}),finalizeFaceLipsync:async options=>{fs.writeFileSync(options.outputPath,'fixture');return probe;}},
      './scene-tail':{prepareSceneContinuation:async({inputPath})=>inputPath},'./video-preview':{createVideoPreview:async()=>undefined},
      './ffmpeg':{probeMedia:async()=>probe,sha256File:async()=> 'fixture-hash',encodeMp3:async(_input,output)=>fs.writeFileSync(output,'fixture'),
        prepareSourceVideo:async(_input,_seconds,output)=>{fs.writeFileSync(output,'fixture');return{duration:30,width:160,height:120};}},
      '../mcp/heygen-adapter':{HeyGenMcpAdapter:{}},'./openlux-lipsync':{OpenLuxLipsyncAdapter:{}},
      './fal-veed-lipsync':{FalVeedLipsyncAdapter:{execute:async options=>{mouths++;assert.equal((await ledger.reservation(id,reservation.requestId)).reservedPoints,375);
        await options.onProviderSubmitting?.();options.onProviderAccepted();options.onJobCreated({lipsyncId:'fixture-mouth'});return{lipsyncId:'fixture-mouth',status:'completed'};}}},
      '../cos':{CosService:{isConfigured:()=>false}},'../lipsync-provider':{resolveLipsyncProvider:()=> 'veed'},
      '../media-path-policy':{resolveAllowedLocalMediaPath:value=>value},'../server/media-response':{getTrustedExternalMediaUrl:async()=>{throw new Error('local fixture');}},
      '../main-app-billing':billing,'./narration-fallback':{deliverNarrationFallback:()=>null},
    };
    await loadSource('../src/lib/engine/pipeline.ts',deps).runDigitalHumanPipeline(task.id);
    assert.equal(task.status,'completed',JSON.stringify(task));assert.equal(task.billing.status,'settled');
    assert.equal(task.billing.costCny,3);assert.equal(task.results.chargedPoints,375);assert.equal(ttsCalls,1);assert.equal(mouths,outputType==='audio'?0:1);
    assert.equal(Object.keys((await ledger.reservation(id,reservation.requestId)).costItems).length,1);
    assert.equal((await ledger.snapshot(id)).available,625);assert.equal(publicData.isTaskOutputDeliverable(task),true);
  }}finally{process.chdir(savedCwd);}
});
test('recovering an existing MP3 records its real monetary cost without another synthesis or a second charge',async()=>{
  const id='recover-cost',reservation=await reserve(id,6),jobDir=path.join(root,'jobs',reservation.requestId);
  fs.mkdirSync(jobDir,{recursive:true});const file=path.join(jobDir,'voice-track.mp3');fs.writeFileSync(file,Buffer.alloc(2048));
  let task={id:reservation.requestId,userId:id,status:'failed',createdAt:Date.now(),updatedAt:Date.now(),logs:[],
    billing:{...reservation,isExternalUser:true,status:'settle_pending'},inputs:{outputType:'audio'},
    results:{exactAudioUrl:file,audioFormat:'mp3',audioDuration:999,costCny:0,chargedPoints:1}};
  const TaskStore={get:()=>task,getAsync:async()=>task,isDeleted:()=>false,addLog:()=>undefined,
    update:(_id,value)=>task={...task,...value,results:{...task.results,...value.results}}};
  const recovery=loadSource('../src/lib/engine/recover-lipsync.ts',{
    fs,path,'./video-preview':{},'../cos':{CosService:{isConfigured:()=>false}},'../lipsync-provider':{},
    '../store/task-store':{TaskStore},'./ffmpeg':{probeMedia:async()=>({durationSeconds:30,hasAudio:true}),sha256File:async()=> 'fixture'},
    './face-lipsync':{},'./narration-fallback':{deliverNarrationFallback:()=>assert.fail('cannot deliver a free fallback')},
    '../server/safe-log':{logServerError:()=>undefined},'./lipsync-chunks':{},
    './task-execution':{withTaskExecution:async(_id,action)=>action()},'./download-file':{},'./fal-veed-lipsync':{},
    './pixverse-ingest':{},'./openlux-lipsync':{},'../main-app-billing':billing,
    '../config':{getAppConfig:()=>({storageDir:path.join(root,'jobs')})},'../server/outbound-url-policy':{},
    '../server/media-response':{},'../task-output-retention':{isTaskOutputExpired:()=>false},
  });
  const result=await recovery.recoverStuckLipsyncTask(task.id);
  assert.equal(result.status,'completed');assert.equal(result.billing.chargedPoints,375);assert.equal(result.results.costCny,3);
  assert.equal(result.results.audioDuration,30);
  await recovery.recoverStuckLipsyncTask(task.id);assert.equal((await ledger.snapshot(id)).available,625);
});
