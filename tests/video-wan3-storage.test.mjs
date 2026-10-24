import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWan3Storage } from '../services/video/wan3-storage.mjs';

const env = { COS_BUCKET: 'test-bucket-1250000000', COS_REGION: 'ap-shanghai', COS_SECRET_ID: 'test-id', COS_SECRET_KEY: 'test-key' };

test('Wan COS storage streams private inputs to stable task keys and deletes only those inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wan3-storage-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'photo.jpg'), bytes = Buffer.from([255, 216, 255, 0]), taskId = randomUUID();
  await writeFile(path, bytes);
  const calls = [];
  const storage = createWan3Storage({ env, cosClient: {
    async putObject(options, callback) {
      const chunks = []; for await (const chunk of options.Body) chunks.push(chunk);
      calls.push({ ...options, Body: Buffer.concat(chunks) }); callback(null, {});
    },
    deleteObject(options, callback) { calls.push(options); callback(null, {}); },
  } });
  await storage.upload(taskId, 'photo', path, 'image/jpeg');
  await storage.upload(taskId, 'photo', path, 'image/jpeg');
  await storage.remove(taskId, 'photo');
  assert.deepEqual(calls[0], { Bucket: env.COS_BUCKET, Region: env.COS_REGION,
    Key: `workspace-video/wan3/${taskId}/photo.jpg`, Body: bytes, ContentLength: bytes.length, ContentType: 'image/jpeg', ACL: 'private' });
  assert.equal(calls[1].Key, calls[0].Key, 'an interrupted upload overwrites its own key');
  assert.equal(calls[2].Key, calls[0].Key);
  await assert.rejects(storage.remove(taskId, '../../workspace-assets'), /Invalid Wan material/);
  assert.equal(calls.length, 3);
});

test('the real COS SDK signs HTTPS media URLs for three days without a network call', async () => {
  const storage = createWan3Storage({ env }), id = randomUUID();
  for (const [kind, extension] of [['photo', 'jpg'], ['product', 'jpg'], ['background', 'jpg'], ['voice', 'wav'], ['video', 'mp4'], ['segment-1', 'mp4']]) {
    const url = new URL(await storage.url(id, kind));
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, `${env.COS_BUCKET}.cos.${env.COS_REGION}.myqcloud.com`);
    assert.equal(url.pathname, `/workspace-video/wan3/${id}/${kind}.${extension}`);
    assert.ok(url.searchParams.get('q-signature'));
    const [start, end] = url.searchParams.get('q-key-time').split(';').map(Number);
    assert.equal(end - start, 3 * 86400);
    assert.ok(Math.abs(start - Date.now() / 1000) < 10);
  }
});

test('missing COS settings and provider errors are explicit and do not expose credentials', async () => {
  const id = randomUUID();
  await assert.rejects(createWan3Storage({ env: {} }).url(id, 'photo'), { code: 'VIDEO_SOURCE_STORAGE_NOT_CONFIGURED' });
  const storage = createWan3Storage({ env, cosClient: { getObjectUrl(_options, callback) { callback(new Error('test-key private-provider-response')); } } });
  await assert.rejects(storage.url(id, 'photo'), error => {
    assert.equal(error.code, 'VIDEO_SOURCE_STORAGE_FAILED');
    assert.doesNotMatch(error.message, /test-key|private-provider-response/); return true;
  });
});
