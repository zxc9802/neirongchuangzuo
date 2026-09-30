import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createAIHandler } from './services/ai/server.mjs';
import { getWorkspaceUser, workspaceAuthRequired } from './services/auth/workspace.mjs';
const files = new Map([
  ['/', ['design/index.html', 'text/html; charset=utf-8']],
  ['/login', ['design/auth.html', 'text/html; charset=utf-8']],
  ['/register', ['design/auth.html', 'text/html; charset=utf-8']],
  ['/auth.css', ['design/auth.css', 'text/css; charset=utf-8']],
  ...['auth', 'workspace-account', 'account-storage'].map(name => [`/${name}.js`, [`design/${name}.js`, 'text/javascript; charset=utf-8']]),
  ['/app.js', ['design/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['design/style.css', 'text/css; charset=utf-8']],
  ...['home', 'studios', 'workbench', 'agent-chat', 'business-catalog', 'business-flow', 'material-catalog', 'image-generation', 'image-presets', 'image-preset-ui', 'generated-assets'].map(name=>[`/${name}.js`,[`design/${name}.js`,'text/javascript; charset=utf-8']]),
  ...['digital-human', 'digital-human-api'].map(name=>[`/${name}.js`,[`design/${name}.js`,'text/javascript; charset=utf-8']]),
  ['/digital-human.css', ['design/digital-human.css', 'text/css; charset=utf-8']],
  ...['home', 'studios', 'product', 'agent-chat', 'business-flow', 'generated-assets'].map(name=>[`/${name}.css`,[`design/${name}.css`,'text/css; charset=utf-8']]),
]);
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function proxyHeaders(headers) {
  const names = new Set([...hopHeaders, ...String(headers.connection || '').split(',').map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !names.has(key.toLowerCase())));
}

function forward(req, res, backend, publicOrigin) {
  const headers = proxyHeaders(req.headers);
  headers.host = backend.host;
  headers['x-forwarded-host'] = publicOrigin?.host || req.headers.host || '127.0.0.1:5173';
  headers['x-forwarded-proto'] = publicOrigin?.protocol.slice(0, -1) || 'http';
  const upstream = request({ hostname: backend.hostname, port: backend.port, path: req.url, method: req.method, headers }, response => {
    const responseHeaders = proxyHeaders(response.headers);
    if (responseHeaders.location?.startsWith(backend.origin + '/')) {
      responseHeaders.location = responseHeaders.location.slice(backend.origin.length);
    }
    res.writeHead(response.statusCode || 502, responseHeaders);
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.setTimeout(10 * 60_000, () => upstream.destroy(new Error('Backend timeout')));
  upstream.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: '数字人服务暂时无法连接，请稍后重试。', code: 'SERVICE_UNAVAILABLE' }));
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}

const MAX_AI_BODY_BYTES = 34 * 1024 * 1024;

function safeError(res, status, code, message, close = false) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(close ? { Connection: 'close' } : {}) });
  res.end(JSON.stringify({ error: message, code }));
}

