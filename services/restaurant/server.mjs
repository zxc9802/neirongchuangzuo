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
function decodeUploads(value) {
  if (!Array.isArray(value) || !value.length || value.length > 9) throw new RestaurantError('请选择1—9张真实照片。');
  let total = 0;
  return value.map((item, index) => {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(item?.dataUrl ?? '');
    if (!match || match[2].length > Math.ceil(8 * MB / 3) * 4) throw new RestaurantError('只支持PNG、JPEG、WebP，单张最多8MB。');
    const bytes = Buffer.from(match[2], 'base64'); total += bytes.length;
    if (!bytes.length || bytes.length > 8 * MB || total > 24 * MB || bytes.toString('base64') !== match[2]) throw new RestaurantError('照片大小超限或数据不完整。', 413);
    return { id: `photo-${index + 1}`, name: typeof item.name === 'string' ? item.name.slice(0, 180).replace(/[\u0000-\u001f]/g, '') : `照片${index + 1}`, mime: match[1], bytes };
  });
}

export function createRestaurantHandler({ dataDir = resolve('.data/restaurant'), databaseUrl = process.env.RESTAURANT_DATABASE_URL || process.env.AUTH_DATABASE_URL, config = loadAIConfig(), fetchImpl = fetch, now = Date.now,
  store: injectedStore, media: injectedMedia, model: injectedModel, providerLedger, mediaEnv = process.env, imageProcessor = images, packageDailyLimit = Number(process.env.RESTAURANT_PACKAGE_DAILY_LIMIT || 20), cleanupIntervalMs = 60_000,
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
  const running = new Set(), serial = new Map();
  const report = code => { try { logger.warn?.({ event: 'restaurant', code }); } catch {} };
  async function sweep() {
    const result = await store.sweep();
    for (const file of result.expiredFiles ?? []) {
      await media.remove(file.userId, file.taskId, file.key);
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
    const { userId, fingerprint: ignored, ...output } = task;
    if (Object.hasOwn(output, 'model')) output.model = displayModelName(output.model, 'Plus模型');
    output.files = (task.files ?? []).map(({ key, ...file }) => ({ ...file, expired: file.expired || file.expiresAt <= now(), url: `/api/restaurant/tasks/${task.id}/files/${encodeURIComponent(file.filename)}` }));
    output.sourceImages = (task.sourceImages ?? []).map(({ key, ...photo }) => ({ ...photo, expired: photo.expired || photo.expiresAt <= now(), url: `/api/restaurant/tasks/${task.id}/files/${encodeURIComponent(photo.filename)}` }));
    output.filesExpired = Boolean(output.files.length) && output.files.every(file => file.expired);
    output.selectedDirectionId = task.selection?.directionId ?? task.selectedDirectionId ?? null;
    output.facts = task.selection?.facts ?? {};
    output.imageMode = task.selection?.imageMode ?? 'natural';
    return output;
  }
  async function taskFor(userId, id) {
    if (!UUID.test(id)) throw new RestaurantError('任务地址无效。', 400);
    const task = await store.getTask(userId, id);
    if (!task) throw new RestaurantError('任务不存在或已过期。', 404, 'TASK_NOT_FOUND');
    return task;
  }
  async function fail(userId, id, cause) {
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
  async function analyseTask(userId, id) {
    const task = await taskFor(userId, id), sources = await loadSources(userId, task);
    const analysis = [];
    for (let start = 0; start < sources.length; start += 3) {
      const batch = [];
      for (const source of sources.slice(start, start + 3)) {
        const prepared = imageProcessor.prepareAnalysisPhoto ? await imageProcessor.prepareAnalysisPhoto(source.bytes) : { bytes: source.bytes, mime: source.mime };
        batch.push({ ...source, dataUrl: `data:${prepared.mime};base64,${prepared.bytes.toString('base64')}` });
      }
      analysis.push(...validateAnalysis({ images: await model.analyse(batch, task.profileSnapshot) }, batch.map(item => item.id)));
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
    const directions = validateDirections({ directions: await model.recommend(analysis, task.profileSnapshot) }, analysis, task.profileSnapshot);
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
    // Record every intended object before upload so interrupted writes remain discoverable by cleanup.
    await store.patchTask(userId, task.id, { files });
    try {
      for (const file of files.filter(item => item.role === 'image')) {
        await media.put(userId, task.id, file.key, processed.get(file.imageId).bytes); uploaded.push(file.key);
      }
      await media.put(userId, task.id, zipKey, zip); uploaded.push(zipKey);
      return { files, copy, review };
    } catch (cause) { for (const key of uploaded) await media.remove(userId, task.id, key).catch(() => {}); throw cause; }
  }
  async function generateTask(userId, id) {
    const task = await taskFor(userId, id), selection = task.selection;
    const sources = await loadSources(userId, task);
    let selected = task.analysis.filter(item => selection.imageIds.includes(item.imageId));
    const processed = new Map();
    for (const item of selected) {
      const source = sources.find(photo => photo.id === item.imageId);
      try { processed.set(item.imageId, await process(userId, task, source, item.crop ? { crop: item.crop } : {})); }
      catch { /* Failed photos may be removed before copy is written against remaining evidence. */ }
    }
    selected = selected.filter(item => processed.has(item.imageId));
    if (!selected.length) throw new RestaurantError('可用图片处理失败，未形成完整内容包。', 502, 'IMAGES_FAILED');
    // A dish/group-buy direction requires its visual evidence; otherwise fail rather than weaken its claim silently.
    const originalCore = task.analysis.filter(item => selection.imageIds.includes(item.imageId) && item.imageType === 'food');
    if (originalCore.length && /菜|餐|面|食|团购/.test(selection.direction.label) && !selected.some(item => item.imageType === 'food')) throw new RestaurantError('核心菜品图片处理失败，请重试或选择其他方向。', 502, 'CORE_IMAGE_FAILED');
    await store.patchTask(userId, id, { status: 'generating', progress: { stage: 'copy' }, removedImageIds: selection.imageIds.filter(imageId => !processed.has(imageId)) });
    // Let writing and review see a few actual final photos, with removed edge risks already cropped.
    // The full structured analysis remains available for every selected photo.
    const photos = await Promise.all(selected.slice(0, 3).map(async item => {
      const result = processed.get(item.imageId);
      const photo = imageProcessor.prepareAnalysisPhoto ? await imageProcessor.prepareAnalysisPhoto(result.bytes) : { bytes: result.bytes, mime: 'image/jpeg' };
      return { id: item.imageId, dataUrl: `data:${photo.mime};base64,${photo.bytes.toString('base64')}` };
    }));
    let copy, review, copyQuality;
    for (let revision = 0; revision < 2; revision++) {
      const draft = copy, qualityIssues = review?.errors ?? [];
      if (revision) await store.patchTask(userId, id, { progress: { stage: 'copy_refining' } });
      // Only complete, known drafts can be rewritten. Uncertain provider errors propagate without replay.
      copy = validateCopy(await model.write({ profile: task.profileSnapshot, analysis: selected, direction: selection.direction, facts: selection.facts, photos,
        ...(draft ? { draft, qualityIssues } : {}) }), selected.map(item => item.imageId));
      if (copy.imageOrder.length !== selected.length) throw new RestaurantError('文案返回的图片顺序不完整。', 502, 'MODEL_INVALID_OUTPUT');
      const quality = inspectCopyQuality(copy, { profile: task.profileSnapshot, analysis: selected, direction: selection.direction });
      copyQuality = { ...quality, revisionCount: revision };
      const local = localReview(copy, task.profileSnapshot, selection.facts, selected);
      // Avoid another paid review for an already rejected draft, but never relax factual checks.
      const audit = quality.passed && !local.errors.length
        ? validateAudit(await model.audit({ copy, profile: task.profileSnapshot, confirmedFacts: selection.facts, direction: selection.direction, images: selected, photos }))
        : { status: 'passed', errors: [], warnings: [] };
      const errors = [...new Set([...local.errors, ...quality.issues, ...audit.errors])], warnings = [...new Set([...local.warnings, ...audit.warnings])];
      if (audit.status === 'blocked' && !errors.length) errors.push('发布文案检查未通过，请调整消费主题或核对资料。');
      review = { status: errors.length ? 'blocked' : warnings.length || audit.status === 'passed_with_warning' ? 'passed_with_warning' : 'passed', errors, warnings };
      if (review.status !== 'blocked') break;
      if (revision === 1) {
        await store.releasePackage(userId, id);
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
    } else await store.completeTask(userId, id, { ...result, progress: null, completedAt: now() });
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
    try {
      created = await store.createTask(userId, { id: requestId, fingerprint: fp, forkFrom: old.id, profileSnapshot: old.profileSnapshot, sourceImages,
        analysis: old.analysis, directions: old.directions, sparsePhotos: old.sparsePhotos, rightsConfirmed: true, status: 'uploading', files: [] });
      for (const source of old.sourceImages) {
        const bytes = await media.get(userId, old.id, source.key);
        const key = scopedKey(userId, requestId, `originals/${source.filename}`);
        await media.put(userId, requestId, key, bytes); originals.push(key);
      }
      return await store.patchTask(userId, requestId, { status: 'awaiting_selection' });
    } catch (cause) { for (const key of originals) await media.remove(userId, requestId, key).catch(() => {}); if (created) await fail(userId, requestId, cause); throw cause; }
  }
  async function startGenerate(userId, task, body) {
    if (ACTIVE.has(task.status) || task.status === 'awaiting_confirmation') return task;
    if (task.status === 'completed') {
      // A repeated exact request returns its charged task, while a new direction is a new task.
      if (task.selection?.directionId === body.directionId && task.selection?.imageMode === (body.imageMode ?? body.processingMode ?? 'natural') && fingerprint(task.selection?.facts ?? {}) === fingerprint(resolveDirectionFacts(task.selection.direction, task.profileSnapshot, normalizeFacts(body.facts)))) return task;
      task = await cloneTask(userId, task, body.requestId ?? randomUUID());
    }
    if (!['awaiting_selection', 'awaiting_facts'].includes(task.status)) throw new RestaurantError('请先完成照片分析，或返回重新上传照片。', 409, 'TASK_STATE');
    const direction = task.directions.find(item => item.id === body.directionId);
    if (!direction) throw new RestaurantError('请选择有效的内容方向。');
    const facts = resolveDirectionFacts(direction, task.profileSnapshot, normalizeFacts(body.facts)), missingFacts = pendingFacts(direction, task.profileSnapshot, facts);
    if (missingFacts.length) return await store.patchTask(userId, task.id, { status: 'awaiting_facts', missingFacts, selectedDirectionId: direction.id });
    if (task.sparsePhotos && body.acceptSparse !== true && body.allowFewImages !== true) throw new RestaurantError('可用照片较少，请确认继续生成简版图文。', 422, 'SPARSE_CONFIRMATION_REQUIRED');
    const imageMode = body.imageMode ?? body.processingMode ?? 'natural';
    if (!['natural', 'cover'].includes(imageMode)) throw new RestaurantError('请选择自然美化或封面加字。');
    const imageIds = direction.supportingImageIds.filter(id => task.analysis.find(item => item.imageId === id)?.usable);
    if (!imageIds.length) throw new RestaurantError('该方向没有可用照片，请更换方向。', 422);
    await store.reservePackage(userId, task.id);
    const claimed = await store.claimTask(userId, task.id, ['awaiting_selection', 'awaiting_facts'], { status: 'generating', selection: { directionId: direction.id, direction, facts, imageMode, imageIds }, missingFacts: [], error: null, code: null });
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
          try {
            created = await store.createTask(userId, { id: body.requestId, requestId: body.requestId, fingerprint: fp, profileSnapshot: profile, sourceImages, analysis: [], directions: [], files: [], rightsConfirmed: true, status: 'uploading' });
            for (const source of sourceImages) {
              await media.put(userId, body.requestId, source.key, inspected.find(photo => photo.id === source.id).bytes); uploaded.push(source.key);
            }
            const uploadedTask = await store.patchTask(userId, body.requestId, { status: 'analysing' });
            launch(userId, created.id, () => analyseTask(userId, created.id)); return uploadedTask;
          } catch (cause) { for (const key of uploaded) await media.remove(userId, body.requestId, key).catch(() => {}); if (created) await fail(userId, body.requestId, cause); throw cause; }
        });
        reply(res, 202, { task: publicTask(task) }); return true;
      }
      const match = /^\/api\/restaurant\/tasks\/([^/]+)(?:\/(generate|retry|confirm|fork|files)(?:\/([^/]+))?)?$/.exec(path);
      if (match) {
        const [, id, action, filename] = match;
        if (req.method === 'GET' && !action) { reply(res, 200, { task: publicTask(await taskFor(userId, id)) }); return true; }
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
        if (req.method === 'POST' && ['generate', 'retry', 'confirm', 'fork'].includes(action)) {
          const body = await readJSON(req);
          const result = await exclusive(userId, async () => {
            const task = await taskFor(userId, id);
            if (action === 'generate') return startGenerate(userId, task, body);
            if (action === 'fork') return cloneTask(userId, task, body.requestId);
            if (action === 'confirm') {
              if (task.status === 'completed') return task;
              if (task.code === 'FILES_EXPIRED' || task.files?.some(file => file.expired || file.expiresAt <= now())) throw new RestaurantError('结果文件已过期，请重新上传。', 410, 'FILES_EXPIRED');
              if (task.status !== 'awaiting_confirmation' || body.confirmWarnings !== true) throw new RestaurantError('请确认本次结果的全部风险提示。', 422, 'WARNING_CONFIRMATION_REQUIRED');
              if (!task.files?.length || task.files.some(file => file.expiresAt <= now())) throw new RestaurantError('结果文件已过期，请重新上传。', 410, 'FILES_EXPIRED');
              return store.completeTask(userId, id, { warningsConfirmedAt: now(), completedAt: now() });
            }
            if (task.status !== 'failed' || task.retryable === false) throw new RestaurantError('该任务不能直接重试，请核对提示或重新上传。', 409, task.code === 'PROVIDER_UNCERTAIN' ? 'PROVIDER_UNCERTAIN' : 'TASK_STATE');
            await loadSources(userId, task);
            if (task.selection) {
              await store.reservePackage(userId, id);
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
  handler.shutdown = () => shutdownPromise ||= (async () => { closing = true; clearInterval(cleanupTimer); await ready.catch(() => {}); await Promise.allSettled([...serial.values()]); await Promise.allSettled([...running]); await model.close?.(); await store.close?.(); })();
  handler.store = store;
  return handler;
}
