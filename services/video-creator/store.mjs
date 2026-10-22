import { mkdir, lstat, realpath, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { createRequestLedger } from '../ai/request-ledger.mjs';
import { creatorError } from './model.mjs';
import { applyWorkspaceChanges } from './workspace.mjs';

export const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const compress = promisify(gzip);
export function createCreatorStore(storageDir) {
  const root = resolve(storageDir), records = new Map();
  const instance = createRequestLedger({ storageDir: root, limits: { chatDaily: null, imageDaily: null, perMinute: null } });
  let canonical, writes = Promise.resolve();
  async function directory(id, create = false) {
    if (!UUID.test(id)) throw creatorError('任务标识无效。');
    if (create) await mkdir(join(root, id), { recursive: true });
    const path = join(root, id), info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== join(canonical, id)) throw creatorError('任务存储不可用。', 503, 'CREATOR_STORAGE_FAILED');
    return path;
  }
  const ready = (async () => {
    await instance.ready; canonical = await realpath(root);
    for (const name of await readdir(root)) {
      if (!UUID.test(name)) continue;
      const path = join(await directory(name), 'state.json'); let info;
      try { info = await lstat(path); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) throw creatorError('任务记录无法读取。', 503, 'CREATOR_STORAGE_FAILED');
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.id !== name || typeof value.userId !== 'string' || !Array.isArray(value.assets) || !Array.isArray(value.messages)
        || !Array.isArray(value.operations) || !Array.isArray(value.tasks)) throw creatorError('任务记录无法读取。', 503, 'CREATOR_STORAGE_FAILED');
      records.set(name, value);
    }
  })();
  ready.catch(() => {});
  async function readWorkspace(userId) {
    await ready;
    const file = join(root, 'workspace-' + createHash('sha256').update(userId).digest('hex') + '.json');
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) throw creatorError('工作区记录无法读取。', 503, 'CREATOR_STORAGE_FAILED');
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value.userId !== userId || !Number.isSafeInteger(value.revision) || !value.entries || Array.isArray(value.entries)) throw creatorError('工作区记录无法读取。', 503, 'CREATOR_STORAGE_FAILED');
      return value;
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; return { userId, revision: 0, entries: {} }; }
  }
  return { ready, records, readWorkspace, updateWorkspace(userId, changes, now) {
    const work = writes.then(async () => {
      const next = applyWorkspaceChanges(await readWorkspace(userId), changes, now);
      const file = join(root, 'workspace-' + createHash('sha256').update(userId).digest('hex') + '.json'), temp = join(root, randomUUID() + '.tmp');
      try { await writeFile(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); await rename(temp, file); }
      finally { await rm(temp, { force: true }); }
      return next;
    }); writes = work.catch(() => {}); return work;
  }, async path(id, filename) {
    await ready;
    if (!/^(?:state\.json|result-[a-f\d-]{36}\.mp4|director-[a-f\d-]{36}\.json\.gz|[a-f\d-]{36}\.(?:jpg|wav|upload)|[a-f\d-]{36}\.tmp)$/.test(filename)) throw creatorError('文件标识无效。');
    return join(await directory(id), filename);
  }, save(record) {
    const copy = structuredClone(record);
    const work = writes.then(async () => {
      await ready; const folder = await directory(copy.id, true), temporary = join(folder, randomUUID() + '.tmp');
      try { await writeFile(temporary, JSON.stringify(copy), { flag: 'wx', mode: 0o600 }); await rename(temporary, join(folder, 'state.json')); }
      finally { await rm(temporary, { force: true }); }
    });
    writes = work.catch(() => {}); return work;
  }, saveDirectorDiagnostic(id, operationId, diagnostic) {
    if (!UUID.test(operationId)) throw creatorError('编导操作标识无效。');
    const snapshot = structuredClone(diagnostic);
    const work = writes.then(async () => {
      await ready; const folder = await directory(id), temporary = join(folder, randomUUID() + '.tmp');
      try {
        const bytes = await compress(Buffer.from(JSON.stringify(snapshot)));
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await rename(temporary, join(folder, `director-${operationId}.json.gz`));
      } finally { await rm(temporary, { force: true }); }
    });
    writes = work.catch(() => {}); return work;
  }, async remove(id) {
    await writes; const folder = await directory(id); await rm(folder, { recursive: true }); records.delete(id);
  }, async close() { await ready.catch(() => {}); await writes; await instance.close(); } };
}
