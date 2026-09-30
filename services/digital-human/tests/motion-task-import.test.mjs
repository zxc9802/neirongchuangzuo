import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import ts from 'typescript';
import {NextRequest, NextResponse} from 'next/server';

const cwd = process.cwd(), tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'motion-task-import-')));
const keys = ['MAIN_APP_SSO_CLIENT_SECRET', 'APP_SESSION_SECRET', 'COS_SECRET_ID', 'COS_SECRET_KEY', 'DISABLE_SSO'];
const env = Object.fromEntries(keys.map(key => [key, process.env[key]])), originalFetch = globalThis.fetch;
process.chdir(tmp);
Object.assign(process.env, {MAIN_APP_SSO_CLIENT_SECRET: 'test-sso', APP_SESSION_SECRET: 'test-session'});
for (const key of ['COS_SECRET_ID', 'COS_SECRET_KEY', 'DISABLE_SSO']) delete process.env[key];
globalThis.fetch = async (_url, init) => {
  const id = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '');
  return Response.json({success: true, data: {user: {id, account: id, nickname: id, role: id === 'admin' ? 'admin' : 'member'}}});
};
const sso = await import('../src/lib/main-app-sso.ts');
const policy = await import('../src/lib/server/upload-policy.ts');
function load(file, deps) {
  const code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;
  const module = {exports: {}};
  new Function('require', 'module', 'exports', code)(name => {assert.ok(name in deps, `Missing dependency ${name}`); return deps[name];}, module, module.exports);
  return module.exports;
}
const cos = await import('../src/lib/cos.ts'), log = await import('../src/lib/server/safe-log.ts');
const {TaskStore} = load('../src/lib/store/task-store.ts', {fs, path, '../cos': cos, '../server/safe-log': log,
  '../task-output-retention': await import('../src/lib/task-output-retention.ts')});
const route = load('../src/app/api/motion/from-task/[id]/route.ts', {
  'node:crypto': crypto, 'node:fs': fs, 'next/server': {NextRequest, NextResponse},
  '@/lib/access-control': await import('../src/lib/access-control.ts'),
  '@/lib/store/task-store': {TaskStore}, '@/lib/server/public-data': await import('../src/lib/server/public-data.ts'),
  '@/lib/server/media-response': await import('../src/lib/server/media-response.ts'),
  '@/lib/media-path-policy': await import('../src/lib/media-path-policy.ts'),
  '@/lib/cos': cos, '@/lib/server/safe-log': log, '@/lib/server/upload-policy': policy,
  '@/lib/motion/contract': await import('../src/lib/motion/contract.ts'),
});
const bytes = Buffer.from('test completed video bytes');
function fixture(changes = {}) {
  const task = TaskStore.create({userId: 'alice', status: 'completed', step: 'done', progress: 100, inputs: {videoName: '口播测试.mp4', videoPath: '', videoUrl: '', scriptText: '测试', toneProfile: 'low', videoFit: 'smart', emotionIntensity: .8}, results: {}, ...changes});
  const final = path.join(tmp, '.runtime', 'jobs', task.id, 'final.mp4');
  fs.mkdirSync(path.dirname(final), {recursive: true}); fs.writeFileSync(final, bytes);
  return TaskStore.update(task.id, {results: {finalVideoUrl: final, videoDuration: 12, ...changes.results}});
}
async function request(method, task, user = 'alice') {
  const headers = {};
  if (user) {
    const cookie = await sso.createMainAppSessionCookie({token: user, user: {id: user, account: user, nickname: user, role: user === 'admin' ? 'admin' : 'member'}, expiresAt: Date.now() + 60000, validatedAt: Date.now()});
    headers.Cookie = `${sso.getMainAppSessionCookieName()}=${cookie}`;
  }
  return route[method](new NextRequest(`http://localhost/api/motion/from-task/${task.id}`, {method, headers}), {params: Promise.resolve({id: task.id})});
}
test.after(() => {
  globalThis.fetch = originalFetch; process.chdir(cwd); fs.rmSync(tmp, {recursive: true, force: true});
  for (const key of keys) {if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];}
});

test('loading a completed task prefills private video metadata without copying or creating a motion job', async () => {
  const task = fixture();
  const response = await request('GET', task), data = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(data.video, {taskId: task.id, name: '口播测试-成片.mp4', duration: 12, sourceUrl: `/api/tasks/${task.id}/media/final`});
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.doesNotMatch(JSON.stringify(data), /alice|\.runtime|finalVideoUrl/);
  assert.equal(fs.existsSync(path.join(tmp, '.runtime', 'uploads')), false);
  assert.equal(fs.existsSync(path.join(tmp, '.runtime', 'state', 'motion-projects.json')), false);
});

