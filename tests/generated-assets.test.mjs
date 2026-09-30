import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGeneratedAssets, generatedAssetWindow, renderGeneratedAssets } from '../design/generated-assets.js';

const now = Date.parse('2026-09-30T06:00:00Z');
const hour = 3600000;
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const image = (overrides = {}) => ({ id, status: 'completed', createdAt: new Date(now - 74 * hour).toISOString(), completedAt: new Date(now - hour).toISOString(), images: [{ url: `/api/ai/media/${id}/result-1.png`, filename: 'result-1.png' }], prompt: '设计宣传海报\n主标题：真实工艺，看细节\n要点：打样流程', ...overrides });

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

test('the assets entry presents retention and generated type filters without an upload flow', () => {
  const ctx = { esc: value => String(value), icon: () => '', button: (action, label) => `<button data-action="${action}">${label}</button>` };
  const html = renderGeneratedAssets(ctx);
  assert.match(html, /72 小时/);
  assert.match(html, /到期自动清理/);
  assert.match(html, /成品类型/);
  assert.doesNotMatch(html, /type="file"|确认选择|本地上传/);
});
