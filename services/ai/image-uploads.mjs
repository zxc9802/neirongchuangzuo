import { mkdir, lstat, realpath, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const SOURCE = /^source-(?:0[1-9]|[12]\d|30)\.(?:png|jpg|webp)$/;
const TTL = 72 * 60 * 60 * 1000, MAX_BYTES = 60 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ownerKey = userId => digest(userId == null ? 'local-preview' : `account:${userId}`);
const problem = (message, status = 400, code = 'UPLOAD_INVALID') => Object.assign(new Error(message), { status, code });

/** Private, resumable upload pools. No provider requests or quota reservations. */
export function createImageUploads({ storageDir, now = Date.now, cleanupIntervalMs = 60_000, logger = console } = {}) {
  const root = resolve(storageDir, '.image-uploads');
  const operations = new Map();
  let canonicalRoot, timer, disposed = false;
  const ready = (async () => {
    await mkdir(root, { recursive: true });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('原图存储暂时不可用。', 503, 'UPLOAD_STORAGE_FAILED');
    canonicalRoot = await realpath(root);
  })();
  ready.catch(() => {});
  const inside = path => {
    const suffix = relative(canonicalRoot, path);
    return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  };
  async function directory(id, create = false) {
    await ready;
    if (!UUID.test(id || '')) throw problem('原图上传标识无效。');
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || await realpath(root) !== canonicalRoot) throw problem('原图存储暂时不可用。', 503, 'UPLOAD_STORAGE_FAILED');
    const path = join(root, id);
    if (create) await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(await realpath(path))) throw problem('原图存储暂时不可用。', 503, 'UPLOAD_STORAGE_FAILED');
    return path;
  }
  async function ordinary(path, maximum = 8 * 1024 * 1024) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum || !inside(await realpath(path))) throw problem('原图存储暂时不可用。', 503, 'UPLOAD_STORAGE_FAILED');
    return stat;
  }
  async function readSession(id) {
    try {
      const path = join(await directory(id), 'upload.json');
      await ordinary(path, 128 * 1024);
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.id !== id || !/^[a-f\d]{64}$/.test(value.owner) || !Number.isInteger(value.imageCount) || value.imageCount < 1 || value.imageCount > 30
        || !Array.isArray(value.images) || value.images.length > value.imageCount || !Array.isArray(value.batches) || !Number.isFinite(Date.parse(value.expiresAt))
        || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || value.totalBytes > MAX_BYTES
        || value.images.some((image, index) => !image || !['png', 'jpg', 'webp'].includes(image.ext) || image.mime !== ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' })[image.ext]
          || image.filename !== `source-${String(index + 1).padStart(2, '0')}.${image.ext}` || !/^[a-f\d]{64}$/.test(image.sha256) || !Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > 8 * 1024 * 1024)
        || value.images.reduce((sum, image) => sum + image.bytes, 0) !== value.totalBytes
        || value.batches.some((batch, index) => !Number.isInteger(batch.startIndex) || batch.startIndex !== value.batches.slice(0, index).reduce((sum, item) => sum + item.count, 0)
          || !Number.isInteger(batch.count) || batch.count < 1 || batch.count > 3 || !/^[a-f\d]{64}$/.test(batch.fingerprint))
        || value.batches.reduce((sum, batch) => sum + batch.count, 0) !== value.images.length) throw new Error('Invalid upload metadata');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') throw problem('未找到这次原图上传。', 404, 'UPLOAD_NOT_FOUND');
      if (error.code?.startsWith('UPLOAD_')) throw error;
      throw problem('原图上传记录无法读取，请联系管理员。', 503, 'UPLOAD_STORAGE_FAILED');
    }
  }
  async function save(session) {
    const dir = await directory(session.id), path = join(dir, 'upload.json'), temp = join(dir, `upload-${randomUUID()}.tmp`);
    try {
      try { await ordinary(path, 128 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await writeFile(temp, JSON.stringify(session), { flag: 'wx', mode: 0o600 });
      await directory(session.id); await rename(temp, path);
    } catch (error) { throw problem('原图上传记录无法保存，请联系管理员。', 503, 'UPLOAD_STORAGE_FAILED'); }
    finally { await unlink(temp).catch(() => {}); }
  }
  function serial(id, operation) {
    const next = (operations.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      await ready;
      if (disposed) throw problem('原图服务正在重启，请稍后核对上传进度。', 503, 'UPLOAD_CLOSING');
      return operation();
    });
    operations.set(id, next);
    next.finally(() => { if (operations.get(id) === next) operations.delete(id); }).catch(() => {});
    return next;
  }
  function checkOwner(session, userId) {
    if (session.owner !== ownerKey(userId)) throw problem('未找到这次原图上传。', 404, 'UPLOAD_NOT_FOUND');
    if (session.expired || Date.parse(session.expiresAt) <= now()) throw problem('这组原图已超过3天保留期，请重新上传。', 410, 'UPLOAD_EXPIRED');
  }
  function publicSession(session) {
    const expired = session.expired || Date.parse(session.expiresAt) <= now();
    return { id: session.id, requestId: session.id, imageCount: session.imageCount, uploadedCount: session.images.length,
      nextIndex: session.images.length, complete: !expired && session.images.length === session.imageCount,
      totalBytes: session.totalBytes, expiresAt: session.expiresAt, status: expired ? 'expired' : session.images.length === session.imageCount ? 'ready' : 'uploading' };
  }
  function init(id, imageCount, userId) {
    return serial(id, async () => {
      if (!UUID.test(id || '') || !Number.isInteger(imageCount) || imageCount < 1 || imageCount > 30) throw problem('每次上传需要1—30张原图。');
      let session;
      try { session = await readSession(id); } catch (error) { if (error.code !== 'UPLOAD_NOT_FOUND') throw error; }
      if (session) {
        checkOwner(session, userId);
        if (session.imageCount !== imageCount) throw problem('这次上传的原图数量已经确定，请查询原进度。', 409, 'UPLOAD_CONFLICT');
      } else {
        await directory(id, true);
        session = { id, owner: ownerKey(userId), imageCount, images: [], batches: [], totalBytes: 0, createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + TTL).toISOString() };
        await save(session);
      }
      return publicSession(session);
    });
  }
  function get(id, userId) { return serial(id, async () => { const session = await readSession(id); checkOwner(session, userId); return publicSession(session); }); }
  function append(id, startIndex, images, userId) {
    return serial(id, async () => {
      const session = await readSession(id); checkOwner(session, userId);
      if (!Number.isInteger(startIndex) || startIndex < 0 || !Array.isArray(images) || images.length < 1 || images.length > 3 || startIndex + images.length > session.imageCount) throw problem('每批请按顺序上传1—3张原图。');
      if (images.some(image => !Buffer.isBuffer(image?.bytes) || !['png', 'jpg', 'webp'].includes(image.ext) || image.mime !== ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' })[image.ext])) throw problem('原图格式不支持。');
      const records = images.map(image => ({ sha256: digest(image.bytes), mime: image.mime, ext: image.ext, bytes: image.bytes.length, name: String(image.originalName || '').slice(0, 160) }));
      const fingerprint = digest(JSON.stringify(records));
      if (startIndex < session.images.length) {
        const existing = session.batches.find(batch => batch.startIndex === startIndex);
        if (!existing || existing.count !== images.length || existing.fingerprint !== fingerprint) throw problem('该批原图已上传，内容不同，请核对原进度。', 409, 'UPLOAD_CONFLICT');
        return publicSession(session);
      }
      if (startIndex !== session.images.length) throw problem('请从已上传进度继续，不能跳过原图。', 409, 'UPLOAD_ORDER');
      const batchBytes = records.reduce((sum, item) => sum + item.bytes, 0);
      if (batchBytes > 24 * 1024 * 1024 || records.some(item => item.bytes < 1 || item.bytes > 8 * 1024 * 1024) || session.totalBytes + batchBytes > MAX_BYTES) throw problem('单张原图最多8MB，每批最多24MB，全部原图最多60MB。', 413, 'UPLOAD_TOO_LARGE');
      const dir = await directory(id);
      for (const [offset, image] of images.entries()) {
        const filename = `source-${String(startIndex + offset + 1).padStart(2, '0')}.${image.ext}`, path = join(dir, filename);
        try {
          await writeFile(path, image.bytes, { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if (error.code !== 'EEXIST') throw problem('原图无法保存，请联系管理员。', 503, 'UPLOAD_STORAGE_FAILED');
          await ordinary(path);
          // Recover a batch interrupted before its metadata commit. Committed
          // batches were handled above and can never be overwritten here.
          if (digest(await readFile(path)) !== records[offset].sha256) { await unlink(path); await writeFile(path, image.bytes, { flag: 'wx', mode: 0o600 }); }
        }
        session.images.push({ ...records[offset], filename });
      }
      session.totalBytes += batchBytes;
      session.batches.push({ startIndex, count: images.length, fingerprint });
      await save(session);
      return publicSession(session);
    });
  }
  function images(id, userId) {
    return serial(id, async () => {
      const session = await readSession(id); checkOwner(session, userId);
      if (session.images.length !== session.imageCount) throw problem('原图尚未上传完整，请继续上传后再生成。', 400, 'UPLOAD_INCOMPLETE');
      const dir = await directory(id), output = [];
      for (const [index, record] of session.images.entries()) {
        if (!SOURCE.test(record.filename)) throw problem('原图记录无法读取。', 503, 'UPLOAD_STORAGE_FAILED');
        const path = join(dir, record.filename); await ordinary(path);
        const bytes = await readFile(path);
        if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) throw problem('原图内容无法核对，请重新上传。', 503, 'UPLOAD_STORAGE_FAILED');
        output.push({ bytes, mime: record.mime, ext: record.ext, name: `reference-${index + 1}.${record.ext}` });
      }
      return output;
    });
  }
  async function sweep() {
    await ready;
    if (disposed) return;
    for (const id of await readdir(root)) {
      if (!UUID.test(id)) continue;
      await serial(id, async () => {
        let session;
        try { session = await readSession(id); } catch {
          // If metadata was lost, only aged files from this fixed original-file
          // namespace may be cleaned. Unknown files remain untouched.
          const dir = await directory(id);
          for (const filename of await readdir(dir)) {
            if (!SOURCE.test(filename)) continue;
            const path = join(dir, filename), stat = await ordinary(path);
            if (stat.mtimeMs + TTL <= now()) await unlink(path);
          }
          return;
        }
        if (Date.parse(session.expiresAt) > now() && !session.expired) return;
        if (!session.expired) { session.expired = true; session.images = []; session.batches = []; session.totalBytes = 0; await save(session); }
        const dir = await directory(id);
        for (const filename of await readdir(dir)) {
          if (!SOURCE.test(filename)) continue;
          const path = join(dir, filename); await ordinary(path); await unlink(path);
        }
      }).catch(() => { try { logger.warn?.({ event: 'ai_upload_cleanup_pending' }); } catch {} });
    }
  }
  async function start() {
    await sweep();
    timer = setInterval(() => { void sweep().catch(() => {}); }, Math.max(1, cleanupIntervalMs)); timer.unref?.();
  }
  async function dispose() { clearInterval(timer); await Promise.allSettled([...operations.values()]); disposed = true; }
  return { ready, init, get, append, images, sweep, start, dispose };
}
