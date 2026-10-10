import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { preparePhotoPixels } from '../services/restaurant/images.mjs';
import { extractFoodSubject, processPromotionalPhoto, addPromotionalHeadline, promotionalPalette } from '../services/restaurant/promotion.mjs';
import { validateAnalysis, validateCopy, localReview } from '../services/restaurant/rules.mjs';

const box = { left: 220 / 720, top: 100 / 480, width: 280 / 720, height: 280 / 480 };
const circleOutline = (x,y,r) => Array.from({length:16},(_,i)=>({x:(x+Math.cos(i*Math.PI/8)*r)/720,y:(y+Math.sin(i*Math.PI/8)*r)/480}));
const subjects = [{ box, outline: circleOutline(360,240,138), confidence: .95, label: '圆盘中的食物' }];
const source = async () => sharp(Buffer.from('<svg width="720" height="480"><rect width="720" height="480" fill="#254461"/><circle cx="360" cy="240" r="140" fill="#d2ac68"/><circle cx="340" cy="215" r="30" fill="#a52b21"/><circle cx="400" cy="280" r="15" fill="#348531"/></svg>')).png().toBuffer();
const ellipseMask = () => sharp(Buffer.from('<svg width="320" height="320"><rect width="320" height="320" fill="black"/><circle cx="160" cy="160" r="138" fill="white"/></svg>')).greyscale().png().toBuffer();

test('cutout preserves every opaque RGB pixel and removes background without striped or transparent food', async () => {
  const original = await preparePhotoPixels(await source());
  const result = await extractFoodSubject(original, subjects, { mask: ellipseMask });
  assert.equal(result.method, 'source-cutout');
  const raw = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  const before = await sharp(original.bytes).removeAlpha().raw().toBuffer();
  let opaque = 0, transparent = 0;
  for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
    const pos = (y * result.width + x) * 4;
    if (!raw[pos + 3]) transparent++;
    if (raw[pos + 3] === 255) {
      opaque++;
      const src = ((y + result.top) * original.width + x + result.left) * 3;
      assert.deepEqual(raw.subarray(pos, pos + 3), before.subarray(src, src + 3));
    }
    if (Math.hypot(x + result.left - 360, y + result.top - 240) < 110) assert.equal(raw[pos + 3], 255, 'food interior stays fully opaque on every row');
  }
  assert.ok(opaque > 50_000); assert.ok(transparent > 10_000);
});

test('every separate dish gets a mask and all dishes retain their original relative positions', async () => {
  const bytes = await sharp(Buffer.from('<svg width="720" height="480"><rect width="720" height="480" fill="navy"/><circle cx="180" cy="240" r="90" fill="orange"/><circle cx="540" cy="240" r="90" fill="lime"/></svg>')).png().toBuffer();
  const source = await preparePhotoPixels(bytes); let calls = 0;
  const result = await extractFoodSubject(source, [90, 450].map(left => ({ box: { left: left / 720, top: 150 / 480, width: 180 / 720, height: 180 / 480 }, outline: circleOutline(left+90,240,88), confidence: .95 })), { mask: () => { calls++; return ellipseMask(); } });
  assert.equal(calls, 2);
  const raw = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  const pixel = x => raw.subarray(((240 - result.top) * result.width + x - result.left) * 4, ((240 - result.top) * result.width + x - result.left) * 4 + 4);
  assert.deepEqual([...pixel(180)], [255, 165, 0, 255]);
  assert.deepEqual([...pixel(540)], [0, 255, 0, 255]);
  assert.equal(pixel(360)[3], 0, 'table space between plates is replaced');
});

test('incomplete, malformed and uncertain subject masks keep the whole source instead of dropping food', async () => {
  const bytes = await source();
  for (const mask of [async () => Buffer.from('broken'), () => sharp({ create: { width: 320, height: 320, channels: 1, background: 'black' } }).png().toBuffer(),
    () => sharp({ create: { width: 320, height: 320, channels: 1, background: 'white' } }).png().toBuffer(), async () => { throw new Error('worker unavailable'); }]) {
    const result = await processPromotionalPhoto(bytes, { analysis: { imageType: 'food', foodSubjects: subjects }, mask });
    assert.equal(result.composition.method, 'original-frame');
    assert.equal(result.width, 1080); assert.equal(result.height, 1440);
  }
  let calls = 0;
  const result = await processPromotionalPhoto(bytes, { analysis: { imageType: 'food', foodSubjects: [{ ...subjects[0], confidence: .6 }] }, mask: () => { calls++; return ellipseMask(); } });
  assert.equal(result.composition.method, 'original-frame'); assert.equal(calls, 0);
});

test('non-food photos and old analyses retain a complete original frame without calling the masker', async () => {
  let calls = 0;
  for (const imageType of ['interior', 'exterior', 'preparation', 'people', 'food']) {
    const result = await processPromotionalPhoto(await source(), { analysis: { imageType }, mask: () => { calls++; return ellipseMask(); } });
    assert.equal(result.composition.method, 'original-frame');
  }
  assert.equal(calls, 0);
});

test('safe crop is applied before composition and subjects outside it cannot bring removed risks back', async () => {
  const bytes = await source(), crop = { left: .05, top: .05, width: .9, height: .9 };
  let calls = 0;
  const result = await processPromotionalPhoto(bytes, { crop, analysis: { imageType: 'food', foodSubjects: [{ box: { left: .01, top: .1, width: .3, height: .5 }, confidence: .99 }] }, mask: () => { calls++; return ellipseMask(); } });
  assert.equal(result.composition.method, 'original-frame'); assert.equal(calls, 0);
  await assert.rejects(processPromotionalPhoto(bytes, { crop: { left: 0, top: 0, width: .4, height: .4 } }), { code: 'invalid_image' });
});

