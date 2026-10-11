import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStructuredOutput } from '../services/restaurant/structured-output.mjs';
import { createRestaurantModel } from '../services/restaurant/model.mjs';

const payload = (content, finish_reason = 'stop') => ({ id: 'provider-known', usage: { completion_tokens: 12 }, choices: [{ message: { content }, finish_reason }] });

test('structured replies accept complete wrappers and text blocks without repairing missing JSON', () => {
  const object = { directions: [], note: '引号、括号 { } 和换行\n都保留' }, json = JSON.stringify(object);
  for (const content of [json, '```json ' + json + '```', '分析完成：\n```json\n' + json + '\n```', [{ type: 'text', text: json }]]) assert.deepEqual(parseStructuredOutput(payload(content)), object);
  for (const content of ['{"directions":', '[]', '两个结果：{} {}', '参考：[{}]', null]) assert.throws(() => parseStructuredOutput(payload(content)), { code: 'MODEL_INVALID_OUTPUT' });
  for (const reason of ['length', 'max_tokens']) assert.throws(() => parseStructuredOutput(payload(json, reason)), error => error.outputIssue === 'truncated');
  assert.throws(() => parseStructuredOutput(payload(json, 'content_filter')), { code: 'MODEL_REFUSED' });
});

async function fixture(t, sequence) {
  const storageDir = await mkdtemp(join(tmpdir(), 'restaurant-structured-'));
  const requests = [];
  const model = createRestaurantModel({ storageDir, config: { apiKey: 'test-only', imageTextModel: 'test-claude', baseUrl: 'https://provider.invalid', limits: { chatDaily: 100, perMinute: 10 } },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      const reply = sequence[requests.length - 1];
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply));
    } });
  await model.ready;
  t.after(async () => { await model.close(); await rm(storageDir, { recursive: true, force: true }); });
  return { model, requests };
}

test('a known truncated response increases output budget and retries only the failed text node', async t => {
  const f = await fixture(t, [payload('{"directions":', 'length'), payload('{"directions":[]}')]);
  const retries = [];
  assert.deepEqual(await f.model.recommend([], {}, { onStructuredRetry: event => retries.push(event) }), []);
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0].max_tokens, 8192); assert.equal(f.requests[1].max_tokens, 16384);
  assert.equal(retries.length, 1);
  const usage = await f.model.usage();
  assert.equal(usage.used.chat, 2);
  const failed = usage.recent.find(item => item.status === 'failed');
  assert.equal(failed.outputIssue, 'truncated'); assert.equal(failed.usage.completion_tokens, 12); assert.equal(failed.providerRequestId, 'provider-known');
});

test('malformed output recovers once; persistent invalid output stops without unbounded calls', async t => {
  const recovered = await fixture(t, [payload('{bad'), payload('结果：{"directions":[]}')]);
  assert.deepEqual(await recovered.model.recommend([], {}), []); assert.equal(recovered.requests.length, 2);
  const failed = await fixture(t, [payload('{bad'), payload('{bad')]);
  await assert.rejects(failed.model.recommend([], {}), error => error.code === 'MODEL_INVALID_OUTPUT' && error.providerResponseComplete);
  assert.equal(failed.requests.length, 2);
});

test('connection loss and refusals do not trigger automatic replay', async t => {
  const uncertain = await fixture(t, [new Error('transport lost')]);
  await assert.rejects(uncertain.model.recommend([], {}), { code: 'PROVIDER_UNCERTAIN' }); assert.equal(uncertain.requests.length, 1);
  const refusal = await fixture(t, [payload(null, 'content_filter')]);
  await assert.rejects(refusal.model.recommend([], {}), { code: 'MODEL_REFUSED' }); assert.equal(refusal.requests.length, 1);
});
