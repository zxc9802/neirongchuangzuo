import { readFileSync } from 'node:fs';
import { resolve, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export function workspaceDataRoot(env = process.env, root = ROOT) {
  const path = resolve(root, env.WORKSPACE_DATA_DIR || '.data');
  if (path === parse(path).root) throw new Error('WORKSPACE_DATA_DIR 不能使用磁盘根目录。');
  return path;
}

// Container root filesystems disappear when a deployment is replaced.
// Verify the data mount, instead of treating a mkdir or Docker VOLUME declaration as persistence.
export function assertPersistentStorage({ env = process.env, root = ROOT, mountInfo } = {}) {
  const dataDir = workspaceDataRoot(env, root);
  if (env.NODE_ENV !== 'production') return dataDir;
  if (env.PERSISTENT_STORAGE_CONFIRMED === '1') return dataDir; // bare-metal operator confirmation
  if (mountInfo === undefined) {
    try { mountInfo = readFileSync('/proc/self/mountinfo', 'utf8'); } catch { mountInfo = ''; }
  }
  const mounts = mountInfo.split('\n').map(line => line.split(' ')[4]?.replace(/\\040/g, ' ')).filter(Boolean);
  const isMounted = path => mounts.some(mount => mount !== '/' && (path === mount || path.startsWith(mount + '/')));
  if (!isMounted(dataDir) || !isMounted(join(root, 'services/digital-human/.runtime'))) {
    throw new Error('持久化目录未挂载：请挂载 /app/.data 和 /app/services/digital-human/.runtime 后启动。');
  }
  return dataDir;
}
