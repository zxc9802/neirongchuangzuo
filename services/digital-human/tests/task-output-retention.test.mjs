import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import {NextRequest, NextResponse} from 'next/server.js';
import * as retention from '../src/lib/task-output-retention.ts';
import * as publicData from '../src/lib/server/public-data.ts';

function fixture(overrides = {}) {
  const completedAt = Date.now() - 1000;
  return {
    id: 'task_retention_1', userId: 'owner', createdAt: completedAt - 1000,
    completedAt, updatedAt: completedAt, status: 'completed', step: 'done', progress: 100, logs: [],
    inputs: {videoPath: '', videoUrl: '', videoName: '口播', scriptText: '欢迎', toneProfile: 'low', videoFit: 'smart', emotionIntensity: 1},
    results: {finalVideoUrl: '/jobs/task_retention_1/final.mp4'}, ...overrides,
  };
}

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-retention-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('task-retention-test-'));
    fs.rmSync(dir, {recursive: true, force: true});
  });
  return dir;
}

function load(file, deps, cwd = process.cwd()) {
  const code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText;
  const module = {exports: {}};
  new Function('require', 'module', 'exports', 'process', 'setInterval', code)(
    name => {assert.ok(name in deps, name); return deps[name];}, module, module.exports,
    {cwd: () => cwd}, () => ({unref() {}}),
  );
  return module.exports;
}

test('outputs expire exactly 72 hours after completion, even when logs change later', () => {
  const task = fixture({completedAt: 1000, updatedAt: 9999999});
  const deadline = 1000 + retention.TASK_OUTPUT_RETENTION_MS;
  assert.equal(retention.isTaskOutputExpired(task, deadline - 1), false);
  assert.equal(retention.isTaskOutputExpired(task, deadline), true);
  assert.equal(retention.taskOutputExpiresAt(task), deadline);
  assert.equal(retention.taskOutputExpiresAt(fixture({completedAt: undefined, updatedAt: 2000})), 2000 + retention.TASK_OUTPUT_RETENTION_MS);
  assert.equal(retention.isTaskOutputExpired(fixture({status: 'processing', completedAt: undefined, updatedAt: 0}), deadline), false);
});

test('cleanup removes only generated outputs and preserves original, uploaded, protected, and foreign files', t => {
  const cwd = temp(t);
  const task = fixture({completedAt: 1});
  const write = relative => {const file = path.join(cwd, relative); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, 'fixture'); return file;};
  const final = write('.runtime/jobs/task_retention_1/final.mp4');
  const chunk = write('.runtime/jobs/task_retention_1/lipsync-chunks/result-0.mp4');
  const original = write('.runtime/jobs/task_retention_1/source-video.mp4');
  const input = write('.runtime/jobs/task_retention_1/input-video.mp4');
  const protectedAudio = write('.runtime/jobs/task_retention_1/voice-track.wav');
  const uploaded = write('.runtime/uploads/users/owner/videos/final.mp4');
  const foreign = write('.runtime/jobs/other_task/final.mp4');
  const unrecognized = write('.runtime/jobs/task_retention_1/notes.txt');
  retention.purgeLocalTaskOutputs(task, {cwd, protectedSources: [protectedAudio]});
  for (const file of [final, chunk]) assert.equal(fs.existsSync(file), false, file);
  for (const file of [original, input, protectedAudio, uploaded, foreign, unrecognized]) assert.equal(fs.existsSync(file), true, file);
  retention.purgeLocalTaskOutputs(task, {cwd, protectedSources: [protectedAudio]}); // idempotent
  assert.equal(fs.existsSync(protectedAudio), true);
  assert.deepEqual(retention.generatedTaskObjectKeys({...task, id: '../other'}, []), []);
  const keys = retention.generatedTaskObjectKeys(task, ['uploads/users/owner/videos/final.mp4', 'jobs/other/final.mp4', 'jobs/task_retention_1/source-video.mp4', 'jobs/task_retention_1/lipsync-chunks/result-1.mp4']);
  assert.ok(keys.includes('jobs/task_retention_1/lipsync-chunks/result-1.mp4'));
  assert.ok(keys.every(key => key.startsWith('jobs/task_retention_1/') && !key.endsWith('source-video.mp4')));
  assert.ok(retention.generatedTaskObjectKeys({...task, results: {lipsyncChunks: [{index: 3, status: 'downloaded'}]}}, [])
    .includes('jobs/task_retention_1/lipsync-chunks/result-3.mp4'), 'persisted segment identities require no bucket listing');
});

test('cleanup never follows a task-directory junction into another directory', t => {
  const cwd = temp(t);
  const outside = path.join(cwd, 'shared-originals'); fs.mkdirSync(outside);
  const original = path.join(outside, 'final.mp4'); fs.writeFileSync(original, 'original');
  const jobs = path.join(cwd, '.runtime/jobs'); fs.mkdirSync(jobs, {recursive: true});
  fs.symlinkSync(outside, path.join(jobs, 'task_retention_1'), process.platform === 'win32' ? 'junction' : 'dir');
  retention.purgeLocalTaskOutputs(fixture({completedAt: 1}), {cwd});
  assert.equal(fs.readFileSync(original, 'utf8'), 'original');
});

