import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { planSegments, speechPauses, detectSceneCuts, cutVideoSegment, joinVideoSegments } from '../services/video/segments.mjs';
import { probeVideo } from '../services/video/media.mjs';

const PREMIUM = { maxSegment: 30, durations: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30] };
const spans = plan => plan.segments.map(segment => [segment.start, segment.end, segment.duration]);

test('a reference within one generation tier is not split', () => {
  for (const duration of [4, 29.9, 30, 30.04]) assert.equal(planSegments(duration, PREMIUM), null);
  assert.ok(planSegments(30.06, PREMIUM));
});

test('a 60-second reference splits into two full 30-second generations', () => {
  const plan = planSegments(60, { ...PREMIUM, fps: 30 });
  assert.equal(plan.boundary, 'duration');
  assert.deepEqual(spans(plan), [[0, 30, 30], [30, 60, 30]]);
});

test('without boundaries the seam wastes no paid seconds and stays near the middle', () => {
  const plan = planSegments(45, PREMIUM);
  assert.equal(plan.boundary, 'duration');
  assert.deepEqual(spans(plan), [[0, 20, 20], [20, 45, 25]]);
});

test('a hard cut inside the allowed window wins over speech pauses and lands on a source frame', () => {
  const plan = planSegments(45, { ...PREMIUM, fps: 30, cuts: [10, 21.03], pauses: [{ start: 19.8, end: 20.4 }] });
  assert.equal(plan.boundary, 'scene');
  assert.deepEqual(spans(plan), [[0, 21.033, 25], [21.033, 45, 25]]);
});

test('without a usable cut the seam sits in the longest cheapest speech pause, clamped to the window', () => {
  const pauses = [{ start: 16.9, end: 17.3 }, { start: 22, end: 23.5 }, { start: 3, end: 8 }];
  const plan = planSegments(45, { ...PREMIUM, cuts: [5, 40], pauses });
  assert.equal(plan.boundary, 'pause');
  assert.deepEqual(spans(plan), [[0, 22.75, 25], [22.75, 45, 25]]);
  const edge = planSegments(45, { ...PREMIUM, pauses: [{ start: 10, end: 16 }] });
  assert.deepEqual(spans(edge), [[0, 15, 15], [15, 45, 30]]);
});

test('a reference longer than two generations is rejected before any work', () => {
  assert.throws(() => planSegments(61, PREMIUM), error => error.code === 'VIDEO_DURATION_INVALID' && /4–30 秒/.test(error.message));
});

test('speech pauses ignore short breaths and unordered or invalid intervals', () => {
  assert.deepEqual(speechPauses([{ start: 5, end: 9 }, { start: 0.2, end: 2 }, { start: 2.1, end: 4.8 }, { start: 3, end: 3 }, null]), []);
  assert.deepEqual(speechPauses([{ start: 0, end: 2 }, { start: 2.5, end: 4 }, { start: 4.1, end: 6 }]), [{ start: 2, end: 2.5 }]);
});

test('ffmpeg finds hard cuts, cuts an exact source span and joins parts back onto the source timeline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'video-segments-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x480:r=30:d=3', '-f', 'lavfi', '-i', 'color=c=blue:s=320x480:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  const scenes = await detectSceneCuts(source);
  assert.equal(scenes.fps, 30);
  assert.equal(scenes.cuts.length, 1); assert.ok(Math.abs(scenes.cuts[0] - 3) < 0.05);

  const part = join(root, 'segment-1.mp4');
  const cut = await cutVideoSegment(source, part, 2, 5);
  assert.ok(Math.abs(cut.duration - 3) < 0.1); assert.equal(cut.audio, true);

  // Generated parts differ in size, frame rate and length; the join trims or pads each to its span.
  const first = join(root, 'first.mp4'), second = join(root, 'second.mp4'), joined = join(root, 'joined.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x480:r=24:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', first]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=2.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', second]);
  const result = await joinVideoSegments([first, second], [{ start: 0, end: 3.5 }, { start: 3.5, end: 6.25 }], joined);
  assert.ok(Math.abs(result.duration - 6.25) < 0.1, `joined ${result.duration}`);
  const metadata = await probeVideo(joined);
  assert.equal(metadata.width, 320); assert.equal(metadata.height, 480); assert.equal(metadata.audio, false);

  await assert.rejects(cutVideoSegment(join(root, 'missing.mp4'), join(root, 'never.mp4'), 0, 2), error => error.code === 'VIDEO_SEGMENT_PENDING');
  await assert.rejects(joinVideoSegments([join(root, 'missing.mp4')], [{ start: 0, end: 2 }], join(root, 'never.mp4')),
    error => error.code === 'VIDEO_SEGMENT_JOIN_PENDING');
});
