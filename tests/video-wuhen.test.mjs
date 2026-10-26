import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWuhenProvider, createWuhenStorage } from '../services/video/wuhen.mjs';
import { createSubtitleRemoval } from '../services/video/subtitle-removal.mjs';
import { loadWorkspaceSettings } from '../services/runtime-settings.mjs';

const urls = { videoUrl: 'https://bucket.example/input?private=input', uploadUrl: 'https://bucket.example/output?private=output', uploadHeaders: { 'Content-Type': 'video/mp4' } };
const response = data => Response.json({ code: 0, data });

test('Wuhen sends STD all_area without coordinates, caches auth and refreshes expired tokens', async () => {
  const calls = []; let clock = 1000_000;
  const provider = createWuhenProvider({ env: { WUHENAI_API_KEY: 'private-api-key' }, now: () => clock,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url); calls.push({ url: parsed, ...options });
      assert.ok(parsed.searchParams.get('nonce')); assert.equal(parsed.searchParams.get('t'), String(clock / 1000));
      if (parsed.pathname.endsWith('access_token')) return response({ access_token: 'private-token', expired: clock / 1000 + 3600 });
      assert.equal(options.headers.Authorization, 'Bearer private-token'); assert.equal(parsed.searchParams.has('api_key'), false);
      return parsed.pathname.endsWith('video_removal') ? response({ task_id: 'job-1' }) : response({ task_id: 'job-1', status: 'processing', progress: 38 });
    } });
  await Promise.all([provider.authorize(), provider.authorize()]);
  assert.equal(await provider.submit(urls), 'job-1'); await provider.query('job-1');
  assert.equal(calls.filter(call => call.url.pathname.endsWith('access_token')).length, 1);
  const body = JSON.parse(calls.find(call => call.method === 'POST').body);
  assert.deepEqual(body, { video_url: urls.videoUrl, model: 'video_removal_std', method: 'all_area', upload_url: urls.uploadUrl, upload_headers: urls.uploadHeaders });
  clock += 3600_000; await provider.query('job-1');
  assert.equal(calls.filter(call => call.url.pathname.endsWith('access_token')).length, 2);
  assert.equal(new Set(calls.map(call => call.url.searchParams.get('nonce'))).size, calls.length);
});

for (const outcome of ['network', 'invalid-json', 'missing-receipt', 'balance', 'expired-token']) test(`Wuhen ${outcome} never exposes credentials or retries a paid POST`, async () => {
  let posts = 0;
  const provider = createWuhenProvider({ env: { WUHENAI_API_KEY: 'private-api-key' }, fetchImpl: async (url, options) => {
    if (options.method !== 'POST') return response({ access_token: 'private-token', expired: Date.now() / 1000 + 3600 });
    posts++;
    if (outcome === 'network') throw new Error('private-api-key ' + url);
    if (outcome === 'invalid-json') return new Response('private-token');
    if (outcome === 'missing-receipt') return response({});
    return Response.json({ code: outcome === 'balance' ? 3001 : 401, message: 'private-api-key private-token' });
  } });
  await assert.rejects(provider.submit(urls), cause => {
    assert.doesNotMatch(cause.message, /private-api-key|private-token|https:/);
    assert.equal(cause.providerNotDispatched, ['balance', 'expired-token'].includes(outcome)); return true;
  });
  assert.equal(posts, 1);
});

test('Wuhen COS signs the matching PUT headers and uses only task-scoped private objects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wuhen-storage-')); t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input.mp4'); await writeFile(input, 'video'); const calls = [];
  const cosClient = Object.fromEntries(['putObject', 'getObjectUrl', 'deleteObject'].map(method => [method, (args, callback) => {
    calls.push({ method, ...args }); callback(null, { Url: `https://cos.example/${args.Key}?signature=${args.Method}` });
  }]));
  const storage = createWuhenStorage({ env: { COS_BUCKET: 'primary-bucket', COS_REGION: 'ap-shanghai' }, cosClient });
  const id = randomUUID(); await storage.upload(id, input); const signed = await storage.submissionUrls(id); await storage.remove(id);
  assert.equal(calls[0].ACL, 'private'); assert.equal(calls[0].ContentLength, 5);
  const put = calls.find(call => call.Method === 'PUT');
  assert.equal(put.Expires, 36 * 3600); assert.deepEqual(put.Headers, signed.uploadHeaders);
  assert.equal(calls.filter(call => call.method === 'deleteObject').length, 2);
  for (const call of calls) assert.match(call.Key, new RegExp(`^workspace-video/subtitle-removal/${id}/(input|output)\\.mp4$`));
  await assert.rejects(storage.outputUrl('../other-user'));
});

test('Wuhen configuration is backend-only and production ignores local credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wuhen-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env.local'), 'WUHENAI_API_KEY=local-test-key\n');
  assert.equal(loadWorkspaceSettings({ root, env: {} }).WUHENAI_API_KEY, 'local-test-key');
  assert.equal(loadWorkspaceSettings({ root, env: { WUHENAI_API_KEY: 'deployment-key' } }).WUHENAI_API_KEY, 'deployment-key');
  assert.equal(loadWorkspaceSettings({ root, env: { NODE_ENV: 'production' } }).WUHENAI_API_KEY, undefined);
  assert.throws(() => createSubtitleRemoval({ env: {} }).assertConfigured(), { code: 'VIDEO_CLEANUP_NOT_CONFIGURED' });
});

