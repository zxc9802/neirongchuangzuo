import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { contentRequest, contentDirection, validateContentStoryboard, repairContentStoryboard, composeContentPage, validateSceneGrading, gradeContentScene } from '../services/restaurant/content-sets.mjs';
import { createRestaurantHandler } from '../services/restaurant/server.mjs';
import { restaurantContentError, DEFAULT_RESTAURANT_OUTPUT_COUNT } from '../design/restaurant-types.js';
import { createCreditsLedger } from '../services/credits/store.mjs';

const profile = { name: '测试餐厅', city: '厦门', category: '家常菜' };
const style = { name: '暖木自然光', mood: '轻松', palette: ['暖木', '自然白'], lighting: '自然光', tone: '柔和色彩', texture: '真实摄影', instructions: '保持真实主体和统一色调' };
const graphicStyle = { accent: '#b87438', paper: '#f9f2e5', ink: 'light', typography: 'outline' };
const analysis = Array.from({ length: 4 }, (_, i) => ({ imageId: `photo-${i + 1}`, imageType: 'interior', usable: true, privacyRisk: 'none', textRisk: 'none', qualityScore: 90,
  visibleObjects: ['餐桌', '灯光'], possibleScene: ['用餐'], rejectionReason: '', visibleTexts: [], riskReasons: [] }));
const rawPlan = () => ({ theme: '真实空间与聚餐', visualStyle: style, graphicStyle, foodGroups: [],
  shots: analysis.map(item => ({ sourceImageId: item.imageId, kind: 'scene', name: '空间', purpose: '展示真实空间', camera: '保留原图全景', angle: 'original', lighting: '自然光', editInstructions: '依统一色调修饰实拍' })),
  pages: [[0,1],[0],[1],[2],[3],[0,2,3]].map((assetIndexes, index) => ({ role: index ? '空间细节' : '门店封面', layout: assetIndexes.length === 1 ? 'hero' : assetIndexes.length === 2 ? 'split' : 'grid',
    headline: index ? '看看店里的用餐空间' : '厦门约饭来我们店坐坐', subtitle: '', textPosition: 'bottom', assetIndexes, labels: assetIndexes.map(() => ''), factKeys: ['name','city'] })) });
