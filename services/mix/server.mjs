import { createHash, randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createMixCreditsBridge } from './credits-bridge.mjs';

const PYTHON_ROOT = fileURLToPath(new URL('./python/', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const hopHeaders = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'set-cookie']);
const MUTATIONS = new Set(['POST', 'PATCH', 'DELETE']);

function reply(res, status, code, message) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ code, error: message }));
}

function route(path, method) {
  if (path === '/api/mix/health' && method === 'GET') return '/health';
  if (path === '/api/mix/audio' && ['GET', 'POST'].includes(method)) return '/v1/mix/audio';
  if (/^\/api\/mix\/audio\/[a-f0-9]{32}$/.test(path) && method === 'DELETE') return path.replace('/api/mix', '/v1/mix');
  if (/^\/api\/mix\/audio\/[a-f0-9]{32}\/stream$/.test(path) && ['GET', 'HEAD'].includes(method)) return path.replace('/api/mix', '/v1/mix');
  if (path === '/api/mix/jobs' && ['GET', 'POST'].includes(method)) return '/v1/mix/jobs';
  if (/^\/api\/mix\/jobs\/[a-f0-9]{32}$/.test(path) && method === 'GET') return path.replace('/api/mix', '/v1/mix');
  if (/^\/api\/mix\/jobs\/[a-f0-9]{32}\/(video|plan|captions)$/.test(path) && ['GET', 'HEAD'].includes(method)) return path.replace('/api/mix', '/v1/mix');
  if (/^\/api\/mix\/jobs\/[a-f0-9]{32}\/resume$/.test(path) && method === 'POST') return path.replace('/api/mix', '/v1/mix');
  if (path === '/api/browser-materials/connect' && method === 'POST') return '/v1/browser-materials/connect';
  if (/^\/api\/browser-materials\/devices\/[a-f0-9]{32}$/.test(path) && method === 'DELETE') return path.replace('/api/browser-materials', '/v1/browser-materials');
  const match = /^\/api\/browser-materials\/devices\/[a-f0-9]{32}\/(heartbeat|clips|analyze|requests|assets\/[a-f0-9]{64}|requests\/[a-f0-9]{32}\/(frames|file)|files\/[a-f0-9]{32}(?:\/complete)?)$/.exec(path);
  if (!match) return null;
  const action = match[1];
  const allowed = action === 'requests' ? ['GET'] : action.startsWith('assets/') ? ['DELETE'] : /^files\/[a-f0-9]{32}$/.test(action) ? ['HEAD', 'PATCH'] : ['POST'];
  return allowed.includes(method) ? path.replace('/api/browser-materials', '/v1/browser-materials') : null;
}

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}

