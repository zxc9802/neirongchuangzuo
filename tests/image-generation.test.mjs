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
    calls.push({ url, method: options.method || 'GET' });
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
