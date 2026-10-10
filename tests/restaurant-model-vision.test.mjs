import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestaurantModel } from '../services/restaurant/model.mjs';
import { loadAIConfig } from '../services/ai/server.mjs';
import { COPY_PROMPT, COPY_REWRITE_PROMPT, AUDIT_PROMPT, FOOD_IDENTITY_PROMPT, FOOD_RENDER_AUDIT_PROMPT, GALLERY_STORYBOARD_PROMPT } from '../services/restaurant/prompts.mjs';

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
function harness(result, failure, responseFactory, modelConfig = config) {
  const requests = [], reservations = [], dispatches = [], finishes = [];
  const ledger = { ready: Promise.resolve(),
    async reserve(record) { reservations.push(record); }, async markDispatched(id) { dispatches.push(id); },
    async finish(id, completion) { finishes.push({ id, ...completion }); }, async summary() { return {}; } };
  const model = createRestaurantModel({ config: modelConfig, ledger, fetchImpl: async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    if (failure) throw failure;
    if (responseFactory) return responseFactory();
    return new Response(JSON.stringify({ id: 'provider-test-result', usage: { prompt_tokens: 30, completion_tokens: 20 },
      choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }), { status: 200 });
  } });
  return { model, requests, reservations, dispatches, finishes };
}

test('food identity analysis receives the original photograph and returns a structured visual identity',async()=>{
  const appearance={description:'原图可见食品',portion:'一份',arrangement:'盘内摆放',vessel:'圆形餐盘',colors:['浅色'],visibleComponents:['可见主体'],texture:['表面纹理'],distinctiveFeatures:['圆盘'],uncertainDetails:['内部不可见'],dishCount:1,pieceCount:null};
  const app=harness(appearance);
  assert.deepEqual(await app.model.identifyFood({analysis:analysis[0],photos:[photos[1]]}),appearance);
  const [system,user]=app.requests[0].body.messages;
  assert.equal(system.content,FOOD_IDENTITY_PROMPT);assert.equal(user.content[1].image_url.url,photos[1].dataUrl);
  assert.equal(JSON.parse(user.content[0].text).imageId,'photo-food');assertCompletedAttempt(app);
});

test('food consistency audit compares original and generated photos and explicitly checks the planned camera',async()=>{
  const review={status:'passed',identityMatch:true,sceneMatch:true,shotMatch:true,compositionUsable:true,errors:[],warnings:[]};
  const app=harness(review),plan={angle:'overhead',name:'俯拍摆盘'};
  assert.equal((await app.model.reviewFoodRender({sourceImageId:'photo-food',foodAppearance:{description:'参考食品'},plan,photos})).shotMatch,true);
  const [system,user]=app.requests[0].body.messages;
  assert.equal(system.content,FOOD_RENDER_AUDIT_PROMPT);assert.deepEqual(user.content.slice(1).map(item=>item.image_url.url),photos.map(photo=>photo.dataUrl));
  assert.deepEqual(JSON.parse(user.content[0].text).plan,plan);assertCompletedAttempt(app);
});
test('food identity sends the requested spread or single food focus to the actual vision provider',async()=>{
  const appearance={description:'可见肉盘',portion:'一盘',arrangement:'薄片摆放',vessel:'圆形餐盘',colors:['红色'],visibleComponents:['薄切肉片'],texture:['纹理'],distinctiveFeatures:[],uncertainDetails:[],dishCount:1,pieceCount:null};
  const app=harness(appearance);
  await app.model.identifyFood({analysis:analysis[0],photos:[photos[1]],subjectScope:'auto',subjectFocus:'原图前景肉盘'});
  const input=JSON.parse(app.requests[0].body.messages[1].content[0].text);
  assert.equal(input.subjectScope,'auto');assert.equal(input.subjectFocus,'原图前景肉盘');assertCompletedAttempt(app);
});
test('gallery planning sees the complete material analysis rather than only one food source',async()=>{
  const board={theme:'菜品与门店',foodGroups:[],shots:[]},app=harness(board);
  assert.deepEqual(await app.model.planGallery({analysis,profile,outputCount:9,photos:[photos[1]]}),board);
  const [system,user]=app.requests[0].body.messages,input=JSON.parse(user.content[0].text);
  assert.equal(system.content,GALLERY_STORYBOARD_PROMPT);assert.equal(input.images.length,analysis.length);
  assert.equal(input.requestedOutputCount,9);assert.deepEqual(input.visualImageIds,['photo-food']);assertCompletedAttempt(app);
});

