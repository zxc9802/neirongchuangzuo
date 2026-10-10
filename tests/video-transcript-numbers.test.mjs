import test from 'node:test';
import assert from 'node:assert/strict';
import { alignmentSegments, speechText } from '../services/video/speech.mjs';

function timeline(text) {
  return { text, start: 0, end: 1, segments: [{ text, start: 0, end: 1, words: [{ word: text, start: 0, end: 1 }] }] };
}

test('transcript validation rejects a changed decimal price before aligning audio', () => {
  assert.throws(() => alignmentSegments(timeline('现在9.9元。'), timeline('现在99元。')), /台词/);
  assert.throws(() => alignmentSegments(timeline('价格-5元'), timeline('价格+5元')), /台词/);
  assert.throws(() => alignmentSegments(timeline('9.9元'), timeline('9元')), /台词/);
});

test('ordinary punctuation and full-width decimal prices still match', () => {
  assert.equal(speechText('现在９．９元！'), speechText('现在9.9元。'));
  assert.equal(speechText('九块九，不要八块九。'), speechText('九块九不要八块九'));
  assert.equal(alignmentSegments(timeline('现在９．９元！'), timeline('现在9.9元。')).length, 1);
});

test('real price wording matches ASR Arabic digits without changing prices or currency words', () => {
  const confirmed = '关键价格还超级便宜，不要九块九，不要八块九，甚至连六块钱都不要了。';
  const recognized = '关键价格还超级便宜，不要9块9，不要8块9，甚至连6块钱都不要了。';
  assert.equal(speechText(confirmed), speechText(recognized));
  assert.deepEqual(alignmentSegments(timeline(confirmed), timeline(recognized)), [
    { start: 0, end: 1, targetStart: 0, targetEnd: 1, rate: 1 },
  ]);
  for (const wrong of [
    recognized.replace('9块9', '8块9'),
    recognized.replace('8块9', '8块8'),
    recognized.replace('6块钱', '6元钱'),
    recognized.replace('6块钱', '6块'),
    recognized + '不要9块9。',
  ]) assert.throws(() => alignmentSegments(timeline(confirmed), timeline(wrong)), { code: 'VIDEO_SPEECH_INVALID' });
  assert.equal(alignmentSegments(timeline(confirmed), timeline(recognized.replace('甚至连', '甚至'))).length, 1);
});

test('digit aliases preserve ASR word and segment boundaries during alignment', () => {
  const first = '不要九块九。', second = '不要八块九，甚至连六块钱都不要了。';
  const original = { text: first + second, segments: [
    { text: first, start: 0.16, end: 1.16 },
    { text: second, start: 2, end: 3.5 },
  ] };
  const generated = { text: '不要9块9。不要8块9，甚至连6块钱都不要了。', segments: [
    { start: 0.3, end: 1.3, words: [
      { word: '不要', start: 0.3, end: 0.5 }, { word: '9', start: 0.5, end: 0.7 },
      { word: '块', start: 0.7, end: 1 }, { word: '9', start: 1, end: 1.3 },
    ] },
    { start: 2.2, end: 3.7, words: [
      { word: '不要', start: 2.2, end: 2.4 }, { word: '8块9', start: 2.4, end: 2.7 },
      { word: '甚至连6块钱都不要了', start: 2.7, end: 3.7 },
    ] },
  ] };
  const aligned = alignmentSegments(original, generated);
  assert.equal(aligned.length, 2);
  assert.deepEqual(aligned.map(({ start, end, targetStart, targetEnd }) => ({ start, end, targetStart, targetEnd })), [
    { start: 0.3, end: 1.3, targetStart: 0.16, targetEnd: 1.16 },
    { start: 2.2, end: 3.7, targetStart: 2, targetEnd: 3.5 },
  ]);
  assert.ok(aligned.every(({ rate }) => Math.abs(rate - 1) < 1e-12));
});

test('single Chinese digits are spelling aliases, not amount interpretation or fuzzy matching', () => {
  for (const [chinese, arabic] of [['〇', '0'], ['零', '0'], ['一', '1'], ['二', '2'], ['三', '3'], ['四', '4'], ['五', '5'], ['六', '6'], ['七', '7'], ['八', '8'], ['九', '9']]) {
    assert.equal(alignmentSegments(timeline(`价格${chinese}元`), timeline(`价格${arabic}元`)).length, 1);
  }
  for (const [confirmed, recognized] of [
    ['吃了上万种零食', '吃了3万种零食'],
    ['吃了上万种零食', '吃了三万种零食'],
    ['九十九元', '99元'], ['十九元', '19元'], ['两元', '2元'],
    ['九块九', '9.9'], ['唯一一次机会', '唯一两次机会'],
  ]) assert.throws(() => alignmentSegments(timeline(confirmed), timeline(recognized)), { code: 'VIDEO_SPEECH_INVALID' });
});

test('digit spelling does not erase decimal separators or signed price differences', () => {
  assert.equal(speechText('-五元'), speechText('-5元'));
  assert.equal(speechText('+五元'), speechText('+5元'));
  assert.equal(speechText('九.九元'), speechText('9.9元'));
  for (const [confirmed, recognized] of [
    ['-五元', '+5元'], ['-五元', '5元'], ['+五元', '5元'],
    ['九.九元', '99元'], ['九.九元', '9元'], ['9.9元', '9.99元'],
  ]) assert.throws(() => alignmentSegments(timeline(confirmed), timeline(recognized)), { code: 'VIDEO_SPEECH_INVALID' });
});
