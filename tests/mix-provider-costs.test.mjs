import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createMixProviderCosts } from '../services/mix/provider-costs.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';

const owner = user => createHash('sha256').update(user).digest('hex');
const scope = 'job:' + 'a'.repeat(32);
const llm = 'https://api.openlux.ai/v1beta/models/gemini-3.7-flash:generateContent';
const embed = 'https://api.openlux.ai/v1beta/models/gemini-embedding-2-preview:embedContent';
const voice = 'https://api.302.ai/302/index_tts2/task';
const payload = { contents: [{ parts: [{ text: '仅返回真实可见画面' }] }], generationConfig: { maxOutputTokens: 128 } };
const reply = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mix-provider-cost-'));
  const credits = createCreditsLedger({ storageDir: join(root, 'wallets'), databaseUrl: '', costMode: true });
  await credits.ready;
  t.after(async () => { await credits.close(); await rm(root, { recursive: true, force: true }); });
  const state = { posts: 0, logs: 0, fail: false, missing: false, status: 200, quota: 1000, asyncBill: 0.002 };
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    if (target.pathname === '/api/pricing_new') return reply({ data: ['gemini-3.7-flash', 'gemini-embedding-2-preview', 'qwen3-rerank'].map(model_name => ({
      model_name, quota_type: 0, model_ratio: .1, completion_ratio: 2, enable_groups: ['cheap', 'expensive'] })), group_ratio: { cheap: .1, expensive: 1 } });
    if (target.pathname === '/api/status') return reply({ data: { currency_type: 'USD', usd_exchange_rate: 6, quota_per_unit: 500000 } });
    if (target.pathname === '/api/log/token') {
      state.logs++;
      assert.equal(target.searchParams.get('key'), 'private-openlux');
      return reply({ data: { items: [{ type: state.errorLog ? 5 : 2, model_name: 'gemini-3.7-flash', quota: state.quota,
        other: JSON.stringify({ request_id: state.missing ? 'unrelated' : 'receipt-1' }) }] } });
    }
    if (target.pathname === '/dashboard/api-record') return reply({ items: state.missing ? [] : [{ request_id: 'receipt-1', cost: state.asyncBill, currency: 'USD' }] });
    assert.equal(options.method, 'POST'); state.posts++;
    if (state.fail) throw new Error('network disconnected');
    if (state.status !== 200) return reply({ error: 'rejected' }, state.status, { 'x-api-request-id': 'receipt-1' });
    return reply(target.href === embed ? { embedding: { values: [1, 0] }, quota: state.quota }
      : target.href === voice ? { task_id: 'tts-1' } : { candidates: [], usageMetadata: { promptTokenCount: 100 } },
    200, { 'x-api-request-id': 'receipt-1' });
  };
  const open = () => createMixProviderCosts({ credits, dataDir: join(root, 'mix'), fetchImpl,
    env: { OPENLUX_API_KEY: 'private-openlux', INDEXTTS_302_API_KEY: 'private-302', RERANK_API_KEY: 'private-302' } });
  return { credits, state, open, meter: open() };
}

test('auto-routed Gemini settles the matched actual provider bill, not the maximum quote or another account', async t => {
  const f = await fixture(t);
  await f.meter.request('alice', owner('alice'), scope, llm, payload);
  const summary = await f.meter.close('alice', owner('alice'), scope);
  assert.equal(summary.costMicros, 12000);
  assert.equal(summary.chargedPoints, 2);
  assert.equal((await f.credits.snapshot('alice')).available, 998);
  assert.equal((await f.credits.snapshot('bob')).available, 1000);
});

test('native embedding inline quota is settled once across concurrent retries and process reconstruction', async t => {
  const f = await fixture(t);
  const call = () => f.meter.request('alice', owner('alice'), scope, embed, { content: { parts: [{ text: '天空' }] } });
  const results = await Promise.all([call(), call()]);
  assert.deepEqual(results[0].embedding.values, [1, 0]);
  await f.open().request('alice', owner('alice'), scope, embed, { content: { parts: [{ text: '天空' }] } });
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.logs, 0);
  assert.equal((await f.credits.snapshot('alice')).held, 0);
  assert.equal((await f.credits.snapshot('alice')).available, 998);
});

test('a lost POST response keeps its hold and cannot issue another paid POST after restart', async t => {
  const f = await fixture(t); f.state.fail = true;
  await assert.rejects(f.meter.request('alice', owner('alice'), scope, llm, payload));
  f.state.fail = false;
  await assert.rejects(f.open().request('alice', owner('alice'), scope, llm, payload), { code: 'COST_USAGE_MISSING' });
  assert.equal(f.state.posts, 1);
  assert.ok((await f.credits.snapshot('alice')).held > 0);
  await assert.rejects(f.meter.close('alice', owner('alice'), scope), { code: 'COST_USAGE_MISSING' });
});

test('missing exact bill cannot settle from guessed token usage; later reconciliation reuses the paid response', async t => {
  const f = await fixture(t); f.state.missing = true;
  await assert.rejects(f.meter.request('alice', owner('alice'), scope, llm, payload), { code: 'COST_USAGE_MISSING' });
  assert.ok((await f.credits.snapshot('alice')).held > 0);
  f.state.missing = false;
  await f.open().request('alice', owner('alice'), scope, llm, payload);
  assert.equal(f.state.posts, 1);
  assert.equal((await f.credits.snapshot('alice')).held, 0);
});

