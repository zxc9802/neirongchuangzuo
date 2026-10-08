import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestaurantModel } from '../services/restaurant/model.mjs';
import { COPY_PROMPT, COPY_REWRITE_PROMPT, AUDIT_PROMPT } from '../services/restaurant/prompts.mjs';

const config = { apiKey: 'vision-test-only-not-a-secret', baseUrl: 'https://provider.invalid/v1', chatModel: 'test-vision', limits: { chatDaily: 100 } };
const profile = { name: '桃园火锅', city: '重庆', address: '南滨路二十六号', category: '火锅店' };
const analysis = [
  { imageId: 'photo-food', imageType: 'food', visibleObjects: ['圆形餐盘'], usable: true, qualityScore: 80, privacyRisk: 'none' },
  { imageId: 'photo-night', imageType: 'exterior', visibleObjects: ['木质入口', '绿植'], usable: true, qualityScore: 85, privacyRisk: 'none' },
];
const direction = { id: 'D01', label: '沿江晚饭邀约', targetCustomer: '想约朋友吃晚饭的重庆居民', consumptionScene: '散步后约一顿火锅', supportingImageIds: ['photo-night', 'photo-food'] };
const facts = Object.freeze({ price: '18', conditions: '仅作为测试已确认资料，不新增优惠事实' });
// Use decodable image payloads. The attachment order intentionally differs from analysis order.
const photos = await Promise.all([
  ['photo-night', { r: 40, g: 50, b: 60 }], ['photo-food', { r: 130, g: 90, b: 80 }],
].map(async ([id, background]) => {
  const bytes = await sharp({ create: { width: 180, height: 240, channels: 3, background } }).jpeg().toBuffer();
  return { id, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, bytes, width: 180, height: 240, mime: 'image/jpeg' };
}));
function copy() {
  return { titles: ['南滨路散步后约一顿火锅晚饭', '木质入口与绿植留下门口夜色', '桃园火锅老板分享门店真实日常'],
    body: '如果想约朋友吃一顿火锅，可以把桃园火锅列进这次晚饭的备选。木质入口挨着绿植，门口实拍把这一角留了下来。我们店在重庆南滨路二十六号，想来时搜索店名并导航到店。',
    tags: ['重庆火锅', '南滨路晚饭', '朋友约饭', '门店日常', '实拍分享'], coverText: '沿江散步约一顿火锅', imageOrder: ['photo-night', 'photo-food'],
    claims: [{ text: '桃园火锅', factKeys: ['name'], imageIds: [] }, { text: '木质入口挨着绿植', factKeys: [], imageIds: ['photo-night'] }] };
}
function harness(result, failure, responseFactory) {
  const requests = [], reservations = [], dispatches = [], finishes = [];
  const ledger = { ready: Promise.resolve(),
    async reserve(record) { reservations.push(record); }, async markDispatched(id) { dispatches.push(id); },
    async finish(id, completion) { finishes.push({ id, ...completion }); }, async summary() { return {}; } };
  const model = createRestaurantModel({ config, ledger, fetchImpl: async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    if (failure) throw failure;
    if (responseFactory) return responseFactory();
    return new Response(JSON.stringify({ id: 'provider-test-result', usage: { prompt_tokens: 30, completion_tokens: 20 },
      choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }), { status: 200 });
  } });
  return { model, requests, reservations, dispatches, finishes };
}
function visualInput(request, expectedPrompt) {
  assert.equal(request.url, 'https://provider.invalid/v1/chat/completions');
  const [system, user] = request.body.messages;
  assert.equal(system.content, expectedPrompt);
  assert.equal(user.role, 'user'); assert.ok(Array.isArray(user.content));
  assert.equal(user.content[0].type, 'text');
  const text = user.content[0].text, input = JSON.parse(text);
  assert.doesNotMatch(text, /"(?:photos|dataUrl|bytes)"\s*:/);
  assert.doesNotMatch(text, /data:image\/|;base64,/);
  assert.deepEqual(input.visualImageIds, photos.map(photo => photo.id));
  assert.deepEqual(user.content.slice(1).map(item => item.image_url.url), photos.map(photo => photo.dataUrl));
  assert.ok(user.content.slice(1).every(item => item.type === 'image_url'));
  return input;
}
function assertCompletedAttempt(app) {
  assert.equal(app.reservations.length, 1); assert.equal(app.dispatches.length, 1); assert.equal(app.finishes.length, 1);
  assert.equal(app.reservations[0].kind, 'chat'); assert.equal(app.reservations[0].model, config.chatModel);
  assert.equal(app.dispatches[0], app.reservations[0].id); assert.equal(app.finishes[0].id, app.reservations[0].id);
  assert.equal(app.finishes[0].status, 'completed');
}

