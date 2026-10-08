import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreviewServer } from '../preview.mjs';
import { createCreditsLedger, CreditsError } from '../services/credits/store.mjs';
import { createImageUploads } from '../services/ai/image-uploads.mjs';

const CONFIG = { apiKey: 'unit-test-secret', chatModel: 'gpt-6-luna', imageModel: 'gpt-image-2.5-sunburst-c',
  baseUrl: 'https://test-provider.invalid/v1', limits: { imageDaily: 200, chatDaily: 200, perMinute: 200 } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ6kAAAAASUVORK5CYII=', 'base64');
const imageResult = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { headers: { 'Content-Type': 'application/json' } });
const input = (overrides = {}) => ({ requestId: randomUUID(), prompt: '制作真实门店的自然光宣传图片',
  images: [{ dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }], ratio: '3:4', quality: 'auto', ...overrides });
const cookie = owner => `digital_human_session=${owner}`;
const quiet = { warn() {}, error() {}, info() {} };

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, { fetchImpl = async () => { throw new Error('Unexpected model operation'); }, wrapCredits = value => value, now = Date.now, cleanupIntervalMs = 60_000 } = {}) {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'qiya-ai-credits-'));
  const wallet = createCreditsLedger({ databaseUrl: null, storageDir: join(root, 'credits') }); await wallet.ready;
  const credits = wrapCredits(wallet);
  const backend = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const owner = req.headers.cookie === cookie('alice') ? 'alice' : req.headers.cookie === cookie('bob') ? 'bob' : null;
    if (req.url !== '/api/session' || !owner) { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify({ success: true, data: { authMode: 'standalone', user: {
      id: `account_${owner}`, account: `${owner}@example.test`, nickname: owner, role: 'member',
    } } }));
  });
  const backendUrl = await listen(backend), instances = [];
  async function open({ currentCredits = credits, currentFetch = fetchImpl } = {}) {
    const preview = createPreviewServer({ backendUrl, authRequired: true, credits: currentCredits,
      aiOptions: { config: CONFIG, storageDir: join(root, 'ai'), fetchImpl: currentFetch,
        downloadImpl: async () => { throw new Error('Unexpected external download'); }, now, cleanupIntervalMs, logger: quiet },
      logger() {} });
    await preview.ready; const base = await listen(preview);
    let closed = false;
    const app = {
      base, root, wallet, preview, storageDir: join(root, 'ai'),
      async close() { if (closed) return; closed = true; preview.closeAllConnections(); await preview.shutdown(); },
      get(path, owner = 'alice', headers = {}) { return fetch(base + path, { headers: { cookie: cookie(owner), ...headers } }); },
      post(path, body, owner = 'alice', headers = {}) {
        return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, cookie: cookie(owner), ...headers }, body: JSON.stringify(body) });
      },
      async points(owner = 'alice') {
        const response = await this.get('/api/workspace/credits', owner); assert.equal(response.status, 200); return response.json();
      },
    };
    instances.push(app); return app;
  }
  t.after(async () => {
    for (const instance of instances) await instance.close();
    backend.closeAllConnections(); await new Promise(resolveClose => backend.close(resolveClose));
    await wallet.close();
    assert.equal(dirname(resolve(root)), parent);
    assert.ok(resolve(root).startsWith(join(parent, 'qiya-ai-credits-')));
    await rm(root, { recursive: true, force: true });
  });
  const app = await open(); return { app, wallet, root, open };
}

