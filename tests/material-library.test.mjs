import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createMaterialLibrary, createMaterialHandler } from '../services/assets/library.mjs';
import { createVideoHandler } from '../services/video/server.mjs';

function cloud() {
  const objects = new Map(), writes = [];
  let failIndex = false;
  return { objects, writes, failIndex: value => { failIndex = value; },
    getObject({ Key }, done) { queueMicrotask(() => objects.has(Key) ? done(null, { Body: Buffer.from(objects.get(Key)) }) : done({ statusCode: 404 })); },
    putObject(options, done) {
      writes.push(options);
      queueMicrotask(() => {
        if (failIndex && options.Key.endsWith('/index.json')) return done(new Error('provider unavailable'));
        objects.set(options.Key, Buffer.from(options.Body)); done(null, { statusCode: 200 });
      });
    },
  };
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'qiya-materials-'));
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('COS materials are private, deduplicated per account and recoverable without local task files', async t => {
  const root = await temporary(t), cos = cloud(), library = createMaterialLibrary({ cosClient: cos, now: () => 100 });
  const photo = join(root, 'photo.jpg'), voice = join(root, 'voice.wav');
  await writeFile(photo, 'photo-content'); await writeFile(voice, 'voice-content');
  const result = await Promise.all(Array.from({ length: 5 }, () => library.save('alice', { kind: 'photo', path: photo, name: '我的形象.jpg' })));
  assert.equal(new Set(result.map(item => item.id)).size, 1);
  assert.equal(cos.writes.length, 2, 'one media object and one index write');
  await Promise.all([library.save('alice', { kind: 'voice', path: voice, metadata: { duration: 4, speechStart: 0.1 } }),
    library.save('bob', { kind: 'photo', path: photo })]);
  assert.equal((await library.list('alice')).length, 2);
  assert.equal((await library.list('bob')).length, 1);
  assert.deepEqual(await library.list('stranger'), []);
  assert.ok(cos.writes.every(item => item.ACL === 'private' && item.Key.startsWith('workspace-assets/users/')));
  assert.ok(cos.writes.every(item => !item.Key.includes('alice') && !item.Key.includes('jobs/')));
  const voiceItem = (await library.list('alice')).find(item => item.kind === 'voice');
  await assert.rejects(library.get('bob', voiceItem.id), { status: 404 });
  for (const id of ['../index.json', result[0].id + '/../../', 'voice-bad']) await assert.rejects(library.get('alice', id), { status: 404 });
  const restarted = createMaterialLibrary({ cosClient: cos, now: () => 100 + 365 * 86400000 });
  const restored = await restarted.get('alice', voiceItem.id);
  assert.equal(restored.bytes.toString(), 'voice-content'); assert.equal(restored.metadata.duration, 4);
  assert.equal(restored.permanent, true); assert.equal(restored.expiresAt, undefined);
});

test('a failed cloud index is not reported as saved and retry repairs it without duplicates', async t => {
  const root = await temporary(t), path = join(root, 'photo.jpg'), cos = cloud();
  await writeFile(path, 'content');
  const library = createMaterialLibrary({ cosClient: cos });
  cos.failIndex(true);
  await assert.rejects(library.save('alice', { kind: 'photo', path }), /云存储暂时不可用/);
  assert.deepEqual(await library.list('alice'), []);
  cos.failIndex(false);
  await library.save('alice', { kind: 'photo', path });
  await library.save('alice', { kind: 'photo', path });
  assert.equal((await library.list('alice')).length, 1);
  await assert.rejects(createMaterialLibrary({ env: {} }).save('alice', { kind: 'photo', path }), /尚未配置/);
});

