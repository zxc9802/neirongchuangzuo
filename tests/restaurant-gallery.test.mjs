import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { createGalleryPlan, validateGalleryStoryboard, galleryDirection, storeSceneContext, enhanceStorePhoto, isolateDishReference } from '../services/restaurant/gallery.mjs';
import { validateFoodAppearance } from '../services/restaurant/rules.mjs';
import { createPackageZip } from '../services/restaurant/images.mjs';
import { foodPhotoPrompt, foodScene, foodPhotoPlan } from '../services/restaurant/scenes.mjs';

function material(types) {
  return { profileSnapshot: { category: '烧烤' }, sourceImages: types.map((_, i) => ({ id: `p${i}`, hash: `hash${i}` })),
    analysis: types.map((imageType, i) => ({ imageId: `p${i}`, imageType, qualityScore: 90 - i, usable: true, privacyRisk: 'none', textRisk: 'none',
      visibleObjects: imageType === 'interior' ? ['木纹餐桌', '深灰墙面', '暖色吊灯'] : ['原图主体'] })) };
}

test('fallback nine-frame set preserves useful whole-pool scenes when distinct food themes have not been identified', () => {
  const task = material(['food', 'interior', 'exterior', 'preparation', ...Array(26).fill('food')]);
  task.directions = [{ supportingImageIds: ['p0'] }];
  const shots = createGalleryPlan(task, 9);
  assert.equal(shots.length, 9); assert.equal(new Set(shots.map(shot => shot.imageId)).size, 9);
  assert.equal(shots[0].kind, 'food'); assert.equal(shots.filter(shot => shot.kind === 'food').length, 6);
  assert.deepEqual(new Set(shots.filter(shot => shot.kind === 'scene').map(shot => task.analysis.find(item => item.imageId === shot.sourceImageId).imageType)), new Set(['interior', 'exterior', 'preparation']));
  for (const shot of shots.filter(shot => shot.kind === 'food')) {
    assert.deepEqual(shot.referenceImageIds, ['p1', 'p2']);
    assert.match(JSON.stringify(storeSceneContext(task, shot)), /木纹餐桌/);
  }
});

test('dining scene supplies the actual interior while limited food sources retain useful preparation', () => {
  const task = material(['exterior', 'customers', 'preparation', 'food', 'food']);
  task.analysis[1].visibleObjects = ['店内木桌和木凳', '用餐区顾客'];
  const shots = createGalleryPlan(task, 9);
  assert.equal(shots.filter(shot => shot.kind === 'food').length, 6);
  assert.deepEqual(shots.filter(shot => shot.kind === 'scene').map(shot => shot.sourceImageId), ['p0', 'p1', 'p2']);
  assert.ok(shots.filter(shot => shot.kind === 'food').every(shot => shot.referenceImageIds.join() === 'p1,p0'));
});

test('missing storefront or interior slots are filled by new food views without borrowing unrelated scenes', () => {
  for (const types of [['food'], ['food','exterior'], ['food','interior'], ['food','customers','preparation']]) {
    const task = material(types), shots = createGalleryPlan(task, 9);
    const expectedContext = types.filter(type => ['exterior','interior','preparation'].includes(type)).length;
    assert.equal(shots.length, 9); assert.equal(shots.filter(shot => shot.kind === 'food').length, 9 - expectedContext);
    assert.equal(new Set(shots.filter(shot => shot.kind === 'food').map(shot => galleryShotForTest(shot))).size, 9 - expectedContext);
  }
});

function galleryShotForTest(shot) { return foodPhotoPlan({type:'hotpot'}, shot.shotIndex).camera; }

test('two genuine food photos can support nine distinct camera plans, rather than copying two original files', () => {
  const task = material(['food', 'food']);
  const shots = createGalleryPlan(task, 9);
  assert.equal(shots.length, 9); assert.equal(new Set(shots.map(shot => shot.sourceImageId)).size, 2);
  assert.equal(new Set(shots.map(shot => foodPhotoPlan({ type: 'neighborhood' }, shot.shotIndex).angle)).size, 4);
  assert.equal(galleryDirection(task.analysis, task.profileSnapshot).supportingImageIds.length, 2);
});

