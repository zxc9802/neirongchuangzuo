import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { galleryContactSheets, galleryEditPrompt, validateVisualStyle, validateGalleryImageReview, validateGallerySetReview } from '../services/restaurant/art-direction.mjs';
import { validateGalleryStoryboard } from '../services/restaurant/gallery.mjs';
import { createRestaurantModel } from '../services/restaurant/model.mjs';
import { GALLERY_IMAGE_AUDIT_PROMPT, GALLERY_SET_AUDIT_PROMPT } from '../services/restaurant/prompts.mjs';

const style = { name: '冷调霓虹夜色', mood: '安静通透', lighting: '保留夜景的暗部与局部光源', tone: '冷青配合局部琥珀光', texture: '真实摄影质感', palette: ['冷青', '琥珀'], instructions: '不要整体增亮，维持夜色层次。' };
const shot = { imageId: 'shot-01', sourceImageId: 'photo-1', kind: 'scene', name: '店内夜色', purpose: '展示空间氛围', camera: '拉正轻微透视，保留室内全景', angle: 'oblique', lighting: '遵循局部光源', editInstructions: '保留暗墙，把霓虹灯高光压下来。' };
const review = { status: 'passed', styleScore: 94, identityMatch: true, sceneMatch: true, shotMatch: true, compositionUsable: true, styleMatch: true, marketingUseful: true, errors: [], warnings: [] };
const sourceBytes = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#303a40' } }).jpeg().toBuffer();
const photo = { id: 'photo-1', bytes: sourceBytes, mime: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${sourceBytes.toString('base64')}` };

test('director chooses an unrestricted filter and styled storyboards may lead with a real scene', () => {
  assert.deepEqual(validateVisualStyle(style), style);
  assert.equal(validateVisualStyle({ ...style, instructions: undefined }).instructions, [style.lighting,style.tone,style.texture].join('；'));
  assert.throws(() => validateVisualStyle({ ...style, tone: undefined }), { code: 'INVALID_GALLERY_STYLE' });
  const task = { sourceImages: [{ id: 'photo-1', hash: 'one' }], analysis: [{ imageId: 'photo-1', imageType: 'interior', usable: true, qualityScore: 80, visibleObjects: ['深色墙面'] }] };
  const input = { theme: '室内夜色', visualStyle: style, foodGroups: [], shots: [shot] };
  const board = validateGalleryStoryboard(input, task, 1, { requireStyle: true });
  assert.equal(board.version, 2); assert.equal(board.shots[0].kind, 'scene'); assert.deepEqual(board.visualStyle, style);
  assert.equal(validateGalleryStoryboard({ ...input, shots: [{ ...shot, angle: undefined }] }, task, 1, { requireStyle: true }).shots[0].angle, 'original');
  assert.throws(() => validateGalleryStoryboard({ ...input, shots: [{ ...shot, angle: 'invented' }] }, task, 1, { requireStyle: true }), { code: 'INVALID_GALLERY_STORYBOARD' });
  assert.throws(() => validateGalleryStoryboard({ ...input, visualStyle: undefined }, task, 1, { requireStyle: true }), { code: 'INVALID_GALLERY_STYLE' });
  assert.throws(() => validateGalleryStoryboard({ ...input, shots: [{ ...shot, editInstructions: '' }] }, task, 1, { requireStyle: true }), { code: 'INVALID_GALLERY_STORYBOARD' });
});

test('all thirty original images appear in numbered overview sheets with no material lost', async () => {
  const originals = Array.from({ length: 30 }, (_, i) => ({ ...photo, id: `photo-${i + 1}` }));
  const sheets = await galleryContactSheets(originals);
  assert.equal(sheets.length, 3); assert.deepEqual(sheets.flatMap(s => s.imageIds), originals.map(p => p.id));
  for (const sheet of sheets) { const meta = await sharp(sheet.bytes).metadata(); assert.equal(meta.width, 960); assert.equal(meta.format, 'jpeg'); assert.ok(meta.height <= 1020); }
});

test('a passing image or set review cannot hide style drift or fabricated revision IDs', () => {
  assert.deepEqual(validateGalleryImageReview(review), review);
  for (const change of [{ styleMatch: false }, { marketingUseful: false }, { styleScore: 101 }, { errors: ['风格已偏离'] }])
    assert.throws(() => validateGalleryImageReview({ ...review, ...change }), { code: 'MODEL_INVALID_OUTPUT' });
  assert.equal(validateGallerySetReview({ status: 'blocked', reviseImageIds: ['shot-01'], errors: ['色温偏暖'], warnings: [] }, ['shot-01']).status, 'blocked');
  assert.throws(() => validateGallerySetReview({ status: 'blocked', reviseImageIds: ['unknown'], errors: ['偏暖'], warnings: [] }, ['shot-01']), { code: 'MODEL_INVALID_OUTPUT' });
  assert.throws(() => validateGallerySetReview({ status: 'passed', reviseImageIds: ['shot-01'], errors: [], warnings: [] }, ['shot-01']), { code: 'MODEL_INVALID_OUTPUT' });
});

test('scene and food prompts transmit the same director style and preserve different factual constraints', () => {
  const scenePrompt = galleryEditPrompt({ style, shot });
  assert.ok(scenePrompt.includes(JSON.stringify(style))); assert.match(scenePrompt, /保留暗墙/); assert.match(scenePrompt, /never a mandatory brightness increase/);
  assert.match(scenePrompt, /Do not redesign the shop/); assert.match(scenePrompt, /without text overlays/);
  const foodPrompt = galleryEditPrompt({ style, shot: { ...shot, kind: 'food' }, appearance: { description: '可见牛排' }, corrections: ['减少塑料感'] });
  assert.ok(foodPrompt.includes(JSON.stringify(style))); assert.match(foodPrompt, /ingredient TYPES/); assert.match(foodPrompt, /Never turn leftovers or an empty plate/); assert.match(foodPrompt, /减少塑料感/);
});

test('Image 2.5 receives Claude scene instructions and accepted references through the real edit adapter', async () => {
  const requests = [], records = new Map();
  const ledger = { ready: Promise.resolve(), async reserve(record) { records.set(record.id, record); return { created: true }; }, async markDispatched() {}, async finish(id, patch) { Object.assign(records.get(id), patch); }, async get(id) { return records.get(id); }, async close() {} };
  const model = createRestaurantModel({ config: { apiKey: 'test', baseUrl: 'https://provider.invalid/v1', imageModel: 'gpt-image-2.5-sunburst-c', imageTextModel: 'claude-opus-5-5', limits: {} }, ledger,
    fetchImpl: async (url, options) => { requests.push({ url, options }); return Response.json({ data: [{ b64_json: sourceBytes.toString('base64') }] }); } });
  const accepted = { ...photo, id: 'accepted-photo-1', approvedStyle: true };
  const result = await model.renderGalleryPhoto({ photo, context: [accepted], style, shot, taskId: 'task', attempt: 2, corrections: ['压制高光'] });
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://provider.invalid/v1/images/edits');
  const form = requests[0].options.body;
  assert.equal(form.get('model'), 'gpt-image-2.5-sunburst-c'); assert.equal(form.getAll('image').length, 2); assert.equal(form.get('size'), '960x1280');
  assert.ok(form.get('prompt').includes(JSON.stringify(style))); assert.match(form.get('prompt'), /保留暗墙/); assert.match(form.get('prompt'), /压制高光/); assert.match(form.get('prompt'), /accepted-style-target-for-this-original/);
  assert.match(result.requestId, /^restaurant-gallery-v2-/); assert.equal(records.get(result.requestId).status, 'completed');
  const meta = await sharp(result.bytes).metadata(); assert.equal(meta.width, 1080); assert.equal(meta.height, 1440);
});

test('both individual aesthetic and whole-set checks use Claude with shared style and real visual attachments', async () => {
  const requests = [], results = [review, { status: 'passed', reviseImageIds: [], errors: [], warnings: [] }];
  const ledger = { ready: Promise.resolve(), async reserve() {}, async markDispatched() {}, async finish() {} };
  const model = createRestaurantModel({ config: { apiKey: 'test', baseUrl: 'https://provider.invalid/v1', chatModel: 'other-chat', imageTextModel: 'claude-opus-5-5', limits: {} }, ledger,
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: JSON.stringify(results.shift()) }, finish_reason: 'stop' }] }); } });
  await model.reviewGalleryPhoto({ visualStyle: style, shot, photos: [photo, { ...photo, id: 'shot-01' }] });
  await model.reviewGallerySet({ visualStyle: style, shots: [shot], photos: await galleryContactSheets([{ ...photo, id: 'shot-01' }]) });
  assert.deepEqual(requests.map(r => r.model), ['claude-opus-5-5', 'claude-opus-5-5']);
  assert.deepEqual(requests.map(r => r.messages[0].content), [GALLERY_IMAGE_AUDIT_PROMPT, GALLERY_SET_AUDIT_PROMPT]);
  assert.deepEqual(JSON.parse(requests[0].messages[1].content[0].text).visualStyle, style);
  assert.equal(requests[0].messages[1].content.length, 3); assert.equal(requests[1].messages[1].content.length, 2);
});

test('a complete Claude response with missing frame instructions receives one explicit schema correction', async () => {
  const requests = [], finishes = [];
  const task = { sourceImages: [{ id: 'photo-1', hash: 'one' }], analysis: [{ imageId: 'photo-1', imageType: 'interior', usable: true, qualityScore: 80, visibleObjects: ['深色墙面'] }] };
  const good = { theme: '室内夜色', visualStyle: style, foodGroups: [], shots: [shot] };
  const responses = [{ ...good, shots: [{ ...shot, editInstructions: undefined }] }, good];
  const ledger = { ready: Promise.resolve(), async reserve() {}, async markDispatched() {}, async finish(_id, value) { finishes.push(value); } };
  const model = createRestaurantModel({ config: { apiKey: 'test', baseUrl: 'https://provider.invalid/v1', imageTextModel: 'claude-opus-5-5', limits: {} }, ledger,
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: JSON.stringify(responses.shift()) }, finish_reason: 'stop' }] }); } });
  const output = await model.planGallery({ analysis: task.analysis, profile: {}, outputCount: 1, photos: [photo] }, { validateResult: value => validateGalleryStoryboard(value, task, 1, { requireStyle: true }) });
  assert.deepEqual(output, good); assert.equal(requests.length, 2); assert.match(requests[1].messages[0].content, /上一轮的具体问题：第1张图片缺少editInstructions/);
  assert.deepEqual(finishes.map(f => f.status), ['failed','completed']); assert.equal(finishes[0].outputIssue, 'invalid_schema');
});

test('complete but malformed image and set reviews can be corrected without resending any image generation', async () => {
  const requests = [], finishes = [];
  const passedSet = { status: 'passed', reviseImageIds: [], errors: [], warnings: [] };
  const responses = [{ ...review, styleScore: undefined }, review, { status: 'blocked', reviseImageIds: ['unknown'], errors: ['偏色'], warnings: [] }, passedSet];
  const ledger = { ready: Promise.resolve(), async reserve() {}, async markDispatched() {}, async finish(_id, value) { finishes.push(value); } };
  const model = createRestaurantModel({ config: { apiKey: 'test', baseUrl: 'https://provider.invalid/v1', imageTextModel: 'claude-opus-5-5', limits: {} }, ledger,
    fetchImpl: async (url, options) => { assert.match(url, /chat\/completions$/); requests.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: JSON.stringify(responses.shift()) }, finish_reason: 'stop' }] }); } });
  assert.deepEqual(await model.reviewGalleryPhoto({ visualStyle: style, shot, photos: [photo,photo] }), review);
  assert.deepEqual(await model.reviewGallerySet({ visualStyle: style, shots: [shot], photos: [photo] }), passedSet);
  assert.equal(requests.length, 4); assert.deepEqual(finishes.map(f => f.status), ['failed','completed','failed','completed']);
});
