import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImageRequest, safeImageResultUrl, imageQualityName } from '../design/image-generation.js';

const asset = (size = 1024, type = 'image/png') => ({ file: { size, type } });
function canvasMock() { return { width: 1, height: 1, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: callback => callback(new Blob(['encoded'], { type: 'image/jpeg' })) }; }
function bitmapMock() { return Promise.resolve({ width: 1200, height: 900, close() {} }); }

test('image submission validates actual source files, count, type and total upload size', () => {
  assert.match(validateImageRequest('门店宣传图', []), /至少 1 张/);
  assert.match(validateImageRequest('门店宣传图', [{}]), /重新上传/);
  assert.match(validateImageRequest('门店宣传图', [asset(1, 'image/svg+xml')]), /仅支持/);
  assert.match(validateImageRequest('门店宣传图', [asset(20 * 1024 * 1024 + 1)]), /单张/);
  assert.match(validateImageRequest('门店宣传图', Array.from({ length: 21 }, () => asset(20 * 1024 * 1024))), /总大小/);
  assert.match(validateImageRequest('门店宣传图', Array.from({ length: 31 }, () => asset())), /最多添加 30/);
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
  const original = Object.fromEntries(['document', 'fetch', 'FileReader', 'sessionStorage', 'createImageBitmap'].map(key => [key, globalThis[key]]));
  const saved = new Map();
  globalThis.sessionStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  globalThis.document = { body: { dataset: { page: 'image' } }, querySelector: () => null, createElement: canvasMock };
  globalThis.createImageBitmap = bitmapMock;
  globalThis.FileReader = class { readAsDataURL() { queueMicrotask(() => { this.result = 'data:image/png;base64,iVBORw0KGgo='; this.onload(); }); } };
  const calls = [];
  let releasePost;
  let id;
  let detailRead = false; let upload;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    if (url.endsWith('/status')) return Response.json({ image: { configured: true, model: 'gpt-image-2.5-sunburst-c' } });
    if (url.includes('/image-uploads')) {
      const body=options.body?JSON.parse(options.body):null;
      if(url==='/api/ai/image-uploads'&&options.method==='POST'){ upload={id:body.requestId,imageCount:body.imageCount,uploadedCount:0,submitted:false};return Response.json({upload}); }
      if(options.method==='POST'){upload.uploadedCount=body.startIndex+body.images.length;upload.complete=true;return Response.json({upload});}
      return upload?Response.json({upload}):Response.json({error:'not found'},{status:404});
    }
    if (options.method === 'POST') {
      id = JSON.parse(options.body).requestId;
      return new Promise((resolve, reject) => { releasePost = () => reject(new TypeError('network connection lost after acceptance')); });
    }
    if (url === '/api/ai/images/' + id) { detailRead = true; return Response.json({ task: { id, status: 'completed', prompt: '门店宣传图', createdAt: new Date().toISOString(), images: [] } }); }
    return Response.json({ tasks: [] });
  };
  const generation = await import('../design/image-generation.js?submission-test');
  const ctx = { mode: 'image', modules: { image: { max: 1000 } }, configs: { image: { prompt: '门店宣传图', files: ['one'], ratio: '3:4', quality: 'auto' } }, assets: [{ id: 'one', name: 'store.png', file: { ...asset().file, name: 'store.png' } }], icon: () => '', refresh() {}, toast() {}, setPreviewTab() {} };
  const settle = async (predicate) => { for (let i = 0; i < 30 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), 'async operation should settle'); };
  try {
    generation.bindImageGeneration(ctx);
    await settle(() => calls.some(call => call.url.endsWith('/status')));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(generation.handleImageGenerationAction('generate', {}, ctx), true);
    assert.equal(generation.handleImageGenerationAction('generate', {}, ctx), true);
    await settle(() => !!releasePost);
    assert.equal(calls.filter(call => call.method === 'POST' && call.url === '/api/ai/images').length, 1);
    assert.equal(calls.find(call => call.method === 'POST' && call.url === '/api/ai/images').body.generationMode, 'single');
    assert.equal(calls.find(call => call.method === 'POST' && call.url === '/api/ai/images').body.outputCount, 1);
    assert.equal(saved.get('store-ai-pending-image-request'), id);
    releasePost();
    await settle(() => detailRead && !saved.has('store-ai-pending-image-request'));
    assert.equal(calls.filter(call => call.method === 'POST' && call.url === '/api/ai/images').length, 1);
    assert.ok(calls.some(call => call.url === '/api/ai/images/' + id && call.method === 'GET'));
  } finally {
    generation.disposeImageGeneration();
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

async function imagePage(t, { config = {}, remaining = 20, tasks = [], uploadDraft = null, pendingId = null, expiredUpload = false } = {}) {
  const originals = Object.fromEntries(['document', 'fetch', 'FileReader', 'sessionStorage', 'location', 'createImageBitmap'].map(key => [key, globalThis[key]]));
  const saved = new Map();
  if (uploadDraft) saved.set('store-ai-image-upload-draft', JSON.stringify(uploadDraft));
  if (pendingId) saved.set('store-ai-pending-image-request', pendingId);
  const nodes = new Map(['[data-action="generate"]', '#input-requirement', '#image-generation-options', '#image-generation-notice', '#image-task-queue', '#image-generated-results'].map(key => [key, { innerHTML: '', outerHTML: '', textContent: '', disabled: false }]));
  globalThis.sessionStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  globalThis.location = { origin: 'http://127.0.0.1:5173' };
  globalThis.document = { body: { dataset: { page: 'image' } }, querySelector: key => nodes.get(key) || null, createElement: canvasMock };
  globalThis.createImageBitmap = bitmapMock;
  globalThis.FileReader = class {
    readAsDataURL(file) { queueMicrotask(() => { this.result = `data:${file.type};base64,iVBORw0KGgo=`; this.onload(); }); }
  };
  const calls = [];
  let history = tasks; let upload = uploadDraft ? { ...uploadDraft, submitted: false, complete: uploadDraft.uploadedCount === uploadDraft.imageCount } : undefined;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method || 'GET', body });
    if (url.endsWith('/status')) return Response.json({ image: { configured: true, model: 'Max模型', remaining, dailyLimit: 20 } });
    if (url.includes('/image-uploads')) {
      if(url==='/api/ai/image-uploads'&&options.method==='POST'){upload={id:body.requestId,imageCount:body.imageCount,uploadedCount:0,submitted:false};return Response.json({upload});}
      if(options.method==='POST'){upload.uploadedCount=body.startIndex+body.images.length;upload.complete=upload.uploadedCount===upload.imageCount;return Response.json({upload});}
      if (upload && url.split('/').pop() !== upload.id) return Response.json({ error: 'not found' }, { status: 404 });
      if (expiredUpload && upload?.id === uploadDraft?.id) return Response.json({ error: '这组原图已超过3天保留期，请重新上传。', code: 'UPLOAD_EXPIRED' }, { status: 410 });
      return upload?Response.json({upload}):Response.json({error:'not found'},{status:404});
    }
    if (options.method === 'POST') {
      const task = { id: body.requestId, status: 'completed', prompt: body.prompt, generationMode: body.generationMode, outputCount: body.outputCount, completedCount: body.outputCount, createdAt: new Date().toISOString(), images: [] };
      history = [task];
      return Response.json({ task });
    }
    if (url.startsWith('/api/ai/images/')) {
      const task = history.find(item => item.id === url.split('/').pop());
      return task ? Response.json({ task }) : Response.json({ error: 'not found' }, { status: 404 });
    }
    return Response.json({ tasks: history });
  };
  const module = await import(`../design/image-generation.js?image-page-${crypto.randomUUID()}`);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const ctx = {
    mode: 'image', modules: { image: { max: 1000 } },
    configs: { image: { prompt: '保留真实门店和商品，做春日宣传图', files: ['one', 'two'], ratio: '3:4', quality: 'auto', ...config } },
    assets: [{ id: 'one', name: 'store.png', file: { ...asset().file, name: 'store.png' } }, { id: 'two', name: 'product.png', file: { ...asset().file, name: 'product.png' } }],
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
  await settle(() => nodes.get('#image-generation-notice').outerHTML.includes('Max模型'));
  return { module, ctx, nodes, calls, settle, saved };
}

