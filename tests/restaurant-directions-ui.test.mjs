import test from 'node:test';
import assert from 'node:assert/strict';
import { restaurantAvailablePhotos, restaurantOutputCount, restaurantCanGenerate } from '../design/restaurant.js';

const taskId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const photos = count => Array.from({ length: count }, (_, index) => ({ imageId: `photo-${index + 1}`, usable: true, imageType: 'food', qualityScore: 80, privacyRisk: 'none', textRisk: 'none' }));
const direction = (ids, core = undefined) => ({ id: 'daily', label: '门店日常', supportingImageIds: ids, ...(core ? { coreImageIds: core } : {}), missingFacts: [] });

test('a large supporting pool remains available beyond its core evidence and can overlap another direction', () => {
  const analysis = photos(12);
  const task = { status: 'awaiting_selection', analysis };
  const first = direction(analysis.map(item => item.imageId), ['photo-1', 'photo-2']);
  const second = { ...direction(analysis.slice(0, 8).map(item => item.imageId), ['photo-1']), id: 'lunch' };
  assert.equal(restaurantAvailablePhotos(task, first), 12);
  assert.equal(restaurantOutputCount(task, first), 9);
  assert.equal(restaurantCanGenerate(task, first, { outputCount: 12 }), true);
  assert.equal(restaurantAvailablePhotos(task, second), 8);
  assert.equal(restaurantCanGenerate(task, second, { outputCount: 8 }), true);
  assert.equal(restaurantCanGenerate(task, first, { outputCount: 13 }), false);
  assert.equal(restaurantCanGenerate(task, second, { outputCount: 9 }), false);
});

test('short packages include every core photo while legacy single-photo directions keep working', () => {
  const analysis = photos(3);
  const task = { status: 'awaiting_selection', analysis };
  const current = direction(analysis.map(item => item.imageId), ['photo-1', 'photo-2', 'photo-2']);
  assert.equal(restaurantOutputCount(task, current), 3);
  assert.equal(restaurantCanGenerate(task, current, { outputCount: 1, acceptSparse: true }), false);
  assert.equal(restaurantCanGenerate(task, current, { outputCount: 2, acceptSparse: true }), true);
  assert.equal(restaurantCanGenerate(task, current, { outputCount: 3, acceptSparse: true }), true);
  assert.equal(restaurantCanGenerate(task, current, { outputCount: 2 }), false);
  const legacy = direction(['photo-1']);
  assert.equal(restaurantOutputCount(task, legacy), 1);
  assert.equal(restaurantCanGenerate(task, legacy, { outputCount: 1, acceptSparse: true }), true);
  const missingCore = direction(['photo-1'], ['photo-1', 'photo-2']);
  assert.equal(restaurantOutputCount(task, missingCore), 2);
  assert.equal(restaurantCanGenerate(task, missingCore, { acceptSparse: true }), false);
});

