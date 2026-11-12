import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createDirectorModel } from '../services/video-creator/model.mjs';
import { geminiCompletion } from '../services/video-creator/director-provider.mjs';

const config = { apiKey: 'test-key', baseUrl: 'https://api.openlux.ai/v1', imageTextModel: 'unrelated-vision-model' };
async function sample(t) {
  const root = await mkdtemp(join(tmpdir(), 'director-models-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'product.jpg'); await sharp({ create: { width: 128, height: 160, channels: 3, background: '#ffc900' } }).jpeg().toFile(path);
  return { directorModel: 'gemini', skill: 'signature', settings: { duration: 4, ratio: '9:16', resolution: '720p', language: 'zh', generateAudio: true },
    assets: [{ id: 'product', name: '产品', type: 'image', path }], history: [{ role: 'user', content: '保留黄色主体' }], message: '用新奇角度突出产品' };
}
const output = { kind: 'script', script: { title: '亮色开场', globalDirection: '保留产品外形，用特写到整体的揭示吸引观众。',
  shots: [{ start: 0, end: 4, visual: '产品特写拉到整体', referenceIds: ['product'], camera: '拉远', caption: '', voiceover: '' }] } };
const response = (finishReason = 'STOP', text = JSON.stringify(output)) => ({ candidates: [{ finishReason, content: { parts: [
  { thought: true, text: 'not part of the script' }, { text },
] } }], usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 100, thoughtsTokenCount: 300, cachedContentTokenCount: 20 } });

test('selected Gemini sends real images and creative direction with highest thinking, without changing shared vision config', async t => {
  const input = await sample(t); let sent;
  const result = await createDirectorModel({ config, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openlux.ai/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse');
    assert.equal(options.headers.Authorization, 'Bearer test-key'); sent = JSON.parse(options.body); return Response.json(response());
  } }).generate(input);
  assert.equal(result.kind, 'script'); assert.equal(result.usage.completion_tokens, 400);
  assert.deepEqual(sent.generationConfig.thinkingConfig, { thinkingLevel: 'high', includeThoughts: true });
  assert.equal(sent.generationConfig.maxOutputTokens, 65536); assert.equal(sent.generationConfig.temperature, 1);
  const metadata = JSON.parse(sent.contents[0].parts[0].text);
  assert.deepEqual(metadata.history, input.history); assert.equal(metadata.request, input.message);
  const photo = await sharp(Buffer.from(sent.contents[0].parts.find(p => p.inlineData).inlineData.data, 'base64')).metadata();
  assert.equal(photo.height, 160);
  assert.match(sent.systemInstruction.parts[0].text, /创意优先/); assert.match(sent.systemInstruction.parts[0].text, /购买欲/);
  assert.equal(config.imageTextModel, 'unrelated-vision-model');
});

test('Gemini streaming combines fragmented text, excludes thoughts and keeps final cumulative usage', async t => {
  const input = await sample(t), attempts = [];
  const text = JSON.stringify(output), split = Math.floor(text.length / 2);
  const wire = [
    { responseId: 'gemini-job', candidates: [{ content: { parts: [{ thought: true, text: 'private reasoning' }] } }] },
    { candidates: [{ content: { parts: [{ text: text.slice(0, split) }] } }], usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30 } },
    { ...response('STOP', text.slice(split)), responseId: 'gemini-job' },
  ].map(value => 'data: ' + JSON.stringify(value) + '\r\n\r\n').join('');
  const bytes = Buffer.from(wire);
  const result = await createDirectorModel({ config, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7)); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } }) }).generate(input, { onAttempt: entry => attempts.push(entry) });
  assert.equal(result.script.title, output.script.title);
  assert.equal(result.usage.completion_tokens, 400);
  assert.equal(attempts.at(-1).finishReason, 'stop');
  assert.equal(attempts.at(-1).parsedResponse.id, 'gemini-job');
  assert.doesNotMatch(JSON.stringify(result), /private reasoning|not part of the script/);
});