async function fixture(t, { submitError, downloadError, invalidVideo, uploadFallback } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'wuhen-workflow-')); t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'subtitle-input.mp4'), 'converted-voice-and-background');
  let saved, task = { id: randomUUID() }, status = 'processing';
  const calls = { posts: 0, uploads: 0, downloads: 0, cleanups: 0, muxes: 0, urlRefreshes: 0 };
  const provider = { assertConfigured() {}, authorize: async () => {},
    submit: async () => { calls.posts++; if (submitError) throw submitError; return 'job-1'; },
    query: async () => ({ task_id: 'job-1', status, progress: 50, metering: 15, credits: 23,
      upload_fallback: uploadFallback, download_url: uploadFallback ? 'https://fallback.example/clean.mp4' : undefined }) };
  const storage = { assertConfigured() {}, upload: async () => { calls.uploads++; }, submissionUrls: async () => urls,
    outputUrl: async () => { calls.urlRefreshes++; return 'https://cos.example/clean.mp4?signed=' + calls.urlRefreshes; },
    remove: async () => { calls.cleanups++; } };
  const service = () => createSubtitleRemoval({ provider, storage,
    download: async (url, output) => {
      calls.downloads++; if (downloadError && calls.downloads === 1) throw new Error('download interrupted');
      assert.match(url, uploadFallback ? /fallback\.example/ : /cos\.example/); await writeFile(output, 'clean-video');
    },
    probe: async path => ({ duration: 14.67, width: invalidVideo && path.endsWith('subtitle-clean.mp4') ? 360 : 720, height: 1280, audio: true }),
    restoreAudio: async (input, cleaned, output) => {
      calls.muxes++; assert.equal(await readFile(input, 'utf8'), 'converted-voice-and-background');
      assert.equal(await readFile(cleaned, 'utf8'), 'clean-video'); await copyFile(cleaned, output);
    } });
  return { calls, folder, get task() { return task; }, setStatus: value => { status = value; },
    advance: () => service().advance(task, folder, async () => { saved = structuredClone(task); }),
    restart: () => { task = structuredClone(saved); } };
}

for (const uploadFallback of [false, true]) test(`full-screen removal resumes after restart/download failure; fallback=${uploadFallback}`, async t => {
  const app = await fixture(t, { downloadError: true, uploadFallback });
  assert.equal(await app.advance(), false); app.restart();
  assert.equal(await app.advance(), false); assert.equal(app.task.subtitleRemoval.progress, 50);
  app.setStatus('success'); await assert.rejects(app.advance(), /download interrupted/); app.restart();
  assert.equal(await app.advance(), true); app.restart(); assert.equal(await app.advance(), true);
  assert.equal(app.calls.posts, 1); assert.equal(app.calls.uploads, 1); assert.equal(app.calls.muxes, 1); assert.equal(app.calls.cleanups, 1);
  assert.equal(app.task.captionCheck.method, 'all_area'); assert.equal(app.task.subtitleRemoval.providerCredits, 23);
  assert.doesNotMatch(JSON.stringify(app.task), /private=|https:/);
  assert.equal(await readFile(join(app.folder, 'result.mp4'), 'utf8'), 'clean-video');
});

test('unknown submission survives restart without another paid request', async t => {
  const app = await fixture(t, { submitError: new Error('connection lost') });
  await assert.rejects(app.advance(), /connection lost/); app.restart();
  await assert.rejects(app.advance(), { code: 'VIDEO_CLEANUP_UNCERTAIN' }); assert.equal(app.calls.posts, 1);
  await assert.rejects(readFile(join(app.folder, 'result.mp4')), { code: 'ENOENT' });
});

test('explicit pre-dispatch rejection can retry after the account is repaired', async t => {
  const app = await fixture(t, { submitError: Object.assign(new Error('balance'), { providerNotDispatched: true }) });
  await assert.rejects(app.advance(), /balance/); app.restart();
  assert.equal(app.task.subtitleRemoval.submitting, undefined);
  await assert.rejects(app.advance(), /balance/); assert.equal(app.calls.posts, 2);
});

for (const status of ['failed', 'paused']) test(`terminal ${status} cannot silently pass through or resubmit`, async t => {
  const app = await fixture(t); await app.advance(); app.setStatus(status);
  await assert.rejects(app.advance(), { code: 'VIDEO_CLEANUP_FAILED' }); app.restart();
  await assert.rejects(app.advance(), { code: 'VIDEO_CLEANUP_FAILED' }); assert.equal(app.calls.posts, 1);
  await assert.rejects(readFile(join(app.folder, 'result.mp4')), { code: 'ENOENT' });
});

test('invalid cleanup dimensions preserve the input without delivering or resubmitting', async t => {
  const app = await fixture(t, { invalidVideo: true }); await app.advance(); app.setStatus('success');
  await assert.rejects(app.advance(), { code: 'VIDEO_CLEANUP_INVALID' });
  assert.equal(app.calls.posts, 1); assert.equal(app.calls.muxes, 0);
  assert.equal(await readFile(join(app.folder, 'subtitle-input.mp4'), 'utf8'), 'converted-voice-and-background');
});
