import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digitalHumanApi as api } from '../design/digital-human-api.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('task creation keeps the source contract and never retries an ambiguous server failure', async t => {
  const calls = [];
  const input = { avatarId: 'avatar-1', scriptText: '门店开业', speakerVoiceId: 'voice-1', toneProfile: 'low', videoFit: 'smart', emotionIntensity: 0.8, engine: 'b' };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return json({ error: '创建任务失败，请稍后重试' }, 503);
  });
  await assert.rejects(api.createTask(input), error => error.status === 503 && /创建任务失败/u.test(error.message));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/tasks');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].options.body), input);
});

test('a lost connection does not resubmit a paid task', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('Failed to fetch'); });
  await assert.rejects(api.createTask({ scriptText: '测试' }), error => error.status === 0 && /避免重复提交/u.test(error.message));
  assert.equal(calls, 1);
});

test('empty, non-JSON and incomplete success responses are never treated as saved data', async t => {
  const responses = [new Response(''), new Response('<!doctype html>'), json({ success: true }), json({ success: false })];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  await assert.rejects(api.getTask('task-1'), { status: 502 });
  await assert.rejects(api.listAvatars(), { status: 502 });
  await assert.rejects(api.listVoices(), { status: 502 });
  await assert.rejects(api.deleteTask('task-1'));
});

test('lists unwrap the public DTO and status checks only contact the local status endpoint', async t => {
  const urls = [];
  const avatar = { id: 'avatar-1', name: '老板', videoUrl: '/api/avatars/avatar-1/media?kind=video' };
  const status = { ready: false, ttsReady: false, mediaReady: false, engines: [] };
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return json(url.endsWith('/status') ? status : { success: true, avatars: [avatar] });
  });
  assert.deepEqual(await api.listAvatars(), [avatar]);
  assert.deepEqual(await api.getStatus(), status);
  assert.deepEqual(urls, ['/api/avatars', '/api/digital-human/status']);
});

test('login errors retain the HTTP status and provide readable text', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({ error: 'Main-site session is invalid.' }, 401));
  await assert.rejects(api.getSession(), error => error.status === 401 && error.message === '请先登录后再操作');
});

test('media and download URLs reject script schemes and require a completed output', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//outside.example/file.mp4', '\\outside.example\file', 'https://user:password@example.com/file', 'java\nscript:alert(1)', null]) {
    assert.equal(api.safeMediaUrl(value), '');
  }
  assert.equal(api.safeMediaUrl('/api/avatars/a/media?kind=video'), '/api/avatars/a/media?kind=video');
  assert.equal(api.safeMediaUrl('https://media.example.com/a.mp4'), 'https://media.example.com/a.mp4');
  assert.equal(api.downloadUrl({ id: 't', status: 'processing', results: { finalVideoUrl: '/preview' } }), '');
  assert.equal(api.downloadUrl({ id: 't/a', status: 'completed', results: { finalVideoUrl: '/preview' } }), '/api/tasks/t%2Fa/download/final.mp4');
  assert.equal(api.downloadUrl({ id: 't', status: 'completed', results: { exactAudioUrl: '/voice', audioFormat: 'mp3' } }, 'audio'), '/api/tasks/t/download/voice-track.mp3');
});

function installXhr(t, onSend) {
  class Xhr {
    upload = {};
    headers = {};
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(body) {
      this.body = body;
      queueMicrotask(() => {
        try { onSend(this); } catch (error) { this.testError = error; this.onerror?.(); }
      });
    }
    abort() { this.onabort?.(); }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, writable: true, value: Xhr });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'XMLHttpRequest', previous);
    else delete globalThis.XMLHttpRequest;
  });
}

