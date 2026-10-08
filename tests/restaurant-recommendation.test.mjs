import test from 'node:test';
import assert from 'node:assert/strict';
import { createRestaurantModel } from '../services/restaurant/model.mjs';
import { validateDirections } from '../services/restaurant/rules.mjs';
import { RECOMMEND_PROMPT, RECOMMEND_REPAIR_PROMPT } from '../services/restaurant/prompts.mjs';

const profile = { name: '竹里面馆', city: '武汉', address: '青山建设一路', category: '面食' };
const config = { apiKey: 'recommendation-test-only-not-a-secret', baseUrl: 'https://provider.invalid/v1', chatModel: 'test-luna', limits: { chatDaily: 100 } };
// Fourteen real-material-style analysis records: dishes, kitchen work, seating, and two rejected photos.
// Every fact below is explicitly supplied as visual evidence; no real provider is used in these tests.
function photo(id, imageType, details, usable = true) {
  return { imageId: `photo-${id}`, imageType, visibleObjects: details, possibleScene: imageType === 'food' ? ['午餐'] : ['门店日常'],
    qualityScore: 80, privacyRisk: usable ? 'low' : 'high', usable, rejectionReason: usable ? '' : '该照片不适合本店宣传。',
    visibleTexts: [], textRisk: 'none', riskReasons: [] };
}
const materials = [
  photo(1, 'food', ['圆碗中的面条', '碗边搭着筷子']), photo(2, 'food', ['另一碗面条', '白色餐盘']),
  photo(3, 'food', ['一盘食物', '木色餐桌']), photo(4, 'food', ['碗中食物的近景', '碗口细节']),
  photo(5, 'food', ['整桌的碗盘', '餐具摆放']), photo(6, 'preparation', ['工作人员在操作台旁', '金属锅具']),
  photo(7, 'preparation', ['锅具与操作台', '工作人员手部']), photo(8, 'preparation', ['餐具摆放', '制作场景']),
  photo(9, 'preparation', ['厨房台面', '员工工作画面']), photo(10, 'interior', ['木色桌椅', '室内灯光']),
  photo(11, 'interior', ['餐桌周围座椅', '绿植']), photo(12, 'interior', ['靠墙餐桌', '墙面装饰']),
  photo(13, 'exterior', ['另一家店的明确门头'], false), photo(14, 'people', ['清晰私人证件'], false),
];
function direction(ids, extra = {}) {
  return { id: 'D01', label: '附近上班族约一顿面食', targetCustomer: '附近安排午餐的上班族', consumptionScene: '午餐选择', contentGoal: '用真实面食品类与菜品画面形成午餐邀约',
    recommendationReason: '可见面条摆在圆碗中，以菜品画面作为主题证据。', expectedAction: '搜索店名，导航到店',
    supportingImageIds: ids.map(id => `photo-${id}`), missingFacts: [], ...extra };
}
function richRecommendation() {
  const first = direction([1, 2, 3, 4, 5, 10, 11, 12], { coreImageIds: ['photo-1', 'photo-2'] });
  const second = direction([6, 7, 8, 9, 1, 2, 10], { id: 'D02', label: '从厨房画面聊一顿面食', targetCustomer: '愿意了解门店日常的附近居民', consumptionScene: '午饭前了解店里的工作场景',
    contentGoal: '老板分享照片中可见的厨房工作与餐具细节，不声称手工或现做', recommendationReason: '操作台、锅具与员工工作画面共同支持门店日常主题。', coreImageIds: ['photo-6', 'photo-7'] });
  const third = direction([10, 11, 12, 1, 2, 3, 4, 5], { id: 'D03', label: '和朋友约在木色餐桌旁', targetCustomer: '想和朋友约饭的附近居民', consumptionScene: '朋友见面约一顿饭',
    contentGoal: '用真实桌椅、绿植与餐盘形成朋友见面的邀约，不承诺未确认服务', recommendationReason: '木色桌椅和绿植构成真实用餐画面，可以结合已确认面食品类邀约。', coreImageIds: ['photo-10', 'photo-11'] });
  const directions = [first, second, third].map(item => ({ ...item, imageRoles: item.supportingImageIds.map((imageId, index) => ({ imageId,
    role: index === 0 ? 'cover' : item.coreImageIds.includes(imageId) ? 'core' : materials.find(photo => photo.imageId === imageId).imageType === 'food' ? 'detail' : 'context',
    reason: `${imageId}的${materials.find(photo => photo.imageId === imageId).visibleObjects.join('、')}与${item.consumptionScene}相关，作为真实配图。` })) }));
  return { directions, unusedImages: [] };
}
function degenerate(ids = [1]) { return { directions: [direction(ids)], unusedImages: [] }; }
function response(value, status = 200) {
  return new Response(JSON.stringify({ id: 'mock-recommendation-response', usage: { prompt_tokens: 30, completion_tokens: 20 },
    choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }), { status });
}
function harness(sequence, { reserveFailureAt = 0 } = {}) {
  const requests = [], reservations = [], dispatches = [], finishes = [];
  const ledger = { ready: Promise.resolve(), async reserve(record) {
    if (reserveFailureAt && reservations.length + 1 === reserveFailureAt) throw Object.assign(new Error('daily budget exhausted'), { code: 'DAILY_QUOTA_EXCEEDED' });
    reservations.push(record);
  }, async markDispatched(id) { dispatches.push(id); }, async finish(id, details) { finishes.push({ id, ...details }); }, async summary() { return {}; } };
  const model = createRestaurantModel({ config, ledger, fetchImpl: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const next = sequence[requests.length - 1];
    if (typeof next === 'function') return next();
    if (next instanceof Response) return next;
    if (next === undefined) throw new Error('unexpected third provider request');
    return response(next);
  } });
  return { model, requests, reservations, dispatches, finishes };
}

