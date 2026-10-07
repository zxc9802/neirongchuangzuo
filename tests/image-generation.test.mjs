import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImageRequest, safeImageResultUrl, imageQualityName } from '../design/image-generation.js';

const asset = (size = 1024, type = 'image/png') => ({ file: { size, type } });

test('image submission validates actual source files, count, type and total upload size', () => {
  assert.match(validateImageRequest('门店宣传图', []), /至少 1 张/);
  assert.match(validateImageRequest('门店宣传图', [{}]), /重新上传/);
  assert.match(validateImageRequest('门店宣传图', [asset(1, 'image/svg+xml')]), /仅支持/);
  assert.match(validateImageRequest('门店宣传图', [asset(8 * 1024 * 1024 + 1)]), /单张/);
  assert.match(validateImageRequest('门店宣传图', Array.from({ length: 4 }, () => asset(7 * 1024 * 1024))), /总大小/);
  assert.match(validateImageRequest('门店宣传图', Array.from({ length: 10 }, () => asset())), /最多添加 9/);
  assert.match(validateImageRequest('x'.repeat(1001), [asset()]), /最多 1000/);
  assert.equal(validateImageRequest('门店宣传图', [asset(8 * 1024 * 1024), asset(8 * 1024 * 1024), asset(8 * 1024 * 1024)]), '');
});

test('only same-origin generated media URLs can render or download', () => {
  const origin = 'http://127.0.0.1:5173';
  assert.equal(safeImageResultUrl('/api/ai/media/00000000-abcd-1234-5678-000000000000/result.png', origin), '/api/ai/media/00000000-abcd-1234-5678-000000000000/result.png');
  for (const value of ['javascript:alert(1)', 'https://external.example/api/ai/media/abc/result.png', '/api/ai/status', '/api/ai/media/abc/result.png?redirect=https://external.example', '/api/ai/media/abc/../../status']) assert.equal(safeImageResultUrl(value, origin), '');
  assert.equal(imageQualityName('2K'), '自动');
});