async function renderTask(t, analysis, directions, { taskOverrides = {}, waitFor = '选择一个内容方向' } = {}) {
  const original = Object.fromEntries(['document', 'fetch', 'sessionStorage', 'location', 'matchMedia', 'workspaceUser'].map(key => [key, globalThis[key]]));
  let markup = '';
  const listeners = {};
  const factInput = { dataset: { restFact: 'dishName' }, value: '', addEventListener: (event, callback) => { listeners['fact:' + event] = callback; } };
  const countInput = { addEventListener: (event, callback) => { listeners['count:' + event] = callback; } };
  const root = { contains: () => false, querySelector: selector => selector === '#restaurant-output-count' ? countInput : null, querySelectorAll: selector => selector === '[data-rest-fact]' ? [factInput] : [], set outerHTML(value) { markup = value; } };
  globalThis.document = { activeElement: null, querySelector: selector => selector === '#restaurant-workspace' ? root : null, getElementById: () => null };
  globalThis.location = { origin: 'http://127.0.0.1:5173' };
  globalThis.matchMedia = () => ({ matches: true });
  delete globalThis.workspaceUser;
  const saved = new Map([['restaurant-active-task', taskId]]);
  globalThis.sessionStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const task = { id: taskId, status: 'awaiting_selection', createdAt: Date.now(), analysis, directions, sourceImages: analysis.map((item, index) => ({ id: item.imageId, expiresAt: Date.now() + 60000, url: `/api/restaurant/tasks/${taskId}/files/original-${index + 1}.jpg` })), ...taskOverrides };
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/status')) return Response.json({ enabled: true });
    if (url.endsWith('/profile')) return Response.json({ profile: { name: '真实门店', city: '武汉', address: '真实街道', category: '餐饮' } });
    if (url.endsWith('/usage')) return Response.json({ usage: { limit: 20, remaining: 20 } });
    return Response.json(url.endsWith('/' + taskId) ? { task } : { tasks: [task] });
  };
  const module = await import(`../design/restaurant.js?direction-cards-${crypto.randomUUID()}`);
  t.after(() => {
    module.disposeRestaurant();
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  });
  const ctx = { icon: () => '', toast() {} };
  module.renderRestaurant(ctx); module.bindRestaurant(ctx);
  const settle = async predicate => { for (let count = 0; count < 60 && !predicate(); count++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), 'direction operation should settle'); };
  await settle(() => markup.includes(waitFor));
  return { module, ctx, task, calls, listeners, factInput, saved, settle, html: () => markup, cards: () => [...markup.matchAll(/<button type="button" role="radio"[\s\S]*?<\/button>/g)].map(match => match[0]) };
}

test('direction cards show all twelve usable photos and the real output range', async t => {
  const analysis = photos(12);
  const current = { ...direction(analysis.map(item => item.imageId), ['photo-1', 'photo-2']), imageRoles: [{ imageId: 'photo-1', role: 'cover', reason: '呈现真实菜品' }, { imageId: 'photo-12', role: 'context', reason: '补充门店氛围' }] };
  const app = await renderTask(t, analysis, [current]);
  assert.match(app.cards()[0], /12 张可用素材 · 可生成 12 张/);
  assert.match(app.cards()[0], /相关素材：照片 1、照片 2、照片 3/);
  assert.match(app.cards()[0], /照片 12/);
  assert.doesNotMatch(app.html(), /根据当前可用照片推荐，可生成张数以该方向相关素材为准/);
  assert.ok(!app.html().includes('无需再做筛选'));
  assert.match(app.html(), /<option value="12" selected>12 张<\/option>/);
  assert.match(app.html(), /<option value="6" >6 张<\/option>/);
  assert.equal(app.calls.filter(call => call.method !== 'GET').length, 0);
  assert.match(app.html(), /value="promotional" checked/);
  assert.match(app.html(), /宣传套图/);
});

test('shared supporting photos count independently when switching between directions', async t => {
  const analysis = photos(12);
  const first = direction(analysis.map(item => item.imageId), ['photo-1', 'photo-2']);
  const second = { ...direction(analysis.slice(0, 8).map(item => item.imageId), ['photo-1']), id: 'lunch', label: '附近上班族午餐' };
  const app = await renderTask(t, analysis, [first, second]);
  assert.match(app.cards()[0], /12 张可用素材 · 可生成 12 张/);
  assert.match(app.cards()[1], /8 张可用素材 · 可生成 8 张/);
  assert.match(app.cards()[0], /相关素材：照片 1、/);
  assert.match(app.cards()[1], /相关素材：照片 1、/);
  app.module.handleRestaurantAction('rest-select', { dataset: { id: first.id } }, app.ctx);
  assert.match(app.html(), /<option value="6" >6 张<\/option>/);
  app.module.handleRestaurantAction('rest-select', { dataset: { id: second.id } }, app.ctx);
  assert.match(app.html(), /<option value="8" selected>8 张<\/option>/);
  assert.ok(app.html().includes('<option value="30"'));
});

test('restored task selections keep their saved image mode instead of switching to promotional', async t => {
  for (const imageMode of ['natural', 'cover', 'promotional']) await t.test(imageMode, async child => {
    const analysis = photos(6), current = direction(analysis.map(item => item.imageId));
    const app = await renderTask(child, analysis, [current], { taskOverrides: { selection: { directionId: current.id, imageMode, outputCount: 6 } } });
    assert.match(app.html(), new RegExp(`value="${imageMode}" checked`));
  });
});