test('first copy write supplies real images in declared order without duplicating binary data into the JSON facts', async () => {
  const app = harness(copy()), snapshot = structuredClone({ profile, analysis, direction, facts, photos });
  assert.deepEqual(await app.model.write({ profile, analysis, direction, facts, photos }), copy());
  assert.equal(app.requests.length, 1);
  const input = visualInput(app.requests[0], COPY_PROMPT);
  assert.deepEqual(input.profile, profile); assert.deepEqual(input.images, analysis);
  assert.deepEqual(input.direction, direction); assert.deepEqual(input.confirmedFacts, facts);
  assert.equal(Object.hasOwn(input, 'draft'), false); assert.equal(Object.hasOwn(input, 'qualityIssues'), false);
  assert.deepEqual(structuredClone({ profile, analysis, direction, facts, photos }), snapshot);
  assertCompletedAttempt(app);
});

test('rewrite sends completed draft and quality feedback while retaining the original facts and visual evidence', async () => {
  const draft = { ...copy(), body: '草稿里误写套餐29元，这是需要改掉的错误，不能成为新的事实。' };
  const qualityIssues = ['删除草稿虚构价格，并用不同角度重写标题。'];
  const snapshot = structuredClone({ profile, analysis, direction, facts, photos, draft, qualityIssues });
  const app = harness(copy());
  await app.model.write({ profile, analysis, direction, facts, photos, draft, qualityIssues });
  assert.equal(app.requests.length, 1);
  const input = visualInput(app.requests[0], COPY_REWRITE_PROMPT);
  assert.deepEqual(input.draft, draft); assert.deepEqual(input.qualityIssues, qualityIssues);
  assert.deepEqual(input.profile, profile); assert.deepEqual(input.confirmedFacts, facts);
  assert.equal(input.confirmedFacts.price, '18'); assert.deepEqual(input.images, analysis); assert.deepEqual(input.direction, direction);
  assert.deepEqual(structuredClone({ profile, analysis, direction, facts, photos, draft, qualityIssues }), snapshot);
  assertCompletedAttempt(app);
});

test('publication audit receives the same attachments separately from its structured copy and fact data', async () => {
  const review = { status: 'passed_with_warning', warnings: ['确认照片使用权后发布。'], errors: [] };
  const app = harness(review), payload = { profile, analysis, direction, facts, copy: copy(), photos };
  const snapshot = structuredClone(payload);
  assert.deepEqual(await app.model.audit(payload), review);
  assert.equal(app.requests.length, 1);
  const input = visualInput(app.requests[0], AUDIT_PROMPT);
  assert.deepEqual(input.profile, profile); assert.deepEqual(input.analysis, analysis); assert.deepEqual(input.direction, direction);
  assert.deepEqual(input.facts, facts); assert.deepEqual(input.copy, copy());
  assert.deepEqual(structuredClone(payload), snapshot);
  assertCompletedAttempt(app);
});

