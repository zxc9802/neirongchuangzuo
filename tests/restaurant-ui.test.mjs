import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRestaurantProfile, validateRestaurantUploads, safeRestaurantFileUrl, restaurantMissingFacts, restaurantCanGenerate, restaurantCopyText } from '../design/restaurant.js';

const profile = { name: '真实面馆', city: '武汉', address: '真实街道 1 号', category: '面馆' };
const id = '00000000-abcd-1234-5678-000000000000';
const photo = (size = 1024, type = 'image/jpeg') => ({ size, type, name: '门店.jpg' });
const direction = { id: 'food', supportingImageIds: ['photo-1'], missingFacts: [{ field: 'dishName', requiredForGeneration: true, reason: '确认菜名' }, { field: 'parking', requiredForGeneration: false, reason: '停车可不写' }] };

test('restaurant entry requires four real merchant fields and validates original photos before upload', () => {
  assert.equal(validateRestaurantProfile(profile), '');
  assert.match(validateRestaurantProfile({ ...profile, address: '  ' }), /门店地址/);
  assert.match(validateRestaurantUploads([]), /至少.*1 张/);
  assert.match(validateRestaurantUploads(Array.from({ length: 31 }, () => photo())), /最多添加 30/);
  assert.match(validateRestaurantUploads([photo(1, 'image/svg+xml')]), /JPG/);
  assert.match(validateRestaurantUploads([photo(0)]), /重新上传/);
  assert.match(validateRestaurantUploads([photo(20 * 1024 * 1024 + 1)]), /单张/);
  assert.match(validateRestaurantUploads(Array.from({ length: 21 }, () => photo(20 * 1024 * 1024))), /总大小/);
  assert.equal(validateRestaurantUploads(Array.from({ length: 3 }, () => photo(8 * 1024 * 1024))), '');
});

test('render and download only allow same-origin restaurant file paths', () => {
  const origin = 'http://127.0.0.1:5173';
  const good = `/api/restaurant/tasks/${id}/files/01.jpg`;
  assert.equal(safeRestaurantFileUrl(good, origin), good);
  for (const bad of ['javascript:alert(1)', '//evil.example/a', 'https://evil.example' + good, '/api/restaurant/profile', good + '?redirect=https://evil.example', good + '#x', `/api/restaurant/tasks/${id}/files/../../profile`, '/api/restaurant/tasks/xyz/files/01.jpg', good.replace('files/', 'files\\')]) assert.equal(safeRestaurantFileUrl(bad, origin), '');
});

test('critical facts and sparse-photo acknowledgement gate generation, optional missing facts do not', () => {
  const task = { status: 'awaiting_selection', analysis: [{ imageId: 'photo-1', usable: true }], sparsePhotos: true };
  assert.equal(restaurantCanGenerate(task, direction, { facts: {} }), false);
  assert.equal(restaurantCanGenerate(task, direction, { facts: { dishName: '热干面' } }), false);
  assert.equal(restaurantCanGenerate(task, direction, { facts: { dishName: '热干面' }, acceptSparse: true }), true);
  assert.equal(restaurantCanGenerate({ ...task, analysis: [{ usable: false }] }, direction, { facts: { dishName: '热干面' }, acceptSparse: true }), false);
  assert.equal(restaurantCanGenerate({ ...task, status: 'failed' }, direction, { facts: { dishName: '热干面' }, acceptSparse: true }), false);
  assert.equal(restaurantCanGenerate({ ...task, status: 'awaiting_confirmation' }, direction, { facts: { dishName: '热干面' }, acceptSparse: true }), false);
  assert.equal(restaurantCanGenerate({ ...task, sourceImages: [{ expiresAt: Date.now() - 1 }] }, direction, { facts: { dishName: '热干面' }, acceptSparse: true }), false);
  assert.deepEqual(restaurantMissingFacts({ missingFacts: direction.missingFacts }, direction, { dishName: '热干面' }).map(item => item.field), ['parking']);
});