// Only the Node gateway knows this process's token; the Python listener is private.
export function createMixHandler({ dataDir, env = process.env, serviceUrl, token = randomBytes(32).toString('hex'), publicOrigin, requireOrigin = false, credits } = {}) {
  let endpoint = serviceUrl ? new URL(serviceUrl) : null;
  if (endpoint && (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname))) throw new Error('Mix service must use loopback HTTP.');
  let child, exited, starting, closing = false;
  const transfers = new Set();
  const creditBridge = credits ? createMixCreditsBridge({ credits, dataDir, token }) : null;

  async function start() {
    if (closing) throw new Error('Stopping');
    if (endpoint) return endpoint;
    if (starting) return starting;
    starting = (async () => {
      const port = await freePort();
      const creditsUrl = creditBridge ? await creditBridge.start() : null;
      if (closing) throw new Error('Stopping');
      const address = new URL(`http://127.0.0.1:${port}`);
      child = spawn(env.MIX_PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
        ['-m', 'uvicorn', 'app:create_app', '--factory', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning', '--no-access-log'],
        { cwd: PYTHON_ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
          env: { ...env, DATA_DIR: dataDir, MIXER_API_TOKEN: token, PYTHONUNBUFFERED: '1',
            MIX_CREDITS_ENABLED: creditBridge ? '1' : '0', MIX_CREDITS_URL: creditsUrl || '' } });
      let ended = false;
      exited = new Promise(resolve => {
        child.once('exit', () => { ended = true; endpoint = null; resolve(); });
        child.once('error', () => { ended = true; endpoint = null; resolve(); });
      });
      const deadline = Date.now() + 30_000;
      while (!closing && !ended && Date.now() < deadline) {
        try {
          const response = await fetch(new URL('/health', address), { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1000) });
          if (response.ok && (await response.json()).app === 'browser-material-mixer') { endpoint = address; return address; }
        } catch { /* The child may still be importing the media libraries. */ }
        await delay(100);
      }
      child.kill();
      await exited;
      throw new Error('Mix service could not start');
    })().finally(() => { starting = null; });
    return starting;
  }

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const target = route(path, req.method);
    if (!target) { reply(res, 404, 'NOT_FOUND', '接口不存在。'); return true; }
    if (!req.authenticatedUserId) { reply(res, 401, 'UNAUTHENTICATED', '请先登录后继续。'); return true; }
    if (closing) { reply(res, 503, 'SERVICE_STOPPING', '服务正在重启，请稍后重试。'); return true; }
    if (MUTATIONS.has(req.method)) {
      const expected = publicOrigin || `http://${req.headers.host}`;
      if ((req.headers.origin && req.headers.origin !== expected) || (requireOrigin && req.headers.origin !== expected)
        || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        reply(res, 403, 'ORIGIN_REJECTED', '请从本站页面连接素材或提交混剪。'); return true;
      }
    }
    const owner = hash(req.authenticatedUserId);
    if (creditBridge) {
      try { await creditBridge.register(req.authenticatedUserId); }
      catch { reply(res, 503, 'CREDITS_STORAGE_UNAVAILABLE', '积分服务暂时不可用，请稍后重试。'); return true; }
    }
    const headers = { authorization: 'Bearer ' + token, 'x-material-owner': owner };
    for (const key of ['content-type', 'content-length', 'upload-offset', 'upload-checksum', 'range', 'if-range']) {
      if (req.headers[key] !== undefined) headers[key] = req.headers[key];
    }
    if (req.headers['idempotency-key']) {
      const key = req.headers['idempotency-key'];
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) { reply(res, 400, 'INVALID_REQUEST_ID', '提交标识无效，请刷新后重试。'); return true; }
      headers['idempotency-key'] = hash(owner + ':' + key);
    }
    let backend;
    try { backend = await start(); }
    catch { reply(res, 503, 'MIX_UNAVAILABLE', '混剪服务启动失败，请管理员检查 Python 依赖与服务器配置。'); return true; }
    if (req.aborted || res.destroyed) return true;
    await new Promise(resolve => {
      const address = new URL(target, backend);
      address.search = url.search;
      const upstream = request(address, { method: req.method, headers }, response => {
        const excluded = new Set([...hopHeaders, ...String(response.headers.connection || '').split(',').map(item => item.trim().toLowerCase())]);
        res.writeHead(response.statusCode || 502, { ...Object.fromEntries(Object.entries(response.headers).filter(([key]) => !excluded.has(key))), 'Cache-Control': 'no-store' });
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      transfers.add(upstream);
      const finish = () => { transfers.delete(upstream); resolve(); };
      upstream.setTimeout(10 * 60_000, () => upstream.destroy());
      upstream.on('error', () => { reply(res, 502, 'MIX_UNAVAILABLE', '混剪服务暂时不可用，请稍后重新连接。'); finish(); });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => { if (!res.writableFinished) upstream.destroy(); finish(); });
      req.pipe(upstream);
    });
    return true;
  };
  handle.shutdown = async () => {
    closing = true;
    for (const transfer of transfers) transfer.destroy();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
      await exited; clearTimeout(timer);
    }
    await starting?.catch(() => {});
    await creditBridge?.shutdown();
  };
  return handle;
}
