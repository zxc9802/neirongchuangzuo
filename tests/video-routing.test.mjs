import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPreviewServer } from '../preview.mjs';
import { createVideoProvider, VideoError } from '../services/video/provider.mjs';
import { collectGeneratedAssets } from '../design/generated-assets.js';

test('video routes use verified workspace accounts and preserve the narrow signed source endpoint', async t => {
  const backend = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.cookie !== 'digital_human_session=valid') { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify({ success: true, data: { authMode: 'standalone', user: { id: 'verified-alice', account: 'alice@example.test', nickname: 'Alice' } } }));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  let shutdown = false;
  const stub = async (req, res) => { res.end(JSON.stringify({ userId: req.authenticatedUserId || null })); return true; };
  stub.shutdown = async () => { shutdown = true; };
  const app = createPreviewServer({ backendUrl: `http://127.0.0.1:${backend.address().port}`, authRequired: true,
    createAI: () => stub, createVideo: () => stub, credits: { ready: Promise.resolve() } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await app.shutdown(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); });
  const base = `http://127.0.0.1:${app.address().port}`;
  for (const path of ['/api/video-replica/tasks', '/api/video-replica/config', '/api/video-replica/tasks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/result']) {
    assert.equal((await fetch(base + path, { headers: { 'x-user-id': 'forged' } })).status, 401);
  }
  const response = await fetch(base + '/api/video-replica/tasks', { headers: { cookie: 'digital_human_session=valid', 'x-user-id': 'forged' } });
  assert.deepEqual(await response.json(), { userId: 'verified-alice' });
  const source = await fetch(base + '/api/video-replica/source/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/video');
  assert.deepEqual(await source.json(), { userId: null }); // Only the video handler can verify this signature.
  assert.equal((await fetch(base + '/api/video-replica/source/anything')).status, 401);
  await app.shutdown(); assert.equal(shutdown, true);
});

test('supplier whitelist rejection is actionable without leaking provider response details', async () => {
  const provider = createVideoProvider({ material: { base: 'https://supplier.example', project: 'project', access: 'access', secret: 'secret' } },
    async () => Response.json({ success: false, msg: '访问被拒绝：IP 不在项目的白名单中 sensitive-debug-value' }));
  await assert.rejects(provider.createMaterial('https://app.example/signed', 'photo'), cause => cause instanceof VideoError && cause.code === 'VIDEO_PROVIDER_IP_DENIED' && !cause.message.includes('sensitive-debug-value'));
});

test('asset library includes only retained and settled person-replica results', () => {
  const now = Date.now(), id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const good = { id, status: 'completed', completedAt: now - 1000, expiresAt: now + 60000, resultUrl: `/api/video-replica/tasks/${id}/result`, billing: { status: 'settled' } };
  const variants = [good, { ...good, status: 'running' }, { ...good, billing: { status: 'reserved' } }, { ...good, expiresAt: now - 1 }, { ...good, resultUrl: 'https://untrusted.example/video.mp4' }];
  const records = collectGeneratedAssets([], [], now, [], variants);
  assert.equal(records.length, 1); assert.equal(records[0].source, '人物复刻'); assert.equal(records[0].type, 'video');
  assert.equal(records[0].download, good.resultUrl + '?download=1');
});