test('six frames still include actual food, interior, exterior and service when all roles are available', () => {
  const task = material(['food','food','interior','exterior','preparation']);
  const shots = createGalleryPlan(task, 6);
  assert.equal(shots.filter(shot => shot.kind === 'food').length, 3);
  assert.deepEqual(new Set(shots.map(shot => task.analysis.find(item => item.imageId === shot.sourceImageId).imageType)), new Set(['food','interior','exterior','preparation']));
});

test('a previously unreliable rephotography reference stays usable evidence while another food supplies the new frame',()=>{
  const task=material(['food','food','interior','exterior','preparation']);task.foodReferenceExclusions=['p0'];
  assert.ok(createGalleryPlan(task,6).filter(shot=>shot.kind==='food').every(shot=>shot.sourceImageId==='p1'));
  assert.equal(task.analysis[0].usable,true);assert.ok(galleryDirection(task.analysis,task.profileSnapshot).supportingImageIds.includes('p0'));
});

const dish = { description: '完整餐盘内的主菜', portion: '一盘', arrangement: '位于餐盘中间', vessel: '黑色餐盘', colors: ['金黄'], visibleComponents: ['完整主菜'], texture: ['有光泽'], distinctiveFeatures: [], uncertainDetails: [], dishCount: 1, pieceCount: null };
function storyboardShot(id, kind, index) {
  return { sourceImageId:id,kind,foodGroupId:kind==='food'?'single-dish':'',name:`画面${index}`,purpose:'展示实际可见的食品或门店场景',
    focus:'原图主菜',angle:index%2?'overhead':'oblique',camera:'不同机位展示原图主体',lighting:'明亮柔和自然光' };
}
test('single-dish materials with enough real scenes cannot become seven copies of the same food theme',()=>{
  const task=material(['food',...Array(8).fill('preparation'),'interior','exterior']);
  const board={theme:'一盘菜从制作到上桌',foodGroups:[{id:'single-dish',label:'同一盘菜',imageIds:['p0']}],
    shots:[...Array.from({length:7},(_,i)=>storyboardShot('p0','food',i)),storyboardShot('p9','scene',7),storyboardShot('p10','scene',8)]};
  assert.throws(()=>validateGalleryStoryboard(board,task,9),{code:'INVALID_GALLERY_STORYBOARD'});
  board.shots=[...Array.from({length:3},(_,i)=>storyboardShot('p0','food',i)),...Array.from({length:6},(_,i)=>storyboardShot(`p${i+1}`,'scene',i+3))];
  const validated=validateGalleryStoryboard(board,task,9);
  assert.equal(validated.shots.filter(x=>x.kind==='food').length,3);
  assert.deepEqual(createGalleryPlan({...task,galleryStoryboard:validated},9).map(x=>x.sourceImageId),validated.shots.map(x=>x.sourceImageId));
  assert.equal(new Set(createGalleryPlan(task,9).filter(x=>x.kind==='scene').map(x=>x.sourceImageId)).size,6);
});
test('storyboard rejects invented food sources and duplicate scene frames before dispatching generation',()=>{
  const task=material(['food',...Array(8).fill('preparation')]);
  const board={theme:'食品与制作',foodGroups:[{id:'single-dish',label:'同一盘菜',imageIds:['p0']}],
    shots:[...Array.from({length:3},(_,i)=>storyboardShot('p0','food',i)),...Array.from({length:6},(_,i)=>storyboardShot(`p${i+1}`,'scene',i+3))]};
  board.shots[8].sourceImageId='invented';assert.throws(()=>validateGalleryStoryboard(board,task,9),{code:'INVALID_GALLERY_STORYBOARD'});
  board.shots[8].sourceImageId='p1';assert.throws(()=>validateGalleryStoryboard(board,task,9),{code:'INVALID_GALLERY_STORYBOARD'});
});
test('main-dish reference retains the whole identified vessel with a margin and excludes incidental edge dishes', async () => {
  const bytes = await sharp({ create: { width: 1000, height: 800, channels: 3, background: 'red' } })
    .composite([{ input: await sharp({ create: { width: 600, height: 480, channels: 3, background: 'green' } }).png().toBuffer(), left: 200, top: 160 }]).jpeg().toBuffer();
  const reference = { bytes, mime: 'image/jpeg', id: 'main-dish' };
  const appearance = validateFoodAppearance({ ...dish, identityScope: 'dish', subjectBox: { left: .2, top: .2, width: .6, height: .6 }, subjectConfidence: .94 });
  const cropped = await isolateDishReference(reference, appearance), meta = await sharp(cropped.bytes).metadata();
  assert.ok(meta.width >= 650 && meta.width <= 651); assert.ok(meta.height >= 520 && meta.height <= 521);
  assert.equal(cropped.id, reference.id); assert.match(cropped.dataUrl, /^data:image\/jpeg;base64,/);
  const center = await sharp(cropped.bytes).extract({ left: 100, top: 100, width: 200, height: 200 }).stats();
  assert.ok(center.channels[1].mean > center.channels[0].mean);
  assert.strictEqual(await isolateDishReference(reference, validateFoodAppearance({ ...dish, identityScope: 'spread' })), reference);
});