test('double-clicking submits once; ambiguous network failure only queries the existing request', async () => {
  const original = Object.fromEntries(['document', 'fetch', 'FileReader', 'sessionStorage'].map(key => [key, globalThis[key]]));
  const saved = new Map();
  globalThis.sessionStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  globalThis.document = { body: { dataset: { page: 'image' } }, querySelector: () => null };
  globalThis.FileReader = class { readAsDataURL() { queueMicrotask(() => { this.result = 'data:image/png;base64,iVBORw0KGgo='; this.onload(); }); } };
  const calls = [];
  let releasePost;
  let id;
  let detailRead = false;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    if (url.endsWith('/status')) return Response.json({ image: { configured: true, model: 'gpt-image-2.5-sunburst-c' } });
    if (options.method === 'POST') {
      id = JSON.parse(options.body).requestId;
      return new Promise((resolve, reject) => { releasePost = () => reject(new TypeError('network connection lost after acceptance')); });
    }
    if (url === '/api/ai/images/' + id) { detailRead = true; return Response.json({ task: { id, status: 'completed', prompt: '门店宣传图', createdAt: new Date().toISOString(), images: [] } }); }
    return Response.json({ tasks: [] });
  };
  const generation = await import('../design/image-generation.js?submission-test');
  const ctx = { mode: 'image', modules: { image: { max: 1000 } }, configs: { image: { prompt: '门店宣传图', files: ['one'], ratio: '3:4', quality: 'auto' } }, assets: [{ id: 'one', name: 'store.png', file: asset().file }], icon: () => '', refresh() {}, toast() {}, setPreviewTab() {} };
  const settle = async (predicate) => { for (let i = 0; i < 30 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), 'async operation should settle'); };
  try {
    generation.bindImageGeneration(ctx);
    await settle(() => calls.some(call => call.url.endsWith('/status')));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(generation.handleImageGenerationAction('generate', {}, ctx), true);
    assert.equal(generation.handleImageGenerationAction('generate', {}, ctx), true);
    await settle(() => !!releasePost);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(calls.find(call => call.method === 'POST').body.generationMode, 'single');
    assert.equal(calls.find(call => call.method === 'POST').body.outputCount, 1);
    assert.equal(saved.get('store-ai-pending-image-request'), id);
    releasePost();
    await settle(() => detailRead && !saved.has('store-ai-pending-image-request'));
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.ok(calls.some(call => call.url === '/api/ai/images/' + id && call.method === 'GET'));
  } finally {
    generation.disposeImageGeneration();
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

async function imagePage(t, { config = {}, remaining = 20, tasks = [] } = {}) {
  const originals = Object.fromEntries(['document', 'fetch', 'FileReader', 'sessionStorage', 'location'].map(key => [key, globalThis[key]]));
  const saved = new Map();
  const nodes = new Map(['[data-action="generate"]', '#input-requirement', '#image-generation-options', '#image-generation-notice', '#image-task-queue', '#image-generated-results'].map(key => [key, { innerHTML: '', outerHTML: '', textContent: '', disabled: false }]));
  globalThis.sessionStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  globalThis.location = { origin: 'http://127.0.0.1:5173' };
  globalThis.document = { body: { dataset: { page: 'image' } }, querySelector: key => nodes.get(key) || null };
  globalThis.FileReader = class {
    readAsDataURL(file) { queueMicrotask(() => { this.result = `data:${file.type};base64,iVBORw0KGgo=`; this.onload(); }); }
  };
  const calls = [];
  let history = tasks;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method || 'GET', body });
    if (url.endsWith('/status')) return Response.json({ image: { configured: true, model: 'Max模型', remaining, dailyLimit: 20 } });
    if (options.method === 'POST') {
      const task = { id: body.requestId, status: 'completed', prompt: body.prompt, generationMode: body.generationMode, outputCount: body.outputCount, completedCount: body.outputCount, createdAt: new Date().toISOString(), images: [] };
      history = [task];
      return Response.json({ task });
    }
    return Response.json({ tasks: history });
  };
  const module = await import(`../design/image-generation.js?image-page-${crypto.randomUUID()}`);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const ctx = {
    mode: 'image', modules: { image: { max: 1000 } },
    configs: { image: { prompt: '保留真实门店和商品，做春日宣传图', files: ['one', 'two'], ratio: '3:4', quality: 'auto', ...config } },
    assets: [{ id: 'one', name: 'store.png', file: asset().file }, { id: 'two', name: 'product.png', file: asset().file }],
    icon: () => '', esc, button: (action, label, className = '', extra = '') => `<button data-action="${action}" class="${className}" ${extra}>${label}</button>`,
    refresh() {}, toast() {}, setPreviewTab() {},
  };
  const settle = async predicate => {
    for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(predicate(), 'image page operation should settle');
  };
  t.after(() => {
    module.disposeImageGeneration();
    for (const [key, value] of Object.entries(originals)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  });
  module.bindImageGeneration(ctx);
  await settle(() => nodes.get('#image-generation-notice').outerHTML.includes('今日剩余'));
  return { module, ctx, nodes, calls, settle };
}

test('series and variations submit one task with the chosen output count and all originals', async t => {
  for (const generationMode of ['series', 'variations']) await t.test(generationMode, async child => {
    const app = await imagePage(child, { config: { generationMode, count: '4' } });
    const button = app.nodes.get('[data-action="generate"]');
    assert.equal(button.disabled, false);
    assert.match(button.innerHTML, generationMode === 'series' ? /生成4张套图/ : /生成4张不同风格/);
    assert.match(app.nodes.get('#image-generation-options').innerHTML, /预计使用4次图片额度/);
    app.module.handleImageGenerationAction('generate', {}, app.ctx);
    app.module.handleImageGenerationAction('generate', {}, app.ctx);
    await app.settle(() => app.calls.some(call => call.method === 'POST'));
    const submissions = app.calls.filter(call => call.method === 'POST');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].body.generationMode, generationMode);
    assert.equal(submissions[0].body.outputCount, 4);
    assert.equal(submissions[0].body.prompt, app.ctx.configs.image.prompt);
    assert.deepEqual(submissions[0].body.images.map(image => image.name), ['store.png', 'product.png']);
    await app.settle(() => app.nodes.get('#image-generated-results').outerHTML.includes(submissions[0].body.requestId));
  });
});

