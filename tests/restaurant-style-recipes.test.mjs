import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createStyleRecipes } from '../services/restaurant/style-recipes.mjs';
import { createRestaurantHandler } from '../services/restaurant/server.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';

const root = new URL('../services/restaurant/style-recipes/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root)));
const sources = () => Promise.all(manifest.recipes.map(async (r, index) => ({ id: `photo-${index + 1}`, bytes: await readFile(new URL(r.input, root)), mime: 'image/jpeg' })));

test('approved photo recipes recognize original, renamed, reordered and upload-compressed inputs without confusing related bar views', async () => {
  const recipes = createStyleRecipes(), photos = await sources();
  const original = await recipes.match(photos);
  assert.deepEqual(original.entries.map(e => e.recipeId), manifest.recipes.map(r => r.id));
  const reversed = photos.toReversed().map((p, index) => ({ ...p, id: `reordered-${index}`, name: 'renamed.jpg' }));
  const match = await recipes.match(reversed);
  assert.equal(match.entries.find(e => e.recipeId === 'river-01').sourceImageId, 'reordered-0');
  const uploads = await Promise.all(photos.map(async p => ({ ...p, bytes: await sharp(p.bytes).autoOrient().resize({ width: 1536, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer() })));
  assert.deepEqual((await recipes.match(uploads)).entries.map(e => e.recipeId), manifest.recipes.map(r => r.id));
  assert.equal((await recipes.match([photos[8]])).entries[0].recipeId, 'river-01');
  assert.equal((await recipes.match(photos.slice(0, 8))).entries.length, 8);
});

test('different photographs, changed crops and duplicate uploads cannot silently inherit an accepted recipe', async () => {
  const recipes = createStyleRecipes(), photos = await sources();
  assert.equal(await recipes.match([photos[0], { ...photos[0], id: 'duplicate' }]), null);
  const unrelated = await sharp({ create: { width: 1080, height: 1440, channels: 3, background: 'green' } }).jpeg().toBuffer();
  assert.equal(await recipes.match([...photos.slice(0, 8), { id: 'other', bytes: unrelated }]), null);
  const changed = await sharp(photos[0].bytes).extract({ left: 100, top: 100, width: 810, height: 1080 }).jpeg().toBuffer();
  assert.equal(await recipes.match([{ id: 'cropped', bytes: changed }]), null);
});

test('recipes keep nine distinct originals, preserve the accepted order and reject padding an eight-photo set to nine', async () => {
  const recipes = createStyleRecipes(), photos = await sources(), binding = await recipes.match(photos.toReversed());
  const plan = await recipes.plan(binding, 9);
  assert.equal(new Set(plan.shots.map(s => s.sourceImageId)).size, 9);
  assert.deepEqual(plan.shots.map(s => s.recipeId), manifest.recipes.map(r => r.id));
  await assert.rejects(recipes.plan(await recipes.match(photos.slice(0, 8)), 9), { code: 'INSUFFICIENT_GALLERY_MATERIAL' });
  const analysis = await recipes.analysis(binding);
  assert.ok(analysis.every(a => a.usable));
  assert.ok(analysis.at(-1).visibleObjects.some(f => f.includes('三艘游船')));
});

test('website sends approved photos through Claude planning and Image 2.5 editing, corrects style and settles once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'restaurant-style-'));
  const credits = createCreditsLedger({ storageDir: join(dir, 'credits'), databaseUrl: null });
  const calls = [], reviews = [], recipes = createStyleRecipes();
  let plans = 0, analyses = 0, setReviews = 0;
  const visualStyle = { name: '真实餐酒夜色', mood: '松弛温润', lighting: '保留暗部与局部光源', tone: '保留认可样本的色调关系', texture: '自然摄影质感', palette: ['琥珀', '深青'], instructions: '以已认可的样本为约束，不整体换滤镜。' };
  const model = { ready: Promise.resolve(), enabled: true,
    async analyse(photos) { analyses++; return photos.map(photo => { const row = manifest.recipes[Number(photo.id.split('-')[1]) - 1]; return { ...row.analysis, imageId: photo.id, imageType: row.id === 'river-01' ? 'exterior' : row.analysis.imageType }; }); },
    async planGallery(input) {
      plans++; assert.equal(input.analysis.length, 9); assert.equal(input.approvedStyles.length, 9);
      assert.deepEqual(input.photos.filter(p => p.imageIds && p.id.startsWith('source')).flatMap(p => p.imageIds), input.analysis.map(item => item.imageId));
      assert.equal(input.photos.filter(p => p.id.startsWith('accepted'))[0].imageIds.length, 9);
      return { theme: '真实餐酒夜色', visualStyle, foodGroups: [{ id: 'snack', label: '真实食品', imageIds: ['photo-3'] }],
        shots: input.analysis.map((item, i) => ({ sourceImageId: item.imageId, kind: item.imageType === 'food' ? 'food' : 'scene', foodGroupId: item.imageType === 'food' ? 'snack' : '',
          name: `场景${i + 1}`, purpose: '展示真实氛围', focus: '原图中的食品', camera: '保持自然景别', angle: 'oblique', lighting: '真实局部光源', editInstructions: '保留已认可的色调与氛围。' })) };
    },
    async identifyFood() { return { description: '原图食品', portion: '一份', arrangement: '餐具中', vessel: '原图餐具', colors: ['金黄'], visibleComponents: ['食品'], texture: [], distinctiveFeatures: [], uncertainDetails: [], dishCount: null, pieceCount: null }; },
    async renderGalleryPhoto(input) {
      calls.push(input);
      const reference = input.context.find(photo => photo.approvedStyle);
      assert.ok(reference.bytes.length); assert.equal(reference.sourceImageId, input.shot.sourceImageId); assert.deepEqual(input.style, visualStyle);
      return { bytes: reference.bytes, requestId: `new-provider-${calls.length}`, provider: 'test' };
    },
    async reviewGalleryPhoto(input) {
      reviews.push(input); assert.ok(input.photos.length <= 4); assert.ok(input.context.some(photo => photo.role === 'accepted-style-target-for-this-original'));
      const revise = input.shot.sourceImageId === 'photo-1' && reviews.filter(r => r.shot.sourceImageId === 'photo-1').length === 1;
      return { status: revise ? 'blocked' : 'passed', styleScore: revise ? 50 : 95, identityMatch: true, sceneMatch: true, shotMatch: true, compositionUsable: true,
        styleMatch: !revise, marketingUseful: true, errors: revise ? ['暖琥珀色被改成了冷色'] : [], warnings: [] };
    },
    async reviewGallerySet() { setReviews++; return { status: 'passed', reviseImageIds: [], errors: [], warnings: [] }; },
    async write() { assert.fail('Image-only tasks must not invent store details to write copy'); },
    async usage() { return {}; }, async close() {},
  };
  const handler = createRestaurantHandler({ dataDir: join(dir, 'restaurant'), databaseUrl: '', model, credits, config: { apiKey: 'test', limits: {} }, requireAuth: true, cleanupIntervalMs: 0, logger: { warn() {} } });
  await handler.ready;
  const server = createServer((req, res) => { req.authenticatedUserId = 'style-owner'; handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/restaurant`;
  const api = async (path, body, method = 'POST') => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await handler.shutdown(); await new Promise(resolve => server.close(resolve)); await credits.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await api('/profile')).body.profile, null);
  assert.equal((await api('/tasks', { requestId: randomUUID(), imageCount: 9, rightsConfirmed: true })).body.code, 'PROFILE_INCOMPLETE');
  const id = randomUUID(), photos = await sources();
  assert.equal((await api('/tasks', { requestId: id, imageCount: 9, rightsConfirmed: true, autoGenerate: true, outputCount: 9 })).status, 202);
  for (let at = 0; at < photos.length; at += 3) assert.equal((await api(`/tasks/${id}/photos`, { startIndex: at, images: photos.slice(at, at + 3).map(p => ({ name: 'renamed.jpg', dataUrl: `data:image/jpeg;base64,${p.bytes.toString('base64')}` })) })).status, 202);
  await api(`/tasks/${id}/analyse`, {});
  let task;
  for (let i = 0; i < 500; i++) { task = (await api(`/tasks/${id}`)).body.task; if (['completed', 'failed', 'awaiting_confirmation'].includes(task.status)) break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(task.status, 'awaiting_confirmation', task.error);
  assert.deepEqual(task.profileSnapshot, {}); assert.equal(task.copyStatus, 'not_requested');
  assert.equal(task.galleryStoryboard.source, 'ai'); assert.equal(task.outputCount, 9); assert.deepEqual(task.galleryStoryboard.visualStyle, visualStyle);
  assert.equal(analyses, 5); assert.equal(plans, 1); assert.equal(setReviews, 1);
  assert.equal(task.styleRecipe, undefined); assert.equal(calls.length, 10); assert.equal(reviews.length, 10);
  const corrected = calls.find(call => call.shot.sourceImageId === 'photo-1' && call.attempt === 1);
  assert.deepEqual(corrected.corrections, ['暖琥珀色被改成了冷色']);
  assert.deepEqual(task.imageReviews.filter(r => r.imageId === 'shot-01').map(r => r.status), ['blocked', 'passed']);
  assert.equal(task.files.filter(f => /^image\//.test(f.mime)).length, 9);
  assert.ok(calls.some(c => c.shot.sourceImageId === 'photo-7'), 'portrait must also use the image edit model instead of fixed Sharp filters');
  assert.equal((await api(`/tasks/${id}/confirm`, { confirmWarnings: true })).status, 200);
  const completed = (await api(`/tasks/${id}`)).body.task;
  assert.equal(completed.status, 'completed'); assert.equal(completed.billing.chargedPoints, 450);
  assert.equal((await api(`/tasks/${id}/generate`, { directionId: completed.selection.directionId, outputCount: 9, imageMode: 'cover' })).body.code, 'PROFILE_INCOMPLETE');
  await api(`/tasks/${id}/generate`, { workflow: 'store-gallery-v1', directionId: completed.selection.directionId, outputCount: 9, imageMode: 'promotional' });
  await api(`/tasks/${id}/confirm`, { confirmWarnings: true });
  assert.equal(calls.length, 10); assert.equal((await credits.snapshot('style-owner')).balance, 550);
  const saved = await handler.store.getTask('style-owner', id), frames = saved.galleryCheckpoints;
  assert.equal(new Set(frames.map(f => f.composition.sourceImageId)).size, 9);
  const file = completed.files.find(f => f.mime === 'image/jpeg');
  assert.equal((await fetch(base + `/tasks/${id}/files/${file.filename}`)).status, 200);
  assert.equal((await recipes.match(photos)).entries.length, 9);
});
