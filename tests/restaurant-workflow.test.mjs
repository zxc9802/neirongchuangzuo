import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { unzipSync, strFromU8 } from 'fflate';
import { createRestaurantHandler } from '../services/restaurant/server.mjs';
import { createRestaurantModel } from '../services/restaurant/model.mjs';
import { validateAnalysis, validateDirections, validateCopy, localReview } from '../services/restaurant/rules.mjs';
import * as processor from '../services/restaurant/images.mjs';
import * as promotion from '../services/restaurant/promotion.mjs';
import { COPY_PROMPT } from '../services/restaurant/prompts.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';

const profile = { name: '竹里面馆', city: '武汉', address: '青山建设一路', category: '面食' };
const config = { apiKey: 'test-only-not-a-secret', baseUrl: 'https://provider.invalid/v1', chatModel: 'test-luna', limits: { chatDaily: 100, imageDaily: 20, perMinute: 10 } };
function analysis(photos) { return photos.map(photo => ({ imageId: photo.id, imageType: 'food', visibleObjects: ['一碗面食', '圆碗中盛着面条'], possibleScene: ['午餐'], qualityScore: 80, privacyRisk: 'none', usable: true, rejectionReason: '', visibleTexts: [], textRisk: 'none', riskReasons: [] })); }
function direction(items, extra = {}) { return { id: 'D01', label: '午餐菜品分享', targetCustomer: '附近上班族', consumptionScene: '午餐', contentGoal: '真实菜品介绍', recommendationReason: '可见菜品', expectedAction: '导航到店', supportingImageIds: items.filter(item => item.usable).map(item => item.imageId), missingFacts: [], ...extra }; }
function copy(items) {
  const imageIds = items.map(item => item.imageId);
  return {
    titles: ['午休想吃面附近上班族看过来', '这一碗面给午餐一个具体选项', '来武汉青山建设一路吃顿面食'],
    body: '午休想吃面，又不想临时翻半天收藏的附近上班族，可以把竹里面馆放进午餐备选。我们在武汉青山建设一路，主营面食。这篇想留给正在附近安排午饭的人，吃什么和去哪儿，都有一个具体的落点。\n\n' +
      '圆碗里盛着面条，是这组图最直接的主角。我想把这一碗分享出来，也把店名记在这里：竹里面馆。比起把午餐说得很隆重，我更喜欢从一碗面聊起，让正在找面食的人知道，附近有这样一个选择。\n\n' +
      '如果今天是自己吃午饭，按自己的胃口挑选就好；如果和同事商量午餐，可以先聊聊这顿是不是想吃面。不用为了凑一桌去决定吃什么，先把想吃的品类定下来，再安排午休的路线，选择也会更明确。\n\n' +
      '下一次午饭还没拿定主意时，希望这碗面能给你一点灵感。想来就搜索竹里面馆，核对青山建设一路的位置后再出发；也欢迎先收藏，给下次在武汉找面食的自己留个备选。',
    tags: ['武汉面食', '午餐选择', '附近吃饭', '门店日常', '面馆分享'],
    coverText: '午休想吃面看这一碗', imageOrder: imageIds,
    claims: [
      { text: '竹里面馆', factKeys: ['name'], imageIds: [] },
      { text: '武汉', factKeys: ['city'], imageIds: [] },
      { text: '青山建设一路', factKeys: ['address'], imageIds: [] },
      { text: '主营面食', factKeys: ['category'], imageIds: [] },
      { text: '圆碗里盛着面条', factKeys: [], imageIds },
    ],
  };
}
function paddedCopy(items) {
  return {
    ...copy(items),
    titles: ['附近朋友先看照片认清门店入口', '午餐前看看真实照片判断位置', '找面馆时通过图片认清门口'],
    body: '附近的朋友，先看这组真实照片，再认清门口和招牌。通过照片判断入口位置，结合自己的时间和喜好决定是否到店；需要时收藏外观，在地图里找到我们。'.repeat(5),
    coverText: '看看照片认清门店入口',
    claims: [{ text: '面食', factKeys: ['category'], imageIds: [] }],
  };
}
function mockModel(overrides = {}) { const counts = { analyse: 0, recommend: 0, write: 0, audit: 0 }; return { ready: Promise.resolve(), enabled: true, counts,
  async analyse(photos) { counts.analyse++; return analysis(photos); }, async recommend(items) { counts.recommend++; return [direction(items)]; },
  async write(input) { counts.write++; return copy(input.analysis); }, async audit() { counts.audit++; return { status: 'passed', warnings: [], errors: [] }; },
  async usage() { return { day: '2026-10-07', used: { chat: 0 }, remaining: { chat: 100 }, limits: config.limits }; }, async close() {}, ...overrides }; }
