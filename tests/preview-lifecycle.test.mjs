import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createPreviewServer } from '../preview.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fakeHandler({ ready = Promise.resolve(), route, shutdown = async () => {} } = {}) {
  const handler = route || (async (_req, res) => { res.end('ready'); return true; });
  handler.ready = ready;
  handler.shutdown = shutdown;
  return handler;
}

async function listen(server) {
  await server.ready;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function rawRequest(server, target, headers = '', body = '') {
  return new Promise((resolve, reject) => {
    const socket = connect(server.address().port, '127.0.0.1');
    let data = '';
    socket.setTimeout(3_000, () => socket.destroy(new Error('Raw request timeout')));
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      data += chunk;
      const end = data.indexOf('\r\n\r\n');
      const length = end < 0 ? null : data.slice(0, end).match(/\r\ncontent-length:\s*(\d+)/i);
      const chunkedComplete = end >= 0 && /\r\ntransfer-encoding:\s*chunked/i.test(data.slice(0, end)) && data.endsWith('\r\n0\r\n\r\n');
      if ((length && Buffer.byteLength(data.slice(end + 4)) >= Number(length[1])) || chunkedComplete) {
        resolve(data);
        socket.destroy();
      }
    });
    socket.on('error', reject);
    socket.on('end', () => resolve(data));
    socket.on('connect', () => socket.write(`${target}\r\nHost: localhost\r\nConnection: close\r\n${headers}\r\n${body}`));
  });
}

test('invalid targets and malformed HTTP return 400 without crashing subsequent requests or logging secrets', async t => {
  const logs = [];
  const server = createPreviewServer({ createAI: () => fakeHandler(), logger: code => logs.push(code) });
  const base = await listen(server);
  t.after(() => server.shutdown());
  for (const target of ['GET //[?secret=test-private-value HTTP/1.1', 'GET /%ZZ?secret=test-private-value HTTP/1.1']) {
    const response = await rawRequest(server, target);
    assert.match(response, /^HTTP\/1\.1 400/);
    assert.match(response, /INVALID_REQUEST_URL/);
    assert.doesNotMatch(response, /test-private-value|TypeError|stack/);
  }
  assert.match(await rawRequest(server, 'GET / HTTP/1.1', 'bad header\r\n'), /^HTTP\/1\.1 400/);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.deepEqual(logs, ['INVALID_REQUEST_URL', 'INVALID_REQUEST_URL', 'MALFORMED_HTTP']);
});

test('async handler failures use a sanitized 500 response and do not crash the workspace', async t => {
  const logs = [];
  const handler = fakeHandler({ route: async () => { await Promise.resolve(); throw new Error('private-key hidden-path user-query'); } });
  const server = createPreviewServer({ createAI: () => handler, logger: code => logs.push(code) });
  const base = await listen(server);
  t.after(() => server.shutdown());
  const response = await fetch(base + '/api/ai/test?private=query');
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /REQUEST_FAILED/);
  assert.doesNotMatch(body, /private|hidden|query|stack/);
  assert.deepEqual(logs, ['REQUEST_FAILED']);
  assert.equal((await fetch(base + '/')).status, 200);
});

test('eager initialization exposes ready rejection and cleanup is possible before listening', async () => {
  const readyFailure = new Error('Storage unavailable');
  let factories = 0;
  let shutdowns = 0;
  const server = createPreviewServer({ createAI: () => {
    factories++;
    return fakeHandler({ ready: Promise.reject(readyFailure), shutdown: async () => { shutdowns++; } });
  } });
  assert.equal(factories, 1);
  await assert.rejects(server.ready, readyFailure);
  assert.equal(server.listening, false);
  await server.shutdown();
  await server.shutdown();
  assert.equal(shutdowns, 1);
});

test('graceful close waits for AI drain, rejects new POSTs and keeps result reads available until release', async () => {
  const drain = deferred();
  const drainStarted = deferred();
  const events = [];
  const server = createPreviewServer({ createAI: () => fakeHandler({
    shutdown: async () => {
      events.push('drain-start');
      drainStarted.resolve();
      await drain.promise;
      events.push('lock-release');
    },
  }) });
  const base = await listen(server);
  server.on('close', () => events.push('http-close'));
  let callbacks = 0;
  const closed = new Promise((resolve, reject) => {
    assert.equal(server.close(error => { callbacks++; error ? reject(error) : resolve(); }), server);
  });
  try {
    await drainStarted.promise;
    assert.equal(server.listening, true);
    assert.equal(callbacks, 0);
    const blocked = await fetch(base + '/api/ai/images', { method: 'POST', body: '{}' });
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).code, 'SERVICE_STOPPING');
    const read = await fetch(base + '/api/ai/media/test/result-1.png');
    assert.equal(read.status, 200);
    assert.equal(await read.text(), 'ready');
    assert.deepEqual(events, ['drain-start']);
  } finally {
    drain.resolve();
    await closed;
  }
  await server.shutdown();
  assert.equal(callbacks, 1);
  assert.deepEqual(events, ['drain-start', 'lock-release', 'http-close']);
});

test('AI content length limit rejects early and does not reduce the digital-human upload allowance', async t => {
  let aiCalls = 0;
  let upstreamLength;
  const upstream = createServer((req, res) => { upstreamLength = req.headers['content-length']; res.end('accepted'); });
  const backendUrl = await listen(upstream);
  const server = createPreviewServer({ backendUrl, createAI: () => fakeHandler({ route: async (_req, res) => { aiCalls++; res.end('ready'); return true; } }) });
  await listen(server);
  t.after(async () => {
    await server.shutdown();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  const size = 500 * 1024 * 1024;
  const rejected = await rawRequest(server, 'POST /api/ai/images HTTP/1.1', `Content-Length: ${size}\r\n`);
  assert.match(rejected, /^HTTP\/1\.1 413/);
  assert.equal(aiCalls, 0);
  const accepted = await rawRequest(server, 'POST /api/upload HTTP/1.1', `Content-Length: ${size}\r\n`, 'x');
  assert.match(accepted, /^HTTP\/1\.1 200/);
  assert.equal(upstreamLength, String(size));
});