test('series and variations submit one task with the chosen output count and all originals', async t => {
  for (const generationMode of ['series', 'variations']) await t.test(generationMode, async child => {
    const app = await imagePage(child, { config: { generationMode, count: '4' } });
    const button = app.nodes.get('[data-action="generate"]');
    assert.equal(button.disabled, false);
    assert.match(button.innerHTML, generationMode === 'series' ? /生成4张套图/ : /生成4张不同风格/);
    assert.match(app.nodes.get('#image-generation-options').innerHTML, /<option value="4" selected>4 张<\/option>/);
    app.module.handleImageGenerationAction('generate', {}, app.ctx);
    app.module.handleImageGenerationAction('generate', {}, app.ctx);
    await app.settle(() => app.calls.some(call => call.method === 'POST' && call.url === '/api/ai/images'));
    const submissions = app.calls.filter(call => call.method === 'POST' && call.url === '/api/ai/images');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].body.generationMode, generationMode);
    assert.equal(submissions[0].body.outputCount, 4);
    assert.equal(submissions[0].body.prompt, app.ctx.configs.image.prompt);
    assert.equal(submissions[0].body.images, undefined);
    assert.equal(submissions[0].body.uploadId, submissions[0].body.requestId);
    const batch = app.calls.find(call => call.url.endsWith('/batches') && call.method === 'POST');
    assert.deepEqual(batch.body.images.map(image => image.name), ['store.jpg', 'product.jpg']);
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
  assert.equal(c.count, '6');
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
  assert.match(app.nodes.get('#image-generation-options').innerHTML, /image-single-count">1 张/);
});

test('insufficient quota blocks the whole image set and a smaller count can proceed', async t => {
  const app = await imagePage(t, { config: { generationMode: 'series', count: '4' }, remaining: 3 });
  assert.equal(app.nodes.get('[data-action="generate"]').disabled, true);
  assert.match(app.nodes.get('#input-requirement').textContent, /本次张数超出今日服务限额.*请减少张数/);
  app.module.handleImageGenerationAction('generate', {}, app.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.calls.filter(call => call.method === 'POST' && call.url === '/api/ai/images').length, 0);
  app.module.handleImageGenerationAction('image-output-count', { dataset: { value: '3' } }, app.ctx);
  assert.equal(app.nodes.get('[data-action="generate"]').disabled, false);
  assert.match(app.nodes.get('[data-action="generate"]').innerHTML, /生成3张套图/);
  assert.match(app.nodes.get('#image-generation-options').innerHTML, /<option value="3" selected>3 张<\/option>/);
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
  assert.equal(app.calls.filter(call => call.method === 'POST' && call.url === '/api/ai/images').length, 0);
});

test('thirty originals upload in ordered batches before one fifteen-image task', async t => {
  const app = await imagePage(t, { config: { generationMode: 'series', count: '15' } });
  app.ctx.assets = Array.from({ length: 30 }, (_, index) => ({ id: `source-${index}`, name: `门店-${index}.png`, file: { ...asset(7 * 1024 * 1024).file, name: `门店-${index}.png`, lastModified: index } }));
  app.ctx.configs.image.files = app.ctx.assets.map(item => item.id);
  app.module.updateImageGenerationControls(app.ctx);
  assert.match(app.nodes.get('#image-generation-options').innerHTML, /<option value="15" selected>15 张<\/option>/);
  app.module.handleImageGenerationAction('generate', {}, app.ctx);
  await app.settle(() => app.calls.some(call => call.url === '/api/ai/images' && call.method === 'POST'));
  const batches = app.calls.filter(call => call.url.endsWith('/batches') && call.method === 'POST');
  assert.equal(batches.length, 10);
  assert.deepEqual(batches.map(call => call.body.startIndex), Array.from({ length: 10 }, (_, index) => index * 3));
  assert.ok(batches.every(call => call.body.images.length === 3 && call.body.images.every(image => image.dataUrl.startsWith('data:image/jpeg;'))));
  const init = app.calls.find(call => call.url === '/api/ai/image-uploads' && call.method === 'POST');
  const generated = app.calls.find(call => call.url === '/api/ai/images' && call.method === 'POST');
  assert.equal(init.body.imageCount, 30);
  assert.equal(generated.body.requestId, init.body.requestId);
  assert.equal(generated.body.uploadId, init.body.requestId);
  assert.equal(generated.body.outputCount, 15);
  assert.equal(generated.body.images, undefined);
  assert.equal(app.ctx.configs.image.files.length, 30);
  assert.equal(app.ctx.assets[29].file.name, '门店-29.png');
});

test('an interrupted upload survives page reload and resumes remaining photos under the same UUID', async t => {
  const app = await imagePage(t, { config: { generationMode: 'series', count: '6' } });
  app.ctx.assets = Array.from({ length: 7 }, (_, index) => ({ id: `source-${index}`, file: { ...asset().file, name: `原图-${index}.png`, lastModified: index } }));
  const ids = app.ctx.assets.map(item => item.id);
  app.ctx.configs.image.files = [...ids];
  const originalFetch = globalThis.fetch;
  let interrupt = true;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/batches') && options.method === 'POST' && JSON.parse(options.body).startIndex === 3 && interrupt) { interrupt = false; throw new TypeError('网络暂时断开'); }
    return originalFetch(url, options);
  };
  app.module.handleImageGenerationAction('generate', {}, app.ctx);
  await app.settle(() => app.nodes.get('#image-generation-notice').outerHTML.includes('网络暂时断开'));
  const draft = JSON.parse(app.saved.get('store-ai-image-upload-draft'));
  assert.equal(draft.uploadedCount, 3);
  assert.equal(app.calls.filter(call => call.url === '/api/ai/images' && call.method === 'POST').length, 0);
  assert.equal(app.ctx.configs.image.files.length, 7);
  app.module.disposeImageGeneration();
  app.ctx.configs.image.files = []; app.ctx.configs.image.prompt = '';
  const reloaded = await import(`../design/image-generation.js?reload-${crypto.randomUUID()}`);
  t.after(() => reloaded.disposeImageGeneration());
  reloaded.bindImageGeneration(app.ctx);
  await app.settle(() => app.nodes.get('#image-generation-notice').outerHTML.includes('素材已保存 3 / 7 张'));
  assert.match(app.ctx.configs.image.prompt, /真实门店/);
  assert.equal(app.calls.filter(call => call.url === '/api/ai/images' && call.method === 'POST').length, 0);
  app.ctx.configs.image.files = [...ids];
  reloaded.updateImageGenerationControls(app.ctx);
  await app.settle(() => app.nodes.get('[data-action="generate"]').disabled === false);
  reloaded.handleImageGenerationAction('image-resume-upload', {}, app.ctx);
  await app.settle(() => app.calls.some(call => call.url === '/api/ai/images' && call.method === 'POST'));
  const generated = app.calls.find(call => call.url === '/api/ai/images' && call.method === 'POST');
  assert.equal(generated.body.requestId, draft.id);
  assert.equal(app.calls.filter(call => call.url === '/api/ai/image-uploads' && call.method === 'POST').length, 1);
  assert.deepEqual(app.calls.filter(call => call.url.endsWith('/batches') && call.method === 'POST').map(call => call.body.startIndex), [0, 3, 6]);
});