async function photos(count = 2) { return Promise.all(Array.from({ length: count }, async (_, index) => ({ name: `photo${index}.png`, dataUrl: `data:image/png;base64,${(await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 80 + (index * 15) % 176, g: 50, b: 120 } } }).png().toBuffer()).toString('base64')}` }))); }
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'restaurant-flow-'));
  const model = options.model ?? mockModel();
  const credits = options.credits ?? (options.withCredits ? createCreditsLedger({ storageDir: join(root, 'points'), databaseUrl: null }) : undefined);
  const handler = createRestaurantHandler({ dataDir: root, databaseUrl: '', config, model, credits, requireAuth: true, cleanupIntervalMs: 0, logger: { warn() {} }, ...options });
  await handler.ready;
  const server = createServer((req, res) => { req.authenticatedUserId = req.headers['x-test-user']; handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/restaurant`;
  async function api(path, body, user = 'owner') { const response = await fetch(base + path, { method: body === undefined ? 'GET' : path === '/profile' ? 'PUT' : 'POST', headers: { ...(user ? { 'x-test-user': user } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) }; }
  async function wait(id, states) {
    const deadline = performance.now() + 15_000;
    let last;
    do {
      const response = await api(`/tasks/${id}`); last = response.body.task;
      if (states.includes(last?.status)) return last;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    throw new Error(`task did not reach ${states.join('/')} within 15s; last status: ${last?.status}, stage: ${last?.progress?.stage}, code: ${last?.code}, error: ${last?.error}`);
  }
  t.after(async () => { await handler.shutdown(); await new Promise(resolve => server.close(resolve)); await credits?.close(); assert.equal(join(tmpdir(), root.split(/[\\/]/).at(-1)), root); await rm(root, { recursive: true, force: true }); });
  return { api, wait, model, handler, root, credits };
}
async function newTask(app, input = {}) { await app.api('/profile', { profile }); const id = randomUUID(); const result = await app.api('/tasks', { requestId: id, images: await photos(), rightsConfirmed: true, ...input }); assert.equal(result.status, 202); return { id, task: await app.wait(id, ['awaiting_selection', 'failed']) }; }
async function uploadPool(app, count) {
  await app.api('/profile', { profile });
  const id = randomUUID(), inputs = await photos(count);
  const draft = await app.api('/tasks', { requestId: id, imageCount: count, rightsConfirmed: true });
  assert.equal(draft.status, 202); assert.equal(draft.body.task.status, 'uploading');
  for (let startIndex = 0; startIndex < count; startIndex += 3) assert.equal((await app.api(`/tasks/${id}/photos`, { startIndex, images: inputs.slice(startIndex, startIndex + 3) })).status, 202);
  assert.equal((await app.api(`/tasks/${id}/analyse`, {})).status, 202);
  return { id, task: await app.wait(id, ['awaiting_selection', 'failed']), inputs };
}

test('promotional package uses original photo evidence, produces six themed images and ZIP, and charges once', async t => {
  let masks = 0, closed = 0, seen;
  const model = mockModel({ async write(input) {
    seen = input;
    return { ...copy(input.analysis), imageCaptions: input.analysis.map(item => ({ imageId: item.imageId, text: '附近午餐看看这一碗面' })) };
  } });
  const app = await setup(t, { model, withCredits: true, subjectMasker: { mask() { masks++; throw new Error('should not mask non-food geometry'); }, close() { closed++; } } });
  const { id } = await uploadPool(app, 6);
  const body = { directionId: 'D01', imageMode: 'promotional', outputCount: 6 };
  assert.equal((await app.api(`/tasks/${id}/generate`, body)).status, 202);
  const task = await app.wait(id, ['completed', 'failed']);
  assert.equal(task.status, 'completed', task.error); assert.equal(task.imageMode, 'promotional');
  assert.equal(seen.imageMode, 'promotional'); assert.equal(seen.photos.length, 4);
  for (const photo of seen.photos) {
    const metadata = await sharp(Buffer.from(photo.dataUrl.split(',')[1], 'base64')).metadata();
    assert.equal(metadata.width, 300); assert.equal(metadata.height, 400, 'model sees genuine scene instead of designed background');
  }
  assert.equal(task.files.filter(file => file.mime === 'image/jpeg').length, 6);
  assert.ok(task.files.filter(file => file.mime === 'image/jpeg').every(file => file.width === 1080 && file.height === 1440 && file.composition.method === 'original-frame'));
  assert.equal(new Set(task.files.filter(file => file.mime === 'image/jpeg').map(file => file.composition.palette)).size, 1);
  assert.equal(masks, 0); assert.equal(task.billing.chargedPoints, 300);
  const zip = await app.api(`/tasks/${id}/files/package.zip`);
  assert.equal(zip.status, 200); assert.equal(Object.keys(unzipSync(zip.body)).filter(name => /\.jpg$/.test(name)).length, 6);
  assert.equal((await app.api(`/tasks/${id}/generate`, body)).body.task.id, id);
  assert.equal((await app.credits.snapshot('owner')).balance, 700);
  await app.handler.shutdown(); assert.equal(closed, 1);
});

test('promotional processing failure retries locally and releases held credits without publishing a partial set', async t => {
  let attempts = 0;
  const app = await setup(t, { withCredits: true, promotionalProcessor: { ...promotion, processPromotionalPhoto() { attempts++; throw new Error('composition failed'); } } });
  const { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true, imageMode: 'promotional' });
  const task = await app.wait(id, ['completed', 'failed']);
  assert.equal(task.status, 'failed'); assert.equal(attempts, 6);
  assert.equal(task.files.length, 0); assert.equal((await app.credits.snapshot('owner')).balance, 1000);
  assert.equal((await app.credits.snapshot('owner')).held, 0); assert.equal((await app.api('/usage')).body.usage.used, 0);
});

const foodAppearance={description:'圆碗中的食物',portion:'一碗',arrangement:'食物在碗内',vessel:'圆碗',colors:['浅色'],visibleComponents:['条状食物'],texture:['可见纹理'],distinctiveFeatures:['圆碗'],uncertainDetails:[],dishCount:1,pieceCount:null};
const foodReview={status:'passed',identityMatch:true,sceneMatch:true,shotMatch:true,compositionUsable:true,errors:[],warnings:[]};

test('one-click gallery analyses the whole upload, expands two food references to six new frames, and delivers without optional copy', async t => {
  let renders = 0, copies = 0;
  const plans = [];
  const model = mockModel({ async identifyFood() { return foodAppearance; },
    async renderFood(input) { renders++; plans.push(input.plan.angle); return { bytes: await sharp(input.photo.bytes).resize(1080,1440).jpeg().toBuffer(), requestId: input.imageId }; },
    async reviewFoodRender() { return foodReview; }, async write() { copies++; throw Object.assign(Error('copy result uncertain'), { code: 'PROVIDER_UNCERTAIN' }); } });
  const app = await setup(t, { model, withCredits: true }); await app.api('/profile', { profile });
  const id = randomUUID(), inputs = await photos(2);
  assert.equal((await app.api('/tasks', { requestId: id, imageCount: 2, rightsConfirmed: true, autoGenerate: true, outputCount: 6 })).status, 202);
  await app.api(`/tasks/${id}/photos`, { startIndex: 0, images: inputs }); await app.api(`/tasks/${id}/analyse`, {});
  const task = await app.wait(id, ['completed','failed']);
  assert.equal(task.status, 'completed', task.error); assert.equal(task.selection.workflow, 'store-gallery-v1');
  assert.equal(task.analysis.length, 2); assert.equal(task.files.filter(file => file.role === 'image').length, 6);
  assert.equal(renders, 6); assert.equal(new Set(plans).size, 4); assert.equal(copies, 1); assert.equal(model.counts.recommend, 0);
  assert.equal(task.billing.chargedPoints, 300); assert.equal(task.copyStatus, 'unavailable');
  assert.equal((await app.credits.snapshot('owner')).balance, 700);
  const zipped = await app.api(`/tasks/${id}/files/package.zip`);
  assert.equal(zipped.status, 200); assert.equal(Object.keys(unzipSync(zipped.body)).length, 6);
  const again = await app.api(`/tasks/${id}/generate`, { directionId: task.selection.directionId, imageMode: 'promotional', workflow: 'store-gallery-v1', outputCount: 6 });
  assert.equal(again.body.task.id, id); assert.equal(renders, 6); assert.equal((await app.credits.snapshot('owner')).balance, 700);
});

test('gallery sends real store environment alongside food and previews nine finished frames before one final settlement', async t => {
  const references = [];
  const types = ['food','interior','exterior','preparation','food'];
  const model = mockModel({ async analyse(photos) { return analysis(photos).map(item => ({ ...item, imageType: types[Number(item.imageId.split('-')[1])-1],
    textRisk: 'warning', riskReasons: ['请核对公开招牌文字'] })); }, async identifyFood() { return foodAppearance; },
    async renderFood(input) { references.push(input.storeReferences.map(item => item.id)); return { bytes: await sharp(input.photo.bytes).resize(1080,1440).jpeg().toBuffer(), requestId: input.imageId }; },
    async reviewFoodRender(input) { assert.equal(input.photos.length, 4); return foodReview; } });
  const app = await setup(t, { model, withCredits: true }); await app.api('/profile', { profile });
  const id = randomUUID(), inputs = await photos(5);
  await app.api('/tasks', { requestId:id,imageCount:5,rightsConfirmed:true,autoGenerate:true,outputCount:9 });
  for (let startIndex=0;startIndex<5;startIndex+=3) await app.api(`/tasks/${id}/photos`, {startIndex,images:inputs.slice(startIndex,startIndex+3)});
  await app.api(`/tasks/${id}/analyse`,{});
  const task=await app.wait(id,['awaiting_confirmation','completed','failed']);
  assert.equal(task.status,'awaiting_confirmation',task.error); assert.equal(task.files.filter(file=>file.role==='image').length,9);
  assert.equal(references.length,6); assert.ok(references.every(ids=>ids.join() === 'photo-2,photo-3'));
  assert.equal((await app.api(`/tasks/${id}/files/01.jpg`)).status,200);
  assert.equal((await app.api(`/tasks/${id}/files/package.zip`)).status,404);
  assert.equal((await app.api(`/tasks/${id}/files/01.jpg`,undefined,'another-owner')).status,404);
  assert.equal(task.billing.reservedPoints,450); assert.equal(task.billing.chargedPoints,0);
  const confirmed=await app.api(`/tasks/${id}/confirm`,{confirmWarnings:true}); assert.equal(confirmed.body.task.billing.chargedPoints,450);
  await app.api(`/tasks/${id}/confirm`,{confirmWarnings:true}); assert.equal((await app.credits.snapshot('owner')).balance,550);
});

test('the website plans a varied single-dish story from all uploads once and executes that exact storyboard', async t => {
  let plans=0,renders=0;
  const types=['food','food','exterior','interior',...Array(9).fill('preparation'),'staff'];
  const names=['食品主视觉','加料摊盘','淋酱出餐','菜品质感','门店外观','蒸制工作','用餐环境','食品上桌','员工工作'];
  const ids=['photo-1','photo-5','photo-6','photo-2','photo-3','photo-7','photo-4','photo-1','photo-14'];
  const model=mockModel({async analyse(photos){return analysis(photos).map(item=>({...item,imageType:types[Number(item.imageId.split('-')[1])-1]}));},
    async planGallery(input){plans++;assert.equal(input.analysis.length,14);assert.equal(input.outputCount,9);assert.equal(input.photos.length,4);
      return {theme:'一盘面食从制作到上桌',foodGroups:[{id:'same-dish',label:'同一碗面食',imageIds:['photo-1','photo-2']}],shots:ids.map((id,index)=>{
        const kind=types[Number(id.split('-')[1])-1]==='food'?'food':'scene';return {sourceImageId:id,kind,foodGroupId:kind==='food'?'same-dish':'',
          name:names[index],purpose:'展示实际菜品或门店过程',focus:'完整面食',angle:index%2?'overhead':'oblique',camera:'按实际主体调整机位与景别',lighting:'明亮自然光'};})};},
    async identifyFood(){return foodAppearance;},async renderFood(input){renders++;return{bytes:await sharp(input.photo.bytes).resize(1080,1440).jpeg().toBuffer(),requestId:input.imageId};},
    async reviewFoodRender(){return foodReview;}});
  const app=await setup(t,{model,withCredits:true});await app.api('/profile',{profile});const id=randomUUID(),inputs=await photos(14);
  await app.api('/tasks',{requestId:id,imageCount:14,rightsConfirmed:true,autoGenerate:true,outputCount:9});
  for(let startIndex=0;startIndex<14;startIndex+=3)await app.api(`/tasks/${id}/photos`,{startIndex,images:inputs.slice(startIndex,startIndex+3)});
  await app.api(`/tasks/${id}/analyse`,{});const task=await app.wait(id,['completed','failed']);
  assert.equal(task.status,'completed',task.error);assert.equal(plans,1);assert.equal(renders,3);
  assert.equal(task.galleryStoryboard.source,'ai');assert.equal(task.galleryStoryboard.foodGroups.length,1);
  assert.deepEqual(task.selection.shots.map(shot=>shot.name),names);assert.equal(task.files.filter(file=>file.role==='image').length,9);
  assert.equal(task.billing.chargedPoints,450);
  const repeated=await app.api(`/tasks/${id}/generate`,{directionId:'store-gallery',workflow:'store-gallery-v1',imageMode:'promotional',outputCount:9});
  assert.equal(repeated.body.task.id,id);assert.equal(plans,1);assert.equal(renders,3);assert.equal((await app.credits.snapshot('owner')).balance,550);
  const fresh=await app.api(`/tasks/${id}/fork`,{requestId:randomUUID()});
  assert.equal(fresh.body.task.galleryStoryboard,undefined,'a new direction must get a fresh composition rather than retaining the old one');
  assert.equal((await app.api(`/tasks/${id}`)).body.task.galleryStoryboard.source,'ai');
});

test('an uncertain optional planning call is not replayed and the fallback retains varied real scenes',async t=>{
  let plans=0;
  const model=mockModel({async analyse(photos){return analysis(photos).map(item=>({...item,imageType:item.imageId==='photo-1'?'food':'preparation'}));},
    async planGallery(){plans++;throw Object.assign(Error('response lost'),{code:'PROVIDER_UNCERTAIN'});},async identifyFood(){return foodAppearance;},
    async renderFood(input){return{bytes:await sharp(input.photo.bytes).resize(1080,1440).jpeg().toBuffer(),requestId:input.imageId};},async reviewFoodRender(){return foodReview;}});
  const app=await setup(t,{model});await app.api('/profile',{profile});const id=randomUUID(),inputs=await photos(9);
  await app.api('/tasks',{requestId:id,imageCount:9,rightsConfirmed:true,autoGenerate:true,outputCount:9});
  for(let startIndex=0;startIndex<9;startIndex+=3)await app.api(`/tasks/${id}/photos`,{startIndex,images:inputs.slice(startIndex,startIndex+3)});
  await app.api(`/tasks/${id}/analyse`,{});const task=await app.wait(id,['completed','failed']);
  assert.equal(task.status,'completed',task.error);assert.equal(plans,1);assert.equal(task.galleryStoryboard.source,'rules');
  assert.equal(task.selection.shots.filter(shot=>shot.kind==='food').length,3);
  assert.equal(new Set(task.selection.shots.filter(shot=>shot.kind==='scene').map(shot=>shot.sourceImageId)).size,6);
});

test('auto gallery rejects invalid frame counts before creating a paid task', async t => {
  const app=await setup(t,{withCredits:true}); await app.api('/profile',{profile});
  for(const outputCount of [0,-1,31,1.5,'9']) assert.equal((await app.api('/tasks',{requestId:randomUUID(),imageCount:2,rightsConfirmed:true,autoGenerate:true,outputCount})).body.code,'INVALID_OUTPUT_COUNT');
  assert.equal((await app.credits.snapshot('owner')).balance,1000); assert.equal(app.model.counts.analyse,0);
});

test('gallery renders and audits the identical cropped primary dish, keeping the complete original for task evidence', async t => {
  let renders = 0, audits = 0;
  const renderedReferences = new Map(), fullSizes = new Map();
  const model = mockModel({ async identifyFood(input) { fullSizes.set(input.analysis.imageId, await sharp(input.photos[0].bytes).metadata()); return { ...foodAppearance, identityScope: 'dish', subjectBox: { left: .2, top: .2, width: .6, height: .6 }, subjectConfidence: .95 }; },
    async renderFood(input) {
      renders++;
      const meta = await sharp(input.photo.bytes).metadata();
      const full = fullSizes.get(input.photo.id);
      assert.ok(meta.width < full.width && meta.height < full.height);
      renderedReferences.set(input.photo.id, input.photo.bytes);
      return { bytes: await sharp(input.photo.bytes).resize(1080,1440).jpeg().toBuffer(), requestId: input.imageId };
    }, async reviewFoodRender(input) {
      audits++; assert.deepEqual(input.photos[0].bytes, renderedReferences.get(input.sourceImageId)); return foodReview;
    } });
  const app = await setup(t, { model }); await app.api('/profile', { profile });
  const id = randomUUID(), inputs = await photos(2);
  await app.api('/tasks', { requestId:id, images:inputs, rightsConfirmed:true, autoGenerate:true, outputCount:6 });
  const task = await app.wait(id, ['completed','failed']);
  assert.equal(task.status, 'completed', task.error); assert.equal(renders,6); assert.equal(audits,6);
  assert.equal(task.sourceImages.length,2);
  assert.ok(task.files.filter(file=>file.role==='image').every(file=>file.composition.subjectBox?.width===.6));
});

test('hotpot gallery keeps the complete spread even when vision selects a foreground side dish', async t => {
  let fullReference, renders = 0;
  const model = mockModel({ async identifyFood(input) {
    assert.equal(input.subjectScope, 'spread'); fullReference = input.photos[0].bytes;
    return { ...foodAppearance, identityScope: 'dish', subjectBox: { left: .2, top: .2, width: .6, height: .6 }, subjectConfidence: .95 };
  }, async renderFood(input) {
    renders++; assert.deepEqual(input.photo.bytes, fullReference); assert.equal(input.appearance.identityScope, 'spread');
    assert.equal(input.appearance.subjectBox, undefined);
    return { bytes: await sharp(input.photo.bytes).resize(1080,1440).jpeg().toBuffer(), requestId: input.imageId };
  }, async reviewFoodRender(input) { assert.deepEqual(input.photos[0].bytes, fullReference); return foodReview; } });
  const app = await setup(t, { model }); await app.api('/profile', { profile: { ...profile, category: '火锅' } });
  const id = randomUUID(); await app.api('/tasks', { requestId: id, images: await photos(1), rightsConfirmed: true, autoGenerate: true, outputCount: 9 });
  const task = await app.wait(id, ['completed','failed']);
  assert.equal(task.status, 'completed', task.error); assert.equal(renders, 9);
  assert.ok(task.files.filter(file=>file.role==='image').every(file=>file.composition.subjectBox===null));
});

test('gallery persists approved frames privately and a known failure retries only the remaining frames', async t => {
  let renders=0;
  const model=mockModel({async identifyFood(){return foodAppearance;},async renderFood(input){
    if(++renders===3)throw Object.assign(Error('explicit provider rejection'),{code:'PROVIDER_ERROR'});
    return {bytes:await sharp(input.photo.bytes).resize(1080,1440).jpeg().toBuffer(),requestId:input.imageId};
  },async reviewFoodRender(){return foodReview;},async write(){throw Error('optional copy unavailable');}});
  const app=await setup(t,{model,withCredits:true});await app.api('/profile',{profile});
  const id=randomUUID();await app.api('/tasks',{requestId:id,images:await photos(2),rightsConfirmed:true,autoGenerate:true,outputCount:6});
  const failed=await app.wait(id,['failed']);assert.equal(failed.code,'PROVIDER_ERROR');
  const saved=await app.handler.store.getTask('owner',id);assert.equal(saved.galleryCheckpoints.filter(x=>x.status==='ready').length,2);
  assert.equal(failed.galleryCheckpoints,undefined);
  assert.equal((await app.api(`/tasks/${id}/files/${saved.galleryCheckpoints[0].key.split('/').at(-1)}`)).status,404);
  assert.equal((await app.credits.snapshot('owner')).balance,1000);
  await app.api(`/tasks/${id}/retry`,{});const completed=await app.wait(id,['completed','failed']);
  assert.equal(completed.status,'completed',completed.error);assert.equal(renders,7);
  assert.equal(completed.files.filter(x=>x.role==='image').length,6);assert.equal(completed.billing.chargedPoints,300);
});

test('an explicitly requested new gallery reuses known frames from an uncertain task without replaying its unknown call',async t=>{
  let renders=0;
  const model=mockModel({async identifyFood(){return foodAppearance;},async renderFood(input){
    if(++renders===3)throw Object.assign(Error('unknown result'),{code:'PROVIDER_UNCERTAIN'});
    return {bytes:await sharp(input.photo.bytes).resize(1080,1440).jpeg().toBuffer(),requestId:input.imageId};
  },async reviewFoodRender(){return foodReview;},async write(){throw Error('optional copy unavailable');}});
  const app=await setup(t,{model,withCredits:true});await app.api('/profile',{profile});
  const id=randomUUID();await app.api('/tasks',{requestId:id,images:await photos(2),rightsConfirmed:true,autoGenerate:true,outputCount:6});
  await app.wait(id,['failed']);assert.equal((await app.api(`/tasks/${id}/retry`,{})).status,409);assert.equal(renders,3);
  const next=randomUUID();await app.api(`/tasks/${id}/fork`,{requestId:next,reuseCompletedImages:true});
  await app.api(`/tasks/${next}/generate`,{directionId:'store-gallery',imageMode:'promotional',workflow:'store-gallery-v1',outputCount:6});
  const completed=await app.wait(next,['completed','failed']);assert.equal(completed.status,'completed',completed.error);
  assert.equal(renders,7);assert.equal((await app.credits.snapshot('owner')).balance,700);
  const again=await app.api(`/tasks/${id}/fork`,{requestId:next,reuseCompletedImages:true});assert.equal(again.body.task.id,next);
});

test('food rephotography changes angles, reuses completed calls during local retries and charges delivered images once', async t => {
  let renders=0, attempts=0, identities=0;const plans=[],styles=[];
  const model=mockModel({async identifyFood(){identities++;return foodAppearance;},async renderFood(input){renders++;plans.push(input.plan.angle);styles.push(Boolean(input.styleReference));return {bytes:input.photo.bytes,requestId:'render-id'};},async reviewFoodRender(input){assert.equal(input.photos.length,2);return foodReview;}});
  const promotionalProcessor={...promotion,async processPromotionalPhoto(bytes,options){
    assert.equal((await options.renderFood(options.analysis,{bytes})).requestId,'render-id');
    if(++attempts===1)throw Error('local composition failed after successful rephotography');
    return processor.processPhoto(bytes);
  },async addPromotionalHeadline(result){return result;}};
  const app=await setup(t,{model,withCredits:true,promotionalProcessor});const {id}=await newTask(app);
  await app.api(`/tasks/${id}/generate`,{directionId:'D01',acceptSparse:true,imageMode:'promotional'});
  const task=await app.wait(id,['completed','failed']);assert.equal(task.status,'completed',task.error);
  assert.equal(renders,2);assert.equal(identities,2);assert.equal(attempts,3);assert.deepEqual(plans,['oblique','overhead']);assert.deepEqual(styles,[false,false]);
  assert.equal(task.billing.chargedPoints,100);assert.equal((await app.credits.snapshot('owner')).balance,900);
  assert.ok(task.analysis.every(image=>image.foodAppearance.description));
  await app.api(`/tasks/${id}/generate`,{directionId:'D01',acceptSparse:true,imageMode:'promotional'});assert.equal(renders,2);
});

test('uncertain food-generation calls stop once, never get a quality retry and fully release the points', async t => {
  let renders=0, attempts=0, reviews=0;
  const model=mockModel({async identifyFood(){return foodAppearance;},async renderFood(){renders++;throw Object.assign(Error('result uncertain'),{code:'PROVIDER_UNCERTAIN'});},async reviewFoodRender(){reviews++;return foodReview;}});
  const promotionalProcessor={...promotion,async processPromotionalPhoto(bytes,options){attempts++;await options.renderFood(options.analysis,{bytes});}};
  const app=await setup(t,{model,withCredits:true,promotionalProcessor});const {id}=await newTask(app);
  await app.api(`/tasks/${id}/generate`,{directionId:'D01',acceptSparse:true,imageMode:'promotional'});
  const task=await app.wait(id,['completed','failed']);assert.equal(task.status,'failed');assert.equal(task.code,'PROVIDER_UNCERTAIN');
  assert.equal(renders,1);assert.equal(attempts,1);assert.equal(reviews,0);assert.equal(task.files.length,0);
  const wallet=await app.credits.snapshot('owner');assert.equal(wallet.balance,1000);assert.equal(wallet.held,0);
});

test('only completed food results with visible identity drift get a corrective generation; persistent drift releases all points',async t=>{
  let renders=0;const attempts=[],corrections=[];
  const model=mockModel({async identifyFood(){return foodAppearance;},async renderFood(input){renders++;attempts.push(input.attempt);corrections.push(input.corrections);return {bytes:input.photo.bytes,requestId:'render-id'};},async reviewFoodRender(){return {...foodReview,status:'blocked',identityMatch:false,errors:['多出一份食物']};}});
  const app=await setup(t,{model,withCredits:true});const {id}=await newTask(app);
  await app.api(`/tasks/${id}/generate`,{directionId:'D01',acceptSparse:true,imageMode:'promotional'});
  const task=await app.wait(id,['completed','failed']);assert.equal(task.status,'failed');assert.equal(task.code,'FOOD_IDENTITY_MISMATCH');
  assert.equal(renders,2);assert.deepEqual(attempts,[0,1]);assert.deepEqual(corrections,[[],['多出一份食物']]);
  assert.equal(task.files.length,0);assert.equal((await app.credits.snapshot('owner')).balance,1000);
});

test('restaurant points: upload and analysis are free, cover replaces first photo, and repeated completion charges once', async t => {
  const app = await setup(t, { withCredits: true }), { id } = await newTask(app);
  assert.equal((await app.credits.snapshot('owner')).balance, 1000);
  assert.equal((await app.credits.snapshot('owner')).held, 0);
  const body = { directionId: 'D01', acceptSparse: true, imageMode: 'cover' };
  assert.equal((await app.api(`/tasks/${id}/generate`, body)).status, 202);
  const task = await app.wait(id, ['completed', 'failed']);
  assert.equal(task.status, 'completed', task.error);
  assert.equal(task.files.filter(file => /^image\//.test(file.mime)).length, 2);
  assert.equal(task.billing.chargedPoints, 100);
  assert.equal(task.billing.status, 'settled');
  assert.equal((await app.api(`/tasks/${id}/generate`, body)).body.task.id, id);
  assert.equal((await app.credits.snapshot('owner')).balance, 900);
  assert.equal((await app.credits.snapshot('owner')).held, 0);
  assert.equal((await app.credits.snapshot('another-owner')).balance, 1000);
});

test('restaurant unlimited account delivers a complete cover package with zero balance and no point charge', async t => {
  const app = await setup(t, { withCredits: true });
  await app.credits.reserve({ userId: 'owner', taskId: 'previous-images', kind: 'image', units: 20 });
  await app.credits.settle({ userId: 'owner', taskId: 'previous-images', units: 20 });
  await app.credits.setUnlimited('owner', true);
  const { id } = await newTask(app);
  assert.equal((await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true, imageMode: 'cover' })).status, 202);
  const task = await app.wait(id, ['completed', 'failed']);
  assert.equal(task.status, 'completed', task.error);
  assert.equal(task.files.filter(file => /^image\//.test(file.mime)).length, 2);
  assert.equal(task.billing.status, 'settled'); assert.equal(task.billing.exempt, true);
  assert.equal(task.billing.chargedPoints, 0); assert.equal(task.billing.reservedPoints, 0);
  assert.equal((await app.api(`/tasks/${id}/files/package.zip`)).status, 200);
  assert.equal((await app.credits.snapshot('owner')).available, 0);
  assert.equal((await app.credits.snapshot('owner')).held, 0);
  assert.equal((await app.credits.snapshot('another-owner')).unlimited, false);
});

test('restaurant points: failed noncore photo refunds the difference and only the actual package photos are charged', async t => {
  const imageProcessor = { ...processor, async processPhoto(bytes, options) {
    if ((await sharp(bytes).stats()).channels[0].mean < 90) throw new Error('unavailable photo');
    return processor.processPhoto(bytes, options);
  } };
  const app = await setup(t, { withCredits: true, imageProcessor }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  const task = await app.wait(id, ['completed', 'failed']);
  assert.equal(task.status, 'completed', task.error);
  assert.equal(task.billing.chargedPoints, 50);
  assert.equal((await app.credits.snapshot('owner')).balance, 950);
  assert.equal((await app.credits.snapshot('owner')).held, 0);
});

test('restaurant points: risk confirmation keeps a reservation, then confirms and settles only once', async t => {
  const model = mockModel({ async audit() { return { status: 'passed_with_warning', warnings: ['请核对真实照片后发布'], errors: [] }; } });
  const app = await setup(t, { withCredits: true, model }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  const task = await app.wait(id, ['awaiting_confirmation', 'failed']);
  assert.equal(task.status, 'awaiting_confirmation', task.error);
  const wallet = await app.credits.snapshot('owner');
  assert.equal(wallet.balance, 900); assert.equal(wallet.held, 100); assert.equal(wallet.total, 1000);
  assert.equal((await app.api(`/tasks/${id}/confirm`, { confirmWarnings: true })).body.task.status, 'completed');
  await app.api(`/tasks/${id}/confirm`, { confirmWarnings: true });
  assert.equal((await app.credits.snapshot('owner')).balance, 900);
  assert.equal((await app.credits.snapshot('owner')).held, 0);
});

test('restaurant points: insufficient balance stops writing and does not reserve provider or image points', async t => {
  const app = await setup(t, { withCredits: true }), { id } = await newTask(app);
  await app.credits.reserve({ userId: 'owner', taskId: 'previous-images', kind: 'image', units: 19 });
  await app.credits.settle({ userId: 'owner', taskId: 'previous-images', units: 19 });
  const result = await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  assert.equal(result.status, 402); assert.equal(result.body.code, 'INSUFFICIENT_POINTS');
  assert.equal(app.model.counts.write, 0); assert.equal(app.model.counts.audit, 0);
  assert.equal((await app.credits.snapshot('owner')).balance, 50);
  assert.equal((await app.credits.snapshot('owner')).held, 0);
});

test('restaurant points: explicit failed generation refunds and manual retry uses a fresh reservation', async t => {
  let attempts = 0;
  const model = mockModel({ async write(input) { if (!attempts++) throw new Error('temporary failed response'); return copy(input.analysis); } });
  const app = await setup(t, { withCredits: true, model }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  const failed = await app.wait(id, ['failed']);
  assert.equal(failed.billing.status, 'released');
  assert.equal((await app.credits.snapshot('owner')).balance, 1000);
  await app.api(`/tasks/${id}/retry`, {});
  const task = await app.wait(id, ['completed', 'failed']);
  assert.equal(task.status, 'completed', task.error);
  assert.notEqual(task.billing.taskId, failed.billing.taskId);
  assert.equal(task.billing.chargedPoints, 100);
  assert.equal((await app.credits.snapshot('owner')).balance, 900);
});

test('restaurant points: pending settlement blocks package download and restores without repeating model calls', async t => {
  const app = await setup(t, { withCredits: true }), { id } = await newTask(app);
  const settle = app.credits.settle; let offline = true;
  app.credits.settle = async input => {
    if (offline) throw Object.assign(new Error('credits temporarily unavailable'), { code: 'CREDITS_STORAGE_UNAVAILABLE', status: 503 });
    return settle(input);
  };
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  let task;
  const deadline = performance.now() + 5000;
  do {
    task = (await app.api(`/tasks/${id}`)).body.task;
    if (task?.billing?.status === 'settle_pending') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (performance.now() < deadline);
  assert.equal(task.billing.status, 'settle_pending');
  assert.equal(task.status, 'generating');
  assert.notEqual((await app.api(`/tasks/${id}/files/${task.files[0].filename}`)).status, 200);
  const counts = { ...app.model.counts };
  assert.equal((await app.credits.snapshot('owner')).held, 100);
  offline = false;
  const restored = (await app.api(`/tasks/${id}`)).body.task;
  assert.equal(restored.status, 'completed', restored.error);
  assert.equal(restored.code, null);
  assert.equal(restored.billing.chargedPoints, 100);
  assert.deepEqual(app.model.counts, counts);
  assert.equal((await app.credits.snapshot('owner')).balance, 900);
  assert.equal((await app.credits.snapshot('owner')).held, 0);
});

test('restaurant points: expiring an unconfirmed package releases its image reservation', async t => {
  let clock = Date.now();
  const model = mockModel({ async audit() { return { status: 'passed_with_warning', warnings: ['请核对照片'], errors: [] }; } });
  const app = await setup(t, { withCredits: true, model, now: () => clock }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  assert.equal((await app.wait(id, ['awaiting_confirmation', 'failed'])).status, 'awaiting_confirmation');
  assert.equal((await app.credits.snapshot('owner')).held, 100);
  clock += 3 * 24 * 60 * 60 * 1000 + 1000;
  await app.api(`/tasks/${id}`);
  assert.equal((await app.credits.snapshot('owner')).balance, 1000);
  assert.equal((await app.credits.snapshot('owner')).held, 0);
});

for (const committed of [false, true]) test(`restaurant points: expiry reconciles pending settlement with committed=${committed}`, async t => {
  let clock = Date.now();
  const app = await setup(t, { withCredits: true, now: () => clock }), { id } = await newTask(app);
  const settle = app.credits.settle;
  app.credits.settle = async input => {
    if (committed) await settle(input);
    throw Object.assign(new Error('lost settlement response'), { code: 'CREDITS_STORAGE_UNAVAILABLE', status: 503 });
  };
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  const deadline = performance.now() + 5000;
  let pending;
  do {
    pending = (await app.api(`/tasks/${id}`)).body.task;
    if (pending?.billing?.status === 'settle_pending') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (performance.now() < deadline);
  assert.equal(pending.billing.status, 'settle_pending');
  const counts = { ...app.model.counts };
  clock += 3 * 24 * 60 * 60 * 1000 + 1000;
  const expired = (await app.api(`/tasks/${id}`)).body.task;
  assert.equal(expired.status, 'failed'); assert.equal(expired.code, 'FILES_EXPIRED');
  assert.equal(expired.billing.status, committed ? 'settled' : 'released');
  assert.equal(expired.billing.chargedPoints, committed ? 100 : 0);
  await app.api(`/tasks/${id}`);
  assert.equal((await app.credits.snapshot('owner')).balance, committed ? 900 : 1000);
  assert.equal((await app.credits.snapshot('owner')).held, 0);
  assert.deepEqual(app.model.counts, counts);
});

test('restaurant points: task deletion keeps a durable cleanup reference until an offline wallet recovers', async t => {
  let clock = Date.now();
  const model = mockModel({ async audit() { return { status: 'passed_with_warning', warnings: ['请核对照片'], errors: [] }; } });
  const app = await setup(t, { withCredits: true, model, now: () => clock }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  const task = await app.wait(id, ['awaiting_confirmation']);
  const reservation = app.credits.reservation; let offline = true;
  app.credits.reservation = async (...args) => { if (offline) throw new Error('database offline'); return reservation(...args); };
  clock += 31 * 24 * 60 * 60 * 1000;
  assert.equal((await app.api(`/tasks/${id}`)).status, 404);
  assert.equal((await app.credits.snapshot('owner')).held, 100);
  const swept = await app.handler.store.sweep();
  assert.deepEqual(swept.pendingCredits, [{ userId: 'owner', taskId: id, creditId: task.billing.taskId }]);
  assert.equal(await app.handler.store.getTask('owner', id), null);
  offline = false;
  assert.equal((await app.api(`/tasks/${id}`)).status, 404);
  assert.equal((await app.credits.snapshot('owner')).balance, 1000);
  assert.equal((await app.credits.snapshot('owner')).held, 0);
  assert.equal((await app.handler.store.sweep()).pendingCredits.length, 0);
});

test('30-photo draft accepts contiguous resumable batches, detects changed deliveries, and analyse starts only once', async t => {
  const app = await setup(t); await app.api('/profile', { profile });
  const id = randomUUID(), input = await photos(30), create = { requestId: id, imageCount: 30, rightsConfirmed: true };
  assert.equal((await app.api('/tasks', { ...create, rightsConfirmed: false })).status, 422);
  assert.equal((await app.api('/tasks', { ...create, imageCount: 31 })).status, 400);
  assert.equal((await app.api('/tasks', create)).body.task.imageCount, 30);
  assert.equal((await app.api('/tasks', create)).body.task.uploadedCount, 0);
  assert.equal((await app.api('/tasks', { ...create, imageCount: 29 })).status, 409);
  assert.equal((await app.api(`/tasks/${id}/analyse`, {})).body.code, 'UPLOAD_INCOMPLETE');
  assert.equal((await app.api(`/tasks/${id}/photos`, { startIndex: 1, images: input.slice(0, 3) })).body.code, 'UPLOAD_SEQUENCE_CONFLICT');
  assert.equal((await app.api(`/tasks/${id}/photos`, { startIndex: 0, images: input.slice(0, 4) })).status, 400);
  const first = { startIndex: 0, images: input.slice(0, 3) };
  const [one, duplicate] = await Promise.all([app.api(`/tasks/${id}/photos`, first), app.api(`/tasks/${id}/photos`, first)]);
  assert.equal(one.body.task.uploadedCount, 3); assert.equal(duplicate.body.task.uploadedCount, 3);
  assert.equal((await app.api(`/tasks/${id}/photos`, { startIndex: 0, images: input.slice(3, 6) })).body.code, 'UPLOAD_BATCH_CONFLICT');
  assert.equal((await app.api(`/tasks/${id}/photos`, { startIndex: 3, images: input.slice(3, 6) }, 'another-owner')).status, 404);
  for (let startIndex = 3; startIndex < 30; startIndex += 3) {
    const uploaded = await app.api(`/tasks/${id}/photos`, { startIndex, images: input.slice(startIndex, startIndex + 3) });
    assert.equal(uploaded.body.task.uploadedCount, startIndex + 3);
    assert.equal(uploaded.body.task.status, 'uploading');
  }
  assert.equal(app.model.counts.analyse, 0);
  await Promise.all([app.api(`/tasks/${id}/analyse`, {}), app.api(`/tasks/${id}/analyse`, {})]);
  const task = await app.wait(id, ['awaiting_selection']);
  assert.equal(task.analysis.length, 30); assert.equal(task.directions[0].supportingImageIds.length, 30);
  assert.equal(app.model.counts.analyse, 10); assert.equal(app.model.counts.recommend, 1);
  assert.equal((await app.api(`/tasks/${id}/analyse`, {})).body.task.status, 'awaiting_selection');
  assert.equal((await app.api(`/tasks/${id}/photos`, first)).body.task.uploadedCount, 30);
  assert.equal(app.model.counts.analyse, 10);
});

test('unfinished upload drafts survive restart and continue from the acknowledged batch without analysis replay', async t => {
  const app = await setup(t), inputs = await photos(6), id = randomUUID();
  await app.api('/profile', { profile });
  await app.api('/tasks', { requestId: id, imageCount: 6, rightsConfirmed: true });
  const first = { startIndex: 0, images: inputs.slice(0, 3) };
  await app.api(`/tasks/${id}/photos`, first);
  await app.handler.shutdown();
  const reopened = await setup(t, { dataDir: app.root, model: app.model });
  const draft = (await reopened.api(`/tasks/${id}`)).body.task;
  assert.equal(draft.status, 'uploading'); assert.equal(draft.uploadedCount, 3); assert.equal(app.model.counts.analyse, 0);
  assert.equal((await reopened.api(`/tasks/${id}/photos`, first)).body.task.uploadedCount, 3);
  assert.equal((await reopened.api(`/tasks/${id}/photos`, { startIndex: 3, images: inputs.slice(3) })).body.task.uploadedCount, 6);
  await reopened.api(`/tasks/${id}/analyse`, {});
  assert.equal((await reopened.wait(id, ['awaiting_selection'])).analysis.length, 6);
  assert.equal(app.model.counts.analyse, 2); assert.equal(app.model.counts.recommend, 1);
});

test('cancelling stale drafts is idempotent, releases the active slot, protects ownership and cannot cancel analysis', async t => {
  const app = await setup(t); await app.api('/profile', { profile });
  const first = randomUUID(), second = randomUUID(), third = randomUUID();
  for (const id of [first, second]) await app.api('/tasks', { requestId: id, imageCount: 3, rightsConfirmed: true });
  await app.api(`/tasks/${first}/photos`, { startIndex: 0, images: await photos(3) });
  assert.equal((await app.api('/tasks', { requestId: third, imageCount: 3, rightsConfirmed: true })).status, 429);
  assert.equal((await app.api(`/tasks/${first}/cancel-upload`, {}, 'another-owner')).status, 404);
  for (let repeat = 0; repeat < 2; repeat++) {
    const cancelled = await app.api(`/tasks/${first}/cancel-upload`, {});
    assert.equal(cancelled.status, 200); assert.equal(cancelled.body.task.code, 'UPLOAD_CANCELLED');
  }
  assert.equal((await app.api(`/tasks/${first}/files/original-photo-1.png`)).status, 410);
  assert.equal((await app.api('/tasks', { requestId: third, imageCount: 3, rightsConfirmed: true })).status, 202);
  await app.api(`/tasks/${third}/photos`, { startIndex: 0, images: await photos(3) });
  await app.api(`/tasks/${third}/analyse`, {});
  assert.equal((await app.api(`/tasks/${third}/cancel-upload`, {})).status, 409);
  await app.wait(third, ['awaiting_selection']);
  assert.equal((await app.api('/usage')).body.usage.used, 0);
  await app.handler.shutdown();
  const reopened = await setup(t, { dataDir: app.root, model: app.model });
  assert.equal((await reopened.api(`/tasks/${first}`)).body.task.code, 'UPLOAD_CANCELLED');
});

test('an interrupted media batch can be replayed exactly and incompatible payloads at that pending position are rejected', async t => {
  const files = new Map(); let writes = 0;
  const media = { ready: Promise.resolve(), async put(key, bytes) { if (++writes === 2) throw new Error('simulated media outage'); files.set(key, Buffer.from(bytes)); }, async get(key) { return files.get(key); }, async remove(key) { files.delete(key); } };
  const app = await setup(t, { media }), inputs = await photos(3), id = randomUUID();
  await app.api('/profile', { profile }); await app.api('/tasks', { requestId: id, imageCount: 3, rightsConfirmed: true });
  const batch = { startIndex: 0, images: inputs };
  assert.equal((await app.api(`/tasks/${id}/photos`, batch)).status, 500);
  const pending = (await app.api(`/tasks/${id}`)).body.task;
  assert.equal(pending.status, 'uploading'); assert.equal(pending.uploadedCount, 0); assert.equal(Object.hasOwn(pending, 'pendingUpload'), false);
  assert.equal((await app.api(`/tasks/${id}/photos`, { startIndex: 0, images: [inputs[2], inputs[1], inputs[0]] })).body.code, 'UPLOAD_BATCH_CONFLICT');
  assert.equal((await app.api(`/tasks/${id}/photos`, batch)).body.task.uploadedCount, 3);
  await app.api(`/tasks/${id}/analyse`, {}); await app.wait(id, ['awaiting_selection']);
  assert.equal(files.size, 3); assert.equal(app.model.counts.analyse, 1);
});

test('expiry cleanup keeps an entire in-flight upload batch queued until late puts and failures finish', async t => {
  let clock = Date.now(), release, notify, writes = 0, removals = 0;
  const entered = new Promise(resolve => { notify = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const files = new Map();
  const media = { ready: Promise.resolve(), async put(key, bytes) {
    if (++writes === 1) { notify(); await gate; }
    else throw new Error('second photo failed after expiry');
    files.set(key, Buffer.from(bytes));
  }, async get(key) { return files.get(key); }, async remove(key) { removals++; files.delete(key); } };
  const app = await setup(t, { media, now: () => clock, cleanupIntervalMs: 10 }), id = randomUUID();
  await app.api('/profile', { profile }); await app.api('/tasks', { requestId: id, imageCount: 3, rightsConfirmed: true });
  const posting = app.api(`/tasks/${id}/photos`, { startIndex: 0, images: await photos(3) });
  try {
    await entered; clock += 3 * 24 * 3600_000 + 1;
    const queued = await app.handler.store.sweep();
    assert.equal(queued.expiredFiles.length, 3);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(removals, 0, 'none of the registered keys can be acknowledged before the batch finishes');
    assert.equal((await app.handler.store.sweep()).expiredFiles.length, 3);
  } finally { release(); }
  assert.equal((await posting).status, 500);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await app.handler.store.sweep()).expiredFiles.length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(files.size, 0, 'the late first put remains discoverable and is actually deleted');
  assert.equal((await app.handler.store.sweep()).expiredFiles.length, 0);
});

test('expiry cleanup protects every pre-registered package key until the complete background write group ends', async t => {
  let clock = Date.now(), release, notify, resultPuts = 0, resultRemovals = 0, failRollback = true;
  const entered = new Promise(resolve => { notify = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const files = new Map();
  const media = { ready: Promise.resolve(), async put(key, bytes) {
    if (key.includes('/results/')) {
      if (++resultPuts === 1) { notify(); await gate; }
      else throw new Error('second result failed after expiry');
    }
    files.set(key, Buffer.from(bytes));
  }, async get(key) { return files.get(key); }, async remove(key) {
    if (key.includes('/results/')) {
      resultRemovals++;
      if (files.has(key) && failRollback) { failRollback = false; throw new Error('one transient rollback failure'); }
    }
    files.delete(key);
  } };
  const app = await setup(t, { media, now: () => clock, cleanupIntervalMs: 10 }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  try {
    await entered; clock += 3 * 24 * 3600_000 + 1;
    const queued = await app.handler.store.sweep();
    assert.equal(queued.expiredFiles.filter(file => file.key.includes('/results/')).length, 3);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(resultRemovals, 0, 'background writes protect future image and ZIP keys, not just the current put');
    assert.equal((await app.handler.store.sweep()).expiredFiles.filter(file => file.key.includes('/results/')).length, 3);
  } finally { release(); }
  await app.wait(id, ['failed']);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await app.handler.store.sweep()).expiredFiles.length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(files.size, 0); assert.equal((await app.handler.store.sweep()).expiredFiles.length, 0);
  assert.equal((await app.api('/usage')).body.usage.used, 0);
});

test('upload pool byte cap is cumulative across batches and no oversized pool enters analysis', async t => {
  const app = await setup(t), base = Buffer.from((await photos(1))[0].dataUrl.split(',')[1], 'base64'), id = randomUUID();
  await app.api('/profile', { profile }); await app.api('/tasks', { requestId: id, imageCount: 9, rightsConfirmed: true });
  const oversized = Buffer.alloc(8 * 1024 * 1024 + 1); base.copy(oversized);
  assert.equal((await app.api(`/tasks/${id}/photos`, { startIndex: 0, images: [{ name: 'too-big.png', dataUrl: `data:image/png;base64,${oversized.toString('base64')}` }] })).status, 413);
  const bigImages = Array.from({ length: 3 }, (_, index) => { const bytes = Buffer.alloc(8 * 1024 * 1024 - 1); base.copy(bytes); bytes[bytes.length - 1] = index; return { name: `large${index}.png`, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }; });
  assert.equal((await app.api(`/tasks/${id}/photos`, { startIndex: 0, images: bigImages })).body.task.uploadedCount, 3);
  assert.equal((await app.api(`/tasks/${id}/photos`, { startIndex: 3, images: bigImages })).body.task.uploadedCount, 6);
  const rejected = await app.api(`/tasks/${id}/photos`, { startIndex: 6, images: bigImages });
  assert.equal(rejected.status, 413); assert.equal(rejected.body.code, 'UPLOAD_POOL_TOO_LARGE');
  assert.equal((await app.api(`/tasks/${id}`)).body.task.uploadedCount, 6); assert.equal(app.model.counts.analyse, 0);
});

test('a known pre-dispatch budget failure resumes saved photo analysis rather than paying to analyse acknowledged photos twice', async t => {
  const batches = []; let limited = true;
  const model = mockModel({ async analyse(input) {
    batches.push(input.map(item => item.id));
    if (batches.length === 2 && limited) { limited = false; throw Object.assign(new Error('known unsent budget exhausted'), { code: 'DAILY_QUOTA_EXCEEDED', status: 429 }); }
    return analysis(input);
  } });
  const app = await setup(t, { model }), { id, task } = await uploadPool(app, 6);
  assert.equal(task.status, 'failed'); assert.equal(task.analysis.length, 3); assert.equal(task.retryable, true);
  await app.api(`/tasks/${id}/retry`, {});
  const complete = await app.wait(id, ['awaiting_selection']);
  assert.equal(complete.analysis.length, 6);
  assert.deepEqual(batches, [['photo-1', 'photo-2', 'photo-3'], ['photo-4', 'photo-5', 'photo-6'], ['photo-4', 'photo-5', 'photo-6']]);
  assert.equal((await app.api('/usage')).body.usage.used, 0);
});

test('explicit six and fifteen-photo packages use unique real candidates and changing count forks a new charged task', async t => {
  const app = await setup(t), { id } = await uploadPool(app, 30);
  const request = { directionId: 'D01', outputCount: 6 };
  await app.api(`/tasks/${id}/generate`, request);
  const six = await app.wait(id, ['completed', 'failed']); assert.equal(six.status, 'completed', six.error);
  assert.equal(six.outputCount, 6); assert.equal(six.copy.imageOrder.length, 6); assert.equal(six.files.length, 7);
  assert.equal((await app.api(`/tasks/${id}/generate`, request)).body.task.id, id);
  assert.equal((await app.api('/usage')).body.usage.used, 1);
  const nextId = randomUUID(), next = await app.api(`/tasks/${id}/generate`, { ...request, outputCount: 15, requestId: nextId });
  assert.equal(next.body.task.id, nextId);
  const fifteen = await app.wait(nextId, ['completed', 'failed']); assert.equal(fifteen.status, 'completed', fifteen.error);
  assert.equal(fifteen.outputCount, 15); assert.equal(new Set(fifteen.copy.imageOrder).size, 15); assert.equal(fifteen.files.length, 16);
  const zip = unzipSync((await app.api(`/tasks/${nextId}/files/package.zip`)).body);
  assert.ok(zip['15.jpg']); assert.equal(Object.keys(zip).length, 16);
  assert.equal((await app.api('/usage')).body.usage.used, 2);
});

test('explicit counts reject insufficient direction evidence and permit small packages only for genuinely small pools', async t => {
  const app = await setup(t), { id } = await uploadPool(app, 6);
  for (const outputCount of [5, 7]) assert.equal((await app.api(`/tasks/${id}/generate`, { directionId: 'D01', outputCount })).body.code, 'INSUFFICIENT_DIRECTION_IMAGES');
  for (const outputCount of [0, 16, '6']) assert.equal((await app.api(`/tasks/${id}/generate`, { directionId: 'D01', outputCount })).body.code, 'INVALID_OUTPUT_COUNT');
  assert.equal(app.model.counts.write, 0); assert.equal((await app.api('/usage')).body.usage.reserved, 0);
  const sparse = await uploadPool(app, 2);
  await app.api(`/tasks/${sparse.id}/generate`, { directionId: 'D01', outputCount: 2, acceptSparse: true });
  const task = await app.wait(sparse.id, ['completed', 'failed']); assert.equal(task.status, 'completed', task.error); assert.equal(task.outputCount, 2);
});

test('direction candidates retain core evidence even when its IDs appear after the output cutoff', async t => {
  const model = mockModel({ async recommend(items) { return [direction(items, { coreImageIds: items.slice(-2).map(item => item.imageId) })]; } });
  const app = await setup(t, { model }), { id, task } = await uploadPool(app, 14);
  assert.equal(task.directions[0].supportingImageIds.length, 14);
  assert.deepEqual(task.directions[0].coreImageIds, ['photo-13', 'photo-14']);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', outputCount: 6 });
  const result = await app.wait(id, ['completed', 'failed']);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.copy.imageOrder.length, 6);
  assert.ok(result.copy.imageOrder.includes('photo-13')); assert.ok(result.copy.imageOrder.includes('photo-14'));
  assert.deepEqual(result.selection.coreImageIds, ['photo-13', 'photo-14']);
  assert.equal((await app.api('/usage')).body.usage.used, 1);
  const small = await uploadPool(app, 3);
  assert.equal((await app.api(`/tasks/${small.id}/generate`, { directionId: 'D01', outputCount: 1, acceptSparse: true })).body.code, 'CORE_IMAGES_REQUIRED');
  assert.equal(model.counts.write, 1, 'insufficient output counts must not invoke generation');
});

test('refreshing directions reuses saved analysis, coalesces identical requests and never charges a package', async t => {
  let calls = 0, finish;
  const model = mockModel({ async recommend(items) {
    calls++;
    if (calls === 1) return [direction(items, { supportingImageIds: [items[0].imageId] })];
    await new Promise(resolve => { finish = resolve; });
    return [direction(items), direction(items, { id: 'D02', label: '店内午餐日常分享', targetCustomer: '附近居民', consumptionScene: '工作日午餐', contentGoal: '店内日常介绍' })];
  } });
  const app = await setup(t, { model }), { id, task } = await uploadPool(app, 6);
  assert.equal(task.directions[0].supportingImageIds.length, 1);
  const original = structuredClone(task.analysis), originalCalls = model.counts.analyse, requestId = randomUUID();
  assert.equal((await app.api(`/tasks/${id}/recommend`, { requestId: 'invalid' })).status, 400);
  assert.equal((await app.api(`/tasks/${id}/recommend`, { requestId }, 'other-owner')).status, 404);
  const refreshed = await app.api(`/tasks/${id}/recommend`, { requestId });
  assert.equal(refreshed.status, 202); assert.equal(refreshed.body.task.progress.stage, 'recommendation');
  const duplicate = await app.api(`/tasks/${id}/recommend`, { requestId });
  assert.equal(duplicate.status, 202);
  assert.equal((await app.api(`/tasks/${id}/recommend`, { requestId: randomUUID() })).status, 409);
  const recommendationDeadline = performance.now() + 10_000;
  while (!finish && performance.now() < recommendationDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(typeof finish, 'function'); finish();
  const result = await app.wait(id, ['awaiting_selection', 'failed']);
  assert.equal(result.status, 'awaiting_selection', result.error);
  assert.equal(result.directions.length, 2); assert.equal(result.directions[0].supportingImageIds.length, 6);
  assert.deepEqual(result.analysis, original); assert.deepEqual(result.profileSnapshot, task.profileSnapshot);
  assert.equal(model.counts.analyse, originalCalls); assert.equal(calls, 2);
  assert.equal((await app.api(`/tasks/${id}/recommend`, { requestId })).status, 200);
  assert.equal(calls, 2); assert.equal((await app.api('/usage')).body.usage.used, 0);
});

test('expired originals and completed packages cannot trigger a fresh recommendation call', async t => {
  let clock = Date.now(), recommends = 0;
  const model = mockModel({ async recommend(items) { recommends++; return [direction(items)]; } });
  const app = await setup(t, { model, now: () => clock }), { id } = await uploadPool(app, 6);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', outputCount: 6 });
  assert.equal((await app.wait(id, ['completed', 'failed'])).status, 'completed');
  assert.equal((await app.api(`/tasks/${id}/recommend`, { requestId: randomUUID() })).status, 409);
  const old = await uploadPool(app, 6);
  assert.equal((await app.api('/usage')).body.usage.used, 1);
  clock += 4 * 24 * 3600000;
  assert.equal((await app.api(`/tasks/${old.id}/recommend`, { requestId: randomUUID() })).body.code, 'FILES_EXPIRED');
  assert.equal(recommends, 2); assert.equal((await app.api('/usage')).body.usage.used, 0);
});

test('scene backups cannot replace failed indispensable evidence or consume a package charge', async t => {
  const model = mockModel({ async recommend(items) { return [direction(items, { coreImageIds: [items[0].imageId] })]; } });
  const imageProcessor = { ...processor, async processPhoto(bytes, options) {
    const meta = await sharp(bytes).metadata(), pixel = await sharp(bytes).raw().toBuffer();
    if (pixel[0] === 80 && meta.width === 300) throw new Error('core evidence failed');
    return processor.processPhoto(bytes, options);
  } };
  const app = await setup(t, { model, imageProcessor }), { id } = await uploadPool(app, 7);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', outputCount: 6 });
  const result = await app.wait(id, ['failed', 'completed']);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'CORE_IMAGE_FAILED');
  assert.equal(model.counts.write, 0); assert.equal(result.files.length, 0);
  assert.equal((await app.api('/usage')).body.usage.used, 0); assert.equal((await app.api('/usage')).body.usage.reserved, 0);
});

test('strict image counts replace failed photos with real same-direction backups or fail without consuming package quota', async t => {
  const imageProcessor = { ...processor, async processPhoto(bytes, options) {
    const meta = await sharp(bytes).metadata(), pixel = await sharp(bytes).raw().toBuffer();
    if (pixel[0] === 80 && meta.width === 300) throw new Error('one failed real photo');
    return processor.processPhoto(bytes, options);
  } };
  const app = await setup(t, { imageProcessor }), { id } = await uploadPool(app, 7);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', outputCount: 6 });
  const task = await app.wait(id, ['completed', 'failed']); assert.equal(task.status, 'completed', task.error);
  assert.equal(task.copy.imageOrder.length, 6); assert.ok(task.copy.imageOrder.includes('photo-7')); assert.ok(!task.copy.imageOrder.includes('photo-1'));
  assert.equal((await app.api('/usage')).body.usage.used, 1);
  const short = await uploadPool(app, 6);
  await app.api(`/tasks/${short.id}/generate`, { directionId: 'D01', outputCount: 6 });
  const failed = await app.wait(short.id, ['failed', 'completed']); assert.equal(failed.status, 'failed'); assert.equal(failed.code, 'INSUFFICIENT_PROCESSED_IMAGES');
  assert.equal(failed.files.length, 0); assert.equal((await app.api('/usage')).body.usage.used, 1); assert.equal((await app.api('/usage')).body.usage.reserved, 0);
});

test('real image processing and ZIP complete one package; duplicate requests charge once and files are account protected', async t => {
  const app = await setup(t), input = { requestId: randomUUID(), images: await photos(), rightsConfirmed: true };
  await app.api('/profile', { profile });
  const [first, duplicate] = await Promise.all([app.api('/tasks', input), app.api('/tasks', input)]);
  assert.equal(first.status, 202); assert.equal(duplicate.status, 202);
  await app.wait(input.requestId, ['awaiting_selection']); assert.equal(app.model.counts.analyse, 1);
  const request = { directionId: 'D01', imageMode: 'cover', acceptSparse: true, facts: {} };
  const [one, two] = await Promise.all([app.api(`/tasks/${input.requestId}/generate`, request), app.api(`/tasks/${input.requestId}/generate`, request)]);
  assert.equal(one.status, 202); assert.equal(two.status, 202);
  const result = await app.wait(input.requestId, ['completed', 'awaiting_confirmation', 'failed']);
  assert.equal(result.status, 'completed', result.error); assert.equal(result.files.length, 3); assert.equal(app.model.counts.write, 1);
  assert.equal((await app.api('/usage')).body.usage.used, 1);
  assert.equal((await app.api(`/tasks/${input.requestId}/generate`, request)).body.task.id, input.requestId);
  assert.equal((await app.api('/usage')).body.usage.used, 1);
  const zip = await app.api(`/tasks/${input.requestId}/files/package.zip`);
  assert.equal(zip.status, 200); const entries = unzipSync(zip.body); assert.ok(entries['01.jpg']); assert.ok(entries['02.jpg']);
  assert.match(strFromU8(entries['发布文案.txt']), /武汉面食/);
  assert.equal((await app.api(`/tasks/${input.requestId}`, undefined, 'other')).status, 404);
  assert.equal((await app.api(`/tasks/${input.requestId}/files/01.jpg`, undefined, 'other')).status, 404);
  assert.equal((await app.api('/profile', undefined, null)).status, 401);
});

test('one complete weak draft is rewritten with its original facts and photo evidence before delivery', async t => {
  const writes = [], audited = [];
  const model = mockModel({
    async write(input) { writes.push(structuredClone(input)); return writes.length === 1 ? paddedCopy(input.analysis) : copy(input.analysis); },
    async audit(input) { audited.push(structuredClone(input)); return { status: 'passed', warnings: [], errors: [] }; },
  });
  const app = await setup(t, { model }), { id } = await newTask(app);
  const facts = { dishName: '牛肉面' };
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true, facts });
  const result = await app.wait(id, ['completed', 'awaiting_confirmation', 'failed']);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(writes.length, 2, 'one returned weak draft permits only one additional writing call');
  assert.deepEqual(writes[1].draft, paddedCopy(writes[0].analysis));
  assert.ok(Array.isArray(writes[1].qualityIssues) && writes[1].qualityIssues.length, 'rewriter receives the concrete problems with its completed draft');
  for (const field of ['profile', 'analysis', 'direction', 'facts']) assert.deepEqual(writes[1][field], writes[0][field], `rewrite retains ${field}`);
  assert.equal(writes[1].profile.name, profile.name);
  assert.deepEqual(writes[1].facts, facts);
  assert.deepEqual(writes[1].analysis.map(item => item.imageId), ['photo-1', 'photo-2']);
  assert.equal(writes[1].direction.targetCustomer, '附近上班族');
  assert.deepEqual(writes[1].photos, writes[0].photos, 'both writing calls receive the same final processed evidence');
  for (const input of writes) {
    assert.equal(input.photos.length, 2);
    assert.deepEqual(input.photos.map(photo => photo.id), ['photo-1', 'photo-2']);
    for (const photo of input.photos) {
      assert.match(photo.dataUrl, /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
      assert.ok(Buffer.from(photo.dataUrl.split(',')[1], 'base64').length > 0);
    }
  }
  assert.equal(result.copy.body, copy(writes[1].analysis).body);
  assert.equal(audited.length, 1, 'the final improved copy still receives factual publication review');
  assert.deepEqual(audited[0].copy, result.copy);
  assert.equal((await app.api(`/tasks/${id}/files/package.zip`)).status, 200);
  const usage = (await app.api('/usage')).body.usage;
  assert.equal(usage.used, 1); assert.equal(usage.reserved, 0);
});

test('clinical food narration is rewritten before publication and only the delivered package consumes points', async t => {
  const writes = [], audits = [];
  const model = mockModel({
    async write(input) {
      writes.push(structuredClone(input));
      const result = copy(input.analysis);
      if (writes.length === 1) result.body = result.body.replace('圆碗里盛着面条', '圆碗里可见长条状食材');
      return result;
    },
    async audit(input) { audits.push(input.copy); return { status: 'passed', warnings: [], errors: [] }; },
  });
  const app = await setup(t, { model, withCredits: true }), { id } = await newTask(app);
  const selection = { directionId: 'D01', imageMode: 'natural', acceptSparse: true, outputCount: 2, facts: {} };
  await app.api(`/tasks/${id}/generate`, selection);
  const result = await app.wait(id, ['completed', 'failed']);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(writes.length, 2);
  assert.ok(writes[1].qualityIssues.some(issue => /食材.*分析描述/.test(issue)));
  assert.equal(audits.length, 1);
  assert.equal(result.copy.body, copy(result.analysis).body);
  assert.equal((await app.credits.snapshot('owner')).balance, 900);
  assert.equal((await app.api(`/tasks/${id}/generate`, selection)).body.task.id, id);
  assert.equal((await app.credits.snapshot('owner')).balance, 900);
});

test('a model-only factual rejection rewrites the complete draft and reviews the replacement before delivery', async t => {
  const writes = [], audits = [];
  const parkingError = '文案出现免费停车位，但门店资料和照片分析均未确认停车信息。';
  const model = mockModel({
    async write(input) {
      writes.push(structuredClone(input));
      const original = copy(input.analysis);
      return writes.length === 1 ? { ...original, body: `${original.body}\n\n店门口设有免费停车位，开车过来也方便。` } : original;
    },
    async audit(input) {
      audits.push(structuredClone(input));
      return audits.length === 1 ? { status: 'blocked', warnings: [], errors: [parkingError] } : { status: 'passed', warnings: [], errors: [] };
    },
  });
  const app = await setup(t, { model }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  const result = await app.wait(id, ['completed', 'failed', 'awaiting_confirmation']);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(writes.length, 2); assert.equal(audits.length, 2);
  assert.match(audits[0].copy.body, /免费停车位/);
  assert.deepEqual(writes[1].draft, audits[0].copy);
  assert.ok(writes[1].qualityIssues.includes(parkingError), 'the factual audit reason is supplied to the rewriter');
  for (const field of ['profile', 'analysis', 'direction', 'facts', 'photos']) assert.deepEqual(writes[1][field], writes[0][field]);
  assert.deepEqual(audits[1].copy, result.copy);
  assert.doesNotMatch(result.copy.body, /免费停车位/);
  assert.equal(result.review.status, 'passed');
  assert.equal((await app.api(`/tasks/${id}/files/package.zip`)).status, 200);
  const usage = (await app.api('/usage')).body.usage;
  assert.equal(usage.used, 1); assert.equal(usage.reserved, 0);
});

test('a second complete padded draft fails quality without creating a deliverable or consuming package quota', async t => {
  const writes = [];
  const model = mockModel({ async write(input) { writes.push(structuredClone(input)); return paddedCopy(input.analysis); } });
  const app = await setup(t, { model }), { id } = await newTask(app);
  // This is structurally valid and long enough: repeated navigation prose must not pass merely by reaching the character target.
  assert.doesNotThrow(() => validateCopy(paddedCopy(analysis([{ id: 'photo-1' }])), ['photo-1']));
  assert.ok([...paddedCopy([]).body].length >= 250 && [...paddedCopy([]).body].length <= 500);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  const result = await app.wait(id, ['failed', 'completed', 'awaiting_confirmation']);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'COPY_QUALITY_FAILED');
  assert.equal(writes.length, 2, 'rewriting stops after the second complete response');
  assert.ok(writes[1].draft && writes[1].qualityIssues.length);
  assert.equal(result.files.length, 0);
  assert.equal((await app.api(`/tasks/${id}/files/package.zip`)).status, 404);
  const usage = (await app.api('/usage')).body.usage;
  assert.equal(usage.used, 0); assert.equal(usage.reserved, 0);
});

test('uncertain first writes and uncertain rewrites stop without automatic provider replay', async t => {
  for (const uncertainAt of [1, 2]) await t.test(`uncertain writing call ${uncertainAt}`, async t => {
    let writes = 0;
    const model = mockModel({ async write(input) {
      writes++;
      if (writes === uncertainAt) throw Object.assign(new Error('模型请求结果未确认'), { code: 'PROVIDER_UNCERTAIN', statusCode: 502 });
      return paddedCopy(input.analysis);
    } });
    const app = await setup(t, { model }), { id } = await newTask(app);
    await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
    const result = await app.wait(id, ['failed', 'completed', 'awaiting_confirmation']);
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'PROVIDER_UNCERTAIN');
    assert.equal(result.retryable, false); assert.equal(writes, uncertainAt);
    assert.equal(result.files.length, 0);
    assert.equal((await app.api(`/tasks/${id}/files/package.zip`)).status, 404);
    const retry = await app.api(`/tasks/${id}/retry`, {});
    assert.equal(retry.status, 409); assert.equal(retry.body.code, 'PROVIDER_UNCERTAIN'); assert.equal(writes, uncertainAt);
    const usage = (await app.api('/usage')).body.usage;
    assert.equal(usage.used, 0); assert.equal(usage.reserved, 0);
  });
});

test('core missing fact stops generation while irrelevant store history does not block dishes', async t => {
  const model = mockModel({ async recommend(items) { return [direction(items, { missingFacts: [{ field: 'dishName', requiredForGeneration: true, reason: '确认菜名', supportedAlternative: '门店分享' }, { field: 'history', requiredForGeneration: true, reason: '年份', supportedAlternative: '' }] })]; } });
  const app = await setup(t, { model }), { id } = await newTask(app);
  const stopped = await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  assert.equal(stopped.body.task.status, 'awaiting_facts'); assert.equal(stopped.body.task.missingFacts.length, 1); assert.equal(stopped.body.task.missingFacts[0].field, 'dishName');
  assert.equal((await app.api('/usage')).body.usage.used, 0); assert.equal(model.counts.write, 0);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', facts: { dishName: '牛肉面' }, acceptSparse: true });
  assert.equal((await app.wait(id, ['completed', 'awaiting_confirmation', 'failed'])).status, 'completed');
});

test('all unusable photos, severe privacy and invalid schemas never produce fake recommendations or charge', async t => {
  const app = await setup(t, { model: mockModel({ async analyse(items) { return analysis(items).map(item => ({ ...item, privacyRisk: 'high', usable: true })); } }) });
  const { task } = await newTask(app); assert.equal(task.status, 'failed'); assert.equal(task.code, 'NO_USABLE_PHOTOS'); assert.equal(app.model.counts.recommend, 0);
  assert.equal((await app.api('/usage')).body.usage.used, 0);
  assert.throws(() => validateAnalysis({ images: [] }, ['photo-1']), /全部照片/);
  assert.throws(() => validateDirections({ directions: [direction([{ imageId: 'unknown', usable: true }])] }, [], profile), /不可用照片/);
  assert.throws(() => validateCopy({ ...copy([{ imageId: 'photo-1' }]), imageOrder: ['wrong'] }, ['photo-1']), /不符合/);
});

test('automatic image retries remove noncore failure and copy only sees remaining evidence', async t => {
  let attempts = 0; const real = { ...processor, async processPhoto(bytes, options) { const meta = await sharp(bytes).stats(); if (meta.channels[0].mean < 90) { attempts++; throw new Error('image unavailable'); } return processor.processPhoto(bytes, options); } };
  const app = await setup(t, { imageProcessor: real }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  const result = await app.wait(id, ['completed', 'awaiting_confirmation', 'failed']); assert.equal(result.status, 'completed', result.error); assert.equal(attempts, 3);
  assert.deepEqual(result.copy.imageOrder, ['photo-2']); assert.deepEqual(result.removedImageIds, ['photo-1']); assert.equal((await app.api('/usage')).body.usage.used, 1);
});

test('warning requires explicit confirmation before download and package charge', async t => {
  const app = await setup(t, { model: mockModel({ async audit() { return { status: 'passed_with_warning', warnings: ['请确认图片中人物已授权。'], errors: [] }; } }) }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true, confirmWarnings: true });
  const result = await app.wait(id, ['awaiting_confirmation', 'failed']); assert.equal(result.status, 'awaiting_confirmation');
  assert.equal((await app.api('/usage')).body.usage.used, 0); assert.equal((await app.api(`/tasks/${id}/files/package.zip`)).status, 404);
  assert.equal((await app.api(`/tasks/${id}/confirm`, {})).status, 422);
  const responses = await Promise.all([app.api(`/tasks/${id}/confirm`, { confirmWarnings: true }), app.api(`/tasks/${id}/confirm`, { confirmWarnings: true })]);
  assert.ok(responses.every(response => response.body.task.status === 'completed')); assert.equal((await app.api('/usage')).body.usage.used, 1);
});

test('background code and public phone warnings keep real photos in recommendations and require result confirmation', async t => {
  let model;
  model = mockModel({ async analyse(items) {
    model.counts.analyse++;
    // The provider adapter validates once; the handler validates the same DTO again.
    return validateAnalysis({ images: analysis(items).map((item, index) => ({ ...item,
      textRisk: index === 0 ? 'none' : 'warning',
      visibleTexts: index === 1 ? ['门店订餐电话 010-12345678'] : [],
      riskReasons: index === 0 ? ['未发现电话或二维码隐私风险'] : index === 1
        ? ['公开门店电话，请发布前核对'] : ['背景有用途不明的二维码，文案不引用扫码信息'],
    })) }, items.map(item => item.id));
  } });
  const app = await setup(t, { model }), { id, task } = await uploadPool(app, 6);
  assert.equal(task.status, 'awaiting_selection', task.error);
  assert.equal(task.analysis.filter(item => item.usable).length, 6);
  assert.equal(task.analysis.filter(item => item.textRisk === 'warning').length, 4);
  assert.equal(task.directions[0].supportingImageIds.length, 6);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', outputCount: 6 });
  const pending = await app.wait(id, ['awaiting_confirmation', 'completed', 'failed']);
  assert.equal(pending.status, 'awaiting_confirmation', pending.error);
  assert.equal(pending.review.status, 'passed_with_warning'); assert.deepEqual(pending.review.errors, []);
  assert.equal(pending.copy.imageOrder.length, 6); assert.equal(pending.files.filter(item => item.role === 'image').length, 6);
  assert.equal(model.counts.audit, 1); assert.equal((await app.api('/usage')).body.usage.used, 0);
  assert.equal((await app.api(`/tasks/${id}/files/package.zip`)).status, 404);
  assert.equal((await app.api(`/tasks/${id}/confirm`, {})).body.code, 'WARNING_CONFIRMATION_REQUIRED');
  const confirmed = await app.api(`/tasks/${id}/confirm`, { confirmWarnings: true });
  assert.equal(confirmed.body.task.status, 'completed'); assert.equal((await app.api('/usage')).body.usage.used, 1);
  const downloaded = await app.api(`/tasks/${id}/files/package.zip`);
  assert.equal(downloaded.status, 200); assert.equal(Object.keys(unzipSync(downloaded.body)).filter(name => name.endsWith('.jpg')).length, 6);
  await app.api(`/tasks/${id}/confirm`, { confirmWarnings: true });
  assert.equal((await app.api('/usage')).body.usage.used, 1);
});

test('three day image expiry preserves text and prevents downloading or cloning expired sources', async t => {
  let clock = Date.now(); const app = await setup(t, { now: () => clock }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true }); await app.wait(id, ['completed']);
  clock += 4 * 24 * 3600000;
  const task = (await app.api(`/tasks/${id}`)).body.task; assert.ok(task.copy.body); assert.equal(task.filesExpired, true);
  assert.equal((await app.api(`/tasks/${id}/files/01.jpg`)).status, 410); assert.equal((await app.api(`/tasks/${id}/fork`, { requestId: randomUUID() })).status, 410);
});

test('package cap stops new generation without model calls; explicit fork creates independent task and debit', async t => {
  const app = await setup(t, { packageDailyLimit: 1 }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true }); await app.wait(id, ['completed']);
  const forkId = randomUUID(), fork = await app.api(`/tasks/${id}/fork`, { requestId: forkId }); assert.equal(fork.body.task.id, forkId); assert.equal(fork.body.task.status, 'awaiting_selection');
  const before = app.model.counts.write, limited = await app.api(`/tasks/${forkId}/generate`, { directionId: 'D01', acceptSparse: true }); assert.equal(limited.status, 429); assert.equal(app.model.counts.write, before);
});

test('publication blocks unsupported claims and privacy; no quota is charged', async t => {
  let writes = 0;
  const app = await setup(t, { model: mockModel({ async write(input) { writes++; return { ...copy(input.analysis), body: `${copy(input.analysis).body} 纯手工现做，天天排队，19元。` }; } }) }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true }); const result = await app.wait(id, ['failed', 'completed']);
  assert.equal(result.status, 'failed'); assert.equal(result.review.status, 'blocked'); assert.equal(writes, 2);
  assert.equal(result.files.length, 0); assert.equal((await app.api(`/tasks/${id}/files/package.zip`)).status, 404);
  assert.equal((await app.api('/usage')).body.usage.used, 0);
  assert.ok(localReview(copy([{ imageId: 'photo-1' }]), profile, {}, [{ imageId: 'photo-1', usable: false, privacyRisk: 'high', textRisk: 'none' }]).errors.length);
});

test('provider malformed JSON and uncertain transport failures consume internal attempts without auto replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'restaurant-model-')); let requests = 0;
  const model = createRestaurantModel({ config, storageDir: root, fetchImpl: async () => { requests++; return new Response(JSON.stringify({ choices: [{ message: { content: '{broken' }, finish_reason: 'stop' }] }), { status: 200 }); } });
  t.after(async () => { await model.close(); await rm(root, { recursive: true, force: true }); }); await model.ready;
  await assert.rejects(model.recommend([], profile), error => error.code === 'MODEL_INVALID_OUTPUT'); assert.equal(requests, 1); assert.equal((await model.usage()).used.chat, 1);
  const secondRoot = await mkdtemp(join(tmpdir(), 'restaurant-model-uncertain-'));
  const uncertain = createRestaurantModel({ config, storageDir: secondRoot, fetchImpl: async () => { throw new Error('connection lost'); } });
  t.after(async () => { await uncertain.close(); await rm(secondRoot, { recursive: true, force: true }); }); await uncertain.ready;
  await assert.rejects(uncertain.recommend([], profile), error => error.code === 'PROVIDER_UNCERTAIN'); assert.equal((await uncertain.usage()).used.chat, 1); assert.equal((await uncertain.usage()).recent[0].status, 'uncertain');
});

test('injected global provider ledger stays open when restaurant closes', async () => {
  let closed = 0, dispatched = 0, reserved = 0;
  const ledger = { ready: Promise.resolve(), async reserve() { reserved++; }, async markDispatched() { dispatched++; }, async finish() {}, async summary() { return { used: { chat: reserved } }; }, async close() { closed++; } };
  const model = createRestaurantModel({ config, ledger, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"directions":[]}' }, finish_reason: 'stop' }] }), { status: 200 }) });
  await model.ready; assert.deepEqual(await model.recommend([], profile), []); await model.close();
  assert.equal(reserved, 1); assert.equal(dispatched, 1); assert.equal(closed, 0);
});

test('risk text can be removed only by validated crop that preserves all subject pixels', async t => {
  const base = analysis([{ id: 'photo-1' }])[0];
  const risky = { ...base, imageType: 'staff', textRisk: 'high', visibleTexts: ['私人联系电话'], riskReasons: ['底部纸条明确标出个人姓名及私人联系电话，需要裁除后使用'] };
  const excluded = validateAnalysis({ images: [risky] }, ['photo-1']); assert.equal(excluded[0].usable, false); assert.equal(excluded[0].textRisk, 'high');
  const safe = { ...risky, safeCrop: { left: 0, top: 0, width: 1, height: 0.8 }, subjectBox: { left: 0.1, top: 0.1, width: 0.8, height: 0.6 }, riskyTextBoxes: [{ left: 0, top: 0.85, width: 1, height: 0.1 }] };
  const approved = validateAnalysis({ images: [safe] }, ['photo-1']); assert.equal(approved[0].usable, true); assert.equal(approved[0].textRisk, 'none'); assert.ok(approved[0].crop);
  const cutSubject = validateAnalysis({ images: [{ ...safe, subjectBox: { left: 0.1, top: 0.1, width: 0.8, height: 0.85 } }] }, ['photo-1']); assert.equal(cutSubject[0].usable, false);
  const app = await setup(t, { model: mockModel({ async analyse(items) { return analysis(items).map(item => ({ ...safe, imageId: item.imageId })); } }) }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  const task = await app.wait(id, ['completed', 'awaiting_confirmation', 'failed']); assert.equal(task.status, 'completed', task.error); assert.equal(task.files[0].height, 320);
});

test('numeric price evidence must come from price facts rather than an unrelated address number', () => {
  const items = analysis([{ id: 'photo-1' }]), original = copy(items);
  const claimed = { ...original, body: `${original.body}这碗面18元。`, claims: [{ text: '这碗面18元', factKeys: ['price'], imageIds: ['photo-1'] }] };
  assert.equal(localReview(claimed, profile, { price: '18' }, items).errors.length, 0);
  assert.ok(localReview(claimed, { ...profile, address: '测试路18号' }, {}, items).errors.length);
  assert.throws(() => validateCopy({ ...original, titles: [' ', '  ', '   '] }, ['photo-1']), /不符合/);
  assert.throws(() => validateCopy({ ...original, tags: ['餐饮', '#餐饮', '午餐', '门店', '武汉'] }, ['photo-1']), /不符合/);
  for (const phrase of ['保证好吃', '一定满意', '养生面']) assert.ok(localReview({ ...original, body: original.body + phrase }, profile, {}, items).errors.length);
});

test('group buy must confirm package, price and conditions even when merchant says there is a deal', async t => {
  const app = await setup(t, { model: mockModel({ async recommend(items) { return [direction(items, { label: '午餐团购套餐', contentGoal: '真实团购介绍' })]; } }) });
  await app.api('/profile', { profile: { ...profile, groupBuy: '有团购' } });
  const id = randomUUID(); await app.api('/tasks', { requestId: id, images: await photos(), rightsConfirmed: true }); const task = await app.wait(id, ['awaiting_selection']);
  assert.deepEqual(task.directions[0].missingFacts.filter(item => item.requiredForGeneration).map(item => item.field), ['setMeal', 'price', 'conditions']);
  const empty = await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true, facts: {} }); assert.equal(empty.body.task.status, 'awaiting_facts'); assert.equal(app.model.counts.write, 0);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true, facts: { setMeal: '牛肉面和饮料', price: '18', conditions: '周一至周五午餐使用，每人每次限一套' } });
  assert.equal((await app.wait(id, ['completed', 'awaiting_confirmation', 'failed'])).status, 'completed');
  const known = validateDirections({ directions: [direction(analysis([{ id: 'photo-1' }]), { label: '团购套餐', missingFacts: ['name', 'setMeal', 'price', 'conditions'].map(field => ({ field, requiredForGeneration: true, reason: '请确认', supportedAlternative: '' })) })] }, analysis([{ id: 'photo-1' }]), { ...profile, groupBuy: '套餐：牛肉面和饮料；价格：18元；使用条件：工作日午餐' });
  assert.equal(known[0].missingFacts.length, 0);
});

test('copy claims use explicit flat fact keys or exact visual image references', () => {
  const original = copy([{ imageId: 'photo-1' }]);
  const visual = { text: '照片里是盛在碗中的食物', factKeys: [], imageIds: ['photo-1'] };
  assert.deepEqual(validateCopy({ ...original, claims: [visual] }, ['photo-1']).claims, [visual]);
  const factual = { text: '面食', factKeys: ['category'], imageIds: [] };
  assert.deepEqual(validateCopy({ ...original, claims: [factual] }, ['photo-1']).claims, [factual]);
  for (const claim of [
    { ...visual, factKeys: ['visibleObjects'] },
    { ...visual, factKeys: ['profile.category'] },
    { ...visual, factKeys: ['confirmedFacts.price'] },
    { ...visual, imageIds: ['photo1'] },
    { text: '没有来源的断言', factKeys: [], imageIds: [] },
    { ...visual, text: '   ' },
    { text: '缺少数组', imageIds: ['photo-1'] },
  ]) assert.throws(() => validateCopy({ ...original, claims: [claim] }, ['photo-1']), /可追踪依据/);
  assert.match(COPY_PROMPT, /factKeys只允许以下平铺字段名/);
  assert.match(COPY_PROMPT, /纯视觉事实必须使用factKeys:\[\]/);
  assert.match(COPY_PROMPT, /正文必须自然写出profile.name原值/);
});

test('asset task filter uses completion time and includes old tasks completed recently', async t => {
  let clock = Date.now();
  const app = await setup(t, { now: () => clock, model: mockModel({ async audit() { return { status: 'passed_with_warning', warnings: ['核对门店资料后可发布。'], errors: [] }; } }) });
  const { id } = await newTask(app);
  const createdAt = clock;
  clock += 2.5 * 24 * 3600000;
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true });
  await app.wait(id, ['awaiting_confirmation']);
  clock += 24 * 3600000;
  await app.api(`/tasks/${id}/confirm`, { confirmWarnings: true });
  assert.ok(createdAt < clock - 3 * 24 * 3600000);
  const waiting = await newTask(app);
  const oldCompletedId = randomUUID();
  await app.handler.store.createTask('owner', { id: oldCompletedId, status: 'completed', completedAt: clock - 4 * 24 * 3600000, sourceImages: [], files: [] });
  const recent = await app.api(`/tasks?limit=50&completed=true&completedAfter=${clock - 3 * 24 * 3600000}`);
  assert.equal(recent.status, 200); assert.deepEqual(recent.body.tasks.map(item => item.id), [id]);
  assert.equal(recent.body.tasks[0].completedAt, clock); assert.ok(recent.body.tasks[0].createdAt < clock - 3 * 24 * 3600000);
  const all = await app.api('/tasks'); assert.ok(all.body.tasks.some(item => item.id === waiting.id)); assert.ok(all.body.tasks.some(item => item.id === oldCompletedId));
  for (const value of ['Infinity', 'NaN', '-1', '']) assert.equal((await app.api(`/tasks?completedAfter=${value}`)).status, 400);
  assert.equal((await app.api('/tasks?completed=maybe')).status, 400);
});