const task = { contentType: 'store-intro', contentFacts: {}, profileSnapshot: profile, analysis, sourceImages: analysis.map(item => ({ id: item.imageId, hash: item.imageId })) };
test('types require their own facts and material instead of a mandatory full store profile', () => {
  assert.equal(DEFAULT_RESTAURANT_OUTPUT_COUNT, 6);
  assert.equal(contentRequest({ autoGenerate: true, contentType: 'store-intro', contentProfile: profile }, {}).contentType, 'store-intro');
  assert.throws(() => contentRequest({ autoGenerate: true, contentType: 'signature-dish', contentProfile: profile }, {}), { code: 'CONTENT_INFO_REQUIRED' });
  assert.equal(restaurantContentError('signature-dish', { name: '面馆' }, { dishName: '牛肉面', sellingPoints: '肉片和面条' }), '');
  assert.throws(() => contentDirection({ ...task, contentType: 'signature-dish', contentFacts: { dishName: '牛肉面' } }, analysis), { code: 'CONTENT_MATERIAL_REQUIRED' });
  assert.throws(() => contentDirection(task, analysis.map(item => ({ ...item, imageType: 'food' }))), { code: 'CONTENT_MATERIAL_REQUIRED' });
});
test('six finished pages can compose four distinct edited assets with verifiable facts', () => {
  const board = validateContentStoryboard(rawPlan(), task, 6);
  assert.equal(board.outputCount, 6); assert.equal(board.shots.length, 4); assert.equal(board.pages[0].assetIds.length, 2);
  const duplicate = rawPlan(); duplicate.pages[5].assetIndexes = [0]; duplicate.pages[5].layout = 'hero'; duplicate.pages[5].labels = [''];
  assert.throws(() => validateContentStoryboard(duplicate, task, 6), { code: 'INVALID_GALLERY_STORYBOARD' });
  const capacity = rawPlan(); capacity.pages[0].headline = '可以容纳18人聚餐';
  assert.throws(() => validateContentStoryboard(capacity, task, 6), { code: 'INVALID_GALLERY_STORYBOARD' });
  const unsupported = rawPlan(); unsupported.pages[0].factKeys.push('privateRoom');
  assert.throws(() => validateContentStoryboard(unsupported, task, 6), { code: 'INVALID_GALLERY_STORYBOARD' });
});
test('collage exports a real 1080x1440 JPEG and fills scene panels while tracking every input', async () => {
  const board = validateContentStoryboard(rawPlan(), task, 6), assets = new Map();
  for (const [index, shot] of board.shots.entries()) assets.set(shot.imageId, { bytes: await sharp({ create: { width: 800, height: 600, channels: 3, background: ['#af6644','#4466af','#66af44','#af44af'][index] } }).jpeg().toBuffer(), composition: { sourceImageId: shot.sourceImageId, method: 'claude-directed-scene-edit' } });
  for (const page of [board.pages[0], board.pages[5]]) {
    const result = await composeContentPage(page, assets, board.graphicStyle, { brand: '测试<&餐厅' });
    const meta = await sharp(result.bytes).metadata(); assert.equal(meta.width, 1080); assert.equal(meta.height, 1440); assert.equal(meta.format, 'jpeg');
    assert.equal(result.composition.sourceImageIds.length, page.assetIds.length);
    const pixel = await sharp(result.bytes).extract({left:20,top:350,width:1,height:1}).removeAlpha().raw().toBuffer();
    assert.ok(pixel[0] < 220 || pixel[1] < 220 || pixel[2] < 220, 'a photograph fills the panel edge instead of a large empty paper band');
  }
});
test('scene fallback grading retains original geometry and rejects excessive filter parameters', async () => {
  assert.throws(() => validateSceneGrading({ brightness:2,saturation:1,contrast:1,warmth:0 }), { code:'MODEL_INVALID_OUTPUT' });
  const reference = { bytes: await sharp({ create:{width:900,height:600,channels:3,background:'#8b735c'} }).jpeg().toBuffer() };
  const result=await gradeContentScene(reference,{brightness:1.04,saturation:1.03,contrast:1.02,warmth:1});
  assert.equal(result.width,900);assert.equal(result.height,600);assert.equal(result.grading.brightness,1.04);
});