test('fifteen image outputs require fifteen remaining calls without hiding retained legacy counts', async t => {
  const app = await imagePage(t, { config: { generationMode: 'variations', count: '15' }, remaining: 14 });
  assert.equal(app.nodes.get('[data-action="generate"]').disabled, true);
  assert.match(app.nodes.get('#input-requirement').textContent, /本次张数超出今日服务限额.*请减少张数/);
  assert.match(app.nodes.get('#image-generation-options').innerHTML, /value="6"/);
  assert.match(app.nodes.get('#image-generation-options').innerHTML, /value="15"/);
  app.module.handleImageGenerationAction('image-output-count', { dataset: { value: '14' } }, app.ctx);
  assert.equal(app.nodes.get('[data-action="generate"]').disabled, false);
  assert.match(app.nodes.get('[data-action="generate"]').innerHTML, /生成14张不同风格/);
});

test('completed upload drafts still validate requirements before a paid submission', async t => {
  const uploadDraft = { id: crypto.randomUUID(), imageCount: 2, uploadedCount: 2, fingerprints: [], stage: 'ready' };
  const app = await imagePage(t, { uploadDraft, config: { files: [], prompt: '字'.repeat(1001), generationMode: 'series', count: '6' } });
  assert.equal(app.nodes.get('[data-action="generate"]').disabled, true);
  assert.match(app.nodes.get('#input-requirement').textContent, /最多 1000 字/);
  app.module.handleImageGenerationAction('generate', {}, app.ctx);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 0);
  app.ctx.configs.image.prompt = ' ';
  app.module.updateImageGenerationControls(app.ctx);
  assert.equal(app.nodes.get('[data-action="generate"]').disabled, true);
  app.ctx.configs.image.prompt = '字'.repeat(1000);
  app.module.updateImageGenerationControls(app.ctx);
  assert.equal(app.nodes.get('[data-action="generate"]').disabled, false);
});

