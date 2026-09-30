import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import * as contract from '../src/lib/motion/contract.ts';
import * as crop from '../src/lib/motion/crop.ts';

let frame = 0;
function loadComponent(file) {
  const code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;
  const module = {exports: {}};
  const deps = {
    react: React,
    remotion: {AbsoluteFill: ({children}) => React.createElement('main', null, children), useCurrentFrame: () => frame, useVideoConfig: () => ({fps: 30})},
    '../lib/motion/contract': contract, '../lib/motion/crop': crop,
    './EffectRuntime': {}, '../components/SandboxEffect': {},
  };
  new Function('require', 'module', 'exports', code)(name => {
    if (name === './MotionCaptions') return loadComponent('../src/remotion/MotionCaptions.tsx');
    assert.ok(name in deps, `Unexpected dependency ${name}`);
    return deps[name];
  }, module, module.exports);
  return module.exports;
}
const {MotionComposition} = loadComponent('../src/remotion/MotionComposition.tsx');
function shown(captions, time) {
  frame = time * 30;
  const html = renderToStaticMarkup(React.createElement(MotionComposition, {title: '标题', subtitle: '副标题', fit: 'cover', sourceUrl: '', duration: 20, captions, scenes: []}));
  return html.match(/<span[^>]*>([^<]*)<\/span>/)?.[1] || '';
}
function pages(captions, start, end) {
  return [...new Set(Array.from({length: Math.round((end - start) * 30)}, (_, i) => shown(captions, start + i / 30)).filter(Boolean))];
}

test('the actual motion composition shows short punctuation-free phrases in speech order', () => {
  const captions = [{start: 1, end: 7, text: '大家好！今天我们一起学习，怎么把人工智能用到工作里。'}];
  const original = structuredClone(captions);
  const text = pages(captions, 1, 7);
  assert.ok(text.length >= 3);
  for (const phrase of text) {
    assert.doesNotMatch(phrase, /[\p{P}\p{S}]/u);
  }
  assert.equal(text.join(''), captions[0].text.replace(/[\p{P}\p{S}]/gu, ''));
  assert.deepEqual(captions, original, 'summary analysis retains the complete original sentences');
});

test('short captions retain cue boundaries and do not fill speech pauses', () => {
  const captions = [{start: 1, end: 3, text: '收入没有增加。'}, {start: 5, end: 7, text: '我们再试一次！'}];
  assert.equal(shown(captions, 0.9), '');
  assert.equal(shown(captions, 1), '收入没有增加');
  assert.equal(shown(captions, 3), '');
  assert.equal(shown(captions, 4), '');
  assert.equal(shown(captions, 5), '我们再试一次');
  assert.equal(shown(captions, 7), '');
});

test('SRT and manually edited captions use the same display rule and percentages retain their meaning', () => {
  const captions = contract.parseSrt('1\n00:00:00,000 --> 00:00:08,000\n20%的人，创造80%的业绩！增长3.5倍。');
  const text = pages(captions, 0, 8);
  assert.equal(text.join(''), '百分之20的人创造百分之80的业绩增长3点5倍');
  assert.ok(text.every(phrase => !/[\p{P}\p{S}]/u.test(phrase)));
  assert.equal(shown([{start: 0, end: 1, text: '……！？★'}], 0.5), '');
});

test('complete short clauses may exceed eight characters without losing compound terms', () => {
  const captions = [{start: 0, end: 6, text: '我们要提升工作效率，OpenAI人工智能应用。'}];
  assert.deepEqual(pages(captions, 0, 6), ['我们要提升工作效率', 'OpenAI人工智能应用']);
});

test('long words are never sliced and long unpunctuated speech still becomes short phrases', () => {
  const term = 'RetrievalAugmentedGeneration';
  const captions = [{start: 0, end: 12, text: `我们使用${term}技术帮助团队提高工作效率让每个人都能轻松完成任务`}];
  const text = pages(captions, 0, 12);
  assert.ok(text.some(phrase => phrase.includes(term)), text.join(' / '));
  assert.ok(text.length > 2, text.join(' / '));
  assert.equal(text.join(''), captions[0].text);
  assert.ok(text.every(phrase => [...phrase].length >= 4), 'avoid one or two character orphan pages');
});