test('server transfer copies the final video intact into a normal owner-only upload grant', async () => {
  const task = fixture();
  const response = await request('POST', task), data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  const imported = await policy.resolveOwnedUpload({key: data.uploadKey, userId: 'alice', folder: 'videos'});
  assert.ok(imported);
  assert.deepEqual(fs.readFileSync(imported.source), bytes);
  assert.deepEqual(fs.readFileSync(task.results.finalVideoUrl), bytes, 'the original delivery is retained');
  assert.equal(policy.isOwnedUploadSource({source: imported.source, userId: 'alice', folder: 'videos'}), true);
  assert.equal(await policy.resolveOwnedUpload({key: data.uploadKey, userId: 'bob', folder: 'videos'}), null);
  assert.equal(policy.claimPendingUpload({key: data.uploadKey, userId: 'bob'}), false);
  assert.equal(policy.claimPendingUpload({key: data.uploadKey, userId: 'alice'}), true);
  assert.equal(policy.claimPendingUpload({key: data.uploadKey, userId: 'alice'}), false);
});

test('import enforces authentication and personal ownership including administrator accounts', async () => {
  const task = fixture();
  for (const method of ['GET', 'POST']) {
    assert.equal((await request(method, task, null)).status, 401);
    for (const user of ['bob', 'admin']) assert.equal((await request(method, task, user)).status, 404);
  }
});

test('unfinished, unsettled, missing, oversized-duration and untrusted task outputs cannot be imported', async () => {
  const cases = [
    [fixture({status: 'processing'}), 409],
    [fixture({billing: {isExternalUser: true, status: 'settle_pending'}}), 409],
    [fixture({results: {videoDuration: 601}}), 400],
    [fixture({results: {finalVideoUrl: 'https://untrusted.invalid/video.mp4'}}), 404],
    [{id: 'missing'}, 404],
  ];
  const alice = fixture(), other = fixture({userId: 'bob'});
  TaskStore.update(alice.id, {results: {...alice.results, finalVideoUrl: other.results.finalVideoUrl}});
  cases.push([alice, 404]);
  for (const [task, status] of cases) for (const method of ['GET', 'POST']) assert.equal((await request(method, task)).status, status);
});

test('cloud deliveries transfer through trusted storage and a failed copy removes only its new upload', async () => {
  const task = fixture(), sourceKey = `jobs/${task.id}/final.mp4`;
  TaskStore.update(task.id, {results: {finalVideoUrl: `https://storage.test/${sourceKey}`, videoDuration: 12}});
  const savedCos = {...cos.CosService}, savedFetch = globalThis.fetch;
  const uploads = [], deleted = [];
  let failUpload = false;
  Object.assign(cos.CosService, {
    isConfigured: () => true,
    getManagedObjectKey: value => value?.startsWith('https://storage.test/') ? value.slice('https://storage.test/'.length) : null,
    getObjectSize: async () => bytes.length,
    getDownloadUrl: async key => `https://storage.test/${key}`,
    uploadFile: async (file, key) => {uploads.push(key); assert.deepEqual(fs.readFileSync(file), bytes); if (failUpload) throw new Error('copy failed'); return `https://storage.test/${key}`;},
    deleteObject: async key => {deleted.push(key);},
  });
  globalThis.fetch = async (url, init) => String(url).startsWith('https://storage.test/') ? new Response(bytes, {headers: {'Content-Length': String(bytes.length)}}) : savedFetch(url, init);
  try {
    const response = await request('POST', task), data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(policy.getPendingUpload(data.uploadKey, 'alice').stored, true);
    assert.equal(fs.existsSync(policy.localUploadPath(data.uploadKey)), false);
    failUpload = true;
    assert.equal((await request('POST', task)).status, 500);
    assert.equal(policy.getPendingUpload(uploads[1], 'alice'), null);
    assert.equal(fs.existsSync(policy.localUploadPath(uploads[1])), false);
    assert.deepEqual(deleted, [uploads[1]]);
    assert.ok(!deleted.includes(sourceKey));
  } finally {Object.assign(cos.CosService, savedCos); globalThis.fetch = savedFetch;}
});
