import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digitalHumanApi as api } from '../design/digital-human-api.js';

const avatar = { id: 'avatar-1', name: '老板', createdAt: 100 };
const page = {
  items: [{ kind: 'avatar', id: avatar.id, createdAt: avatar.createdAt, avatar }],
  nextCursor: 'opaque-cursor', hasMore: true, total: 14,
  counts: { all: 16, avatars: 14, tasks: 2 },
  selection: { avatar }, activeTasks: [{ id: 'active-1', status: 'processing' }],
};

test('library adapter preserves the page contract and safely encodes cursor and selection', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(url, 'https://example.test');
    assert.equal(request.pathname, '/api/digital-human/library');
    assert.deepEqual(Object.fromEntries(request.searchParams), {
      kind: 'avatars', limit: '12', cursor: 'opaque+/token', avatarId: 'a/1', taskId: 't?1',
    });
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'same-origin');
    return Response.json(page);
  });
  assert.deepEqual(await api.listLibrary({ kind: 'avatars', cursor: 'opaque+/token', avatarId: 'a/1', taskId: 't?1' }), page);
});

test('library adapter rejects incomplete pages and inconsistent pagination metadata', async t => {
  const invalid = [
    {},
    { ...page, items: [{ kind: 'avatar', id: 'wrong', createdAt: 100, avatar }] },
    { ...page, nextCursor: null },
    { ...page, counts: { all: 1 } },
    { ...page, selection: [] },
    { ...page, activeTasks: [{ id: 'done', status: 'completed' }] },
  ];
  t.mock.method(globalThis, 'fetch', async () => Response.json(invalid.shift()));
  for (let i = 0; i < 6; i++) await assert.rejects(api.listLibrary(), { status: 502 });
});
