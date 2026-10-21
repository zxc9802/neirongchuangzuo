import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { probeVideo, restoreVideoBorders } from '../services/video/media.mjs';

test('video probing uses displayed portrait dimensions for rotated phone footage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'replica-aspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'landscape.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=640x360:r=10:d=2',
    '-c:v', 'libx264', '-threads', '1', source]);
  const displayRotation = execFileSync('ffmpeg', ['-hide_banner', '-h', 'long'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).includes('-display_rotation');
  for (const rotation of [0, 90, -90, 180]) {
    const output = join(root, `phone-${rotation}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...(displayRotation ? ['-display_rotation', String(rotation)] : []),
      '-i', source, '-c', 'copy', ...(displayRotation ? [] : ['-metadata:s:v:0', `rotate=${rotation}`]), output]);
    const raw = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output]));
    if (Math.abs(rotation) === 90) assert.equal(Math.abs(raw.streams[0].side_data_list[0].rotation), 90, 'The fixture really carries a rotation matrix');
    const metadata = await probeVideo(output);
    const portrait = Math.abs(rotation) === 90;
    assert.equal(metadata.width, portrait ? 360 : 640, `Displayed width at ${rotation} degrees`);
    assert.equal(metadata.height, portrait ? 640 : 360, `Displayed height at ${rotation} degrees`);
    assert.equal(metadata.duration, 2); assert.equal(metadata.audio, false);
  }
});

test('video probing respects non-square pixels when identifying the uploaded aspect ratio', async t => {
  const root = await mkdtemp(join(tmpdir(), 'replica-pixel-aspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'anamorphic.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=360x288:r=10:d=2',
    '-vf', 'setsar=16/15', '-c:v', 'libx264', '-threads', '1', source]);
  const metadata = await probeVideo(source);
  assert.equal(metadata.width, 384); assert.equal(metadata.height, 288);
  assert.equal(metadata.width / metadata.height, 4 / 3);
});

for (const rotation of [0, 90]) test(`replicas restore source black borders at output resolution (${rotation} degree source)`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'replica-borders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.mp4'), input = join(root, 'input.mp4'), result = join(root, 'result.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=180x320:r=10:d=2',
    '-vf', 'pad=320:320:70:0:black', '-c:v', 'libx264', '-threads', '1', input]);
  const displayRotation = execFileSync('ffmpeg', ['-hide_banner', '-h', 'long'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).includes('-display_rotation');
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...(displayRotation ? ['-display_rotation', String(rotation)] : []),
    '-i', input, '-c', 'copy', ...(displayRotation ? [] : ['-metadata:s:v:0', `rotate=${rotation}`]), source]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=640x640:r=10:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', result]);
  const audio = path => execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-c:a', 'copy', '-f', 'adts', '-']);
  const originalAudio = audio(result), before = await probeVideo(result);
  const restored = await restoreVideoBorders(source, result);
  assert.equal(restored.restored, true, JSON.stringify(restored));
  assert.equal(rotation ? restored.top : restored.left, 70 / 320);
  assert.equal(rotation ? restored.bottom : restored.right, 70 / 320);
  const pixels = execFileSync('ffmpeg', ['-v', 'error', '-i', result, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 2 * 1024 * 1024 });
  const pixel = (x, y) => [...pixels.subarray((y * 640 + x) * 3, (y * 640 + x) * 3 + 3)];
  for (const edge of [0, 138, 502, 639]) assert.ok((rotation ? pixel(320, edge) : pixel(edge, 320)).every(value => value < 5));
  for (const center of [142, 320, 498]) assert.ok((rotation ? pixel(320, center) : pixel(center, 320))[2] > 245);
  assert.deepEqual(audio(result), originalAudio, 'The existing audio packets are copied unchanged');
  assert.deepEqual(await probeVideo(result), before, 'Dimensions, timing and audio availability remain unchanged');
});

test('border restoration leaves full-frame, changing and all-black sources untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'replica-no-borders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const kind of ['full', 'changing', 'black']) {
    const source = join(root, `${kind}.mp4`), result = join(root, `${kind}-result.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${kind === 'black' ? 'black' : 'blue'}:s=320x320:r=10:d=2`,
      ...(kind === 'changing' ? ['-vf', "drawbox=x=0:y=0:w=70:h=320:color=black:t=fill:enable='lt(t,1)',drawbox=x=250:y=0:w=70:h=320:color=black:t=fill:enable='lt(t,1)'"] : []),
      '-c:v', 'libx264', '-threads', '1', source]);
    await copyFile(source, result);
    const before = await readFile(result);
    assert.deepEqual(await restoreVideoBorders(source, result), { restored: false }, kind);
    assert.deepEqual(await readFile(result), before, kind);
  }
});

test('an unavailable border analysis preserves the generated video and returns a safe warning', async t => {
  const root = await mkdtemp(join(tmpdir(), 'replica-border-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = join(root, 'result.mp4');
  await writeFile(result, 'existing result');
  const check = await restoreVideoBorders(join(root, 'missing-source.mp4'), result);
  assert.equal(check.restored, false); assert.match(check.warning, /已保留成片/);
  assert.equal(await readFile(result, 'utf8'), 'existing result');
});