test('local voice upload uses raw bytes, reports real progress, and only registers after upload confirmation', async t => {
  const events = [];
  const progress = [];
  const file = new File(['12345678'], 'voice.wav', { type: 'audio/wav' });
  const voice = { id: 'voice-1', name: '老板声音', audioUrl: '/api/voices/voice-1/audio' };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    events.push(url);
    if (url === '/api/upload/direct') {
      assert.deepEqual(JSON.parse(options.body), { folder: 'voices', fileName: 'voice.wav', fileSize: 8, contentType: 'audio/wav' });
      return json({ direct: false });
    }
    assert.deepEqual(JSON.parse(options.body), { name: '老板声音', description: '门店口播', uploadKey: 'uploads/voice.wav' });
    return json({ success: true, voice });
  });
  installXhr(t, xhr => {
    events.push(xhr.url);
    assert.equal(xhr.method, 'POST');
    assert.equal(xhr.body, file);
    assert.equal(xhr.headers['Content-Type'], 'audio/wav');
    xhr.upload.onprogress({ lengthComputable: true, loaded: 4, total: 8 });
    xhr.status = 200;
    xhr.responseText = JSON.stringify({ success: true, uploadKey: 'uploads/voice.wav', storedRemotely: false });
    xhr.onload();
  });
  assert.deepEqual(await api.createVoice(file, { name: '老板声音', description: '门店口播', onProgress: value => progress.push(value) }), voice);
  assert.deepEqual(events, ['/api/upload/direct', '/api/upload?folder=voices&fileName=voice.wav', '/api/voices']);
  assert.deepEqual(progress, [0, 50, 99, 100]);
});

test('multipart uploads use only grant URLs and complete before the voice is registered', async t => {
  const events = [];
  const bytes = [];
  const file = new File(['abcdef'], 'voice.mp3', { type: 'audio/mpeg' });
  t.mock.method(globalThis, 'fetch', async url => {
    events.push(url);
    if (url === '/api/upload/direct') return json({ direct: true, uploadKey: 'uploads/voice.mp3', parts: [
      { url: 'https://media.example.com/part1', size: 2 }, { url: 'https://media.example.com/part2', size: 4 },
    ] });
    if (url === '/api/upload/complete') return json({ success: true, uploadKey: 'uploads/voice.mp3' });
    return json({ success: true, voice: { id: 'voice-2', name: '声音' } });
  });
  installXhr(t, xhr => {
    events.push(xhr.url);
    assert.equal(xhr.method, 'PUT');
    assert.equal(xhr.headers['Content-Type'], 'application/octet-stream');
    bytes.push(xhr.body.text());
    xhr.status = 200;
    xhr.onload();
  });
  await api.createVoice(file, { name: '声音' });
  assert.deepEqual(await Promise.all(bytes), ['ab', 'cdef']);
  assert.deepEqual(events, ['/api/upload/direct', 'https://media.example.com/part1', 'https://media.example.com/part2', '/api/upload/complete', '/api/voices']);
});

test('a failed raw upload is not retried and cannot register a voice', async t => {
  const urls = [];
  let uploads = 0;
  t.mock.method(globalThis, 'fetch', async url => { urls.push(url); return json({ direct: false }); });
  installXhr(t, xhr => {
    uploads++;
    xhr.status = 503;
    xhr.responseText = JSON.stringify({ error: '上传服务暂不可用' });
    xhr.onload();
  });
  await assert.rejects(api.createVoice(new File(['x'], 'test.wav', { type: 'audio/wav' })), { status: 503 });
  assert.deepEqual(urls, ['/api/upload/direct']);
  assert.equal(uploads, 1);
});

test('invalid media is rejected before it contacts the server', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json({}); });
  await assert.rejects(api.createVoice(new File(['x'], 'bad.html', { type: 'text/html' })), { status: 400 });
  await assert.rejects(api.createVoice({ name: 'big.wav', size: 50 * 1024 * 1024 + 1, type: 'audio/wav', slice() {} }), { status: 400 });
  await assert.rejects(api.createAvatar({ name: 'big.mp4', size: 500 * 1024 * 1024 + 1, type: 'video/mp4', slice() {} }), { status: 400 });
  assert.equal(calls, 0);
});
