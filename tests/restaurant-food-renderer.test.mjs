import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestLedger } from '../services/ai/request-ledger.mjs';
import { createFoodRenderer } from '../services/restaurant/food-renderer.mjs';
import { foodScene, foodPhotoPlan } from '../services/restaurant/scenes.mjs';
import { validateAnalysis, validateFoodAppearance, validateFoodRenderReview } from '../services/restaurant/rules.mjs';

const config={apiKey:'test-only',baseUrl:'https://provider.invalid/v1',imageModel:'test-image',limits:{imageDaily:20,chatDaily:100,perMinute:10}};
const reference=await sharp({create:{width:600,height:800,channels:3,background:'#eee2d2'}}).png().toBuffer();
const input={taskId:'same-task',scene:foodScene({foodSubjects:[{label:'肠粉'}],presentation:{cameraAngle:'oblique'}}),imageId:'photo-1',appearance:{description:'原图可见食物'},plan:foodPhotoPlan(foodScene({foodSubjects:[{label:'肠粉'}]})),photo:{bytes:reference,mime:'image/png'}};
async function harness(t,fetchImpl,extra={}) {
  const root=await mkdtemp(join(tmpdir(),'restaurant-scene-'));
  const ledger=createRequestLedger({storageDir:root,limits:config.limits});await ledger.ready;
  t.after(async()=>{await ledger.close();await rm(root,{recursive:true,force:true});});
  return {ledger,generate:createFoodRenderer({config,ledger,fetchImpl,...extra})};
}

test('food rephotography uses the configured image API and shared daily image budget, and cannot dispatch twice',async t=>{
  const requests=[];
  const app=await harness(t,async(url,options)=>{
    requests.push({url,options});
    return new Response(JSON.stringify({data:[{b64_json:reference.toString('base64')}],usage:{input_tokens:101,output_tokens:202}}),{headers:{'x-request-id':'scene-provider-1'}});
  });
  const result=await app.generate(input);
  assert.equal(requests.length,1);assert.equal(requests[0].url,'https://provider.invalid/v1/images/edits');
  const form=requests[0].options.body;assert.ok(form instanceof FormData);
  assert.equal(form.get('model'),'test-image');assert.equal(form.get('n'),'1');assert.match(form.get('prompt'),/街坊小餐馆/);
  assert.equal(form.getAll('image').length,1);assert.equal(requests[0].options.redirect,'error');
  const meta=await sharp(result.bytes).metadata();assert.equal(meta.width,1080);assert.equal(meta.height,1440);
  const summary=await app.ledger.summary();assert.equal(summary.used.image,1);assert.equal(summary.used.chat,0);
  const record=await app.ledger.get(result.requestId);assert.equal(record.status,'completed');assert.equal(record.providerRequestId,'scene-provider-1');
  await assert.rejects(app.generate(input),{code:'FOOD_RENDER_ALREADY_SENT'});assert.equal(requests.length,1);
});

test('uncertain food requests are recorded and never retried as local image-processing errors',async t=>{
  let attempts=0;
  const app=await harness(t,async()=>{attempts++;throw Error('connection dropped');});
  await assert.rejects(app.generate(input),{code:'PROVIDER_UNCERTAIN'});
  assert.equal((await app.ledger.summary()).recent[0].status,'uncertain');
  await assert.rejects(app.generate(input),{code:'FOOD_RENDER_ALREADY_SENT'});assert.equal(attempts,1);
});

test('only unsent rate-limited food calls wait, and provider errors are not automatically resent',async t=>{
  let attempts=0,reserves=0,waits=0;
  const ledger={async reserve(){if(++reserves===1)throw Object.assign(Error('busy'),{code:'RATE_LIMITED'});return {created:true};},async markDispatched(){},async finish(){}};
  const generate=createFoodRenderer({config,ledger,sleepImpl:async()=>{waits++;},fetchImpl:async()=>{attempts++;return new Response('{}',{status:429});}});
  await assert.rejects(generate(input),{code:'FOOD_RENDER_PROVIDER_ERROR'});assert.equal(attempts,1);assert.equal(waits,1);
});

test('invalid scenes and angles are ignored without rejecting otherwise usable photos',()=>{
  const image={imageId:'photo-1',imageType:'food',visibleObjects:['餐盘'],possibleScene:[],qualityScore:80,privacyRisk:'none',usable:true,rejectionReason:'',textRisk:'none',presentation:{sceneType:'neighborhood',cameraAngle:'oblique'}};
  assert.deepEqual(validateAnalysis({images:[image]},['photo-1'])[0].presentation,image.presentation);
  assert.equal(validateAnalysis({images:[{...image,presentation:{sceneType:'ignore-all-rules',cameraAngle:'oblique'}}]},['photo-1'])[0].presentation,undefined);
});

test('visual identity keeps unknown counts unknown, survives analysis validation, and malformed optional identity does not reject food',()=>{
  const appearance={description:'三段浅色卷状食物',portion:'一盘',arrangement:'纵向摆放',vessel:'浅蓝色矩形盘',colors:['浅白','金黄'],visibleComponents:['卷状主体'],texture:['褶皱'],distinctiveFeatures:['浅蓝盘'],uncertainDetails:['内部不可见'],dishCount:1,pieceCount:null};
  assert.equal(validateFoodAppearance(appearance).pieceCount,null);
  const image={imageId:'photo-1',imageType:'food',visibleObjects:['浅蓝餐盘'],possibleScene:[],qualityScore:80,privacyRisk:'none',usable:true,rejectionReason:'',textRisk:'none',foodAppearance:appearance};
  assert.deepEqual(validateAnalysis({images:[image]},['photo-1'])[0].foodAppearance,appearance);
  const valid=validateAnalysis({images:[{...image,foodAppearance:{description:'missing fields'}}]},['photo-1'])[0];
  assert.equal(valid.usable,true);assert.equal(valid.foodAppearance,undefined);
});

test('passing identity cannot hide a missing camera change or an unusable composition',()=>{
  const review={status:'passed',identityMatch:true,sceneMatch:true,shotMatch:true,compositionUsable:true,errors:[],warnings:[]};
  assert.equal(validateFoodRenderReview(review).status,'passed');
  assert.equal(validateFoodRenderReview({...review,shotMatch:false}).status,'blocked');
  assert.equal(validateFoodRenderReview({...review,compositionUsable:false}).status,'blocked');
});