async function workspace(t, { enabled = true, legacy = false } = {}) {
  const root = await temporary(t), cos = cloud(); let now = Date.now();
  const library = createMaterialLibrary(enabled ? { cosClient: cos, now: () => now } : { env: {} });
  if (legacy) {
    const id = randomUUID(), folder = join(root, 'video', id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'photo.jpg'), 'old-photo');
    await writeFile(join(folder, 'reference.wav'), 'old-voice');
    await writeFile(join(folder, 'task.json'), JSON.stringify({ id, userId: 'alice', status: 'draft', createdAt: now, expiresAt: now + 86400000,
      photo: { ready: true }, voice: { duration: 4, speechStart: 0.1 }, materials: {} }));
  }
  const handler = createVideoHandler({ storageDir: join(root, 'video'), materialLibrary: library, now: () => now, pollIntervalMs: 20,
    config: { enabled: true, publicOrigin: 'https://workspace.example', signingSecret: 'test-only' },
    photo: async bytes => Buffer.concat([Buffer.from('jpeg:'), bytes]),
    voice: async (input, output) => { await writeFile(output, Buffer.concat([Buffer.from('wav:'), await readFile(input)])); return { duration: 4 }; },
    speech: { enabled: true, detect: async () => [{ start: 0.2 }] }, captions: { extract: async () => null },
    narration: null, lipsync: null, voiceConversion: null,
  });
  const materials = createMaterialHandler({ library, archiveExisting: userId => handler.archiveMaterials(userId) });
  await handler.ready;
  const server = createServer((req, res) => {
    req.authenticatedUserId = req.headers['x-owner'] || undefined;
    void (req.url.startsWith('/api/assets/') ? materials : handler)(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await handler.shutdown(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { owner = 'alice', method = 'GET', json, body, headers } = {}) => fetch(base + path, {
    method, headers: { ...(owner ? { 'X-Owner': owner } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  async function draft(owner = 'alice') {
    const id = randomUUID();
    assert.equal((await request('/api/video-replica/tasks', { owner, method: 'POST', json: { requestId: id, voiceEngine: 'seedance' } })).status, 201);
    return id;
  }
  return { library, request, draft, root, advance: days => { now += days * 86400000; } };
}

test('replica uploads archive originals, imports verify ownership and expired tasks leave reusable media intact', async t => {
  const app = await workspace(t), id = await app.draft();
  for (const kind of ['photo', 'voice']) {
    const response = await app.request(`/api/video-replica/tasks/${id}/${kind}`, { method: 'PUT', body: kind, headers: { 'X-File-Name': encodeURIComponent('我的素材.' + (kind === 'photo' ? 'png' : 'mp3')) } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.ok((await response.json()).task[kind].assetId);
  }
  const records = await app.library.list('alice'); assert.equal(records.length, 2);
  const photo = records.find(item => item.kind === 'photo'), voice = records.find(item => item.kind === 'voice');
  assert.equal((await app.request(photo.url, { owner: '' })).status, 401);
  assert.equal((await app.request(photo.url, { owner: 'bob' })).status, 404);
  const media = await app.request(voice.url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(media.status, 206); assert.equal(await media.text(), 'wav:');
  assert.equal((await app.request(voice.url, { headers: { Range: 'bytes=100-' } })).status, 416);
  const other = await app.draft('bob');
  assert.equal((await app.request(`/api/video-replica/tasks/${other}/photo`, { owner: 'bob', method: 'POST', json: { assetId: photo.id } })).status, 404);
  const next = await app.draft();
  assert.equal((await app.request(`/api/video-replica/tasks/${next}/photo`, { method: 'POST', json: { assetId: voice.id } })).status, 400);
  for (const item of records) {
    assert.equal((await app.request(`/api/video-replica/tasks/${next}/${item.kind}`, { method: 'POST', json: { assetId: item.id } })).status, 200);
  }
  assert.equal((await app.library.list('alice')).length, 2, 'import never re-encodes or duplicates a saved original');
  assert.equal((await readFile(join(app.root, 'video', next, 'photo.jpg'))).toString(), 'jpeg:photo');
  app.advance(4);
  for (let tries = 0; tries < 100; tries++) {
    const task = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
    if (task.cleaned) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await assert.rejects(readFile(join(app.root, 'video', id, 'photo.jpg')), { code: 'ENOENT' });
  assert.equal(await (await app.request(photo.url)).text(), 'jpeg:photo');
  assert.equal((await (await app.request('/api/assets/materials')).json()).materials.length, 2);
  const afterExpiry = await app.draft();
  assert.equal((await app.request(`/api/video-replica/tasks/${afterExpiry}/voice`, { method: 'POST', json: { assetId: voice.id } })).status, 200);
});

test('missing COS configuration rejects a permanent save instead of claiming success', async t => {
  const app = await workspace(t, { enabled: false }), id = await app.draft();
  const response = await app.request(`/api/video-replica/tasks/${id}/photo`, { method: 'PUT', body: 'photo' });
  assert.equal(response.status, 503); assert.match((await response.json()).error, /COS/);
  assert.equal((await (await app.request(`/api/video-replica/tasks/${id}`)).json()).task.photo, undefined);
});

test('opening assets backfills existing source files only for the authenticated owner', async t => {
  const app = await workspace(t, { legacy: true });
  assert.deepEqual((await (await app.request('/api/assets/materials', { owner: 'bob' })).json()).materials, []);
  assert.deepEqual(await app.library.list('alice'), []);
  const records = (await (await app.request('/api/assets/materials')).json()).materials;
  assert.equal(records.length, 2);
  assert.equal(await (await app.request(records.find(item => item.kind === 'photo').url)).text(), 'old-photo');
  assert.equal((await (await app.request('/api/assets/materials')).json()).materials.length, 2);
});
