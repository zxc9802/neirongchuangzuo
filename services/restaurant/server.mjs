import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { loadAIConfig } from '../ai/server.mjs';
import { createRestaurantStore, FILES_TTL_MS } from './store.mjs';
import { createRestaurantMedia } from './media.mjs';
import * as images from './images.mjs';
import { createRestaurantModel } from './model.mjs';
import { displayModelName } from '../../design/model-labels.js';
import { inspectCopyQuality } from './copy-quality.mjs';
import { RestaurantError, UUID, fingerprint, normalizeProfile, requireProfile, normalizeFacts, resolveDirectionFacts, pendingFacts, validateAnalysis, validateDirections, validateCopy, validateAudit, localReview } from './rules.mjs';

const MB = 1024 * 1024;
const ACTIVE = new Set(['uploading', 'analysing', 'generating', 'retrying']);
const loopback = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function readJSON(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new RestaurantError('请求需要使用JSON格式。', 415);
  if (Number(req.headers['content-length']) > 34 * MB) throw new RestaurantError('素材总大小超出限制。', 413);
  let timer, size = 0; const chunks = [];
  const consume = (async () => {
    for await (const chunk of req) { size += chunk.length; if (size > 34 * MB) throw new RestaurantError('素材总大小超出限制。', 413); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
    catch { throw new RestaurantError('请求内容无法读取。'); }
  })();
  try { return await Promise.race([consume, new Promise((_, reject) => { timer = setTimeout(() => reject(new RestaurantError('上传超时，请重试。', 408, 'BODY_TIMEOUT')), 30_000); })]); }
  finally { clearTimeout(timer); }
}
function decodeUploads(value, max = 9, startIndex = 0) {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new RestaurantError(`每批请选择1—${max}张真实照片。`);
  let total = 0;
  return value.map((item, index) => {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(item?.dataUrl ?? '');
    if (!match || match[2].length > Math.ceil(8 * MB / 3) * 4) throw new RestaurantError('只支持PNG、JPEG、WebP，单张最多8MB。');
    const bytes = Buffer.from(match[2], 'base64'); total += bytes.length;
    if (!bytes.length || bytes.length > 8 * MB || total > 24 * MB || bytes.toString('base64') !== match[2]) throw new RestaurantError('照片大小超限或数据不完整。', 413);
    return { id: `photo-${startIndex + index + 1}`, name: typeof item.name === 'string' ? item.name.slice(0, 180).replace(/[\u0000-\u001f]/g, '') : `照片${startIndex + index + 1}`, mime: match[1], bytes };
  });
}

export function createRestaurantHandler({ dataDir = resolve('.data/restaurant'), databaseUrl = process.env.RESTAURANT_DATABASE_URL || process.env.AUTH_DATABASE_URL, config = loadAIConfig(), fetchImpl = fetch, now = Date.now,
  store: injectedStore, media: injectedMedia, model: injectedModel, providerLedger, credits, mediaEnv = process.env, imageProcessor = images, packageDailyLimit = Number(process.env.RESTAURANT_PACKAGE_DAILY_LIMIT || 20), cleanupIntervalMs = 60_000,
  requireAuth = process.env.NODE_ENV === 'production', logger = console } = {}) {
  const store = injectedStore ?? createRestaurantStore({ dataDir, databaseUrl, now, packageDailyLimit });
  const rawMedia = injectedMedia ?? createRestaurantMedia({ dataDir, now, env: mediaEnv });
  const scopedKey = (userId, taskId, key) => `${fingerprint(userId).slice(0, 32)}/${taskId}/${key}`;
  const media = { ready: rawMedia.ready,
    put: (_userId, _taskId, key, bytes) => rawMedia.put(key, bytes),
    get: (_userId, _taskId, key) => rawMedia.get(key),
    remove: (_userId, _taskId, key) => rawMedia.remove(key) };
  const model = injectedModel ?? createRestaurantModel({ config, storageDir: join(dataDir, 'model-control'), fetchImpl, now, ledger: providerLedger });
  let closing = false, cleanupTimer, shutdownPromise;
  const running = new Set(), serial = new Map(), mediaWriteGroups = new Map();
  const report = code => { try { logger.warn?.({ event: 'restaurant', code }); } catch {} };
  async function protectMediaGroup(keys, operation) {
    for (const key of keys) mediaWriteGroups.set(key, (mediaWriteGroups.get(key) ?? 0) + 1);
    try { return await operation(); }
    finally { for (const key of keys) { const remaining = mediaWriteGroups.get(key) - 1; if (remaining) mediaWriteGroups.set(key, remaining); else mediaWriteGroups.delete(key); } }
  }
  async function sweep() {
    const result = await store.sweep();
    if (credits) {
      for (const { userId, taskId, creditId } of result.pendingCredits ?? []) {
        try {
          const saved = await credits.reservation(userId, creditId);
          const record = saved?.status === 'reserved' ? await credits.release({ userId, taskId: creditId }) : saved;
          await store.acknowledgeCredits(userId, taskId, creditId, record);
        } catch { report('CREDITS_RELEASE_PENDING'); }
      }
    }
    for (const file of result.expiredFiles ?? []) {
      // The whole registered batch stays queued until every possible late write ends.
      if (serial.has(file.userId) || mediaWriteGroups.has(file.key)) continue;
      await media.remove(file.userId, file.taskId, file.key);
      if (serial.has(file.userId) || mediaWriteGroups.has(file.key)) continue;
      await store.acknowledgeFiles?.(file.userId, [file.key]);
    }
  }
  const ready = (async () => {
    await Promise.all([store.ready, media.ready, model.ready]);
    await sweep().catch(() => report('CLEANUP_FAILED'));
    if (cleanupIntervalMs > 0) { cleanupTimer = setInterval(() => sweep().catch(() => report('CLEANUP_FAILED')), cleanupIntervalMs); cleanupTimer.unref?.(); }
  })();
  ready.catch(() => {});
  function exclusive(userId, operation) {
    const last = serial.get(userId) ?? Promise.resolve();
    const next = last.catch(() => {}).then(operation);
    serial.set(userId, next);
    next.finally(() => { if (serial.get(userId) === next) serial.delete(userId); }).catch(() => {});
    return next;
  }
  function publicTask(task) {
    if (!task) return null;
    const { userId, fingerprint: ignored, uploadBatches: ignoredBatches, uploadedBytes: ignoredBytes, pendingUpload: ignoredPending, ...output } = task;
    if (Object.hasOwn(output, 'model')) output.model = displayModelName(output.model, 'Plus模型');
    output.files = (task.files ?? []).map(({ key, ...file }) => ({ ...file, expired: file.expired || file.expiresAt <= now(), url: `/api/restaurant/tasks/${task.id}/files/${encodeURIComponent(file.filename)}` }));
    output.sourceImages = (task.sourceImages ?? []).map(({ key, ...photo }) => ({ ...photo, expired: photo.expired || photo.expiresAt <= now(), url: `/api/restaurant/tasks/${task.id}/files/${encodeURIComponent(photo.filename)}` }));
    output.filesExpired = Boolean(output.files.length) && output.files.every(file => file.expired);
    output.selectedDirectionId = task.selection?.directionId ?? task.selectedDirectionId ?? null;
    output.facts = task.selection?.facts ?? {};
    output.imageMode = task.selection?.imageMode ?? 'natural';
    output.imageCount = task.imageCount ?? task.sourceImages?.length ?? 0;
    output.uploadedCount = task.sourceImages?.length ?? 0;
    output.outputCount = task.outputCount ?? task.selection?.outputCount ?? task.copy?.imageOrder?.length ?? null;
    return output;
  }
  async function taskFor(userId, id) {
    if (!UUID.test(id)) throw new RestaurantError('任务地址无效。', 400);
    const task = await store.getTask(userId, id);
    if (!task) throw new RestaurantError('任务不存在或已过期。', 404, 'TASK_NOT_FOUND');
    return task;
  }
  async function reserveTaskCredits(userId, task, units) {
    if (!credits) return task;
    if (task.billing?.source === 'workspace' && !['released', 'settled'].includes(task.billing.status)) await releaseTaskCredits(userId, task);
    const attempt = (task.generationAttempt || 0) + 1;
    const taskId = `${task.id}-generation-${attempt}`;
    await store.patchTask(userId, task.id, { generationAttempt: attempt, billing: { source: 'workspace', taskId, status: 'reserving', requestedUnits: units, reservedPoints: 0, chargedPoints: 0 } });
    let reservation;
    try {
      reservation = await credits.reserve({ userId, taskId, kind: 'restaurant', units });
      if (reservation.status !== 'reserved') throw new RestaurantError('此任务积分记录已结束，请重新生成。', 409, 'CREDITS_TASK_ENDED');
      return await store.patchTask(userId, task.id, { billing: { source: 'workspace', taskId, status: 'reserved', requestedUnits: units, reservedPoints: reservation.reservedPoints, chargedPoints: 0, exempt: reservation.exempt === true } });
    } catch (error) {
      if (reservation?.status === 'reserved') await credits.release({ userId, taskId }).catch(() => report('CREDITS_RELEASE_PENDING'));
      await store.patchTask(userId, task.id, { billing: { source: 'workspace', taskId, status: 'release_pending', requestedUnits: units, chargedPoints: 0 } }).catch(() => {});
      throw error;
    }
  }
  async function releaseTaskCredits(userId, task) {
    if (!credits || task.billing?.source !== 'workspace' || ['settled', 'released'].includes(task.billing.status)) return;
    const saved = await credits.reservation(userId, task.billing.taskId);
    if (saved?.status === 'settled') { await store.patchTask(userId, task.id, { billing: { ...task.billing, status: 'settled', chargedPoints: saved.chargedPoints, exempt: saved.exempt === true } }); return; }
    if (saved) await credits.release({ userId, taskId: task.billing.taskId });
    await store.patchTask(userId, task.id, { billing: { ...task.billing, status: 'released', chargedPoints: 0 } });
  }
  async function completeWithCredits(userId, id, patch = {}) {
    const task = await taskFor(userId, id);
    if (!credits || task.billing?.source !== 'workspace') return store.completeTask(userId, id, patch);
    if (task.status === 'completed') return task;
    const files = patch.files ?? task.files ?? [];
    const units = files.filter(file => /^image\//.test(file.mime)).length;
    if (!units || files.some(file => file.expired || file.expiresAt <= now())) throw new RestaurantError('成品已过期，无法结算，请重新生成。', 410, 'FILES_EXPIRED');
    const pending = await store.patchTask(userId, id, { ...patch, status: 'generating', progress: { stage: 'credits_settlement' }, billing: { ...task.billing, status: 'settle_pending', deliveredUnits: units } });
    const record = await credits.settle({ userId, taskId: task.billing.taskId, units });
    return store.completeTask(userId, id, { billing: { ...pending.billing, status: 'settled', chargedPoints: record.chargedPoints, reservedPoints: record.reservedPoints, exempt: record.exempt === true }, progress: null, error: null, code: null, completedAt: now() });
  }
  async function fail(userId, id, cause) {
    const current = await store.getTask(userId, id);
    if (current?.billing?.status === 'settle_pending' && current.files?.length) {
      await store.patchTask(userId, id, { status: 'generating', progress: { stage: 'credits_settlement', message: '成品已保存，正在确认积分结算。' }, error: '积分结算暂未确认，请稍后查询原任务。', code: 'CREDITS_SETTLEMENT_PENDING' });
      report('CREDITS_SETTLEMENT_PENDING'); return;
    }
    if (current) await releaseTaskCredits(userId, current).catch(() => report('CREDITS_RELEASE_PENDING'));
    await store.releasePackage(userId, id);
    await store.patchTask(userId, id, { status: 'failed', error: cause instanceof RestaurantError || cause.status || cause.statusCode ? cause.message : '任务处理失败，请稍后重试。', code: cause.code ?? 'PROCESSING_FAILED', retryable: cause.code !== 'PROVIDER_UNCERTAIN' });
    report(cause.code ?? 'PROCESSING_FAILED');
  }
  function launch(userId, id, operation) {
    const work = Promise.resolve().then(operation).catch(cause => fail(userId, id, cause)).catch(() => report('TASK_SAVE_FAILED'));
    running.add(work); work.finally(() => running.delete(work));
  }
  async function loadSources(userId, task) {
    const loaded = [];
    for (const photo of task.sourceImages) {
      if (photo.expiresAt <= now() || photo.expired) throw new RestaurantError('原图已过期，请重新上传。', 410, 'FILES_EXPIRED');
      const bytes = await media.get(userId, task.id, photo.key);
      if (!bytes) throw new RestaurantError('原图文件不可用，请重新上传。', 410, 'FILES_EXPIRED');
      loaded.push({ ...photo, bytes, dataUrl: `data:${photo.mime};base64,${bytes.toString('base64')}` });
    }
    return loaded;
  }
  async function uploadPhotos(userId, task, body) {
    if (task.uploadProtocol !== 'batches') throw new RestaurantError('该任务不支持分批上传。', 409, 'TASK_STATE');
    if (task.uploadExpiresAt <= now()) throw new RestaurantError('上传素材已过3天保留期，请创建新任务。', 410, 'FILES_EXPIRED');
    if (!Number.isInteger(body.startIndex) || body.startIndex < 0 || body.startIndex >= task.imageCount) throw new RestaurantError('照片起始序号无效。', 400, 'INVALID_UPLOAD_INDEX');
    const decoded = decodeUploads(body.images, 3, body.startIndex), inspected = [];
    if (body.startIndex + decoded.length > task.imageCount) throw new RestaurantError('本批照片超过声明的总张数。', 400, 'IMAGE_COUNT_EXCEEDED');
    for (const photo of decoded) {
      const meta = await imageProcessor.inspectPhoto(photo.bytes), mime = meta.format === 'jpeg' ? 'image/jpeg' : `image/${meta.format}`;
      if (mime !== photo.mime) throw new RestaurantError('图片内容与格式不一致。');
      inspected.push({ ...photo, ...meta });
    }
    const fp = fingerprint(inspected.map(photo => ({ hash: photo.hash, name: photo.name })));
    const previous = (task.uploadBatches ?? []).find(batch => batch.startIndex === body.startIndex);
    if (previous) {
      if (previous.fingerprint !== fp || previous.count !== inspected.length) throw new RestaurantError('该序号已上传不同照片，请重新创建素材任务。', 409, 'UPLOAD_BATCH_CONFLICT');
      return task;
    }
    if (task.status !== 'uploading') throw new RestaurantError('素材任务已进入分析，不能再追加照片。', 409, 'TASK_STATE');
    if (body.startIndex !== task.sourceImages.length) throw new RestaurantError('请从已上传照片后的连续序号继续。', 409, 'UPLOAD_SEQUENCE_CONFLICT');
    if (task.pendingUpload && (task.pendingUpload.startIndex !== body.startIndex || task.pendingUpload.fingerprint !== fp)) throw new RestaurantError('该序号有未确认的上传批次，请恢复原批次。', 409, 'UPLOAD_BATCH_CONFLICT');
    const batchBytes = inspected.reduce((sum, photo) => sum + photo.bytes.length, 0);
    if ((task.uploadedBytes ?? 0) + batchBytes > 60 * MB) throw new RestaurantError('压缩后的素材总大小最多60MB，请减少照片或进一步压缩。', 413, 'UPLOAD_POOL_TOO_LARGE');
    const sourceImages = inspected.map(photo => {
      const filename = `original-${photo.id}.${photo.format === 'jpeg' ? 'jpg' : photo.format}`;
      return { id: photo.id, name: photo.name, mime: photo.mime, width: photo.width, height: photo.height, hash: photo.hash, quality: photo.quality, bytes: photo.bytes.length,
        filename, key: scopedKey(userId, task.id, `originals/${filename}`), expiresAt: task.uploadExpiresAt };
    });
    return protectMediaGroup(sourceImages.map(source => source.key), async () => {
      await store.patchTask(userId, task.id, { pendingUpload: { startIndex: body.startIndex, fingerprint: fp, sourceImages } });
      for (const [index, source] of sourceImages.entries()) await media.put(userId, task.id, source.key, inspected[index].bytes);
      return await store.patchTask(userId, task.id, { sourceImages: [...task.sourceImages, ...sourceImages], uploadedBytes: (task.uploadedBytes ?? 0) + batchBytes,
        uploadBatches: [...(task.uploadBatches ?? []), { startIndex: body.startIndex, count: inspected.length, fingerprint: fp }], pendingUpload: null });
    });
  }
  async function startAnalysis(userId, task) {
    if (task.uploadProtocol !== 'batches') throw new RestaurantError('该任务使用原有上传流程。', 409, 'TASK_STATE');
    if (task.status !== 'uploading') return task;
    if (task.uploadExpiresAt <= now()) throw new RestaurantError('上传素材已过期，请重新上传。', 410, 'FILES_EXPIRED');
    if (task.pendingUpload || task.sourceImages.length !== task.imageCount) throw new RestaurantError('照片尚未全部上传，请继续上传后再分析。', 409, 'UPLOAD_INCOMPLETE');
    if (model.enabled === false) throw new RestaurantError('内容分析接口尚未配置。', 503, 'MODEL_NOT_CONFIGURED');
    await loadSources(userId, task);
    const claimed = await store.claimTask(userId, task.id, ['uploading'], { status: 'analysing', progress: { stage: 'analysis', current: 0, total: task.imageCount } });
    if (claimed) launch(userId, task.id, () => analyseTask(userId, task.id));
    return claimed ?? await taskFor(userId, task.id);
  }
  async function cancelUpload(userId, task) {
    if (task.uploadProtocol !== 'batches') throw new RestaurantError('该任务不是分批上传草稿。', 409, 'TASK_STATE');
    if (task.code === 'UPLOAD_CANCELLED') return task;
    if (task.status !== 'uploading') throw new RestaurantError('任务已开始分析，不能取消上传草稿。', 409, 'TASK_STATE');
    const expire = file => ({ ...file, expiresAt: now() });
    return await store.claimTask(userId, task.id, ['uploading'], { status: 'failed', code: 'UPLOAD_CANCELLED', retryable: false, error: '已取消上传，可以重新选择素材。',
      sourceImages: task.sourceImages.map(expire), pendingUpload: task.pendingUpload ? { ...task.pendingUpload, sourceImages: task.pendingUpload.sourceImages.map(expire) } : null }) ?? await taskFor(userId, task.id);
  }
  async function refreshRecommendations(userId, task, body) {
    if (!UUID.test(body.requestId ?? '')) throw new RestaurantError('推荐请求标识无效，请刷新后重试。');
    if (task.recommendationRequestId === body.requestId) return task;
    if (!['awaiting_selection', 'awaiting_facts'].includes(task.status)) throw new RestaurantError('请等待当前任务完成后再重新推荐。', 409, 'TASK_STATE');
    if (!task.sourceImages?.length || task.analysis?.length !== task.sourceImages.length) throw new RestaurantError('照片分析尚未完成，请先完成原任务。', 409, 'ANALYSIS_INCOMPLETE');
    if (model.enabled === false) throw new RestaurantError('内容分析接口尚未配置。', 503, 'MODEL_NOT_CONFIGURED');
    if ((await store.listTasks(userId)).filter(item => ACTIVE.has(item.status)).length >= 2) throw new RestaurantError('当前有任务处理中，请完成后再重新推荐。', 429, 'ACTIVE_LIMIT');
    await loadSources(userId, task);
    const claimed = await store.claimTask(userId, task.id, ['awaiting_selection', 'awaiting_facts'], {
      status: 'analysing', recommendationRequestId: body.requestId,
      directions: [], selection: null, selectedDirectionId: null, facts: {}, missingFacts: [], outputCount: null,
      progress: { stage: 'recommendation', current: task.analysis.length, total: task.sourceImages.length }, error: null, code: null,
    });
    if (claimed) launch(userId, task.id, () => analyseTask(userId, task.id));
    return claimed ?? await taskFor(userId, task.id);
  }
  async function analyseTask(userId, id) {
    const task = await taskFor(userId, id), sources = await loadSources(userId, task);
    const analysis = [...(task.analysis ?? [])];
    const onBudgetWait = () => store.patchTask(userId, id, { progress: { stage: 'waiting_for_budget', current: analysis.length, total: sources.length, message: '共享请求较多，正在排队等待继续分析。' } });
    for (let start = analysis.length; start < sources.length; start += 3) {
      const batch = [];
      for (const source of sources.slice(start, start + 3)) {
        const prepared = imageProcessor.prepareAnalysisPhoto ? await imageProcessor.prepareAnalysisPhoto(source.bytes) : { bytes: source.bytes, mime: source.mime };
        batch.push({ ...source, dataUrl: `data:${prepared.mime};base64,${prepared.bytes.toString('base64')}` });
      }
      analysis.push(...validateAnalysis({ images: await model.analyse(batch, task.profileSnapshot, { onBudgetWait }) }, batch.map(item => item.id)));
      await store.patchTask(userId, id, { analysis: [...analysis], progress: { stage: 'analysis', current: analysis.length, total: sources.length } });
    }
    const hashes = new Set();
    for (const item of analysis) {
      const photo = sources.find(source => source.id === item.imageId);
      if (hashes.has(photo.hash)) { item.usable = false; item.rejectionReason = '与本组另一张照片完全重复。'; }
      hashes.add(photo.hash);
    }
    const usable = analysis.filter(item => item.usable);
    if (!usable.length) {
      await store.patchTask(userId, id, { analysis, directions: [], status: 'failed', code: 'NO_USABLE_PHOTOS', retryable: false, error: '这组照片暂时无法组成一篇可发布的小红书内容，请补充更清晰的菜品、环境或消费场景照片。' });
      return;
    }
    const directions = validateDirections({ directions: await model.recommend(analysis, task.profileSnapshot, { onBudgetWait }) }, analysis, task.profileSnapshot);
    await store.patchTask(userId, id, { analysis, directions, sparsePhotos: usable.length <= 2, status: directions.length ? 'awaiting_selection' : 'failed', progress: null,
      ...(directions.length ? { message: usable.length <= 2 ? '当前可用照片较少，可以生成简版图文；补充菜品、环境或消费场景照片后，内容会更完整。' : '', error: null } : { code: 'NO_RELIABLE_DIRECTION', retryable: false, error: '没有可靠的内容方向，请补充照片或门店资料。' }) });
  }
  async function process(userId, task, photo, options) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await imageProcessor.processPhoto(photo.bytes, options); }
      catch (cause) {
        if (attempt === 2) throw cause;
        await store.patchTask(userId, task.id, { status: 'retrying', progress: { stage: 'image', imageId: photo.id, retry: attempt + 1 } });
      }
    }
  }
  async function buildPackage(userId, task, processed, copy, review) {
    const expiresAt = now() + FILES_TTL_MS;
    if (expiresAt <= now()) throw new RestaurantError('原图已过期，请重新上传。', 410, 'FILES_EXPIRED');
    const files = [], uploaded = [];
    for (let index = 0; index < copy.imageOrder.length; index++) {
      const result = processed.get(copy.imageOrder[index]);
      const filename = `${String(index + 1).padStart(2, '0')}.jpg`, key = scopedKey(userId, task.id, `results/${filename}`);
      files.push({ key, filename, mime: 'image/jpeg', role: 'image', imageId: copy.imageOrder[index], bytes: result.bytes.length, expiresAt, width: result.width, height: result.height });
    }
    const zip = await imageProcessor.createPackageZip(copy.imageOrder.map(imageId => ({ ...processed.get(imageId) })), { ...copy, hashtags: copy.tags.map(tag => `#${tag}`), store: task.profileSnapshot.name, risks: review.warnings, review });
    const zipKey = scopedKey(userId, task.id, 'results/package.zip');
    files.push({ key: zipKey, filename: 'package.zip', mime: 'application/zip', role: 'zip', bytes: zip.length, expiresAt });
    return protectMediaGroup(files.map(file => file.key), async () => {
      // Register after protecting every key, including those not yet dispatched to media.
      await store.patchTask(userId, task.id, { files });
      try {
        for (const file of files.filter(item => item.role === 'image')) {
          await media.put(userId, task.id, file.key, processed.get(file.imageId).bytes); uploaded.push(file.key);
        }
        await media.put(userId, task.id, zipKey, zip); uploaded.push(zipKey);
        return { files, copy, review };
      } catch (cause) { for (const key of uploaded) await media.remove(userId, task.id, key).catch(() => {}); throw cause; }
    });
  }
  async function generateTask(userId, id) {
    const task = await taskFor(userId, id), selection = task.selection;
    const sources = await loadSources(userId, task);
    const candidates = [...selection.imageIds, ...(selection.backupImageIds ?? [])].map(imageId => task.analysis.find(item => item.imageId === imageId)).filter(Boolean);
    let selected = [];
    const processed = new Map();
    const targetCount = selection.outputCount ?? selection.imageIds.length;
    for (const item of candidates) {
      if (processed.size >= targetCount) break;
      const source = sources.find(photo => photo.id === item.imageId);
      try { processed.set(item.imageId, await process(userId, task, source, item.crop ? { crop: item.crop } : {})); selected.push(item); }
      catch { /* Failed photos may be removed before copy is written against remaining evidence. */ }
    }
    if (!selected.length) throw new RestaurantError('可用图片处理失败，未形成完整内容包。', 502, 'IMAGES_FAILED');
    if (selection.strictOutputCount && selected.length !== targetCount) throw new RestaurantError(`可用照片处理后不足${targetCount}张，同方向备用照片也无法补齐，未扣正式生成额度。`, 502, 'INSUFFICIENT_PROCESSED_IMAGES');
    if ((selection.coreImageIds ?? []).some(imageId => !processed.has(imageId))) throw new RestaurantError('该方向的核心证据照片处理失败，无法用场景配图替代，未扣正式生成额度。', 502, 'CORE_IMAGE_FAILED');
    // A dish/group-buy direction requires its visual evidence; otherwise fail rather than weaken its claim silently.
    const originalCore = task.analysis.filter(item => selection.imageIds.includes(item.imageId) && item.imageType === 'food');
    if (originalCore.length && /菜|餐|面|食|团购/.test(selection.direction.label) && !selected.some(item => item.imageType === 'food')) throw new RestaurantError('核心菜品图片处理失败，请重试或选择其他方向。', 502, 'CORE_IMAGE_FAILED');
    await store.patchTask(userId, id, { status: 'generating', outputCount: selected.length, progress: { stage: 'copy' }, removedImageIds: selection.imageIds.filter(imageId => !processed.has(imageId)) });
    // Let writing and review see a few actual final photos, with removed edge risks already cropped.
    // The full structured analysis remains available for every selected photo.
    const photos = await Promise.all(selected.slice(0, 3).map(async item => {
      const result = processed.get(item.imageId);
      const photo = imageProcessor.prepareAnalysisPhoto ? await imageProcessor.prepareAnalysisPhoto(result.bytes) : { bytes: result.bytes, mime: 'image/jpeg' };
      return { id: item.imageId, dataUrl: `data:${photo.mime};base64,${photo.bytes.toString('base64')}` };
    }));
    let copy, review, copyQuality;
    const onBudgetWait = () => store.patchTask(userId, id, { progress: { stage: 'waiting_for_budget', message: '共享请求较多，正在排队等待继续生成。' } });
    for (let revision = 0; revision < 2; revision++) {
      const draft = copy, qualityIssues = review?.errors ?? [];
      if (revision) await store.patchTask(userId, id, { progress: { stage: 'copy_refining' } });
      // Only complete, known drafts can be rewritten. Uncertain provider errors propagate without replay.
      copy = validateCopy(await model.write({ profile: task.profileSnapshot, analysis: selected, direction: selection.direction, facts: selection.facts, photos,
        ...(draft ? { draft, qualityIssues } : {}) }, { onBudgetWait }), selected.map(item => item.imageId));
      if (copy.imageOrder.length !== selected.length) throw new RestaurantError('文案返回的图片顺序不完整。', 502, 'MODEL_INVALID_OUTPUT');
      const quality = inspectCopyQuality(copy, { profile: task.profileSnapshot, analysis: selected, direction: selection.direction });
      copyQuality = { ...quality, revisionCount: revision };
      const local = localReview(copy, task.profileSnapshot, selection.facts, selected);
      // Avoid another paid review for an already rejected draft, but never relax factual checks.
      const audit = quality.passed && !local.errors.length
        ? validateAudit(await model.audit({ copy, profile: task.profileSnapshot, confirmedFacts: selection.facts, direction: selection.direction, images: selected, photos }, { onBudgetWait }))
        : { status: 'passed', errors: [], warnings: [] };
      const errors = [...new Set([...local.errors, ...quality.issues, ...audit.errors])], warnings = [...new Set([...local.warnings, ...audit.warnings])];
      if (audit.status === 'blocked' && !errors.length) errors.push('发布文案检查未通过，请调整消费主题或核对资料。');
      review = { status: errors.length ? 'blocked' : warnings.length || audit.status === 'passed_with_warning' ? 'passed_with_warning' : 'passed', errors, warnings };
      if (review.status !== 'blocked') break;
      if (revision === 1) {
        await store.releasePackage(userId, id);
        await releaseTaskCredits(userId, await taskFor(userId, id));
        await store.patchTask(userId, id, { status: 'failed', copy, review, copyQuality, code: local.errors.length || quality.passed ? 'REVIEW_BLOCKED' : 'COPY_QUALITY_FAILED',
          error: '文案自动改写后仍未通过检查，请补充真实亮点或更换内容方向。', retryable: false, progress: null }); return;
      }
    }
    if (selection.imageMode === 'cover') {
      // A cover can move to another successfully processed, reviewed photo without adding any claims.
      let cover;
      for (const imageId of copy.imageOrder) {
        try { cover = await process(userId, task, sources.find(photo => photo.id === imageId), { coverText: copy.coverText, ...(selected.find(item => item.imageId === imageId)?.crop ? { crop: selected.find(item => item.imageId === imageId).crop } : {}) });
          processed.set(imageId, cover); copy.imageOrder = [imageId, ...copy.imageOrder.filter(id => id !== imageId)]; break; }
        catch { /* Try another genuine source for the first image. */ }
      }
      if (!cover) throw new RestaurantError('封面处理失败，未形成完整内容包。', 502, 'COVER_FAILED');
    }
    const result = { ...await buildPackage(userId, task, processed, copy, review), copyQuality };
    if (review.status === 'passed_with_warning') {
      // Files remain inaccessible until warnings are explicitly confirmed on this exact result.
      await store.patchTask(userId, id, { ...result, status: 'awaiting_confirmation', progress: null });
    } else await completeWithCredits(userId, id, { ...result, progress: null, completedAt: now() });
  }
  async function cloneTask(userId, old, requestId = randomUUID()) {
    if (!UUID.test(requestId)) throw new RestaurantError('请求标识无效。');
    await loadSources(userId, old);
    const existing = await store.getTask(userId, requestId);
    const fp = fingerprint({ forkFrom: old.id });
    if (existing) { if (existing.fingerprint !== fp) throw new RestaurantError('请求标识已用于其他任务。', 409, 'REQUEST_ID_CONFLICT'); return existing; }
    if (!['completed', 'awaiting_selection', 'awaiting_facts', 'awaiting_confirmation', 'failed'].includes(old.status) || !old.directions?.length) throw new RestaurantError('当前任务尚不能选择新方向，请等待分析完成。', 409, 'TASK_STATE');
    const originals = [], sourceImages = old.sourceImages.map(source => ({ ...source, key: scopedKey(userId, requestId, `originals/${source.filename}`) }));
    let created;
    return protectMediaGroup(sourceImages.map(source => source.key), async () => { try {
      created = await store.createTask(userId, { id: requestId, fingerprint: fp, forkFrom: old.id, profileSnapshot: old.profileSnapshot, sourceImages,
        analysis: old.analysis, directions: old.directions, sparsePhotos: old.sparsePhotos, rightsConfirmed: true, status: 'uploading', files: [] });
      for (const source of old.sourceImages) {
        const bytes = await media.get(userId, old.id, source.key);
        const key = scopedKey(userId, requestId, `originals/${source.filename}`);
        await media.put(userId, requestId, key, bytes); originals.push(key);
      }
      return await store.patchTask(userId, requestId, { status: 'awaiting_selection' });
    } catch (cause) { for (const key of originals) await media.remove(userId, requestId, key).catch(() => {}); if (created) await fail(userId, requestId, cause); throw cause; } });
  }
  async function startGenerate(userId, task, body) {
    if (body.outputCount !== undefined && (!Number.isInteger(body.outputCount) || body.outputCount < 1 || body.outputCount > 15)) throw new RestaurantError('请选择1—15张真实成品图片。', 400, 'INVALID_OUTPUT_COUNT');
    if (task.selection && (ACTIVE.has(task.status) || task.status === 'awaiting_confirmation') && body.outputCount !== undefined && body.outputCount !== (task.selection.outputCount ?? task.selection.imageIds.length)) throw new RestaurantError('该任务已按其他成品数量开始，请查询原任务。', 409, 'OUTPUT_COUNT_CONFLICT');
    if (ACTIVE.has(task.status) || task.status === 'awaiting_confirmation') return task;
    if (task.status === 'completed') {
      // A repeated exact request returns its charged task, while a new direction is a new task.
      const sameCount = body.outputCount === undefined ? task.selection?.strictOutputCount !== true : task.selection?.strictOutputCount === true && task.selection.outputCount === body.outputCount;
      if (sameCount && task.selection?.directionId === body.directionId && task.selection?.imageMode === (body.imageMode ?? body.processingMode ?? 'natural') && fingerprint(task.selection?.facts ?? {}) === fingerprint(resolveDirectionFacts(task.selection.direction, task.profileSnapshot, normalizeFacts(body.facts)))) return task;
      task = await cloneTask(userId, task, body.requestId ?? randomUUID());
    }
    if (!['awaiting_selection', 'awaiting_facts'].includes(task.status)) throw new RestaurantError('请先完成照片分析，或返回重新上传照片。', 409, 'TASK_STATE');
    const direction = task.directions.find(item => item.id === body.directionId);
    if (!direction) throw new RestaurantError('请选择有效的内容方向。');
    const seenHashes = new Set();
    const availableIds = direction.supportingImageIds.filter(imageId => {
      const item = task.analysis.find(entry => entry.imageId === imageId), source = task.sourceImages.find(entry => entry.id === imageId);
      if (!item?.usable || !source || seenHashes.has(source.hash)) return false;
      seenHashes.add(source.hash); return true;
    });
    if (!availableIds.length) throw new RestaurantError('该方向没有可用照片，请更换方向。', 422);
    const coreImageIds = direction.coreImageIds ?? [];
    if (coreImageIds.some(imageId => !availableIds.includes(imageId))) throw new RestaurantError('该方向的核心证据照片不可用，请重新分析或更换方向。', 422, 'CORE_IMAGES_UNAVAILABLE');
    const outputCount = body.outputCount ?? Math.min(15, availableIds.length);
    if (outputCount > availableIds.length || body.outputCount !== undefined && availableIds.length >= 6 && outputCount < 6) throw new RestaurantError(`该方向可用真实照片${availableIds.length}张，请选择${availableIds.length >= 6 ? '6—' : '1—'}${Math.min(15, availableIds.length)}张，不会复制照片凑数。`, 422, 'INSUFFICIENT_DIRECTION_IMAGES');
    if (outputCount < coreImageIds.length) throw new RestaurantError(`该方向需要保留${coreImageIds.length}张核心证据照片，请增加成品张数。`, 422, 'CORE_IMAGES_REQUIRED');
    const facts = resolveDirectionFacts(direction, task.profileSnapshot, normalizeFacts(body.facts)), missingFacts = pendingFacts(direction, task.profileSnapshot, facts);
    if (missingFacts.length) return await store.patchTask(userId, task.id, { status: 'awaiting_facts', missingFacts, selectedDirectionId: direction.id });
    if (task.sparsePhotos && body.acceptSparse !== true && body.allowFewImages !== true) throw new RestaurantError('可用照片较少，请确认继续生成简版图文。', 422, 'SPARSE_CONFIRMATION_REQUIRED');
    const imageMode = body.imageMode ?? body.processingMode ?? 'natural';
    if (!['natural', 'cover'].includes(imageMode)) throw new RestaurantError('请选择自然美化或封面加字。');
    const orderedIds = [...coreImageIds, ...availableIds.filter(imageId => !coreImageIds.includes(imageId))];
    const imageIds = orderedIds.slice(0, outputCount), backupImageIds = orderedIds.slice(outputCount);
    task = await reserveTaskCredits(userId, task, imageIds.length);
    try { await store.reservePackage(userId, task.id); }
    catch (error) { await releaseTaskCredits(userId, task).catch(() => {}); throw error; }
    const claimed = await store.claimTask(userId, task.id, ['awaiting_selection', 'awaiting_facts'], { status: 'generating', outputCount, selection: { directionId: direction.id, direction, facts, imageMode, imageIds, coreImageIds, backupImageIds, outputCount, strictOutputCount: body.outputCount !== undefined }, missingFacts: [], error: null, code: null });
    if (!claimed) return await taskFor(userId, task.id);
    launch(userId, task.id, () => generateTask(userId, task.id)); return claimed;
  }
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname;
    if (!path.startsWith('/api/restaurant/')) return false;
    try {
      if (closing) throw new RestaurantError('服务正在重启，请稍后继续。', 503, 'SERVICE_CLOSING');
      await ready;
      const userId = req.authenticatedUserId || (!requireAuth && loopback(req.socket?.remoteAddress) ? 'local-dev' : null);
      if (!userId) throw new RestaurantError('请先登录后继续。', 401, 'UNAUTHENTICATED');
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin); } catch { throw new RestaurantError('请求来源不正确。', 403); }
        if (origin.host !== req.headers.host) throw new RestaurantError('请求来源不正确。', 403, 'ORIGIN_REJECTED');
      }
      if (path === '/api/restaurant/status' && req.method === 'GET') { reply(res, 200, { enabled: model.enabled ?? true, packageDailyLimit, retention: { filesDays: 3, tasksDays: 30 }, model: displayModelName(config.chatModel, 'Plus模型') }); return true; }
      if (path === '/api/restaurant/usage' && req.method === 'GET') { const usage = await store.usage(userId), raw = await model.usage?.(); reply(res, 200, { usage, budget: raw ? { day: raw.day, limits: raw.limits, used: raw.used, remaining: raw.remaining } : null }); return true; }
      if (path === '/api/restaurant/profile') {
        if (req.method === 'GET') { reply(res, 200, { profile: await store.getProfile(userId) }); return true; }
        if (['PUT', 'PATCH'].includes(req.method)) { const body = await readJSON(req); const profile = await exclusive(userId, async () => store.saveProfile(userId, normalizeProfile(req.method === 'PATCH' ? { ...await store.getProfile(userId), ...(body.profile ?? body) } : body))); reply(res, 200, { profile }); return true; }
      }
      if (path === '/api/restaurant/tasks' && req.method === 'GET') {
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 12)), cursor = Number(url.searchParams.get('cursor')) || Infinity;
        const completed = url.searchParams.get('completed');
        if (completed !== null && !['true', 'false'].includes(completed)) throw new RestaurantError('任务筛选条件无效。');
        const afterValue = url.searchParams.get('completedAfter'), completedAfter = afterValue === null ? null : Number(afterValue);
        if (afterValue !== null && (!afterValue.trim() || !Number.isFinite(completedAfter) || completedAfter < 0)) throw new RestaurantError('完成时间筛选条件无效。');
        const all = await store.listTasks(userId), tasks = all.filter(item => item.createdAt < cursor
          && (completed !== 'true' || item.status === 'completed')
          && (completedAfter === null || item.status === 'completed' && Number.isFinite(item.completedAt) && item.completedAt > completedAfter))
          .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
        reply(res, 200, { tasks: tasks.map(publicTask), nextCursor: tasks.length === limit ? String(tasks.at(-1).createdAt) : null }); return true;
      }
      if (path === '/api/restaurant/tasks' && req.method === 'POST') {
        const body = await readJSON(req);
        const task = await exclusive(userId, async () => {
          if (!UUID.test(body.requestId ?? '')) throw new RestaurantError('请求标识无效，请刷新后重试。');
          if (body.rightsConfirmed !== true) throw new RestaurantError('请确认图片使用权和人物授权。', 422, 'RIGHTS_REQUIRED');
          const profile = await store.getProfile(userId); requireProfile(profile);
          if (body.images === undefined) {
            if (!Number.isInteger(body.imageCount) || body.imageCount < 1 || body.imageCount > 30) throw new RestaurantError('请选择1—30张素材。', 400, 'INVALID_IMAGE_COUNT');
            const fp = fingerprint({ uploadProtocol: 'batches', imageCount: body.imageCount, rightsConfirmed: true, profile });
            const old = await store.getTask(userId, body.requestId);
            if (old) { if (old.fingerprint !== fp) throw new RestaurantError('该请求标识已用于不同素材数量或门店资料。', 409, 'REQUEST_ID_CONFLICT'); return old; }
            if ((await store.listTasks(userId)).filter(item => ACTIVE.has(item.status) && !(item.uploadProtocol === 'batches' && item.uploadExpiresAt <= now())).length >= 2) throw new RestaurantError('当前有任务处理中，请完成后再上传。', 429, 'ACTIVE_LIMIT');
            return await store.createTask(userId, { id: body.requestId, requestId: body.requestId, fingerprint: fp, profileSnapshot: profile, imageCount: body.imageCount,
              uploadProtocol: 'batches', uploadExpiresAt: now() + FILES_TTL_MS, uploadedBytes: 0, uploadBatches: [], sourceImages: [], analysis: [], directions: [], files: [], rightsConfirmed: true, status: 'uploading' });
          }
          const decoded = decodeUploads(body.images), inspected = [];
          for (const photo of decoded) {
            const meta = await imageProcessor.inspectPhoto(photo.bytes);
            const mime = meta.format === 'jpeg' ? 'image/jpeg' : `image/${meta.format}`;
            if (mime !== photo.mime) throw new RestaurantError('图片内容与格式不一致。');
            inspected.push({ ...photo, ...meta });
          }
          const fp = fingerprint({ rightsConfirmed: true, images: inspected.map(item => ({ hash: item.hash, name: item.name })), profile });
          const old = await store.getTask(userId, body.requestId);
          if (old) { if (old.fingerprint !== fp) throw new RestaurantError('请求标识已用于不同照片或资料。', 409, 'REQUEST_ID_CONFLICT'); return old; }
          const active = (await store.listTasks(userId)).filter(item => ACTIVE.has(item.status));
          if (active.length >= 2) throw new RestaurantError('当前有任务处理中，请完成后再上传。', 429, 'ACTIVE_LIMIT');
          if (model.enabled === false) throw new RestaurantError('内容分析接口尚未配置。', 503, 'MODEL_NOT_CONFIGURED');
          const sourceImages = inspected.map(photo => {
            const filename = `original-${photo.id}.${photo.format === 'jpeg' ? 'jpg' : photo.format}`, key = scopedKey(userId, body.requestId, `originals/${filename}`);
            return { id: photo.id, name: photo.name, mime: photo.mime, width: photo.width, height: photo.height, hash: photo.hash, quality: photo.quality, filename, key, expiresAt: now() + FILES_TTL_MS };
          });
          const uploaded = []; let created;
          return protectMediaGroup(sourceImages.map(source => source.key), async () => { try {
            created = await store.createTask(userId, { id: body.requestId, requestId: body.requestId, fingerprint: fp, profileSnapshot: profile, sourceImages, analysis: [], directions: [], files: [], rightsConfirmed: true, status: 'uploading' });
            for (const source of sourceImages) {
              await media.put(userId, body.requestId, source.key, inspected.find(photo => photo.id === source.id).bytes); uploaded.push(source.key);
            }
            const uploadedTask = await store.patchTask(userId, body.requestId, { status: 'analysing' });
            launch(userId, created.id, () => analyseTask(userId, created.id)); return uploadedTask;
          } catch (cause) { for (const key of uploaded) await media.remove(userId, body.requestId, key).catch(() => {}); if (created) await fail(userId, body.requestId, cause); throw cause; } });
        });
        reply(res, 202, { task: publicTask(task) }); return true;
      }
      const match = /^\/api\/restaurant\/tasks\/([^/]+)(?:\/(generate|retry|confirm|fork|files|photos|analyse|recommend|cancel-upload)(?:\/([^/]+))?)?$/.exec(path);
      if (match) {
        const [, id, action, filename] = match;
        if (req.method === 'GET' && !action) {
          // Reconcile expiry on reads as well as the timer, so pending credits recover promptly after an outage.
          if (!UUID.test(id)) throw new RestaurantError('任务地址无效。', 400);
          let task = await store.getTask(userId, id);
          if (!task || task.billing?.source === 'workspace' && !['settled', 'released'].includes(task.billing.status)
            && (task.status === 'failed' || task.files?.some(file => file.expired || file.expiresAt <= now()))) {
            await sweep();
            task = await taskFor(userId, id);
          }
          if (task.billing?.source === 'workspace') {
            await exclusive(userId, async () => {
              if (task.status === 'failed' || task.billing.status === 'release_pending') await releaseTaskCredits(userId, task).catch(() => report('CREDITS_RELEASE_PENDING'));
              else if (task.billing.status === 'settle_pending' && task.files?.length) await completeWithCredits(userId, id).catch(() => report('CREDITS_SETTLEMENT_PENDING'));
            });
            task = await taskFor(userId, id);
          }
          reply(res, 200, { task: publicTask(task) }); return true;
        }
        if (req.method === 'GET' && action === 'files' && filename) {
          const task = await taskFor(userId, id);
          const name = decodeURIComponent(filename), original = task.sourceImages.find(item => item.filename === name);
          const file = original ?? (task.status === 'completed' ? task.files?.find(item => item.filename === name) : null);
          if (!file) throw new RestaurantError('文件不存在或尚未允许交付。', 404, 'FILE_NOT_FOUND');
          if (file.expired || file.expiresAt <= now()) throw new RestaurantError('文件已过期，请及时下载新任务的结果。', 410, 'FILES_EXPIRED');
          const bytes = await media.get(userId, id, file.key);
          if (!bytes) throw new RestaurantError('文件已过期或不可用。', 410, 'FILES_EXPIRED');
          res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `${original ? 'inline' : 'attachment'}; filename="${file.filename}"` }); res.end(bytes); return true;
        }
        if (req.method === 'POST' && ['generate', 'retry', 'confirm', 'fork', 'photos', 'analyse', 'recommend', 'cancel-upload'].includes(action)) {
          const body = await readJSON(req);
          const result = await exclusive(userId, async () => {
            const task = await taskFor(userId, id);
            if (action === 'photos') return uploadPhotos(userId, task, body);
            if (action === 'analyse') return startAnalysis(userId, task);
            if (action === 'recommend') return refreshRecommendations(userId, task, body);
            if (action === 'cancel-upload') return cancelUpload(userId, task);
            if (action === 'generate') return startGenerate(userId, task, body);
            if (action === 'fork') return cloneTask(userId, task, body.requestId);
            if (action === 'confirm') {
              if (task.status === 'completed') return task;
              if (task.code === 'FILES_EXPIRED' || task.files?.some(file => file.expired || file.expiresAt <= now())) throw new RestaurantError('结果文件已过期，请重新上传。', 410, 'FILES_EXPIRED');
              if (task.status !== 'awaiting_confirmation' || body.confirmWarnings !== true) throw new RestaurantError('请确认本次结果的全部风险提示。', 422, 'WARNING_CONFIRMATION_REQUIRED');
              if (!task.files?.length || task.files.some(file => file.expiresAt <= now())) throw new RestaurantError('结果文件已过期，请重新上传。', 410, 'FILES_EXPIRED');
              return completeWithCredits(userId, id, { warningsConfirmedAt: now(), completedAt: now() });
            }
            if (task.status !== 'failed' || task.retryable === false) throw new RestaurantError('该任务不能直接重试，请核对提示或重新上传。', 409, task.code === 'PROVIDER_UNCERTAIN' ? 'PROVIDER_UNCERTAIN' : 'TASK_STATE');
            await loadSources(userId, task);
            if (task.selection) {
              const reserved = await reserveTaskCredits(userId, task, task.selection.imageIds.length);
              try { await store.reservePackage(userId, id); }
              catch (error) { await releaseTaskCredits(userId, reserved).catch(() => {}); throw error; }
              const claimed = await store.claimTask(userId, id, ['failed'], { status: 'generating', error: null, code: null });
              if (claimed) launch(userId, id, () => generateTask(userId, id)); return claimed ?? task;
            }
            const claimed = await store.claimTask(userId, id, ['failed'], { status: 'analysing', error: null, code: null });
            if (claimed) launch(userId, id, () => analyseTask(userId, id)); return claimed ?? task;
          });
          reply(res, ACTIVE.has(result.status) ? 202 : 200, { task: publicTask(result) }); return true;
        }
      }
      throw new RestaurantError('接口不存在。', 404, 'NOT_FOUND');
    } catch (cause) {
      const status = cause.statusCode ?? cause.status ?? 500;
      reply(res, status >= 400 && status <= 599 ? status : 500, { error: status < 500 || cause instanceof RestaurantError ? cause.message : '服务暂时不可用，请稍后重试。', code: cause.code ?? 'SERVICE_ERROR', ...(cause.missingFields ? { missingFields: cause.missingFields } : {}) }); return true;
    }
  };
  handler.ready = ready;
  handler.shutdown = () => shutdownPromise ||= (async () => { closing = true; model.stop?.(); clearInterval(cleanupTimer); await ready.catch(() => {}); await Promise.allSettled([...serial.values()]); await Promise.allSettled([...running]); await model.close?.(); await store.close?.(); })();
  handler.store = store;
  return handler;
}
