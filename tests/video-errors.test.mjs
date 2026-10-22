import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoProvider, parseGeneration } from '../services/video/provider.mjs';
import { createWan3Provider } from '../services/video/wan3.mjs';
import { safeVideoError } from '../services/video/errors.mjs';

const copyright = 'The request failed because the output may be related to copyright restrictions. Request id: request-test-2';
const config = { video: { base: 'https://provider.example', project: 'project', access: 'private-access', secret: 'private-secret' },
  material: { base: 'https://provider.example', project: 'project', access: 'private-access', secret: 'private-secret' } };

test('Seedance keeps the nested failed result rather than the successful query envelope', () => {
  const result = parseGeneration({ success: true, msg: '操作成功！', data: { success: false, status: 3, taskId: 'part-two', message: copyright } });
  assert.equal(result.failed, true);
  assert.match(result.error, /生成结果可能涉及版权限制/);
  assert.ok(result.error.includes(copyright));
  assert.doesNotMatch(result.error, /操作成功/);
  assert.equal(parseGeneration({ data: { status: 1, message: 'processing' } }).error, undefined);
});

test('material review retains the matching asset rejection and strips credentials and URLs', async () => {
  const provider = createVideoProvider(config, async () => Response.json({ data: { records: [
    { materialId: 'other', status: 3, errorMsg: 'wrong asset' },
    { materialId: 'reference', status: 3, errorMsg: 'The request failed because the input video may contain sensitive information. private-secret https://cdn.example/video?signature=private' },
  ] } }));
  const result = await provider.queryMaterial('reference');
  assert.equal(result.status, 3); assert.match(result.error, /参考视频可能包含敏感内容/);
  assert.doesNotMatch(result.error, /wrong asset|private-secret|cdn\.example|signature=private/);
});

for (const status of [403, 429, 503]) test(`Seedance HTTP ${status} retains the provider error code and reason`, async () => {
  const provider = createVideoProvider(config, async () => Response.json({ code: 'QuotaDenied', message: '额度不足 private-access', requestId: 'request-3' }, { status }));
  await assert.rejects(provider.query('task'), cause => {
    assert.match(cause.message, new RegExp(`HTTP ${status}`)); assert.match(cause.message, /QuotaDenied.*request-3/);
    assert.match(cause.message, /额度不足/); assert.doesNotMatch(cause.message, /private-access/); return true;
  });
});

test('Wan failed jobs preserve output diagnostics, while HTTP rejection stays a confirmed non-dispatch', async () => {
  const provider = createWan3Provider({ dashscopeKey: 'private-wan-key' }, async () => Response.json({ request_id: 'request-wan',
    output: { task_status: 'FAILED', code: 'DataInspectionFailed', message: 'Reference video rejected private-wan-key' } }));
  const result = await provider.query('task');
  assert.equal(result.failed, true); assert.match(result.error, /Reference video rejected.*DataInspectionFailed.*request-wan/);
  assert.doesNotMatch(result.error, /private-wan-key/);
  const rejected = createWan3Provider({ dashscopeKey: 'private-wan-key' }, async () => Response.json({ code: 'InvalidApiKey', message: 'Key expired' }, { status: 401 }));
  await assert.rejects(rejected.query('task'), cause => cause.providerNotDispatched && /Key expired.*InvalidApiKey/.test(cause.message));
});

test('diagnostics redact auth values and bound long messages', () => {
  const result = safeVideoError('Authorization: Bearer abc.def X-Secret-Key: key-secret api_key="key-private" token=key-token https://cdn.example/private?sig=value');
  assert.doesNotMatch(result, /abc\.def|key-secret|key-private|key-token|cdn\.example/);
  assert.equal(safeVideoError('a'.repeat(3000)).length, 1600);
});

test('unreadable rejection bodies do not turn a confirmed Wan rejection into uncertain dispatch', async () => {
  for (const status of [401, 429]) {
    const provider = createWan3Provider({ dashscopeKey: 'private-key' }, async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('connection closed while reading error body')); },
    }), { status }));
    await assert.rejects(provider.query('task'), cause => cause.providerNotDispatched && cause.message.includes(`HTTP ${status}`));
  }
});
