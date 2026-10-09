import test from 'node:test';
import assert from 'node:assert/strict';
import { generationBody } from '../services/video/provider.mjs';

const task = overrides => ({
  duration: 15,
  ratio: '9:16',
  video: { duration: 12.3 },
  materials: { photo: { id: 'photo-1' }, video: { id: 'video-1' }, voice: { id: 'voice-1' } },
  ...overrides,
});

test('voice prompt includes measured lead-in, interior pause and output-tail silence', () => {
  const request = generationBody(task({
    voice: { duration: 5.8 },
    speech: { start: 0.16, segments: [
      { start: 0.16, end: 9.28, text: '不要九块九，不要八块九，甚至连六块钱都不要了。' },
      { start: 11.232, end: 12.282, text: '真的超好吃。' },
    ] },
  }));

  assert.match(request.prompt, /0\.000–0\.160秒；9\.280–11\.232秒；12\.282秒至成片结束必须保持静音/);
  assert.match(request.prompt, /0\.160–9\.280 秒：不要九块九，不要八块九，甚至连六块钱都不要了。/);
  assert.match(request.prompt, /11\.232–12\.282 秒：真的超好吃。/);
  assert.match(request.prompt, /每段仅说一次/);
  assert.match(request.prompt, /价格、数字、单位按原字说，不改写、不补全、不重复/);
  assert.match(request.prompt, /参考音频仅提供音色，不使用参考音频的台词/);
  assert.match(request.prompt, /不保留或混入原视频的人声/);
  assert.deepEqual(request.payload.referAudioUrl, ['asset://voice-1']);
});

test('a continuous full-duration speech track does not invent a silent gap', () => {
  const { prompt } = generationBody(task({
    duration: 6,
    video: { duration: 6 },
    voice: {},
    speech: { start: 0, segments: [
      { start: 0, end: 2.5, text: '前半段。' },
      { start: 2.5, end: 6, text: '后半段。' },
    ] },
  }));

  assert.doesNotMatch(prompt, /必须保持静音|秒至成片结束/);
  assert.match(prompt, /最后一段结束后不得补说或复读/);
});

test('rounded-up video duration freezes the end frame without removing real packaging text', () => {
  const { prompt, payload } = generationBody(task());

  assert.match(prompt, /参考视频实际时长为12\.300秒/);
  assert.match(prompt, /输出超过原视频时长的部分保持末帧静止、闭嘴和无声/);
  assert.match(prompt, /不增加动作、不重复片段、不延伸表演/);
  assert.match(prompt, /去除画面叠加的字幕/);
  assert.match(prompt, /保留真实商品包装与场景标识/);
  assert.doesNotMatch(prompt, /原视频人声从第|唯一台词依据/);
  assert.equal(payload.params.duration, 15);
  assert.equal('referAudioUrl' in payload, false);
});