test('fourteen analyzed photos yield three different themes with core evidence and multi-photo candidate pools', async () => {
  const output = richRecommendation(), app = harness([output]), snapshot = structuredClone({ materials, profile, output });
  const result = await app.model.recommend(materials, profile);
  assert.equal(result.length, 3); assert.ok(result.every(item => item.supportingImageIds.length >= 6));
  assert.equal(new Set(result.flatMap(item => item.supportingImageIds)).size, 12);
  assert.ok(result.every(item => item.coreImageIds.length && item.coreImageIds.every(id => item.supportingImageIds.includes(id))));
  assert.equal(new Set(result.map(item => item.consumptionScene)).size, 3);
  assert.equal(app.requests.length, 1); assert.equal(app.requests[0].body.model, config.chatModel);
  assert.equal(app.requests[0].body.messages[0].content, RECOMMEND_PROMPT);
  assert.deepEqual(JSON.parse(app.requests[0].body.messages[1].content), { profile, images: materials });
  assert.deepEqual({ materials, profile, output }, snapshot); assert.equal(app.finishes[0].status, 'completed');
});

test('a complete one-photo degenerate draft receives exactly one repair with original facts and concrete issues', async () => {
  const draft = degenerate(), replacement = richRecommendation(), app = harness([draft, replacement]);
  const result = await app.model.recommend(materials, profile);
  assert.equal(result.length, 3); assert.equal(new Set(result.flatMap(item => item.supportingImageIds)).size, 12);
  assert.equal(app.requests.length, 2); assert.equal(app.requests[1].body.messages[0].content, RECOMMEND_REPAIR_PROMPT);
  const input = JSON.parse(app.requests[1].body.messages[1].content);
  assert.deepEqual(input.profile, profile); assert.deepEqual(input.images, materials); assert.deepEqual(input.draft, draft);
  assert.ok(input.recommendationIssues.length > 0); assert.ok(input.recommendationIssues.length <= 4);
  assert.equal(app.reservations.length, 2); assert.equal(app.dispatches.length, 2); assert.equal(app.finishes.length, 2);
  assert.ok(app.finishes.every(item => item.status === 'completed'));
  assert.notEqual(app.reservations[0].id, app.reservations[1].id, 'the completed draft repair is a distinct charged request');
});

test('sparse single-photo recommendations and explicit no-reliable-direction results do not request a repair', async () => {
  const sparse = [photo(1, 'food', ['圆碗中的面条'])], first = harness([degenerate()]);
  assert.equal((await first.model.recommend(sparse, profile)).length, 1); assert.equal(first.requests.length, 1);
  const empty = harness([{ directions: [] }]);
  assert.deepEqual(await empty.model.recommend(materials, profile), []); assert.equal(empty.requests.length, 1);
});

test('a still-incomplete repair is selected by unique coverage without triggering a third request', async () => {
  const app = harness([degenerate(), degenerate([1, 2, 3, 4, 5, 6])]);
  const result = await app.model.recommend(materials, profile);
  assert.equal(result[0].supportingImageIds.length, 6); assert.equal(app.requests.length, 2);
});

test('a worse repair retains the lawful original candidate pool and never appends unrelated photos', async () => {
  const initial = degenerate([1, 2]), app = harness([initial, degenerate()]);
  const result = await app.model.recommend(materials, profile);
  assert.deepEqual(result[0].supportingImageIds, ['photo-1', 'photo-2']); assert.equal(app.requests.length, 2);
});

test('a known complete invalid repair falls back to the valid draft', async t => {
  for (const repaired of [
    { directions: [direction([99])] },
    { directions: [direction([1], { coreImageIds: ['photo-2'] })] },
    new Response(JSON.stringify({ choices: [{ message: { content: '{broken' }, finish_reason: 'stop' }] })),
    () => response({}, 500),
  ]) await t.test('known completed error', async () => {
    const app = harness([degenerate(), repaired]);
    const result = await app.model.recommend(materials, profile);
    assert.deepEqual(result[0].supportingImageIds, ['photo-1']); assert.equal(app.requests.length, 2);
  });
});

