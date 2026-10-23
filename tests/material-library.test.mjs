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
    probe: async () => ({ duration: 5, width: 640, height: 640, audio: true }),
    voice: async (input, output) => { await writeFile(output, Buffer.concat([Buffer.from('wav:'), await readFile(input)])); return { duration: 4 }; },
    speech: { enabled: true, detect: async () => [{ start: 0.2 }] }, captions: { extract: async () => null },
    narration: null, lipsync: null, voiceConversion: null,
  });
  const materials = createMaterialHandler({ library, archiveExisting: userId => handler.archiveMaterials(userId),
    photo: async bytes => { if (bytes.toString() === 'invalid') throw Object.assign(new Error('图片格式无效。'), { status: 400 }); return Buffer.concat([Buffer.from('jpeg:'), bytes]); },
    voice: async (input, output) => { await writeFile(output, Buffer.concat([Buffer.from('wav:'), await readFile(input)])); return { duration: 4 }; },
    probe: async () => ({ duration: 5, width: 640, height: 640, audio: true }),
  });
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
  async function draft(owner = 'alice', options = {}) {
    const id = randomUUID();
    assert.equal((await request('/api/video-replica/tasks', { owner, method: 'POST', json: { requestId: id, voiceEngine: 'seedance', ...options } })).status, 201);
    return id;
  }
  return { library, request, draft, root, cos, advance: days => { now += days * 86400000; } };
}

test('standalone uploads persist before generation and all replica slots reuse owned assets without duplicate objects', async t => {
  const app = await workspace(t), saved = {};
  const video = Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypisom0000')]);
  for (const kind of ['photo', 'voice', 'video']) {
    const body = kind === 'video' ? video : Buffer.from(kind);
    const response = await app.request(`/api/assets/materials/${kind}`, { method: 'POST', body, headers: { 'X-File-Name': encodeURIComponent(`新素材-${kind}.mp4`) } });
    assert.equal(response.status, 201, await response.clone().text());
    saved[kind] = (await response.json()).material;
    assert.equal(saved[kind].permanent, true);
    assert.equal((await app.request(`/api/assets/materials/${kind}`, { method: 'POST', body })).status, 201);
    assert.equal((await app.request(saved[kind].url, { owner: 'bob' })).status, 404);
  }
  const materials = (await (await app.request('/api/assets/materials')).json()).materials;
  assert.equal(materials.length, 3);
  assert.equal(materials.find(item => item.kind === 'video').type, 'video');
  assert.equal((await app.request(saved.video.url, { headers: { Range: 'bytes=4-7' } })).status, 206);
  const id = await app.draft('alice', { mode: 'deep', replacements: { photo: true, voice: true, product: true, background: true } });
  const before = app.cos.writes.length;
  for (const kind of ['photo', 'product', 'background', 'voice', 'video']) {
    const asset = saved[['product', 'background'].includes(kind) ? 'photo' : kind];
    const response = await app.request(`/api/video-replica/tasks/${id}/${kind}`, { method: 'POST', json: { assetId: asset.id } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).task[kind].assetId, asset.id);
  }
  assert.equal(app.cos.writes.length, before, 'imported photos, sounds and videos are never re-encoded into duplicate assets');
  assert.equal((await app.request(`/api/video-replica/tasks/${id}/background`, { method: 'POST', json: { assetId: saved.voice.id } })).status, 400);
  await app.request(`/api/video-replica/tasks/${id}/options`, { method: 'POST', json: { replacements: { photo: false, voice: false, product: false, background: false } } });
  assert.equal((await app.library.list('alice')).length, 3, 'deselection does not delete shared assets');
});

test('direct deep task uploads also archive product images, backgrounds and reference videos', async t => {
  const app = await workspace(t);
  const id = await app.draft('alice', { mode: 'deep', replacements: { photo: false, voice: false, product: true, background: true } });
  for (const kind of ['product', 'background', 'video']) {
    const body = kind === 'video' ? Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypisom0000')]) : kind;
    const response = await app.request(`/api/video-replica/tasks/${id}/${kind}`, { method: 'PUT', body });
    assert.equal(response.status, 200, await response.clone().text());
    assert.ok((await response.json()).task[kind].assetId);
  }
  assert.equal((await app.library.list('alice')).length, 3);
});

