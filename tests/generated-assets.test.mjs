import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGeneratedAssets, generatedAssetWindow, renderGeneratedAssets, bindGeneratedAssets, disposeGeneratedAssets } from '../design/generated-assets.js';

const now = Date.parse('2026-09-30T06:00:00Z');
const hour = 3600000;
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const image = (overrides = {}) => ({ id, status: 'completed', createdAt: new Date(now - 74 * hour).toISOString(), completedAt: new Date(now - hour).toISOString(), images: [{ url: `/api/ai/media/${id}/result-1.png`, filename: 'result-1.png' }], prompt: '设计宣传海报\n主标题：真实工艺，看细节\n要点：打样流程', ...overrides });
const restaurant = (overrides = {}) => ({ id, status: 'completed', completedAt: now - hour, copy: { titles: ['附近午餐来吃一碗面'] }, files: [{ role: 'image', filename: '01.jpg', url: `/api/restaurant/tasks/${id}/files/01.jpg`, expiresAt: now + 2 * hour }, { role: 'zip', filename: 'package.zip', url: `/api/restaurant/tasks/${id}/files/package.zip`, expiresAt: now + 2 * hour }], sourceImages: [{ filename: 'original-1.jpg', url: `/api/restaurant/tasks/${id}/files/original-1.jpg` }], ...overrides });

test('all fifteen generated pictures enter assets while out-of-range names and originals remain excluded', () => {
  const images = Array.from({ length: 16 }, (_, index) => ({ url: `/api/ai/media/${id}/result-${index + 1}.png`, filename: `result-${index + 1}.png` }));
  images.push({ url: `/api/ai/media/${id}/source-01.jpg`, filename: 'source-01.jpg' });
  assert.equal(collectGeneratedAssets([image({ images })], [], now).length, 15);
  const files = Array.from({ length: 16 }, (_, index) => { const filename = `${String(index + 1).padStart(2, '0')}.jpg`; return { role: 'image', filename, url: `/api/restaurant/tasks/${id}/files/${filename}`, expiresAt: now + hour }; });
  const records = collectGeneratedAssets([], [], now, [restaurant({ files })]);
  assert.equal(records.length, 15); assert.ok(records.some(item => item.filename === '15.jpg'));
  assert.ok(!records.some(item => item.filename === '16.jpg'));
});

test('asset retention starts when generation completes and ends exactly at 72 hours', () => {
  assert.ok(generatedAssetWindow(image(), now));
  assert.equal(generatedAssetWindow(image({ completedAt: now - 72 * hour }), now), null);
  assert.ok(generatedAssetWindow(image({ completedAt: now - 72 * hour + 1 }), now));
  assert.equal(generatedAssetWindow(image({ completedAt: now + 1 }), now), null);
  assert.equal(generatedAssetWindow(image({ completedAt: 'invalid' }), now), null);
  assert.equal(generatedAssetWindow(image({ expiresAt: now }), now), null);
  assert.equal(generatedAssetWindow(image({ completedAt: now - 73 * hour, expiresAt: now + hour }), now), null);
});

test('only completed generated images enter assets, excluding original uploads, examples and expired results', () => {
  const records = collectGeneratedAssets([
    image(), image({ status: 'running' }), image({ status: 'failed' }), image({ status: 'expired' }),
    image({ completedAt: now - 73 * hour }),
    image({ images: [{ url: '/media/ai-industrial-poster.png' }, { url: 'blob:original' }, { url: 'https://outside.example/result.png' }] }),
    image({ images: [{ url: '/api/ai/media/another/result-1.png' }] }),
  ], [], now);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, '真实工艺，看细节');
  assert.equal(records[0].type, 'image');
  assert.equal(records[0].download, `/api/ai/media/${id}/result-1.png?download=1`);
});