test('switching to a conservative direction excludes required facts left over from a previous direction', () => {
  const staleFacts = [{ field: 'price', requiredForGeneration: true, reason: '团购价格必须提供' }];
  const task = { status: 'awaiting_facts', selectedDirectionId: 'group-buy', missingFacts: staleFacts, analysis: [{ usable: true }] };
  const conservative = { id: 'store-scene', missingFacts: [] };
  assert.deepEqual(restaurantMissingFacts(task, conservative), []);
  assert.equal(restaurantCanGenerate(task, conservative, { acceptSparse: true }), true);
  assert.deepEqual(restaurantMissingFacts(task, { id: 'group-buy', missingFacts: [] }), staleFacts);
  assert.equal(restaurantCanGenerate(task, { id: 'group-buy', missingFacts: [] }), false);
  assert.deepEqual(restaurantMissingFacts({ selection: { directionId: 'group-buy' }, missingFacts: staleFacts }, { id: 'group-buy' }), staleFacts);
});

test('photo analysis distinguishes publication warnings from shooting quality and escapes specific risk and rejection text', async () => {
  const original = Object.fromEntries(['document', 'fetch', 'sessionStorage', 'location', 'matchMedia'].map(key => [key, globalThis[key]]));
  let markup = '';
  const root = { contains: () => false, querySelector: () => null, querySelectorAll: () => [], set outerHTML(value) { markup = value; } };
  globalThis.document = { activeElement: null, querySelector: selector => selector === '#restaurant-workspace' ? root : null, getElementById: () => null };
  globalThis.location = { origin: 'http://127.0.0.1:5173' };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.sessionStorage = { getItem: key => key === 'restaurant-active-task' ? id : null, setItem() {}, removeItem() {} };
  const analysis = [
    { imageId: 'photo-1', imageType: 'customers', usable: true, qualityScore: 12, privacyRisk: 'low', textRisk: 'none', visibleObjects: ['顾客用餐'], riskReasons: ['请确认照片中人物授权', '<script>alert(1)</script>'] },
    { imageId: 'photo-2', imageType: 'exterior', usable: true, qualityScore: 83, privacyRisk: 'none', textRisk: 'warning', visibleObjects: ['真实门头'], riskReasons: ['公开门头旁有收款码，请在发布前确认'] },
    { imageId: 'photo-3', imageType: 'food', usable: true, qualityScore: 20, privacyRisk: 'none', textRisk: 'none', visibleObjects: ['真实菜品'], riskReasons: [] },
    { imageId: 'photo-4', imageType: 'other', usable: false, qualityScore: 99, privacyRisk: 'none', textRisk: 'high', rejectionReason: '主体只有联系方式 <b>请换图</b>', riskReasons: ['联系方式占据主要画面'] },
    { imageId: 'photo-5', imageType: 'staff', usable: true, qualityScore: 70, privacyRisk: 'low', textRisk: 'warning', visibleObjects: ['员工工作'], riskReasons: [] },
  ];
  const task = { id, status: 'awaiting_selection', createdAt: Date.now(), analysis, sourceImages: analysis.map(item => ({ id: item.imageId, url: `/api/restaurant/tasks/${id}/files/${item.imageId}.jpg`, expiresAt: Date.now() + 60000 })), directions: [{ id: 'daily', label: '真实门店日常', supportingImageIds: ['photo-1', 'photo-2', 'photo-3', 'photo-5'], missingFacts: [] }] };
  globalThis.fetch = async url => {
    if (url.endsWith('/status')) return Response.json({ enabled: true });
    if (url.endsWith('/profile')) return Response.json({ profile });
    if (url.endsWith('/usage')) return Response.json({ usage: { limit: 20, remaining: 20 } });
    return Response.json(url.endsWith('/' + id) ? { task } : { tasks: [task] });
  };
  const module = await import('../design/restaurant.js?ui-analysis-warnings');
  const ctx = { icon: () => '', toast() {} };
  try {
    module.renderRestaurant(ctx); module.bindRestaurant(ctx);
    for (let count = 0; count < 60 && !markup.includes('照片分析'); count++) await new Promise(resolve => setImmediate(resolve));
    assert.match(markup, /4 \/ 5 张可用/);
    const cards = [...markup.matchAll(/<article class="restaurant-analysis-item[^]*?<\/article>/g)].map(match => match[0]);
    assert.equal(cards.length, 5);
    assert.match(cards[0], /<span>可用 · 发布前需确认<\/span>/);
    assert.doesNotMatch(cards[0], /拍摄质量评分/);
    assert.match(cards[0], /请确认照片中人物授权/);
    assert.match(cards[0], /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(!cards[0].includes('<script>'));
    assert.match(cards[1], /<span>可用 · 发布前需确认<\/span>/);
    assert.match(cards[1], /公开门头旁有收款码，请在发布前确认/);
    assert.match(cards[2], /<span>可用<\/span>/);
    assert.doesNotMatch(cards[2], /拍摄质量评分/);
    assert.ok(!cards[2].includes('发布前需确认'));
    assert.match(cards[3], /<span>不采用<\/span>/);
    assert.match(cards[3], /主体只有联系方式 &lt;b&gt;请换图&lt;\/b&gt;/);
    assert.match(cards[3], /联系方式占据主要画面/);
    assert.ok(!cards[3].includes('<b>请换图</b>'));
    assert.match(cards[4], /<span>可用 · 发布前需确认<\/span>/);
    assert.match(cards[4], /发布前请确认照片中人物已授权/);
    assert.match(cards[4], /发布前请确认图片中文字的真实性/);
    assert.equal(restaurantCanGenerate(task, task.directions[0], { acceptSparse: true }), true);
  } finally {
    module.disposeRestaurant();
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

test('warning review provides read-only drafts and source references while keeping formal files hidden', async () => {
  const original = Object.fromEntries(['document', 'fetch', 'sessionStorage', 'location', 'matchMedia'].map(key => [key, globalThis[key]]));
  let markup = '';
  const root = { contains: () => false, querySelector: () => null, querySelectorAll: () => [], set outerHTML(value) { markup = value; } };
  globalThis.document = { activeElement: null, querySelector: selector => selector === '#restaurant-workspace' ? root : null, getElementById: () => null };
  globalThis.location = { origin: 'http://127.0.0.1:5173' };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const makeFiles = taskId => [{ role: 'image', filename: '01.jpg', url: `/api/restaurant/tasks/${taskId}/files/01.jpg`, expiresAt: Date.now() + 60000 }, { role: 'zip', filename: 'package.zip', url: `/api/restaurant/tasks/${taskId}/files/package.zip`, expiresAt: Date.now() + 60000 }];
  const warningId = '11111111-abcd-1234-5678-000000000000';
  const expiredId = '22222222-abcd-1234-5678-000000000000';
  const blockedId = '33333333-abcd-1234-5678-000000000000';
  const singleId = '44444444-abcd-1234-5678-000000000000';
  const doubleId = '55555555-abcd-1234-5678-000000000000';
  const tasks = [
    { id: warningId, status: 'awaiting_confirmation', createdAt: Date.now(), review: { status: 'passed_with_warning', warnings: ['确认照片中人物授权'] }, copy: { titles: ['已生成标题一', '已生成标题二', '已生成标题三'], coverText: '待确认的封面文字', body: '待确认的正文', tags: ['武汉面馆', '午餐'], imageOrder: ['photo-1'] }, sourceImages: [{ id: 'photo-1', expiresAt: Date.now() + 60000, url: `/api/restaurant/tasks/${warningId}/files/original-1.jpg` }, { id: 'photo-2', expiresAt: Date.now() + 60000, url: `/api/restaurant/tasks/${warningId}/files/original-2.jpg` }], files: makeFiles(warningId) },
    { id: expiredId, status: 'completed', createdAt: Date.now(), filesExpired: true, copy: { titles: ['过期后标题一', '过期后标题二', '过期后标题三'], body: '过期后仍可复制的正文', tags: ['面馆'] }, files: makeFiles(expiredId) },
    { id: blockedId, status: 'failed', createdAt: Date.now(), review: { status: 'blocked', errors: ['价格未经核实'], warnings: [] }, copy: { titles: ['被阻断标题'], coverText: '不能展示的封面字', body: '被阻断的正文', tags: [], imageOrder: ['photo-1'] }, sourceImages: [{ id: 'photo-1', expiresAt: Date.now() + 60000, url: `/api/restaurant/tasks/${blockedId}/files/original-1.jpg` }], files: makeFiles(blockedId) },
    { id: singleId, status: 'completed', createdAt: Date.now(), completedAt: Date.now(), copy: { titles: ['单图标题一', '单图标题二', '单图标题三'], body: '单图正文', tags: [] }, files: makeFiles(singleId) },
    { id: doubleId, status: 'completed', createdAt: Date.now(), completedAt: Date.now(), copy: { titles: ['双图标题一', '双图标题二', '双图标题三'], body: '双图正文', tags: [] }, files: [...makeFiles(doubleId), { role: 'image', filename: '02.jpg', url: `/api/restaurant/tasks/${doubleId}/files/02.jpg`, expiresAt: Date.now() + 60000 }] },
  ];
  globalThis.fetch = async url => {
    if (url.endsWith('/status')) return Response.json({ enabled: true });
    if (url.endsWith('/profile')) return Response.json({ profile });
    if (url.endsWith('/usage')) return Response.json({ usage: { limit: 20, remaining: 19 } });
    const task = tasks.find(item => url.endsWith('/' + item.id));
    return Response.json(task ? { task } : { tasks });
  };
  const module = await import('../design/restaurant.js?ui-review');
  const ctx = { icon: () => '', toast() {} };
  const settle = async predicate => { for (let count = 0; count < 60 && !predicate(); count++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate()); };
  try {
    module.renderRestaurant(ctx); module.bindRestaurant(ctx);
    await settle(() => markup.includes('真实面馆 · 武汉'));
    module.handleRestaurantAction('rest-open-task', { dataset: { id: warningId } }, ctx);
    await settle(() => markup.includes('确认照片中人物授权'));
    assert.ok(!markup.includes(`src="/api/restaurant/tasks/${warningId}/files/01.jpg"`));
    assert.ok(!markup.includes(`href="/api/restaurant/tasks/${warningId}/files/package.zip"`));
    assert.ok(markup.includes('待确认的正文'));
    assert.ok(markup.includes('待确认的封面文字'));
    assert.ok(markup.includes('已生成标题二'));
    assert.ok(markup.includes('#武汉面馆 #午餐'));
    assert.ok(markup.includes('照片为原图参考'));
    assert.ok(markup.includes(`src="/api/restaurant/tasks/${warningId}/files/original-1.jpg"`));
    assert.ok(!markup.includes(`src="/api/restaurant/tasks/${warningId}/files/original-2.jpg"`));
    assert.ok(!markup.includes('data-action="rest-copy"'));
    assert.ok(!markup.includes('download="'));
    module.handleRestaurantAction('rest-open-task', { dataset: { id: blockedId } }, ctx);
    await settle(() => markup.includes('价格未经核实'));
    assert.ok(!markup.includes('待确认预览'));
    assert.ok(!markup.includes('被阻断标题'));
    assert.ok(!markup.includes('被阻断的正文'));
    assert.ok(!markup.includes('不能展示的封面字'));
    assert.ok(!markup.includes(`src="/api/restaurant/tasks/${blockedId}/files/01.jpg"`));
    module.handleRestaurantAction('rest-open-task', { dataset: { id: expiredId } }, ctx);
    await settle(() => markup.includes('过期后仍可复制的正文'));
    assert.ok(markup.includes('文件已过期'));
    assert.ok(!markup.includes(`href="/api/restaurant/tasks/${expiredId}/files/01.jpg"`));
    assert.ok(!markup.includes(`href="/api/restaurant/tasks/${expiredId}/files/package.zip"`));
    module.handleRestaurantAction('rest-open-task', { dataset: { id: singleId } }, ctx);
    await settle(() => markup.includes('单图正文'));
    assert.ok(markup.includes('restaurant-result-content compact single'));
    module.handleRestaurantAction('rest-open-task', { dataset: { id: doubleId } }, ctx);
    await settle(() => markup.includes('双图正文'));
    assert.ok(markup.includes('restaurant-result-content compact double'));
  } finally {
    module.disposeRestaurant();
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

test('publication text preserves line breaks and provides independently copyable titles, body and tags', () => {
  const task = { copy: { titles: ['标题甲', '标题乙', '标题丙'], body: '第一段\n\n第二段', tags: ['武汉面馆', '#午餐'] } };
  assert.equal(restaurantCopyText(task, 'title-1'), '标题乙');
  assert.equal(restaurantCopyText(task, 'body'), '第一段\n\n第二段');
  assert.equal(restaurantCopyText(task, 'tags'), '#武汉面馆 #午餐');
  assert.match(restaurantCopyText(task, 'all'), /标题 3：标题丙\n\n第一段\n\n第二段/);
});

test('restaurant merchant entry opens the server profile and switching accounts clears cached records and rejects old responses', async () => {
  const keys = ['document', 'fetch', 'sessionStorage', 'location', 'matchMedia', 'workspaceUser'];
  const original = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  let markup = '', focusCount = 0, scrollCount = 0, releaseOldResponse;
  const saved = new Map();
  const oldTask = { id, status: 'completed', createdAt: Date.now(), files: [], profileSnapshot: { ...profile, name: '账号甲的门店' }, copy: { titles: ['账号甲的私有标题'], body: '账号甲的私有正文', tags: [] } };
  const root = { contains: () => false, querySelector: () => null, querySelectorAll: () => [], set outerHTML(value) { markup = value; } };
  const profileSection = { scrollIntoView() { scrollCount++; } };
  const profileName = { focus() { focusCount++; } };
  globalThis.document = { activeElement: null, querySelector: selector => selector === '#restaurant-workspace' ? root : selector === '.restaurant-profile' ? profileSection : selector === '#rest-profile-name' ? profileName : null, getElementById: () => null };
  globalThis.location = { origin: 'http://127.0.0.1:5173' };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.workspaceUser = { id: 'account-A' };
  globalThis.sessionStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  globalThis.fetch = async url => {
    const account = globalThis.workspaceUser.id;
    if (url.endsWith('/status')) return Response.json({ enabled: true });
    if (url.endsWith('/profile')) return Response.json({ profile: { ...profile, name: account === 'account-A' ? '账号甲的门店' : '账号乙的门店' } });
    if (url.endsWith('/usage')) return Response.json({ usage: { limit: 20, remaining: 20 } });
    if (url.endsWith('/' + id)) return new Promise(resolve => { releaseOldResponse = () => resolve(Response.json({ task: oldTask })); });
    return Response.json({ tasks: account === 'account-A' ? [oldTask] : [] });
  };
  const module = await import('../design/restaurant.js?ui-account-switch');
  const ctx = { icon: () => '', toast() {} };
  const settle = async predicate => { for (let count = 0; count < 60 && !predicate(); count++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate()); };
  try {
    module.renderRestaurant(ctx); module.bindRestaurant(ctx);
    await settle(() => markup.includes('账号甲的门店'));
    assert.ok(!markup.includes('id="restaurant-profile-form"'));
    assert.equal(module.handleRestaurantAction('rest-edit-profile', {}, ctx), true);
    assert.ok(markup.includes('id="restaurant-profile-form"'));
    assert.equal(scrollCount, 1); assert.equal(focusCount, 1);
    module.handleRestaurantAction('rest-open-task', { dataset: { id } }, ctx);
    await settle(() => !!releaseOldResponse);
    assert.ok(markup.includes('账号甲的私有正文'));
    globalThis.workspaceUser = { id: 'account-B' };
    const firstBRender = module.renderRestaurant(ctx);
    assert.ok(!firstBRender.includes('账号甲'));
    module.bindRestaurant(ctx);
    await settle(() => markup.includes('账号乙的门店'));
    releaseOldResponse();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!markup.includes('账号甲'));
    assert.ok(markup.includes('账号乙的门店'));
    assert.equal(saved.get('restaurant-active-task:account-A'), id);
    assert.equal(saved.get('restaurant-active-task:account-B'), undefined);
  } finally {
    module.disposeRestaurant();
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

test('double click submits one analysis task; interrupted submission only queries its saved ID and escapes model text', async () => {
  const keys = ['document', 'fetch', 'FileReader', 'sessionStorage', 'location', 'createImageBitmap'];
  const original = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const saved = new Map(), calls = [];
  const listeners = {};
  const inputs = Object.fromEntries(['restaurant-file-input', 'restaurant-rights'].map(name => [name, { addEventListener: (event, callback) => { listeners[name + ':' + event] = callback; } }]));
  let markup = '', releasePost, taskId, currentTask;
  const root = { contains: () => false, querySelector: selector => inputs[selector.slice(1)] || null, querySelectorAll: () => [], set outerHTML(value) { markup = value; } };
  globalThis.document = { activeElement: null, querySelector: selector => selector === '#restaurant-workspace' ? root : null, getElementById: () => null , createElement: () => ({ width: 1, height: 1, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: callback => callback(new Blob(['encoded'], { type: 'image/jpeg' })) }) };
  globalThis.createImageBitmap = async () => ({ width: 1200, height: 900, close() {} });
  globalThis.location = { origin: 'http://127.0.0.1:5173' };
  globalThis.sessionStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  URL.createObjectURL = () => 'blob:local-test'; URL.revokeObjectURL = () => {};
  globalThis.FileReader = class { readAsDataURL() { queueMicrotask(() => { this.result = 'data:image/jpeg;base64,aGVsbG8='; this.onload(); }); } };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/status')) return Response.json({ enabled: true });
    if (url.endsWith('/profile')) return Response.json({ profile });
    if (url.endsWith('/usage')) return Response.json({ usage: { limit: 20, remaining: 20 } });
    if (options.method === 'POST' && url.endsWith('/tasks')) {taskId=JSON.parse(options.body).requestId;currentTask={id:taskId,status:'uploading',imageCount:1,uploadedCount:0,createdAt:Date.now()};return Response.json({task:currentTask});}
    if (options.method === 'POST' && url.endsWith('/photos')) {currentTask={...currentTask,uploadedCount:1};return Response.json({task:currentTask});}
    if (options.method === 'POST' && url.endsWith('/analyse')) { return new Promise((resolve, reject) => { releasePost = () => reject(new TypeError('Connection interrupted')); }); }
    if (url === `/api/restaurant/tasks/${taskId}`) return Response.json({ task: { id: taskId, status: 'awaiting_selection', createdAt: Date.now(), sourceImages: [{ id: 'photo-1', expiresAt: Date.now() + 60000, url: `/api/restaurant/tasks/${taskId}/files/original.jpg` }], analysis: [{ imageId: 'photo-1', usable: true }], directions: [{ id: 'food', label: '<img src=x onerror=alert(1)>', targetCustomer: '附近居民', recommendationReason: '<script>alert(1)</script>', supportingImageIds: ['photo-1'], missingFacts: [] }] } });
    return Response.json({ tasks: [], nextCursor: null });
  };
  const settle = async predicate => { for (let count = 0; count < 60 && !predicate(); count++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), 'asynchronous work should settle'); };
  const module = await import('../design/restaurant.js?ui-submit');
  const ctx = { icon: () => '', toast() {} };
  try {
    module.renderRestaurant(ctx); module.bindRestaurant(ctx);
    await settle(() => markup.includes('真实面馆 · 武汉'));
    listeners['restaurant-file-input:change']({ target: { files: [photo()], value: '' } });
    listeners['restaurant-rights:change']({ target: { checked: true } });
    module.handleRestaurantAction('rest-analyse', {}, ctx);
    module.handleRestaurantAction('rest-analyse', {}, ctx);
    await settle(() => !!releasePost);
    assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/analyse')).length, 1);
    assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/tasks')).length, 1);
    assert.equal(saved.get('restaurant-active-task'), taskId);
    releasePost();
    await settle(() => markup.includes('提交连接中断'));
    module.handleRestaurantAction('rest-refresh', {}, ctx);
    await settle(() => markup.includes('选择一个内容方向'));
    assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/analyse')).length, 1);
    assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/tasks')).length, 1);
    assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(markup.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!markup.includes('<script>'));
  } finally {
    module.disposeRestaurant();
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});
