import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { captionSpeech, createCaptionService } from '../services/video/captions.mjs';
import { generationBody } from '../services/video/provider.mjs';

const run = promisify(execFile);
const python = process.env.VIDEO_PYTHON_BIN || process.env.MIX_PYTHON_BIN || 'python3';
const available = await run(python, ['-c', 'import rapidocr_onnxruntime, cv2, PIL']).then(() => true, () => false);

test('caption wording overrides misheard speech while retaining VAD openings and pauses', () => {
  const captions = { engine: 'rapidocr', cues: [
    { start: .1, end: 1, text: '因为姐妹想看我吃生腌' }, { start: 1, end: 2, text: '有寄生虫的' },
    { start: 2.8, end: 3.5, text: '只要9.9元' },
  ] };
  const timeline = captionSpeech(captions, [{ start: .032, end: 1.9, text: '我吃生烟', words: [] }, { start: 2.75, end: 3.4 }]);
  assert.equal(timeline.text, '因为姐妹想看我吃生腌有寄生虫的只要9.9元');
  assert.equal(timeline.start, .032); assert.equal(timeline.segments[1].start, 2.75);
  const { prompt, payload } = generationBody({ duration: 4, video: { duration: 3.5 }, ratio: '9:16', speech: timeline, captions,
    materials: { photo: { id: 'photo' }, video: { id: 'video' } } });
  assert.match(prompt, /台词来自原视频字幕，优先于听辨结果/); assert.match(prompt, /只要9.9元/);
  assert.doesNotMatch(prompt, /生烟/); assert.equal('referAudioUrl' in payload, false);
});

test('embedded and burned captions preserve text, prices and cue times without changing audio', { skip: !available }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'video-captions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'base.mp4'), soft = join(root, 'soft.mp4'), burned = join(root, 'burned.mp4');
  const srt = join(root, 'source.srt');
  await writeFile(srt, '1\n00:00:00,400 --> 00:00:01,400\n因为姐妹想看我吃生腌\n\n2\n00:00:02,000 --> 00:00:03,400\n只要9.9元\n');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x456789:s=512x768:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base]);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', base, '-i', srt, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', soft]);
  const service = createCaptionService({ VIDEO_PYTHON_BIN: python });
  const embedded = await service.extract(soft);
  assert.equal(embedded.kind, 'embedded');
  assert.deepEqual(embedded.cues.map(cue => [cue.start, cue.end, cue.text]),
    [[.4, 1.4, '因为姐妹想看我吃生腌'], [2, 3.4, '只要9.9元']]);
  await service.render(base, burned, embedded);
  const extracted = await service.extract(burned);
  assert.equal(extracted.kind, 'burned');
  assert.deepEqual(extracted.cues.map(cue => cue.text), embedded.cues.map(cue => cue.text));
  for (let i = 0; i < embedded.cues.length; i++) {
    assert.ok(Math.abs(extracted.cues[i].start - embedded.cues[i].start) <= .11);
    assert.ok(Math.abs(extracted.cues[i].end - embedded.cues[i].end) <= .11);
  }
  const clean = join(root, 'clean.mp4');
  await service.clean(burned, clean, extracted);
  assert.equal(await service.extract(clean), null);
  const corrected = { ...embedded, cues: embedded.cues.map((cue, i) => ({ ...cue, text: i ? '只要8.8元' : cue.text })) };
  const final = join(root, 'final.mp4');
  await service.render(burned, final, corrected);
  const output = await service.extract(final);
  assert.deepEqual(output.cues.map(cue => cue.text), ['因为姐妹想看我吃生腌', '只要8.8元']);
  async function audioHash(path) {
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 });
    return createHash('sha256').update(stdout).digest('hex');
  }
  assert.equal(await audioHash(final), await audioHash(base));
  assert.equal(await service.extract(base), null);
});

test('stationary packaging or a logo is not used as dialogue', { skip: !available }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'video-caption-logo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'base.mp4'), logo = join(root, 'logo.mp4');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x456789:s=512x768:r=25:d=2',
    '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', base]);
  const service = createCaptionService({ VIDEO_PYTHON_BIN: python });
  await service.render(base, logo, { kind: 'embedded', width: 512, height: 768,
    cues: [{ start: 0, end: 2, text: '起芽品牌', box: [160, 350, 350, 390] }] });
  assert.equal(await service.extract(logo), null);
});
