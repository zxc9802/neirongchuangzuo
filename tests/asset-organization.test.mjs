import test from 'node:test';
import assert from 'node:assert/strict';
import { organizeAssets, relativeAssetMove } from '../design/asset-organization.js';

test('newest saved or completed assets come first regardless of legacy order, preserving trash and source input', () => {
  const items = [{ key: 'material:a', createdAt: 100 }, { key: 'material:b', createdAt: 400 }, { key: 'image:c:0', completed: 300 }, { key: 'video:d', completed: 200 }];
  const organization = { order: ['material:a', 'video:d', 'material:b'], deleted: ['material:b'] };
  assert.deepEqual(organizeAssets(items, organization).map(x => x.key), ['image:c:0', 'video:d', 'material:a']);
  assert.deepEqual(organizeAssets(items, organization, true).map(x => x.key), ['material:b']);
  assert.equal(items[0].key, 'material:a');
  assert.equal(relativeAssetMove(items, 'material:a', -1), null);
  assert.equal(relativeAssetMove(items, 'missing', 1), null);
  assert.deepEqual(relativeAssetMove(items, 'material:b', 1), {action:'move',keys:['material:b'],target:'image:c:0',position:'after'});
});

test('equal timestamps keep stable order and invalid dates do not hide newer assets', () => {
  const items = [{ key: 'old', createdAt: NaN }, { key: 'first', createdAt: 10 }, { key: 'second', createdAt: 10 }];
  assert.deepEqual(organizeAssets(items, { order: ['old', 'second', 'first'] }).map(x => x.key), ['first', 'second', 'old']);
});