async function saved(app, id, predicate) {
  const deadline = Date.now() + 30_000;
  let latest;
  while (Date.now() < deadline) {
    let task;
    try { task = JSON.parse(await readFile(join(app.storageDir, id, 'task.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (task && predicate(task)) return task;
    latest = task;
    await delay(10);
  }
  assert.fail(`Mock task did not reach the expected persisted state: ${JSON.stringify({ status: latest?.status, billing: latest?.billing?.status, completedCount: latest?.completedCount, code: latest?.code })}`);
}

async function finished(app, id, owner = 'alice') {
  const deadline = Date.now() + 30_000;
  let latest;
  while (Date.now() < deadline) {
    const response = await app.get(`/api/ai/images/${id}`, owner); assert.equal(response.status, 200);
    const { task } = await response.json();
    latest = task;
    if (['completed', 'failed'].includes(task.status)) {
      const persisted = await saved(app, id, item => item.status === task.status && ['settled', 'released'].includes(item.billing?.status));
      assert.equal(persisted.billing.status, task.billing.status); return task;
    }
    await delay(10);
  }
  assert.fail(`Mock image task did not finish or refund: ${JSON.stringify({ status: latest?.status, billing: latest?.billing?.status, completedCount: latest?.completedCount, code: latest?.code })}`);
}

async function submitWhenIdle(app, body, owner = 'alice') {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await app.post('/api/ai/images', body, owner);
    if (response.status !== 429) return response;
    const error = await response.clone().json();
    if (error.code !== 'BUSY') return response;
    await delay(10);
  }
  assert.fail('Previous mock task did not release its execution slot');
}

test('one generated image costs 50 points and downloads only after settlement', async t => {
  let calls = 0;
  const { app, wallet } = await fixture(t, { fetchImpl: async () => { calls++; return imageResult(); } });
  const body = input(); assert.equal((await app.points()).balance, 1000);
  assert.equal((await app.post('/api/ai/images', body)).status, 202);
  const task = await finished(app, body.requestId);
  assert.equal(task.images.length, 1); assert.equal(task.billing.chargedPoints, 50);
  assert.equal((await app.points()).balance, 950); assert.equal((await app.points()).held, 0);
  const reservation = await wallet.reservation('account_alice', body.requestId);
  assert.equal(reservation.status, 'settled'); assert.equal(reservation.chargedPoints, 50);
  const image = await app.get(task.images[0].url);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG); assert.equal(calls, 1);
});

test('15-image set reserves 750 points and settles all successful output images', async t => {
  let calls = 0;
  const { app } = await fixture(t, { fetchImpl: async () => { calls++; return imageResult(); } });
  const body = input({ generationMode: 'series', outputCount: 15 });
  assert.equal((await app.post('/api/ai/images', body)).status, 202);
  const task = await finished(app, body.requestId);
  assert.equal(task.images.length, 15); assert.equal(task.billing.reservedPoints, 750); assert.equal(task.billing.chargedPoints, 750);
  assert.equal((await app.points()).balance, 250); assert.equal((await app.points()).held, 0); assert.equal(calls, 15);
});

test('two successful images out of three cost 100 and refund the undelivered image', async t => {
  let calls = 0;
  const { app } = await fixture(t, { fetchImpl: async () => {
    calls++; return calls === 2 ? new Response('{}', { status: 400 }) : imageResult();
  } });
  const body = input({ generationMode: 'variations', outputCount: 3 });
  assert.equal((await app.post('/api/ai/images', body)).status, 202);
  const task = await finished(app, body.requestId);
  assert.equal(task.partial, true); assert.equal(task.outputCount, 3); assert.equal(task.completedCount, 2);
  assert.equal(task.images.length, 2); assert.equal(task.billing.reservedPoints, 150); assert.equal(task.billing.chargedPoints, 100);
  assert.equal((await app.points()).balance, 900); assert.equal((await app.points()).held, 0); assert.equal(calls, 3);
});

test('failed generation returns all held points without exposing downloadable output', async t => {
  let calls = 0;
  const { app, wallet } = await fixture(t, { fetchImpl: async () => { calls++; return new Response('{}', { status: 400 }); } });
  const body = input(); assert.equal((await app.post('/api/ai/images', body)).status, 202);
  const task = await finished(app, body.requestId);
  assert.equal(task.status, 'failed'); assert.deepEqual(task.images, []); assert.equal(task.billing.status, 'released');
  assert.equal((await app.points()).balance, 1000); assert.equal((await app.points()).held, 0);
  assert.equal((await wallet.reservation('account_alice', body.requestId)).chargedPoints, 0);
  assert.notEqual((await app.get(`/api/ai/media/${body.requestId}/result-1.png`)).status, 200); assert.equal(calls, 1);
});

test('exact task replay does not generate or charge twice, and changed inputs conflict', async t => {
  let calls = 0;
  const { app } = await fixture(t, { fetchImpl: async () => { calls++; return imageResult(); } });
  const body = input({ generationMode: 'variations', outputCount: 3 });
  assert.equal((await app.post('/api/ai/images', body)).status, 202);
  await finished(app, body.requestId);
  const repeats = await Promise.all(Array.from({ length: 3 }, () => app.post('/api/ai/images', body)));
  for (const response of repeats) { assert.equal(response.status, 200); assert.equal((await response.json()).task.images.length, 3); }
  assert.equal(calls, 3); assert.equal((await app.points()).balance, 850);
  assert.equal((await app.post('/api/ai/images', { ...body, outputCount: 4 })).status, 409);
  assert.equal(calls, 3); assert.equal((await app.points()).balance, 850);
});

test('initial 1000 points cover exactly 20 images; the twenty-first returns 402 without a provider call', async t => {
  let calls = 0;
  const { app, wallet } = await fixture(t, { fetchImpl: async () => { calls++; return imageResult(); } });
  for (const outputCount of [15, 5]) {
    const body = input({ generationMode: 'series', outputCount });
    assert.equal((await submitWhenIdle(app, body)).status, 202);
    await finished(app, body.requestId);
  }
  assert.equal((await app.points()).balance, 0); assert.equal((await app.points()).held, 0); assert.equal(calls, 20);
  const body = input(), response = await submitWhenIdle(app, body);
  assert.equal(response.status, 402); assert.equal((await response.json()).code, 'INSUFFICIENT_POINTS');
  assert.equal(calls, 20); assert.equal(await wallet.reservation('account_alice', body.requestId), null);
});

test('the credits API trusts the verified cookie, rejects anonymous mutation and isolates account outputs', async t => {
  let calls = 0;
  const { app } = await fixture(t, { fetchImpl: async () => { calls++; return imageResult(); } });
  const body = input(); assert.equal((await app.post('/api/ai/images', body)).status, 202);
  const task = await finished(app, body.requestId);
  assert.equal((await app.points('alice')).balance, 950); assert.equal((await app.points('bob')).balance, 1000);
  const forged = await app.get('/api/workspace/credits?userId=account_alice', 'bob', { 'x-user-id': 'account_alice' });
  assert.equal(forged.status, 200); assert.equal((await forged.json()).balance, 1000);
  assert.equal((await fetch(app.base + '/api/workspace/credits', { headers: { 'x-user-id': 'account_alice' } })).status, 401);
  assert.equal((await app.post('/api/workspace/credits', { userId: 'account_alice', points: 999999 }, 'alice')).status, 405);
  assert.equal((await app.get(`/api/ai/images/${body.requestId}`, 'bob')).status, 404);
  assert.equal((await app.get(task.images[0].url, 'bob')).status, 404);
  assert.equal((await app.post('/api/ai/images', body, 'bob')).status, 409);
  assert.equal(calls, 1); assert.equal((await app.points('bob')).balance, 1000);
});

test('settlement outage hides saved images and GET recovers billing without another model call', async t => {
  let calls = 0, blocked = true;
  const { app, wallet } = await fixture(t, { fetchImpl: async () => { calls++; return imageResult(); },
    wrapCredits: ledger => ({ ...ledger, settle: async options => {
      if (blocked) throw new CreditsError('测试积分服务暂时离线', 503, 'CREDITS_STORAGE_UNAVAILABLE');
      return ledger.settle(options);
    } }) });
  const body = input(); assert.equal((await app.post('/api/ai/images', body)).status, 202);
  await saved(app, body.requestId, task => task.status === 'completed' && task.billing.status === 'settle_pending');
  const pendingResponse = await app.get(`/api/ai/images/${body.requestId}`);
  const pending = (await pendingResponse.json()).task;
  assert.equal(pending.status, 'running'); assert.equal(pending.code, 'CREDITS_SETTLEMENT_PENDING'); assert.deepEqual(pending.images, []);
  const media = await app.get(`/api/ai/media/${body.requestId}/result-1.png`); assert.equal(media.status, 503);
  assert.equal((await app.points()).balance, 950); assert.equal((await app.points()).held, 50);
  blocked = false;
  const done = await finished(app, body.requestId);
  assert.equal(done.images.length, 1); assert.equal(done.billing.status, 'settled');
  assert.equal((await wallet.snapshot('account_alice')).balance, 950); assert.equal((await wallet.snapshot('account_alice')).held, 0);
  assert.equal((await app.get(done.images[0].url)).status, 200); assert.equal(calls, 1);
});

test('restart restores pending settlement from the task file without regenerating or gifting again', async t => {
  let calls = 0;
  const { app, wallet, open } = await fixture(t, { fetchImpl: async () => { calls++; return imageResult(); },
    wrapCredits: ledger => ({ ...ledger, settle: async () => { throw new CreditsError('测试结算不可用', 503, 'CREDITS_STORAGE_UNAVAILABLE'); } }) });
  const body = input({ generationMode: 'series', outputCount: 3 });
  assert.equal((await app.post('/api/ai/images', body)).status, 202);
  await saved(app, body.requestId, task => task.status === 'completed' && task.billing.status === 'settle_pending');
  assert.equal((await wallet.snapshot('account_alice')).held, 150); await app.close();
  const reopened = await open({ currentCredits: wallet, currentFetch: async () => { calls++; throw new Error('Restart must not repeat model calls'); } });
  const task = await finished(reopened, body.requestId);
  assert.equal(task.images.length, 3); assert.equal(task.billing.status, 'settled'); assert.equal(task.billing.chargedPoints, 150);
  assert.equal((await reopened.points()).balance, 850); assert.equal((await reopened.points()).held, 0); assert.equal(calls, 3);
  assert.equal((await reopened.post('/api/ai/images', body)).status, 200); assert.equal(calls, 3);
});

test('image and another module share atomic holds, so concurrent requests cannot oversell one wallet', async t => {
  let calls = 0, releaseProvider;
  const gate = new Promise(resolveGate => { releaseProvider = resolveGate; });
  const { app, wallet } = await fixture(t, { fetchImpl: async () => { calls++; await gate; return imageResult(); } });
  const body = input({ generationMode: 'series', outputCount: 15 });
  let response, mixed;
  try {
    [response, mixed] = await Promise.all([
      app.post('/api/ai/images', body),
      wallet.reserve({ userId: 'account_alice', taskId: 'concurrent_mix', kind: 'mix', units: 60 })
        .then(record => ({ ok: true, record }), error => ({ ok: false, error })),
    ]);
    const accepted = (response.status === 202 ? 1 : 0) + (mixed.ok ? 1 : 0);
    assert.equal(accepted, 1);
    const snapshot = await wallet.snapshot('account_alice'); assert.ok(snapshot.available >= 0); assert.ok(snapshot.held <= 1000);
    if (mixed.ok) {
      assert.equal(response.status, 402); assert.equal(calls, 0); assert.equal(snapshot.held, 666);
      await wallet.release({ userId: 'account_alice', taskId: 'concurrent_mix' });
    } else {
      assert.equal(response.status, 202); assert.equal(mixed.error.code, 'INSUFFICIENT_POINTS'); assert.equal(snapshot.held, 750);
    }
  } finally { releaseProvider(); }
  if (response.status === 202) await finished(app, body.requestId);
  const final = await wallet.snapshot('account_alice'); assert.equal(final.held, 0); assert.equal(final.available, response.status === 202 ? 250 : 1000);
});

test('reservation response lost after a durable hold is refunded before any provider call and never retried automatically', async t => {
  let calls = 0, loseAck = true;
  const { app, wallet } = await fixture(t, { fetchImpl: async () => { calls++; return imageResult(); },
    wrapCredits: ledger => ({ ...ledger, reserve: async options => {
      const held = await ledger.reserve(options);
      if (loseAck) { loseAck = false; throw new CreditsError('预留结果回包丢失', 503, 'CREDITS_STORAGE_UNAVAILABLE'); }
      return held;
    } }) });
  const body = input(), response = await app.post('/api/ai/images', body);
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'CREDITS_STORAGE_UNAVAILABLE');
  const task = await finished(app, body.requestId);
  assert.equal(task.status, 'failed'); assert.equal(task.billing.status, 'released');
  assert.equal((await wallet.reservation('account_alice', body.requestId)).status, 'released');
  assert.equal((await app.points()).balance, 1000); assert.equal((await app.points()).held, 0); assert.equal(calls, 0);
  const repeated = await app.post('/api/ai/images', body); assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).task.status, 'failed'); assert.equal(calls, 0);
});

