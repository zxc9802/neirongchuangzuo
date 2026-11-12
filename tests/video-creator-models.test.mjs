import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createDirectorModel } from '../services/video-creator/model.mjs';
import { directorSelection } from '../services/video-creator/director-provider.mjs';

const config = { apiKey: 'test-key', falKey: 'existing-fal-key', arkKey: 'fixture-ark-key', baseUrl: 'https://api.openlux.ai/v1', imageTextModel: 'unrelated-vision-model' };
const endpoint = 'https://queue.fal.run/openrouter/router/openai/v1/chat/completions';
const requestId = '01a1cec6-8ab8-7113-9ecb-5af9a3a71cfc';
const resultUrl = `https://queue.fal.run/openrouter/router/requests/${requestId}`;
async function sample(t) {
  const root = await mkdtemp(join(tmpdir(), 'director-models-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'product.jpg'); await sharp({ create: { width: 128, height: 160, channels: 3, background: '#ffc900' } }).jpeg().toFile(path);
  return { directorModel: 'haiku', skill: 'signature', settings: { duration: 4, ratio: '9:16', resolution: '720p', language: 'zh', generateAudio: true },
    assets: [{ id: 'product', name: '产品', type: 'image', path }], history: [{ role: 'user', content: '保留黄色主体' }], message: '用新奇角度突出产品' };
}
const output = { kind: 'script', script: { title: '亮色开场', globalDirection: '保留产品外形，用特写到整体的揭示吸引观众。',
  shots: [{ start: 0, end: 4, visual: '产品特写拉到整体', referenceIds: ['product'], camera: '拉远', caption: '', voiceover: '' }] } };
const completion = (value = output, finish = 'stop') => ({ id: 'carbon-completion', choices: [{ finish_reason: finish, message: {
  content: typeof value === 'string' ? value : JSON.stringify(value), reasoning: 'private reasoning',
} }], usage: { prompt_tokens: 200, completion_tokens: 400 } });
function queueFetch(onSubmit = () => {}, result = () => Response.json(completion())) {
  return async (url, options = {}) => {
    assert.equal(options.headers.Authorization, 'Key existing-fal-key');
    assert.equal(options.redirect, 'error');
    if (url === endpoint) {
      onSubmit(JSON.parse(options.body));
      return Response.json({ request_id: requestId, status_url: 'https://untrusted.invalid/status', response_url: 'https://untrusted.invalid/result' });
    }
    if (url === resultUrl + '/status') return Response.json({ status: 'COMPLETED' });
    assert.equal(url, resultUrl); return result();
  };
}

test('Doubao and legacy Gemini selections use the official Ark stream with separate credentials and real pixels',async t=>{
  assert.equal(directorSelection().id,'doubao');assert.equal(directorSelection('gemini').id,'doubao');
  for(const directorModel of ['doubao','gemini']) {
    const input={...await sample(t),directorModel},attempts=[];let sent,calls=0;
    const result=await createDirectorModel({config,fetchImpl:async(url,options)=>{
      calls++;assert.equal(url,'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
      assert.equal(options.headers.Authorization,'Bearer fixture-ark-key');assert.equal(options.redirect,'error');
      sent=JSON.parse(options.body);
      const providerOutput=JSON.parse(JSON.stringify(output).replaceAll('"product"','"asset-01"'));
      const raw='data: '+JSON.stringify({id:'ark-test-id',choices:[{delta:{reasoning_content:'private thinking'}}]})+'\n\n'
        +'data: '+JSON.stringify({id:'ark-test-id',choices:[{delta:{content:JSON.stringify(providerOutput)},finish_reason:'stop'}]})+'\n\n'
        +'data: '+JSON.stringify({id:'ark-test-id',choices:[],usage:{prompt_tokens:200,completion_tokens:400}})+'\n\ndata: [DONE]\n\n';
      return new Response(raw,{headers:{'Content-Type':'text/event-stream','x-request-id':'ark-test-id'}});
    }}).generate(input,{onAttempt:a=>attempts.push(a)});
    assert.equal(calls,1);assert.equal(result.kind,'script');assert.equal(sent.model,'doubao-seed-2-1-pro-260915');
    assert.equal(sent.stream,true);assert.deepEqual(sent.stream_options,{include_usage:true});
    assert.deepEqual(sent.thinking,{type:'enabled'});assert.equal(sent.reasoning_effort,'medium');
    assert.equal(sent.max_completion_tokens,65536);assert.equal(sent.max_tokens,undefined);
    assert.deepEqual(sent.response_format,{type:'json_object'});assert.equal(sent.messages[1].content.filter(p=>p.type==='image_url').length,1);
    assert.equal(JSON.parse(sent.messages[1].content[0].text).assets[0].id,'asset-01');
    assert.deepEqual(result.script.shots[0].referenceIds,['product']);
    assert.equal(attempts.at(-1).providerRequestId,'ark-test-id');
    assert.doesNotMatch(JSON.stringify(result),/private thinking|fixture-ark-key/);
    assert.doesNotMatch(JSON.stringify(attempts),/fixture-ark-key|existing-fal-key|test-key/);
  }
});

test('missing Ark credentials fail before observation, and provider diagnostics redact the Ark key',async t=>{
  let calls=0;const input={...await sample(t),directorModel:'doubao',groundingVersion:1};
  await assert.rejects(createDirectorModel({config:{...config,arkKey:''},fetchImpl:async()=>{calls++;}}).generate(input),{code:'DIRECTOR_NOT_CONFIGURED'});
  assert.equal(calls,0);
  const attempts=[];
  await assert.rejects(createDirectorModel({config,fetchImpl:async()=>new Response('rejected fixture-ark-key',{status:401})}).generate({...input,groundingVersion:undefined},{onAttempt:a=>attempts.push(a)}),{code:'DIRECTOR_PROVIDER_ERROR'});
  assert.doesNotMatch(JSON.stringify(attempts),/fixture-ark-key/);
});

for (const [directorModel, model] of [['haiku', 'anthropic/claude-haiku-5.5']])
test(`${directorModel} uses fal with real pixels, history, high thinking and private credentials`, async t => {
  const input = { ...await sample(t), directorModel }, attempts = []; let sent;
  const result = await createDirectorModel({ config, fetchImpl: queueFetch(body => { sent = body; }) }).generate(input, { onAttempt: entry => attempts.push(entry) });
  assert.equal(result.kind, 'script'); assert.equal(result.usage.completion_tokens, 400);
  assert.equal(sent.model, model); assert.equal(sent.stream, false);
  assert.equal(sent.top_p, undefined);
  assert.deepEqual(sent.reasoning, { effort: 'high', exclude: true });
  assert.deepEqual(sent.response_format, { type: 'json_object' });
  assert.equal(sent.max_tokens, 65536); assert.equal(sent.temperature, 1);
  const metadata = JSON.parse(sent.messages[1].content[0].text);
  assert.deepEqual(metadata.history, input.history); assert.equal(metadata.request, input.message);
  const photo = await sharp(Buffer.from(sent.messages[1].content.find(p => p.image_url).image_url.url.split(',')[1], 'base64')).metadata();
  assert.equal(photo.height, 160); assert.match(sent.messages[0].content, /创意优先/);
  assert.equal(attempts.at(-1).providerRequestId, requestId);
  assert.doesNotMatch(JSON.stringify(result), /private reasoning/);
  assert.doesNotMatch(JSON.stringify(attempts), /existing-fal-key|test-key|data:image/);
  assert.equal(config.imageTextModel, 'unrelated-vision-model');
});

test('Kimi preserves its own transport and existing credentials', async t => {
  const input = await sample(t); let sent;
  await createDirectorModel({ config, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openlux.ai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key'); sent = JSON.parse(options.body);
    return Response.json(completion());
  } }).generate({ ...input, directorModel: 'kimi' });
  assert.equal(sent.model, 'kimi-k3.1-pro'); assert.equal(sent.reasoning_effort, 'max');
  assert.equal(sent.messages[1].content.filter(p => p.type === 'image_url').length, 1);
});

test('completed truncated Haiku output retries with corrected input and a larger budget', async t => {
  const input = await sample(t), sent = [];
  const result = await createDirectorModel({ config, maxOutputTokens: 16384,
    fetchImpl: queueFetch(body => sent.push(body), () => Response.json(sent.length === 1 ? completion('{', 'length') : completion())),
  }).generate(input);
  assert.equal(result.script.title, output.script.title);
  assert.deepEqual(sent.map(s => s.max_tokens), [16384, 32768]);
  assert.match(sent[1].messages[1].content.at(-1).text, /truncated/);
});

for (const directorModel of ['haiku'])test(`${directorModel} missing fal credentials fail before observation or any paid call`, async t => {
  let calls = 0;
  const model = createDirectorModel({ config: { ...config, falKey: '' }, fetchImpl: async () => { calls++; } });
  await assert.rejects(model.generate({ ...await sample(t), directorModel, groundingVersion: 1 }), { code: 'DIRECTOR_NOT_CONFIGURED' });
  assert.equal(calls, 0);
});

for (const directorModel of ['haiku'])test(`${directorModel} failed queue polling, ambiguous submissions and failed accepted results never resubmit`, async t => {
  const input = { ...await sample(t), directorModel };
  for (const failure of ['status', 'result', 'submission']) {
    let posts = 0;
    const model = createDirectorModel({ config, fetchImpl: async (url, options = {}) => {
      if (options.method === 'POST') { posts++; return Response.json(failure === 'submission' ? {} : { request_id: requestId }); }
      if (url.endsWith('/status')) return failure === 'status' ? new Response('unavailable', { status: 503 }) : Response.json({ status: 'COMPLETED' });
      return new Response('upstream timeout', { status: 504 });
    } });
    await assert.rejects(model.generate(input)); assert.equal(posts, 1, failure);
  }
});

test('cancelled queue waits retain the request ID and never submit another job', async t => {
  const input = await sample(t), controller = new AbortController(), attempts = []; let posts = 0;
  const model = createDirectorModel({ config, fetchImpl: async (_url, options = {}) => {
    if (options.method === 'POST') { posts++; return Response.json({ request_id: requestId }); }
    controller.abort(); return Response.json({ status: 'IN_PROGRESS' });
  } });
  await assert.rejects(model.generate(input, { signal: controller.signal, onAttempt: entry => attempts.push(entry) }), { code: 'DIRECTOR_INTERRUPTED' });
  assert.equal(posts, 1); assert.equal(attempts.at(-1).providerRequestId, requestId);
});

for (const directorModel of ['haiku','doubao'])test(`grounded ${directorModel} keeps original images and independent factual review`, async t => {
  const input = { ...await sample(t), directorModel, groundingVersion: 1 }, sent = [], candidate = structuredClone(output);
  candidate.script.shots[0].evidence = [{ assetId: 'product', factIndexes: [0], use: 'detail' }];
  let carbon;
  const falFetch = queueFetch(body => { carbon = body; }, () => Response.json(completion(candidate)));
  const result = await createDirectorModel({ config, fetchImpl: async (url, options) => {
    if (url.startsWith('https://queue.fal.run/')) return falFetch(url, options);
    if (url.startsWith('https://ark.cn-beijing.volces.com/')) {
      assert.equal(options.headers.Authorization,'Bearer fixture-ark-key');
      carbon=JSON.parse(options.body);return Response.json(completion(JSON.parse(JSON.stringify(candidate).replaceAll('"product"','"asset-01"'))));
    }
    const body = JSON.parse(options.body); sent.push(body);
    return Response.json(completion(sent.length === 1 ? { observations: [{ id: 'product', kinds: ['detail'], facts: ['黄色产品'], uncertain: [] }] } : { passed: true, issues: [] }));
  } }).generate(input);
  assert.equal(sent.length, 2); assert.equal(result.quality.passed, true);
  assert.equal(carbon.messages[1].content.filter(p => p.image_url).length, 1);
  assert.match(carbon.messages[1].content[1].text, /黄色产品/);
  if(directorModel==='doubao')assert.match(carbon.messages[0].content,/scene图片拍局部特写仍填scene/);
  assert.equal(sent[1].model, config.imageTextModel);
});

for (const [directorModel, model] of [['haiku', 'anthropic/claude-haiku-5.5']])
test(`narration repairs use ${directorModel} with the same full thinking budget`, async t => {
  const input = { ...await sample(t), directorModel, planningVersion: 2 }, candidate = structuredClone(output), sent = [];
  candidate.assets = [{ id: 'product', description: '黄色产品', role: '产品主体', adopt: '保留可见形态' }];
  candidate.script.plan = { objective: '展示产品细节', audience: '对产品感兴趣的观众', perspective: '产品展示', storyArc: '从细节到整体', visualStyle: '自然明亮', cast: [], audio: { voiceDirection: '自然中文', music: '轻音乐', ambience: '轻声' }, keep: ['产品外形'], avoid: ['虚构效果'] };
  candidate.script.shots[0].intent = '展示产品细节';
  candidate.script.shots[0].voiceover = '这一段很长很长的旁白不可能在四秒钟内读完，我们要把店内每一个具体区域的细节都讲出来。';
  const result = await createDirectorModel({ config, fetchImpl: queueFetch(body => sent.push(body),
    () => Response.json(completion(sent.length === 1 ? candidate : { voiceovers: ['亮色登场，看看产品细节'] }))),
  }).generate(input);
  assert.equal(sent.length, 2); assert.equal(sent[1].model, model);
  assert.equal(sent[1].max_tokens, 65536); assert.equal(sent[1].reasoning.effort, 'high');
  assert.equal(result.narrationRepaired, true);
});
