import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreviewServer } from '../preview.mjs';
import { assertPersistentStorage } from '../services/runtime-paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const serviceDir = join(root, 'services/digital-human');
const nextBin = join(serviceDir, 'node_modules/next/dist/bin/next');
let server;
let child;
let childExited;
let stopping = false;

function portValue(name, fallback) {
  const value = process.env[name] || String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`${name} 必须是 1–65535 的端口号。`);
  return Number(value);
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try { await server?.shutdown(); }
  catch { console.error('工作台关闭失败。'); code = 1; }
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    // This is the backend created by this launcher, never an existing local service.
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    timer.unref();
    await childExited;
    clearTimeout(timer);
  }
  process.exitCode = code;
}

async function start() {
  const port = portValue('PORT', 8080);
  const backendPort = portValue('DIGITAL_HUMAN_PORT', 3001);
  if (port === backendPort) throw new Error('PORT 与 DIGITAL_HUMAN_PORT 不能相同。');
  process.env.NODE_ENV = 'production';
  const dataRoot = assertPersistentStorage({ root });
  process.env.AUTH_MODE ||= 'standalone';
  if (process.env.AUTH_MODE !== 'standalone' || !process.env.AUTH_DATABASE_URL) throw new Error('请配置 AUTH_MODE=standalone 和 AUTH_DATABASE_URL。');
  let publicOrigin;
  try { publicOrigin = new URL(process.env.AUTH_PUBLIC_URL).origin; } catch {}
  if (!publicOrigin?.startsWith('https://')) throw new Error('AUTH_PUBLIC_URL 必须是网站的 HTTPS 地址。');
  if (!existsSync(nextBin) || !existsSync(join(serviceDir, '.next/BUILD_ID'))) throw new Error('缺少生产构建，请先安装数字人依赖并执行 npm run build。');

  const backendUrl = `http://127.0.0.1:${backendPort}`;
  server = createPreviewServer({ backendUrl, publicOrigin, authRequired: true,
    aiOptions: { storageDir: join(dataRoot, 'ai') },
    restaurantOptions: { dataDir: join(dataRoot, 'restaurant'), databaseUrl: process.env.RESTAURANT_DATABASE_URL || process.env.AUTH_DATABASE_URL },
  });
  server.on('error', () => { console.error('主站端口监听失败。'); void stop(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
  await server.ready;
  if (stopping) return;
  child = spawn(process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(backendPort)], {
    cwd: serviceDir, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PORT: String(backendPort), NEXT_TELEMETRY_DISABLED: '1' },
  });
  childExited = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  child.once('error', () => { console.error('数字人后端启动失败。'); void stop(1); });
  child.once('exit', () => { if (!stopping) { console.error('数字人后端已退出，停止主站。'); void stop(1); } });
  const deadline = Date.now() + 60000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(backendUrl + '/api/auth/info', { signal: AbortSignal.timeout(2000) });
      const info = await response.json();
      ready = response.ok && info.app === 'digital-human-studio' && info.authMode === 'standalone';
      if (ready) break;
    } catch { /* Next.js may still be starting. */ }
    await delay(250);
  }
  if (stopping) return;
  if (!ready) throw new Error('数字人后端启动超时。');
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
  console.log(`Workspace: http://${server.address().address}:${server.address().port}`);
}

start().catch(async error => { console.error(error.message); await stop(1); });