test('lost successful settlement acknowledgement is reconciled idempotently without charging or generating twice', async t => {
  let calls = 0, loseAck = true, settlementCalls = 0;
  const { app, wallet } = await fixture(t, { fetchImpl: async () => { calls++; return imageResult(); },
    wrapCredits: ledger => ({ ...ledger, settle: async options => {
      settlementCalls++; const settled = await ledger.settle(options);
      if (loseAck) { loseAck = false; throw new CreditsError('结算结果回包丢失', 503, 'CREDITS_STORAGE_UNAVAILABLE'); }
      return settled;
    } }) });
  const body = input(); assert.equal((await app.post('/api/ai/images', body)).status, 202);
  await saved(app, body.requestId, task => task.status === 'completed' && task.billing.status === 'settle_pending');
  const settledBeforeRecovery = await wallet.reservation('account_alice', body.requestId);
  assert.equal(settledBeforeRecovery.status, 'settled'); assert.equal(settledBeforeRecovery.chargedPoints, 50);
  const task = await finished(app, body.requestId);
  assert.equal(task.billing.status, 'settled'); assert.equal(task.images.length, 1);
  assert.equal((await app.points()).balance, 950); assert.equal((await app.points()).held, 0);
  assert.equal(settlementCalls, 1, 'recovery synchronizes the committed ledger instead of issuing another settlement'); assert.equal(calls, 1);
});

