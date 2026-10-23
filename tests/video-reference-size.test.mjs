import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, stat, readdir, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareReferenceVideo, referenceVideoLimit } from '../services/video/reference-video.mjs';
import { probeVideo } from '../services/video/media.mjs';

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), 'video-reference-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function padVideo(path, bytes) {
  const size = (await stat(path)).size, atom = Buffer.alloc(8);
  atom.writeUInt32BE(bytes - size); atom.write('free', 4);
  const handle = await open(path, 'r+');
  try { await handle.write(atom, 0, 8, size); await handle.truncate(bytes); }
  finally { await handle.close(); }
}

for (const model of ['doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628',
  'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615', 'wan3.0-video', 'wan3.0-video-prime']) {
  test(`${model} leaves references below and exactly at its byte limit untouched`, async t => {
    const root = await folder(t), input = join(root, 'source.mp4'), output = join(root, 'reference.mp4');
    const limit = model.startsWith('wan') ? 100_000_000 : 200_000_000;
    assert.equal(referenceVideoLimit(model), limit);
    // Invalid tiny content also proves that the fast path never probes or starts FFmpeg.
    await writeFile(input, 'unchanged');
    for (const size of [9, limit]) {
      const handle = await open(input, 'r+'); await handle.truncate(size); await handle.close();
      const original = await digest(input);
      assert.deepEqual(await prepareReferenceVideo(input, output, model), { compressed: false, inputBytes: size, outputBytes: size });
      assert.equal(await digest(input), original);
      assert.deepEqual(await readdir(root), ['source.mp4']);
    }
  });
}

for (const [model, audio] of [['wan3.0-video', true], ['doubao-seedance-2-5-260628', false]]) {
  test(`${model} compresses an over-limit file, preserving source bytes, dimensions, timing and audio=${audio}`, async t => {
    const root = await folder(t), input = join(root, 'source.mp4'), output = join(root, 'reference.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=30000/1001:d=2',
      ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac'] : []),
      '-c:v', 'libx264', '-threads', '1', input]);
    const limit = referenceVideoLimit(model);
    await padVideo(input, limit + 1);
    const originalHash = await digest(input), original = await probeVideo(input);
    const result = await prepareReferenceVideo(input, output, model), encoded = await probeVideo(output);
    assert.equal(result.compressed, true); assert.equal(result.inputBytes, limit + 1);
    assert.ok(result.outputBytes <= limit * .9);
    assert.equal(await digest(input), originalHash);
    assert.equal(encoded.width, original.width); assert.equal(encoded.height, original.height);
    assert.equal(encoded.audio, audio); assert.ok(Math.abs(encoded.duration - original.duration) <= .1);
    const frames = path => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=avg_frame_rate,nb_frames', '-of', 'json', path], { encoding: 'utf8' })).streams[0];
    assert.deepEqual(frames(output), frames(input));
    assert.deepEqual((await readdir(root)).sort(), ['reference.mp4', 'source.mp4']);
  });
}

test('high-bitrate moving footage over 100 MB is reduced below the Wan budget without lowering resolution or frame count', async t => {
  const root = await folder(t), input = join(root, 'source.mp4'), output = join(root, 'reference.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4',
    '-vf', 'noise=alls=100:allf=t+u:all_seed=7', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', input]);
  assert.ok((await stat(input)).size > 100_000_000, 'The actual encoded video, without padding, must exceed the limit');
  const original = await digest(input), result = await prepareReferenceVideo(input, output, 'wan3.0-video');
  assert.equal(result.compressed, true); assert.ok(result.outputBytes <= 90_000_000);
  assert.equal(await digest(input), original);
  const metadata = await probeVideo(output);
  assert.equal(metadata.width, 1280); assert.equal(metadata.height, 720); assert.equal(metadata.duration, 4);
  const stream = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=avg_frame_rate,nb_frames', '-of', 'json', output], { encoding: 'utf8' })).streams[0];
  assert.equal(stream.avg_frame_rate, '30/1'); assert.equal(Number(stream.nb_frames), 120);
});

test('invalid over-limit media stops with a clear error and leaves no partial compressed copy', async t => {
  const root = await folder(t), input = join(root, 'source.mp4'), output = join(root, 'reference.mp4');
  await writeFile(input, 'invalid source'); await padVideo(input, 100_000_001);
  const original = await digest(input);
  await assert.rejects(prepareReferenceVideo(input, output, 'wan3.0-video'), { code: 'VIDEO_REFERENCE_COMPRESSION_FAILED' });
  assert.equal(await digest(input), original); assert.deepEqual(await readdir(root), ['source.mp4']);
});
