import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validMediaKey } from './store.mjs';

const problem = (code, message, statusCode = 503) => Object.assign(new Error(message), { code, statusCode, status: statusCode });
const MAX_FILE_BYTES = 96 * 1024 * 1024;
const contentType = key => key.endsWith('.png') ? 'image/png' : /\.jpe?g$/.test(key) ? 'image/jpeg'
  : key.endsWith('.webp') ? 'image/webp' : key.endsWith('.zip') ? 'application/zip' : 'application/octet-stream';
async function safeDirectory(path) {
  let cursor = resolve(path);
  if (cursor === parse(cursor).root) throw problem('unsafe_media', '素材目录无效。');
  while (cursor !== parse(cursor).root) {
    try { const stat = await lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('unsafe_media', '素材目录不安全。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    cursor = dirname(cursor);
  }
}
async function safeFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw problem('unsafe_media', '素材文件不安全。');
  return stat;
}

/** Private storage only: the HTTP layer must authenticate and check task ownership before get(). */
export function createRestaurantMedia({ dataDir = '.data/restaurant', now = Date.now, env = process.env, cosClient } = {}) {
  const root = resolve(dataDir, 'media');
  const settings = { Bucket: env.COS_BUCKET, Region: env.COS_REGION };
  const configured = Boolean(env.COS_SECRET_ID && env.COS_SECRET_KEY && settings.Bucket && settings.Region);
  if ([env.COS_SECRET_ID, env.COS_SECRET_KEY, settings.Bucket, settings.Region].some(Boolean) && !configured && !cosClient) {
    throw problem('media_config_incomplete', '对象存储配置不完整，请补齐凭据、存储桶和地域。');
  }
  let clientPromise;
  async function client() {
    if (cosClient) return cosClient;
    clientPromise ||= import('cos-nodejs-sdk-v5').then(({ default: COS }) => new COS({ SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY }));
    return clientPromise;
  }
  function checked(key) {
    if (!validMediaKey(key)) throw problem('invalid_media_key', '素材文件标识无效。', 400);
    return key;
  }
  async function invoke(method, params) {
    const cos = await client();
    return new Promise((resolve, reject) => cos[method](params, (error, result) => error ? reject(error) : resolve(result)));
  }
  async function localPath(key) {
    const path = join(root, ...checked(key).split('/'));
    await safeDirectory(dirname(path));
    return path;
  }
  const cloud = configured || Boolean(cosClient);
  return {
    mode: cloud ? 'cos' : 'local',
    async put(key, bytes) {
      checked(key);
      if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw problem('invalid_media', '素材内容无效。', 400);
      const body = Buffer.from(bytes);
      if (!body.length || body.length > MAX_FILE_BYTES) throw problem('invalid_media_size', '素材文件大小超出限制。', 400);
      if (cloud) {
        await invoke('putObject', { ...settings, Key: `restaurant/${key}`, Body: body, ACL: 'private', ContentType: contentType(key) });
      } else {
        const path = await localPath(key);
        await mkdir(dirname(path), { recursive: true });
        await safeDirectory(dirname(path));
        try { await safeFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
        let handle;
        try {
          handle = await open(temporary, 'wx', 0o600);
          await handle.writeFile(body); await handle.sync(); await handle.close(); handle = undefined;
          await rename(temporary, path);
        } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
      }
      return { key, size: body.length, createdAt: now() };
    },
    async get(key) {
      checked(key);
      if (cloud) {
        try {
          const result = await invoke('getObject', { ...settings, Key: `restaurant/${key}` });
          if (result?.Body === undefined) return null;
          const body = Buffer.from(result.Body);
          if (body.length > MAX_FILE_BYTES) throw problem('invalid_media_size', '素材文件大小超出限制。');
          return body;
        } catch (error) { if (error.statusCode === 404 || error.code === 'NoSuchKey') return null; throw error; }
      }
      const path = await localPath(key);
      try { await safeFile(path); return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async remove(key) {
      checked(key);
      if (cloud) {
        try { await invoke('deleteObject', { ...settings, Key: `restaurant/${key}` }); }
        catch (error) { if (error.statusCode !== 404 && error.code !== 'NoSuchKey') throw error; }
      } else {
        const path = await localPath(key);
        try { await safeFile(path); await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    },
  };
}
