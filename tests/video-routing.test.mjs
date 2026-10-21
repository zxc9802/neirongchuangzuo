import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPreviewServer } from '../preview.mjs';
import { createVideoProvider, VideoError } from '../services/video/provider.mjs';
import { collectGeneratedAssets } from '../design/generated-assets.js';

test('fal-only production starts saved replica processing before the first page visit', async t => {
  const names = ['NODE_ENV', 'FAL_KEY', 'TEMP_ASSET_SIGNING_SECRET', 'VIDEO_ACCESS_KEY', 'VIDEO_SECRET_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let app;
  try {
    process.env.NODE_ENV = 'production'; process.env.FAL_KEY = 'test-only';
    process.env.TEMP_ASSET_SIGNING_SECRET = 'test-signing-secret';
    process.env.VIDEO_ACCESS_KEY = ''; process.env.VIDEO_SECRET_KEY = '';
    let starts = 0;
    const stub = Object.assign(async () => false, { ready: Promise.resolve(), shutdown: async () => {} });
    app = createPreviewServer({ publicOrigin: 'https://studio.example', createAI: () => stub,
      createVideo: () => { starts++; return stub; } });
    await app.ready;
    assert.equal(starts, 1);
  } finally {
    await app?.shutdown();
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
});

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
    createAI: () => stub, createVideo: () => stub, createVideoCreator: () => stub, credits: { ready: Promise.resolve() },
    materialLibrary: { configured: true, list: async userId => [{ owner: userId }] } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await app.shutdown(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); });
  const base = `http://127.0.0.1:${app.address().port}`;
  for (const path of ['/api/video-replica/tasks', '/api/video-replica/config', '/api/video-replica/tasks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/result', '/api/video-creator/config', '/api/video-creator/conversations', '/api/video-creator/tasks', '/api/assets/materials', `/api/assets/materials/photo-${'a'.repeat(64)}/media`]) {
    assert.equal((await fetch(base + path, { headers: { 'x-user-id': 'forged' } })).status, 401);
  }
  const response = await fetch(base + '/api/video-replica/tasks', { headers: { cookie: 'digital_human_session=valid', 'x-user-id': 'forged' } });
  assert.deepEqual(await response.json(), { userId: 'verified-alice' });
  const materials = await fetch(base + '/api/assets/materials', { headers: { cookie: 'digital_human_session=valid', 'x-user-id': 'forged' } });
  assert.deepEqual(await materials.json(), { materials: [{ owner: 'verified-alice' }], configured: true });
  const pricingModule = await fetch(base + '/malaysian-prices.js');
  assert.equal(pricingModule.status, 200);
  assert.match(pricingModule.headers.get('content-type'), /javascript/);
  assert.match(await pricingModule.text(), /export const GENERATION_PRICES/);
  assert.deepEqual(await (await fetch(base + '/api/video-creator/tasks', { headers: { cookie: 'digital_human_session=valid', 'x-user-id': 'forged' } })).json(), { userId: 'verified-alice' });
  const source = await fetch(base + '/api/video-replica/source/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/video');
  assert.deepEqual(await source.json(), { userId: null }); // Only the video handler can verify this signature.
  assert.equal((await fetch(base + '/api/video-replica/source/anything')).status, 401);
  assert.deepEqual(await (await fetch(base + '/api/video-creator/source/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee')).json(), { userId: null });
  assert.equal((await fetch(base + '/api/video-creator/source/anything')).status, 401);
  await app.shutdown(); assert.equal(shutdown, true);
});

test('supplier whitelist rejection is actionable without leaking provider response details', async () => {
  const provider = createVideoProvider({ material: { base: 'https://supplier.example', project: 'project', access: 'access', secret: 'secret' } },
    async () => Response.json({ success: false, msg: '访问被拒绝：IP 不在项目的白名单中 sensitive-debug-value' }));
  await assert.rejects(provider.createMaterial('https://app.example/signed', 'photo'), cause => cause instanceof VideoError && cause.code === 'VIDEO_PROVIDER_IP_DENIED' && !cause.message.includes('sensitive-debug-value'));
});

test('a supplier gateway failure cannot be treated as proof that a paid submission was rejected', async () => {
  const provider = createVideoProvider({ video: { base: 'https://supplier.example', project: 'project', access: 'access', secret: 'secret' } },
    async () => Response.json({success: false, msg: 'upstream timeout'}, {status: 502}));
  await assert.rejects(provider.generate({materials: {photo: {id: 'photo'}, video: {id: 'video'}}}), {code: 'VIDEO_PROVIDER_UNAVAILABLE'});
});

test('asset library includes only retained and settled person-replica results', () => {
  const now = Date.now(), id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const good = { id, status: 'completed', completedAt: now - 1000, expiresAt: now + 60000, resultUrl: `/api/video-replica/tasks/${id}/result`, billing: { status: 'settled' } };
  const variants = [good, { ...good, status: 'running' }, { ...good, billing: { status: 'reserved' } }, { ...good, expiresAt: now - 1 }, { ...good, resultUrl: 'https://untrusted.example/video.mp4' }];
  const records = collectGeneratedAssets([], [], now, [], variants);
  assert.equal(records.length, 1); assert.equal(records[0].source, '人物复刻'); assert.equal(records[0].type, 'video');
  assert.equal(records[0].download, good.resultUrl + '?download=1');
});
