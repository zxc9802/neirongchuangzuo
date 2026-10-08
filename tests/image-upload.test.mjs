import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePhotoSelection, preparePhotoBatches, PHOTO_LIMITS } from '../design/image-upload.js';

const photo = (name, size = 9 * 1024 * 1024) => ({ name, size, type: 'image/jpeg' });

test('phone original selection accepts 30 large photos but rejects count, type and byte limits', () => {
  assert.equal(validatePhotoSelection(Array.from({ length: 30 }, (_, i) => photo(`${i}.jpg`))), '');
  assert.match(validatePhotoSelection(Array.from({ length: 31 }, (_, i) => photo(`${i}.jpg`))), /30/);
  assert.match(validatePhotoSelection([photo('large.jpg', PHOTO_LIMITS.originalBytes + 1)]), /单张最多 20MB/);
  assert.match(validatePhotoSelection(Array.from({ length: 30 }, (_, i) => photo(`${i}.jpg`, 20 * 1024 * 1024))), /总大小最多 400MB/);
  assert.match(validatePhotoSelection([{ ...photo('html'), type: 'text/html' }]), /仅支持/);
  assert.match(validatePhotoSelection([{ ...photo('empty'), size: 0 }]), /无法读取/);
});

function browser(t, { failFile, dimensions = [5712, 4284] } = {}) {
  const original = Object.fromEntries(['createImageBitmap', 'document', 'FileReader'].map(key => [key, globalThis[key]]));
  const calls = { decoded: [], sizes: [], active: 0, peak: 0, closed: 0 };
  globalThis.createImageBitmap = async (file, options) => {
    assert.equal(options.imageOrientation, 'from-image');
    if (file.name === failFile) throw new Error('invalid JPEG');
    calls.decoded.push(file.name); calls.active++; calls.peak = Math.max(calls.peak, calls.active);
    return { width: dimensions[0], height: dimensions[1], close() { calls.active--; calls.closed++; } };
  };
  globalThis.document = { createElement(tag) {
    assert.equal(tag, 'canvas');
    const canvas = { width: 0, height: 0, getContext() { return { fillRect() {}, drawImage() { calls.sizes.push([canvas.width, canvas.height]); } }; }, toBlob(callback, type, quality) {
      assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.85);
      queueMicrotask(() => callback(new Blob([Uint8Array.from([255, 216, 255, 217])], { type })));
    } };
    return canvas;
  } };
  globalThis.FileReader = class {
    async readAsDataURL(blob) { this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`; this.onload(); }
    abort() { this.onabort?.(); }
  };
  t.after(() => { for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });
  return calls;
}

test('30 originals prepare ten ordered batches and release each decoded bitmap before the next', async t => {
  const calls = browser(t), files = Array.from({ length: 30 }, (_, i) => photo(`${i + 1}.jpg`));
  const batches = [], progress = [];
  for await (const batch of preparePhotoBatches(files, { onProgress: value => progress.push(value.current) })) batches.push(batch);
  assert.equal(batches.length, 10); assert.deepEqual(batches.map(item => item.startIndex), [0, 3, 6, 9, 12, 15, 18, 21, 24, 27]);
  assert.equal(batches.flatMap(item => item.images).length, 30);
  assert.ok(batches.every(item => item.images.length === 3 && item.images.every(image => image.dataUrl.startsWith('data:image/jpeg;base64,'))));
  assert.ok(calls.sizes.every(([width, height]) => width === 2048 && height === 1536));
  assert.equal(calls.peak, 1); assert.equal(calls.active, 0); assert.equal(calls.closed, 30);
  assert.equal(progress.at(-1), 30);
  assert.equal(files[0].size, 9 * 1024 * 1024);
});

test('resuming from uploadedCount skips already prepared originals and preserves absolute indices', async t => {
  const calls = browser(t), batches = [];
  for await (const batch of preparePhotoBatches(Array.from({ length: 8 }, (_, i) => photo(`${i}.jpg`)), { startIndex: 3 })) batches.push(batch);
  assert.deepEqual(calls.decoded, ['3.jpg', '4.jpg', '5.jpg', '6.jpg', '7.jpg']);
  assert.deepEqual(batches.map(item => [item.startIndex, item.images.length]), [[3, 3], [6, 2]]);
});

test('abort between batches does not decode any further photos', async t => {
  const calls = browser(t), controller = new AbortController();
  const prepare = preparePhotoBatches(Array.from({ length: 6 }, (_, i) => photo(`${i}.jpg`)), { signal: controller.signal });
  assert.equal((await prepare.next()).value.images.length, 3); controller.abort();
  await assert.rejects(prepare.next(), { name: 'AbortError' });
  assert.equal(calls.decoded.length, 3); assert.equal(calls.active, 0);
});

test('unreadable originals reject the batch before a malformed image can upload', async t => {
  const calls = browser(t, { failFile: 'bad.jpg' });
  const prepare = preparePhotoBatches([photo('ok.jpg'), photo('bad.jpg'), photo('later.jpg')]);
  await assert.rejects(prepare.next(), /bad.jpg.*invalid JPEG/);
  assert.deepEqual(calls.decoded, ['ok.jpg']); assert.equal(calls.active, 0);
});

test('oversized decoded dimensions reject and still close the bitmap', async t => {
  const calls = browser(t, { dimensions: [9000, 9000] });
  await assert.rejects(preparePhotoBatches([photo('huge.jpg')]).next(), /像素过大/);
  assert.equal(calls.closed, 1); assert.equal(calls.active, 0);
});