test('expired upload progress clears without generating and the same originals use a new UUID after an explicit click', async t => {
  const oldId = crypto.randomUUID();
  const files = ['store.png', 'product.png'].map(name => ({ ...asset().file, name }));
  const uploadDraft = { id: oldId, imageCount: 2, uploadedCount: 2, fingerprints: files.map(file => [file.name, file.size, file.type, 0]), stage: 'ready', expiresAt: new Date(Date.now() - 1).toISOString() };
  const app = await imagePage(t, { uploadDraft, expiredUpload: true, pendingId: oldId, config: { generationMode: 'series', count: '6' } });
  await app.settle(() => !app.saved.has('store-ai-image-upload-draft') && !app.saved.has('store-ai-pending-image-request'));
  assert.match(app.nodes.get('#image-generation-notice').outerHTML, /超过3天保留期.*已清除/);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 0);
  assert.deepEqual(app.ctx.configs.image.files, ['one', 'two']);
  assert.equal(app.ctx.assets[0].file.name, 'store.png');
  app.module.handleImageGenerationAction('generate', {}, app.ctx);
  await app.settle(() => app.calls.some(call => call.url === '/api/ai/images' && call.method === 'POST'));
  const init = app.calls.find(call => call.url === '/api/ai/image-uploads' && call.method === 'POST');
  const generated = app.calls.find(call => call.url === '/api/ai/images' && call.method === 'POST');
  assert.notEqual(init.body.requestId, oldId);
  assert.equal(generated.body.requestId, init.body.requestId);
  assert.equal(app.calls.filter(call => call.url === '/api/ai/images' && call.method === 'POST').length, 1);
});

