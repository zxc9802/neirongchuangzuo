import test from 'node:test';
import assert from 'node:assert/strict';
import { readCompletionStream } from '../services/restaurant/model-stream.mjs';
import { createRestaurantModel } from '../services/restaurant/model.mjs';

function event(value) { return `data: ${JSON.stringify(value)}\r\n\r\n`; }
function complete(content, finish = 'stop') {
  return ': ping\r\n\r\n' + event({ id: 'stream-request', model: 'claude-opus-5-5', choices: [{ index: 0, delta: { content: content.slice(0, 5) }, finish_reason: null }] })
    + event({ choices: [{ index: 0, delta: { content: content.slice(5) }, finish_reason: finish }] })
    + event({ choices: [], usage: { prompt_tokens: 32, completion_tokens: 48 } }) + 'data: [DONE]\r\n\r\n';
}
function fragmented(text) {
  const bytes = Buffer.from(text);
  return new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3)); controller.close(); } });
}

test('stream parser accepts text block deltas and full-message compatibility envelopes', async () => {
  const first = await readCompletionStream(fragmented(event({ choices: [{ delta: { content: [{ type: 'text', text: '{"ok":' }] } }] })
    + event({ choices: [{ delta: { content: [{ type: 'text', text: 'true}' }] }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'));
  assert.equal(first.choices[0].message.content, '{"ok":true}');
  const second = await readCompletionStream(fragmented(event({ choices: [{ message: { content: [{ type: 'text', text: '{"ok":true}' }] }, finish_reason: 'stop' }] })));
  assert.equal(second.choices[0].message.content, '{"ok":true}');
});
const config = { apiKey: 'stream-test', baseUrl: 'https://provider.invalid/v1', imageTextModel: 'claude-opus-5-5', limits: {} };
function harness(fetchImpl) {
  const records = [], finishes = [], requests = [];
  const ledger = { ready: Promise.resolve(), async reserve(value) { records.push(value); }, async markDispatched() {}, async finish(id, value) { finishes.push({ id, ...value }); } };
  return { records, finishes, requests, model: createRestaurantModel({ config, ledger, fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body)); return fetchImpl(url, options, requests.length); } }) };
}

test('stream parser preserves split UTF-8, CRLF events, complete content, provider ID and final usage', async () => {
  const content = JSON.stringify({ theme: '深青夜色🍜', foodGroups: [], shots: [] });
  const payload = await readCompletionStream(fragmented(complete(content)));
  assert.equal(payload.choices[0].message.content, content); assert.equal(payload.id, 'stream-request'); assert.equal(payload.choices[0].finish_reason, 'stop');
  assert.deepEqual(payload.usage, { prompt_tokens: 32, completion_tokens: 48 });
});

test('planning actually requests streaming and only records completion after the full structured result', async () => {
  const board = { theme: '深青夜色', foodGroups: [], shots: [] };
  const app = harness(() => new Response(fragmented(complete(JSON.stringify(board))), { headers: { 'Content-Type': 'text/event-stream' } }));
  assert.deepEqual(await app.model.planGallery({ analysis: [], profile: {}, outputCount: 9 }), board);
  assert.equal(app.requests[0].stream, true); assert.deepEqual(app.requests[0].stream_options, { include_usage: true });
  assert.equal(app.finishes[0].status, 'completed'); assert.equal(app.finishes[0].providerRequestId, 'stream-request'); assert.equal(app.finishes[0].usage.completion_tokens, 48);
});

test('incomplete streams and broken transports remain uncertain and are never automatically replayed', async t => {
  for (const broken of [false, true]) await t.test(String(broken), async () => {
    const app = harness(() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(event({ choices: [{ delta: { content: '{"theme":"夜色' }, finish_reason: null }] })));
      if (broken) controller.error(Error('connection reset')); else controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    await assert.rejects(app.model.planGallery({ analysis: [], profile: {}, outputCount: 9 }), { code: 'PROVIDER_UNCERTAIN' });
    assert.equal(app.requests.length, 1); assert.equal(app.finishes[0].status, 'uncertain');
  });
});

test('only completed truncated or malformed streams receive one bounded structured correction', async t => {
  const board = { theme: '夜色', foodGroups: [], shots: [] };
  for (const bad of [complete('{"theme":', 'length'), 'data: malformed\n\ndata: [DONE]\n\n']) await t.test(bad.slice(0, 30), async () => {
    const app = harness((_url, _options, attempt) => new Response(attempt === 1 ? bad : complete(JSON.stringify(board)), { headers: { 'Content-Type': 'text/event-stream' } }));
    assert.deepEqual(await app.model.planGallery({ analysis: [], profile: {}, outputCount: 9 }), board);
    assert.equal(app.requests.length, 2); assert.deepEqual(app.finishes.map(f => f.status), ['failed','completed']);
  });
});

test('streamed refusal and explicit upstream errors stop without a replay', async t => {
  for (const [stream, code] of [
    [event({ choices: [{ index: 0, delta: { refusal: 'refused' }, finish_reason: 'content_filter' }] }) + 'data: [DONE]\n\n', 'MODEL_REFUSED'],
    [event({ error: { message: 'busy' } }) + 'data: [DONE]\n\n', 'PROVIDER_ERROR'],
  ]) await t.test(code, async () => {
    const app = harness(() => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
    await assert.rejects(app.model.planGallery({ analysis: [], profile: {}, outputCount: 9 }), { code });
    assert.equal(app.requests.length, 1); assert.equal(app.finishes[0].status, 'failed');
  });
});
