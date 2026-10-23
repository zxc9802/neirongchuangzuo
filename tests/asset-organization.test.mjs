import test from 'node:test';
import assert from 'node:assert/strict';
import { organizeAssets, relativeAssetMove } from '../design/asset-organization.js';

test('stored order and trash apply equally to uploads and generated assets without modifying originals', () => {
  const items = ['material:a', 'material:b', 'image:c:0', 'video:d'].map(key => ({ key }));
  const organization = { order: ['video:d', 'material:b', 'material:a'], deleted: ['material:b'] };
  assert.deepEqual(organizeAssets(items, organization).map(x => x.key), ['video:d', 'material:a', 'image:c:0']);
  assert.deepEqual(organizeAssets(items, organization, true).map(x => x.key), ['material:b']);
  assert.equal(items[0].key, 'material:a');
  assert.equal(relativeAssetMove(items, 'material:a', -1), null);
  assert.equal(relativeAssetMove(items, 'missing', 1), null);
  assert.deepEqual(relativeAssetMove(items, 'material:b', 1), {action:'move',keys:['material:b'],target:'image:c:0',position:'after'});
});
