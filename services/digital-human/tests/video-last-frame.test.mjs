import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';
import * as media from '../src/lib/engine/ffmpeg.ts';

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

function assertColor(file, time, color) {
  const pixel = ffmpeg(['-ss', String(time), '-i', file, '-frames:v', '1',
    '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.equal(pixel.length, 3, `missing frame at ${time}s`);
  assert.ok(pixel[color] > 200 && pixel[2 - color] < 20,
    `frame at ${time}s should retain ${color === 2 ? 'the blue last frame' : 'the red opening'}; got ${[...pixel]}`);
}

function fixture(dir) {
  const silent = path.join(dir, 'silent.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=160x128:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=blue:s=160x128:r=30:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', silent]);
  const sound = path.join(dir, 'sound.mp4');
  const longerAudio = path.join(dir, 'longer-audio.mp4');
  for (const [output, duration] of [[sound, 2], [longerAudio, 5]]) {
    ffmpeg(['-i', silent, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`,
      '-c:v', 'copy', '-c:a', 'aac', output]);
  }
  return { silent, sound, longerAudio };
}

test('short source keeps its original motion and holds the final frame through the longer narration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-last-frame-'));
  try {
    for (const [name, input] of Object.entries(fixture(dir))) {
      const output = path.join(dir, `${name}-extended.mp4`);
      await media.prepareSourceVideo(input, 3.5, output);
      const probe = await media.probeMedia(output);
      assert.ok(Math.abs(probe.videoDurationSeconds - 3.5) < 0.05, name);
      assert.ok(probe.hasAudio, 'lip-sync providers still receive an audio track');
      assertColor(output, 0.4, 0);
      assertColor(output, 1.4, 2);
      for (const time of [2.2, 2.8, 3.4]) assertColor(output, time, 2);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('narration recovery also holds the last frame when only the shorter original video remains', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narration-last-frame-'));
  try {
    const { silent } = fixture(dir);
    const jobDir = path.join(dir, 'job'); fs.mkdirSync(jobDir);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=3.5', path.join(jobDir, 'voice-track.wav')]);
    let task = { id: 'job', status: 'failed', createdAt: Date.now(), updatedAt: Date.now(),
      inputs: { outputType: 'video', videoPath: silent, scriptText: '完整配音' }, results: {} };
    const deps = { fs, path, './ffmpeg': media,
      './video-preview': { createVideoPreview: async () => undefined },
      '../config': { getAppConfig: () => ({ storageDir: dir }) },
      '../cos': { CosService: { isConfigured: () => false } },
      '../main-app-billing': { releaseMainAppCredits: () => assert.fail('internal fixture needs no refund') },
      '../media-path-policy': { resolveAllowedLocalMediaPath: value => value },
      '../server/media-response': { downloadTrustedMediaToFile: () => assert.fail('local fixture needs no download') },
      '../server/task-worker': { withTaskBillingGuard: async (_id, action) => action() },
      '../store/task-store': { TaskStore: { get: () => task, isDeleted: () => false, addLog() {},
        update: (_id, value) => task = { ...task, ...value, results: { ...task.results, ...value.results } } } },
      '../task-output-retention': { isTaskOutputExpired: () => false },
    };
    const source = fs.readFileSync(new URL('../src/lib/engine/narration-fallback.ts', import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', code)(name => {
      assert.ok(name in deps, `unexpected dependency ${name}`); return deps[name];
    }, module, module.exports);
    const result = await module.exports.deliverNarrationFallback('job');
    assert.equal(result.results.deliveryMode, 'narration_fallback');
    assert.ok(Math.abs(result.results.videoDuration - 3.5) < 0.05);
    assertColor(result.results.finalVideoUrl, 0.4, 0);
    for (const time of [2.2, 2.8, 3.4]) assertColor(result.results.finalVideoUrl, time, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