test('new creation discards an interrupted two-photo upload and quotes the newly selected one-photo draft before network lookup', async t => {
  const oldId = crypto.randomUUID();
  const uploadDraft = { id: oldId, imageCount: 2, uploadedCount: 0, fingerprints: [], stage: 'uploading', config: { prompt: '旧门店主题', generationMode: 'series', count: '6' } };
  const app = await imagePage(t, { uploadDraft, config: { files: [], prompt: '' } });
  assert.equal(app.ctx.configs.image.prompt, '旧门店主题');
  assert.match(app.nodes.get('#image-generation-notice').outerHTML, /素材已保存 0 \/ 2 张/);
  assert.equal(app.module.resetImageCreation(app.ctx), true);
  assert.equal(app.saved.has('store-ai-image-upload-draft'), false);
  app.ctx.configs.image.prompt = ''; app.ctx.configs.image.files = [];
  app.module.bindImageGeneration(app.ctx);
  assert.equal(app.ctx.configs.image.prompt, '');
  app.ctx.configs.image.prompt = '新门店宣传';
  app.ctx.configs.image.files = ['one'];
  app.ctx.configs.image.generationMode = 'series'; app.ctx.configs.image.count = '6';
  const originalFetch = globalThis.fetch;
  let releaseLookup;
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/image-uploads/') && !options.method && !releaseLookup) {
      return new Promise(resolve => { releaseLookup = () => resolve(originalFetch(url, options)); });
    }
    return originalFetch(url, options);
  };
  app.module.handleImageGenerationAction('generate', {}, app.ctx);
  await app.settle(() => !!releaseLookup);
  assert.match(app.nodes.get('#input-requirement').textContent, /正在上传 0 \/ 1 张/);
  const current = JSON.parse(app.saved.get('store-ai-image-upload-draft'));
  assert.notEqual(current.id, oldId); assert.equal(current.imageCount, 1);
  assert.equal(app.module.resetImageCreation(app.ctx), false);
  assert.equal(JSON.parse(app.saved.get('store-ai-image-upload-draft')).id, current.id);
  releaseLookup();
  await app.settle(() => app.calls.some(call => call.url === '/api/ai/images' && call.method === 'POST'));
  const init = app.calls.find(call => call.url === '/api/ai/image-uploads' && call.method === 'POST');
  const generated = app.calls.find(call => call.url === '/api/ai/images' && call.method === 'POST');
  assert.equal(init.body.imageCount, 1); assert.equal(init.body.requestId, current.id);
  assert.equal(generated.body.outputCount, 6); assert.equal(generated.body.uploadId, current.id);
});