test('refund outage is restored by task GET and failed generation remains uncharged', async t => {
  let calls = 0, blocked = true;
  const { app, wallet } = await fixture(t, { fetchImpl: async () => { calls++; return new Response('{}', { status: 400 }); },
    wrapCredits: ledger => ({ ...ledger, release: async options => {
      if (blocked) throw new CreditsError('测试退款不可用', 503, 'CREDITS_STORAGE_UNAVAILABLE');
      return ledger.release(options);
    } }) });
  const body = input(); assert.equal((await app.post('/api/ai/images', body)).status, 202);
  await saved(app, body.requestId, task => task.status === 'failed' && task.billing.status === 'release_pending');
  assert.equal((await app.points()).balance, 950); assert.equal((await app.points()).held, 50);
  blocked = false;
  const task = await finished(app, body.requestId);
  assert.equal(task.status, 'failed'); assert.equal(task.billing.status, 'released');
  assert.equal((await wallet.snapshot('account_alice')).balance, 1000); assert.equal((await wallet.snapshot('account_alice')).held, 0);
  assert.equal(calls, 1);
});

test('restart recovers interrupted partial progress and settles only the two persisted output images', async t => {
  let calls = 0;
  const { app, wallet, open } = await fixture(t, { fetchImpl: async () => { calls++; return imageResult(); },
    wrapCredits: ledger => ({ ...ledger, settle: async () => { throw new CreditsError('测试结算不可用', 503, 'CREDITS_STORAGE_UNAVAILABLE'); } }) });
  const body = input({ generationMode: 'series', outputCount: 3 });
  assert.equal((await app.post('/api/ai/images', body)).status, 202);
  const progress = await saved(app, body.requestId, task => task.status === 'completed' && task.billing.status === 'settle_pending');
  await app.close();
  // Represent the durable task snapshot from a restart after two outputs, before
  // the last request is known. This does not execute or resume an upstream call.
  progress.status = 'running'; progress.images = progress.images.slice(0, 2); progress.completedCount = 2;
  progress.billing.status = 'reserved'; delete progress.completedAt;
  await writeFile(join(app.storageDir, body.requestId, 'task.json'), JSON.stringify(progress));
  const reopened = await open({ currentCredits: wallet, currentFetch: async () => { calls++; throw new Error('Interrupted generation must not be dispatched again'); } });
  const task = await finished(reopened, body.requestId);
  assert.equal(task.status, 'completed'); assert.equal(task.partial, true); assert.equal(task.images.length, 2);
  assert.equal(task.warningCode, 'INTERRUPTED'); assert.equal(task.billing.chargedPoints, 100);
  assert.equal((await reopened.points()).balance, 900); assert.equal((await reopened.points()).held, 0);
  assert.equal(calls, 3);
});