test('unknown first responses and unknown repair responses stop without provider replay', async t => {
  for (const failAt of [1, 2]) await t.test(`unknown call ${failAt}`, async () => {
    const fail = () => { throw new Error('transport connection lost'); };
    const app = harness(failAt === 1 ? [fail] : [degenerate(), fail]);
    await assert.rejects(app.model.recommend(materials, profile), { code: 'PROVIDER_UNCERTAIN' });
    assert.equal(app.requests.length, failAt); assert.equal(app.finishes.at(-1).status, 'uncertain');
  });
});

test('an interrupted HTTP 200 repair stream is uncertain and cannot silently fall back or request a third response', async () => {
  const broken = () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"choices":'));
    controller.error(new Error('response stream disconnected'));
  } }), { status: 200 });
  const app = harness([degenerate(), broken]);
  await assert.rejects(app.model.recommend(materials, profile), { code: 'PROVIDER_UNCERTAIN' });
  assert.equal(app.requests.length, 2); assert.equal(app.reservations.length, 2);
  assert.equal(app.finishes[0].status, 'completed'); assert.equal(app.finishes[1].status, 'uncertain');
});

test('a repair rejected before its full response is received retains the model error instead of falling back', async () => {
  const app = harness([degenerate(), () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 })]);
  await assert.rejects(app.model.recommend(materials, profile), error => error.code === 'MODEL_INVALID_OUTPUT' && error.providerResponseComplete === false);
  assert.equal(app.requests.length, 2); assert.equal(app.finishes.at(-1).status, 'failed');
});

test('repair quota failures retain their existing stopping semantics instead of silently succeeding', async t => {
  const local = harness([degenerate()], { reserveFailureAt: 2 });
  await assert.rejects(local.model.recommend(materials, profile), { code: 'DAILY_QUOTA_EXCEEDED' });
  assert.equal(local.requests.length, 1); assert.equal(local.dispatches.length, 1);
  for (const status of [402, 429]) await t.test(`provider ${status}`, async () => {
    const app = harness([degenerate(), () => response({}, status)]);
    await assert.rejects(app.model.recommend(materials, profile), error => error.code === 'PROVIDER_ERROR' && error.providerStatus === status);
    assert.equal(app.requests.length, 2); assert.equal(app.finishes.at(-1).status, 'failed');
  });
});

test('direction validation accepts cross-theme reuse and preserves optional roles through a second normalization', () => {
  const raw = richRecommendation(), once = validateDirections(raw, materials, profile);
  assert.equal(once.filter(item => item.supportingImageIds.includes('photo-1')).length, 3);
  assert.deepEqual(validateDirections({ directions: once }, materials, profile), once);
  const legacy = validateDirections(degenerate(), materials, profile)[0];
  assert.deepEqual(legacy.coreImageIds, []); assert.deepEqual(legacy.imageRoles, []);
});

test('invalid first ids, core evidence, roles and unused-image records cannot be repaired into a hidden success', async () => {
  const invalidDirections = [
    direction([99]), direction([13]), direction([1], { coreImageIds: ['photo-2'] }),
    direction([1], { coreImageIds: ['photo-1', 'photo-1'] }), direction([1, 2, 3, 4], { coreImageIds: ['photo-1', 'photo-2', 'photo-3', 'photo-4'] }),
    direction([1], { coreImageIds: null }), direction([1], { imageRoles: null }),
    direction([1], { imageRoles: [{ imageId: 'photo-2', role: 'context', reason: '另一图' }] }),
    direction([1], { imageRoles: [{ imageId: 'photo-1', role: 'fake', reason: '错误角色' }] }),
    direction([1], { imageRoles: [{ imageId: 'photo-1', role: 'core', reason: ' ' }] }),
    direction([1], { imageRoles: [{ imageId: 'photo-1', role: 'core', reason: '核心' }, { imageId: 'photo-1', role: 'cover', reason: '重复' }] }),
  ];
  for (const item of invalidDirections) {
    const app = harness([{ directions: [item] }]);
    await assert.rejects(app.model.recommend(materials, profile), { code: 'MODEL_INVALID_OUTPUT' }); assert.equal(app.requests.length, 1);
  }
  for (const unusedImages of [null, [{ imageId: 'photo-1', reason: '已经被使用' }], [{ imageId: 'photo-13', reason: '已拒绝' }],
    [{ imageId: 'photo-2', reason: '' }], [{ imageId: 'photo-2', reason: '重复视角' }, { imageId: 'photo-2', reason: '重复说明' }]]) {
    assert.throws(() => validateDirections({ ...degenerate(), unusedImages }, materials, profile), { code: 'MODEL_INVALID_OUTPUT' });
  }
});
