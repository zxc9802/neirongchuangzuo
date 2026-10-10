import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createPreviewServer } from '../preview.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';

const idleAI = () => Object.assign(async () => false, { ready: Promise.resolve(), shutdown: async () => {} });
async function listen(server) {
  await server.ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function storage() { return mkdtemp(join(tmpdir(), 'qiya-preview-credits-')); }
async function removeStorage(root) {
  assert.equal(dirname(root), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}

test('local unlimited points apply to the preview wallet, do not charge it and survive a restart', async t => {
  const root = await storage();
  let wallet;
  const options = { localUnlimitedCredits: true, creditsOptions: { databaseUrl: null, storageDir: root },
    createAI: config => { wallet = config.credits; return idleAI(); } };
  let server = createPreviewServer(options);
  t.after(async () => { await server.shutdown(); await removeStorage(root); });
  let base = await listen(server);
  assert.deepEqual(await (await fetch(base + '/api/workspace/session')).json(), { required: false, user: null, localCredits: true });
  let response = await fetch(base + '/api/workspace/credits');
  assert.equal(response.status, 200); assert.equal((await response.json()).unlimited, true);
  const reservation = await wallet.reserve({ userId: 'local-dev', taskId: 'preview-test', kind: 'restaurant', units: 30 });
  assert.equal(reservation.exempt, true); assert.equal(reservation.reservedPoints, 0);
  assert.equal((await wallet.settle({ userId: 'local-dev', taskId: 'preview-test', units: 30 })).chargedPoints, 0);
  assert.equal((await wallet.snapshot('account_owner')).unlimited, false);
  await server.shutdown();
  const saved = createCreditsLedger({ databaseUrl: null, storageDir: root });
  try { await saved.ready; assert.equal((await saved.snapshot('local-dev')).unlimited, true); }
  finally { await saved.close(); }
  server = createPreviewServer(options); base = await listen(server);
  response = await fetch(base + '/api/workspace/credits');
  const snapshot = await response.json();
  assert.equal(response.status, 200); assert.equal(snapshot.unlimited, true); assert.equal(snapshot.held, 0); assert.equal(snapshot.balance, 1000);
});

test('local unlimited configuration cannot grant points to an authenticated deployment account', async t => {
  const root = await storage();
  let wallet;
  const server = createPreviewServer({ authRequired: true, localUnlimitedCredits: true,
    creditsOptions: { databaseUrl: null, storageDir: root }, createAI: config => { wallet = config.credits; return idleAI(); } });
  t.after(async () => { await server.shutdown(); await removeStorage(root); });
  await server.ready;
  assert.equal((await wallet.snapshot('local-dev')).unlimited, false);
  assert.equal((await wallet.snapshot('account_owner')).unlimited, false);
});

test('preview points remain opt-in when no local unlimited setting is passed', async t => {
  const server = createPreviewServer({ createAI: idleAI });
  t.after(() => server.shutdown());
  const base = await listen(server);
  assert.deepEqual(await (await fetch(base + '/api/workspace/session')).json(), { required: false, user: null });
  const response = await fetch(base + '/api/workspace/credits');
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'CREDITS_NOT_CONFIGURED');
});
