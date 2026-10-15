import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createPreviewServer } from '../preview.mjs';
import { assertPersistentStorage, workspaceDataRoot } from '../services/runtime-paths.mjs';
import { loadWorkspaceSettings } from '../services/runtime-settings.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
const idleAI = () => Object.assign(async () => false, { ready: Promise.resolve(), shutdown: async () => {} });

test('restaurant routes use verified identity and never forward to the digital-human proxy', async t => {
  let restaurantStarts = 0, closed = false;
  const backend = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url !== '/api/session') { res.writeHead(418); res.end('{}'); return; }
    if (req.headers.cookie !== 'session=valid') { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify({ success: true, data: { authMode: 'standalone', user: { id: 'owner' } } }));
  });
  const preview = createPreviewServer({ backendUrl: await listen(backend), authRequired: true, createAI: idleAI,
    createRestaurant: () => {
      restaurantStarts++;
      return Object.assign(async (req, res) => { res.end(JSON.stringify({ user: req.authenticatedUserId })); return true; },
        { ready: Promise.resolve(), shutdown: async () => { closed = true; } });
    },
  });
  const base = await listen(preview);
  t.after(async () => { await preview.shutdown(); backend.closeAllConnections(); await new Promise(r => backend.close(r)); });
  assert.equal((await fetch(base + '/api/restaurant/profile', { headers: { 'x-user-id': 'owner' } })).status, 401);
  assert.equal(restaurantStarts, 0);
  const response = await fetch(base + '/api/restaurant/profile', { headers: { cookie: 'session=valid', 'x-user-id': 'forged' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: 'owner' });
  assert.equal(restaurantStarts, 1);
  await preview.shutdown();
  assert.equal(closed, true);
});

test('local restaurant development rejects spoofed remote Host and keeps model operations lazy', async t => {
  let starts = 0;
  const preview = createPreviewServer({ createAI: idleAI, createRestaurant: () => {
    starts++;
    return Object.assign(async (req, res) => { res.end(JSON.stringify({ user: req.authenticatedUserId })); return true; },
      { ready: Promise.resolve(), shutdown: async () => {} });
  } });
  const base = await listen(preview);
  t.after(() => preview.shutdown());
  assert.equal((await fetch(base + '/login')).status, 200);
  assert.equal(starts, 0);
  const spoofedStatus = await new Promise((resolve, reject) => {
    const req = request(base + '/api/restaurant/profile', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(spoofedStatus, 403);
  assert.equal(starts, 0);
  assert.deepEqual(await (await fetch(base + '/api/restaurant/profile')).json(), { user: 'local-dev' });
});

test('production persistence check accepts mounted data and rejects a container root filesystem', () => {
  const env = { NODE_ENV: 'production', WORKSPACE_DATA_DIR: '/app/.data' };
  assert.throws(() => assertPersistentStorage({ env, root: '/app', mountInfo: '1 1 0:1 / / rw - overlay overlay rw' }), /未挂载/);
  const mountInfo = ['1 1 0:1 / / rw - overlay overlay rw', '2 1 0:2 / /app/.data rw - ext4 data rw',
    '3 1 0:3 / /app/services/digital-human/.runtime rw - ext4 data rw'].join('\n');
  // Mount paths are checked as POSIX paths in Linux production.
  if (process.platform !== 'win32') assert.equal(assertPersistentStorage({ env, root: '/app', mountInfo }), '/app/.data');
  assert.ok(workspaceDataRoot({}).endsWith('.data'));
  assert.throws(() => workspaceDataRoot({ WORKSPACE_DATA_DIR: process.platform === 'win32' ? 'D:\\' : '/' }), /根目录/);
});

test('local restaurant configuration is restricted and production ignores developer files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'restaurant-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env.local'), 'RESTAURANT_PACKAGE_DAILY_LIMIT=12\nWORKSPACE_DATA_DIR=.local-data\nWORKSPACE_LOCAL_UNLIMITED_CREDITS=1\nCOS_BUCKET=test\nAUTH_DATABASE_URL=do-not-load\nPERSISTENT_STORAGE_CONFIRMED=1\n');
  const local = loadWorkspaceSettings({ root, env: { COS_BUCKET: 'env-wins' } });
  assert.equal(local.RESTAURANT_PACKAGE_DAILY_LIMIT, '12');
  assert.equal(local.WORKSPACE_LOCAL_UNLIMITED_CREDITS, '1');
  assert.equal(local.COS_BUCKET, 'env-wins');
  assert.equal(local.AUTH_DATABASE_URL, undefined);
  assert.equal(local.PERSISTENT_STORAGE_CONFIRMED, undefined);
  assert.deepEqual(loadWorkspaceSettings({ root, env: { NODE_ENV: 'production' } }), { NODE_ENV: 'production' });
});