test('digital assets include only settled final video and generated voice, never source media', () => {
  const task = { id: 'avatar-task', status: 'completed', createdAt: now - 2 * hour, completedAt: now - hour, inputs: { scriptText: '介绍真实加工过程' }, results: { finalVideoUrl: '/api/tasks/avatar-task/media/final', exactAudioUrl: '/api/tasks/avatar-task/media/voice', originalVideoUrl: '/api/tasks/avatar-task/media/original', audioFormat: 'mp3' } };
  const records = collectGeneratedAssets([], [task], now);
  assert.deepEqual(records.map(item => item.type), ['video', 'audio']);
  assert.equal(records[0].download, '/api/tasks/avatar-task/download/final.mp4');
  assert.equal(records[1].download, '/api/tasks/avatar-task/download/voice-track.mp3');
  for (const source of ['https://outside.example/result.mp4', '//outside.example/result.mp4', '/api/tasks/other/media/final']) {
    assert.equal(collectGeneratedAssets([], [{ ...task, results: { finalVideoUrl: source } }], now).length, 0);
  }
  assert.equal(collectGeneratedAssets([], [{ ...task, billing: { isExternalUser: true, status: 'pending' } }], now).length, 0);
  assert.equal(collectGeneratedAssets([], [{ ...task, expired: true }], now).length, 0);
});

