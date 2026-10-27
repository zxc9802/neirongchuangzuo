import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createMaterialLibrary, createMaterialHandler } from '../services/assets/library.mjs';
import { createVideoHandler } from '../services/video/server.mjs';
import { assetFolders, materialFolder } from '../design/asset-organization.js';
import { generatedSource } from '../services/assets/retain.mjs';

test('material rename persists without changing content, folder, order or ownership', async t => {
  const app = await workspace(t);
  for (const kind of ['photo', 'voice', 'video']) {
    const path = join(app.root, `rename-${kind}`); await writeFile(path, `original-${kind}`);
    const item = await app.library.save('alice', { kind, path, name: '原素材', placement: { folderId: kind === 'photo' ? 'photos' : kind === 'voice' ? 'own-voice' : 'own-video' } });
    const organization = await app.library.organization('alice');
    const response = await app.request('/api/assets/materials/rename', { method: 'POST', json: { id: item.id, name: '  客户素材 2.0  ' } });
    assert.equal(response.status, 200);
    const renamed = (await response.json()).material;
    assert.equal(renamed.name, '客户素材 2.0');
    assert.equal(renamed.filename, `客户素材 2.0.${kind === 'photo' ? 'jpg' : kind === 'voice' ? 'wav' : 'mp4'}`);
    assert.equal(renamed.id, item.id); assert.equal(renamed.url, item.url); assert.equal(renamed.createdAt, item.createdAt);
    assert.deepEqual(await app.library.organization('alice'), organization);
    const restarted = createMaterialLibrary({ cosClient: app.cos });
    assert.equal((await restarted.get('alice', item.id)).bytes.toString(), `original-${kind}`);
    assert.equal((await restarted.get('alice', item.id)).name, renamed.name);
    await assert.rejects(restarted.rename('bob', { id: item.id, name: '改名' }), { status: 404 });
    for (const name of ['', '   ', '../名字', 'a'.repeat(81), 'bad\nname']) {
      assert.equal((await app.request('/api/assets/materials/rename', { method: 'POST', json: { id: item.id, name } })).status, 400);
    }
    app.cos.failIndex(true);
    assert.equal((await app.request('/api/assets/materials/rename', { method: 'POST', json: { id: item.id, name: '不应保存' } })).status, 503);
    app.cos.failIndex(false);
    assert.equal((await restarted.get('alice', item.id)).name, renamed.name);
  }
});

test('new uploads lead the library despite legacy ordering, including after restart and rename', async t => {
  const root = await temporary(t), cos = cloud(); let time = 1000;
  const library = createMaterialLibrary({ cosClient: cos, now: () => time++ }), items = [];
  for (const name of ['old', 'middle', 'new']) {
    const path = join(root, name); await writeFile(path, name);
    items.push(await library.save('alice', { kind: 'photo', path, name }));
  }
  const [old, middle, newest] = items, keys = items.map(item => `material:${item.id}`);
  await library.organize('alice', { action: 'move', keys: [keys[0]], target: keys[2], position: 'before', order: keys });
  const restarted = createMaterialLibrary({ cosClient: cos });
  await restarted.rename('alice', { id: old.id, name: 'renamed old' });
  assert.deepEqual((await restarted.list('alice')).map(item => item.id), [newest.id, middle.id, old.id]);
});