test('legacy directions show related material without an invented core label', async t => {
  const app = await renderTask(t, photos(1), [direction(['photo-1'])]);
  assert.match(app.cards()[0], /1 张可用素材 · 可生成 1 张/);
  assert.ok(!app.cards()[0].includes('核心依据'));
  assert.match(app.cards()[0], /相关素材：照片 1/);
  assert.match(app.html(), /套图张数/);
});

test('direction counts exclude unusable sources and all descriptive HTML remains escaped', async t => {
  const analysis = photos(12);
  analysis[11].usable = false;
  const current = { ...direction(analysis.map(item => item.imageId), ['photo-1', 'photo-2']), id: 'daily" onmouseover="alert(1)', label: '<img src=x onerror=alert(1)>', targetCustomer: '<script>顾客</script>', consumptionScene: '<b>消费场景</b>', recommendationReason: '<svg onload=alert(1)>', expectedAction: '<a href=javascript:alert(1)>到店</a>' };
  const app = await renderTask(t, analysis, [current]);
  const card = app.cards()[0];
  assert.match(card, /11 张可用素材 · 可生成 11 张/);
  assert.match(card, /照片 12/);
  assert.match(card, /data-id="daily&quot; onmouseover=&quot;alert\(1\)"/);
  assert.match(card, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(card, /&lt;script&gt;顾客&lt;\/script&gt;/);
  assert.match(card, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(card, /&lt;a href=javascript:alert\(1\)&gt;到店&lt;\/a&gt;/);
  assert.ok(!card.includes('<script>'));
  assert.ok(!card.includes('<svg '));
  assert.ok(!card.includes(' onmouseover="'));
});

test('recommending twice quickly sends one UUID request without uploading and clears matching old direction options', async t => {
  const analysis = photos(12);
  const current = { ...direction(analysis.map(item => item.imageId), ['photo-1', 'photo-2']), missingFacts: [{ field: 'dishName', requiredForGeneration: false, reason: '可确认菜名' }] };
  const app = await renderTask(t, analysis, [current]);
  app.factInput.value = '旧方向已填写菜名'; app.listeners['fact:input']();
  app.listeners['count:change']({ target: { value: '6' } });
  const before = app.module.renderRestaurant(app.ctx);
  assert.match(before, /value="旧方向已填写菜名"/);
  assert.match(before, /<option value="6" selected>/);
  const originalFetch = globalThis.fetch;
  let finish;
  globalThis.fetch = (url, options = {}) => {
    if (url.endsWith('/recommend') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      app.calls.push({ url, method: options.method, body });
      return new Promise(resolve => { finish = () => resolve(Response.json({ task: { ...app.task, recommendationRequestId: body.requestId, directions: [{ ...current, label: '新推荐的午餐方向', supportingImageIds: current.supportingImageIds.slice(0, 8) }], selection: { directionId: current.id, outputCount: 12, facts: { dishName: '服务端旧值' } } } })); });
    }
    return originalFetch(url, options);
  };
  app.module.handleRestaurantAction('rest-recommend', {}, app.ctx);
  app.module.handleRestaurantAction('rest-recommend', {}, app.ctx);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
  assert.match(app.html(), /data-action="rest-recommend" disabled/);
  assert.ok(app.html().includes('value="旧方向已填写菜名"'));
  finish();
  await app.settle(() => app.html().includes('新推荐的午餐方向'));
  const request = app.calls.find(call => call.method === 'POST');
  assert.equal(request.url, `/api/restaurant/tasks/${taskId}/recommend`);
  assert.deepEqual(Object.keys(request.body), ['requestId']);
  assert.match(request.body.requestId, /^[\da-f-]{36}$/i);
  assert.notEqual(request.body.requestId, taskId);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(!app.saved.has('restaurant-pending-recommendation'));
  assert.match(app.html(), /<option value="8" selected>/);
  assert.match(app.html(), /data-rest-fact="dishName" value=""/);
  assert.ok(!app.html().includes('服务端旧值'));
  assert.ok(!app.html().includes('<option value="12"'));
});

test('an interrupted recommendation only queries the original task and never repeats uploads, analysis or paid requests', async t => {
  const analysis = photos(12);
  const current = direction(analysis.map(item => item.imageId), ['photo-1', 'photo-2']);
  const app = await renderTask(t, analysis, [current]);
  const originalFetch = globalThis.fetch;
  let fail;
  const updatedTask = { ...app.task, directions: [{ ...current, label: '查询恢复的新方向' }] };
  globalThis.fetch = (url, options = {}) => {
    if (url.endsWith('/recommend') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      app.calls.push({ url, method: 'POST', body });
      updatedTask.recommendationRequestId = body.requestId;
      return new Promise((resolve, reject) => { fail = () => reject(new TypeError('连接中断')); });
    }
    if (url === `/api/restaurant/tasks/${taskId}`) {
      app.calls.push({ url, method: options.method || 'GET' });
      return Promise.resolve(Response.json({ task: updatedTask }));
    }
    return originalFetch(url, options);
  };
  app.module.handleRestaurantAction('rest-recommend', {}, app.ctx);
  fail();
  await app.settle(() => app.html().includes('不会自动再次调用'));
  assert.match(app.html(), /data-action="rest-recommend" disabled/);
  app.module.handleRestaurantAction('rest-recommend', {}, app.ctx);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
  app.module.handleRestaurantAction('rest-refresh', {}, app.ctx);
  await app.settle(() => app.html().includes('查询恢复的新方向'));
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(app.calls.some(call => call.url === `/api/restaurant/tasks/${taskId}` && call.method === 'GET'));
  assert.ok(!app.calls.some(call => /\/(photos|analyse)$/.test(call.url)));
  assert.ok(!app.calls.some(call => call.url === '/api/restaurant/tasks' && call.method === 'POST'));
});

test('finding the old task with an old nonce does not confirm a recommendation and only a manual retry sends a new request', async t => {
  const analysis = photos(12);
  const current = { ...direction(analysis.map(item => item.imageId), ['photo-1', 'photo-2']), missingFacts: [{ field: 'dishName', requiredForGeneration: false, reason: '确认菜名' }] };
  const app = await renderTask(t, analysis, [current], { taskOverrides: { recommendationRequestId: crypto.randomUUID(), selectedDirectionId: current.id, selection: { directionId: current.id, outputCount: 12, facts: { dishName: '原方案菜名' } } } });
  const originalFetch = globalThis.fetch;
  let rejectRequest = true;
  globalThis.fetch = (url, options = {}) => {
    if (url.endsWith('/recommend') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      app.calls.push({ url, method: 'POST', body });
      if (rejectRequest) return Promise.reject(new TypeError('连接中断'));
      return Promise.resolve(Response.json({ task: { ...app.task, recommendationRequestId: body.requestId, directions: [{ ...current, label: '手动重新推荐已受理', supportingImageIds: current.supportingImageIds.slice(0, 8) }] } }));
    }
    return originalFetch(url, options);
  };
  app.module.handleRestaurantAction('rest-recommend', {}, app.ctx);
  await app.settle(() => app.html().includes('不会自动再次调用'));
  const firstRequest = app.calls.find(call => call.method === 'POST');
  assert.notEqual(firstRequest.body.requestId, app.task.recommendationRequestId);
  app.module.handleRestaurantAction('rest-refresh', {}, app.ctx);
  await app.settle(() => app.html().includes('尚未确认重新推荐，当前仍为原方案，请核对后手动重新推荐'));
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
  assert.match(app.html(), /value="原方案菜名"/);
  assert.match(app.html(), /<option value="12" selected>/);
  assert.ok(!app.saved.has('restaurant-pending-recommendation'));
  assert.ok(!app.html().includes('data-action="rest-recommend" disabled'));
  rejectRequest = false;
  app.module.handleRestaurantAction('rest-recommend', {}, app.ctx);
  await app.settle(() => app.html().includes('手动重新推荐已受理'));
  const requests = app.calls.filter(call => call.method === 'POST');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].body.requestId, requests[1].body.requestId);
  assert.match(app.html(), /<option value="8" selected>/);
  assert.match(app.html(), /data-rest-fact="dishName" value=""/);
});