test('periodic three-day expiry refunds a saved but never-settled image without a task request', async t => {
  let time = Date.UTC(2026, 9, 8, 3), calls = 0;
  const { app, wallet } = await fixture(t, { now: () => time, cleanupIntervalMs: 25,
    fetchImpl: async () => { calls++; return imageResult(); },
    wrapCredits: ledger => ({ ...ledger, settle: async () => { throw new CreditsError('测试持续结算故障', 503, 'CREDITS_STORAGE_UNAVAILABLE'); } }) });
  const body = input(); assert.equal((await app.post('/api/ai/images', body)).status, 202);
  await saved(app, body.requestId, task => task.status === 'completed' && task.billing.status === 'settle_pending');
  assert.equal((await wallet.snapshot('account_alice')).held, 50);
  time += 3 * 24 * 3600_000 + 1;
  const expired = await saved(app, body.requestId, task => task.status === 'expired' && task.billing.status === 'released');
  assert.deepEqual(expired.images, []); assert.equal(expired.billing.chargedPoints, 0);
  assert.equal((await wallet.snapshot('account_alice')).held, 0); assert.equal((await wallet.snapshot('account_alice')).available, 1000);
  await assert.rejects(readFile(join(app.storageDir, body.requestId, 'result-1.png')), { code: 'ENOENT' });
  const media = await app.get(`/api/ai/media/${body.requestId}/result-1.png`);
  assert.equal(media.status, 410); assert.equal((await media.json()).code, 'RESULT_EXPIRED'); assert.equal(calls, 1);
});

