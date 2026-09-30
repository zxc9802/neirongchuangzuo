import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreviewServer } from '../preview.mjs';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}

test('production proxy forwards the configured HTTPS origin and preserves secure login cookies', async t => {
  const backend = createServer((req, res) => {
    res.setHeader('Set-Cookie', 'session=opaque; HttpOnly; Secure; SameSite=Lax; Path=/');
    res.end(JSON.stringify(req.headers));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const handler = async () => false; handler.ready = Promise.resolve(); handler.shutdown = async () => {};
  const server = createPreviewServer({ backendUrl: `http://127.0.0.1:${backend.address().port}`, publicOrigin: 'https://studio.example.com', createAI: () => handler });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await server.shutdown(); await new Promise(resolve => backend.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: 'POST', headers: { Origin: 'https://studio.example.com', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'untrusted.example' },
  });
  const forwarded = await response.json();
  assert.equal(forwarded['x-forwarded-proto'], 'https');
  assert.equal(forwarded['x-forwarded-host'], 'studio.example.com');
  assert.equal(forwarded.origin, 'https://studio.example.com');
  assert.match(response.headers.get('set-cookie'), /Secure/);
});

test('production launcher binds PORT publicly, starts a private production backend and exits when it fails', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-production-'));
  const service = join(root, 'services/digital-human');
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(service, 'node_modules/next/dist/bin'), { recursive: true });
  await mkdir(join(service, '.next'), { recursive: true });
  await writeFile(join(root, 'scripts/start.mjs'), await readFile(new URL('../scripts/start.mjs', import.meta.url)));
  await writeFile(join(root, 'preview.mjs'), `export { createPreviewServer } from ${JSON.stringify(new URL('../preview.mjs', import.meta.url).href)};`);
  await writeFile(join(service, '.next/BUILD_ID'), 'test-build');
  await writeFile(join(service, 'node_modules/next/dist/bin/next'), `
    const http = require('node:http');
    const args = process.argv.slice(2);
    const port = Number(args[args.indexOf('--port') + 1]);
    const host = args[args.indexOf('--hostname') + 1];
    http.createServer((req,res) => {
      res.setHeader('Content-Type','application/json');
      if (req.url === '/api/auth/info') res.end(JSON.stringify({app:'digital-human-studio',authMode:'standalone'}));
      else if (req.url === '/api/crash') {res.end('{}'); setTimeout(() => process.exit(7),20);}
      else res.end(JSON.stringify({mode:args[0],host,port,nodeEnv:process.env.NODE_ENV}));
    }).listen(port,host);
  `);
  const port = await freePort(); const backendPort = await freePort();
  const child = spawn(process.execPath, [join(root, 'scripts/start.mjs')], {
    env: { ...process.env, PORT: String(port), DIGITAL_HUMAN_PORT: String(backendPort), AUTH_MODE: 'standalone',
      AUTH_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test', AUTH_PUBLIC_URL: 'https://studio.example.com', OPENLUX_API_KEY: '' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    assert.ok(root.startsWith(join(tmpdir(), 'workspace-production-')));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try { ready = (await fetch(base + '/login')).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, output);
  assert.match(output, new RegExp('0\\.0\\.0\\.0:' + port));
  assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(base + '/api/ai/images')).status, 401);
  assert.deepEqual(await (await fetch(base + '/api/probe')).json(), {mode:'start',host:'127.0.0.1',port:backendPort,nodeEnv:'production'});
  await fetch(base + '/api/crash');
  assert.equal((await exited)[0], 1);
  await assert.rejects(fetch(base + '/login'));
});