test('server expiry caps lifetime and mixed outputs are sorted by completion rather than submission', () => {
  const records = collectGeneratedAssets([image({ expiresAt: now + 2 * hour }), image({ id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', completedAt: now - 2 * hour, images: [{ url: '/api/ai/media/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee/result-1.png' }] })], [], now);
  assert.equal(records[0].expires, now + 2 * hour);
  assert.ok(records[0].completed > records[1].completed);
  assert.equal(collectGeneratedAssets([image(), image()], [], now).length, 1);
});

test('restaurant assets include only completed unexpired processed photos, never originals or ZIP files', () => {
  const records = collectGeneratedAssets([], [], now, [restaurant(), restaurant({ status: 'awaiting_confirmation' }), restaurant({ status: 'failed' }), restaurant({ filesExpired: true }), restaurant({ review: { status: 'blocked' } }), restaurant({ completedAt: now - 73 * hour })]);
  assert.equal(records.length, 1);
  assert.equal(records[0].source, '餐饮小红书');
  assert.equal(records[0].title, '附近午餐来吃一碗面');
  assert.equal(records[0].download, `/api/restaurant/tasks/${id}/files/01.jpg`);
  assert.equal(records[0].expires, now + 2 * hour);
  assert.equal(records[0].filename, '01.jpg');
  assert.equal(collectGeneratedAssets([], [], now, [restaurant(), restaurant()]).length, 1);
});

test('restaurant file expiry and task identity are independently enforced at the three-day boundary', () => {
  const good = restaurant().files[0];
  const badFiles = [
    { ...good, expired: true }, { ...good, expiresAt: now }, { ...good, expiresAt: 'invalid' },
    { ...good, role: 'original' }, { ...good, filename: 'original-1.jpg', url: `/api/restaurant/tasks/${id}/files/original-1.jpg` },
    { ...good, url: 'https://outside.example' + good.url }, { ...good, url: '//outside.example' + good.url },
    { ...good, url: good.url + '?download=1' }, { ...good, url: good.url + '#x' },
    { ...good, url: '/api/restaurant/tasks/aaaaaaaa-bbbb-cccc-dddd-ffffffffffff/files/01.jpg' },
    { ...good, filename: '02.jpg' }, { ...good, url: good.url.replace('files/', 'files/../files/') },
  ];
  for (const file of badFiles) assert.equal(collectGeneratedAssets([], [], now, [restaurant({ files: [file] })]).length, 0);
  assert.equal(collectGeneratedAssets([], [], now, [restaurant({ completedAt: now - 72 * hour, files: [{ ...good, expiresAt: now + hour }] })]).length, 0);
  const capped = collectGeneratedAssets([], [], now, [restaurant({ completedAt: now - 71 * hour, files: [{ ...good, expiresAt: now + 10 * hour }] })]);
  assert.equal(capped[0].expires, now + hour);
});

test('asset loading paginates restaurant metadata without paid calls and keeps existing source error handling', async () => {
  const original = Object.fromEntries(['document', 'fetch'].map(key => [key, globalThis[key]]));
  let markup = '';
  const calls = [];
  const host = { set innerHTML(value) { markup = value; } };
  globalThis.document = { body: { dataset: { page: 'assets' } }, querySelector: selector => selector === '#generated-assets-results' ? host : null };
  const current = Date.now();
  const pageTask = (taskId, title) => restaurant({ id: taskId, completedAt: current - 1000, copy: { titles: [title] }, files: [{ role: 'image', filename: '01.jpg', url: `/api/restaurant/tasks/${taskId}/files/01.jpg`, expiresAt: current + hour }] });
  globalThis.fetch = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET' });
    if (path.startsWith('/api/ai/images')) return Response.json({ tasks: [image({ completedAt: current - 2000, expiresAt: current + hour })] });
    if (path.startsWith('/api/tasks?')) return Response.json({}, { status: 503 });
    if (path.startsWith('/api/restaurant/tasks?')) {
      const query = new URL(path, 'http://localhost').searchParams;
      assert.equal(query.get('limit'), '50'); assert.equal(query.get('completed'), 'true');
      assert.ok(Number(query.get('completedAfter')) <= current);
      if (!query.get('cursor')) return Response.json({ tasks: [pageTask(id, '餐饮第一页')], nextCursor: 'older-cursor' });
      assert.equal(query.get('cursor'), 'older-cursor');
      return Response.json({ tasks: [pageTask('aaaaaaaa-bbbb-cccc-dddd-ffffffffffff', '餐饮第二页')], nextCursor: null });
    }
    throw new Error('Unexpected request');
  };
  const ctx = { mode: 'assets', esc: value => String(value), icon: () => '', button: (action, label) => `<button data-action="${action}">${label}</button>` };
  try {
    bindGeneratedAssets(ctx);
    for (let count = 0; count < 50 && !markup.includes('餐饮第二页'); count++) await new Promise(resolve => setImmediate(resolve));
    assert.match(markup, /餐饮第一页/); assert.match(markup, /餐饮第二页/);
    assert.match(markup, /真实工艺，看细节/);
    assert.match(markup, /数字人作品暂时无法加载/);
    assert.equal(calls.filter(call => call.path.startsWith('/api/restaurant/')).length, 2);
    assert.ok(calls.every(call => call.method === 'GET'));
    assert.ok(!calls.some(call => /generate|\/status|\/profile|\/usage/.test(call.path)));
    assert.ok(!markup.includes(`/api/restaurant/tasks/${id}/files/01.jpg?download=1`));
  } finally {
    disposeGeneratedAssets();
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

test('the assets entry presents retention and generated type filters without an upload flow', () => {
  const ctx = { esc: value => String(value), icon: () => '', button: (action, label) => `<button data-action="${action}">${label}</button>` };
  const html = renderGeneratedAssets(ctx);
  assert.match(html, /保留 <strong>3 天<\/strong>，请及时下载/);
  assert.match(html, /及时下载/);
  assert.match(html, /成品类型/);
  assert.doesNotMatch(html, /type="file"|确认选择|本地上传/);
});
test('image assets use the same business title or generation-mode fallback as the work page', () => {
  assert.equal(collectGeneratedAssets([image({ prompt: '设计3:4工厂海报\n主标题：真实样件，看细节' })], [], now)[0].title, '真实样件，看细节');
  assert.equal(collectGeneratedAssets([image({ prompt: '内部排版与制作约束', generationMode: 'series' })], [], now)[0].title, '统一风格套图');
});
