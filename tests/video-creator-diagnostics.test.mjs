import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createDirectorModel, validateDirectorResult } from '../services/video-creator/model.mjs';
import { readDirectorResponse, directorAttemptSummary, directorFailure } from '../services/video-creator/director-response.mjs';

const config = { apiKey: 'sk-private-test-key', baseUrl: 'https://model.example/v1', imageTextModel: 'claude-opus-5-5' };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'director-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'photo.jpg'); await sharp({ create: { width: 200, height: 300, channels: 3, background: '#335544' } }).jpeg().toFile(path);
  const input = { skill: 'store-discovery', settings: { duration: 4, ratio: '9:16', resolution: '480p', language: 'zh', generateAudio: true },
    assets: [{ id: 'real-photo', path, name: '实拍.jpg', type: 'image' }], history: [], message: '介绍这家店' };
  const output = { kind: 'script', script: { title: '真实门店', globalDirection: '暖黄灯光', shots: [{ start: 0, end: 4,
    visual: '门店空间', camera: '平移', referenceIds: ['real-photo'], voiceover: '', caption: '' }] } };
  return { input, output };
}
function completion(content, finish = 'stop', tokens = 20) {
  return { id: 'upstream-id', choices: [{ index: 0, message: { content }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: tokens } };
}
function sse(payload) {
  const choice = payload.choices[0];
  return 'data: ' + JSON.stringify({ ...payload, choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: choice.finish_reason }] }) + '\n\ndata: [DONE]\n\n';
}
const streamResponse = payload => new Response(sse(payload), { headers: { 'content-type': 'text/event-stream', 'x-api-request-id': 'outer-receipt-id' } });

test('a request timer expiring during later validation cannot relabel a quality rejection as network timeout',()=>{
  const signal=AbortSignal.abort(new DOMException('Timeout','TimeoutError'));
  const cause=Object.assign(new Error('脚本依据不符'),{code:'DIRECTOR_INVALID_OUTPUT',outputIssue:'quality_rejected'});
  assert.equal(directorFailure(cause,'validate',signal).code,'DIRECTOR_INVALID_OUTPUT');
  assert.equal(directorFailure(new Error('read failed'),'response',signal).code,'DIRECTOR_TIMEOUT');
});

test('a terminal SSE event completes even if the gateway leaves the HTTP connection open', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(sse(completion('{"ok":true}')))); }, cancel() { cancelled = true; } });
  const result = await readDirectorResponse(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(result.payload.choices[0].finish_reason, 'stop'); assert.equal(cancelled, true);
  assert.match(result.rawResponse, /\[DONE\]/);
});

test('director raises output budget and preserves finish reason, raw wire response and usage without secrets', async t => {
  const { input, output } = await setup(t); output.script.globalDirection += config.apiKey;
  const attempts = []; let sent;
  const payload = completion(JSON.stringify(output));
  const result = await createDirectorModel({ config, fetchImpl: async (_url, opts) => { sent = JSON.parse(opts.body); return streamResponse(payload); } })
    .generate(input, { onAttempt: entry => attempts.push(entry) });
  assert.equal(sent.max_tokens, 16384); assert.equal(result.kind, 'script');
  const last = attempts.at(-1); assert.equal(last.finishReason, 'stop'); assert.equal(last.status, 'completed');
  assert.equal(last.providerRequestId, 'outer-receipt-id'); assert.equal(last.usage.completion_tokens, 20);
  assert.ok(last.rawResponse.includes('[DONE]')); assert.ok(last.parsedResponse.choices[0].message.content.includes('[REDACTED]'));
  assert.ok(!JSON.stringify(attempts).includes(config.apiKey));
  const summary = directorAttemptSummary(last); assert.equal(summary.finishReason, 'stop');
  for (const key of ['rawResponse', 'responseContent', 'parsedResponse']) assert.equal(key in summary, false);
});