test('the image-text model is independently configurable without replacing chat or image generation', () => {
  const defaults = loadAIConfig({ OPENLUX_CHAT_MODEL: 'test-chat', OPENLUX_IMAGE_MODEL: 'test-image', OPENLUX_IMAGE_TEXT_MODEL: '' });
  assert.equal(defaults.chatModel, 'test-chat');
  assert.equal(defaults.imageModel, 'test-image');
  assert.equal(defaults.imageTextModel, 'claude-opus-5-5');
  const custom = loadAIConfig({ OPENLUX_IMAGE_TEXT_MODEL: 'custom-image-text' });
  assert.equal(custom.imageTextModel, 'custom-image-text');
});

test('all image-text operations route to Claude and retain accurate provider ledger entries', async () => {
  const board = { theme: '菜品与门店', foodGroups: [], shots: [] };
  const review = { status: 'passed', identityMatch: true, sceneMatch: true, shotMatch: true, compositionUsable: true, errors: [], warnings: [] };
  const appearance = { description: '参考菜品', vessel: '圆形餐盘', colors: ['棕色'], visibleComponents: ['可见主体'], portion: '一份', arrangement: '盘内摆放', texture: [], distinctiveFeatures: [], uncertainDetails: [], dishCount: 1, pieceCount: null };
  const analysed = { images: analysis.map(item => ({ ...item, possibleScene: [], rejectionReason: '', visibleTexts: [], textRisk: 'none', riskReasons: [] })) };
  const responses = [analysed, { directions: [] }, appearance, board, review, copy(), copy(), { status: 'passed', warnings: [], errors: [] }];
  const app = harness(null, undefined, () => new Response(JSON.stringify({ id: 'test-result', choices: [{ message: { content: JSON.stringify(responses.shift()) }, finish_reason: 'stop' }] })),
    { ...config, imageTextModel: 'claude-opus-5-5' });
  await app.model.analyse(photos, profile, { gallery: true });
  await app.model.recommend(analysis, profile);
  await app.model.identifyFood({ analysis: analysis[0], photos });
  await app.model.planGallery({ analysis, profile, outputCount: 9, photos });
  await app.model.reviewFoodRender({ sourceImageId: 'photo-food', photos });
  await app.model.write({ profile, analysis, direction, facts, photos });
  await app.model.write({ profile, analysis, direction, facts, photos, draft: copy(), qualityIssues: ['调整开头'] });
  await app.model.audit({ profile, copy: copy(), photos });
  const expected = Array(8).fill('claude-opus-5-5');
  assert.deepEqual(app.requests.map(request => request.body.model), expected);
  assert.deepEqual(app.reservations.map(record => record.model), expected);
  assert.equal(app.finishes.length, 8);
  assert.ok(app.finishes.every(record => record.status === 'completed'));
  assert.deepEqual(app.requests[0].body.messages[1].content.slice(1).map(item => item.image_url.url), photos.map(photo => photo.dataUrl));
});

test('a configured image-text model failure is not silently retried with the chat model', async t => {
  for (const operation of ['planGallery', 'reviewFoodRender']) await t.test(operation, async () => {
    const app = harness(null, undefined, () => new Response('{}', { status: 503 }),
      { ...config, imageTextModel: 'claude-opus-5-5' });
    await assert.rejects(app.model[operation]({ analysis, profile, outputCount: 9, photos }), { code: 'PROVIDER_ERROR' });
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].body.model, 'claude-opus-5-5');
    assert.equal(app.reservations[0].model, 'claude-opus-5-5');
    assert.equal(app.finishes[0].status, 'failed');
  });
});

