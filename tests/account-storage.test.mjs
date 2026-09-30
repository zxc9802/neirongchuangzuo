import test from 'node:test';
import assert from 'node:assert/strict';
import { accountStorageKey } from '../design/account-storage.js';

test('browser draft keys separate users and leave the original local preview data intact', () => {
  try {
    globalThis.workspaceUser = null;
    assert.equal(accountStorageKey('drafts'), 'drafts');
    globalThis.workspaceUser = { id: 'account_alice' };
    const alice = accountStorageKey('drafts');
    globalThis.workspaceUser = { id: 'internal_bob' };
    assert.notEqual(accountStorageKey('drafts'), alice);
    globalThis.workspaceUser = { id: 'account_alice' };
    assert.equal(accountStorageKey('drafts'), alice);
  } finally { delete globalThis.workspaceUser; }
});
