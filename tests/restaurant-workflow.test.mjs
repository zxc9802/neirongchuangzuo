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
import { COPY_PROMPT } from '../services/restaurant/prompts.mjs';

const profile = { name: '测试面馆', city: '武汉', address: '测试路一号', category: '面食' };
const config = { apiKey: 'test-only-not-a-secret', baseUrl: 'https://provider.invalid/v1', chatModel: 'test-luna', limits: { chatDaily: 100, imageDaily: 20, perMinute: 10 } };
function analysis(photos) { return photos.map(photo => ({ imageId: photo.id, imageType: 'food', visibleObjects: ['一碗面食'], possibleScene: ['午餐'], qualityScore: 80, privacyRisk: 'none', usable: true, rejectionReason: '', visibleTexts: [], textRisk: 'none', riskReasons: [] })); }
function direction(items, extra = {}) { return { id: 'D01', label: '午餐菜品分享', targetCustomer: '附近上班族', consumptionScene: '午餐', contentGoal: '真实菜品介绍', recommendationReason: '可见菜品', expectedAction: '导航到店', supportingImageIds: items.filter(item => item.usable).map(item => item.imageId), missingFacts: [], ...extra }; }
function copy(items) { return { titles: ['附近上班族午餐看看我们的面馆', '想吃一碗面时看看门店真实样子', '把门店里的午餐画面分享给大家'], body: '我是这家面馆的老板，想把门店里的真实画面分享给附近正在找午餐地方的朋友。照片记录了店里的菜品，也让大家在到店前看看实际样子。\n\n' + '如果你正在附近安排午餐，可以先看看这些照片，结合自己的时间和喜好决定是否到店。我们希望这组真实画面能帮助你了解门店，具体菜品信息可以到店询问，避免单凭图片猜测。'.repeat(3) + '\n\n可以收藏这篇，在需要的时候搜索门店名称并导航到店。', tags: ['武汉面食', '午餐选择', '附近吃饭', '门店日常', '面馆分享'], coverText: '附近午餐看看这碗面', imageOrder: items.map(item => item.imageId), claims: [{ text: '门店菜品', factKeys: ['category'], imageIds: items.map(item => item.imageId) }] }; }
function mockModel(overrides = {}) { const counts = { analyse: 0, recommend: 0, write: 0, audit: 0 }; return { ready: Promise.resolve(), enabled: true, counts,
  async analyse(photos) { counts.analyse++; return analysis(photos); }, async recommend(items) { counts.recommend++; return [direction(items)]; },
  async write(input) { counts.write++; return copy(input.analysis); }, async audit() { counts.audit++; return { status: 'passed', warnings: [], errors: [] }; },
  async usage() { return { day: '2026-10-07', used: { chat: 0 }, remaining: { chat: 100 }, limits: config.limits }; }, async close() {}, ...overrides }; }
async function photos(count = 2) { return Promise.all(Array.from({ length: count }, async (_, index) => ({ name: `photo${index}.png`, dataUrl: `data:image/png;base64,${(await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 80 + index * 15, g: 50, b: 120 } } }).png().toBuffer()).toString('base64')}` }))); }
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'restaurant-flow-'));
  const model = options.model ?? mockModel();
  const handler = createRestaurantHandler({ dataDir: root, databaseUrl: '', config, model, requireAuth: true, cleanupIntervalMs: 0, logger: { warn() {} }, ...options });
  await handler.ready;
  const server = createServer((req, res) => { req.authenticatedUserId = req.headers['x-test-user']; handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/restaurant`;
  async function api(path, body, user = 'owner') { const response = await fetch(base + path, { method: body === undefined ? 'GET' : path === '/profile' ? 'PUT' : 'POST', headers: { ...(user ? { 'x-test-user': user } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) }; }
  async function wait(id, states) { for (let index = 0; index < 150; index++) { const response = await api(`/tasks/${id}`); if (states.includes(response.body.task?.status)) return response.body.task; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('task did not reach expected status'); }
  t.after(async () => { await handler.shutdown(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { api, wait, model, handler, root };
}
async function newTask(app, input = {}) { await app.api('/profile', { profile }); const id = randomUUID(); const result = await app.api('/tasks', { requestId: id, images: await photos(), rightsConfirmed: true, ...input }); assert.equal(result.status, 202); return { id, task: await app.wait(id, ['awaiting_selection', 'failed']) }; }

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
  const app = await setup(t, { model: mockModel({ async write(input) { return { ...copy(input.analysis), body: `${copy(input.analysis).body} 纯手工现做，天天排队，19元。` }; } }) }), { id } = await newTask(app);
  await app.api(`/tasks/${id}/generate`, { directionId: 'D01', acceptSparse: true }); const result = await app.wait(id, ['failed', 'completed']);
  assert.equal(result.status, 'failed'); assert.equal(result.review.status, 'blocked'); assert.equal((await app.api('/usage')).body.usage.used, 0);
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
  const risky = { ...base, imageType: 'staff', textRisk: 'warning', visibleTexts: ['联系电话'], riskReasons: ['二维码位于底部'] };
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
