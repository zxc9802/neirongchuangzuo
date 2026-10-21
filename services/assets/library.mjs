import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const hash = value => createHash('sha256').update(value).digest('hex');
const TYPES = { photo: { type: 'image', mime: 'image/jpeg', ext: 'jpg', name: '复刻形象' }, voice: { type: 'audio', mime: 'audio/wav', ext: 'wav', name: '参考声音' } };
const fail = (message, status = 503) => Object.assign(new Error(message), { status, code: 'ASSET_STORAGE_ERROR' });
const validId = id => /^(photo|voice)-[a-f0-9]{64}$/.test(id || '');

// A separate, private prefix has no application expiry or task-cleanup dependency.
export function createMaterialLibrary({ env = process.env, cosClient, now = Date.now } = {}) {
  const configured = Boolean(cosClient || env.COS_SECRET_ID && env.COS_SECRET_KEY && env.COS_BUCKET && env.COS_REGION);
  const settings = { Bucket: env.COS_BUCKET, Region: env.COS_REGION }, locks = new Map();
  let client;
  async function call(method, options) {
    if (!configured) throw fail('素材云存储尚未配置，请联系管理员配置 COS 后重试。');
    client ||= cosClient || import('cos-nodejs-sdk-v5').then(({ default: COS }) => new COS({ SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY, Timeout: 60000 }));
    const cos = await client;
    try { return await new Promise((resolve, reject) => cos[method]({ ...settings, ...options }, (error, result) => error ? reject(error) : resolve(result))); }
    catch (error) { if (error.statusCode === 404 || error.code === 'NoSuchKey') return null; throw fail('素材云存储暂时不可用，请重试。'); }
  }
  function prefix(userId) {
    if (typeof userId !== 'string' || !userId) throw fail('请先登录。', 401);
    return `workspace-assets/users/${hash(userId)}/`;
  }
  async function records(userId) {
    const result = await call('getObject', { Key: prefix(userId) + 'index.json' });
    if (!result) return [];
    try {
      const items = JSON.parse(Buffer.from(result.Body).toString('utf8'));
      if (!Array.isArray(items) || items.some(item => !validId(item.id) || !TYPES[item.kind] || !item.id.startsWith(item.kind + '-') || !Number.isFinite(item.createdAt))) throw new Error();
      return items;
    } catch { throw fail('素材索引暂时无法读取，请稍后重试。'); }
  }
  function view(item) {
    return { id: item.id, kind: item.kind, type: TYPES[item.kind].type, name: item.name, createdAt: item.createdAt,
      bytes: item.bytes, duration: item.metadata?.duration, permanent: true,
      url: `/api/assets/materials/${item.id}/media`, filename: `${item.name}.${TYPES[item.kind].ext}` };
  }
  return {
    configured,
    async list(userId) { return (await records(userId)).sort((a, b) => b.createdAt - a.createdAt).map(view); },
    async save(userId, { kind, path, name, metadata = {} }) {
      if (!TYPES[kind]) throw fail('素材类型无效。', 400);
      const bytes = await readFile(path);
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw fail('素材大小无效。', 400);
      const id = `${kind}-${hash(bytes)}`, base = prefix(userId);
      const previous = locks.get(userId) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const items = await records(userId), existing = items.find(item => item.id === id);
        if (existing) return view(existing);
        const title = String(name || TYPES[kind].name).replace(/\.[^.]+$/, '').replace(/[\\/\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || TYPES[kind].name;
        const item = { id, kind, name: title, bytes: bytes.length, createdAt: now(), metadata };
        const written = await call('putObject', { Key: base + `${id}.${TYPES[kind].ext}`, Body: bytes, ContentType: TYPES[kind].mime, ACL: 'private' });
        if (!written) throw fail('素材保存失败，请重试。');
        const indexed = await call('putObject', { Key: base + 'index.json', Body: JSON.stringify([...items, item]), ContentType: 'application/json', ACL: 'private' });
        if (!indexed) throw fail('素材索引保存失败，请重试。');
        return view(item);
      });
      locks.set(userId, operation);
      try { return await operation; } finally { if (locks.get(userId) === operation) locks.delete(userId); }
    },
    async get(userId, id) {
      if (!validId(id)) throw fail('素材不存在。', 404);
      const item = (await records(userId)).find(item => item.id === id);
      if (!item) throw fail('素材不存在。', 404);
      const result = await call('getObject', { Key: prefix(userId) + `${id}.${TYPES[item.kind].ext}` });
      if (!result) throw fail('素材不存在。', 404);
      const bytes = Buffer.from(result.Body);
      if (bytes.length !== item.bytes || hash(bytes) !== id.slice(item.kind.length + 1)) throw fail('素材内容校验失败，请稍后重试。');
      return { ...view(item), bytes, metadata: item.metadata, mime: TYPES[item.kind].mime };
    },
  };
}

export function createMaterialHandler({ library, archiveExisting }) {
  return async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify(value)); };
    try {
      const userId = req.authenticatedUserId;
      if (!userId) throw fail('请先登录。', 401);
      if (!['GET', 'HEAD'].includes(req.method)) throw fail('请求方式不受支持。', 405);
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/assets/materials' && req.method === 'GET') {
        if (!library.configured) { json(200, { materials: [], configured: false }); return; }
        await archiveExisting?.(userId);
        json(200, { materials: await library.list(userId), configured: true }); return;
      }
      const match = /^\/api\/assets\/materials\/((?:photo|voice)-[a-f0-9]{64})\/media$/.exec(url.pathname);
      if (!match) throw fail('素材不存在。', 404);
      const item = await library.get(userId, match[1]), size = item.bytes.length;
      let start = 0, end = size - 1;
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (range && (range[1] || range[2])) {
          start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
          end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        } else start = size;
        if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'private, no-store' }); res.end(); return;
        }
      }
      res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': item.mime, 'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(item.filename)}`,
        ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      res.end(req.method === 'HEAD' ? undefined : item.bytes.subarray(start, end + 1));
    } catch (error) { json(error.status || 503, { error: error.code === 'ASSET_STORAGE_ERROR' ? error.message : '素材暂时无法读取，请重试。' }); }
  };
}