export function createPreviewServer({ backendUrl = 'http://127.0.0.1:3001', publicOrigin, authRequired = false, aiOptions, createAI = createAIHandler, logger = code => console.error(`[preview] ${code}`) } = {}) {
 const backend = new URL(backendUrl);
 const externalOrigin = publicOrigin ? new URL(publicOrigin) : undefined;
 if (backend.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(backend.hostname)) throw new Error('The development backend must use loopback HTTP.');
 const handleAI = createAI(aiOptions);
 const ready = Promise.resolve(handleAI.ready);
 ready.catch(() => {});
 let closing = false;
 let shutdownPromise;
 const report = code => { try { logger(code); } catch { /* Diagnostics must never crash the server. */ } };
 const route = async (req, res) => {
  let path;
  try {
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || /[\\#\u0000-\u0020]/.test(req.url)) throw new Error('Invalid request target');
    const parsed = new URL(req.url, 'http://localhost');
    if (/[\u0000-\u001f\u007f]/.test(decodeURI(req.url))) throw new Error('Invalid request target');
    path = parsed.pathname;
  } catch {
    report('INVALID_REQUEST_URL');
    safeError(res, 400, 'INVALID_REQUEST_URL', '请求地址无效。', true);
    return;
  }
  if (path === '/api/workspace/session' || authRequired && (path === '/' || path === '/api/ai' || path.startsWith('/api/ai/'))) {
    let user = null;
    try { if (authRequired) user = await getWorkspaceUser(req, backend); }
    catch { safeError(res, 503, 'AUTH_UNAVAILABLE', '账号服务暂时不可用，请稍后重试。'); return; }
    if (authRequired && !user) {
      if (path === '/') { res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' }); res.end(); }
      else safeError(res, 401, 'UNAUTHENTICATED', '请先登录后继续。');
      return;
    }
    req.authenticatedUserId = user?.id;
    if (path === '/api/workspace/session') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ required: authRequired, user })); return;
    }
  }
  if (path === '/api/ai' || path.startsWith('/api/ai/')) {
    if (req.method === 'POST' && (closing || handleAI.isClosing)) {
      safeError(res, 503, 'SERVICE_STOPPING', '服务正在重启，请稍后重试。', true);
      return;
    }
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_AI_BODY_BYTES)) {
      safeError(res, 413, 'BODY_TOO_LARGE', '上传内容过大，请减少图片数量或压缩图片。', true);
      return;
    }
    await ready;
    if (await handleAI(req, res)) return;
    safeError(res, 404, 'NOT_FOUND', '接口不存在。');
    return;
  }
  if (/^\/(api(?:\/|$)|jobs\/|uploads\/|_next\/)/.test(path)) {
    forward(req, res, backend, externalOrigin);
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  const entry = files.get(path) || (/^\/media\/[a-zA-Z0-9-]+\.(png|jpg)$/.test(path) ? [`design${path}`,path.endsWith('.png')?'image/png':'image/jpeg'] : null);
  if (!entry) { res.writeHead(404); res.end(); return; }
  const body = await readFile(new URL(entry[0], import.meta.url));
  res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
 };
 const server = createServer({ headersTimeout: 30_000, requestTimeout: 10 * 60_000, keepAliveTimeout: 5_000 }, (req, res) => {
   void route(req, res).catch(() => {
     report('REQUEST_FAILED');
     safeError(res, 500, 'REQUEST_FAILED', '服务暂时无法完成请求，请稍后重试。', true);
   });
 });
 server.on('clientError', (_error, socket) => {
   report('MALFORMED_HTTP');
   if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
   else socket.destroy();
 });
 server.ready = ready;
 const closeHTTP = server.close.bind(server);
 server.shutdown = () => {
   if (shutdownPromise) return shutdownPromise;
   closing = true;
   shutdownPromise = (async () => {
     let failure;
     try {
       if (handleAI.shutdown) await handleAI.shutdown();
       else await handleAI.dispose?.();
     } catch (error) { failure = error; report('AI_SHUTDOWN_FAILED'); }
     await new Promise((resolve, reject) => closeHTTP(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
     if (failure) throw failure;
   })();
   shutdownPromise.catch(() => {});
   return shutdownPromise;
 };
 server.close = callback => {
   const stopped = server.shutdown();
   if (typeof callback === 'function') stopped.then(() => callback(), error => callback(error));
   return server;
 };
 return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const server = createPreviewServer({ authRequired: workspaceAuthRequired() });
 let stopping = false;
 const stop = async (code = 0) => {
   stopping = true;
   try { await server.shutdown(); } catch { console.error('服务关闭未完成，请检查运行日志。'); code = 1; }
   process.exitCode = code;
 };
 for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
 server.on('error', error => {
   console.error(error.code === 'EADDRINUSE' ? '5173 端口已被占用。' : '服务启动失败，请检查运行配置。');
   void stop(1);
 });
 try {
   await server.ready;
   if (!stopping) server.listen(5173, '127.0.0.1', () => console.log('Workspace: http://127.0.0.1:5173'));
 } catch {
   console.error('AI 服务初始化失败，请检查存储目录和运行实例。');
   await stop(1);
 }
}