test('a delayed old upload read cannot resurrect a draft discarded by new creation', async t => {
  const uploadDraft = { id: crypto.randomUUID(), imageCount: 2, uploadedCount: 0, fingerprints: [], stage: 'uploading', config: { prompt: '旧主题' } };
  const app = await imagePage(t, { uploadDraft });
  const originalFetch = globalThis.fetch;
  let releaseLookup;
  globalThis.fetch = async (url, options = {}) => {
    if (url === `/api/ai/image-uploads/${uploadDraft.id}` && !options.method) return new Promise(resolve => { releaseLookup = () => resolve(Response.json({ upload: { ...uploadDraft, uploadedCount: 2, complete: true } })); });
    return originalFetch(url, options);
  };
  app.module.handleImageGenerationAction('image-refresh', {}, app.ctx);
  await app.settle(() => !!releaseLookup);
  assert.equal(app.module.resetImageCreation(app.ctx), true);
  app.ctx.configs.image.prompt = ''; app.ctx.configs.image.files = [];
  releaseLookup();
  await app.settle(() => !app.nodes.get('#image-generation-notice').outerHTML.includes('disabled'));
  assert.equal(app.saved.has('store-ai-image-upload-draft'), false);
  assert.doesNotMatch(app.nodes.get('#image-generation-notice').outerHTML, /素材已保存/);
  app.module.bindImageGeneration(app.ctx);
  assert.equal(app.ctx.configs.image.prompt, '');
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 0);
});

test('new creation keeps accepted running tasks and unresolved submissions locked without cancelling either', async t => {
  await t.test('accepted running task', async child => {
    const uploadDraft = { id: crypto.randomUUID(), imageCount: 2, uploadedCount: 0, fingerprints: [], stage: 'uploading' };
    const task = { id: crypto.randomUUID(), status: 'running', prompt: '正在生成的套图', outputCount: 6, completedCount: 1, createdAt: new Date().toISOString(), images: [] };
    const app = await imagePage(child, { uploadDraft, tasks: [task] });
    assert.equal(app.module.handleImageGenerationAction('new', {}, app.ctx), true);
    assert.equal(app.module.resetImageCreation(app.ctx), false);
    assert.equal(JSON.parse(app.saved.get('store-ai-image-upload-draft')).id, uploadDraft.id);
    assert.match(app.module.renderImageTaskQueue(app.ctx), /正在生成 1 \/ 6/);
    assert.equal(app.calls.filter(call => call.method !== 'GET').length, 0);
  });
  await t.test('unresolved paid submission', async child => {
    const pendingId = crypto.randomUUID();
    const app = await imagePage(child, { pendingId });
    assert.equal(app.module.handleImageGenerationAction('new', {}, app.ctx), true);
    assert.equal(app.module.resetImageCreation(app.ctx), false);
    assert.equal(app.saved.get('store-ai-pending-image-request'), pendingId);
    assert.match(app.nodes.get('[data-action="generate"]').innerHTML, /提交状态待确认/);
    assert.equal(app.calls.filter(call => call.method !== 'GET').length, 0);
  });
});

test('image cards, task rows and preview alt use escaped business titles while keeping full prompts collapsed', async t => {
  const id = crypto.randomUUID();
  const prompt = '设计3:4竖版工厂宣传海报。深海军蓝与安全橙。\n主标题：<img src=x> 好工艺\n【制作约束】保留真实设备';
  const app = await imagePage(t, { tasks: [{ id, status: 'completed', generationMode: 'series', prompt, outputCount: 6, completedCount: 1, createdAt: new Date().toISOString(), images: [{ url: `/api/ai/media/${id}/result-1.png` }] }] });
  const queue = app.module.renderImageTaskQueue(app.ctx);
  const result = app.module.renderImageResults(app.ctx);
  const header = /<article class="image-result-card"[^]*?<\/header>/.exec(result)?.[0];
  assert.match(queue, /<strong>&lt;img src=x&gt; 好工艺<\/strong>/);
  assert.doesNotMatch(queue, /设计3:4|深海军蓝/);
  assert.match(header, /<strong>&lt;img src=x&gt; 好工艺<\/strong>/);
  assert.doesNotMatch(header, /设计3:4|深海军蓝/);
  assert.match(result, /alt="&lt;img src=x&gt; 好工艺 · 生成作品 1"/);
  assert.match(result, /<details class="image-result-prompt"><summary>查看创作要求<\/summary>/);
  assert.doesNotMatch(result, /<details[^>]*\bopen\b/);
  assert.doesNotMatch(result, /<img src=x>/);
});
