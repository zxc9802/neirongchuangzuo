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
