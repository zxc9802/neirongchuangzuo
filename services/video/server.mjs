import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRequestLedger } from '../ai/request-ledger.mjs';
import { calculateCredits } from '../credits/store.mjs';
import { createVideoProvider, videoConfig, VideoError, MODEL, DURATIONS, PROMPT } from './provider.mjs';
import { VIDEO_LIMIT, PHOTO_LIMIT, probeVideo, normalizePhoto, downloadVideo, serveMedia } from './media.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PREFIX = '/api/video-replica';
const DAY = 86400_000;
const ACTIVE = new Set(['reserving', 'reviewing', 'submitting', 'running', 'downloading']);
const RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const error = (message, status = 400, code) => new VideoError(message, status, code);
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify(value)); };
export const isVideoSourcePath = path => /^\/api\/video-replica\/source\/[a-f0-9-]{36}\/(video|photo)$/.test(path);

async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw error('文件过大，请压缩后重试。', 413, 'VIDEO_UPLOAD_TOO_LARGE');
  const chunks = []; let size = 0;
  const timer = setTimeout(() => req.destroy(), 120_000);
  try {
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw error('文件过大，请压缩后重试。', 413, 'VIDEO_UPLOAD_TOO_LARGE'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}
async function readJSON(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw error('请求格式无效。');
  try { return JSON.parse((await readBody(req, 4096)).toString()); }
  catch (cause) { if (cause instanceof VideoError) throw cause; throw error('请求格式无效。'); }
}

export function createVideoHandler({ storageDir, env = process.env, publicOrigin, credits,
  config = videoConfig(env, publicOrigin), provider = createVideoProvider(config), probe = probeVideo,
  photo = normalizePhoto, download = downloadVideo, now = Date.now, pollIntervalMs = 5000 } = {}) {
  const jobs = new Map(), locks = new Map();
  // Share the existing durable single-writer lock implementation, in a separate directory.
  const instance = createRequestLedger({ storageDir });
  let closing = false, fatal = false, timer, ticking, shutdownPromise;
  const folder = task => join(storageDir, task.id);
  const file = (task, kind) => join(folder(task), kind === 'photo' ? 'photo.jpg' : kind === 'video' ? 'source.mp4' : 'result.mp4');
  function serialize(key, action) {
    const pending = (locks.get(key) || Promise.resolve()).catch(() => {}).then(action);
    locks.set(key, pending);
    pending.finally(() => { if (locks.get(key) === pending) locks.delete(key); }).catch(() => {});
    return pending;
  }
  async function save(task) {
    try {
      await mkdir(folder(task), { recursive: true });
      const temporary = join(folder(task), 'task.json.tmp');
      await writeFile(temporary, JSON.stringify(task), { mode: 0o600 });
      await rename(temporary, join(folder(task), 'task.json'));
    } catch { fatal = true; throw error('任务存储暂时不可用，已暂停新的生成。', 503, 'VIDEO_STORAGE_UNAVAILABLE'); }
  }
  function view(task) {
    const settled = !credits || task.billing?.status === 'settled';
    const expired = task.expiresAt <= now();
    return { id: task.id, kind: 'video', status: expired ? 'expired' : task.status === 'completed' && !settled ? 'settling' : task.status,
      createdAt: task.createdAt, completedAt: task.completedAt, expiresAt: task.expiresAt, duration: task.duration, actualDuration: task.actualDuration,
      ratio: task.ratio, video: task.video, photo: task.photo, error: task.error || '', code: task.code,
      sourceVideoUrl: !expired && task.video ? `${PREFIX}/tasks/${task.id}/video` : null,
      sourcePhotoUrl: !expired && task.photo ? `${PREFIX}/tasks/${task.id}/photo` : null,
      estimatedPoints: task.duration ? calculateCredits('video', task.duration) : null,
      billing: task.billing && { source: 'workspace', status: task.billing.status, reservedPoints: task.billing.reservedPoints, chargedPoints: task.billing.chargedPoints },
      resultUrl: !expired && task.status === 'completed' && settled ? `${PREFIX}/tasks/${task.id}/result` : null };
  }
  async function reconcile(task) {
    if (!credits || !['completed', 'failed', 'expired'].includes(task.status) || ['settled', 'released'].includes(task.billing?.status)) return;
    try {
      let record = await credits.reservation(task.userId, task.id);
      if (record?.status === 'reserved') record = task.status === 'completed'
        ? await credits.settle({ userId: task.userId, taskId: task.id, units: Math.min(task.duration, task.actualDuration) })
        : await credits.release({ userId: task.userId, taskId: task.id });
      task.billing = record ? { status: record.status, reservedPoints: record.reservedPoints, chargedPoints: record.chargedPoints }
        : { status: 'released', reservedPoints: 0, chargedPoints: 0 };
    } catch { task.billing = { ...task.billing, status: task.status === 'completed' ? 'settle_pending' : 'release_pending' }; }
    await save(task);
  }
  async function fail(task, message, code) {
    task.status = 'failed'; task.error = message; task.code = code;
    await save(task); await reconcile(task);
  }
  function signature(id, kind, expires) {
    return createHmac('sha256', config.signingSecret).update(`${id}:${kind}:${expires}`).digest('hex');
  }
  function sourceUrl(task, kind) {
    const expires = task.startedAt + DAY;
    return `${config.publicOrigin}${PREFIX}/source/${task.id}/${kind}?expires=${expires}&signature=${signature(task.id, kind, expires)}`;
  }
  async function acceptResult(task, result) {
    if (result.failed) { await fail(task, '视频生成失败，预留积分将退回。请检查参考素材后重新创建任务。', 'VIDEO_GENERATION_FAILED'); return; }
    if (result.taskId) task.providerId = result.taskId;
    if (result.url) { task.resultSource = result.url; task.status = 'downloading'; }
    else if (task.providerId) task.status = 'running';
    else { await fail(task, '模型未返回任务编号，未自动重试。请核对模型服务记录后再创建任务。', 'VIDEO_SUBMISSION_UNCERTAIN'); return; }
    task.error = ''; delete task.code; await save(task);
  }
  async function processTask(task) {
    if (closing || fatal) return;
    if (task.expiresAt <= now()) {
      if (task.status !== 'expired') {
        task.status = 'expired'; task.error = '素材和成片已超过保存期限。'; task.code = 'VIDEO_EXPIRED'; await save(task);
      }
      await reconcile(task);
      if (!task.cleaned) {
        for (const name of ['photo.jpg', 'source.mp4', 'result.mp4', 'upload.tmp', 'result.tmp']) await rm(join(folder(task), name), { force: true });
        task.cleaned = true; await save(task);
      }
      return;
    }
    if (['completed', 'failed', 'expired'].includes(task.status)) { await reconcile(task); return; }
    if (!ACTIVE.has(task.status)) return;
    if (now() - task.startedAt > DAY) { await fail(task, '模型任务超时，预留积分将退回。未自动重新生成。', 'VIDEO_TIMEOUT'); return; }
    if (task.status === 'reviewing') {
      if (now() - task.startedAt > 180_000) { await fail(task, '素材审核超时，请检查人物照片和参考视频后重试。', 'VIDEO_REVIEW_TIMEOUT'); return; }
      for (const kind of ['photo', 'video']) {
        if (!task.materials[kind]) { task.materials[kind] = await provider.createMaterial(sourceUrl(task, kind), kind); await save(task); }
        const material = task.materials[kind];
        if (material.status !== 2) material.status = await provider.queryMaterial(material.id);
        if (material.status === 3) { await fail(task, `${kind === 'photo' ? '人物照片' : '参考视频'}未通过素材审核，请更换清晰、符合要求的素材。`, 'VIDEO_REVIEW_REJECTED'); return; }
        await save(task);
      }
      if (Object.values(task.materials).some(value => value.status !== 2)) return;
      // Persist the dispatch boundary before making the paid call. Never replay it after a restart.
      task.status = 'submitting'; await save(task);
      try { await acceptResult(task, await provider.generate(task)); }
      catch (cause) {
        if (fatal) throw cause;
        await fail(task, '提交未获得确认，未自动重复生成。请核对模型服务记录后再创建任务，预留积分将退回。', 'VIDEO_SUBMISSION_UNCERTAIN');
      }
    } else if (task.status === 'running') await acceptResult(task, await provider.query(task.providerId));
    if (task.status === 'downloading') {
      const temporary = join(folder(task), 'result.tmp');
      await download(task.resultSource, temporary);
      const metadata = await probe(temporary);
      if (metadata.duration > task.duration + 1 || metadata.duration < 1 || !metadata.audio) throw error('成片缺少声音或时长不符合要求，预留积分将退回。', 502, 'VIDEO_RESULT_INVALID');
      await rename(temporary, file(task, 'result'));
      task.actualDuration = Math.round(metadata.duration * 1000) / 1000;
      task.status = 'completed'; task.error = ''; delete task.code;
      task.completedAt = now();
      task.expiresAt = now() + 3 * DAY;
      await save(task); await reconcile(task);
    }
  }
  async function tick() {
    if (ticking || closing || fatal) return;
    ticking = Promise.all([...jobs.values()].map(task => serialize(task.id, async () => {
      try { await processTask(task); }
      catch (cause) {
        if (fatal) return;
        if (task.status === 'reviewing' && cause instanceof VideoError && ['VIDEO_PROVIDER_IP_DENIED', 'VIDEO_PROVIDER_REJECTED', 'VIDEO_MATERIAL_INVALID'].includes(cause.code)) {
          await fail(task, cause.message, cause.code); return;
        }
        if (cause.code === 'VIDEO_RESULT_INVALID') { await fail(task, cause.message, cause.code); return; }
        // Queries and result downloads can be retried without another paid generation call.
        task.error = task.status === 'downloading' ? '成片正在保存，将自动重试下载。' : '模型服务暂时不可用，正在查询原任务。';
        task.code = 'VIDEO_QUERY_PENDING'; await save(task);
      }
    })));
    try { await ticking; } finally { ticking = null; }
  }
  const ready = (async () => {
    await instance.ready;
    for (const entry of await readdir(storageDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const task = JSON.parse(await readFile(join(storageDir, entry.name, 'task.json'), 'utf8'));
      if (task.id !== entry.name || typeof task.userId !== 'string') throw new Error('Invalid video task');
      jobs.set(task.id, task);
      if (['reserving', 'submitting'].includes(task.status)) {
        await fail(task, '服务重启中断了提交确认，未自动重新生成。预留积分将退回，请核对原任务后重试。', 'VIDEO_INTERRUPTED');
      }
    }
    timer = setInterval(() => { void tick().catch(() => { fatal = true; }); }, pollIntervalMs); timer.unref();
  })();
  ready.catch(() => { fatal = true; });
  const handler = async (req, res) => {
    try {
      await ready;
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      const source = /^\/api\/video-replica\/source\/([a-f0-9-]{36})\/(video|photo)$/.exec(path);
      if (source) {
        const task = jobs.get(source[1]), expires = Number(url.searchParams.get('expires')), supplied = url.searchParams.get('signature') || '';
        const valid = config.signingSecret && /^\d{13}$/.test(url.searchParams.get('expires') || '') && /^[a-f0-9]{64}$/.test(supplied)
          && timingSafeEqual(Buffer.from(supplied), Buffer.from(signature(source[1], source[2], expires)));
        if (!['GET', 'HEAD'].includes(req.method) || !task || !valid || expires <= now() || expires !== task.startedAt + DAY || task.status === 'expired') throw error('素材链接不可用或已过期。', 403, 'VIDEO_SOURCE_FORBIDDEN');
        await serveMedia(req, res, file(task, source[2]), source[2] === 'photo' ? 'image/jpeg' : 'video/mp4'); return;
      }
      const userId = req.authenticatedUserId;
      if (!userId) throw error('请先登录后继续。', 401, 'UNAUTHENTICATED');
      if (!['GET', 'HEAD'].includes(req.method)) {
        const expected = publicOrigin ? new URL(publicOrigin).origin : `http://${req.headers.host}`;
        if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && req.headers.origin !== expected) throw error('请求来源无效。', 403, 'VIDEO_ORIGIN_REJECTED');
        if (closing || fatal) throw error('视频服务暂时不可用，请稍后查询原任务。', 503, 'VIDEO_UNAVAILABLE');
      }
      if (path === `${PREFIX}/config` && req.method === 'GET') { json(res, 200, { enabled: config.enabled, model: MODEL, prompt: PROMPT, durations: DURATIONS, videoLimit: VIDEO_LIMIT, photoLimit: PHOTO_LIMIT }); return; }
      if (path === `${PREFIX}/tasks` && req.method === 'GET') {
        const tasks = [...jobs.values()].filter(task => task.userId === userId).sort((a, b) => b.createdAt - a.createdAt).map(view);
        json(res, 200, { tasks: url.searchParams.get('completed') === 'true' ? tasks.filter(task => task.status === 'completed') : tasks.slice(0, 50) }); return;
      }
      if (path === `${PREFIX}/tasks` && req.method === 'POST') {
        if (!config.enabled) throw error('人物复刻服务尚未配置，请联系管理员。', 503, 'VIDEO_NOT_CONFIGURED');
        const body = await readJSON(req);
        if (!UUID.test(body?.requestId)) throw error('任务编号无效。');
        await serialize('create', async () => {
          const existing = jobs.get(body.requestId);
          if (existing) { if (existing.userId !== userId) throw error('任务不存在。', 404); json(res, 200, { task: view(existing) }); return; }
          const drafts = [...jobs.values()].filter(task => task.userId === userId && task.status === 'draft' && task.expiresAt > now());
          if (drafts.length >= 5) throw error('尚有未提交的素材，请先完成现有任务。', 429, 'VIDEO_DRAFT_LIMIT');
          const task = { id: body.requestId, userId, status: 'draft', createdAt: now(), expiresAt: now() + DAY, materials: {} };
          await save(task); jobs.set(task.id, task); json(res, 201, { task: view(task) });
        }); return;
      }
      const match = /^\/api\/video-replica\/tasks\/([a-f0-9-]{36})(?:\/(video|photo|start|result))?$/.exec(path);
      const task = match && jobs.get(match[1]);
      if (!task || task.userId !== userId) throw error('任务不存在。', 404, 'VIDEO_NOT_FOUND');
      if (!match[2] && req.method === 'GET') { json(res, 200, { task: view(task) }); return; }
      if (task.expiresAt <= now()) throw error('素材或成片已过期，请重新上传。', 410, 'VIDEO_EXPIRED');
      if (['video', 'photo'].includes(match[2]) && ['GET', 'HEAD'].includes(req.method)) {
        if (!task[match[2]]) throw error('素材尚未上传。', 404, 'VIDEO_NOT_FOUND');
        await serveMedia(req, res, file(task, match[2]), match[2] === 'photo' ? 'image/jpeg' : 'video/mp4'); return;
      }
      if (match[2] === 'result' && ['GET', 'HEAD'].includes(req.method)) {
        if (!view(task).resultUrl) throw error('成片尚未准备好。', 409, 'VIDEO_NOT_READY');
        await serveMedia(req, res, file(task, 'result'), 'video/mp4', url.searchParams.get('download') === '1'); return;
      }
      await serialize(task.id, async () => {
        if (['video', 'photo'].includes(match[2]) && req.method === 'PUT') {
          if (task.status !== 'draft') throw error('任务已提交，不能替换素材。', 409);
          const kind = match[2], bytes = await readBody(req, kind === 'video' ? VIDEO_LIMIT : PHOTO_LIMIT);
          const temporary = join(folder(task), 'upload.tmp');
          if (kind === 'photo') {
            const normalized = await photo(bytes); await writeFile(temporary, normalized, { mode: 0o600 });
            task.photo = { ready: true };
          } else {
            if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw error('请上传 MP4 或 MOV 视频。');
            await writeFile(temporary, bytes, { mode: 0o600 });
            const metadata = await probe(temporary);
            if (metadata.duration < 2 || metadata.duration > 15 || metadata.width < 300 || metadata.height < 300) throw error('参考视频需为 2–15 秒，宽高至少 300 像素。');
            task.video = metadata;
            task.duration = DURATIONS.find(value => value >= Math.ceil(metadata.duration - 0.05)) || 15;
            task.ratio = RATIOS.reduce((best, ratio) => {
              const value = text => text.split(':').reduce((a, b) => a / b);
              return Math.abs(value(ratio) - metadata.width / metadata.height) < Math.abs(value(best) - metadata.width / metadata.height) ? ratio : best;
            });
          }
          await rename(temporary, file(task, kind)); await save(task); json(res, 200, { task: view(task) }); return;
        }
        if (match[2] === 'start' && req.method === 'POST') {
          await readJSON(req);
          if (task.status !== 'draft') { json(res, 200, { task: view(task) }); return; }
          if (!task.photo || !task.video) throw error('请先上传一段参考视频和一张人物照片。');
          if (!config.enabled) throw error('人物复刻服务尚未配置。', 503, 'VIDEO_NOT_CONFIGURED');
          if ([...jobs.values()].some(item => item.userId === userId && ACTIVE.has(item.status))) throw error('当前有视频正在生成，请完成后再提交。', 409, 'VIDEO_BUSY');
          task.status = 'reserving'; task.startedAt = now(); task.expiresAt = now() + 3 * DAY; await save(task);
          try {
            if (credits) {
              const record = await credits.reserve({ userId, taskId: task.id, kind: 'video', units: task.duration });
              task.billing = { status: record.status, reservedPoints: record.reservedPoints, chargedPoints: record.chargedPoints };
            }
            task.status = 'reviewing'; await save(task);
          } catch (cause) {
            if (fatal) throw cause;
            await fail(task, cause.code === 'INSUFFICIENT_POINTS' ? '积分不足，未开始生成。' : '积分预留失败，未开始生成。', cause.code || 'CREDITS_UNAVAILABLE');
            throw cause;
          }
          json(res, 202, { task: view(task) }); return;
        }
        throw error('请求方式不受支持。', 405, 'METHOD_NOT_ALLOWED');
      });
    } catch (cause) {
      if (res.headersSent) { res.destroy(); return; }
      const safe = cause instanceof VideoError || ['INSUFFICIENT_POINTS', 'CREDITS_STORAGE_UNAVAILABLE'].includes(cause.code);
      json(res, safe ? cause.status || 503 : 503, { error: safe ? cause.message : '视频服务暂时不可用，请稍后查询原任务。', code: safe ? cause.code : 'VIDEO_UNAVAILABLE' });
    }
  };
  handler.ready = ready;
  handler.shutdown = () => shutdownPromise ||= (async () => {
    closing = true; clearInterval(timer); await ready.catch(() => {}); clearInterval(timer);
    await ticking?.catch(() => {}); await Promise.allSettled([...locks.values()]); await instance.close();
  })();
  return handler;
}