test('completed truncation retries once with doubled output budget and does not reuse the partial script', async t => {
  const { input, output } = await setup(t); const sent = [], attempts = [];
  const model = createDirectorModel({ config, fetchImpl: async (_url, opts) => {
    sent.push(JSON.parse(opts.body)); return streamResponse(sent.length === 1 ? completion('{"kind":"script","script":', 'length', 16384) : completion(JSON.stringify(output)));
  } });
  const result = await model.generate(input, { onAttempt: entry => attempts.push(entry) });
  assert.equal(result.script.title, output.script.title);
  assert.deepEqual(sent.map(x => x.max_tokens), [16384, 32768]);
  const failure = attempts.find(a => a.status === 'failed'); assert.equal(failure.finishReason, 'length');
  assert.equal(failure.error.code, 'DIRECTOR_OUTPUT_TRUNCATED'); assert.equal(failure.error.issue, 'truncated');
  assert.match(failure.rawResponse, /length/); assert.match(sent[1].messages[1].content.at(-1).text, /完整/);
  assert.equal(attempts.at(-1).status, 'completed');
});

test('repeated malformed output has a concrete JSON error and preserves both original responses', async t => {
  const { input } = await setup(t); const attempts = []; let calls = 0;
  const model = createDirectorModel({ config, fetchImpl: async () => { calls++; return streamResponse(completion('{"kind": bad value}')); } });
  await assert.rejects(model.generate(input, { onAttempt: entry => attempts.push(entry) }), error => error.code === 'DIRECTOR_INVALID_JSON' && error.outputIssue === 'invalid_json');
  assert.equal(calls, 2); const failures = attempts.filter(a => a.status === 'failed'); assert.equal(failures.length, 2);
  assert.ok(failures.every(a => a.rawResponse.includes('bad value') && a.finishReason === 'stop' && a.error.phase === 'parse'));
  assert.match(failures[0].error.detail, /JSON|Unexpected|Expected/i);
});

test('unfinished transports retain partial raw response and are not silently replayed', async t => {
  const { input } = await setup(t); const attempts = []; let calls = 0;
  const raw = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '{"title":"半截' } }] }) + '\n\n';
  const model = createDirectorModel({ config, fetchImpl: async () => { calls++; return new Response(raw, { headers: { 'content-type': 'text/event-stream' } }); } });
  await assert.rejects(model.generate(input, { onAttempt: entry => attempts.push(entry) }), { code: 'DIRECTOR_STREAM_INCOMPLETE' });
  assert.equal(calls, 1); const last = attempts.at(-1); assert.equal(last.rawResponse, raw); assert.equal(last.finishReason, null);
  assert.equal(last.error.issue, 'MODEL_STREAM_INCOMPLETE');
});

test('empty completions, refusals and HTTP errors keep distinct diagnoses', async t => {
  const { input } = await setup(t);
  for (const [response, expected, callsExpected] of [
    [() => streamResponse(completion('')), 'DIRECTOR_EMPTY_OUTPUT', 2],
    [() => streamResponse(completion('', 'content_filter')), 'MODEL_REFUSED', 1],
    [() => new Response('invalid max_tokens', { status: 400 }), 'DIRECTOR_PROVIDER_ERROR', 1],
  ]) {
    let calls = 0; const records = [];
    const model = createDirectorModel({ config, fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(model.generate(input, { onAttempt: entry => records.push(entry) }), { code: expected });
    assert.equal(calls, callsExpected); assert.equal(records.at(-1).error.code, expected); assert.ok(records.at(-1).rawResponse !== undefined);
  }
});

test('raw responses are bounded and timeline/reference validation includes exact fields', async t => {
  await assert.rejects(readDirectorResponse(new Response('123456789'), 5), error => error.code === 'DIRECTOR_RESPONSE_TOO_LARGE' && error.rawResponse === '12345' && error.rawTruncated === true);
  const { input, output } = await setup(t);
  output.script.shots[0].referenceIds = ['invented'];
  assert.throws(() => validateDirectorResult(output, input), error => error.outputIssue === 'invalid_reference' && error.validationIssue.includes('invented'));
  output.script.shots[0] = null;
  assert.throws(() => validateDirectorResult(output, input), error => error.outputIssue === 'invalid_schema' && error.validationIssue.includes('shot'));
});
