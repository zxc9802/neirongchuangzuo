import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generationBody, createVideoProvider, MODELS, PIXVERSE_MODEL, WAN3_MODEL } from '../services/video/provider.mjs';
import { wan3GenerationBody } from '../services/video/wan3.mjs';
import { restoreSourceAudio, probeVideo } from '../services/video/media.mjs';

const models = MODELS.filter(model => model.id !== PIXVERSE_MODEL);
const kinds = ['photo', 'product', 'background', 'voice'];
for (const model of models) test(`deep ${model.id}: all 16 combinations map only enabled images to the right references`, () => {
  for (let mask = 0; mask < 16; mask++) {
    const replacements = Object.fromEntries(kinds.map((kind, bit) => [kind, Boolean(mask & (1 << bit))]));
    const selectedImages = kinds.slice(0, 3).filter(kind => replacements[kind]);
    const task = { mode: 'deep', model: model.id, replacements, video: { duration: 4 },
      voiceEngine: replacements.voice ? 'chatterbox' : 'seedance', ...(replacements.voice ? { voice: {} } : {}),
      materials: Object.fromEntries(['video', ...selectedImages].map(kind => [kind, { id: kind + '-asset' }])) };
    const body = model.id === WAN3_MODEL ? wan3GenerationBody(task) : generationBody(task);
    const prompt = body.prompt || body.input.prompt;
    if (model.id === WAN3_MODEL) {
      assert.deepEqual(body.input.media, [...selectedImages.map(kind => ({ type: 'reference_image', url: kind + '-asset' })), { type: 'reference_video', url: 'video-asset' }]);
      assert.equal(body.parameters.audio, false);
    } else {
      assert.deepEqual(body.payload.resources, selectedImages.map(kind => `asset://${kind}-asset`));
      assert.deepEqual(body.payload.referVideoUrl, ['asset://video-asset']);
      assert.equal(body.payload.params.generateAudio, false);
      assert.equal(body.payload.referAudioUrl, undefined);
    }
    for (const [kind, phrase] of [['photo', '脸部外貌和发型'], ['product', '中展示的商品'], ['background', '的场景背景']]) {
      if (replacements[kind]) assert.match(prompt, new RegExp(`${phrase}替换为(?:图片|图)${selectedImages.indexOf(kind) + 1}`));
      else assert.match(prompt, new RegExp(`不得替换${{ photo: '人物', product: '商品', background: '背景' }[kind]}`));
    }
    assert.doesNotMatch(prompt, /唯一人物完整替换为图片1|人物外观替换为图片1|去水印/);
  }
});

test('product and background are registered as images with the material provider', async () => {
  const requests = [];
  const credentials = { base: 'https://provider.example', project: 'test', access: 'test', secret: 'test' };
  const provider = createVideoProvider({ video: credentials, material: credentials }, async (_url, options) => {
    requests.push(JSON.parse(options.body)); return Response.json({ data: { materialId: 'image', status: 2 } });
  });
  for (const kind of ['photo', 'product', 'background']) await provider.createMaterial(`https://workspace.example/${kind}`, kind);
  assert.deepEqual(requests.map(body => body.fileType), [1, 1, 1]);
});

for (const audio of [true, false]) test(`original audio restoration removes model audio and preserves source audio=${audio}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deep-audio-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.mp4'), generated = join(root, 'generated.mp4'), result = join(root, 'result.mp4');
  const make = (path, seconds, frequency) => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x320:r=25',
    ...(frequency ? ['-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=16000`] : []),
    '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(frequency ? ['-c:a', 'aac'] : ['-an']), path]);
  make(source, 2, audio ? 440 : null); make(generated, 3, 880);
  await restoreSourceAudio(source, generated, result);
  const metadata = await probeVideo(result);
  assert.equal(metadata.audio, audio); assert.ok(Math.abs(metadata.duration - 2) < .15);
  if (audio) {
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', result, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
    let crossings = 0;
    for (let index = 2; index < pcm.length; index += 2) if (pcm.readInt16LE(index - 2) <= 0 && pcm.readInt16LE(index) > 0) crossings++;
    assert.ok(Math.abs(crossings / (pcm.length / 2 / 16000) - 440) < 5, 'the source tone, not the model tone, must be audible');
  }
});