test('unreliable or out-of-bounds subject boxes cannot crop a food reference', () => {
  for (const extra of [
    { subjectBox: { left: .2, top: .2, width: .6, height: .6 }, subjectConfidence: .7 },
    { subjectBox: { left: .8, top: .2, width: .6, height: .6 }, subjectConfidence: .95 },
    { subjectBox: { left: .2, top: .2, width: .01, height: .6 }, subjectConfidence: .95 }
  ]) assert.equal(validateFoodAppearance({ ...dish, identityScope: 'dish', ...extra }).subjectBox, undefined);
});

test('severe risks, unrelated menu photos and exact duplicates cannot become gallery frames or environment references', () => {
  const task = material(['food', 'interior', 'interior', 'menu', 'exterior']);
  task.analysis[1].privacyRisk = 'high'; task.sourceImages[4].hash = task.sourceImages[0].hash;
  const shots = createGalleryPlan(task, 6);
  assert.ok(shots.every(shot => !['p1','p3','p4'].includes(shot.sourceImageId)));
  assert.ok(shots.filter(shot => shot.kind === 'food').every(shot => shot.referenceImageIds.join() === 'p2'));
  assert.throws(() => createGalleryPlan(material(['interior','exterior']), 6), { code: 'INSUFFICIENT_GALLERY_MATERIAL' });
  assert.throws(() => createGalleryPlan(task, 0), { code: 'INVALID_OUTPUT_COUNT' });
});

test('scene enhancement brightens actual pixels, preserves every original scene edge and uses the same portrait output size', async () => {
  const input = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#404040' } }).png().toBuffer();
  const result = await enhanceStorePhoto(input, { imageId: 'store-1', rotation: 0 });
  const meta = await sharp(result.bytes).metadata(), pixels = await sharp(result.bytes).raw().toBuffer();
  assert.equal(meta.width, 1080); assert.equal(meta.height, 1440);
  assert.ok(pixels[Math.floor(pixels.length / 2)] > 64);
  assert.equal(result.composition.generatedScene, false); assert.equal(result.composition.sourceImageId, 'store-1');
});

test('food direction takes real store references before generic restaurant templates and requests full-bleed photography without text', () => {
  const scene = { ...foodScene({}, { category: '烧烤' }), storeContext: { sourceImageIds: ['store-1'], evidence: [{ visibleObjects: ['灰墙','石纹桌面'] }], look: '明亮统一' } };
  const prompt = foodPhotoPrompt({ scene, appearance: {}, plan: foodPhotoPlan(scene, 1) });
  assert.match(prompt, /第二张及后续附图/); assert.match(prompt, /石纹桌面/); assert.match(prompt, /不凭空豪华化/); assert.match(prompt, /不留文字区/);
});

test('optional copy cannot insert empty JSON and risk commentary into a customer gallery download', async () => {
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'white' } }).jpeg().toBuffer();
  const files = unzipSync(await createPackageZip([{ bytes, format: 'jpeg' }], { cleanExport: true, body: '', titles: [] }));
  assert.deepEqual(Object.keys(files), ['01.jpg']);
});
