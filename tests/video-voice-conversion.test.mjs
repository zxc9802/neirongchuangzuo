import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createVoiceConversionService, VOICE_CONVERSION_MODEL } from '../services/video/voice-conversion.mjs';
import { generationBody } from '../services/video/provider.mjs';

const receipt = { request_id: 'conversion-1', status_url: 'https://queue.fal.run/fal-ai/chatterbox/requests/conversion-1/status',
  response_url: 'https://queue.fal.run/fal-ai/chatterbox/requests/conversion-1' };
function wav(seconds = 4) {
  const samples = Math.round(24000 * seconds), data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(10000 * Math.sin(i * 2 * Math.PI * 300 / 24000)), 44 + i * 2);
  return data;
}
async function fixture(t, options = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'voice-conversion-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'source.mp4'), wav());
  await writeFile(join(folder, 'reference.wav'), wav(3));
  const task = { video: { audio: true, duration: 4 }, voice: { ready: true } }, calls = [], saves = [];
  const service = createVoiceConversionService({ FAL_KEY: 'test-only-key' }, {
    upload: async path => 'https://fal.media/' + path.split(/[\\/]/).at(-1),
    download: async (_url, path) => writeFile(path, wav(options.duration ?? 3.88)),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      assert.equal(init.headers.Authorization, 'Key test-only-key');
      if (init.method === 'POST') {
        assert.equal(saves.at(-1).submitting, true);
        assert.deepEqual(JSON.parse(init.body), { source_audio_url: 'https://fal.media/conversion-source.wav', target_voice_audio_url: 'https://fal.media/reference.wav' });
        if (options.submitError) throw options.submitError;
        return Response.json(options.receipt || receipt);
      }
      return Response.json(String(url).endsWith('/status') ? { status: 'COMPLETED' } : { audio: { url: 'https://v3.fal.media/converted.wav' } });
    }, ...options.dependencies,
  });
  const save = async () => saves.push(structuredClone(task.voiceConversion));
  return { folder, task, calls, saves, service, save, advance: () => service.advance(task, folder, save) };
}

test('converts the whole original audio once, resumes its receipt and muxes without changing video cadence', async t => {
  const f = await fixture(t);
  await f.advance();
  f.task.voiceConversion = JSON.parse(JSON.stringify(f.task.voiceConversion));
  await f.advance(); await f.advance();
  assert.equal(f.task.voiceConversion.ready, true);
  assert.equal(f.task.voiceConversion.duration, 3.88);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.calls[0].url, `https://queue.fal.run/${VOICE_CONVERSION_MODEL}`);
  const video = join(f.folder, 'generated.mp4'), output = join(f.folder, 'result.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=160x240:r=15:d=4', '-c:v', 'libx264', video]);
  await f.service.mux(video, join(f.folder, 'converted-voice.wav'), output, 4);
  const frames = file => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-']).toString();
  assert.equal(frames(video), frames(output));
  const meta = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', output]));
  assert.equal(Number(meta.format.duration), 4);
  assert(meta.streams.some(s => s.codec_type === 'audio'));
});

test('an uncertain submission or invalid queue receipt never repeats the paid request', async t => {
  for (const options of [{ submitError: new Error('disconnected') }, { receipt: { ...receipt, status_url: 'https://evil.example/status' } }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.advance(), { code: 'VIDEO_CONVERSION_UNCERTAIN' });
    await assert.rejects(f.advance(), { code: 'VIDEO_CONVERSION_UNCERTAIN' });
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  }
});

test('audio that starts after the first video frame retains its leading silence', async t => {
  const f = await fixture(t);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=160x240:r=25:d=4',
    '-itsoffset', '0.4', '-f', 'lavfi', '-i', 'sine=duration=3.6', '-c:v', 'libx264', '-c:a', 'aac', join(f.folder, 'source.mp4')]);
  await f.advance();
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', join(f.folder, 'conversion-source.wav'), '-t', '0.25', '-f', 's16le', '-']);
  assert(pcm.length > 1000);
  for (let i = 0; i < pcm.length; i += 2) assert(Math.abs(pcm.readInt16LE(i)) < 10);
});

test('a credit rejection before dispatch remains safely resumable', async t => {
  const f = await fixture(t, { submitError: Object.assign(new Error('no credits'), { providerNotDispatched: true }) });
  await assert.rejects(f.advance(), { providerNotDispatched: true });
  assert.equal(f.task.voiceConversion.submitting, undefined);
  assert.equal(f.task.voiceConversion.failed, undefined);
});

test('download retry uses the same generated audio and no new generation', async t => {
  let downloads = 0;
  const f = await fixture(t, { dependencies: { download: async (_url, path) => {
    if (!downloads++) throw new Error('network');
    await writeFile(path, wav());
  } } });
  await f.advance();
  await assert.rejects(f.advance(), { code: 'VIDEO_CONVERSION_PENDING' });
  await f.advance();
  assert.equal(f.task.voiceConversion.ready, true);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(downloads, 2);
});

test('shorter and longer converted audio remain deliverable without regenerating speech', async t => {
  for (const duration of [3, 5]) {
    const f = await fixture(t, { duration });
    await f.advance(); await f.advance(); await f.advance();
    assert.equal(f.task.voiceConversion.ready, true);
    assert.equal(f.task.voiceConversion.duration, duration);
    assert.equal(f.task.voiceConversion.failed, undefined);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
    const video = join(f.folder, 'generated.mp4'), output = join(f.folder, 'result.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=160x240:r=15:d=4', '-c:v', 'libx264', video]);
    await f.service.mux(video, join(f.folder, 'converted-voice.wav'), output, 4);
    const meta = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', output]));
    assert.equal(Number(meta.format.duration), 4);
    assert(meta.streams.some(stream => stream.codec_type === 'audio'));
  }
});

test('video model receives original video and lip-motion instructions without a second voice reference', () => {
  const body = generationBody({ voiceEngine: 'chatterbox', sourceAudioMode: 'original', voice: {}, video: { duration: 8 },
    materials: { photo: { id: 'photo' }, video: { id: 'source' } } });
  assert.equal(body.payload.params.generateAudio, false);
  assert.equal(body.payload.referAudioUrl, undefined);
  assert.deepEqual(body.payload.referVideoUrl, ['asset://source']);
  assert.match(body.prompt, /逐帧保留.*嘴唇动作/);
  assert.match(body.prompt, /8\.000秒/);
});