test('folders migrate existing assets, isolate owners, prevent cycles and keep content on deletion', async t => {
  const root = await temporary(t), path = join(root, 'photo'), cos = cloud(); await writeFile(path, 'folder-photo');
  const library = createMaterialLibrary({ cosClient: cos }), item = await library.save('alice', { kind: 'photo', path });
  assert.equal(assetFolders(await library.organization('alice')).length, 6);
  assert.equal(materialFolder(item, await library.organization('alice')), 'photos');
  let data = await library.folders('alice', { action: 'folder-create', type: 'image', name: '门店A', parentId: 'photos' });
  const folder = data.folders.find(item => item.name === '门店A');
  data = await library.folders('alice', { action: 'assign', ids: [item.id], type: 'image', folderId: folder.id });
  assert.equal(data.assignments[item.id], folder.id);
  await assert.rejects(library.folders('bob', { action: 'assign', ids: [item.id], type: 'image', folderId: 'photos' }), { status: 404 });
  await assert.rejects(library.folders('alice', { action: 'assign', ids: [item.id], type: 'audio', folderId: 'own-voice' }), { status: 400 });
  await assert.rejects(library.folders('alice', { action: 'folder-move', id: 'photos', parentId: folder.id }), /自身或下级/);
  await library.folders('alice', { action: 'folder-rename', id: folder.id, name: '客户门店' });
  await library.folders('alice', { action: 'folder-move', id: folder.id, parentId: null });
  await assert.rejects(library.folders('alice', { action: 'folder-create', type: 'image', name: '客户门店' }), /同名/);
  const restarted = createMaterialLibrary({ cosClient: cos });
  assert.equal((await restarted.organization('alice')).folders.find(item => item.id === folder.id).name, '客户门店');
  data = await restarted.folders('alice', { action: 'folder-delete', id: folder.id });
  assert.equal(data.assignments[item.id], null);
  assert.equal((await restarted.get('alice', item.id)).bytes.toString(), 'folder-photo');
  await restarted.folders('alice', { action: 'folder-delete', id: 'photos' });
  assert.ok(!assetFolders(await restarted.organization('alice')).some(item => item.id === 'photos'), 'deleted defaults never reappear');
  assert.equal(assetFolders(await restarted.organization('bob')).length, 6);
});

test('retaining a generated output preserves format and survives expiry, restart, retry and folder deletion', async t => {
  const root = await temporary(t), cos = cloud(), path = join(root, 'image.png'); await writeFile(path, 'original-png-bytes');
  const library = createMaterialLibrary({ cosClient: cos }), key = 'image:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:0';
  const args = { kind: 'photo', path, name: '成品.png', mime: 'image/png', metadata: { origin: 'generated' }, placement: { folderId: 'photos', sourceKey: key } };
  const item = await library.save('alice', args);
  assert.equal(item.mime, 'image/png'); assert.equal(item.filename, '成品.png');
  assert.equal((await library.organization('alice')).retained[key], item.id);
  await library.organize('alice', { action: 'delete', keys: [`material:${item.id}`] });
  await library.save('alice', args);
  assert.equal((await library.list('alice')).length, 1, 'retry restores and deduplicates');
  await library.folders('alice', { action: 'folder-delete', id: 'photos' });
  await rm(path);
  const restarted = createMaterialLibrary({ cosClient: cos, now: () => Date.now() + 10 * 86400000 });
  assert.equal((await restarted.get('alice', item.id)).bytes.toString(), 'original-png-bytes');
  assert.equal((await restarted.list('alice'))[0].permanent, true);
});

test('retain endpoint uses only authorized local output routes and never claims failed transfers succeeded', async t => {
  const cos = cloud(), library = createMaterialLibrary({ cosClient: cos });
  let expired = false;
  const handler = createMaterialHandler({ library });
  const outputUrl = '/api/ai/media/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/result-1.png';
  const server = createServer((req, res) => {
    req.authenticatedUserId = req.headers.cookie === 'user=alice' ? 'alice' : undefined;
    if (req.url === outputUrl) {
      res.writeHead(!req.authenticatedUserId ? 401 : expired ? 410 : 200, { 'Content-Type': 'image/png' }); res.end('source-png'); return;
    }
    void handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const retain = (overrides = {}, cookie = 'user=alice') => fetch(base + '/api/assets/materials/retain', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'image:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:0', url: outputUrl, name: '作品', folderId: 'photos', ...overrides }) });
  assert.equal((await retain({}, '')).status, 401);
  assert.equal((await retain({ url: 'https://external.invalid/private' })).status, 400);
  assert.equal((await retain({ folderId: 'own-voice' })).status, 400);
  assert.equal((await library.list('alice')).length, 0);
  expired = true; assert.equal((await retain()).status, 410); expired = false;
  cos.failIndex(true); assert.equal((await retain()).status, 503);
  cos.failIndex(false);
  const response = await retain(); assert.equal(response.status, 201, await response.clone().text());
  const data = await response.json();
  assert.equal(data.material.permanent, true); assert.equal(data.material.mime, 'image/png');
  expired = true;
  const media = await fetch(base + data.material.url, { headers: { Cookie: 'user=alice' } });
  assert.equal(media.status, 200); assert.equal(await media.text(), 'source-png');
  assert.equal((await fetch(base + data.material.url)).status, 401);
});