test('Gemini unfinished streams fail without replaying a paid generation', async t => {
  const input = await sample(t); let calls = 0;
  const model = createDirectorModel({ config, fetchImpl: async () => {
    calls++; return new Response('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  await assert.rejects(model.generate(input), { code: 'DIRECTOR_STREAM_INCOMPLETE' });
  assert.equal(calls, 1);
});

test('Gemini streaming safety blocks and upstream failures stay distinct and do not trigger another generation', async t => {
  const input = await sample(t);
  for (const [payload, code] of [[{ promptFeedback: { blockReason: 'SAFETY' } }, 'MODEL_REFUSED'],
    [{ error: { code: 503, message: 'unavailable' } }, 'DIRECTOR_PROVIDER_ERROR']]) {
    let calls = 0;
    const model = createDirectorModel({ config, fetchImpl: async () => { calls++; return new Response('data: ' + JSON.stringify(payload) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } }); } });
    await assert.rejects(model.generate(input), { code });
    assert.equal(calls, 1);
  }
});

test('Kimi switch uses the same image/history inputs and max reasoning on its own transport', async t => {
  const input = await sample(t); let sent;
  await createDirectorModel({ config, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openlux.ai/v1/chat/completions'); sent = JSON.parse(options.body);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
  } }).generate({ ...input, directorModel: 'kimi' });
  assert.equal(sent.model, 'kimi-k3.1-pro'); assert.equal(sent.reasoning_effort, 'max'); assert.equal(sent.temperature, 1);
  assert.equal(sent.messages[1].content.filter(p => p.type === 'image_url').length, 1);
  assert.deepEqual(JSON.parse(sent.messages[1].content[0].text).history, input.history);
});

test('Gemini truncation retries once, filtering thought parts and preserving correction metadata', async t => {
  const input = await sample(t), sent = [];
  const result = await createDirectorModel({ config, maxOutputTokens: 16384, fetchImpl: async (_url, options) => {
    sent.push(JSON.parse(options.body)); return Response.json(sent.length === 1 ? response('MAX_TOKENS', '{') : response());
  } }).generate(input);
  assert.equal(result.script.title, output.script.title);
  assert.deepEqual(sent.map(s => s.generationConfig.maxOutputTokens), [16384, 32768]);
  assert.match(sent[1].contents[0].parts.at(-1).text, /truncated/);
  assert.doesNotMatch(JSON.stringify(result), /not part of the script/);
});

test('blocked Gemini responses and invalid model choices never fall back to another paid model', async t => {
  const input = await sample(t); let calls = 0;
  const model = createDirectorModel({ config, fetchImpl: async () => { calls++; return Response.json({ promptFeedback: { blockReason: 'SAFETY' } }); } });
  await assert.rejects(model.generate(input), { code: 'MODEL_REFUSED' }); assert.equal(calls, 1);
  await assert.rejects(model.generate({ ...input, directorModel: 'direct' }), { code: 'DIRECTOR_MODEL_INVALID' }); assert.equal(calls, 1);
  assert.equal(geminiCompletion(response()).choices[0].message.content, JSON.stringify(output));
});

test('grounded Gemini receives original image pixels and evidence while retaining independent factual review',async t=>{
  const input={...await sample(t),groundingVersion:1};const sent=[];
  const candidate=structuredClone(output);candidate.script.shots[0].evidence=[{assetId:'product',factIndexes:[0],use:'detail'}];
  const model=createDirectorModel({config,fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);sent.push(body);
    if(url.includes(':streamGenerateContent'))return Response.json(response('STOP',JSON.stringify(candidate)));
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(sent.length===1
      ?{observations:[{id:'product',kinds:['detail'],facts:['黄色产品'],uncertain:[]}]}
      :{passed:true,issues:[]})}}]});
  }});
  const result=await model.generate(input);
  assert.equal(sent.length,3);assert.equal(result.quality.passed,true);
  assert.equal(sent[1].contents[0].parts.filter(p=>p.inlineData).length,1);
  assert.match(sent[1].contents[0].parts[1].text,/黄色产品/);
  assert.doesNotMatch(sent[1].systemInstruction.parts[0].text,/不附图片像素/);
});

test('Gemini narration repairs stay on the selected model with full thinking headroom',async t=>{
  const input={...await sample(t),planningVersion:2},candidate=structuredClone(output),sent=[];
  candidate.assets=[{id:'product',description:'黄色产品',role:'产品主体',adopt:'保留可见形态'}];
  candidate.script.plan={objective:'展示产品细节',audience:'对产品感兴趣的观众',perspective:'产品展示',storyArc:'从细节到整体',visualStyle:'自然明亮',cast:[],audio:{voiceDirection:'自然中文',music:'轻音乐',ambience:'轻声'},keep:['产品外形'],avoid:['虚构效果']};
  candidate.script.shots[0].intent='展示产品细节';
  candidate.script.shots[0].voiceover='这一段很长很长的旁白不可能在四秒钟内读完，我们要把店内每一个具体区域的细节都讲出来。';
  const result=await createDirectorModel({config,fetchImpl:async(url,options)=>{
    assert.match(url,/gemini-4-argon:streamGenerateContent\?alt=sse$/);sent.push(JSON.parse(options.body));
    return Response.json(response('STOP',JSON.stringify(sent.length===1?candidate:{voiceovers:['亮色登场，看看产品细节']})));
  }}).generate(input);
  assert.equal(sent.length,2);assert.equal(sent[1].generationConfig.maxOutputTokens,65536);
  assert.equal(sent[1].generationConfig.thinkingConfig.thinkingLevel,'high');
  assert.equal(result.narrationRepaired,true);assert.equal(result.script.shots[0].visual,output.script.shots[0].visual);
});