test('task store freezes completion and retains the task record after output cleanup', async t => {
  const cwd = temp(t);
  const {TaskStore} = load('../src/lib/store/task-store.ts', {
    fs, path, '../server/safe-log': {logServerError() {}},
    '../cos': {CosService: {isConfigured: () => false, getManagedObjectKey: () => null}},
    '../task-output-retention': {...retention, purgeLocalTaskOutputs: (task, opts) => retention.purgeLocalTaskOutputs(task, {...opts, cwd})},
  }, cwd);
  const initial = fixture({status: 'processing', completedAt: undefined});
  const task = TaskStore.create(initial);
  TaskStore.update(task.id, {status: 'completed'});
  const first = (await TaskStore.getAsync(task.id)).completedAt;
  TaskStore.addLog(task.id, 'later status');
  TaskStore.update(task.id, {completedAt: first + retention.TASK_OUTPUT_RETENTION_MS, progress: 100});
  assert.equal((await TaskStore.getAsync(task.id)).completedAt, first);
  const old = fixture({id: 'task_expired', completedAt: 1});
  const storePath = path.join(cwd, '.runtime/state/tasks.json');
  fs.writeFileSync(storePath, JSON.stringify([old]));
  const retained = await TaskStore.getAsync(old.id);
  assert.equal(retained.id, old.id);
  assert.equal(retained.completedAt, 1);
  assert.ok(retained.outputsPurgedAt);
});

test('public tasks publish expiry and protected downloads, and never expose expired or unsettled outputs', () => {
  const task = fixture();
  const available = publicData.toPublicTask(task);
  assert.equal(available.expiresAt, task.completedAt + retention.TASK_OUTPUT_RETENTION_MS);
  assert.equal(available.results.downloadUrl, '/api/tasks/task_retention_1/download/final.mp4');
  const expired = publicData.toPublicTask(fixture({completedAt: Date.now() - retention.TASK_OUTPUT_RETENTION_MS}));
  assert.equal(expired.outputExpired, true);
  assert.equal(expired.results.finalVideoUrl, undefined);
  assert.equal(expired.results.downloadUrl, undefined);
  assert.equal(expired.recoverable, false);
  assert.equal(publicData.toPublicTask(fixture({billing: {isExternalUser: true, status: 'settle_pending'}})).results.downloadUrl, undefined);
});

test('completed asset listing preserves owner isolation, excludes unfinished and expired outputs, and blocks unauthenticated access', async () => {
  let access = {isolated: true, userId: 'owner', isAdmin: false};
  const tasks = [fixture(), fixture({id: 'foreign', userId: 'other'}), fixture({id: 'expired', completedAt: 1}), fixture({id: 'pending', completedAt: undefined, status: 'processing'})];
  const deps = {
    'next/server': {NextRequest, NextResponse}, '@/lib/server/safe-log': {},
    '@/lib/store/task-store': {TaskStore: {getAllAsync: async () => tasks}}, '@/lib/engine/pipeline': {},
    '@/lib/store/avatar-store': {}, '@/lib/store/voice-store': {}, '@/lib/server/public-data': publicData,
    '@/lib/main-app-billing': {}, '@/lib/billing-estimate': {}, '@/lib/server/generation-limit': {},
    '@/lib/server/upload-policy': {}, '@/lib/server/media-response': {},
    '@/lib/server/task-worker': {}, '@/lib/server/workspace-task-recovery': {reconcileWorkspaceTask: async task => task},
    '@/lib/access-control': {resolveAccessContext: async () => access, unauthorizedResponse: () => new Response(null, {status: 401})},
  };
  const {GET} = load('../src/app/api/tasks/route.ts', deps);
  const request = new NextRequest('http://localhost/api/tasks?completed=true');
  assert.deepEqual((await (await GET(request)).json()).tasks.map(task => task.id), ['task_retention_1']);
  access = {...access, isAdmin: true};
  assert.deepEqual((await (await GET(request)).json()).tasks.map(task => task.id), ['task_retention_1', 'foreign']);
  access = {isolated: true};
  assert.equal((await GET(request)).status, 401);
});

test('media and download routes reject expired or foreign outputs before opening any file', async () => {
  let task = fixture();
  let access = {isolated: true, userId: 'owner'};
  let served = 0;
  const deps = {
    'next/server': {NextRequest, NextResponse},
    '@/lib/store/task-store': {TaskStore: {getAsync: async () => task}},
    '@/lib/server/public-data': publicData,
    '@/lib/task-output-retention': retention,
    '@/lib/server/media-response': {isTrustedTaskOutputSource: () => true, servePrivateMedia: () => {served++; return new Response('video');}},
    '@/lib/server/upload-policy': {}, '@/lib/store/avatar-store': {},
    '@/lib/access-control': {
      resolveAccessContext: async () => access, canAccessTask: (context, item) => context.userId === item.userId,
      unauthorizedResponse: () => new Response(null, {status: 401}), taskNotFoundResponse: () => new Response(null, {status: 404}),
    },
  };
  for (const [file, param] of [
    ['../src/app/api/tasks/[id]/media/[kind]/route.ts', {kind: 'final'}],
    ['../src/app/api/tasks/[id]/download/[file]/route.ts', {file: 'final.mp4'}],
  ]) {
    const {GET} = load(file, deps);
    const request = () => GET(new NextRequest('http://localhost/api/tasks/example'), {params: Promise.resolve({id: task.id, ...param})});
    task = fixture(); access = {isolated: true, userId: 'owner'};
    assert.equal((await request()).status, 200);
    const before = served;
    task = fixture({completedAt: Date.now() - retention.TASK_OUTPUT_RETENTION_MS});
    assert.equal((await request()).status, 404);
    task = fixture({userId: 'other'});
    assert.equal((await request()).status, 404);
    access = {isolated: true};
    assert.equal((await request()).status, 401);
    assert.equal(served, before);
  }
});
