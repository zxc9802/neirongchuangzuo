import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from '../preview.mjs';
import { workspaceAuthRequired } from '../services/auth/workspace.mjs';
import { loadWorkspaceSettings } from '../services/runtime-settings.mjs';

const serviceDir = fileURLToPath(new URL('../services/digital-human/', import.meta.url));
const nextBin = fileURLToPath(new URL('../services/digital-human/node_modules/next/dist/bin/next', import.meta.url));
if (!existsSync(nextBin)) {
  console.error('请先运行 npm run setup:digital-human 安装数字人服务依赖。');
  process.exit(1);
}
let child;
let stopping = false;
const server = createPreviewServer({ authRequired: workspaceAuthRequired(), localUnlimitedCredits: loadWorkspaceSettings().WORKSPACE_LOCAL_UNLIMITED_CREDITS === '1' });
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try { await server.shutdown(); }
  catch { console.error('AI 服务关闭失败，请检查运行日志。'); code = 1; }
  if (child?.pid && child.exitCode === null) {
    // Only terminate the child process tree created by this launcher.
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('exit', resolve);
        killer.once('error', resolve);
      });
    } else child.kill('SIGTERM');
  }
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? '5173 端口已有服务，请先关闭已有工作台后重试。' : '工作台启动失败，请检查运行配置。');
  void stop(1);
});
try { await server.ready; }
catch {
  console.error('AI 服务初始化失败，请检查存储目录和运行实例。');
  await stop(1);
}
if (!stopping) server.listen(5173, '127.0.0.1', async () => {
  console.log('门店创作工作台：http://127.0.0.1:5173/#avatar');
  try {
    const response = await fetch('http://127.0.0.1:3001/api/digital-human/status', { signal: AbortSignal.timeout(12_000) });
    const data = await response.json();
    if (data.service === 'digital-human') {
      console.log('已连接本机现有数字人服务。');
      return;
    }
    if (response.status === 401) {
      const discovery = await fetch('http://127.0.0.1:3001/api/auth/info', { signal: AbortSignal.timeout(12_000) });
      const info = await discovery.json();
      if (discovery.ok && info.app === 'digital-human-studio' && info.authMode === 'standalone') {
        console.log('已连接本机现有数字人账号服务。');
        return;
      }
    }
    throw new Error('3001 端口已有其他服务，请关闭该服务或检查配置。');
  } catch (error) {
    if (!['TypeError', 'TimeoutError'].includes(error.name)) {
      console.error(error.message);
      await stop(1);
      return;
    }
  }
  if (stopping) return;
  child = spawn(process.execPath, [nextBin, 'dev', '--hostname', '127.0.0.1', '--port', '3001'], {
    cwd: serviceDir, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  child.once('error', error => { console.error(error.message); void stop(1); });
  child.once('exit', code => { if (!stopping) void stop(code ?? 1); });
});