test('known unsent reserve and dispatch rate limits wait in short steps using the same id and only send once', async () => {
  let reserves = 0, dispatches = 0, calls = 0;
  const ids = [], delays = [], waits = [], finishes = [];
  const limited = () => Object.assign(new Error('unsent rate limit'), { code: 'RATE_LIMITED' });
  const ledger = { ready: Promise.resolve(), async reserve(record) { ids.push(record.id); if (++reserves === 1) throw limited(); }, async markDispatched(id) { ids.push(id); if (++dispatches === 1) throw limited(); }, async finish(id, details) { finishes.push({ id, ...details }); }, async summary() { return {}; } };
  const model = createRestaurantModel({ config, ledger, sleepImpl: async ms => { delays.push(ms); }, fetchImpl: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"directions":[]}' } }] })); } });
  assert.deepEqual(await model.recommend([], profile, { onBudgetWait: info => waits.push(info.waitedMs) }), []);
  assert.equal(calls, 1); assert.equal(new Set(ids).size, 1); assert.deepEqual(delays, [5000, 5000]); assert.deepEqual(waits, [0, 5000]);
  assert.equal(finishes.length, 1); assert.equal(finishes[0].status, 'completed');
});

test('waiting closes before dispatch, daily exhausted budgets do not wait, and bounded waits cannot replay model calls', async t => {
  for (const scenario of ['stop', 'daily', 'timeout']) await t.test(scenario, async () => {
    let calls = 0, sleeps = 0, model;
    const ledger = { ready: Promise.resolve(), async reserve() { throw Object.assign(new Error('budget'), { code: scenario === 'daily' ? 'DAILY_QUOTA_EXCEEDED' : 'RATE_LIMITED' }); }, async markDispatched() { throw new Error('must not dispatch'); }, async finish() {}, async summary() { return {}; } };
    model = createRestaurantModel({ config, ledger, budgetWaitMaxMs: 10_000, sleepImpl: async () => { sleeps++; if (scenario === 'stop') model.stop(); }, fetchImpl: async () => { calls++; } });
    await assert.rejects(model.recommend([], profile), { code: scenario === 'stop' ? 'SERVICE_CLOSING' : scenario === 'daily' ? 'DAILY_QUOTA_EXCEEDED' : 'RATE_LIMITED' });
    assert.equal(calls, 0); assert.equal(sleeps, scenario === 'stop' ? 1 : scenario === 'daily' ? 0 : 2);
  });
});

test('thirty-photo analysis plus recommendation, writing and audit complete thirteen charged calls with a shared ten-per-minute ledger', async t => {
  const root = await mkdtemp(join(tmpdir(), 'restaurant-budget-'));
  let clock = Date.now(), calls = 0;
  const delays = [];
  const model = createRestaurantModel({ config: { ...config, limits: { imageDaily: 20, chatDaily: 100, perMinute: 10 } }, storageDir: root, now: () => clock,
    sleepImpl: async ms => { delays.push(ms); clock += ms; }, fetchImpl: async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body), message = body.messages[1].content;
      const data = JSON.parse(Array.isArray(message) ? message[0].text : message);
      let output;
      if (body.messages[0].content.includes('逐张分析本批')) output = { images: data.images.map(item => ({ imageId: item.imageId, imageType: 'food', visibleObjects: ['真实餐盘'], possibleScene: ['午餐'], qualityScore: 80, privacyRisk: 'none', usable: true, rejectionReason: '', visibleTexts: [], textRisk: 'none', riskReasons: [] })) };
      else if (body.messages[0].content.includes('推荐1至4个')) output = { directions: [{ ...direction, contentGoal: '真实午餐', recommendationReason: '真实餐盘', expectedAction: '到店', supportingImageIds: data.images.map(item => item.imageId), missingFacts: [] }] };
      else if (body.messages[0].content === AUDIT_PROMPT) output = { status: 'passed', warnings: [], errors: [] };
      else output = { ...copy(), imageOrder: data.images.map(item => item.imageId), claims: [{ text: profile.name, factKeys: ['name'], imageIds: [] }] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
    } });
  t.after(async () => { await model.close(); await rm(root, { recursive: true, force: true }); });
  const all = [];
  for (let start = 0; start < 30; start += 3) all.push(...await model.analyse(Array.from({ length: 3 }, (_, index) => ({ ...photos[0], id: `photo-${start + index + 1}` })), profile));
  const recommended = await model.recommend(all, profile);
  const output = await model.write({ profile, analysis: all.slice(0, 15), direction: recommended[0], facts: {} });
  assert.equal(output.imageOrder.length, 15);
  await model.audit({ copy: output, profile, images: all.slice(0, 15) });
  assert.equal(calls, 13); assert.equal((await model.usage()).used.chat, 13); assert.equal((await model.usage()).remaining.chat, 87);
  assert.ok(delays.length > 0); assert.ok(delays.every(ms => ms <= 5000));
});

test('unknown write or audit transport failure is charged as uncertain once and never automatically replayed', async t => {
  for (const operation of ['write', 'audit']) await t.test(operation, async () => {
    const app = harness(null, new TypeError('simulated connection lost after dispatch'));
    await assert.rejects(app.model[operation]({ profile, analysis, direction, facts, photos, copy: copy() }), error => error.code === 'PROVIDER_UNCERTAIN');
    assert.equal(app.requests.length, 1); assert.equal(app.reservations.length, 1); assert.equal(app.dispatches.length, 1);
    assert.equal(app.finishes.length, 1); assert.equal(app.finishes[0].id, app.reservations[0].id);
    assert.equal(app.finishes[0].status, 'uncertain'); assert.equal(app.finishes[0].code, 'PROVIDER_UNCERTAIN');
    visualInput(app.requests[0], operation === 'write' ? COPY_PROMPT : AUDIT_PROMPT);
  });
});

test('HTTP 200 followed by a broken response stream is uncertain for both writing and audit', async t => {
  for (const operation of ['write', 'audit']) await t.test(operation, async () => {
    let chunksRead = 0;
    const responseFactory = () => new Response(new ReadableStream({
      pull(controller) {
        if (chunksRead++ === 0) controller.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"partial'));
        else controller.error(new TypeError('simulated socket closed while reading HTTP 200 body'));
      },
    }), { status: 200 });
    const app = harness(null, undefined, responseFactory);
    await assert.rejects(app.model[operation]({ profile, analysis, direction, facts, photos, copy: copy() }), error => error.code === 'PROVIDER_UNCERTAIN');
    assert.ok(chunksRead >= 2, 'a response chunk must arrive before the stream fails');
    assert.equal(app.requests.length, 1); assert.equal(app.reservations.length, 1); assert.equal(app.dispatches.length, 1);
    assert.deepEqual(app.finishes, [{ id: app.reservations[0].id, status: 'uncertain', code: 'PROVIDER_UNCERTAIN' }]);
    visualInput(app.requests[0], operation === 'write' ? COPY_PROMPT : AUDIT_PROMPT);
  });
});
