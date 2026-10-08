import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMixCreditsBridge } from '../services/mix/credits-bridge.mjs';
import { createMixHandler } from '../services/mix/server.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';
import { getMixState, mixJobLabel, mixReadiness, renderMixMaterials, mixFolderLocked, stopMixMaterials } from '../design/mix-materials.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const token = 'private-test-token-'.repeat(3);
const taskId = 'mix:' + 'a'.repeat(32) + ':1';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'qiya-mix-credits-'));
  const credits = createCreditsLedger({ databaseUrl: '', storageDir: join(root, 'wallets') });
  await credits.ready;
  let bridge = createMixCreditsBridge({ credits, dataDir: join(root, 'mix'), token });
  let url = await bridge.start();
  t.after(async () => { await bridge.shutdown(); await credits.close(); await rm(root, { recursive: true, force: true }); });
  const call = async (action, body, credential = token) => {
    const response = await fetch(url + '/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { credits, root, call, register: user => bridge.register(user), restart: async () => { await bridge.shutdown(); bridge = createMixCreditsBridge({ credits, dataDir: join(root, 'mix'), token }); url = await bridge.start(); } };
}

test('mix callbacks require the private bearer and a gateway-registered owner instead of a browser identity', async t => {
  const ctx = await fixture(t);
  assert.equal((await ctx.call('snapshot', { owner: sha('alice') })).status, 403);
  await ctx.register('alice');
  assert.equal((await ctx.call('reserve', { owner: sha('alice'), taskId, units: 30 }, 'forged')).status, 401);
  const result = await ctx.call('reserve', { owner: sha('alice'), userId: 'bob', taskId, units: 30 });
  assert.equal(result.status, 200);
  assert.equal(result.data.reservation.reservedPoints, 333);
  assert.equal(result.data.reservation.userId, undefined);
  assert.equal((await ctx.credits.snapshot('alice')).available, 667);
  assert.equal((await ctx.credits.snapshot('bob')).available, 1000);
});

test('real wallet reservation and actual-duration settlement remain idempotent through the private mix callback', async t => {
  const ctx = await fixture(t);
  const owner = await ctx.register('alice');
  for (let index = 0; index < 2; index++) assert.equal((await ctx.call('reserve', { owner, taskId, units: 30 })).status, 200);
  assert.equal((await ctx.credits.snapshot('alice')).held, 333);
  for (let index = 0; index < 2; index++) {
    const result = await ctx.call('settle', { owner, taskId, units: 60 });
    assert.equal(result.status, 200);
    assert.equal(result.data.reservation.chargedPoints, 666);
  }
  const wallet = await ctx.credits.snapshot('alice');
  assert.equal(wallet.available, 334);
  assert.equal(wallet.held, 0);
  assert.equal((await ctx.call('release', { owner, taskId })).status, 409);
});

test('owner mappings persist atomically across callback restarts and continue to resolve old frozen work', async t => {
  const ctx = await fixture(t);
  const owner = await ctx.register('alice');
  await ctx.call('reserve', { owner, taskId, units: 30 });
  const saved = JSON.parse(await readFile(join(ctx.root, 'mix', 'credit-owners.json'), 'utf8'));
  assert.equal(saved[owner], 'alice');
  await ctx.restart();
  const record = await ctx.call('read', { owner, taskId });
  assert.equal(record.status, 200);
  assert.equal(record.data.reservation.status, 'reserved');
  await ctx.call('release', { owner, taskId });
  const wallet = await ctx.credits.snapshot('alice');
  assert.equal(wallet.available, 1000);
  assert.equal(wallet.held, 0);
});

test('invalid attempts and unaffordable duration cannot consume or arbitrarily mutate the real wallet', async t => {
  const ctx = await fixture(t);
  const owner = await ctx.register('alice');
  assert.equal((await ctx.call('reserve', { owner, taskId: 'image:fake', units: 1 })).status, 400);
  const result = await ctx.call('reserve', { owner, taskId, units: 100 });
  assert.equal(result.status, 402);
  assert.equal(result.data.code, 'INSUFFICIENT_POINTS');
  const wallet = await ctx.credits.snapshot('alice');
  assert.equal(wallet.available, 1000);
  assert.equal(wallet.held, 0);
});

test('pending credit confirmation is labelled and can resume its original task while new generation remains blocked', t => {
  stopMixMaterials();
  const state = getMixState();
  state.job = { id: 'a'.repeat(32), state: 'credit_pending', error: '积分暂未确认' };
  t.after(stopMixMaterials);
  assert.equal(mixJobLabel(state.job), '积分确认中');
  assert.match(mixReadiness(), /积分确认中.*重试确认/);
  const html = renderMixMaterials();
  assert.match(html, /data-action="mix-resume-job"[^>]*>重试确认积分/);
  assert.doesNotMatch(html, /data-action="mix-retry-submit"/);
  assert.equal(mixFolderLocked(), true);
});

test('the gateway preserves an accepted pending task ID for status queries and confirmation of the same job', async t => {
  const ctx = await fixture(t), id = 'a'.repeat(32), calls = [];
  let state = 'credit_pending';
  await ctx.credits.reserve({ userId: 'alice', taskId, kind: 'mix', units: 30 });
  const engine = createServer(async (req, res) => {
    for await (const chunk of req) { /* consume the forwarded JSON body */ }
    calls.push({ path: req.url, method: req.method, owner: req.headers['x-material-owner'] });
    if (req.url.endsWith('/resume')) state = 'queued';
    res.writeHead(req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, state, billing: { source: 'workspace', status: state === 'credit_pending' ? 'reserve_pending' : 'reserved', reservedPoints: 333, chargedPoints: 0 } }));
  });
  engine.listen(0, '127.0.0.1'); await once(engine, 'listening');
  const handler = createMixHandler({ dataDir: join(ctx.root, 'gateway'), credits: ctx.credits, serviceUrl: `http://127.0.0.1:${engine.address().port}`, token });
  const gateway = createServer((req, res) => { req.authenticatedUserId = 'alice'; void handler(req, res); });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(async () => { await handler.shutdown(); for (const server of [gateway, engine]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const first = await fetch(base + '/api/mix/jobs', { method: 'POST', headers: { 'Idempotency-Key': 'original-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '真实文案' }) });
  assert.equal(first.status, 202);
  assert.equal((await first.json()).state, 'credit_pending');
  assert.equal((await (await fetch(base + '/api/mix/jobs/' + id)).json()).id, id);
  const resumed = await fetch(base + '/api/mix/jobs/' + id + '/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(resumed.status, 202);
  assert.equal((await resumed.json()).state, 'queued');
  assert.equal(calls.filter(call => call.path === '/v1/mix/jobs' && call.method === 'POST').length, 1);
  assert.ok(calls.every(call => call.owner === sha('alice')));
  assert.equal((await ctx.credits.snapshot('alice')).held, 333);
});
