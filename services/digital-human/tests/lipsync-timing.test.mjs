import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { concatVideos, finalizeVideo, prepareSourceVideo, probeMedia } from '../src/lib/engine/ffmpeg.ts';
import { planLipsyncChunks } from '../src/lib/engine/lipsync-chunks.ts';
import { toPublicTask } from '../src/lib/server/public-data.ts';

const ffmpeg = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 4 * 1024 * 1024 });

test('duration failures give the website an actionable message without publishing a video', () => {
  const task = toPublicTask({ id: 'timing-failure', createdAt: Date.now(), updatedAt: Date.now(),
    status: 'failed', step: 'error', progress: 85, logs: [], inputs: {}, results: {},
    error: 'private diagnostic', errorCode: 'LIPSYNC_DURATION_MISMATCH' });
  assert.match(task.error, /画面时长与配音不一致/u);
  assert.equal(task.results.finalVideoUrl, undefined);
});

test('chunk plans retain short tails without creating subsecond provider jobs', () => {
  for (const seconds of [98.1, 180.1, 180.3, 180.39, 270.3]) {
    const chunks = planLipsyncChunks(seconds);
    assert.ok(Math.abs(chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0) - seconds) < 0.000001);
    assert.ok(chunks.every(chunk => chunk.durationSeconds >= 0.4 && chunk.durationSeconds <= 98));
    for (let i = 1; i < chunks.length; i++) {
      assert.equal(chunks[i].startSeconds, chunks[i - 1].startSeconds + chunks[i - 1].durationSeconds);
    }
  }
});

test('real media keeps video timing independent of the source audio duration', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-timing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = name => path.join(dir, name);
  function segment(name, color, videoSeconds, audioSeconds) {
    ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=160x120:r=30:d=${videoSeconds}`,
      '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${audioSeconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', at(name)]);
  }
  segment('first.mp4', 'black', 2, 2.3);
  segment('second.mp4', 'white', 2, 2);
  ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=4', '-c:a', 'pcm_s16le', at('voice.wav')]);

  await t.test('concatenation starts the second picture at the end of the first picture', async () => {
    await concatVideos([at('first.mp4'), at('second.mp4')], at('joined.mp4'));
    const frames = ffmpeg(['-i', at('joined.mp4'), '-an', '-vf', 'scale=1:1,format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
    const timestamps = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', at('joined.mp4')], { encoding: 'utf8' })).frames;
    const secondStart = Number(timestamps[[...frames].findIndex(value => value > 200)].best_effort_timestamp_time);
    assert.ok(Math.abs(secondStart - 2) <= 1 / 30, `second segment starts at ${secondStart}s`);
  });

  await t.test('source preparation covers narration when source audio outlasts the picture', async () => {
    await prepareSourceVideo(at('first.mp4'), 2.2, at('prepared.mp4'));
    const probe = await probeMedia(at('prepared.mp4'));
    assert.ok(Math.abs(probe.videoDurationSeconds - 2.2) <= 1 / 30);
  });

  await t.test('finalization rejects a picture shorter than narration before writing a deliverable', async () => {
    await assert.rejects(finalizeVideo(at('first.mp4'), at('voice.wav'), at('bad-final.mp4')),
      error => error.code === 'LIPSYNC_DURATION_MISMATCH');
    assert.equal(fs.existsSync(at('bad-final.mp4')), false);
  });

  await t.test('finalization rejects a picture longer than narration', async () => {
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=30:d=5', '-c:v', 'libx264', '-preset', 'ultrafast', at('long.mp4')]);
    await assert.rejects(finalizeVideo(at('long.mp4'), at('voice.wav'), at('long-final.mp4')),
      error => error.code === 'LIPSYNC_DURATION_MISMATCH');
  });

  await t.test('finalization accepts normal frame rounding and preserves the exact narration', async () => {
    segment('normal.mp4', 'black', 3.966667, 4);
    const probe = await finalizeVideo(at('normal.mp4'), at('voice.wav'), at('final.mp4'));
    assert.equal(probe.hasAudio, true);
    assert.ok(Math.abs(probe.durationSeconds - 4) < 0.04);
  });
});