test('busy old-nonce queries keep the pending request and a reload confirms only the saved matching nonce', async t => {
  const analysis = photos(12);
  const current = direction(analysis.map(item => item.imageId), ['photo-1', 'photo-2']);
  const oldNonce = crypto.randomUUID();
  const app = await renderTask(t, analysis, [current], { taskOverrides: { recommendationRequestId: oldNonce } });
  const originalFetch = globalThis.fetch;
  let latest = app.task;
  globalThis.fetch = (url, options = {}) => {
    if (url.endsWith('/recommend') && options.method === 'POST') {
      app.calls.push({ url, method: 'POST', body: JSON.parse(options.body) });
      return Promise.reject(new TypeError('连接中断'));
    }
    if (url === `/api/restaurant/tasks/${taskId}`) {
      app.calls.push({ url, method: options.method || 'GET' });
      return Promise.resolve(Response.json({ task: latest }));
    }
    return originalFetch(url, options);
  };
  app.module.handleRestaurantAction('rest-recommend', {}, app.ctx);
  await app.settle(() => app.html().includes('不会自动再次调用'));
  const pending = JSON.parse(app.saved.get('restaurant-pending-recommendation'));
  assert.equal(pending.id, taskId);
  assert.equal(pending.requestId, app.calls.find(call => call.method === 'POST').body.requestId);
  latest = { ...app.task, status: 'analysing', recommendationRequestId: oldNonce };
  app.module.handleRestaurantAction('rest-refresh', {}, app.ctx);
  await app.settle(() => app.html().includes('正在核对重新推荐是否已受理'));
  assert.equal(JSON.parse(app.saved.get('restaurant-pending-recommendation')).requestId, pending.requestId);
  app.module.handleRestaurantAction('rest-recommend', {}, app.ctx);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
  app.module.disposeRestaurant();
  latest = { ...app.task, recommendationRequestId: pending.requestId, directions: [{ ...current, label: '刷新后确认新推荐' }] };
  const reloaded = await import(`../design/restaurant.js?recommendation-reload-${crypto.randomUUID()}`);
  t.after(() => reloaded.disposeRestaurant());
  reloaded.renderRestaurant(app.ctx); reloaded.bindRestaurant(app.ctx);
  await app.settle(() => app.html().includes('刷新后确认新推荐'));
  assert.ok(!app.saved.has('restaurant-pending-recommendation'));
  assert.ok(!app.html().includes('尚未确认重新推荐'));
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(app.calls.filter(call => call.url === `/api/restaurant/tasks/${taskId}`).every(call => call.method === 'GET'));
});