test('headline is confined to the reserved header and a package shares its palette', async () => {
  const result = await processPromotionalPhoto(await source(), { analysis: { imageType: 'food', foodSubjects: subjects }, mask: ellipseMask, seed: 'one-package' });
  assert.equal(result.composition.method, 'source-cutout');
  assert.deepEqual(promotionalPalette('one-package'), promotionalPalette('one-package'));
  const cover = await addPromotionalHeadline(result, '附近午餐想吃这份实拍', 'one-package');
  const before = await sharp(result.bytes).extract({ left: 0, top: 450, width: 1080, height: 850 }).raw().toBuffer();
  const after = await sharp(cover.bytes).extract({ left: 0, top: 450, width: 1080, height: 850 }).raw().toBuffer();
  let difference = 0; for (let i = 0; i < before.length; i++) difference += Math.abs(before[i] - after[i]);
  assert.ok(difference / before.length < 2, 'adding text does not repaint the food');
  const top = await sharp(cover.bytes).extract({ left: 60, top: 160, width: 960, height: 190 }).stats();
  assert.ok(top.channels[0].stdev > 20, 'large headline is rendered');
  const reordered = await addPromotionalHeadline(result, '附近午餐想吃这份实拍', 'one-package', { index: 5 });
  const footer = image => sharp(image.bytes).extract({ left: 950, top: 1320, width: 70, height: 70 }).raw().toBuffer();
  assert.notDeepEqual(await footer(cover), await footer(reordered), 'page numbers use the final copy order');
  await assert.rejects(addPromotionalHeadline(result, '短字')); await assert.rejects(addPromotionalHeadline(result, '附近午餐想吃这份实拍\n<script>'));
});

test('analysis preserves valid food geometry across validation and invalid geometry does not reject otherwise usable photos', () => {
  const base = { imageId: 'photo-1', imageType: 'food', visibleObjects: ['圆盘中的食物'], possibleScene: ['午餐'], qualityScore: 90, privacyRisk: 'none', usable: true, rejectionReason: '', textRisk: 'none', foodSubjects: subjects };
  const first = validateAnalysis({ images: [base] }, ['photo-1']);
  assert.deepEqual(validateAnalysis({ images: first }, ['photo-1'])[0].foodSubjects, subjects);
  const invalid = validateAnalysis({ images: [{ ...base, foodSubjects: [{ box: { ...box, left: -1 }, confidence: .9 }] }] }, ['photo-1'])[0];
  assert.equal(invalid.usable, true); assert.equal(invalid.foodSubjects, undefined);
});

test('a mask that splits a dish cannot deliver a missing rim and falls back to the complete photograph', async () => {
  const bytes = await source(), original = await preparePhotoPixels(bytes);
  const damagedMask = () => sharp(Buffer.from('<svg width="320" height="320"><rect width="320" height="320" fill="black"/><circle cx="160" cy="160" r="138" fill="white"/><rect x="50" y="70" width="220" height="40" fill="black"/></svg>')).greyscale().png().toBuffer();
  await assert.rejects(extractFoodSubject(original, subjects, { mask: damagedMask }), { code: 'SUBJECT_MASK_UNSAFE' });
  const result = await processPromotionalPhoto(bytes, { analysis: { imageType: 'food', foodSubjects: subjects }, mask: damagedMask });
  assert.equal(result.composition.method, 'original-frame');
  assert.equal(result.composition.fallbackReason, 'SUBJECT_MASK_UNSAFE');
});

test('unknown, crossed or out-of-bounds contours use a full photo instead of risking a partial dish', async () => {
  let calls = 0;
  const bad = [undefined, subjects[0].outline.map((p, i) => i === 0 ? { x: -1, y: p.y } : p), [...subjects[0].outline].sort((a, b) => a.x - b.x)];
  for (const outline of bad) {
    const result = await processPromotionalPhoto(await source(), { analysis: { imageType: 'food', foodSubjects: [{ ...subjects[0], outline }] }, mask: () => { calls++; return ellipseMask(); } });
    assert.equal(result.composition.method, 'original-frame');
  }
  assert.equal(calls, 0);
});

test('image captions must match unique source IDs and receive the same factual checks as the main copy', () => {
  const ids = ['photo-1', 'photo-2'];
  const draft = { titles: ['附近上班族午餐来看看这一碗', '给附近找面食的朋友一个选择', '来真实街道吃一顿自己的午饭'], body: '老板邀请附近的朋友看看这一碗。', tags: ['面食', '午餐', '附近', '门店', '实拍'], coverText: '午餐想吃面看看这一碗', imageOrder: ids,
    claims: [{ text: '面食', factKeys: ['category'], imageIds: [] }], imageCaptions: ids.map(imageId => ({ imageId, text: '附近午餐看看这一碗面' })) };
  assert.deepEqual(validateCopy(draft, ids).imageCaptions, draft.imageCaptions);
  for (const imageCaptions of [[draft.imageCaptions[0]], [{ ...draft.imageCaptions[0], imageId: 'other' }, draft.imageCaptions[1]], [draft.imageCaptions[0], draft.imageCaptions[0]],
    draft.imageCaptions.map(item => ({ ...item, text: '附近午餐来看看\n<script>' }))]) assert.throws(() => validateCopy({ ...draft, imageCaptions }, ids), { code: 'MODEL_INVALID_OUTPUT' });
  const unsafe = validateCopy({ ...draft, imageCaptions: [{ imageId: 'photo-1', text: '全网第一纯手工面条等你' }, draft.imageCaptions[1]] }, ids);
  const review = localReview(unsafe, { category: '面食' }, {}, []);
  assert.ok(review.errors.some(message => /绝对化/.test(message)));
  assert.ok(review.errors.some(message => /手工.*依据/.test(message)));
});