test('layout repair may omit an unsuitable asset without changing stable asset identities or the output count', () => {
  const board = validateContentStoryboard(rawPlan(), task, 6), repaired = rawPlan();
  repaired.pages = [[0,1],[0],[1],[2],[0,2],[1,2]].map((assetIndexes,index)=>({...repaired.pages[index],assetIndexes,
    layout:assetIndexes.length===1?'hero':'split',labels:assetIndexes.map(()=> '')}));
  assert.throws(()=>validateContentStoryboard(repaired,task,6),{code:'INVALID_GALLERY_STORYBOARD'});
  const result = repairContentStoryboard(repaired,board,task);
  assert.equal(result.pages.length,6);assert.deepEqual(result.shots.map(shot=>shot.imageId),board.shots.map(shot=>shot.imageId));
  assert.deepEqual(result.unusedAssetIds,['shot-04']);
});
test('HTTP one-click defaults to six pages, retains type across requests and exports a usable ZIP', async t => {
  const root = await mkdtemp(join(tmpdir(), 'restaurant-content-'));
  const review = { status: 'passed', styleScore: 95, identityMatch: true, sceneMatch: true, shotMatch: true, compositionUsable: true, styleMatch: true, marketingUseful: true, errors: [], warnings: [] };
  let renderedCount=0,factCalls=0,layoutCalls=0,pageCalls=0;
  const model = { ready: Promise.resolve(), enabled: true, async analyse(photos) { return photos.map(photo => analysis.find(item => item.imageId === photo.id)); },
    async planContentSet(input) { assert.equal(input.contentType, 'store-intro'); assert.equal(input.requestedOutputCount, 6); const board=rawPlan();board.shots.reverse();return board; },
    async auditContentFacts(input) { assert.equal(input.pages[0].evidence[0].sourceImageId,'photo-4');factCalls++; return factCalls===1 ? {status:'blocked',errors:['套餐未经确认'],warnings:[]} : {status:'passed',errors:[],warnings:[]}; },
    async repairContentLayout(input) { layoutCalls++; return {pages:input.pages.map((page,i)=>({...page,headline:i?'看看店里的用餐空间':'厦门约饭来我们店坐坐',textPosition:'top'}))}; },
    async renderGalleryPhoto({ photo }) { assert.equal(factCalls,2);renderedCount++;return { bytes: await sharp(photo.bytes).resize(1080,1440).jpeg().toBuffer(), requestId: 'mock' }; },
    async reviewGalleryPhoto() { return review; }, async reviewGallerySet() { return { status: 'passed', reviseImageIds: [], errors: [], warnings: [] }; },
    async reviewContentSet(input) { assert.equal(input.pages.length, 6);pageCalls++;return pageCalls===1 ? {status:'blocked',reviseImageIds:['page-01'],errors:['封面文字位置不当'],warnings:[]} : { status: 'passed', reviseImageIds: [], errors: [], warnings: [] }; }, async write() { throw Error('optional copy unavailable'); } };
  const handler = createRestaurantHandler({ dataDir: root, databaseUrl: '', model, requireAuth: false, cleanupIntervalMs: 0, logger: { warn() {} } });
  await handler.ready; const server = createServer((req,res) => handler(req,res)); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await handler.shutdown(); await new Promise(resolve => server.close(resolve)); await rm(root,{recursive:true,force:true}); });
  const base = `http://127.0.0.1:${server.address().port}/api/restaurant`;
  const api = async (path,body) => { const response = await fetch(base+path,{ method: body ? 'POST' : 'GET', headers: {'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}) }); return { status: response.status, data: await response.json() }; };
  const images = await Promise.all(analysis.map(async (_,i) => ({name:`${i}.jpg`,dataUrl:'data:image/jpeg;base64,'+(await sharp({create:{width:300,height:400,channels:3,background:{r:40+i*20,g:100,b:70}}}).jpeg().toBuffer()).toString('base64')})));
  const id = randomUUID(), body = { requestId:id,autoGenerate:true,rightsConfirmed:true,images,contentType:'store-intro',contentProfile:profile };
  assert.equal((await api('/tasks',body)).status,202);
  assert.equal((await api('/tasks',{...body,contentType:'consumption-scene',contentFacts:{occasion:'朋友聚餐'}})).status,409);
  let result; const deadline=Date.now()+15000;
  do { result=(await api('/tasks/'+id)).data.task; if (['completed','failed'].includes(result.status)) break; await new Promise(resolve=>setTimeout(resolve,30)); } while(Date.now()<deadline);
  assert.equal(result.status,'completed',result.error); assert.equal(result.contentType,'store-intro'); assert.equal(result.files.filter(file=>file.role==='image').length,6);
  assert.equal(layoutCalls,2);assert.equal(pageCalls,2);assert.equal(renderedCount,4);
  const zip=Buffer.from(await (await fetch(base.replace('/api/restaurant','')+result.files.find(file=>file.role==='zip').url)).arrayBuffer());
  assert.equal(Object.keys(unzipSync(zip)).filter(name=>name.endsWith('.jpg')).length,6);
});

test('unlimited delivery preserves unresolved cost receipts, while finite wallets wait for verified costs', async t => {
  for (const unlimited of [false,true]) await t.test(String(unlimited),async t => {
    const root=await mkdtemp(join(tmpdir(),'content-pending-cost-')),id=randomUUID();
    const credits=createCreditsLedger({storageDir:join(root,'credits'),databaseUrl:null,costMode:true});await credits.ready;
    if(unlimited)await credits.setUnlimited('local-dev',true);
    let rendering=0;
    const imageReview={status:'passed',styleScore:90,identityMatch:true,sceneMatch:true,shotMatch:true,compositionUsable:true,styleMatch:true,marketingUseful:true,errors:[],warnings:[]};
    const passed={status:'passed',reviseImageIds:[],errors:[],warnings:[]};
    const model={ready:Promise.resolve(),enabled:true,
      async analyse(photos){await credits.prepareCostCall({userId:'local-dev',taskId:id+'-cost-1',receiptId:'unresolved-request',provider:'openlux',quoteCny:1});return photos.map(p=>analysis.find(a=>a.imageId===p.id));},
      async planContentSet(){return rawPlan();},async auditContentFacts(){return {status:'passed',errors:[],warnings:[]};},
      async renderGalleryPhoto({photo}){rendering++;return {bytes:await sharp(photo.bytes).resize(1080,1440).jpeg().toBuffer()};},
      async reviewGalleryPhoto(){return imageReview;},async reviewGallerySet(){return passed;},async reviewContentSet(){return passed;},async write(){throw Error('optional copy not requested');}};
    const handler=createRestaurantHandler({dataDir:join(root,'restaurant'),databaseUrl:'',credits,model,requireAuth:false,cleanupIntervalMs:0,logger:{warn(){}}});await handler.ready;
    const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
    t.after(async()=>{await handler.shutdown();await new Promise(r=>server.close(r));await credits.close();await rm(root,{recursive:true,force:true});});
    const base=`http://127.0.0.1:${server.address().port}`,path='/api/restaurant/tasks/'+id;
    const images=await Promise.all(analysis.map(async(_,i)=>({name:i+'.jpg',dataUrl:'data:image/jpeg;base64,'+(await sharp({create:{width:200,height:300,channels:3,background:{r:60+i*20,g:100,b:80}}}).jpeg().toBuffer()).toString('base64')})));
    assert.equal((await fetch(base+'/api/restaurant/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:id,rightsConfirmed:true,autoGenerate:true,contentType:'store-intro',contentProfile:profile,images})})).status,202);
    let result;const deadline=Date.now()+15000;
    do{result=(await(await fetch(base+path)).json()).task;if(result.status==='completed'||result.code==='CREDITS_SETTLEMENT_PENDING'||result.status==='failed')break;await new Promise(r=>setTimeout(r,25));}while(Date.now()<deadline);
    assert.equal(result.status,unlimited?'completed':'generating',result.error);assert.equal(rendering,4);
    const before=await credits.reservation('local-dev',id+'-cost-1');assert.equal(before.status,'reserved');assert.equal(before.costItems['unresolved-request'].status,'pending');
    const image=result.files.find(f=>f.role==='image');assert.equal((await fetch(base+image.url)).status,unlimited?200:404);
    if(unlimited)assert.equal(result.billing.costConfirmationPending,true);
    await credits.finishCostCall({userId:'local-dev',taskId:id+'-cost-1',receiptId:'unresolved-request',costCny:1});
    result=(await(await fetch(base+path)).json()).task;assert.equal(result.status,'completed');assert.equal(result.billing.status,'settled');
    assert.equal(result.billing.chargedPoints,unlimited?0:125);assert.equal((await credits.reservation('local-dev',id+'-cost-1')).status,'settled');
    const wallet=await credits.snapshot('local-dev');assert.equal(wallet.held,0);assert.equal(wallet.available,unlimited?1000:875);
    await fetch(base+path);assert.equal(rendering,4);assert.deepEqual(await credits.snapshot('local-dev'),wallet);
  });
});