test('recommendation stays disabled for incomplete analysis and expired originals', async t => {
  await t.test('incomplete analysis', async child => {
    const analysis = photos(3);
    const app = await renderTask(child, analysis, [direction(analysis.map(item => item.imageId))], { taskOverrides: { sourceImages: photos(4).map((item, index) => ({ id: item.imageId, url: `/api/restaurant/tasks/${taskId}/files/original-${index + 1}.jpg`, expiresAt: Date.now() + 60000 })) } });
    assert.match(app.html(), /data-action="rest-recommend" disabled/);
    app.module.handleRestaurantAction('rest-recommend', {}, app.ctx);
    assert.equal(app.calls.filter(call => call.method === 'POST').length, 0);
  });
  await t.test('expired originals', async child => {
    const analysis = photos(1);
    const app = await renderTask(child, analysis, [direction(['photo-1'])], { taskOverrides: { sourceImages: [{ id: 'photo-1', url: `/api/restaurant/tasks/${taskId}/files/original-1.jpg`, expiresAt: Date.now() - 1 }] }, waitFor: '原图已过期' });
    assert.match(app.html(), /data-action="rest-recommend" disabled/);
    app.module.handleRestaurantAction('rest-recommend', {}, app.ctx);
    assert.equal(app.calls.filter(call => call.method === 'POST').length, 0);
  });
});