test('generated source allowlist covers outputs but rejects originals, paths and unrelated URLs', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  for (const [key, url, kind] of [
    [`creative-video:${id}`, `/api/video-creator/tasks/${id}/result`, 'video'],
    [`video:${id}`, `/api/video-replica/tasks/${id}/result`, 'video'],
    [`avatar:${id}:audio`, `/api/tasks/${id}/media/voice`, 'voice'],
    [`restaurant:${id}:01.jpg`, `/api/restaurant/tasks/${id}/files/01.jpg`, 'photo'],
  ]) assert.equal(generatedSource({key,url}).kind, kind);
  for (const url of ['/etc/passwd', '//external.invalid', `/api/ai/media/${id}/source.jpg`, `/api/ai/media/${id}/result-1.png?external=1`]) assert.throws(() => generatedSource({key:`image:${id}:0`,url}));
});

test('retained MP3 and PNG are normalized for replica use without overwriting permanent originals', async t => {
  const app = await workspace(t), audioPath = join(app.root, 'generated.mp3'), photoPath = join(app.root, 'generated.png');
  await writeFile(audioPath, 'original-mp3'); await writeFile(photoPath, 'original-png');
  const audio = await app.library.save('alice', { kind: 'voice', path: audioPath, mime: 'audio/mpeg', metadata: { origin: 'generated' }, placement: { folderId: 'imitated-voice' } });
  const photo = await app.library.save('alice', { kind: 'photo', path: photoPath, mime: 'image/png', metadata: { origin: 'generated' }, placement: { folderId: 'photos' } });
  const id = await app.draft();
  for (const [kind, asset] of [['voice', audio], ['photo', photo]]) {
    const response = await app.request(`/api/video-replica/tasks/${id}/${kind}`, { method: 'POST', json: { assetId: asset.id } });
    assert.equal(response.status, 200, await response.clone().text());
    if (kind === 'voice') assert.equal((await response.json()).task.voice.duration, 4);
  }
  assert.equal((await app.library.get('alice', audio.id)).bytes.toString(), 'original-mp3');
  assert.equal((await app.library.get('alice', photo.id)).bytes.toString(), 'original-png');
  const result = await app.request(`/api/video-replica/tasks/${id}/photo`);
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'jpeg:original-png');
});

test('full WAV library uploads are normalized when reused without shortening the stored original', async t => {
  const app = await workspace(t), path = join(app.root, 'full.wav');
  await writeFile(path, 'full-library-wav');
  const audio = await app.library.save('alice', { kind: 'voice', path, mime: 'audio/wav', metadata: { origin: 'library-upload', duration: 20 } });
  const id = await app.draft();
  const response = await app.request(`/api/video-replica/tasks/${id}/voice`, { method: 'POST', json: { assetId: audio.id } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).task.voice.duration, 4, 'the reference normalizer ran');
  assert.equal((await app.library.get('alice', audio.id)).bytes.toString(), 'full-library-wav');
  assert.equal((await app.library.get('alice', audio.id)).duration, 20);
});

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

