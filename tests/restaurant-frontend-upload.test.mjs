import test from 'node:test';
import assert from 'node:assert/strict';
import { restaurantAvailablePhotos, restaurantOutputCount, restaurantCanGenerate } from '../design/restaurant.js';

const profile = { name: '竹里面馆', city: '武汉', address: '建设一路 18 号', category: '面馆' };
const originals = count => Array.from({ length: count }, (_, index) => ({ name: `实拍-${index}.png`, size: 7 * 1024 * 1024, type: 'image/png', lastModified: index }));

async function restaurantPage(t, { count = 30, interruptBatch = false } = {}) {
  const keys = ['document', 'fetch', 'FileReader', 'sessionStorage', 'location', 'createImageBitmap', 'matchMedia'];
  const originalGlobals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const saved = new Map(), calls = [], tasks = new Map(), listeners = new Map();
  let markup = '', interrupted = false;
  const inputNames = ['restaurant-file-input', 'restaurant-rights', 'restaurant-sparse', 'restaurant-output-count'];
  const inputs = Object.fromEntries(inputNames.map(name => [name, { addEventListener(event, handler) { listeners.set(name + ':' + event, handler); } }]));
  const root = { contains: () => false, querySelector: selector => inputs[selector.slice(1)] || null, querySelectorAll: () => [], set outerHTML(value) { markup = value; } };
  globalThis.document = { activeElement: null, querySelector: selector => selector === '#restaurant-workspace' ? root : null, getElementById: () => null, createElement: () => ({ width: 1, height: 1, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: callback => callback(new Blob(['compressed'], { type: 'image/jpeg' })) }) };
  globalThis.location = { origin: 'http://127.0.0.1:5173' };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.sessionStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  globalThis.createImageBitmap = async () => ({ width: 4000, height: 6000, close() {} });
  globalThis.FileReader = class { readAsDataURL() { queueMicrotask(() => { this.result = 'data:image/jpeg;base64,Y29tcHJlc3NlZA=='; this.onload(); }); } };
  URL.createObjectURL = file => `blob:${file.name}`; URL.revokeObjectURL = () => {};
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method || 'GET', body });
    if (url.endsWith('/status')) return Response.json({ enabled: true });
    if (url.endsWith('/profile')) return Response.json({ profile });
    if (url.endsWith('/usage')) return Response.json({ usage: { limit: 20, remaining: 20 } });
    if (url.includes('/tasks?')) return Response.json({ tasks: [...tasks.values()], nextCursor: null });
    if (url.endsWith('/tasks') && options.method === 'POST') {
      const task = { id: body.requestId, status: 'uploading', imageCount: body.imageCount, uploadedCount: 0, createdAt: Date.now(), sourceImages: [] };
      tasks.set(task.id, task); return Response.json({ task });
    }
    const match = url.match(/\/tasks\/([\da-f-]{36})(?:\/(photos|analyse|generate|cancel-upload))?$/i);
    const task = match && tasks.get(match[1]);
    if (!task) return Response.json({ error: '没有找到该任务' }, { status: 404 });
    if (!match[2]) return Response.json({ task });
    if (match[2] === 'photos') {
      if (interruptBatch && !interrupted && body.startIndex === 3) { interrupted = true; throw new TypeError('上传暂时中断'); }
      for (const [offset, image] of body.images.entries()) {
        const index = body.startIndex + offset;
        task.sourceImages[index] = { id: `photo-${index + 1}`, name: image.name, expiresAt: Date.now() + 60000, url: `/api/restaurant/tasks/${task.id}/files/original-${index + 1}.jpg` };
      }
      task.uploadedCount = Math.max(task.uploadedCount, body.startIndex + body.images.length);
    }
    if (match[2] === 'analyse') {
      task.status = 'awaiting_selection';
      task.analysis = task.sourceImages.map(source => ({ imageId: source.id, usable: true, imageType: 'food', visibleObjects: ['真实菜品'] }));
      task.directions = [{ id: 'food', label: '附近居民的午餐分享', supportingImageIds: task.sourceImages.map(source => source.id), missingFacts: [] }];
    }
    if (match[2] === 'generate') { task.status = 'generating'; task.selection = { directionId: body.directionId, outputCount: body.outputCount }; }
    if (match[2] === 'cancel-upload') { task.status = 'failed'; task.code = 'UPLOAD_CANCELLED'; task.retryable = false; }
    return Response.json({ task });
  };
  const module = await import(`../design/restaurant.js?bulk-${crypto.randomUUID()}`);
  const ctx = { icon: () => '', toast() {} };
  const settle = async predicate => { for (let index = 0; index < 120 && !predicate(); index++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), `restaurant action should settle: ${markup.slice(-400)}`); };
  const files = originals(count);
  const select = () => { listeners.get('restaurant-file-input:change')({ target: { files, value: '' } }); listeners.get('restaurant-rights:change')({ target: { checked: true } }); };
  t.after(() => { module.disposeRestaurant(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; for (const [key, value] of Object.entries(originalGlobals)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });
  module.renderRestaurant(ctx); module.bindRestaurant(ctx); await settle(() => markup.includes('今日剩余'));
  return { module, ctx, calls, tasks, saved, files, listeners, select, settle, markup: () => markup };
}

test('restaurant counts only usable supporting photos and rejects inflated or unconfirmed short packages', () => {
  const task = { status: 'awaiting_selection', analysis: Array.from({ length: 30 }, (_, index) => ({ imageId: `p-${index}`, usable: index !== 29 })) };
  const direction = { supportingImageIds: Array.from({ length: 20 }, (_, index) => `p-${index}`), missingFacts: [] };
  assert.equal(restaurantAvailablePhotos(task, direction), 20);
  assert.equal(restaurantOutputCount(task, direction), 9);
  assert.equal(restaurantCanGenerate(task, direction, { outputCount: 15 }), true);
  assert.equal(restaurantCanGenerate(task, direction, { outputCount: 21 }), false);
  assert.equal(restaurantCanGenerate(task, direction, { outputCount: 5 }), false);
  const shortDirection = { supportingImageIds: ['p-1', 'p-2', 'p-3'], missingFacts: [] };
  assert.equal(restaurantOutputCount(task, shortDirection), 3);
  assert.equal(restaurantCanGenerate(task, shortDirection), false);
  assert.equal(restaurantCanGenerate(task, shortDirection, { outputCount: 3, acceptSparse: true }), true);
  assert.equal(restaurantCanGenerate(task, shortDirection, { outputCount: 6, acceptSparse: true }), false);
});

test('thirty restaurant originals compress into ten batches and the selected package count reaches generation', async t => {
  const app = await restaurantPage(t);
  app.select();
  assert.match(app.markup(), /30 \/ 30/);
  assert.match(app.markup(), /loading="lazy" decoding="async"/);
  app.module.handleRestaurantAction('rest-analyse', {}, app.ctx);
  app.module.handleRestaurantAction('rest-analyse', {}, app.ctx);
  await app.settle(() => app.markup().includes('选择一个内容方向'));
  const init = app.calls.filter(call => call.url.endsWith('/tasks') && call.method === 'POST');
  assert.equal(init.length, 1);
  assert.equal(init[0].body.imageCount, 30);
  assert.equal(init[0].body.images, undefined);
  const batches = app.calls.filter(call => call.url.endsWith('/photos') && call.method === 'POST');
  assert.equal(batches.length, 10);
  assert.deepEqual(batches.map(call => call.body.startIndex), Array.from({ length: 10 }, (_, index) => index * 3));
  assert.ok(batches.every(call => call.body.images.length === 3));
  assert.equal(app.calls.filter(call => call.url.endsWith('/analyse') && call.method === 'POST').length, 1);
  assert.match(app.markup(), /value="9" selected/);
  assert.match(app.markup(), /value="15"/);
  app.listeners.get('restaurant-output-count:change')({ target: { value: '15' } });
  app.module.handleRestaurantAction('rest-generate', {}, app.ctx);
  await app.settle(() => app.calls.some(call => call.url.endsWith('/generate') && call.method === 'POST'));
  assert.equal(app.calls.find(call => call.url.endsWith('/generate') && call.method === 'POST').body.outputCount, 15);
  assert.equal(app.files[29].name, '实拍-29.png');
});

test('restaurant upload failure retains originals and resumes the same task without repeating saved batches', async t => {
  const app = await restaurantPage(t, { count: 7, interruptBatch: true });
  app.select(); app.module.handleRestaurantAction('rest-analyse', {}, app.ctx);
  await app.settle(() => app.markup().includes('上传暂时中断'));
  const draft = JSON.parse(app.saved.get('restaurant-upload-draft'));
  assert.equal(draft.uploadedCount, 3);
  assert.match(app.markup(), /继续上传并分析/);
  assert.match(app.markup(), /7 \/ 30/);
  assert.equal(app.calls.filter(call => call.url.endsWith('/analyse')).length, 0);
  app.module.handleRestaurantAction('rest-analyse', {}, app.ctx);
  await app.settle(() => app.markup().includes('选择一个内容方向'));
  assert.equal(app.calls.filter(call => call.url.endsWith('/tasks') && call.method === 'POST').length, 1);
  assert.deepEqual(app.calls.filter(call => call.url.endsWith('/photos') && call.method === 'POST').map(call => call.body.startIndex), [0, 3, 3, 6]);
  assert.equal(app.calls.filter(call => call.url.endsWith('/analyse')).length, 1);
  assert.ok(app.calls.find(call => call.url.endsWith('/analyse')).url.includes(draft.id));
});

test('starting a fresh restaurant upload explicitly cancels the paused draft before clearing its progress', async t => {
  const app = await restaurantPage(t, { count: 7, interruptBatch: true });
  app.select(); app.module.handleRestaurantAction('rest-analyse', {}, app.ctx);
  await app.settle(() => app.markup().includes('上传暂时中断'));
  const id = JSON.parse(app.saved.get('restaurant-upload-draft')).id;
  app.module.handleRestaurantAction('rest-new', {}, app.ctx);
  await app.settle(() => !app.saved.has('restaurant-upload-draft'));
  assert.equal(app.calls.filter(call => call.url.endsWith('/cancel-upload') && call.method === 'POST').length, 1);
  assert.equal(app.tasks.get(id).code, 'UPLOAD_CANCELLED');
  assert.match(app.markup(), /0 \/ 30/);
  assert.equal(app.calls.filter(call => call.url.endsWith('/analyse')).length, 0);
});