test('Claude JSON fences are normalized without accepting prose, partial data or truncated responses', async t => {
  const board = { theme: '菜品与门店', foodGroups: [], shots: [] };
  for (const content of [JSON.stringify(board), '```json\n' + JSON.stringify(board) + '\n```', '  ```JSON\r\n' + JSON.stringify(board) + '\r\n```  ']) await t.test('complete object', async () => {
    const app = harness(null, undefined, () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] })), { ...config, imageTextModel: 'claude-opus-5-5' });
    assert.deepEqual(await app.model.planGallery({ analysis, profile, outputCount: 9, photos }), board);
    assert.equal(app.reservations[0].model, 'claude-opus-5-5');
    assert.equal(app.finishes[0].status, 'completed');
  });
  for (const [content, finishReason] of [
    ['这是分析结果：\n```json\n' + JSON.stringify(board) + '\n```', 'stop'],
    ['```json\n{"theme":', 'stop'],
    ['```json\n[]\n```', 'stop'],
    ['```json\n' + JSON.stringify(board) + '\n```', 'length'],
  ]) await t.test('invalid output', async () => {
    const app = harness(null, undefined, () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] })));
    await assert.rejects(app.model.planGallery({ analysis, profile, outputCount: 9, photos }), { code: 'MODEL_INVALID_OUTPUT' });
    assert.equal(app.requests.length, 1);
    assert.equal(app.finishes[0].status, 'failed');
  });
});
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
  assert.deepEqual(await app.model.write({ profile, analysis, direction, facts, photos, imageMode: 'promotional' }), copy());
  assert.equal(app.requests.length, 1);
  const input = visualInput(app.requests[0], COPY_PROMPT);
  assert.deepEqual(input.profile, profile); assert.deepEqual(input.images.map(item => item.imageId), analysis.map(item => item.imageId));
  assert.deepEqual(input.images.map(item => item.visibleObjects), analysis.map(item => item.visibleObjects));
  assert.deepEqual(input.direction, { id: direction.id, label: direction.label, targetCustomer: direction.targetCustomer, consumptionScene: direction.consumptionScene }); assert.deepEqual(input.confirmedFacts, facts);
  assert.equal(app.requests[0].body.temperature, 0.6);
  assert.equal(input.imageMode, 'promotional');
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
  assert.equal(input.confirmedFacts.price, '18'); assert.deepEqual(input.images.map(item => item.visibleObjects), analysis.map(item => item.visibleObjects));
  assert.equal(input.direction.label, direction.label); assert.equal(input.direction.targetCustomer, direction.targetCustomer);
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
  assert.equal(app.requests[0].body.temperature, 0.3);
  assert.deepEqual(structuredClone(payload), snapshot);
  assertCompletedAttempt(app);
});

test('writing omits rephotography measurements and internal recommendation prose while retaining facts, risks and original photos', async () => {
  const evidence = analysis.map(item => ({ ...item, textRisk: 'warning', riskReasons: ['人工确认图片文字'],
    foodAppearance: { description: '内部形态档案，薄片状食材' }, foodSubjects: [{ box: { left: 0.1, top: 0.2, width: 0.5, height: 0.4 } }] }));
  const planned = { ...direction, recommendationReason: '图中可见多盘食材组合，不能确认肉种', contentGoal: '通过视觉层次呈现菜盘组合', expectedAction: '列入消费候选' };
  const app = harness(copy());
  await app.model.write({ profile, analysis: evidence, direction: planned, facts, photos });
  const input = visualInput(app.requests[0], COPY_PROMPT);
  assert.deepEqual(input.images.map(item => item.visibleObjects), evidence.map(item => item.visibleObjects));
  assert.ok(input.images.every(item => item.textRisk === 'warning' && item.riskReasons[0] === '人工确认图片文字'));
  assert.doesNotMatch(JSON.stringify(input), /foodAppearance|foodSubjects|qualityScore|recommendationReason|contentGoal|expectedAction/);
  assert.deepEqual(input.confirmedFacts, facts);
});

test('audit retains selected evidence beyond the preview attachment subset', async () => {
  const images = [...analysis, { ...analysis[1], imageId: 'photo-extra' }];
  const app = harness({ status: 'passed', warnings: [], errors: [] });
  await app.model.audit({ copy: copy(), profile, images, confirmedFacts: facts, direction, photos });
  const input = visualInput(app.requests[0], AUDIT_PROMPT);
  assert.deepEqual(input.images.map(item => item.imageId), ['photo-food', 'photo-night', 'photo-extra']);
  assert.equal(input.visualImageIds.includes('photo-extra'), false);
  assert.match(AUDIT_PROMPT, /visualImageIds只是本次直接附带缩略图的子集/);
  assert.match(AUDIT_PROMPT, /未出现在visualImageIds不等于已排除/);
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