test('standalone uploads reject unauthenticated, invalid, empty, oversized and failed cloud writes', async t => {
  const app = await workspace(t);
  assert.equal((await app.request('/api/assets/materials/photo', { method: 'POST', body: 'photo', owner: '' })).status, 401);
  for (const [kind, body] of [['photo', 'invalid'], ['video', 'not-video'], ['voice', '']]) {
    assert.equal((await app.request(`/api/assets/materials/${kind}`, { method: 'POST', body })).status, 400);
  }
  assert.equal((await app.request('/api/assets/materials/photo', { method: 'POST', body: Buffer.alloc(10 * 1024 * 1024 + 1) })).status, 413);
  app.cos.failIndex(true);
  assert.equal((await app.request('/api/assets/materials/photo', { method: 'POST', body: 'photo' })).status, 503);
  assert.deepEqual(await app.library.list('alice'), []);
  app.cos.failIndex(false);
  assert.equal((await app.request('/api/assets/materials/photo', { method: 'POST', body: 'photo' })).status, 201);
  assert.equal((await app.library.list('alice')).length, 1);
});

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

test('asset deletion survives backfill and restart, can be restored, and does not break referenced media', async t => {
  const app = await workspace(t, { legacy: true });
  const initial = await (await app.request('/api/assets/materials')).json();
  const item = initial.materials[0], key = `material:${item.id}`;
  const change = body => app.request('/api/assets/materials/organization', { method: 'POST', json: body });
  assert.equal((await change({ action: 'delete', keys: [key] })).status, 200);
  const deleted = await (await app.request('/api/assets/materials')).json();
  assert.ok(!deleted.materials.some(value => value.id === item.id));
  assert.ok(deleted.allMaterials.some(value => value.id === item.id));
  assert.equal((await app.request(item.url)).status, 200, 'task references continue to read the original');
  const restarted = createMaterialLibrary({ cosClient: app.cos });
  assert.ok(!(await restarted.list('alice')).some(value => value.id === item.id));
  assert.deepEqual((await restarted.organization('bob')).deleted, []);
  assert.equal((await app.request('/api/assets/materials/organization', { owner: 'bob', method: 'POST', json: { action: 'delete', keys: [key] } })).status, 404);
  assert.equal((await change({ action: 'restore', keys: [key] })).status, 200);
  assert.ok((await restarted.list('alice')).some(value => value.id === item.id));
});

test('relative sorting preserves surrounding assets, persists, and concurrent delete does not overwrite it', async t => {
  const app = await workspace(t), keys = [];
  for (const name of ['a', 'b', 'c', 'd']) {
    const r = await app.request('/api/assets/materials/voice', { method: 'POST', body: name });
    keys.push(`material:${(await r.json()).material.id}`);
  }
  const [a,b,c,d] = keys;
  const moved = await app.library.organize('alice', { action: 'move', keys: [d], target: c, position: 'before', order: keys });
  assert.deepEqual(moved.order, [a,b,d,c]);
  await Promise.all([
    app.library.organize('alice', { action: 'move', keys: [a], target: c, position: 'after', order: keys }),
    app.library.organize('alice', { action: 'delete', keys: [b] }),
  ]);
  assert.deepEqual((await app.library.organization('alice')).order, [b,d,c,a]);
  assert.deepEqual((await app.library.list('alice')).map(item => `material:${item.id}`), [d,c,a]);
  for (const input of [{action:'move',keys:[a],target:a,position:'before'}, {action:'delete',keys:['__proto__']}, {action:'restore',keys:[]}, {action:'move',keys:[a],target:b,position:'before',order:['../../other']}]) {
    assert.equal((await app.request('/api/assets/materials/organization', { method:'POST',json:input })).status, 400);
  }
  assert.equal((await app.request('/api/assets/materials/organization', {owner:'',method:'POST',json:{action:'delete',keys:[a]}})).status, 401);
});

test('cloud organization failure is not acknowledged as a saved edit', async t => {
  const app = await workspace(t), item = (await (await app.request('/api/assets/materials/photo', {method:'POST',body:'photo'})).json()).material;
  const original = app.cos.putObject;
  app.cos.putObject = (options, done) => options.Key.endsWith('/organization.json') ? done(new Error('outage')) : original(options, done);
  const response = await app.request('/api/assets/materials/organization', {method:'POST',json:{action:'delete',keys:[`material:${item.id}`]}});
  assert.equal(response.status, 503);
  assert.equal((await app.library.list('alice')).length, 1);
});