test('expiry synchronizes an already-committed settlement after a lost reply and never refunds that charge', async t => {
  let time = Date.UTC(2026, 9, 8, 3), calls = 0, settlements = 0;
  const { app, wallet } = await fixture(t, { now: () => time, cleanupIntervalMs: 25,
    fetchImpl: async () => { calls++; return imageResult(); },
    wrapCredits: ledger => ({ ...ledger, settle: async options => {
      settlements++; await ledger.settle(options);
      throw new CreditsError('测试成功结算回包丢失', 503, 'CREDITS_STORAGE_UNAVAILABLE');
    } }) });
  const body = input(); assert.equal((await app.post('/api/ai/images', body)).status, 202);
  await saved(app, body.requestId, task => task.status === 'completed' && task.billing.status === 'settle_pending');
  assert.equal((await wallet.reservation('account_alice', body.requestId)).status, 'settled');
  time += 3 * 24 * 3600_000 + 1;
  const expired = await saved(app, body.requestId, task => task.status === 'expired' && task.billing.status === 'settled');
  assert.deepEqual(expired.images, []); assert.equal(expired.billing.chargedPoints, 50);
  assert.equal((await wallet.snapshot('account_alice')).balance, 950); assert.equal((await wallet.snapshot('account_alice')).held, 0);
  assert.equal((await app.get(`/api/ai/media/${body.requestId}/result-1.png`)).status, 410);
  assert.equal(settlements, 1); assert.equal(calls, 1);
});

