import test from 'node:test';
import assert from 'node:assert/strict';
import { alignmentSegments, compareSpeech } from '../services/video/speech.mjs';

const first = '这款饼干又薄又脆打开包装就能闻到浓浓的香味吃起来清爽可口适合大家分享';
const second = '真的超级好吃';
function timeline(parts) {
  const segments = parts.map((text, index) => ({ text, start: index * 2, end: index * 2 + 1,
    words: Array.from(text, (word, i) => ({ word, start: index * 2 + i / text.length, end: index * 2 + (i + 1) / text.length })) }));
  return { text: parts.join(''), start: 0, end: segments.at(-1).end, segments };
}

test('minor differences require both at most five characters and at most ten percent', () => {
  const expected = first + second + '香酥美味全家都爱分享';
  const changed = (text, count) => '甲'.repeat(count) + text.slice(count);
  assert.equal(expected.length, 50);
  assert.deepEqual(compareSpeech(expected, expected).differences, 0);
  assert.equal(compareSpeech(expected, changed(expected, 5)).accepted, true);
  assert.equal(compareSpeech(expected, changed(expected, 5)).differences, 5);
  assert.equal(compareSpeech(expected.repeat(2), changed(expected.repeat(2), 6)).accepted, false);
  const shorter = expected.slice(0, -1);
  assert.equal(compareSpeech(shorter, changed(shorter, 4)).accepted, true);
  assert.equal(compareSpeech(shorter, changed(shorter, 5)).accepted, false);
  assert.equal(compareSpeech('真的好吃', '真的好喝').accepted, false);
});

test('minor insertions, deletions and substitutions preserve every original speech window', () => {
  const original = timeline([first, second]);
  for (const changed of [first.replace('包装', '包妆'), first.replace('包装', '包装呀'), first.replace('包装', '包')]) {
    const generated = timeline([changed, second]);
    assert.equal(compareSpeech(original.text, generated.text).accepted, true);
    const aligned = alignmentSegments(original, generated);
    assert.deepEqual(aligned.map(({ start, end, targetStart, targetEnd }) => ({ start, end, targetStart, targetEnd })), [
      { start: 0, end: 1, targetStart: 0, targetEnd: 1 },
      { start: 2, end: 3, targetStart: 2, targetEnd: 3 },
    ]);
  }
});

test('a missing whole phrase cannot pass even when it is only one character of a long script', () => {
  const original = timeline([first + second, '好']);
  const generated = timeline([first + second]);
  assert.equal(compareSpeech(original.text, generated.text).accepted, true);
  assert.throws(() => alignmentSegments(original, generated), { code: 'VIDEO_SPEECH_INVALID' });
});

test('minor tolerance never changes numeric amounts, price units or number signs', () => {
  const prefix = first + second;
  for (const [expected, actual] of [['9.9元', '99元'], ['九块九', '八块九'], ['6块钱', '6元钱'], ['6块钱', '6块'], ['-5元', '+5元'], ['十元', '百元'], ['两元', '十元']]) {
    assert.equal(compareSpeech(prefix + expected, prefix + actual).accepted, false);
  }
  assert.equal(compareSpeech(prefix + '九块九', prefix + '9块9').exact, true);
});
