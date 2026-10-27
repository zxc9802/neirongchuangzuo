import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import COS from 'cos-nodejs-sdk-v5';
import { createMaterialLibrary } from '../services/assets/library.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'material-upload-'));
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const video = join(root, 'video.mp4'), photo = join(root, 'photo.jpg');
  await writeFile(video, Buffer.alloc(20 * 1024 * 1024, 1));
  await writeFile(photo, 'photo');
  const objects = new Map(), writes = [];
  const cos = {
    getObject({ Key }, done) { queueMicrotask(() => objects.has(Key) ? done(null, { Body: objects.get(Key) }) : done({ statusCode: 404 })); },
    putObject(options, done) {
      writes.push({ method: 'putObject', ...options });
      objects.set(options.Key, Buffer.from(options.Body)); queueMicrotask(() => done(null, {}));
    },
    sliceUploadFile(options, done) {
      writes.push({ method: 'sliceUploadFile', ...options });
      readFile(options.FilePath).then(bytes => { objects.set(options.Key, bytes); done(null, {}); }, done);
    },
  };
  return { video, photo, cos, writes, library: createMaterialLibrary({ cosClient: cos }) };
}

test('large material uploads use bounded parallel file chunks and keep small objects on PUT', async t => {
  const f = await fixture(t);
  const video = await f.library.save('alice', { kind: 'video', path: f.video });
  await f.library.save('alice', { kind: 'photo', path: f.photo });
  const transfer = f.writes.find(item => item.Key.includes(video.id));
  assert.equal(transfer.method, 'sliceUploadFile');
  assert.equal(transfer.FilePath, f.video);
  assert.equal(transfer.Body, undefined);
  assert.equal(transfer.ChunkSize, 8 * 1024 * 1024);
  assert.equal(transfer.AsyncLimit, 4);
  assert.equal(transfer.ACL, 'private');
  assert.equal(transfer.ContentType, 'video/mp4');
  assert.ok(f.writes.filter(item => !item.Key.includes(video.id)).every(item => item.method === 'putObject'));
  assert.equal((await f.library.get('alice', video.id)).bytes.length, 20 * 1024 * 1024);
});

test('a slow video transfer does not block another material or lose either index entry', async t => {
  const f = await fixture(t);
  let release, started;
  const uploading = new Promise(resolve => { started = resolve; });
  for (const method of ['putObject', 'sliceUploadFile']) {
    const original = f.cos[method].bind(f.cos);
    f.cos[method] = (options, done) => {
      if (options.Key.endsWith('.mp4')) { release = () => original(options, done); started(); }
      else original(options, done);
    };
  }
  const video = f.library.save('alice', { kind: 'video', path: f.video, placement: { folderId: 'own-video' } });
  await uploading;
  let savedPhoto;
  const photo = f.library.save('alice', { kind: 'photo', path: f.photo }).then(item => { savedPhoto = item; return item; });
  // The video stays blocked until this assertion; the photo must finish independently.
  try {
    await Promise.race([photo, new Promise(resolve => setTimeout(resolve, 250))]);
    assert.ok(savedPhoto, 'small materials must not queue behind a large transfer');
    await f.library.folders('alice', { action: 'folder-create', type: 'video', name: '上传期间新建' });
  } finally { release(); await Promise.all([video, photo]); }
  const items = await f.library.list('alice');
  assert.deepEqual(items.map(item => item.kind).sort(), ['photo', 'video']);
  const organization = await f.library.organization('alice');
  assert.ok(organization.folders.some(folder => folder.name === '上传期间新建'));
  assert.equal(organization.assignments[(await video).id], 'own-video');
});

test('failed multipart uploads stay unindexed and retry without duplicate media transfers', async t => {
  const f = await fixture(t), original = f.cos.sliceUploadFile;
  f.cos.sliceUploadFile = (_options, done) => done(new Error('upload interrupted'));
  await assert.rejects(f.library.save('alice', { kind: 'video', path: f.video }), /云存储暂时不可用/);
  assert.deepEqual(await f.library.list('alice'), []);
  f.cos.sliceUploadFile = original;
  const items = await Promise.all(Array.from({ length: 4 }, () => f.library.save('alice', { kind: 'video', path: f.video })));
  assert.equal(new Set(items.map(item => item.id)).size, 1);
  assert.equal(f.writes.filter(item => item.method === 'sliceUploadFile').length, 1);
  assert.equal((await f.library.list('alice')).length, 1);
});

test('the installed COS SDK sends four chunks concurrently, retries only the failed chunk and merges intact bytes', async t => {
  const f = await fixture(t), source = Buffer.alloc(40 * 1024 * 1024, 2);
  await writeFile(f.video, source);
  const cos = new COS({ SecretId: 'test', SecretKey: 'test', UploadIdCacheLimit: 0 });
  cos.getObject = f.cos.getObject; cos.putObject = f.cos.putObject;
  const parts = new Map(), attempts = new Map();
  let active = 0, peak = 0, initialized, completed, release;
  const firstBatch = new Promise(resolve => { release = resolve; });
  cos.multipartList = (_options, done) => done(null, { Upload: [], IsTruncated: 'false' });
  cos.multipartInit = (options, done) => { initialized = options; done(null, { UploadId: randomUUID() }); };
  cos.multipartUpload = (options, done) => {
    active++; peak = Math.max(peak, active);
    if (active === 4) release();
    attempts.set(options.PartNumber, (attempts.get(options.PartNumber) || 0) + 1);
    (async () => {
      const chunks = [];
      for await (const chunk of options.Body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      await firstBatch;
      active--;
      if (options.PartNumber === 2 && attempts.get(2) === 1) { done(new Error('temporary chunk failure')); return; }
      parts.set(options.PartNumber, bytes);
      done(null, { ETag: '"' + createHash('md5').update(bytes).digest('hex') + '"' });
    })().catch(done);
  };
  cos.multipartComplete = (options, done) => {
    completed = options;
    done(null, { statusCode: 200 });
  };
  const library = createMaterialLibrary({ cosClient: cos, env: { COS_BUCKET: 'test-1234567890', COS_REGION: 'ap-guangzhou' } });
  await library.save('alice', { kind: 'video', path: f.video });
  assert.equal(peak, 4);
  assert.equal(parts.size, 5);
  assert.equal(attempts.get(2), 2);
  assert.ok([...attempts].filter(([part]) => part !== 2).every(([, count]) => count === 1));
  assert.equal(initialized.Headers['x-cos-acl'], 'private');
  assert.equal(initialized.Headers['Content-Type'], 'video/mp4');
  assert.deepEqual(completed.Parts.map(part => part.PartNumber), [1, 2, 3, 4, 5]);
  assert.deepEqual(Buffer.concat(completed.Parts.map(part => parts.get(part.PartNumber))), source);
  assert.equal((await library.list('alice')).length, 1);
});
