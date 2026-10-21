import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { normalizeSeedanceVideo, probeVideo } from '../services/video/media.mjs';

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), 'seedance-pixels-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function makeVideo(path, width, height, { audio = false, filter, fps = 30 } = {}) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=white:s=${width}x${height}:r=${fps}:d=2`,
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac'] : []),
    ...(filter ? ['-vf', filter] : []), '-c:v', 'libx264', '-threads', '1', path]);
}
function assertPixels(metadata) {
  for (const [width, height] of [[metadata.width, metadata.height], [metadata.codedWidth, metadata.codedHeight]]) {
    assert.ok(width >= 300 && width <= 6000 && height >= 300 && height <= 6000, JSON.stringify(metadata));
    assert.ok(width * height >= 407696 && width * height <= 8295044, JSON.stringify(metadata));
    assert.ok(width / height >= 0.4 && width / height <= 2.5, JSON.stringify(metadata));
  }
}

for (const [width, height] of [[160, 240], [350, 350], [300, 1400], [1400, 300], [4096, 2160], [7200, 1200]]) {
  test(`Seedance fixes ${width}x${height} pixels without trimming or losing audio`, async t => {
    const root = await folder(t), path = join(root, 'source.mp4');
    makeVideo(path, width, height, { audio: true, fps: width > 4000 ? 1 : 30 });
    const original = await probeVideo(path);
    const metadata = await normalizeSeedanceVideo(path, original);
    assertPixels(metadata);
    assert.equal(metadata.audio, true);
    assert.ok(Math.abs(metadata.duration - original.duration) < 0.1);
    const ratio = Math.max(0.4, Math.min(2.5, width / height));
    assert.ok(Math.abs(metadata.width / metadata.height - ratio) < 0.01);
    const encoded = await readFile(path);
    assert.deepEqual(await normalizeSeedanceVideo(path, metadata), metadata);
    assert.deepEqual(await readFile(path), encoded, 'Already normalized videos are not re-encoded');
    assert.deepEqual(await readdir(root), ['source.mp4']);
    if (width / height > 2.5 || width / height < 0.4) {
      const pixels = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'],
        { maxBuffer: 20 * 1024 * 1024 });
      assert.ok(pixels[0] < 10, 'Extreme ratios get black padding');
      assert.ok(pixels[Math.floor(metadata.height / 2) * metadata.width + Math.floor(metadata.width / 2)] > 240);
    }
  });
}

for (const [width, height] of [[614, 664], [480, 854], [1280, 720]]) {
  test(`Seedance leaves compliant ${width}x${height} uploads byte-identical`, async t => {
    const root = await folder(t), path = join(root, 'source.mp4');
    makeVideo(path, width, height);
    const original = await readFile(path), metadata = await probeVideo(path);
    assert.strictEqual(await normalizeSeedanceVideo(path, metadata), metadata);
    assert.deepEqual(await readFile(path), original);
  });
}

test('Seedance preserves displayed proportions for rotated and non-square-pixel footage', async t => {
  const root = await folder(t), source = join(root, 'source.mp4');
  makeVideo(source, 640, 360);
  const rotated = join(root, 'rotated.mp4');
  const displayRotation = execFileSync('ffmpeg', ['-hide_banner', '-h', 'long'], { encoding: 'utf8' }).includes('-display_rotation');
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...(displayRotation ? ['-display_rotation', '90'] : []), '-i', source,
    '-c', 'copy', ...(displayRotation ? [] : ['-metadata:s:v:0', 'rotate=90']), rotated]);
  const portrait = await normalizeSeedanceVideo(rotated);
  assertPixels(portrait); assert.ok(Math.abs(portrait.width / portrait.height - 9 / 16) < 0.01);
  const anamorphic = join(root, 'anamorphic.mp4');
  makeVideo(anamorphic, 280, 800, { filter: 'setsar=2/1' });
  const original = await probeVideo(anamorphic);
  assert.equal(original.width, 560); assert.equal(original.codedWidth, 280);
  const corrected = await normalizeSeedanceVideo(anamorphic, original);
  assertPixels(corrected); assert.equal(corrected.width / corrected.height, 0.7);
  assert.equal(corrected.audio, false);
});

test('a failed Seedance conversion preserves its source and removes partial output', async t => {
  const root = await folder(t), path = join(root, 'source.mp4');
  const original = Buffer.from('invalid video'); await writeFile(path, original);
  await assert.rejects(normalizeSeedanceVideo(path, { width: 350, height: 350, duration: 2, audio: false }), { code: 'VIDEO_NORMALIZE_FAILED' });
  assert.deepEqual(await readFile(path), original);
  assert.deepEqual(await readdir(root), ['source.mp4']);
});
