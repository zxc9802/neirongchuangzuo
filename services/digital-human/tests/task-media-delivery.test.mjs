import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import ts from 'typescript';
import * as media from '../src/lib/server/media-response.ts';
import * as access from '../src/lib/access-control.ts';
import * as publicData from '../src/lib/server/public-data.ts';
import * as retention from '../src/lib/task-output-retention.ts';
process.env.NODE_ENV = 'development';
process.env.DISABLE_SSO = 'true';
delete process.env.AUTH_MODE;
const TaskStore = {getAsync: async () => undefined};
const { CosService } = await import('../src/lib/cos.ts');
function load(relative) {
  const code = ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const deps = {'next/server': {NextRequest,NextResponse}, '@/lib/store/task-store': {TaskStore}, '@/lib/server/media-response': media,
    '@/lib/server/public-data': publicData, '@/lib/access-control': access,
    '@/lib/task-output-retention': retention, '@/lib/server/upload-policy': {}, '@/lib/store/avatar-store': {}};
  const module = {exports: {}};
  new Function('require','module','exports',code)(name => {assert.ok(name in deps,name);return deps[name];}, module, module.exports);
  return module.exports.GET;
}
const preview = load('../src/app/api/tasks/[id]/media/[kind]/route.ts');
const download = load('../src/app/api/tasks/[id]/download/[file]/route.ts');
const { TASK_OUTPUT_RETENTION_MS } = await import('../src/lib/task-output-retention.ts');
const id = 'task_delivery';
const origin = 'https://storage.example.test';
function setup(t, overrides = {}) {
  const task = { id, status: 'completed', completedAt: Date.now(), updatedAt: Date.now(),
    inputs: {}, results: { finalVideoUrl: `${origin}/jobs/${id}/final.mp4`,
      previewVideoUrl: `${origin}/jobs/${id}/preview.mp4` }, ...overrides };
  t.mock.method(TaskStore, 'getAsync', async () => task);
  t.mock.method(CosService, 'getManagedObjectKey', value => value?.startsWith(origin + '/jobs/') ? new URL(value).pathname.slice(1) : null);
  const signed = [];
  t.mock.method(CosService, 'getDownloadUrl', async (...args) => { signed.push(args); return `${origin}/${args[0]}?signed=temporary`; });
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches++; return new Response('large original bytes'); });
  return { task, signed, fetches: () => fetches };
}
const request = (handler, headers = {}, file = 'final.mp4') => handler(new NextRequest(`http://localhost/api/tasks/${id}/media/final`, {headers}),
  {params: Promise.resolve({id, kind: 'final', file})});

test('preview uses a smaller rendition without proxying bytes through the app', async t => {
  const ctx = setup(t);
  const res = await request(preview, {Range: 'bytes=0-1023'});
  assert.equal(res.status, 307);
  assert.match(res.headers.get('location'), /preview\.mp4/);
  assert.equal(ctx.fetches(), 0);
  assert.equal(ctx.signed[0][3].inline, true);
  assert.ok(ctx.signed[0][2] <= 3600);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
});

test('download retains the original file and attachment filename', async t => {
  const ctx = setup(t);
  const res = await request(download);
  assert.equal(res.status, 307);
  assert.match(res.headers.get('location'), /final\.mp4/);
  assert.equal(ctx.fetches(), 0);
  assert.equal(ctx.signed[0][1], 'digital-human-video.mp4');
  assert.equal(ctx.signed[0][3].inline, false);
});

test('legacy tasks and invalid preview paths use the original video', async t => {
  const ctx = setup(t);
  for (const value of [undefined, 'https://evil.test/preview.mp4', `${origin}/jobs/other/preview.mp4`]) {
    ctx.task.results.previewVideoUrl = value;
    const res = await request(preview);
    assert.equal(res.status, 307);
    assert.match(res.headers.get('location'), /task_delivery\/final\.mp4/);
  }
});

test('no signed output is exposed before completion, settlement, or after expiry', async t => {
  const ctx = setup(t);
  for (const overrides of [{status:'processing'}, {status:'completed', billing:{isExternalUser:true,status:'reserved'}},
    {billing:undefined,completedAt:Date.now()-TASK_OUTPUT_RETENTION_MS-1000}]) {
    Object.assign(ctx.task, overrides);
    assert.equal((await request(preview)).status, 404);
    assert.equal((await request(download)).status, 404);
  }
  assert.equal(ctx.signed.length, 0);
});

test('authorization precedes redirects and signatures cannot outlive retention', async t => {
  const ctx = setup(t, {completedAt: Date.now()-TASK_OUTPUT_RETENTION_MS+30_000});
  assert.equal((await request(preview)).status, 307);
  assert.ok(ctx.signed[0][2] <= 30);
  process.env.NODE_ENV = 'production';
  try { assert.equal((await request(preview)).status, 401); }
  finally { process.env.NODE_ENV = 'development'; }
  assert.equal(ctx.signed.length, 1);
});

test('small-file download uses the preview and falls back to the original for legacy tasks', async t => {
  const ctx = setup(t);
  assert.match((await request(download, {}, 'preview.mp4')).headers.get('location'), /preview\.mp4/);
  assert.equal(ctx.signed[0][1], 'digital-human-video-small.mp4');
  ctx.task.results.previewVideoUrl = undefined;
  assert.match((await request(download, {}, 'preview.mp4')).headers.get('location'), /final\.mp4/);
  ctx.task.status = 'processing';
  assert.equal((await request(download, {}, 'preview.mp4')).status, 404);
});
