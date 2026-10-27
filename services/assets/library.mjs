import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePhoto, probeVideo, PHOTO_LIMIT, VIDEO_LIMIT } from '../video/media.mjs';
import { normalizeVoice, VOICE_LIMIT } from '../video/speech.mjs';
import { editFolders, assignMaterials } from './folders.mjs';
import { generatedSource, readGeneratedMedia } from './retain.mjs';
import { inspectAssetUpload } from './upload.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const TYPES = { photo: { type: 'image', mime: 'image/jpeg', ext: 'jpg', name: '图片素材' }, voice: { type: 'audio', mime: 'audio/wav', ext: 'wav', name: '参考声音' }, video: { type: 'video', mime: 'video/mp4', ext: 'mp4', name: '参考视频' } };
const fail = (message, status = 503) => Object.assign(new Error(message), { status, code: 'ASSET_STORAGE_ERROR' });
const validId = id => /^(photo|voice|video)-[a-f0-9]{64}$/.test(id || '');
const formats = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

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
      bytes: item.bytes, duration: item.metadata?.duration, permanent: true, origin: item.metadata?.origin, mime: item.mime || TYPES[item.kind].mime,
      url: `/api/assets/materials/${item.id}/media`, filename: `${item.name}.${item.ext || TYPES[item.kind].ext}` };
  }
  async function organization(userId) {
    const result = await call('getObject', { Key: prefix(userId) + 'organization.json' });
    if (!result) return { order: [], deleted: [] };
    try {
      const data = JSON.parse(Buffer.from(result.Body).toString('utf8'));
      if (!Array.isArray(data.order) || !Array.isArray(data.deleted) || [...data.order, ...data.deleted].some(key => !assetKey(key))) throw new Error();
      return data;
    } catch { throw fail('资产排列记录无法读取，请刷新重试。'); }
  }
  const assetKey = key => typeof key === 'string' && key.length <= 220 && /^(?:material:(?:photo|voice|video)-[a-f0-9]{64}|(?:image|avatar|restaurant|video|creative-video):[a-zA-Z0-9_.:-]+)$/.test(key);
  async function writeOrganization(userId, data) {
    const saved = await call('putObject', { Key: prefix(userId) + 'organization.json', Body: JSON.stringify(data), ContentType: 'application/json', ACL: 'private' });
    if (!saved) throw fail('资产整理保存失败，请重试。');
    return data;
  }
  async function folders(userId, input) {
    if (!input || !['folder-create', 'folder-rename', 'folder-move', 'folder-delete', 'assign'].includes(input.action)) throw fail('文件夹操作无效。', 400);
    const previous = locks.get(userId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const data = await organization(userId), items = await records(userId);
      if (input.action === 'assign') assignMaterials(data, input.ids, input.folderId, input.type, items);
      else editFolders(data, input, items);
      return writeOrganization(userId, data);
    });
    locks.set(userId, operation);
    try { return await operation; } finally { if (locks.get(userId) === operation) locks.delete(userId); }
  }
  async function organize(userId, input) {
    if (!input || !['delete', 'restore', 'move'].includes(input.action) || !Array.isArray(input.keys) || !input.keys.length || input.keys.length > 500 || input.keys.some(key => !assetKey(key))) throw fail('资产操作参数无效。', 400);
    if (input.action === 'move' && (!assetKey(input.target) || !['before', 'after'].includes(input.position) || input.keys.includes(input.target))) throw fail('排列位置无效。', 400);
    if (input.order !== undefined && (!Array.isArray(input.order) || input.order.length > 5000 || input.order.some(key => !assetKey(key)))) throw fail('排列记录无效。', 400);
    const previous = locks.get(userId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const data = await organization(userId), keys = [...new Set(input.keys)];
      const ownMaterials = new Set((await records(userId)).map(item => `material:${item.id}`));
      if ([...keys, ...(input.target ? [input.target] : [])].some(key => key.startsWith('material:') && !ownMaterials.has(key))) throw fail('素材不存在。', 404);
      if (input.action === 'delete') data.deleted = [...new Set([...data.deleted, ...keys])];
      else if (input.action === 'restore') data.deleted = data.deleted.filter(key => !keys.includes(key));
      else {
        // Merge a relative move rather than overwriting another tab's entire ordering.
        const order = [...new Set([...data.order, ...(input.order || [])])].filter(key => !keys.includes(key));
        if (!order.includes(input.target)) order.push(input.target);
        const index = order.indexOf(input.target) + (input.position === 'after' ? 1 : 0);
        order.splice(index, 0, ...keys); data.order = order;
      }
      if (data.order.length + data.deleted.length > 20000) throw fail('资产整理记录过多，请联系管理员。', 409);
      const saved = await call('putObject', { Key: prefix(userId) + 'organization.json', Body: JSON.stringify(data), ContentType: 'application/json', ACL: 'private' });
      if (!saved) throw fail('资产整理保存失败，请重试。');
      return data;
    });
    locks.set(userId, operation);
    try { return await operation; } finally { if (locks.get(userId) === operation) locks.delete(userId); }
  }
  return {
    configured,
    organization, organize, folders,
    async rename(userId, { id, name } = {}) {
      if (!validId(id)) throw fail('素材不存在。', 404);
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\\/<>:"|?*\u0000-\u001f\u007f]/.test(name)) throw fail('请输入1—80个字符的素材名称，不含文件路径或特殊符号。', 400);
      const previous = locks.get(userId) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const items = await records(userId), item = items.find(item => item.id === id);
        if (!item) throw fail('素材不存在。', 404);
        item.name = name.trim();
        const saved = await call('putObject', { Key: prefix(userId) + 'index.json', Body: JSON.stringify(items), ContentType: 'application/json', ACL: 'private' });
        if (!saved) throw fail('素材名称保存失败，请重试。');
        return view(item);
      });
      locks.set(userId, operation);
      try { return await operation; } finally { if (locks.get(userId) === operation) locks.delete(userId); }
    },
    async list(userId, { includeDeleted = false } = {}) {
      const data = await organization(userId);
      return (await records(userId)).filter(item => includeDeleted || !data.deleted.includes(`material:${item.id}`))
        .sort((a, b) => b.createdAt - a.createdAt).map(view);
    },
    async save(userId, { kind, path, name, metadata = {}, mime, placement }) {
      if (!TYPES[kind]) throw fail('素材类型无效。', 400);
      const bytes = await readFile(path);
      if (!bytes.length || bytes.length > (kind === 'video' ? VIDEO_LIMIT : 50 * 1024 * 1024)) throw fail('素材大小无效。', 400);
      mime ||= TYPES[kind].mime;
      if (!formats[mime] || !mime.startsWith(TYPES[kind].type + '/')) throw fail('素材格式无效。', 400);
      const id = `${kind}-${hash(bytes)}`, base = prefix(userId);
      const previous = locks.get(userId) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const items = await records(userId), existing = items.find(item => item.id === id);
        let data;
        if (placement) {
          data = await organization(userId);
          assignMaterials(data, [id], placement.folderId, TYPES[kind].type, [...items.filter(item => item.id !== id), { id, kind }]);
          data.deleted = data.deleted.filter(key => key !== `material:${id}`);
          if (placement.sourceKey) {
            if (!assetKey(placement.sourceKey) || placement.sourceKey.startsWith('material:')) throw fail('成品来源无效。', 400);
            data.retained = { ...data.retained, [placement.sourceKey]: id };
          }
        }
        if (existing) { if (data) await writeOrganization(userId, data); return view(existing); }
        const title = String(name || TYPES[kind].name).replace(/\.[^.]+$/, '').replace(/[\\/\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || TYPES[kind].name;
        const item = { id, kind, name: title, bytes: bytes.length, createdAt: now(), metadata, mime, ext: formats[mime] };
        const written = await call('putObject', { Key: base + `${id}.${item.ext}`, Body: bytes, ContentType: mime, ACL: 'private' });
        if (!written) throw fail('素材保存失败，请重试。');
        const indexed = await call('putObject', { Key: base + 'index.json', Body: JSON.stringify([...items, item]), ContentType: 'application/json', ACL: 'private' });
        if (!indexed) throw fail('素材索引保存失败，请重试。');
        if (data) await writeOrganization(userId, data);
        return view(item);
      });
      locks.set(userId, operation);
      try { return await operation; } finally { if (locks.get(userId) === operation) locks.delete(userId); }
    },
    async get(userId, id) {
      if (!validId(id)) throw fail('素材不存在。', 404);
      const item = (await records(userId)).find(item => item.id === id);
      if (!item) throw fail('素材不存在。', 404);
      const result = await call('getObject', { Key: prefix(userId) + `${id}.${item.ext || TYPES[item.kind].ext}` });
      if (!result) throw fail('素材不存在。', 404);
      const bytes = Buffer.from(result.Body);
      if (bytes.length !== item.bytes || hash(bytes) !== id.slice(item.kind.length + 1)) throw fail('素材内容校验失败，请稍后重试。');
      return { ...view(item), bytes, metadata: item.metadata, mime: item.mime || TYPES[item.kind].mime };
    },
  };
}

