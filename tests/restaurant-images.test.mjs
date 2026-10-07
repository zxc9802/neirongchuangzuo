import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { unzipSync, strFromU8 } from 'fflate';
import { inspectPhoto, prepareAnalysisPhoto, processPhoto, createPackageZip } from '../services/restaurant/images.mjs';

const source = async () => sharp({ create: { width: 720, height: 480, channels: 3, background: '#745846' } })
  .composite([{ input: Buffer.from('<svg width="720" height="480"><rect x="0" y="0" width="100" height="480" fill="#b55225"/><rect x="620" y="0" width="100" height="480" fill="#215cb5"/><circle cx="360" cy="240" r="140" fill="#dab478"/></svg>') }])
  .png().toBuffer();

test('photo inspection validates decoded content rather than extensions and reports dimensions and identity', async () => {
  const bytes = await source();
  const photo = await inspectPhoto(bytes);
  assert.equal(photo.format, 'png'); assert.equal(photo.width, 720); assert.equal(photo.height, 480);
  assert.match(photo.hash, /^[a-f0-9]{64}$/); assert.ok(photo.quality.brightness > 0); assert.ok(photo.quality.contrast > 0);
  assert.equal((await inspectPhoto(Buffer.from(bytes))).hash, photo.hash);
  await assert.rejects(inspectPhoto(Buffer.from('<svg/>')), { code: 'invalid_image' });
  await assert.rejects(inspectPhoto(Buffer.from('broken-image')), { code: 'invalid_image' });
  const tiny = await sharp({ create: { width: 60, height: 60, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(inspectPhoto(tiny), { code: 'invalid_image' });
});

test('natural enhancement preserves the whole composition without inventing a portrait crop', async () => {
  const bytes = await source();
  const result = await processPhoto(bytes);
  assert.equal(result.width, 720); assert.equal(result.height, 480); assert.equal(result.format, 'jpeg');
  const before = await sharp(bytes).removeAlpha().raw().toBuffer();
  const after = await sharp(result.bytes).raw().toBuffer();
  let difference = 0;
  for (let index = 0; index < before.length; index++) difference += Math.abs(before[index] - after[index]);
  assert.ok(difference / before.length < 15, 'ordinary adjustments should make mild pixel changes');
  assert.ok(after[0] > after[2], 'left subject remains red');
  const at = (719 * 3); assert.ok(after[at + 2] > after[at], 'right subject remains blue');
});

test('vision input normalizes orientation and strips source EXIF without editing the subject', async () => {
  const original = await sharp(await source()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const sourceMeta = await sharp(original).metadata();
  assert.ok(sourceMeta.exif);
  const inspected = await inspectPhoto(original);
  assert.equal(inspected.width, 480); assert.equal(inspected.height, 720);
  const prepared = await prepareAnalysisPhoto(original);
  assert.equal(prepared.mime, 'image/jpeg');
  const metadata = await sharp(prepared.bytes).metadata();
  assert.equal(metadata.width, 480); assert.equal(metadata.height, 720);
  assert.equal(metadata.exif, undefined); assert.equal(metadata.orientation, undefined);
  const enhanced = await processPhoto(original);
  assert.equal(enhanced.width, 480); assert.equal(enhanced.height, 720);
});

test('cover strip preserves subject pixels and appends readable text to the first image', async () => {
  const bytes = await source();
  const enhanced = await processPhoto(bytes);
  const cover = await processPhoto(bytes, { coverText: '附近上班族午餐来吃面' });
  assert.equal(cover.width, enhanced.width); assert.ok(cover.height > enhanced.height);
  const originalPart = await sharp(cover.bytes).extract({ left: 0, top: 0, width: enhanced.width, height: enhanced.height }).raw().toBuffer();
  const before = await sharp(enhanced.bytes).raw().toBuffer();
  let difference = 0;
  for (let index = 0; index < before.length; index++) difference += Math.abs(before[index] - originalPart[index]);
  assert.ok(difference / before.length < 4, 'text should not cover or repaint the image');
  const banner = await sharp(cover.bytes).extract({ left: 0, top: enhanced.height, width: cover.width, height: cover.height - enhanced.height }).stats();
  assert.ok(banner.channels[0].stdev > 20, 'banner contains actual rendered text');
  await assert.rejects(processPhoto(bytes, { coverText: '短标题' }), { code: 'invalid_image' });
  await assert.rejects(processPhoto(bytes, { coverText: '附近上班族午餐来吃面\n<script/>' }), { code: 'invalid_image' });
});

test('reviewed crop accepts only bounded conservative coordinates', async () => {
  const bytes = await source();
  const cropped = await processPhoto(bytes, { crop: { left: 0.05, top: 0.05, width: 0.9, height: 0.9 } });
  assert.equal(cropped.width, 648); assert.equal(cropped.height, 432);
  for (const crop of [{ left: -1, top: 0, width: 1, height: 1 }, { left: 0.2, top: 0, width: 1, height: 1 },
    { left: 0, top: 0, width: 0.5, height: 1 }, { left: 'bad', top: 0, width: 1, height: 1 }]) {
    await assert.rejects(processPhoto(bytes, { crop }), { code: 'invalid_image' });
  }
});

test('ZIP packages use ordered safe filenames and contain the publishable copy', async () => {
  const image = await processPhoto(await source());
  const zip = createPackageZip([{ ...image, title: '../../untrusted' }, image], { titles: ['标题一', '标题二', '标题三'], body: '老板真实分享', hashtags: ['#午餐', '#面馆'], risks: ['人工确认'] });
  const extracted = unzipSync(zip);
  assert.deepEqual(Object.keys(extracted), ['01.jpg', '02.jpg', '发布文案.txt']);
  assert.equal(Buffer.compare(Buffer.from(extracted['01.jpg']), image.bytes), 0);
  assert.match(strFromU8(extracted['发布文案.txt']), /老板真实分享/);
  assert.match(strFromU8(extracted['发布文案.txt']), /人工确认/);
  assert.throws(() => createPackageZip([], ''), { code: 'invalid_image' });
  assert.throws(() => createPackageZip(Array(10).fill(image), ''), { code: 'invalid_image' });
});
