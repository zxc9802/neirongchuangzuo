import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {interpolate} from 'remotion';
import {classifyTemplate, prepareSemanticScenes} from '../src/lib/motion-library/semantics.ts';
import {validateSemanticPolicy, validateVisualPlan} from '../src/lib/motion-library/visual.ts';
import {validateMotionEdit} from '../src/lib/motion/contract.ts';
import {publicEffect} from '../src/lib/motion-library/store.ts';
import {publicBuiltinEffect} from '../src/lib/motion-library/builtins.ts';
import {publicMotion} from '../src/lib/motion/store.ts';
import {compileEffect, requireSemanticDiagram} from '../scripts/motion-library/compile.mjs';

const effect = {id: 'effect_11111111-1111-4111-8111-111111111111', revision: 1};
const scenes = [{start: 0, end: 6, headline: '经验变成团队能力', line1: '沉淀销冠经验', line2: '让新人也能复用', highlight: '复用'}];
const captions = [{start: 0, end: 6, text: '把销冠经验沉淀成知识库，让新人也能复用。'}];
const policy = {required: true, reason: '需要分析概念之间的关系', layouts: ['flow', 'compare', 'list']};
const plan = {layout: 'flow', nodes: [{label: '销冠经验', icon: 'person', emphasis: false}, {label: '知识库', icon: 'book', emphasis: false}, {label: '新人复用', icon: 'team', emphasis: true}]};
const input = {effect, scenes, captions, policy};
const answer = async () => ({scenes: [{index: 0, ...plan}]});

test('creation asks the model to classify the latest requirement and normalizes its decision', async () => {
  const seen = [];
  const requirement = {messages: [{role: 'user', content: '改为纯文字依次入场，去掉图解'}], currentCode: 'old graph code', assets: []};
  const decision = await classifyTemplate(requirement, async (system, data) => {seen.push({system, data}); return {required: false, reason: '只需文字動效', layouts: []};});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data.latestRequest, requirement.messages[0].content);
  assert.equal(seen[0].data.previousTemplateCodeForReferenceOnly, requirement.currentCode);
  assert.equal(decision.required, false);
  assert.equal(decision.reason, '只需文字动效');
  assert.deepEqual(validateSemanticPolicy({required: true, reason: '关系', layouts: ['flow']}).layouts, ['flow', 'list']);
  for (const bad of [null, {required: 'false', reason: 'x', layouts: []}, {required: true, reason: 'x', layouts: []}, {required: true, reason: 'x', layouts: ['arbitrary']}]) assert.throws(() => validateSemanticPolicy(bad));
});

test('text templates and older versions skip semantic model calls even with a previous graph', async () => {
  let calls = 0;
  const ask = async () => {calls++; throw new Error('Must not call the model');};
  for (const policy of [undefined, {required: false, reason: '文字', layouts: []}]) {
    const result = await prepareSemanticScenes({...input, policy, scenes: [{...scenes[0], visual: plan}]}, ask);
    assert.equal(result.scenes[0].visual, undefined);
    assert.equal(result.cache, undefined);
  }
  assert.equal(calls, 0);
});

test('the built-in diagram analyzes content while the text template and legacy diagram skip it', async () => {
  let calls=0;
  const ask=async()=>{calls++;return answer();};
  for(const [id,revision] of [['builtin_green_text',1],['builtin_green_diagram',1]]){
    const builtin=publicBuiltinEffect(id,true,revision);
    const result=await prepareSemanticScenes({...input,effect:{id,revision},policy:builtin.semantics},ask);
    assert.equal(result.scenes[0].visual,undefined);
  }
  assert.equal(calls,0);
  const builtin=publicBuiltinEffect('builtin_green_diagram',true);
  const request={...input,effect:{id:builtin.id,revision:builtin.revision},policy:builtin.semantics};
  const first=await prepareSemanticScenes(request,ask);
  assert.equal(calls,1);assert.deepEqual(first.scenes[0].visual,plan);
  await prepareSemanticScenes({...request,cache:first.cache},ask);assert.equal(calls,1);
  requireSemanticDiagram(fs.readFileSync(new URL('../src/remotion/templates/GreenSemanticDiagram.tsx',import.meta.url),'utf8'));
});

test('semantic templates use validated plans and reuse them across preview, save and export', async () => {
  let calls = 0;
  const ask = async () => {calls++; return answer();};
  const first = await prepareSemanticScenes(input, ask);
  assert.equal(calls, 1);
  assert.deepEqual(first.scenes[0].visual, plan);
  assert.equal(first.scenes[0].line1, scenes[0].line1);
  const again = await prepareSemanticScenes({...input, scenes: first.scenes, cache: first.cache, title: '只改标题', crop: {zoom: 2}}, ask);
  assert.equal(calls, 1);
  assert.deepEqual(again, first);
  for (const change of [{effect: {...effect, revision: 2}}, {scenes: [{...scenes[0], line1: '提取销冠经验'}]}, {captions: [{...captions[0], text: '不同的原话'}]}]) {
    await prepareSemanticScenes({...input, ...change, cache: first.cache}, ask);
  }
  assert.equal(calls, 4);
});