test('expired result stays inaccessible during refund outage and GET later releases the hold idempotently', async t => {
  let time = Date.UTC(2026, 9, 8, 3), blocked = true, calls = 0;
  const { app, wallet, open } = await fixture(t, { now: () => time,
    fetchImpl: async () => { calls++; return imageResult(); },
    wrapCredits: ledger => ({ ...ledger,
      settle: async () => { throw new CreditsError('测试结算离线', 503, 'CREDITS_STORAGE_UNAVAILABLE'); },
      release: async options => { if (blocked) throw new CreditsError('测试退款离线', 503, 'CREDITS_STORAGE_UNAVAILABLE'); return ledger.release(options); },
    }) });
  const body = input(); assert.equal((await app.post('/api/ai/images', body)).status, 202);
  await saved(app, body.requestId, task => task.status === 'completed' && task.billing.status === 'settle_pending');
  time += 3 * 24 * 3600_000 + 1;
  const detail = await app.get(`/api/ai/images/${body.requestId}`);
  assert.equal(detail.status, 200);
  const expired = (await detail.json()).task;
  assert.equal(expired.status, 'expired'); assert.deepEqual(expired.images, []); assert.equal(expired.billing.status, 'release_pending');
  assert.equal((await wallet.snapshot('account_alice')).held, 50);
  const media = await app.get(`/api/ai/media/${body.requestId}/result-1.png`);
  assert.equal(media.status, 410); assert.equal((await media.json()).code, 'RESULT_EXPIRED');
  blocked = false;
  for (let i = 0; i < 3; i++) {
    const response = await app.get(`/api/ai/images/${body.requestId}`);
    assert.equal((await response.json()).task.billing.status, 'released');
  }
  assert.equal((await wallet.snapshot('account_alice')).balance, 1000); assert.equal((await wallet.snapshot('account_alice')).held, 0);
  assert.equal((await wallet.reservation('account_alice', body.requestId)).status, 'released');
  time += 31 * 24 * 3600_000;
  await app.close();
  const reopened = await open({ currentCredits: wallet, currentFetch: async () => { throw new Error('An expired task must not regenerate'); } });
  const response = await reopened.post('/api/ai/images', body);
  assert.equal(response.status, 200); assert.equal((await response.json()).task.status, 'expired');
  const durable = JSON.parse(await readFile(join(app.storageDir, body.requestId, 'task.json'), 'utf8'));
  assert.equal(durable.billing.taskId, body.requestId); assert.equal(durable.billing.status, 'released');
  assert.equal((await reopened.points()).balance, 1000); assert.equal(calls, 1);
});

test('startup reconciles an old pending result as expired before charging or allowing download', async t => {
  let time = Date.UTC(2026, 9, 8, 3), calls = 0;
  const { app, wallet, open } = await fixture(t, { now: () => time,
    fetchImpl: async () => { calls++; return imageResult(); },
    wrapCredits: ledger => ({ ...ledger, settle: async () => { throw new CreditsError('测试结算离线', 503, 'CREDITS_STORAGE_UNAVAILABLE'); } }) });
  const body = input({ generationMode: 'series', outputCount: 3 });
  assert.equal((await app.post('/api/ai/images', body)).status, 202);
  await saved(app, body.requestId, task => task.status === 'completed' && task.billing.status === 'settle_pending');
  await app.close(); time += 3 * 24 * 3600_000 + 1;
  const reopened = await open({ currentCredits: wallet, currentFetch: async () => { throw new Error('Startup reconciliation must not call the model'); } });
  const durable = await saved(reopened, body.requestId, task => task.status === 'expired' && task.billing.status === 'released');
  assert.deepEqual(durable.images, []); assert.equal(durable.billing.chargedPoints, 0);
  assert.equal((await reopened.points()).balance, 1000); assert.equal((await reopened.points()).held, 0);
  assert.equal((await reopened.get(`/api/ai/media/${body.requestId}/result-1.png`)).status, 410); assert.equal(calls, 3);
});

