import test from 'node:test';
import assert from 'node:assert/strict';
import {detectSpeechLanguage} from '../src/lib/engine/speech-language.ts';

const config = {openluxApiKey: 'primary-key', openluxBaseUrl: 'https://api.openlux.ai', falApiKey: 'fal-key'};
async function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { await run(); } finally { globalThis.fetch = original; }
}

test('Chinese scripts keep the old route without requiring language-service credentials', async () => {
  await withFetch(() => assert.fail('Chinese should not need a language API'), async () => {
    for (const text of ['欢迎大家，今天的价格是25元！', '歡迎大家，一起來看看。']) assert.equal(await detectSpeechLanguage(text, {}), 'zh');
    for (const text of ['', '12345 !?']) await assert.rejects(detectSpeechLanguage(text, {}), {code: 'SPEECH_LANGUAGE_UNCERTAIN'});
  });
});

test('primary classification uses GPT-6 Luna and treats the entire unchanged script as data', async () => {
  for (const [text, language] of [['Welcome everyone, our product costs RM 25.', 'en'], ['Selamat datang, produk baharu kami berharga RM 25.', 'ms'], ['今天介绍iPhone的使用方法。', 'zh']]) {
    await withFetch(async (url, options) => {
      assert.equal(url, 'https://api.openlux.ai/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer primary-key');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gpt-6-luna');
      assert.equal(body.messages[1].content, JSON.stringify({script: text}));
      return Response.json({choices: [{message: {content: JSON.stringify({language})}}]});
    }, async () => assert.equal(await detectSpeechLanguage(text, config), language));
  }
});

test('unavailable primary classifier uses the configured fal key once with the same model', async () => {
  for (const failure of ['http', 'network', 'invalid']) {
    const urls = [];
    await withFetch(async (url, options) => {
      urls.push(url);
      if (url.includes('openlux')) {
        if (failure === 'network') throw new Error('private detail');
        return failure === 'http' ? new Response('', {status: 503}) : Response.json({choices: []});
      }
      assert.equal(options.headers.Authorization, 'Key fal-key');
      assert.equal(JSON.parse(options.body).model, 'openai/gpt-6-luna');
      return Response.json({output: '{"language":"ms"}'});
    }, async () => assert.equal(await detectSpeechLanguage('Selamat datang semua.', config), 'ms'));
    assert.deepEqual(urls, ['https://api.openlux.ai/v1/chat/completions', 'https://fal.run/openrouter/router']);
  }
});

test('unknown, unsupported, partial and failed language results stop without guessing English', async () => {
  for (const result of [{output: '{"language":"unknown"}'}, {output: '{"language":"id"}'}, {output: '{"language":"en"}', partial: true}, {error: 'private provider error'}]) {
    let calls = 0;
    await withFetch(async () => { calls++; return Response.json(result); }, async () => {
      await assert.rejects(detectSpeechLanguage('Hotel', {...config, openluxApiKey: ''}), error => error.code === 'SPEECH_LANGUAGE_UNCERTAIN' && !error.message.includes('private'));
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await withFetch(async () => { calls++; return Response.json({choices: [{message: {content: '{"language":"unknown"}'}}]}); }, async () => {
    await assert.rejects(detectSpeechLanguage('Hotel', config), {code: 'SPEECH_LANGUAGE_UNCERTAIN'});
  });
  assert.equal(calls, 1, 'A clear unknown result does not need another classifier');
});