test('inline generation changes retain originals, presets and hand-edited requirements', async t => {
  const preset = { id: 'original-preset', appliedPrompt: '预设要求' };
  const app = await imagePage(t, { config: { imagePreset: preset } });
  const c = app.ctx.configs.image;
  const originalFiles = c.files;
  const originalPrompt = c.prompt;
  assert.match(app.nodes.get('[data-action="generate"]').innerHTML, /立即生成图片/);
  app.module.handleImageGenerationAction('image-generation-mode', { dataset: { value: 'series' } }, app.ctx);
  assert.equal(c.generationMode, 'series');
  assert.equal(c.count, '4');
  app.module.handleImageGenerationAction('image-output-count', { dataset: { value: '3' } }, app.ctx);
  app.module.handleImageGenerationAction('image-generation-mode', { dataset: { value: 'variations' } }, app.ctx);
  assert.equal(c.count, '3');
  assert.match(app.nodes.get('[data-action="generate"]').innerHTML, /生成3张不同风格/);
  assert.strictEqual(c.files, originalFiles);
  assert.deepEqual(c.files, ['one', 'two']);
  assert.equal(c.prompt, originalPrompt);
  assert.strictEqual(c.imagePreset, preset);
  app.module.handleImageGenerationAction('image-generation-mode', { dataset: { value: 'single' } }, app.ctx);
  assert.equal(c.count, '1');
  assert.match(app.nodes.get('#image-generation-options').innerHTML, /预计使用1次图片额度/);
});

test('insufficient quota blocks the whole image set and a smaller count can proceed', async t => {
  const app = await imagePage(t, { config: { generationMode: 'series', count: '4' }, remaining: 3 });
  assert.equal(app.nodes.get('[data-action="generate"]').disabled, true);
  assert.match(app.nodes.get('#input-requirement').textContent, /需要4次.*仅剩3次/);
  app.module.handleImageGenerationAction('generate', {}, app.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 0);
  app.module.handleImageGenerationAction('image-output-count', { dataset: { value: '3' } }, app.ctx);
  assert.equal(app.nodes.get('[data-action="generate"]').disabled, false);
  assert.match(app.nodes.get('[data-action="generate"]').innerHTML, /生成3张套图/);
  assert.match(app.nodes.get('#image-generation-options').innerHTML, /预计使用3次图片额度/);
});

test('partial image sets explain missing outputs, escape labels and keep safe downloads until expiry', async t => {
  const id = '00000000-abcd-1234-5678-000000000000';
  const task = {
    id, status: 'completed', prompt: '门店春日主题', generationMode: 'variations', outputCount: 4, completedCount: 2,
    partial: true, warning: '其余图片未完成 <img src=x onerror=alert(1)>', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    images: [
      { index: 1, label: '简洁纪实', style: '自然摄影', url: `/api/ai/media/${id}/result-1.png`, filename: 'result-1.png' },
      { index: 3, label: '<script>坏标签</script>', style: '温暖生活感', url: `/api/ai/media/${id}/result-3.png`, filename: 'result-3.png' },
      { index: 4, label: '不安全图片', url: 'https://outside.invalid/image.png' },
    ],
  };
  const app = await imagePage(t, { tasks: [task, { ...task, id: 'expired', prompt: '已过期集合', expiresAt: new Date(Date.now() - 1).toISOString() }] });
  const markup = app.module.renderImageResults(app.ctx);
  assert.match(markup, /同主题多风格 · 2 \/ 4 张/);
  assert.match(markup, /已生成 2 张，剩余 2 张未完成/);
  assert.match(markup, /部分完成/);
  assert.equal((markup.match(/download="result-/g) || []).length, 2);
  assert.match(markup, /简洁纪实/);
  assert.match(markup, /温暖生活感/);
  assert.match(markup, /&lt;script&gt;坏标签&lt;\/script&gt;/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(markup, /outside\.invalid|已过期集合|<script>|<img src=x/);
});

test('running image sets show saved progress and cannot be submitted again', async t => {
  const app = await imagePage(t, { tasks: [{ id: '00000000-abcd-1234-5678-000000000001', status: 'running', prompt: '门店主题套图', generationMode: 'series', outputCount: 4, completedCount: 1, createdAt: new Date().toISOString(), images: [] }] });
  assert.equal(app.nodes.get('[data-action="generate"]').disabled, true);
  assert.match(app.nodes.get('[data-action="generate"]').innerHTML, /图片生成中 1 \/ 4/);
  assert.match(app.module.renderImageResults(app.ctx), /已生成 1 \/ 4 张/);
  app.module.handleImageGenerationAction('generate', {}, app.ctx);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 0);
});