test('semantic analysis rejects missing scenes, foreign layouts, invented numbers and invalid graph data', async () => {
  for (const scenes of [[], [{index: 1, ...plan}], [{index: 0, ...plan, layout: 'merge'}], [{index: 0, ...plan, nodes: [{label: '增长500%', icon: 'chart', emphasis: true}]}]]) {
    await assert.rejects(prepareSemanticScenes(input, async () => ({scenes})));
  }
  for (const bad of [{layout: 'flow', nodes: []}, {...plan, layout: 'script'}, {...plan, nodes: [{label: '用户', icon: 'https://example.com', emphasis: false}]}, {...plan, nodes: Array(5).fill(plan.nodes[0])}]) assert.throws(() => validateVisualPlan(bad));
  await assert.rejects(prepareSemanticScenes(input, async () => {throw new Error('upstream failure');}), /upstream failure/);
  assert.equal(input.scenes[0].visual, undefined);
});

test('semantic analysis batches all scenes without changing their time or text and simplifies labels', async () => {
  let calls = 0;
  const many = Array.from({length: 11}, (_, i) => ({...scenes[0], start: i * 6, end: (i + 1) * 6}));
  const result = await prepareSemanticScenes({...input, scenes: many}, async (_system, batch) => {
    calls++;
    return {scenes: batch.map(row => ({index: row.index, layout: 'list', nodes: [{label: '團隊知識庫', icon: 'book', emphasis: true}]}))};
  });
  assert.equal(calls, 2);
  assert.equal(result.scenes.length, 11);
  assert.equal(result.scenes[10].end, 66);
  assert.equal(result.scenes[10].visual.nodes[0].label, '团队知识库');
});

test('an invalid plan gets one bounded correction and cannot pollute the saved cache', async () => {
  const prompts = [];
  const result = await prepareSemanticScenes(input, async system => {
    prompts.push(system);
    return prompts.length === 1 ? {scenes: [{index: 0, ...plan, nodes: [{label: '增长500%', icon: 'chart', emphasis: true}]}]} : answer();
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /原话没有的数字/);
  assert.deepEqual(result.cache.plans, [plan]);
  let failures = 0;
  await assert.rejects(prepareSemanticScenes(input, async () => {failures++; return {scenes: []};}));
  assert.equal(failures, 2);
});

test('incomplete model JSON gets one correction but network failures are not retried as formatting errors',async()=>{
  let calls=0;
  const result=await prepareSemanticScenes(input,async system=>{
    if(++calls===1)throw new SyntaxError('Unexpected end of JSON input');
    assert.match(system,/JSON 不完整/);return answer();
  });
  assert.equal(calls,2);assert.deepEqual(result.scenes[0].visual,plan);
  let failures=0;
  await assert.rejects(prepareSemanticScenes(input,async()=>{failures++;throw new Error('network failed');}),/network failed/);
  assert.equal(failures,1);
});

test('saved versions expose their own decision while project analysis caches stay private', async () => {
  const result = await prepareSemanticScenes(input, answer);
  const edit = validateMotionEdit({title: '标题', subtitle: '副标题', fit: 'cover', captions, scenes: result.scenes, effect}, 6, true);
  assert.deepEqual(edit.scenes[0].visual, plan);
  const publicProject = publicMotion({...edit, id: 'motion_test', source: '/private', semanticCache: result.cache});
  assert.equal(publicProject.semanticCache, undefined);
  assert.deepEqual(publicProject.scenes[0].visual, plan);
  const row = {id: effect.id, name: '模板', status: 'ready', revision: 2, saved: true, assets: [], messages: [], versions: [{revision: 1, assets: [], semantics: policy}, {revision: 2, assets: [], semantics: {required: false, reason: '文字', layouts: []}}]};
  assert.equal(publicEffect(row, true, 1).template.semantics.required, true);
  assert.equal(publicEffect(row, true, 2).semantics.required, false);
});

test('generated semantic code must pass real scene data to the built-in diagram renderer', () => {
  const source = "import React from 'react';import {Diagram} from '@motion';export default function Effect({scene}){return <Diagram plan={scene.visual} color='#ffffff'/>;}";
  assert.match(compileEffect(source), /Diagram/);
  requireSemanticDiagram(source);
  assert.throws(()=>requireSemanticDiagram(source,false), /无需语义分析/);
  requireSemanticDiagram("export default function Effect({scene}){return <div>{scene.headline}</div>}",false);
  for (const bad of [source.replace('plan={scene.visual}', ''), source.replace('plan={scene.visual}', 'plan={{layout:"list",nodes:[]}}'), 'export default function Effect(){return <div>硬编码图解</div>}']) assert.throws(() => requireSemanticDiagram(bad));
});

test('diagram renderer changes its actual labels, icons and connectors with the semantic plan', () => {
  const code = ts.transpileModule(fs.readFileSync(new URL('../src/remotion/SemanticDiagram.tsx', import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true}}).outputText;
  const module = {exports: {}};
  new Function('require', 'module', 'exports', code)(name => name === 'react' ? React : {interpolate}, module, module.exports);
  const render = plan => renderToStaticMarkup(React.createElement(module.exports.SemanticDiagram, {plan, frame: 150, fps: 30, durationInFrames: 180}));
  const graph = render(plan);
  assert.match(graph, /销冠经验/);
  assert.match(graph, /知识库/);
  assert.match(graph, /新人复用/);
  const comparison = render({layout: 'compare', nodes: [{label: '20%的人', icon: 'person', emphasis: false}, {label: '80%的业绩', icon: 'chart', emphasis: true}]});
  assert.match(comparison, /80%的业绩/);
  assert.doesNotMatch(comparison, /销冠经验/);
  assert.ok((graph.match(/<path/g) || []).length > (comparison.match(/<path/g) || []).length);
});