test('insufficient balance stops dispatch; unlimited accounts retain receipts with zero deductions', async t => {
  const f = await fixture(t);
  await f.credits.reserve({ userId: 'alice', taskId: 'existing', kind: 'mix', units: 90 });
  await assert.rejects(f.meter.request('alice', owner('alice'), scope, llm, { ...payload, generationConfig: { maxOutputTokens: 10000000 } }), { code: 'INSUFFICIENT_POINTS' });
  assert.equal(f.state.posts, 0);
  await f.credits.setUnlimited('bob', true);
  await f.meter.request('bob', owner('bob'), scope, llm, payload);
  assert.deepEqual(await f.meter.close('bob', owner('bob'), scope), { chargedPoints: 0, costMicros: 12000 });
  assert.equal((await f.credits.snapshot('bob')).available, 1000);
});

test('asynchronous 302 TTS returns the saved task and gates completion on its exact bill', async t => {
  const f = await fixture(t); f.state.missing = true;
  const body = { text: '这是真实配音', speaker_audio_url: 'https://file.302.ai/reference.wav' };
  assert.equal((await f.meter.request('alice', owner('alice'), scope, voice, body)).task_id, 'tts-1');
  await assert.rejects(f.meter.close('alice', owner('alice'), scope), { code: 'COST_USAGE_MISSING' });
  assert.equal((await f.open().request('alice', owner('alice'), scope, voice, body)).task_id, 'tts-1');
  f.state.missing = false;
  assert.deepEqual(await f.meter.close('alice', owner('alice'), scope), { chargedPoints: 2, costMicros: 12000 });
  assert.equal(f.state.posts, 1);
});

test('definite provider rejection releases the hold and unconfigured targets never dispatch', async t => {
  const f = await fixture(t); f.state.status = 400;
  await assert.rejects(f.meter.request('alice', owner('alice'), scope, llm, payload), { code: 'MIX_PROVIDER_REJECTED' });
  assert.equal((await f.credits.snapshot('alice')).available, 1000);
  assert.equal((await f.credits.snapshot('alice')).held, 0);
  await assert.rejects(f.meter.request('alice', owner('alice'), '../../escape', llm, payload));
  await assert.rejects(f.meter.request('alice', owner('alice'), scope, 'https://other.example/pay', payload));
  assert.equal(f.state.posts, 1);
});

test('an exact zero-cost gateway error bill permits retry, while an unconfirmed server error never does', async t => {
  const f = await fixture(t); f.state.status = 500; f.state.quota = 0; f.state.errorLog = true;
  await assert.rejects(f.meter.request('alice', owner('alice'), scope, llm, payload), { code: 'MIX_PROVIDER_REJECTED' });
  assert.equal((await f.credits.snapshot('alice')).held, 0);
  f.state.status = 200; f.state.quota = 1000; f.state.errorLog = false;
  await f.meter.request('alice', owner('alice'), scope, llm, payload);
  assert.equal(f.state.posts, 2);
  assert.equal((await f.credits.snapshot('alice')).available, 998);
});

test('explicit new TTS attempts get separate bills while retries of the same attempt return the old task', async t => {
  const f = await fixture(t), body = { text: '配音', speaker_audio_url: 'https://file.302.ai/ref.wav' };
  await f.meter.request('alice', owner('alice'), scope, voice, body, 'tts:segment:0');
  await f.open().request('alice', owner('alice'), scope, voice, body, 'tts:segment:0');
  await f.meter.close('alice', owner('alice'), scope);
  await f.meter.request('alice', owner('alice'), scope, voice, body, 'tts:segment:1');
  assert.equal((await f.meter.close('alice', owner('alice'), scope)).costMicros, 24000);
  assert.equal(f.state.posts, 2);
});

test('a confirmed cost above the hold can settle after funds become available without dispatching again', async t => {
  const f = await fixture(t);
  await f.credits.reserve({ userId: 'alice', taskId: 'other-held-task', kind: 'mix', units: 90 });
  await assert.rejects(f.meter.request('alice', owner('alice'), scope, llm, payload), { code: 'INSUFFICIENT_POINTS' });
  assert.equal(f.state.posts, 1);
  assert.ok((await f.credits.snapshot('alice')).available >= 0);
  await f.credits.release({ userId: 'alice', taskId: 'other-held-task' });
  await f.meter.request('alice', owner('alice'), scope, llm, payload);
  assert.equal(f.state.posts, 1);
  assert.equal((await f.credits.snapshot('alice')).available, 998);
});

test('a paid but invalid model result can be retried while retaining both actual bills', async t => {
  const f = await fixture(t);
  await f.meter.request('alice', owner('alice'), scope, llm, payload);
  await f.meter.reject('alice', owner('alice'), scope, llm, payload);
  await f.meter.request('alice', owner('alice'), scope, llm, payload);
  const summary = await f.meter.close('alice', owner('alice'), scope);
  assert.equal(summary.costMicros, 24000);
  assert.equal(summary.chargedPoints, 3);
  assert.equal(f.state.posts, 2);
  assert.equal((await f.credits.snapshot('alice')).available, 997);
});

test('a success response cannot be settled from a zero-cost error log sharing its request ID', async t => {
  const f = await fixture(t); f.state.errorLog = true; f.state.quota = 0;
  await assert.rejects(f.meter.request('alice', owner('alice'), scope, llm, payload), { code: 'COST_USAGE_MISSING' });
  assert.ok((await f.credits.snapshot('alice')).held > 0);
});
