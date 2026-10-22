import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { probeVideo } from '../services/video/media.mjs';

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
