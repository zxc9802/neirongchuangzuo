import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createDirectorModel, validateDirectorResult } from '../services/video-creator/model.mjs';
import { skillDirection, verifyOfferFacts } from '../services/video-creator/skill-directions.mjs';

const settings = { duration: 30, ratio: '9:16', resolution: '480p', language: 'zh', generateAudio: true };
const config = { apiKey: 'test-private', baseUrl: 'https://director.example/v1', imageTextModel: 'claude-opus-5-5' };
const facts = { package: { value: '双人锡纸菜套餐', sourceQuote: '套餐是双人锡纸菜套餐，含锡纸热菜一份和烤串八串。' },
  price: { value: '128元', sourceQuote: '团购价128元。' }, validity: { value: '2026年10月31日', sourceQuote: '有效期至2026年10月31日。' },
  conditions: { value: '仅周一到周四使用，需提前一天预约，不含酒水', sourceQuote: '仅周一到周四使用，需提前一天预约，不含酒水。' } };
const message = Object.values(facts).map(f => f.sourceQuote).join('');
const baseInput = { settings, assets: [{ id: 'food', type: 'image' }, { id: 'space', type: 'image' }], history: [], message };
const output = () => ({ kind: 'script', script: { title: '到店体验', globalDirection: '写实暖色，保留店铺与产品。',
  shots: Array.from({ length: 9 }, (_, i) => ({ start: i * 30 / 9, end: (i + 1) * 30 / 9, visual: `具体看点${i + 1}`,
    camera: '稳定短移后切换', referenceIds: [i % 2 ? 'food' : 'space'], voiceover: '', caption: '' })) } });

test('three modules send distinct directing briefs while retaining full canonical timelines', async t => {
  const root = await mkdtemp(join(tmpdir(), 'director-skills-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'real.jpg'); await sharp({ create: { width: 120, height: 160, channels: 3, background: '#a68965' } }).jpeg().toFile(path);
  const briefs = new Map();
  for (const skill of ['store-discovery', 'store-visit', 'signature', 'group-buy']) {
    const input = { ...baseInput, skill, assets: baseInput.assets.map(a => ({ ...a, path, name: '实拍.jpg' })) };
    const payload = output(); if (skill === 'group-buy') payload.offerFacts = facts;
    let attempts = 0;
    const result = await createDirectorModel({ config, fetchImpl: async (_url, opts) => {
      attempts++; const request = JSON.parse(opts.body); briefs.set(skill, request.messages[0].content);
      assert.equal(request.model, 'claude-opus-5-5'); assert.equal(request.max_tokens, 16384);
      return Response.json({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] });
    } }).generate(input);
    assert.equal(attempts, 1); assert.equal(result.kind, 'script'); assert.equal(result.script.shots.length, 9);
    for (let i = 1; i <= 9; i++) assert.ok(result.script.videoPrompt.includes(`镜头${i}｜`));
    assert.ok(result.script.videoPrompt.includes('26.666666666666668–30秒'));
    assert.doesNotMatch(result.script.videoPrompt, /参考food|参考space/);
  }
  assert.equal(skillDirection('store-discovery'), '');
  assert.match(briefs.get('store-visit'), /一次到店体验如何发生/);
  assert.match(briefs.get('signature'), /门店环境只作体验背景/);
  assert.doesNotMatch(briefs.get('signature'), /门店或环境介绍要主动梳理|例如30秒素材充足的环境介绍/);
  assert.match(briefs.get('signature'), /让主推对象尽早进入画面/);
  assert.match(briefs.get('group-buy'), /offerFacts/);
  assert.match(briefs.get('group-buy'), /"warnings":\[\],"offerFacts":\{/);
  assert.match(briefs.get('group-buy'), /不将原价列为必填问题/);
  assert.doesNotMatch(briefs.get('store-discovery'), /当前模块为/);
});

test('group-buy cannot promote assistant guesses or fabricated evidence into confirmed offer facts', () => {
  const input = { ...baseInput, skill: 'group-buy', message: '帮我做团购宣传', history: [{ role: 'assistant', content: message }] };
  const value = { ...output(), offerFacts: facts };
  const result = validateDirectorResult(value, input);
  assert.equal(result.kind, 'clarification'); assert.equal(result.script, undefined);
  for (const field of ['套餐内容', '套餐价格', '有效期', '使用条件']) assert.ok(result.questions[0].includes(field));
  const fabricated = structuredClone(value); fabricated.offerFacts.price.value = '88元';
  const missing = validateDirectorResult(fabricated, { ...baseInput, skill: 'group-buy' });
  assert.equal(missing.kind, 'clarification'); assert.match(missing.questions[0], /套餐价格/);
  assert.doesNotMatch(missing.questions[0], /套餐内容|使用条件/);
});

test('group-buy accepts facts across user clarification turns and includes all restrictions in applied prompt', () => {
  const input = { ...baseInput, skill: 'group-buy', history: [
    { role: 'user', content: facts.package.sourceQuote + facts.price.sourceQuote },
    { role: 'assistant', content: '请补充有效期和使用条件。' },
  ], message: facts.validity.sourceQuote + facts.conditions.sourceQuote };
  assert.deepEqual(verifyOfferFacts(facts, input).missing, []);
  const result = validateDirectorResult({ ...output(), offerFacts: facts }, input);
  assert.equal(result.kind, 'script'); assert.deepEqual(result.offerFacts, facts);
  for (const fact of Object.values(facts)) assert.ok(result.script.videoPrompt.includes(fact.value));
  const partial = structuredClone(facts); delete partial.conditions;
  assert.deepEqual(verifyOfferFacts(partial, input).missing, ['使用条件']);
});

test('missing offer facts yield a clarification without format retries or a paid video prompt', async () => {
  let calls = 0;
  const input = { ...baseInput, assets: [], skill: 'group-buy', message: '做个团购视频' };
  const result = await createDirectorModel({ config, fetchImpl: async () => {
    calls++; return Response.json({ choices: [{ message: { content: JSON.stringify(output()) }, finish_reason: 'stop' }] });
  } }).generate(input);
  assert.equal(calls, 1); assert.equal(result.kind, 'clarification'); assert.equal(result.script, undefined);
});