test('zero cleanup interval disables periodic file sweeps while explicit HTTP cleanup still expires originals and outputs', async t => {
  let time = Date.UTC(2026, 9, 8, 3), calls = 0;
  const { app } = await fixture(t, { now: () => time, cleanupIntervalMs: 0, fetchImpl: async () => { calls++; return imageResult(); } });
  const body = input(), id = body.requestId;
  assert.equal((await app.post('/api/ai/image-uploads', { requestId: id, imageCount: 1 })).status, 200);
  assert.equal((await app.post(`/api/ai/image-uploads/${id}/batches`, { startIndex: 0, images: body.images })).status, 200);
  const { images: ignored, ...request } = body;
  assert.equal((await app.post('/api/ai/images', { ...request, uploadId: id })).status, 202);
  await finished(app, id);
  time += 3 * 24 * 3600_000 + 1;
  await delay(100);
  const sourcePath = join(app.storageDir, '.image-uploads', id, 'source-01.png');
  const resultPath = join(app.storageDir, id, 'result-1.png');
  assert.deepEqual(await readFile(sourcePath), PNG); assert.deepEqual(await readFile(resultPath), PNG);
  assert.equal(JSON.parse(await readFile(join(app.storageDir, id, 'task.json'), 'utf8')).status, 'completed');
  assert.equal(JSON.parse(await readFile(join(app.storageDir, '.image-uploads', id, 'upload.json'), 'utf8')).expired, undefined);
  assert.equal((await app.get('/api/ai/images')).status, 200);
  await assert.rejects(readFile(sourcePath), { code: 'ENOENT' }); await assert.rejects(readFile(resultPath), { code: 'ENOENT' });
  assert.equal((await app.get(`/api/ai/image-uploads/${id}`)).status, 410);
  assert.equal((await app.get(`/api/ai/media/${id}/result-1.png`)).status, 410);
  assert.equal((await app.points()).available, 950); assert.equal(calls, 1);
});

test('concurrent upload sweeps share one in-flight scan and safely expire each uploaded source once', async t => {
  let time = Date.UTC(2026, 9, 8, 3), warnings = 0;
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'qiya-upload-singleflight-'));
  const uploads = createImageUploads({ storageDir: root, now: () => time, cleanupIntervalMs: 0, logger: { warn() { warnings++; } } });
  t.after(async () => {
    await uploads.dispose(); assert.equal(dirname(resolve(root)), parent);
    assert.ok(resolve(root).startsWith(join(parent, 'qiya-upload-singleflight-'))); await rm(root, { recursive: true, force: true });
  });
  await uploads.ready;
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) {
    await uploads.init(id, 1, 'test_owner');
    await uploads.append(id, 0, [{ bytes: PNG, mime: 'image/png', ext: 'png' }], 'test_owner');
  }
  time += 3 * 24 * 3600_000 + 1;
  const sweeps = Array.from({ length: 100 }, () => uploads.sweep());
  assert.ok(sweeps.every(item => item === sweeps[0]), 'concurrent callers must join one scan instead of enqueueing 100 scans per upload');
  await Promise.all(sweeps);
  for (const id of ids) {
    const expired = JSON.parse(await readFile(join(root, '.image-uploads', id, 'upload.json'), 'utf8'));
    assert.equal(expired.expired, true); assert.equal(expired.totalBytes, 0); assert.deepEqual(expired.images, []);
    await assert.rejects(readFile(join(root, '.image-uploads', id, 'source-01.png')), { code: 'ENOENT' });
  }
  await uploads.sweep(); assert.equal(warnings, 0);
});