async function workspace(t, { enabled = true, legacy = false, videoProbe } = {}) {
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
    probe: videoProbe || (async () => ({ duration: 5, width: 640, height: 640, audio: true })),
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

test('legacy order persists for compatibility but listing uses saved time; deletion remains isolated', async t => {
  const app = await workspace(t), keys = [];
  for (const name of ['a', 'b', 'c', 'd']) {
    app.advance(1);
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

function uploadWav(seconds = 20) {
  const bytes = Buffer.alloc(44 + seconds * 16000 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}

test('library uploads preserve full audio and image bytes, enforce folder types and reject fake files', async t => {
  const library = createMaterialLibrary({ cosClient: cloud() });
  const handler = createMaterialHandler({ library, voice: () => assert.fail('must not trim library audio') });
  const server = createServer((req, res) => { req.authenticatedUserId = req.headers.cookie === 'alice' ? 'alice' : undefined; void handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = (kind, body, folder, cookie = 'alice') => fetch(`${base}/api/assets/materials/upload/${kind}?folderId=${folder}`, { method:'POST', headers:{ Cookie:cookie,'X-File-Name':encodeURIComponent('测试素材') }, body });
  const wav = uploadWav();
  assert.equal((await upload('voice', wav, 'own-voice', '')).status, 401);
  assert.equal((await upload('voice', wav, 'photos')).status, 400);
  assert.equal((await library.list('alice')).length, 0);
  const response = await upload('voice', wav, 'own-voice');
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json(), saved = await library.get('alice', result.material.id);
  assert.equal(saved.duration, 20); assert.equal(saved.mime, 'audio/wav'); assert.deepEqual(saved.bytes, wav);
  assert.equal(saved.metadata.origin, 'library-upload'); assert.equal(result.organization.assignments[saved.id], 'own-voice');
  assert.equal((await upload('voice', wav, 'imitated-voice')).status, 201);
  assert.equal((await library.list('alice')).length, 1);
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create:{ width:32,height:32,channels:3,background:'red' } }).png().toBuffer();
  const imageResponse = await upload('photo', png, 'photos'); assert.equal(imageResponse.status, 201);
  const image = await imageResponse.json(); assert.equal(image.material.mime, 'image/png');
  assert.deepEqual((await library.get('alice', image.material.id)).bytes, png);
  assert.equal((await upload('photo', Buffer.from('not an image'), 'photos')).status, 400);
  assert.equal((await upload('voice', Buffer.from('not audio'), 'own-voice')).status, 400);
  assert.equal((await upload('video', png, 'own-video')).status, 400);
  assert.equal((await upload('photo', Buffer.alloc(50 * 1024 * 1024), 'photos')).status, 413);
  assert.equal((await library.list('alice')).length, 2);
});

test('media reads reuse the listed index, refresh after five seconds and see newly saved assets immediately', async t => {
  const root = await temporary(t), path = join(root, 'photo.jpg'), voice = join(root, 'voice.wav'), cos = cloud();
  await writeFile(path, 'photo'); await writeFile(voice, 'voice');
  const writer = createMaterialLibrary({ cosClient: cos });
  const photo = await writer.save('alice', { kind: 'photo', path });
  let clock = 1000, indexReads = 0;
  const getObject = cos.getObject;
  cos.getObject = (options, done) => { if (options.Key.endsWith('/index.json')) indexReads++; getObject(options, done); };
  const reader = createMaterialLibrary({ cosClient: cos, now: () => clock });
  await reader.list('alice');
  await Promise.all(Array.from({ length: 8 }, () => reader.get('alice', photo.id)));
  assert.equal(indexReads, 1, 'one list plus eight previews need only one cloud index read');
  clock += 5001;
  await Promise.all(Array.from({ length: 8 }, () => reader.get('alice', photo.id)));
  assert.equal(indexReads, 2, 'expired lookups share one in-flight cloud read');
  const saved = await reader.save('alice', { kind: 'voice', path: voice });
  const afterSave = indexReads;
  assert.equal((await reader.get('alice', saved.id)).bytes.toString(), 'voice');
  assert.equal(indexReads, afterSave, 'successful uploads replace the cached index immediately');
  await assert.rejects(reader.get('bob', photo.id), { status: 404 });
});

test('writes refresh a stale index and explicit listing discovers assets saved by another instance', async t => {
  const root = await temporary(t), path = join(root, 'photo.jpg'), cos = cloud();
  await writeFile(path, 'photo');
  const first = createMaterialLibrary({ cosClient: cos }), second = createMaterialLibrary({ cosClient: cos });
  assert.deepEqual(await first.list('alice'), []);
  const photo = await second.save('alice', { kind: 'photo', path });
  const voice = await first.save('alice', { kind: 'voice', path });
  const items = await second.list('alice');
  assert.deepEqual(new Set(items.map(item => item.id)), new Set([photo.id, voice.id]));
  assert.equal((await first.list('alice')).length, 2);
});

test('an older in-flight list cannot replace the index populated by a successful upload', async t => {
  const root = await temporary(t), path = join(root, 'photo.jpg'), cos = cloud();
  await writeFile(path, 'photo');
  const library = createMaterialLibrary({ cosClient: cos });
  await library.save('alice', { kind: 'photo', path });
  let finish, reads = 0;
  const getObject = cos.getObject;
  cos.getObject = (options, done) => {
    if (options.Key.endsWith('/index.json') && ++reads === 1) {
      const bytes = Buffer.from(cos.objects.get(options.Key));
      finish = () => done(null, { Body: bytes }); return;
    }
    getObject(options, done);
  };
  const oldList = library.list('alice');
  try {
    await new Promise(resolve => setImmediate(resolve));
    const saved = await library.save('alice', { kind: 'voice', path });
    finish(); await oldList;
    const count = reads;
    assert.equal((await library.get('alice', saved.id)).id, saved.id);
    assert.equal(reads, count);
  } finally { finish?.(); await oldList; }
});

test('opening saved assets does not queue behind a busy task whose photos are already archived', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const app = await workspace(t, { videoProbe: async () => { entered(); await gate; return { duration: 5, width: 640, height: 640, audio: true }; } });
  const id = await app.draft();
  assert.equal((await app.request(`/api/video-replica/tasks/${id}/photo`, { method: 'PUT', body: 'photo' })).status, 200);
  const uploading = app.request(`/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypisom0000')]) });
  let listing, timer;
  try {
    await Promise.race([started, uploading.then(response => { throw new Error(`upload finished before probe: ${response.status}`); })]);
    listing = app.request('/api/assets/materials');
    const result = await Promise.race([listing, new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); })]);
    assert.ok(result, 'asset listing must finish before the video processing lock is released');
    assert.equal((await result.json()).materials.length, 1);
  } finally { clearTimeout(timer); release(); await uploading; await listing; }
});

test('material thumbnails are small, cached per owner, revalidated and never replace the original', async t => {
  const app = await workspace(t), path = join(app.root, 'large.jpg');
  const original = await sharp({ create: { width: 2048, height: 1536, channels: 3, background: '#567890' } }).jpeg({ quality: 95 }).toBuffer();
  await writeFile(path, original);
  const item = await app.library.save('alice', { kind: 'photo', path });
  const url = item.url + '?thumbnail=1';
  const requests = [], getObject = app.cos.getObject;
  app.cos.getObject = (options, done) => { requests.push(options.Key); getObject(options, done); };
  const responses = await Promise.all(Array.from({ length: 4 }, () => app.request(url)));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    const bytes = Buffer.from(await response.arrayBuffer()), meta = await sharp(bytes).metadata();
    assert.equal(meta.width, 320); assert.equal(meta.height, 240);
    assert.ok(bytes.length < original.length / 4);
  }
  assert.equal(requests.filter(key => key.endsWith('.jpg')).length, 1, 'concurrent previews fetch the original only once');
  const etag = responses[0].headers.get('etag'); assert.ok(etag);
  assert.equal(responses[0].headers.get('cache-control'), 'private, no-cache');
  assert.equal(responses[0].headers.get('vary'), 'Cookie');
  const cached = await app.request(url, { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304); assert.equal((await cached.arrayBuffer()).byteLength, 0);
  assert.equal(requests.filter(key => key.endsWith('.jpg')).length, 1);
  assert.equal((await app.request(url, { owner: 'bob', headers: { 'If-None-Match': etag } })).status, 404);
  assert.equal((await app.request(url, { owner: '' })).status, 401);
  assert.deepEqual(Buffer.from(await (await app.request(item.url)).arrayBuffer()), original);
});
