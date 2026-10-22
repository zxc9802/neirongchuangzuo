import test from 'node:test';
import assert from 'node:assert/strict';
import { draftSnapshot, remapMaterialReferences, hasMissingReferences } from '../design/video-creator-drafts.js';
const image = id => ({ id, type: 'image' });
test('removing a material marks its references and renumbers surviving references in one pass', () => {
  const before = [image('a'), image('b'), image('c')];
  const result = remapMaterialReferences('@图片1开场，@图片2细节，@图片3结尾', before, [before[1], before[2]]);
  assert.equal(result, '[已移除图片1]开场，@图片1细节，@图片2结尾');
  assert.equal(hasMissingReferences(result), true);
  assert.equal(remapMaterialReferences(result, [before[1], before[2]], [before[1], before[2]]), result);
});
test('replacement keeps slot identity across uploaded IDs and does not confuse picture 1 with picture 10', () => {
  const before = Array.from({length: 10}, (_, i) => image('a'+i)), after = before.map((a,i) => image('b'+i));
  const mapping = Object.fromEntries(before.map((a,i) => [a.id, after[i].id]));
  assert.equal(remapMaterialReferences('@图片10 / @图片1', before, after, mapping), '@图片10 / @图片1');
  const audio = { id:'voice', type:'audio' };
  assert.equal(remapMaterialReferences('@声音1', [audio], [{id:'new-voice',type:'audio'}], {voice:'new-voice'}), '@声音1');
});
test('draft saves text, settings and planned material IDs without persisting media payloads', () => {
  const result = draftSnapshot({draftId:'d',session:{id:'c',assets:[{file:'large-private-payload'}]},settings:{duration:30},input:'编导要求',prompt:'@图片1',referenceImageIds:['one'],stage:'generation'});
  assert.equal(result.conversationId,'c'); assert.equal(result.prompt,'@图片1');
  assert.deepEqual(result.referenceImageIds,['one']); assert.equal(result.settings.duration,30);
  assert.equal(JSON.stringify(result).includes('large-private-payload'),false);
});
