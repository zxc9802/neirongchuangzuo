import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, writeFile, symlink, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAIHandler } from '../services/ai/server.mjs';
import { createImageUploads } from '../services/ai/image-uploads.mjs';
import { imagePlan, selectImageReferences } from '../services/ai/image-sets.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ6kAAAAASUVORK5CYII=', 'base64');
const IMAGE = { name: '真实原图.png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` };
const SOURCE = { bytes: PNG, mime: 'image/png', ext: 'png' };
const CONFIG = { apiKey: 'mock-only', chatModel: 'test-chat', imageModel: 'test-image', baseUrl: 'https://mock.invalid/v1', limits: { imageDaily: 20, chatDaily: 100, perMinute: 10 } };
const output = () => Response.json({ data: [{ b64_json: PNG.toString('base64') }] });
const requestBody = overrides => ({ requestId: randomUUID(), prompt: '以真实照片制作同一主题的宣传图。', ratio: '3:4', quality: 'auto', ...overrides });

async function fixture(t) {
  const parent = resolve(tmpdir()), storageDir = await mkdtemp(join(parent, 'ai-upload-contract-')), closers = [];
  t.after(async () => {
    for (const close of closers) await close();
    assert.equal(dirname(resolve(storageDir)), parent); assert.ok(resolve(storageDir).startsWith(join(parent, 'ai-upload-contract-')));
    await rm(storageDir, { recursive: true, force: true });
  });
  async function server(options = {}) {
    const handler = createAIHandler({ storageDir, config: CONFIG, logger: { warn() {} }, fetchImpl: async () => { throw new Error('Unexpected provider call'); }, ...options });
    await handler.ready;
    const http = createServer((req, res) => { req.authenticatedUserId = req.headers['x-test-user'] || 'merchant-a'; void handler(req, res); });
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const base = `http://127.0.0.1:${http.address().port}`;
    let closed = false;
    const close = async () => { if (closed) return; closed = true; http.closeAllConnections(); await new Promise(resolveClose => http.close(resolveClose)); await handler.shutdown(); };
    closers.push(close);
    return { base, handler, close, api: async (path, body, user = 'merchant-a') => {
      const response = await fetch(base + '/api/ai' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'x-test-user': user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    } };
  }
  return { storageDir, server, closers };
}

async function pool(app, id = randomUUID(), imageCount = 30) {
  const created = await app.api('/image-uploads', { requestId: id, imageCount }); assert.equal(created.status, 200);
  for (let startIndex = 0; startIndex < imageCount; startIndex += 3) {
    const response = await app.api(`/image-uploads/${id}/batches`, { startIndex, images: Array.from({ length: Math.min(3, imageCount - startIndex) }, () => IMAGE) });
    assert.equal(response.status, 200); assert.equal(response.body.upload.uploadedCount, Math.min(startIndex + 3, imageCount));
  }
  return id;
}
async function terminal(app, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await app.api(`/images/${id}`);
    if (['completed', 'failed'].includes(response.body.task?.status)) return response.body.task;
    await delay(10);
  }
  assert.fail('Mock generation did not finish');
}

test('fifteen-position plans have distinct safe instructions and deterministic references stay bounded', () => {
  for (const mode of ['series', 'variations']) {
    const plans = imagePlan(mode, 15, '真实主题');
    assert.equal(plans.length, 15); assert.ok(plans.every(item => item.prompt && !item.prompt.includes('undefined')));
    assert.equal(new Set(plans.map(item => item.prompt)).size, 15);
  }
  const references = Array.from({ length: 30 }, (_, index) => ({ ...SOURCE, name: `reference-${index + 1}.png` }));
  assert.deepEqual(selectImageReferences(references).map(item => item.sourceIndex), [1, 10, 20, 30]);
  const groups = Array.from({ length: 15 }, (_, index) => selectImageReferences(references, index + 1, 15));
  assert.ok(groups.every(group => group.length === 4)); assert.equal(new Set(groups.flat().map(item => item.sourceIndex)).size, 30);
});

test('thirty-photo uploads are ordered, resumable, idempotent, private and free; incomplete pools cannot generate', async t => {
  let calls = 0; const f = await fixture(t), app = await f.server({ fetchImpl: async () => { calls++; return output(); } }), id = randomUUID();
  assert.equal((await app.api('/image-uploads', { requestId: id, imageCount: 30 })).body.upload.uploadedCount, 0);
  assert.equal((await app.api('/image-uploads', { requestId: id, imageCount: 30 })).status, 200);
  assert.equal((await app.api('/image-uploads', { requestId: id, imageCount: 29 })).status, 409);
  const batch = { startIndex: 0, images: [IMAGE, IMAGE, IMAGE] };
  const first = await app.api(`/image-uploads/${id}/batches`, batch); assert.equal(first.body.upload.uploadedCount, 3);
  assert.equal((await app.api(`/image-uploads/${id}/batches`, batch)).body.upload.uploadedCount, 3);
  assert.equal((await app.api(`/image-uploads/${id}/batches`, { ...batch, images: [{ ...IMAGE, name: '另一张.png' }, IMAGE, IMAGE] })).status, 409);
  assert.equal((await app.api(`/image-uploads/${id}/batches`, { startIndex: 6, images: [IMAGE] })).status, 409);
  assert.equal((await app.api('/images', requestBody({ requestId: id, uploadId: id, generationMode: 'series', outputCount: 6 }))).body.code, 'UPLOAD_INCOMPLETE');
  for (const [path, body] of [[`/image-uploads/${id}`, undefined], [`/image-uploads/${id}/batches`, { startIndex: 3, images: [IMAGE] }], ['/image-uploads', { requestId: id, imageCount: 30 }]]) assert.equal((await app.api(path, body, 'merchant-b')).status, 404);
  assert.equal((await app.api('/usage')).body.used.image, 0); assert.equal(calls, 0);
  assert.equal((await app.api(`/image-uploads/${id}/batches`)).body.upload.uploadedCount, 3);
  assert.doesNotMatch(JSON.stringify(first.body), /owner|sha256|source-01|真实原图|fingerprint|data:image/);
  await app.close(); const restarted = await f.server();
  const progress = await restarted.api(`/image-uploads/${id}`); assert.equal(progress.body.upload.uploadedCount, 3);
  for (let startIndex = 3; startIndex < 30; startIndex += 3) assert.equal((await restarted.api(`/image-uploads/${id}/batches`, { startIndex, images: [IMAGE, IMAGE, IMAGE] })).status, 200);
  assert.equal((await restarted.api(`/image-uploads/${id}`)).body.upload.complete, true);
});

test('fifteen outputs cross the ten-per-minute window without lost positions or extra calls, and all are downloadable', async t => {
  let clock = Date.parse('2026-10-08T00:00:00Z'), waits = 0;
  const calls = [], f = await fixture(t), app = await f.server({ now: () => clock, rateLimitWait: async ms => { assert.equal(ms, 1000); waits++; clock += ms; }, fetchImpl: async (_url, options) => { calls.push({ at: clock, names: options.body.getAll('image').map(image => image.name), prompt: options.body.get('prompt') }); return output(); } });
  const id = await pool(app), body = requestBody({ requestId: id, uploadId: id, generationMode: 'variations', outputCount: 15 });
  assert.equal((await app.api('/images', body)).status, 202);
  const task = await terminal(app, id);
  assert.equal(task.status, 'completed'); assert.equal(task.partial, false); assert.equal(task.completedCount, 15); assert.equal(task.inputCount, 30);
  assert.equal(calls.length, 15); assert.equal(waits, 60); assert.ok(calls.every(call => call.names.length === 4));
  assert.equal(new Set(calls.flatMap(call => call.names)).size, 30);
  assert.equal(new Set(task.images.map(image => image.style)).size, 15);
  for (const call of calls) assert.ok(calls.filter(other => other.at <= call.at && call.at - other.at < 60000).length <= 10);
  const usage = await app.api('/usage'); assert.equal(usage.body.used.image, 15); assert.equal(usage.body.remaining.image, 5);
  assert.equal((await app.api('/images', body)).status, 200); assert.equal(calls.length, 15);
  const submitted = await app.api(`/image-uploads/${id}`); assert.equal(submitted.body.upload.submitted, true); assert.equal(submitted.body.upload.taskId, id);
  for (const image of task.images) { const response = await fetch(app.base + image.url + '?download=1', { headers: { 'x-test-user': 'merchant-a' } }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG); }
  const missing = await fetch(app.base + `/api/ai/media/${id}/result-16.png`); assert.equal(missing.status, 404);
  await app.close(); const restarted = await f.server({ now: () => clock });
  assert.equal((await restarted.api(`/images/${id}`)).body.task.images.length, 15);
  assert.equal((await fetch(restarted.base + `/api/ai/media/${id}/result-15.png`, { headers: { 'x-test-user': 'merchant-a' } })).status, 200);
});

test('insufficient daily quota rejects a full fifteen-image set without partial reservation or provider calls', async t => {
  let calls = 0; const f = await fixture(t), app = await f.server({ config: { ...CONFIG, limits: { ...CONFIG.limits, imageDaily: 14 } }, fetchImpl: async () => { calls++; return output(); } });
  const id = await pool(app, randomUUID(), 6);
  const rejected = await app.api('/images', requestBody({ requestId: id, uploadId: id, generationMode: 'series', outputCount: 15 }));
  assert.equal(rejected.status, 429); assert.equal(rejected.body.code, 'DAILY_QUOTA_EXCEEDED'); assert.equal(calls, 0);
  assert.equal((await app.api('/usage')).body.used.image, 0); assert.equal((await app.api(`/image-uploads/${id}`)).body.upload.submitted, false);
});

test('single-image mode samples a thirty-photo pool and still consumes exactly one call', async t => {
  const calls = [], f = await fixture(t), app = await f.server({ fetchImpl: async (_url, options) => { calls.push(options.body.getAll('image').map(image => image.name)); return output(); } });
  const id = await pool(app), body = requestBody({ requestId: id, uploadId: id, generationMode: 'single', outputCount: 1 });
  await app.api('/images', body); const task = await terminal(app, id);
  assert.deepEqual(calls, [['reference-1.png', 'reference-10.png', 'reference-20.png', 'reference-30.png']]);
  assert.equal(task.inputCount, 30); assert.equal(task.images.length, 1); assert.equal((await app.api('/usage')).body.used.image, 1);
});

test('a fifteen-image set stops on uncertain sent work and releases every remaining unsent reservation', async t => {
  let calls = 0; const f = await fixture(t), app = await f.server({ fetchImpl: async () => { if (++calls === 2) throw new Error('Unknown transport outcome'); return output(); } });
  const body = requestBody({ images: [IMAGE], generationMode: 'series', outputCount: 15 });
  await app.api('/images', body); const task = await terminal(app, body.requestId);
  assert.equal(task.partial, true); assert.equal(task.completedCount, 1); assert.equal(calls, 2);
  const usage = (await app.api('/usage')).body; assert.equal(usage.used.image, 2);
  assert.equal(usage.recent.filter(record => record.status === 'cancelled').length, 13);
  assert.equal((await app.api('/images', body)).status, 200); assert.equal(calls, 2);
});

test('shutdown while waiting for the next rate-limit slot preserves ten images and cancels five definitely-unsent calls', async t => {
  let release, notify, calls = 0;
  const waiting = new Promise(resolveWaiting => { notify = resolveWaiting; }), gate = new Promise(resolveGate => { release = resolveGate; });
  const f = await fixture(t), app = await f.server({ rateLimitWait: async () => { notify(); await gate; }, fetchImpl: async () => { calls++; return output(); } });
  const body = requestBody({ images: [IMAGE], generationMode: 'series', outputCount: 15 });
  await app.api('/images', body); await waiting;
  const stopped = app.handler.shutdown(); release(); await stopped; await app.close();
  const restarted = await f.server();
  const task = (await restarted.api(`/images/${body.requestId}`)).body.task;
  assert.equal(task.completedCount, 10); assert.equal(task.partial, true); assert.equal(calls, 10);
  const usage = (await restarted.api('/usage')).body; assert.equal(usage.used.image, 10); assert.equal(usage.recent.filter(record => record.status === 'cancelled').length, 5);
});

test('invalid counts, wrong upload IDs and oversized batches never reserve or generate', async t => {
  const f = await fixture(t), app = await f.server(), id = randomUUID();
  for (const imageCount of [0, 31, '30']) assert.equal((await app.api('/image-uploads', { requestId: randomUUID(), imageCount })).status, 400);
  await app.api('/image-uploads', { requestId: id, imageCount: 4 });
  for (const images of [[], [IMAGE, IMAGE, IMAGE, IMAGE], [{ ...IMAGE, dataUrl: IMAGE.dataUrl.replace('image/png', 'image/jpeg') }]]) assert.equal((await app.api(`/image-uploads/${id}/batches`, { startIndex: 0, images })).status, 400);
  for (const options of [{ uploadId: randomUUID() }, { uploadId: id, images: [IMAGE] }, { images: [IMAGE], generationMode: 'series', outputCount: 16 }]) assert.equal((await app.api('/images', requestBody({ requestId: id, ...options }))).status, 400);
  assert.equal((await app.api('/usage')).body.used.image, 0);
});

test('upload pools enforce the sixty-MB total before writing a batch and keep committed progress intact', async t => {
  const f = await fixture(t), uploads = createImageUploads({ storageDir: f.storageDir }); f.closers.push(() => uploads.dispose());
  const id = randomUUID(), large = { ...SOURCE, bytes: Buffer.alloc(8 * 1024 * 1024) };
  await uploads.init(id, 8, 'a');
  await uploads.append(id, 0, [large, large, large], 'a'); await uploads.append(id, 3, [large, large, large], 'a'); await uploads.append(id, 6, [large], 'a');
  await assert.rejects(uploads.append(id, 7, [{ ...SOURCE, bytes: Buffer.alloc(5 * 1024 * 1024) }], 'a'), { code: 'UPLOAD_TOO_LARGE' });
  const progress = await uploads.get(id, 'a'); assert.equal(progress.uploadedCount, 7); assert.equal(progress.totalBytes, 56 * 1024 * 1024);
  assert.equal((await readdir(join(f.storageDir, '.image-uploads', id))).filter(name => name.startsWith('source-')).length, 7);
});

test('three-day cleanup expires original upload access and removes only managed originals, including after restart', async t => {
  let clock = Date.parse('2026-10-08T00:00:00Z'); const f = await fixture(t), app = await f.server({ now: () => clock });
  const id = await pool(app, randomUUID(), 3), dir = join(f.storageDir, '.image-uploads', id);
  await writeFile(join(dir, 'unknown.txt'), 'preserve');
  clock += 72 * 60 * 60 * 1000;
  assert.equal((await app.api(`/image-uploads/${id}`)).status, 410);
  await assert.rejects(readFile(join(dir, 'source-01.png')), { code: 'ENOENT' });
  assert.equal(await readFile(join(dir, 'unknown.txt'), 'utf8'), 'preserve');
  await app.close(); const restarted = await f.server({ now: () => clock });
  assert.equal((await restarted.api('/image-uploads', { requestId: id, imageCount: 3 })).status, 410);
  assert.equal((await restarted.api('/usage')).body.used.image, 0);
});

test('a retry recovers an orphan batch written before metadata commit without overwriting committed images', async t => {
  const f = await fixture(t), uploads = createImageUploads({ storageDir: f.storageDir }); f.closers.push(() => uploads.dispose());
  const id = randomUUID(); await uploads.init(id, 2, 'a');
  await writeFile(join(f.storageDir, '.image-uploads', id, 'source-01.png'), PNG);
  assert.equal((await uploads.append(id, 0, [SOURCE, SOURCE], 'a')).complete, true);
  assert.deepEqual((await uploads.images(id, 'a')).map(item => item.bytes), [PNG, PNG]);
  await assert.rejects(uploads.append(id, 0, [{ ...SOURCE, bytes: Buffer.from('different') }, SOURCE], 'a'), { code: 'UPLOAD_CONFLICT' });
});

test('upload cleanup handles aged orphan originals without touching fresh originals or unknown files', async t => {
  const f = await fixture(t), uploads = createImageUploads({ storageDir: f.storageDir }); f.closers.push(() => uploads.dispose());
  const id = randomUUID(); await uploads.ready; const dir = join(f.storageDir, '.image-uploads', id); await mkdir(dir);
  await writeFile(join(dir, 'source-01.png'), PNG); await writeFile(join(dir, 'source-02.png'), PNG); await writeFile(join(dir, 'unrelated.png'), PNG);
  const old = new Date(Date.now() - 73 * 60 * 60 * 1000); await utimes(join(dir, 'source-01.png'), old, old);
  await uploads.sweep();
  await assert.rejects(readFile(join(dir, 'source-01.png')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(dir, 'source-02.png')), PNG); assert.deepEqual(await readFile(join(dir, 'unrelated.png')), PNG);
});

test('original files and metadata cannot follow symlinks outside their upload pool', async t => {
  const f = await fixture(t), uploads = createImageUploads({ storageDir: f.storageDir }); f.closers.push(() => uploads.dispose());
  const id = randomUUID(), outside = join(f.storageDir, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.png'), PNG);
  await uploads.init(id, 1, 'a');
  const target = join(f.storageDir, '.image-uploads', id, 'source-01.png');
  try { await symlink(join(outside, 'private.png'), target, 'file'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlinks not available'); return; } throw error; }
  await assert.rejects(uploads.append(id, 0, [SOURCE], 'a'), { code: 'UPLOAD_STORAGE_FAILED' });
  assert.deepEqual(await readFile(join(outside, 'private.png')), PNG);
});