async function uploadBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw fail('素材文件过大。', 413);
  let size = 0; const chunks = [];
  const timer = setTimeout(() => req.destroy(), 120_000);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw fail('素材文件过大。', 413);
      chunks.push(chunk);
    }
    if (!size) throw fail('请选择素材文件。', 400);
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}

export function createMaterialHandler({ library, archiveExisting, readGenerated = readGeneratedMedia, photo = normalizePhoto, voice = normalizeVoice, probe = probeVideo }) {
  return async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify(value)); };
    try {
      const userId = req.authenticatedUserId;
      if (!userId) throw fail('请先登录。', 401);
      const url = new URL(req.url, 'http://localhost');
      if (['/api/assets/materials/folders', '/api/assets/materials/retain', '/api/assets/materials/rename'].includes(url.pathname) && req.method === 'POST') {
        let input;
        try { input = JSON.parse((await uploadBody(req, 128 * 1024)).toString('utf8')); } catch (error) { if (error.status) throw error; throw fail('资产操作参数无效。', 400); }
        if (url.pathname.endsWith('/folders')) { json(200, { organization: await library.folders(userId, input) }); return; }
        if (url.pathname.endsWith('/rename')) {
          if (!input || typeof input !== 'object') throw fail('资产操作参数无效。', 400);
          json(200, { material: await library.rename(userId, input), organization: await library.organization(userId) }); return;
        }
        const source = generatedSource(input);
        const directory = await mkdtemp(join(tmpdir(), 'qiya-retain-'));
        try {
          const data = await readGenerated(req, source), path = join(directory, 'output');
          if (data.mime.split('/')[0] !== source.type) throw fail('成品格式与目标文件夹不一致。', 400);
          await writeFile(path, data.bytes, { mode: 0o600 });
          const material = await library.save(userId, { kind: source.kind, path, name: input.name, mime: data.mime,
            metadata: { origin: 'generated', sourceKey: input.key }, placement: { folderId: input.folderId, sourceKey: input.key } });
          json(201, { material, organization: await library.organization(userId) }); return;
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
      if (url.pathname === '/api/assets/materials/organization' && req.method === 'POST') {
        let input;
        try { input = JSON.parse((await uploadBody(req, 128 * 1024)).toString('utf8')); }
        catch (error) { if (error.status) throw error; throw fail('资产操作参数无效。', 400); }
        json(200, { organization: await library.organize(userId, input) }); return;
      }
      const directUpload = /^\/api\/assets\/materials\/upload\/(photo|voice|video)$/.exec(url.pathname);
      const upload = directUpload || /^\/api\/assets\/materials\/(photo|voice|video)$/.exec(url.pathname);
      if (upload && req.method === 'POST') {
        if (!library.configured) throw fail('素材云存储尚未配置，请联系管理员配置 COS 后重试。');
        const kind = upload[1], bytes = await uploadBody(req, kind === 'video' ? VIDEO_LIMIT : directUpload ? 50 * 1024 * 1024 - 1 : kind === 'voice' ? VOICE_LIMIT : PHOTO_LIMIT);
        let name;
        try { name = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { throw fail('素材文件名无效。', 400); }
        const directory = await mkdtemp(join(tmpdir(), 'qiya-asset-upload-'));
        try {
          const input = join(directory, 'input'), output = join(directory, 'normalized.wav');
          if (directUpload) {
            await writeFile(input, bytes, { mode: 0o600 });
            const inspected = await inspectAssetUpload(kind, bytes, input, probe);
            const material = await library.save(userId, { kind, path: input, name, mime: inspected.mime,
              metadata: { ...inspected.metadata, origin: 'library-upload' }, placement: { folderId: url.searchParams.get('folderId') || null } });
            json(201, { material, organization: await library.organization(userId) }); return;
          }
          await writeFile(input, kind === 'photo' ? await photo(bytes) : bytes, { mode: 0o600 });
          let metadata = {};
          if (kind === 'voice') metadata = await voice(input, output);
          if (kind === 'video') {
            if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw fail('请上传 MP4 或 MOV 视频。', 400);
            metadata = await probe(input);
          }
          const material = await library.save(userId, { kind, path: kind === 'voice' ? output : input, name, metadata });
          json(201, { material }); return;
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw fail('请求方式不受支持。', 405);
      if (url.pathname === '/api/assets/materials' && req.method === 'GET') {
        if (!library.configured) { json(200, { materials: [], configured: false }); return; }
        await archiveExisting?.(userId);
        const organization = await library.organization(userId), allMaterials = await library.list(userId, { includeDeleted: true });
        json(200, { materials: allMaterials.filter(item => !organization.deleted.includes(`material:${item.id}`)), allMaterials, organization, configured: true }); return;
      }
      const match = /^\/api\/assets\/materials\/((?:photo|voice|video)-[a-f0-9]{64})\/media$/.exec(url.pathname);
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
    } catch (error) { json(error.status || 503, { error: error.code === 'ASSET_STORAGE_ERROR' || error.status === 400 ? error.message : '素材暂时无法读取，请重试。' }); }
  };
}
