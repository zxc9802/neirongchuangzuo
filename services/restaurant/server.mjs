import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { loadAIConfig } from '../ai/server.mjs';
import { createApiCostMeter } from '../credits/meter.mjs';
import { createRestaurantStore, FILES_TTL_MS } from './store.mjs';
import { createRestaurantMedia } from './media.mjs';
import { createThumbnailCache, sendThumbnail } from '../assets/thumbnails.mjs';
import * as images from './images.mjs';
import * as promotion from './promotion.mjs';
import { foodScene, foodPhotoPlan } from './scenes.mjs';
import { createSubjectMasker } from './subject-mask.mjs';
import { createRestaurantModel } from './model.mjs';
import { createStyleRecipes } from './style-recipes.mjs';
import { createGalleryQueue, GALLERY_CONCURRENCY } from './gallery-queue.mjs';
import { displayModelName } from '../../design/model-labels.js';
import { inspectCopyQuality } from './copy-quality.mjs';
import { GALLERY_WORKFLOW, galleryDirection, createGalleryPlan, validateGalleryStoryboard, storeSceneContext, galleryShot, prepareGalleryReference, isolateDishReference } from './gallery.mjs';
import { galleryContactSheets, validateGalleryImageReview, validateGallerySetReview } from './art-direction.mjs';
import { contentRequest, contentDirection, validateContentStoryboard, repairContentStoryboard, composeContentPage, gradeContentScene, DEFAULT_RESTAURANT_OUTPUT_COUNT } from './content-sets.mjs';
import { prepareMaterialComposition, finishMaterialPage, materialClaimIssues, repairMaterialCopy } from './content-materials.mjs';
import { contentReferences } from './content-references.mjs';
import { RestaurantError, UUID, fingerprint, normalizeProfile, requireProfile, normalizeFacts, resolveDirectionFacts, pendingFacts, validateAnalysis, validateDirections, validateCopy, validateAudit, localReview, validateFoodAppearance, validateFoodRenderReview } from './rules.mjs';

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
  store: injectedStore, media: injectedMedia, model: injectedModel, providerLedger, credits, mediaEnv = process.env, imageProcessor = images, promotionalProcessor = promotion, subjectMasker: injectedMasker, packageDailyLimit = Number(process.env.RESTAURANT_PACKAGE_DAILY_LIMIT || 20), cleanupIntervalMs = 60_000,
  requireAuth = process.env.NODE_ENV === 'production', logger = console, styleRecipes = createStyleRecipes(), galleryConcurrency = GALLERY_CONCURRENCY } = {}) {
  const galleryQueue = createGalleryQueue(galleryConcurrency);
  const thumbnails = createThumbnailCache();
  const costMeter = createApiCostMeter({credits,config,fetchImpl});
  fetchImpl = costMeter.fetch;
  const store = injectedStore ?? createRestaurantStore({ dataDir, databaseUrl, now, packageDailyLimit });
  const rawMedia = injectedMedia ?? createRestaurantMedia({ dataDir, now, env: mediaEnv });
  const scopedKey = (userId, taskId, key) => `${fingerprint(userId).slice(0, 32)}/${taskId}/${key}`;
  const media = { ready: rawMedia.ready,
    put: (_userId, _taskId, key, bytes) => rawMedia.put(key, bytes),
    get: (_userId, _taskId, key) => rawMedia.get(key),
    remove: (_userId, _taskId, key) => rawMedia.remove(key) };
  const model = injectedModel ?? createRestaurantModel({ config, storageDir: join(dataDir, 'model-control'), fetchImpl, now, ledger: providerLedger });
  const subjectMasker = injectedMasker ?? createSubjectMasker({ env: mediaEnv });
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
    const { userId, fingerprint: ignored, uploadBatches: ignoredBatches, uploadedBytes: ignoredBytes, pendingUpload: ignoredPending, galleryCheckpoints: ignoredCheckpoints, styleRecipe: ignoredRecipe, ...output } = task;
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
    if (costMeter.enabled && (!task.billing || task.billing.mode==='api_cost' || ['released','settled'].includes(task.billing.status))) return ensureCostTask(userId,task);
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
    if (saved?.kind === 'api-cost' && saved.status === 'reserved') await costMeter.reconcile({userId,taskId:task.billing.taskId});
    if (saved?.status === 'settled') { await store.patchTask(userId, task.id, { billing: { ...task.billing, status: 'settled', chargedPoints: saved.chargedPoints, exempt: saved.exempt === true } }); return; }
    const record = saved ? await credits.release({ userId, taskId: task.billing.taskId }) : null;
    await store.patchTask(userId, task.id, { billing: { ...task.billing, status: record?.status || 'released', chargedPoints: record?.chargedPoints || 0,
      ...(record?.kind==='api-cost'?{mode:'api_cost',costCny:(record.settledUnits||0)/1e6}:{}) } });
  }
  async function completeWithCredits(userId, id, patch = {}) {
    const task = await taskFor(userId, id);
    if (!credits || task.billing?.source !== 'workspace') return store.completeTask(userId, id, patch);
    if (task.status === 'completed' && !task.billing.costConfirmationPending) return task;
    const files = patch.files ?? task.files ?? [];
    const units = files.filter(file => /^image\//.test(file.mime)).length;
    if (!units || files.some(file => file.expired || file.expiresAt <= now())) throw new RestaurantError('成品已过期，无法结算，请重新生成。', 410, 'FILES_EXPIRED');
    const pending = task.status==='completed' ? task : await store.patchTask(userId, id, { ...patch, status: 'generating', progress: { stage: 'credits_settlement' }, billing: { ...task.billing, status: 'settle_pending', deliveredUnits: units } });
    let record;
    try {
      if (task.billing.mode === 'api_cost') await costMeter.reconcile({userId,taskId:task.billing.taskId});
      record = task.billing.mode==='api_cost' ? await credits.settleCost({userId,taskId:task.billing.taskId}) : await credits.settle({ userId, taskId: task.billing.taskId, units });
    }
    catch (cause) {
      if (task.billing.mode!=='api_cost' || cause.code!=='COST_CONFIRMATION_PENDING') throw cause;
      const saved=await credits.reservation(userId,task.billing.taskId),wallet=await credits.snapshot(userId);
      if (saved?.exempt!==true || wallet.unlimited!==true) throw cause;
      if(task.status==='completed') return task;
      return store.completeTask(userId,id,{billing:{...pending.billing,exempt:true,chargedPoints:0,costConfirmationPending:true},progress:null,error:null,code:null,completedAt:now()});
    }
    const settled = { billing: { ...pending.billing, status: 'settled', chargedPoints: record.chargedPoints, reservedPoints: record.reservedPoints, exempt: record.exempt === true, costConfirmationPending:false,
      ...(record.kind==='api-cost'?{costCny:(record.settledUnits||0)/1e6}:{}) }, progress: null, error: null, code: null, completedAt: task.completedAt || now() };
    return task.status==='completed' ? store.patchTask(userId,id,settled) : store.completeTask(userId, id, settled);
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
  async function ensureCostTask(userId,task) {
    if (task.billing?.mode==='api_cost' && !['settled','released'].includes(task.billing.status)) return task;
    const attempt=(task.costAttempt||0)+1, taskId=`${task.id}-cost-${attempt}`;
    const record=await credits.reserveCost({userId,taskId});
    return store.patchTask(userId,task.id,{costAttempt:attempt,billing:{source:'workspace',mode:'api_cost',taskId,status:record.status,
      reservedPoints:record.reservedPoints,chargedPoints:record.chargedPoints,exempt:record.exempt===true}});
  }
  function launch(userId, id, operation) {
    const work = Promise.resolve().then(async()=>{
      if (!costMeter.enabled) return operation();
      let task=await taskFor(userId,id);
      const legacy=task.billing?.source==='workspace' && task.billing.mode!=='api_cost' && !['released','settled'].includes(task.billing.status);
      if (!legacy) task=await ensureCostTask(userId,task);
      await costMeter.run({userId,taskId:task.billing?.taskId,legacy},operation);
      const after=await taskFor(userId,id);
      if(after.status==='failed') await releaseTaskCredits(userId,after);
    }).catch(cause => fail(userId, id, cause)).catch(() => report('TASK_SAVE_FAILED'));
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
  async function auditContentStoryboard(userId, task, storyboard, photos, usable = task.analysis) {
    if (!model.auditContentFacts) return storyboard;
    await store.patchTask(userId,task.id,{progress:{stage:'planning',message:'正在核对图片文字。'}});
          const audit = async board => {
            const issues=board.version===4?materialClaimIssues(board,task):[];
            if(issues.length)return {status:'blocked',errors:issues,warnings:[]};
            return model.auditContentFacts({ profile: task.profileSnapshot, confirmedFacts: task.contentFacts || {},
            pages: board.pages.map(page=>({...page,evidence:(board.version === 4 ? page.materials : page.assetIds.map(imageId=>({assetId:imageId,sourceImageId:board.shots.find(shot=>shot.imageId===imageId).sourceImageId}))).map(material=>{
              const source=usable.find(item=>item.imageId===material.sourceImageId);
              return {...material,imageType:source?.imageType,visibleObjects:source?.visibleObjects||[],visibleTexts:source?.visibleTexts||[]};
            })})) }, { onBudgetWait: () => store.patchTask(userId, task.id, { progress: { stage: 'planning', message: '正在核对图片文字。' } }) });
          };
          let review = await audit(storyboard);
          if(review.status==='blocked' && storyboard.version===4 && model.repairContentCopy) {
            const fixed=await model.repairContentCopy({contentType:task.contentType,profile:task.profileSnapshot,confirmedFacts:task.contentFacts || {},
              pages:storyboard.pages.map(p=>({imageId:p.imageId,role:p.role,headline:p.headline,subtitle:p.subtitle,factKeys:p.factKeys})),issues:review.errors},
              {validateResult:value=>repairMaterialCopy(value,storyboard,task)});
            storyboard={...repairMaterialCopy(fixed,storyboard,task),factsRevisionCount:1};review=await audit(storyboard);
          } else if (review.status === 'blocked' && model.repairContentLayout) {
            const fixedAssets = storyboard.shots.map(shot => ({ imageId: shot.imageId, sourceImageId: shot.sourceImageId, name: shot.name, purpose: shot.purpose }));
            const oldPages = storyboard.pages.map(page => ({ ...page, assetIndexes: page.assetIds.map(id => fixedAssets.findIndex(asset => asset.imageId === id)) }));
            const repaired = await model.repairContentLayout({ contentType: task.contentType, profile: task.profileSnapshot, confirmedFacts: task.contentFacts || {}, fixedAssets,
              version:storyboard.version,visualStyle:storyboard.visualStyle,graphicStyle:storyboard.graphicStyle,images:usable,requestedOutputCount:storyboard.outputCount,
              pages: oldPages, issues: review.errors, photos }, { validateResult: value => repairContentStoryboard(value, storyboard, task) });
            storyboard = { ...repairContentStoryboard(repaired, storyboard, task), source: 'ai', factsRevisionCount: 1 };
            review = await audit(storyboard);
          }
          await store.patchTask(userId, task.id, { contentFactsReview: review });
          if (review.status === 'blocked') throw new RestaurantError(`图片方案包含未确认信息：${review.errors.join('；')}`, 422, 'CONTENT_FACTS_BLOCKED');
    return storyboard;
  }
  async function ensureGalleryStoryboard(userId, task, outputCount) {
    const excluded = new Set(task.foodReferenceExclusions || []);
    if (task.galleryStoryboard?.visualStyle && (!task.contentType || task.galleryStoryboard.contentType === task.contentType && task.galleryStoryboard.pages?.length === outputCount
      && (task.galleryStoryboard.version === 4 || !model.renderContentPage))
      && task.galleryStoryboard.outputCount === outputCount && task.galleryStoryboard.shots.every(shot => shot.kind !== 'food' || !excluded.has(shot.sourceImageId))) return task;
    task = { ...task, galleryStoryboard: null };
    if (task.contentType ? !model.planContentSet : !model.planGallery) throw new RestaurantError('尚未配置套图摄影策划服务。', 503, 'MODEL_NOT_CONFIGURED');
    await store.patchTask(userId, task.id, { progress: { stage: 'planning', message: '正在编排整套宣传图片。' } });
    let storyboard;
    try {
      const sources = await loadSources(userId, task);
      const usable = task.analysis.filter(item => item.usable && item.privacyRisk !== 'high' && item.textRisk !== 'high'
        && (item.imageType !== 'food' || !excluded.has(item.imageId)));
      const photos = await galleryContactSheets(sources.filter(source => usable.some(item => item.imageId === source.id)));
      const accepted = await styleRecipes.directorReferences?.(task.styleRecipe) ?? [];
      const acceptedSheets = accepted.length ? await galleryContactSheets(accepted, 'accepted') : [];
      photos.push(...acceptedSheets);
      const food = usable.find(item => item.imageType === 'food');
      if (food && photos.length < 4) {
        const source = sources.find(photo => photo.id === food.imageId), prepared = await imageProcessor.prepareAnalysisPhoto(source.bytes);
        photos.push({ ...prepared, id: source.id, dataUrl: `data:${prepared.mime};base64,${prepared.bytes.toString('base64')}` });
      }
      if (task.contentType) {
        const reference = await contentReferences(task.contentType);
        photos.push(...await galleryContactSheets(reference.images,'type-reference'));
        const validate = value => {
          if(model.renderContentPage && value?.version !== 4) throw new RestaurantError('请返回version=4的真实素材合成方案。',502,'INVALID_GALLERY_STORYBOARD');
          return {...validateContentStoryboard(value, { ...task, analysis: usable }, outputCount),referenceSet:reference.binding};
        };
        storyboard = { ...validate(await model.planContentSet({ contentType: task.contentType, profile: task.profileSnapshot,
          confirmedFacts: task.contentFacts || {}, images: usable, requestedOutputCount: outputCount, photos,referenceSet:reference.binding,
          contactSheets: photos.filter(photo => photo.imageIds).map(photo => ({ sheetId: photo.id, imageIds: photo.imageIds })) }, {
          validateResult: validate, onBudgetWait: () => store.patchTask(userId, task.id, { progress: { stage: 'planning', message: '正在编排页面。' } }) })), source: 'ai' };
        storyboard = await auditContentStoryboard(userId, task, storyboard, photos, usable);
      } else storyboard = { ...validateGalleryStoryboard(await model.planGallery({ analysis: usable, profile: task.profileSnapshot, outputCount, photos,
        approvedStyles: accepted.map(photo => ({ sourceImageId: photo.sourceImageId, style: photo.style })) }, {
        validateResult: value => validateGalleryStoryboard(value, task, outputCount, { requireStyle: true }),
        onBudgetWait: () => store.patchTask(userId, task.id, { progress: { stage: 'planning', message: '正在排队编排套图。' } }) }), task, outputCount, { requireStyle: true }), source: 'ai' };
    } catch (cause) {
      logger.warn({ event: 'gallery-planning-failed', code: cause.code || 'PLANNING_UNAVAILABLE' });
      throw cause;
    }
    return store.patchTask(userId, task.id, { galleryStoryboard: storyboard });
  }
  async function analyseTask(userId, id) {
    let task = await taskFor(userId, id);
    const sources = await loadSources(userId, task);
    if (task.autoGenerate && !task.styleRecipe && !task.analysis?.length) {
      const binding = await styleRecipes.match(sources);
      if (binding) task = await store.patchTask(userId, id, { styleRecipe: binding });
    }
    const analysis = [...(task.analysis ?? [])];
    const onBudgetWait = () => store.patchTask(userId, id, { progress: { stage: 'waiting_for_budget', current: analysis.length, total: sources.length, message: '共享请求较多，正在排队等待继续分析。' } });
    const batchSize = task.autoGenerate ? 2 : 3;
    for (let start = analysis.length; start < sources.length; start += batchSize) {
      const batch = [];
      for (const source of sources.slice(start, start + batchSize)) {
        const prepared = imageProcessor.prepareAnalysisPhoto ? await imageProcessor.prepareAnalysisPhoto(source.bytes) : { bytes: source.bytes, mime: source.mime };
        batch.push({ ...source, dataUrl: `data:${prepared.mime};base64,${prepared.bytes.toString('base64')}` });
      }
      analysis.push(...validateAnalysis({ images: await model.analyse(batch, task.profileSnapshot, { onBudgetWait, gallery: task.autoGenerate === true }) }, batch.map(item => item.id)));
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
    if (task.contentType) contentDirection(task, analysis);
    if (task.autoGenerate) createGalleryPlan(await ensureGalleryStoryboard(userId, { ...task, analysis }, task.requestedOutputCount), task.requestedOutputCount);
    const directions = task.autoGenerate
      ? validateDirections({ directions: [task.contentType ? contentDirection(task, analysis) : { ...galleryDirection(analysis, task.profileSnapshot), ...(task.styleRecipe ? { label: '实拍氛围摄影', contentGoal: '保持已确认的摄影风格，逐张美化实拍', supportingImageIds: analysis.filter(item => item.usable).map(item => item.imageId) } : {}) }] }, analysis, task.profileSnapshot)
      : validateDirections({ directions: await model.recommend(analysis, task.profileSnapshot, { onBudgetWait }) }, analysis, task.profileSnapshot);
    await store.patchTask(userId, id, { analysis, directions, sparsePhotos: usable.length <= 2, status: directions.length ? 'awaiting_selection' : 'failed', progress: null,
      ...(directions.length ? { message: usable.length <= 2 ? '当前可用照片较少，可以生成简版图文；补充菜品、环境或消费场景照片后，内容会更完整。' : '', error: null } : { code: 'NO_RELIABLE_DIRECTION', retryable: false, error: '没有可靠的内容方向，请补充照片或门店资料。' }) });
    if (task.autoGenerate && directions.length) {
      await exclusive(userId, async () => startGenerate(userId, await taskFor(userId, id), { directionId: directions[0].id,
        imageMode: 'promotional', outputCount: task.requestedOutputCount, workflow: GALLERY_WORKFLOW, acceptSparse: true, facts: task.contentFacts || {} }));
    }
  }
  async function process(userId, task, photo, options) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return options?.promotional
        ? await promotionalProcessor.processPromotionalPhoto(photo.bytes, { ...options, mask: bytes => subjectMasker.mask(bytes) })
        : await imageProcessor.processPhoto(photo.bytes, options); }
      catch (cause) {
        if (cause.code && /^(?:FOOD_|PROVIDER_|MODEL_|DAILY_QUOTA_EXCEEDED|RATE_LIMITED|SERVICE_CLOSING|AI_|REQUEST_)/.test(cause.code)) throw cause;
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
      files.push({ key, filename, mime: 'image/jpeg', role: 'image', imageId: copy.imageOrder[index], bytes: result.bytes.length, expiresAt, width: result.width, height: result.height,
        ...(result.composition ? { composition: result.composition, sourceImageId: result.composition.sourceImageId } : {}) });
    }
    const zip = await imageProcessor.createPackageZip(copy.imageOrder.map(imageId => ({ ...processed.get(imageId) })), { ...copy, hashtags: copy.tags.map(tag => `#${tag}`), store: task.profileSnapshot.name, risks: review.warnings, review,
      cleanExport: task.selection?.workflow === GALLERY_WORKFLOW });
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
    if (selection.workflow === GALLERY_WORKFLOW) return generateGalleryTask(userId, task);
    const sources = await loadSources(userId, task);
    const candidates = [...selection.imageIds, ...(selection.backupImageIds ?? [])].map(imageId => task.analysis.find(item => item.imageId === imageId)).filter(Boolean);
    let selected = [];
    const processed = new Map();
    const targetCount = selection.outputCount ?? selection.imageIds.length;
    const promoSeed = `${task.id}:${selection.directionId}`;
    const onBudgetWait = () => store.patchTask(userId, id, { progress: { stage: 'waiting_for_budget', message: '共享请求较多，正在排队等待继续生成。' } });
    const foodRenders = new Map();
    let shotIndex = 0;
    const renderFood = model.renderFood ? (analysis, source) => {
      if (!foodRenders.has(analysis.imageId)) foodRenders.set(analysis.imageId, (async () => {
        const scene = foodScene(analysis, task.profileSnapshot, selection.facts), plan = foodPhotoPlan(scene, shotIndex++);
        const reference = { ...await imageProcessor.prepareAnalysisPhoto(source.bytes), id: analysis.imageId };
        reference.dataUrl = `data:${reference.mime};base64,${reference.bytes.toString('base64')}`;
        await store.patchTask(userId, id, { status: 'generating', progress: { stage: 'food_identity', imageId: analysis.imageId } });
        const appearance = validateFoodAppearance(analysis.foodAppearance || await model.identifyFood({ analysis, photos: [reference] }, { onBudgetWait }));
        analysis.foodAppearance = appearance;
        await store.patchTask(userId, id, { analysis: task.analysis, progress: { stage: 'food_render', imageId: analysis.imageId, shot: plan.name } });
        let corrections = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await model.renderFood({ scene, photo: reference, appearance, plan, taskId: id, imageId: analysis.imageId, attempt, corrections }, { onBudgetWait });
          const preview = await imageProcessor.prepareAnalysisPhoto(result.bytes);
          const review = validateFoodRenderReview(await model.reviewFoodRender({ sourceImageId: analysis.imageId, foodAppearance: appearance, scene: { type: scene.type, name: scene.name }, plan,
            photos: [reference, { id: 'generated-food', dataUrl: `data:${preview.mime};base64,${preview.bytes.toString('base64')}` }] }, { onBudgetWait }));
          if (review.status === 'passed') {
            return { ...result, scene, plan, review };
          }
          corrections = review.errors;
          await store.patchTask(userId, id, { status: 'retrying', progress: { stage: 'food_consistency', imageId: analysis.imageId, retry: attempt + 1 } });
        }
        throw new RestaurantError('菜品重拍后仍有明显差异，未交付本套内容，也未扣除生成积分。', 502, 'FOOD_IDENTITY_MISMATCH');
      })());
      return foodRenders.get(analysis.imageId);
    } : undefined;
    for (const item of candidates) {
      if (processed.size >= targetCount) break;
      const source = sources.find(photo => photo.id === item.imageId);
      try { processed.set(item.imageId, await process(userId, task, source, { ...(item.crop ? { crop: item.crop } : {}),
        ...(selection.imageMode === 'promotional' ? { promotional: true, analysis: item, renderFood, seed: promoSeed, index: processed.size, label: selection.direction.label, storeName: task.profileSnapshot.name } : {}) })); selected.push(item); }
      catch (cause) {
        if (cause.code && /^(?:FOOD_|PROVIDER_|MODEL_|DAILY_QUOTA_EXCEEDED|RATE_LIMITED|SERVICE_CLOSING|AI_|REQUEST_)/.test(cause.code)) throw cause;
      }
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
    const photos = await Promise.all(selected.slice(0, 4).map(async item => {
      // Designed backgrounds are not evidence of the store's actual environment.
      const result = selection.imageMode === 'promotional'
        ? await imageProcessor.preparePhotoPixels(sources.find(source => source.id === item.imageId).bytes, { crop: item.crop })
        : processed.get(item.imageId);
      const photo = imageProcessor.prepareAnalysisPhoto ? await imageProcessor.prepareAnalysisPhoto(result.bytes) : { bytes: result.bytes, mime: 'image/jpeg' };
      return { id: item.imageId, dataUrl: `data:${photo.mime};base64,${photo.bytes.toString('base64')}` };
    }));
    let copy, review, copyQuality;
    for (let revision = 0; revision < 2; revision++) {
      const draft = copy, qualityIssues = review?.errors ?? [];
      if (revision) await store.patchTask(userId, id, { progress: { stage: 'copy_refining' } });
      // Only complete, known drafts can be rewritten. Uncertain provider errors propagate without replay.
      copy = validateCopy(await model.write({ profile: task.profileSnapshot, analysis: selected, direction: selection.direction, facts: selection.facts, photos, imageMode: selection.imageMode,
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
    if (selection.imageMode === 'promotional') {
      for (const [index, imageId] of copy.imageOrder.entries()) {
        const item = selected.find(item => item.imageId === imageId);
        const label = index === 0 ? copy.coverText : copy.imageCaptions?.find(caption => caption.imageId === imageId)?.text
          || (item.imageType === 'food' ? '分享店里的这一份好味' : '看看我们店里的日常');
        processed.set(imageId, await promotionalProcessor.addPromotionalHeadline(processed.get(imageId), label, promoSeed, { index }));
      }
    } else if (selection.imageMode === 'cover') {
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
  async function generateMaterialTask(userId,task) {
    if (!model.renderContentPage || !model.reviewContentSet) throw new RestaurantError('尚未配置素材合成与审美服务。',503,'MODEL_NOT_CONFIGURED');
    const sources=await loadSources(userId,task),processed=new Map(),checkpoints=[...(task.galleryCheckpoints || [])];
    let board=task.galleryStoryboard;
    if(!['passed','passed_with_warning'].includes(task.contentFactsReview?.status)) {
      board=await auditContentStoryboard(userId,task,board,await galleryContactSheets(sources));
      task=await store.patchTask(userId,task.id,{galleryStoryboard:board});
    }
    const planFingerprint=fingerprint({version:4,board}),reference=await contentReferences(task.contentType);
    let bookkeeping=Promise.resolve(),failure,next=0,reusedPages=0;
    const update=operation=>{const work=bookkeeping.then(operation);bookkeeping=work.catch(()=>{});return work;};
    const progress=(stage,message)=>({stage,current:processed.size,total:board.pages.length,message});
    const onBudgetWait=()=>update(()=>store.patchTask(userId,task.id,{progress:progress('waiting_for_budget','正在等待图片服务')}));
    const render=async(page,{attempt=0,corrections=[],reuse=true}={})=>{
      if(reuse) {
        const saved=checkpoints.find(c=>c.imageId===page.imageId && c.planFingerprint===planFingerprint && c.status==='ready' && !c.expired && c.expiresAt>now());
        if(saved) {const bytes=await media.get(userId,task.id,saved.key);if(bytes && fingerprint(bytes.toString('base64'))===saved.hash){processed.set(page.imageId,{bytes,width:1080,height:1440,format:'jpeg',composition:saved.composition});reusedPages++;return;}}
      }
      await update(()=>store.patchTask(userId,task.id,{status:attempt?'retrying':'generating',progress:progress('gallery_image','正在组合实拍素材')}));
      const {draft,parts}=await prepareMaterialComposition(page,sources,board.graphicStyle);
      const rendered=await model.renderContentPage({draft,parts,page,visualStyle:board.visualStyle,taskId:task.id,attempt,corrections},{onBudgetWait});
      const result=await finishMaterialPage(rendered.bytes,page,board,{requestId:rendered.requestId});
      const key=scopedKey(userId,task.id,`working/material-${planFingerprint.slice(0,16)}-${page.imageId}-${attempt}.jpg`);
      const checkpoint={imageId:page.imageId,key,attempt,planFingerprint,expiresAt:now()+FILES_TTL_MS,hash:fingerprint(result.bytes.toString('base64')),width:1080,height:1440,composition:result.composition,status:'pending'};
      await protectMediaGroup([key],async()=>{
        await update(async()=>{const i=checkpoints.findIndex(c=>c.imageId===page.imageId);if(i>=0)checkpoints[i]=checkpoint;else checkpoints.push(checkpoint);await store.patchTask(userId,task.id,{galleryCheckpoints:checkpoints});});
        await media.put(userId,task.id,key,result.bytes);
        await update(async()=>{checkpoint.status='ready';processed.set(page.imageId,result);await store.patchTask(userId,task.id,{galleryCheckpoints:checkpoints,progress:progress('gallery_image','正在组合实拍素材')});});
      });
    };
    const dispatch=async(pages,options)=>{
      next=0;failure=null;
      await Promise.all(Array.from({length:Math.min(galleryConcurrency,pages.length)},async()=>{
        while(!failure && !closing && next<pages.length) {
          const page=pages[next++];
          await galleryQueue(async()=>{if(failure || closing)return;try{await render(page,options);}catch(cause){if(!failure || cause.code==='PROVIDER_UNCERTAIN')failure=cause;}});
        }
      }));
      if(failure)throw failure;
      if(closing)throw new RestaurantError('服务正在关闭，尚未开始的图片已停止生成。',503,'SERVICE_CLOSING');
    };
    await dispatch(board.pages,{});
    const sourceIds=new Set(board.pages.flatMap(p=>p.materials.map(m=>m.sourceImageId))),evidence=task.analysis.filter(a=>sourceIds.has(a.imageId));
    const audit=async()=>{
      await store.patchTask(userId,task.id,{progress:progress('gallery_set_review','正在检查整套素材合成效果')});
      const photos=[...await galleryContactSheets(sources.filter(s=>sourceIds.has(s.id))),...await galleryContactSheets(reference.images,'type-reference'),
        ...await galleryContactSheets(board.pages.map(p=>({id:p.imageId,bytes:processed.get(p.imageId).bytes})),'pages')];
      for(const page of board.pages.filter(p=>p.text.mode!=='none')) {
        const prepared=await imageProcessor.prepareAnalysisPhoto(processed.get(page.imageId).bytes);
        photos.push({...prepared,id:page.imageId+'-text-proof',dataUrl:`data:${prepared.mime};base64,${prepared.bytes.toString('base64')}`});
      }
      const review=validateGallerySetReview(await model.reviewContentSet({version:4,contentType:task.contentType,profile:task.profileSnapshot,confirmedFacts:task.contentFacts || {},
        visualStyle:board.visualStyle,pages:board.pages,referenceSet:board.referenceSet,photos},{onBudgetWait}),board.pages.map(p=>p.imageId));
      await store.patchTask(userId,task.id,{contentPageReview:review,gallerySetReview:review});return review;
    };
    let review=reusedPages===board.pages.length && task.contentPageReview?.status==='blocked'
      ? validateGallerySetReview(task.contentPageReview,board.pages.map(p=>p.imageId)) : await audit();
    const revisionBase=Math.max(0,...checkpoints.map(c=>Number.isInteger(c.attempt)?c.attempt:0));
    for(let attempt=1;review.status==='blocked' && attempt<=2;attempt++) {
      await dispatch(board.pages.filter(p=>review.reviseImageIds.includes(p.imageId)),{attempt:revisionBase+attempt,corrections:review.errors,reuse:false});
      review=await audit();
    }
    if(review.status==='blocked')throw new RestaurantError(`素材合成检查未通过：${review.errors.join('；')}`,502,'CONTENT_PAGE_REVIEW_FAILED');
    const referenceFor=async imageId=>{const source=sources.find(s=>s.id===imageId),prepared=await imageProcessor.prepareAnalysisPhoto(source.bytes);return {...prepared,id:imageId,dataUrl:`data:${prepared.mime};base64,${prepared.bytes.toString('base64')}`};};
    return finishGalleryResult(userId,task,processed,review,evidence,referenceFor,onBudgetWait);
  }
  async function generateGalleryTask(userId, task) {
    if (task.contentType && task.galleryStoryboard?.version === 4) return generateMaterialTask(userId,task);
    const { id, selection } = task;
    const visualStyle = task.galleryStoryboard?.visualStyle;
    if (!visualStyle) throw new RestaurantError('这项任务缺少摄影风格方案，请复用素材新建套图。', 409, 'GALLERY_STYLE_REQUIRED');
    if (!model.renderGalleryPhoto || !model.reviewGalleryPhoto || !model.reviewGallerySet || task.contentType && !model.reviewContentSet) throw new RestaurantError('尚未配置套图生成与审美检查服务。', 503, 'MODEL_NOT_CONFIGURED');
    const sources = await loadSources(userId, task), processed = new Map(), appearances = new Map(), reviews = [...(task.imageReviews || [])];
    if (task.contentType && !['passed', 'passed_with_warning'].includes(task.contentFactsReview?.status)) {
      const board = await auditContentStoryboard(userId, task, task.galleryStoryboard, await galleryContactSheets(sources));
      task = await store.patchTask(userId, task.id, { galleryStoryboard: board });
    }
    const acceptedReferences = await styleRecipes.directorReferences?.(task.styleRecipe) ?? [];
    const planFingerprint = fingerprint({ selection, version: 2, visualStyle, ...(task.styleRecipe ? { styleRecipe: task.styleRecipe.fingerprint } : {}) });
    const checkpoints = [...(task.galleryCheckpoints || [])];
    const successfulSources = new Set();
    const foods = task.analysis.filter(item => item.usable && item.imageType === 'food' && !(task.foodReferenceExclusions || []).includes(item.imageId));
    let bookkeeping = Promise.resolve(), failure, nextShot = 0;
    const updateGallery = operation => {
      const work = bookkeeping.then(operation);
      bookkeeping = work.catch(() => {});
      return work;
    };
    const progress = (stage, message) => ({ stage, current: processed.size, total: selection.shots.length,
      message: `${message} · 已完成 ${processed.size} / ${selection.shots.length} 张` });
    const onBudgetWait = () => updateGallery(() => store.patchTask(userId, id, { progress: progress('waiting_for_budget', '部分请求正在排队') }));
    const references = new Map();
    const referenceFor = imageId => {
      if (!references.has(imageId)) references.set(imageId, (async () => {
        const source = sources.find(item => item.id === imageId), analysis = task.analysis.find(item => item.imageId === imageId);
        const prepared = await prepareGalleryReference(source.bytes, analysis);
        return { ...prepared, id: imageId, dataUrl: `data:${prepared.mime};base64,${prepared.bytes.toString('base64')}` };
      })());
      return references.get(imageId);
    };
    const saveReview = review => updateGallery(async () => {
      reviews.push(review);
      await store.patchTask(userId, id, { imageReviews: reviews });
    });
    const completed = (shot, result) => updateGallery(async () => {
      processed.set(shot.imageId, result); successfulSources.add(result.composition.sourceImageId);
      await store.patchTask(userId, id, { status: 'generating', progress: progress('gallery_image', '正在制作套图') });
    });
    const editReferences = async shot => {
      const real = shot.kind === 'scene' ? [] : await Promise.all(shot.referenceImageIds.slice(0,2).map(referenceFor));
      const accepted = acceptedReferences.find(photo => photo.sourceImageId === shot.sourceImageId);
      if (!accepted) return real;
      const prepared = await imageProcessor.prepareAnalysisPhoto(accepted.bytes);
      return [...real.slice(0,1), { ...accepted, ...prepared, dataUrl: `data:${prepared.mime};base64,${prepared.bytes.toString('base64')}` }];
    };
    const reviewFrame = async (shot, reference, context, rendered, appearance) => {
      const preview = await imageProcessor.prepareAnalysisPhoto(rendered.bytes);
      return validateGalleryImageReview(await model.reviewGalleryPhoto({ visualStyle, shot, context: context.map(photo => ({ imageId: photo.id,
        ...(photo.approvedStyle ? { role: 'accepted-style-target-for-this-original', style: photo.style } : { role: 'real-environment' }) })), ...(appearance ? { foodAppearance: appearance } : {}),
        photos: [reference, ...context, { id: shot.imageId, dataUrl: `data:${preview.mime};base64,${preview.bytes.toString('base64')}` }] }, { onBudgetWait }));
    };
    const processShot = async (originalShot, index, { skipCheckpoint = false, initialCorrections = [], attemptBase = 0 } = {}) => {
      const shot = { ...originalShot };
      await updateGallery(() => store.patchTask(userId, id, { status: 'generating', progress: progress('gallery_image', '正在制作套图') }));
      const saved = checkpoints.find(item => item.imageId === shot.imageId && item.planFingerprint === planFingerprint && ['ready','pending'].includes(item.status) && !item.expired && item.expiresAt > now());
      if (saved && !skipCheckpoint) {
        const bytes = await media.get(userId, id, saved.key);
        if (bytes && saved.hash === fingerprint(bytes.toString('base64'))) {
          if (saved.status === 'pending') await updateGallery(async () => { saved.status = 'ready'; await store.patchTask(userId,id,{galleryCheckpoints:checkpoints}); });
          await completed(shot, { bytes, width: saved.width, height: saved.height, format: 'jpeg', composition: saved.composition });
          return;
        }
      }
      let result;
      if (shot.kind === 'scene') {
        const reference = await referenceFor(shot.sourceImageId), context = await editReferences(shot);
        let corrections = initialCorrections;
        const sceneAttempts = task.contentType && initialCorrections.length && model.planSceneGrading ? 0 : 2;
        for (let attempt = 0; attempt < sceneAttempts; attempt++) {
          if (failure) throw failure;
          const rendered = await model.renderGalleryPhoto({ photo: reference, context, style: visualStyle, shot,
            taskId: `${id}-gallery-${task.generationAttempt || 1}`, attempt: attemptBase + attempt, corrections }, { onBudgetWait });
          const review = await reviewFrame(shot, reference, context, rendered);
          await saveReview({ imageId: shot.imageId, sourceImageId: shot.sourceImageId, attempt: attemptBase + attempt, ...review });
          if (review.status === 'passed') {
            result = { bytes: rendered.bytes, width: 1080, height: 1440, format: 'jpeg', composition: { version: GALLERY_WORKFLOW,
              method: 'claude-directed-scene-edit', sourceImageId: shot.sourceImageId, referenceImageIds: context.filter(photo=>!photo.approvedStyle).map(photo=>photo.id),
              visualStyle, styleFingerprint: fingerprint(visualStyle), generatedScene: false, modelEdited: true,
              styleReview: review, imageRequestId: rendered.requestId, provider: rendered.provider } };
            break;
          }
          corrections = review.errors;
          await updateGallery(() => store.patchTask(userId,id,{status:'retrying',progress:progress('style_consistency',`正在调整第${index+1}张图片的风格`)}));
        }
        if (!result && task.contentType && model.planSceneGrading) {
          const grading = await model.planSceneGrading({ visualStyle, shot, issues: corrections, photos: [reference] }, { onBudgetWait });
          const graded = await gradeContentScene(reference, grading), review = await reviewFrame(shot, reference, context, graded);
          await saveReview({ imageId: shot.imageId, sourceImageId: shot.sourceImageId, attempt: attemptBase+2, method: 'original-scene-grading', ...review });
          if (review.status === 'passed') result = { ...graded, format:'jpeg', composition: { version:GALLERY_WORKFLOW, method:'claude-directed-scene-grade',
            sourceImageId:shot.sourceImageId, referenceImageIds:[], visualStyle, styleFingerprint:fingerprint(visualStyle), generatedScene:false, modelEdited:false, grading, styleReview:review } };
        }
        if (!result) throw new RestaurantError('场景图片的风格或内容检查未通过，未交付残缺套图。',502,'GALLERY_IMAGE_REVIEW_FAILED');
      } else {
        if (!model.identifyFood) throw new RestaurantError('图片重拍服务尚未配置。', 503, 'MODEL_NOT_CONFIGURED');
        const groupIds = task.galleryStoryboard?.foodGroups?.find(group=>group.id===shot.foodGroupId)?.imageIds;
        const alternatives = [shot.sourceImageId, ...foods.filter(item => item.imageId !== shot.sourceImageId && !successfulSources.has(item.imageId)
          && (!groupIds || groupIds.includes(item.imageId))).map(item => item.imageId)].slice(0, 2);
        for (const sourceImageId of alternatives) {
          const analysis = task.analysis.find(item => item.imageId === sourceImageId), fullReference = await referenceFor(sourceImageId);
          shot.sourceImageId = sourceImageId;
          const scene = { ...foodScene(analysis, task.profileSnapshot, selection.facts), storeContext: storeSceneContext(task, shot) };
          const wholeSpread = shot.subjectScope === 'spread' || scene.type === 'hotpot' && !shot.subjectFocus;
          const appearanceKey = `${sourceImageId}:${shot.subjectFocus || ''}:${shot.subjectScope || ''}`;
          if (!appearances.has(appearanceKey)) {
            appearances.set(appearanceKey, (async () => {
              const identified = validateFoodAppearance((!shot.subjectFocus && analysis.foodAppearance) || await model.identifyFood({ analysis,
                subjectScope: wholeSpread ? 'spread' : shot.subjectScope || 'auto', subjectFocus: shot.subjectFocus || '', photos: [fullReference] }, { onBudgetWait }));
              if (wholeSpread) {
                delete identified.subjectBox; delete identified.subjectConfidence;
                identified.identityScope = 'spread';
              }
              return identified;
            })());
          }
          const appearance = await appearances.get(appearanceKey);
          const reference = await isolateDishReference(fullReference, appearance);
          const plan = galleryShot(scene, shot);
          const storeReferences = await editReferences(shot);
          let corrections = initialCorrections;
          for (let attempt = 0; attempt < 2; attempt++) {
            if (failure) throw failure;
            const rendered = await model.renderGalleryPhoto({ photo: reference, appearance, context: storeReferences, style: visualStyle, shot,
              taskId: `${id}-gallery-${task.generationAttempt || 1}`, attempt: attemptBase + attempt, corrections }, { onBudgetWait });
            const review = await reviewFrame(shot, reference, storeReferences, rendered, appearance);
            await saveReview({ imageId: shot.imageId, sourceImageId, attempt: attemptBase + attempt, ...review });
            if (review.status === 'passed') {
              result = { bytes: rendered.bytes, width: 1080, height: 1440, format: 'jpeg', composition: { version: GALLERY_WORKFLOW,
                method: 'reference-rephotography', sourceImageId, referenceImageIds: storeReferences.filter(photo=>!photo.approvedStyle).map(photo=>photo.id), cameraAngle: plan.angle,
                shotName: plan.name, generatedScene: true, foodRecreated: true, subjectBox: appearance.subjectBox || null, identityReview: review,
                visualStyle, styleFingerprint: fingerprint(visualStyle), modelEdited: true, imageRequestId: rendered.requestId, provider: rendered.provider } };
              break;
            }
            corrections = review.errors;
            await updateGallery(() => store.patchTask(userId, id, { status: 'retrying', progress: { ...progress('food_consistency', `正在调整第${index + 1}张菜品图`), imageId: shot.imageId, retry: attempt + 1 } }));
          }
          if (result) break;
        }
        if (!result) throw new RestaurantError('菜品重拍仍有明显差异，未交付残缺套图，积分不扣除。', 502, 'FOOD_IDENTITY_MISMATCH');
      }
      if (shot.name) result.composition = { ...result.composition, shotName: shot.name, purpose: shot.purpose, subjectFocus: shot.subjectFocus || '' };
      const key = scopedKey(userId, id, `working/gallery-${planFingerprint.slice(0,16)}-${shot.imageId}.jpg`);
      const checkpoint = { imageId: shot.imageId, key, expiresAt: now() + FILES_TTL_MS, planFingerprint, hash: fingerprint(result.bytes.toString('base64')), width: result.width, height: result.height, composition: result.composition, status: 'pending' };
      await protectMediaGroup([key], async () => {
        await updateGallery(async () => {
          const previous = checkpoints.findIndex(item => item.imageId === shot.imageId);
          if (previous >= 0) checkpoints[previous] = checkpoint; else checkpoints.push(checkpoint);
          await store.patchTask(userId, id, { galleryCheckpoints: checkpoints });
        });
        await media.put(userId, id, key, result.bytes);
        await updateGallery(async () => { checkpoint.status = 'ready'; await store.patchTask(userId, id, { galleryCheckpoints: checkpoints }); });
      });
      await completed(shot, result);
    };
    await Promise.all(Array.from({ length: Math.min(galleryConcurrency, selection.shots.length) }, async () => {
      while (!failure && !closing && nextShot < selection.shots.length) {
        const index = nextShot++;
        await galleryQueue(async () => {
          if (failure || closing) return;
          try { await processShot(selection.shots[index], index); }
          catch (cause) { if (!failure || cause.code === 'PROVIDER_UNCERTAIN') failure = cause; }
        });
      }
    }));
    if (failure) throw failure;
    if (closing) throw new RestaurantError('服务正在关闭，尚未开始的图片已停止生成。', 503, 'SERVICE_CLOSING');
    const reviewSet = async () => {
      await store.patchTask(userId,id,{progress:progress('gallery_set_review','正在检查整套摄影风格')});
      const photos = await galleryContactSheets(selection.shots.map(shot => ({ id: shot.imageId, bytes: processed.get(shot.imageId).bytes })), 'finished');
      if (task.contentType) {
        const sourceIds = new Set(selection.shots.map(shot => shot.sourceImageId));
        photos.unshift(...await galleryContactSheets(sources.filter(source => sourceIds.has(source.id)).slice(0,12), 'source'));
      }
      const review = validateGallerySetReview(await model.reviewGallerySet({ visualStyle, shots: selection.shots,
        ...(task.contentType ? { contentType: task.contentType } : {}), photos }, { onBudgetWait }), selection.shots.map(shot => shot.imageId));
      await store.patchTask(userId,id,{gallerySetReview:review});return review;
    };
    let setReview = await reviewSet();
    if (setReview.status === 'blocked') {
      await store.patchTask(userId,id,{status:'retrying',progress:progress('gallery_set_review','正在调整整套摄影风格')});
      await Promise.all(setReview.reviseImageIds.map(imageId => galleryQueue(async () => {
        if (failure) return;
        const index = selection.shots.findIndex(shot=>shot.imageId===imageId), shot = { ...selection.shots[index], sourceImageId: processed.get(imageId).composition.sourceImageId };
        try { await processShot(shot,index,{skipCheckpoint:true,attemptBase:2,initialCorrections:setReview.errors}); }
        catch(cause){if (!failure || cause.code === 'PROVIDER_UNCERTAIN') failure = cause;}
      })));
      if (failure) throw failure;
      setReview = await reviewSet();
      if (setReview.status !== 'passed') throw new RestaurantError('套图风格或重复画面检查未通过，请调整素材后重试。',502,'GALLERY_SET_REVIEW_FAILED');
    }
    const finalSources = new Set([...processed.values()].map(image => image.composition.sourceImageId));
    const evidence = task.analysis.filter(item => finalSources.has(item.imageId));
    if (task.contentType) {
      await store.patchTask(userId, id, { progress: { stage: 'layout', message: '正在排版套图。' } });
      let pages = task.galleryStoryboard.pages; const assets = new Map(processed);
      const compose = async () => {
        processed.clear();
        for (const page of pages) processed.set(page.imageId, await composeContentPage({ ...page, contentType: task.contentType }, assets, task.galleryStoryboard.graphicStyle, { brand: task.profileSnapshot.name }));
      };
      const auditPages = async () => validateGallerySetReview(await model.reviewContentSet({ contentType: task.contentType, profile: task.profileSnapshot,
        confirmedFacts: task.contentFacts || {}, visualStyle, pages, photos: await galleryContactSheets(pages.map(page => ({ id: page.imageId, bytes: processed.get(page.imageId).bytes })), 'pages') }, { onBudgetWait }), pages.map(page => page.imageId));
      await compose();
      let pageReview = await auditPages();
      if (pageReview.status === 'blocked' && model.repairContentLayout) {
        await store.patchTask(userId, id, { status: 'retrying', progress: { stage: 'layout', message: '正在调整套图排版。' } });
        const fixedAssets = selection.shots.map(shot => ({ imageId: shot.imageId, sourceImageId: assets.get(shot.imageId).composition.sourceImageId, name: shot.name, purpose: shot.purpose }));
        const oldPages = pages.map(page => ({ ...page, assetIndexes: page.assetIds.map(id => fixedAssets.findIndex(asset => asset.imageId === id)) }));
        const repaired = await model.repairContentLayout({ contentType: task.contentType, profile: task.profileSnapshot, confirmedFacts: task.contentFacts || {},
          fixedAssets, pages: oldPages, issues: pageReview.errors, photos: await galleryContactSheets(selection.shots.map(shot => ({ id: shot.imageId, bytes: assets.get(shot.imageId).bytes })), 'assets') }, {
          onBudgetWait, validateResult: value => repairContentStoryboard(value, task.galleryStoryboard, task) });
        const board = await auditContentStoryboard(userId, task, repairContentStoryboard(repaired, task.galleryStoryboard, task), []);
        task = await store.patchTask(userId, id, { galleryStoryboard: { ...board, source: 'ai', layoutRevisionCount: 1 } }); pages = board.pages;
        await compose(); pageReview = await auditPages();
      }
      await store.patchTask(userId, id, { contentPageReview: pageReview });
      if (pageReview.status === 'blocked') throw new RestaurantError(`套图排版检查未通过：${pageReview.errors.join('；')}`, 502, 'CONTENT_PAGE_REVIEW_FAILED');
      setReview.warnings.push(...pageReview.warnings);
    }
    return finishGalleryResult(userId,task,processed,setReview,evidence,referenceFor,onBudgetWait);
  }
  async function finishGalleryResult(userId,task,processed,setReview,evidence,referenceFor,onBudgetWait) {
    const {id,selection}=task;
    let copy = { titles: [], body: '', tags: [], coverText: '', claims: [], imageOrder: task.contentType ? task.galleryStoryboard.pages.map(page => page.imageId) : selection.shots.map(shot => shot.imageId) };
    const hasCopyProfile = task.contentType ? Boolean(task.profileSnapshot.name?.trim()) : ['name', 'city', 'address', 'category'].every(field => task.profileSnapshot?.[field]?.trim());
    let copyStatus = hasCopyProfile ? 'unavailable' : 'not_requested';
    const warningSet = new Set([...setReview.warnings, ...evidence.filter(item => item.privacyRisk === 'low' || item.textRisk === 'warning').flatMap(item => item.riskReasons)]);
    if (hasCopyProfile) try {
      await store.patchTask(userId, id, { status: 'generating', progress: { stage: 'copy', message: '套图已生成，正在整理配套文案。' } });
      const photos = await Promise.all(evidence.slice(0, 4).map(item => referenceFor(item.imageId)));
      const draft = validateCopy(await model.write({ profile: task.profileSnapshot, analysis: evidence, direction: selection.direction, facts: selection.facts,
        photos, imageMode: 'gallery', ...(task.contentType ? { contentType: task.contentType, pages: task.galleryStoryboard.pages } : {}) }, { onBudgetWait }), evidence.map(item => item.imageId));
      const local = localReview(draft, task.profileSnapshot, selection.facts, evidence), quality = inspectCopyQuality(draft, { profile: task.profileSnapshot, analysis: evidence, direction: selection.direction });
      if (!local.errors.length && quality.passed) {
        const audit = validateAudit(await model.audit({ copy: draft, profile: task.profileSnapshot, confirmedFacts: selection.facts,
          direction: selection.direction, images: evidence, photos }, { onBudgetWait }));
        if (audit.status !== 'blocked') {
          copy = { ...draft, imageOrder: copy.imageOrder }; copyStatus = 'completed';
          [...local.warnings, ...audit.warnings].forEach(warning => warningSet.add(warning));
        }
      }
    } catch (cause) {
      // Images are the deliverable. A failed optional copy request is never replayed or allowed to erase the completed gallery.
      await store.patchTask(userId, id, { copyErrorCode: cause.code || 'COPY_UNAVAILABLE' });
    }
    if (evidence.some(item => item.privacyRisk === 'low') && !warningSet.size) warningSet.add('请确认画面中人物的使用授权。');
    if (evidence.some(item => item.textRisk === 'warning') && !warningSet.size) warningSet.add('请核对实拍中招牌及菜单文字。');
    const warnings = [...warningSet];
    const review = { status: warnings.length ? 'passed_with_warning' : 'passed', errors: [], warnings };
    const result = { ...await buildPackage(userId, task, processed, copy, review), copyStatus, outputCount: processed.size };
    if (warnings.length && !task.contentType) await store.patchTask(userId, id, { ...result, status: 'awaiting_confirmation', progress: null });
    else await completeWithCredits(userId, id, { ...result, progress: null, completedAt: now() });
  }
  async function cloneTask(userId, old, requestId = randomUUID(), reuseCompletedImages = false) {
    if (!UUID.test(requestId)) throw new RestaurantError('请求标识无效。');
    await loadSources(userId, old);
    const existing = await store.getTask(userId, requestId);
    const fp = fingerprint({ forkFrom: old.id, ...(reuseCompletedImages ? { reuseCompletedImages: true } : {}) });
    if (existing) { if (existing.fingerprint !== fp) throw new RestaurantError('请求标识已用于其他任务。', 409, 'REQUEST_ID_CONFLICT'); return existing; }
    const directions = old.directions?.length ? old.directions : old.autoGenerate && old.analysis?.length === old.sourceImages.length
      ? validateDirections({ directions: [galleryDirection(old.analysis, old.profileSnapshot)] }, old.analysis, old.profileSnapshot) : [];
    if (!['completed', 'awaiting_selection', 'awaiting_facts', 'awaiting_confirmation', 'failed'].includes(old.status) || !directions.length) throw new RestaurantError('当前任务尚不能选择新方向，请等待分析完成。', 409, 'TASK_STATE');
    const reusable = reuseCompletedImages && old.status === 'failed' ? (old.galleryCheckpoints || []).filter(item => item.status === 'ready' && !item.expired && item.expiresAt > now()) : [];
    const excludedFoods = new Set(old.foodReferenceExclusions || []);
    if (!reusable.length && old.status === 'failed') {
      let ancestor = old;
      for (let depth = 0; ancestor && depth < 5; depth++) {
        const failures = new Map();
        for (const review of ancestor.imageReviews || []) if (review.status === 'blocked') failures.set(review.sourceImageId, (failures.get(review.sourceImageId) || 0) + 1);
        for (const [imageId, count] of failures) if (count >= 2 && !(ancestor.imageReviews || []).some(item => item.sourceImageId === imageId && item.status === 'passed')) excludedFoods.add(imageId);
        ancestor = ancestor.forkFrom ? await store.getTask(userId, ancestor.forkFrom) : null;
      }
    }
    const originals = [], sourceImages = old.sourceImages.map(source => ({ ...source, key: scopedKey(userId, requestId, `originals/${source.filename}`) }));
    const galleryCheckpoints = reusable.map(item => ({ ...item, key: scopedKey(userId, requestId, `working/${item.key.split('/').at(-1)}`) }));
    let created;
    return protectMediaGroup([...sourceImages, ...galleryCheckpoints].map(source => source.key), async () => { try {
      created = await store.createTask(userId, { id: requestId, fingerprint: fp, forkFrom: old.id, profileSnapshot: old.profileSnapshot, sourceImages,
        analysis: old.analysis, directions, sparsePhotos: old.sparsePhotos, rightsConfirmed: true, status: 'uploading', files: [],
        ...(old.contentType ? { contentType: old.contentType, contentFacts: old.contentFacts } : {}),
        foodReferenceExclusions: [...excludedFoods], ...(old.styleRecipe ? { styleRecipe: old.styleRecipe } : {}), ...(reuseCompletedImages && old.galleryStoryboard ? { galleryStoryboard: old.galleryStoryboard } : {}), ...(galleryCheckpoints.length ? { galleryCheckpoints } : {}) });
      for (const source of old.sourceImages) {
        const bytes = await media.get(userId, old.id, source.key);
        const key = scopedKey(userId, requestId, `originals/${source.filename}`);
        await media.put(userId, requestId, key, bytes); originals.push(key);
      }
      for (const [index, item] of reusable.entries()) {
        const bytes = await media.get(userId, old.id, item.key);
        if (!bytes) throw new RestaurantError('已保存图片不可用，请重新生成。', 410, 'FILES_EXPIRED');
        await media.put(userId, requestId, galleryCheckpoints[index].key, bytes); originals.push(galleryCheckpoints[index].key);
      }
      return await store.patchTask(userId, requestId, { status: 'awaiting_selection' });
    } catch (cause) { for (const key of originals) await media.remove(userId, requestId, key).catch(() => {}); if (created) await fail(userId, requestId, cause); throw cause; } });
  }
  async function startGenerate(userId, task, body) {
    const gallery = body.workflow === GALLERY_WORKFLOW;
    if (gallery && (body.imageMode !== 'promotional' || !Number.isInteger(body.outputCount) || body.outputCount < 1 || body.outputCount > 30)) throw new RestaurantError('宣传套图请选择1—30张。', 400, 'INVALID_OUTPUT_COUNT');
    if (body.outputCount !== undefined && (!Number.isInteger(body.outputCount) || body.outputCount < 1 || body.outputCount > (gallery ? 30 : 15))) throw new RestaurantError(`请选择1—${gallery ? 30 : 15}张真实成品图片。`, 400, 'INVALID_OUTPUT_COUNT');
    if (task.selection && (ACTIVE.has(task.status) || task.status === 'awaiting_confirmation') && body.outputCount !== undefined && body.outputCount !== (task.selection.outputCount ?? task.selection.imageIds.length)) throw new RestaurantError('该任务已按其他成品数量开始，请查询原任务。', 409, 'OUTPUT_COUNT_CONFLICT');
    if (ACTIVE.has(task.status) || task.status === 'awaiting_confirmation') return task;
    if (!gallery) requireProfile(task.profileSnapshot);
    if (task.status === 'completed') {
      // A repeated exact request returns its charged task, while a new direction is a new task.
      const sameCount = body.outputCount === undefined ? task.selection?.strictOutputCount !== true : task.selection?.strictOutputCount === true && task.selection.outputCount === body.outputCount;
      if (sameCount && (task.selection?.workflow ?? '') === (gallery ? GALLERY_WORKFLOW : '') && task.selection?.directionId === body.directionId && task.selection?.imageMode === (body.imageMode ?? body.processingMode ?? 'natural') && fingerprint(task.selection?.facts ?? {}) === fingerprint(resolveDirectionFacts(task.selection.direction, task.profileSnapshot, normalizeFacts(body.facts)))) return task;
      task = await cloneTask(userId, task, body.requestId ?? randomUUID());
    }
    if (!['awaiting_selection', 'awaiting_facts'].includes(task.status)) throw new RestaurantError('请先完成照片分析，或返回重新上传照片。', 409, 'TASK_STATE');
    const direction = task.directions.find(item => item.id === body.directionId);
    if (!direction) throw new RestaurantError('请选择有效的内容方向。');
    const seenHashes = new Set();
    const availableIds = (gallery ? task.analysis.filter(item => item.usable).map(item => item.imageId) : direction.supportingImageIds).filter(imageId => {
      const item = task.analysis.find(entry => entry.imageId === imageId), source = task.sourceImages.find(entry => entry.id === imageId);
      if (!item?.usable || !source || seenHashes.has(source.hash)) return false;
      seenHashes.add(source.hash); return true;
    });
    if (!availableIds.length) throw new RestaurantError('该方向没有可用照片，请更换方向。', 422);
    const coreImageIds = direction.coreImageIds ?? [];
    if (coreImageIds.some(imageId => !availableIds.includes(imageId))) throw new RestaurantError('该方向的核心证据照片不可用，请重新分析或更换方向。', 422, 'CORE_IMAGES_UNAVAILABLE');
    const outputCount = body.outputCount ?? Math.min(15, availableIds.length);
    if (!gallery && (outputCount > availableIds.length || body.outputCount !== undefined && availableIds.length >= 6 && outputCount < 6)) throw new RestaurantError(`该方向可用真实照片${availableIds.length}张，请选择${availableIds.length >= 6 ? '6—' : '1—'}${Math.min(15, availableIds.length)}张，不会复制照片凑数。`, 422, 'INSUFFICIENT_DIRECTION_IMAGES');
    if (outputCount < coreImageIds.length) throw new RestaurantError(`该方向需要保留${coreImageIds.length}张核心证据照片，请增加成品张数。`, 422, 'CORE_IMAGES_REQUIRED');
    const facts = resolveDirectionFacts(direction, task.profileSnapshot, normalizeFacts(body.facts)), missingFacts = pendingFacts(direction, task.profileSnapshot, facts);
    if (missingFacts.length) return await store.patchTask(userId, task.id, { status: 'awaiting_facts', missingFacts, selectedDirectionId: direction.id });
    if (!gallery && task.sparsePhotos && body.acceptSparse !== true && body.allowFewImages !== true) throw new RestaurantError('可用照片较少，请确认继续生成简版图文。', 422, 'SPARSE_CONFIRMATION_REQUIRED');
    const imageMode = body.imageMode ?? body.processingMode ?? 'natural';
    if (!['natural', 'cover', 'promotional'].includes(imageMode)) throw new RestaurantError('请选择有效的图片风格。');
    const orderedIds = [...coreImageIds, ...availableIds.filter(imageId => !coreImageIds.includes(imageId))];
    const imageIds = orderedIds.slice(0, outputCount), backupImageIds = orderedIds.slice(outputCount);
    if (gallery) {
      if(costMeter.enabled) {
        const legacy=task.billing?.source==='workspace' && task.billing.mode!=='api_cost' && !['settled','released'].includes(task.billing.status);
        if(!legacy)task=await ensureCostTask(userId,task);
        task=await costMeter.run({userId,taskId:task.billing?.taskId,legacy},()=>ensureGalleryStoryboard(userId,task,outputCount));
      } else task=await ensureGalleryStoryboard(userId,task,outputCount);
    }
    const shots = gallery ? createGalleryPlan(task, outputCount) : null;
    task = await reserveTaskCredits(userId, task, gallery ? outputCount : imageIds.length);
    try { await store.reservePackage(userId, task.id); }
    catch (error) { await releaseTaskCredits(userId, task).catch(() => {}); throw error; }
    const claimed = await store.claimTask(userId, task.id, ['awaiting_selection', 'awaiting_facts'], { status: 'generating', outputCount, selection: { directionId: direction.id, direction, facts, imageMode, imageIds, coreImageIds, backupImageIds, outputCount, strictOutputCount: body.outputCount !== undefined,
      ...(gallery ? { workflow: GALLERY_WORKFLOW, shots } : {}) }, missingFacts: [], error: null, code: null });
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
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin); } catch { throw new RestaurantError('请求来源不正确。', 403); }
        if (origin.host !== req.headers.host) throw new RestaurantError('请求来源不正确。', 403, 'ORIGIN_REJECTED');
      }
      if (path === '/api/restaurant/status' && req.method === 'GET') { reply(res, 200, { enabled: model.enabled ?? true, packageDailyLimit: (await store.usage(userId)).limit, retention: { filesDays: 3, tasksDays: 30 }, model: displayModelName(config.imageTextModel || config.chatModel, 'Pro模型') }); return true; }
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
          if (body.autoGenerate !== undefined && typeof body.autoGenerate !== 'boolean') throw new RestaurantError('生成方式无效。');
          if (body.autoGenerate && body.outputCount === undefined) body.outputCount = DEFAULT_RESTAURANT_OUTPUT_COUNT;
          if (body.autoGenerate && (!Number.isInteger(body.outputCount) || body.outputCount < 1 || body.outputCount > 30)) throw new RestaurantError('请选择1—30张套图。', 400, 'INVALID_OUTPUT_COUNT');
          const { profile, ...content } = contentRequest(body, await store.getProfile(userId) ?? {});
          if (!body.autoGenerate) requireProfile(profile);
          if (body.images === undefined) {
            if (!Number.isInteger(body.imageCount) || body.imageCount < 1 || body.imageCount > 30) throw new RestaurantError('请选择1—30张素材。', 400, 'INVALID_IMAGE_COUNT');
            const fp = fingerprint({ uploadProtocol: 'batches', imageCount: body.imageCount, rightsConfirmed: true, profile,
              ...content, ...(body.autoGenerate ? { autoGenerate: true, outputCount: body.outputCount } : {}) });
            const old = await store.getTask(userId, body.requestId);
            if (old) { if (old.fingerprint !== fp) throw new RestaurantError('该请求标识已用于不同素材数量或门店资料。', 409, 'REQUEST_ID_CONFLICT'); return old; }
            if ((await store.listTasks(userId)).filter(item => ACTIVE.has(item.status) && !(item.uploadProtocol === 'batches' && item.uploadExpiresAt <= now())).length >= 2) throw new RestaurantError('当前有任务处理中，请完成后再上传。', 429, 'ACTIVE_LIMIT');
            return await store.createTask(userId, { id: body.requestId, requestId: body.requestId, fingerprint: fp, profileSnapshot: profile, imageCount: body.imageCount,
              uploadProtocol: 'batches', uploadExpiresAt: now() + FILES_TTL_MS, uploadedBytes: 0, uploadBatches: [], sourceImages: [], analysis: [], directions: [], files: [], rightsConfirmed: true, status: 'uploading',
              ...content, ...(body.autoGenerate ? { autoGenerate: true, requestedOutputCount: body.outputCount } : {}) });
          }
          const decoded = decodeUploads(body.images), inspected = [];
          for (const photo of decoded) {
            const meta = await imageProcessor.inspectPhoto(photo.bytes);
            const mime = meta.format === 'jpeg' ? 'image/jpeg' : `image/${meta.format}`;
            if (mime !== photo.mime) throw new RestaurantError('图片内容与格式不一致。');
            inspected.push({ ...photo, ...meta });
          }
          const fp = fingerprint({ rightsConfirmed: true, images: inspected.map(item => ({ hash: item.hash, name: item.name })), profile,
            ...content, ...(body.autoGenerate ? { autoGenerate: true, outputCount: body.outputCount } : {}) });
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
            created = await store.createTask(userId, { id: body.requestId, requestId: body.requestId, fingerprint: fp, profileSnapshot: profile, sourceImages, analysis: [], directions: [], files: [], rightsConfirmed: true, status: 'uploading',
              ...content, ...(body.autoGenerate ? { autoGenerate: true, requestedOutputCount: body.outputCount } : {}) });
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
        if (req.method === 'DELETE' && !action) {
          if (!UUID.test(id)) throw new RestaurantError('任务地址无效。', 400);
          await exclusive(userId, async () => {
            const task = await store.getTask(userId, id);
            if (!task) return;
            if (ACTIVE.has(task.status)) throw new RestaurantError('任务处理中，请完成后再删除。', 409, 'TASK_BUSY');
            if (task.billing?.status === 'settle_pending') throw new RestaurantError('积分正在结算，请稍后删除。', 409, 'CREDITS_PENDING');
            await releaseTaskCredits(userId, task);
            await store.deleteTask(userId, id);
          });
          await sweep().catch(() => report('CLEANUP_FAILED'));
          reply(res, 200, { deleted: true, taskId: id }); return true;
        }
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
          const preview = task.status === 'awaiting_confirmation' && task.selection?.workflow === GALLERY_WORKFLOW
            ? task.files?.find(item => item.filename === name && item.role === 'image') : null;
          const file = original ?? preview ?? (task.status === 'completed' ? task.files?.find(item => item.filename === name) : null);
          if (!file) throw new RestaurantError('文件不存在或尚未允许交付。', 404, 'FILE_NOT_FOUND');
          if (file.expired || file.expiresAt <= now()) throw new RestaurantError('文件已过期，请及时下载新任务的结果。', 410, 'FILES_EXPIRED');
          if (url.searchParams.get('thumbnail') === '1' && /^image\/(jpeg|png|webp)$/.test(file.mime) && !url.searchParams.has('download')) {
            const bytes = await thumbnails(JSON.stringify([userId, id, file.key]), async () => {
              const originalBytes = await media.get(userId, id, file.key);
              if (!originalBytes) throw new RestaurantError('文件已过期或不可用。', 410, 'FILES_EXPIRED');
              return originalBytes;
            });
            if (file.expiresAt <= now()) throw new RestaurantError('文件已过期，请及时下载新任务的结果。', 410, 'FILES_EXPIRED');
            sendThumbnail(req, res, bytes); return true;
          }
          const bytes = await media.get(userId, id, file.key);
          if (!bytes) throw new RestaurantError('文件已过期或不可用。', 410, 'FILES_EXPIRED');
          res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `${original || preview ? 'inline' : 'attachment'}; filename="${file.filename}"` }); res.end(bytes); return true;
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
            if (action === 'fork') {
              const outputCount=body.outputCount ?? DEFAULT_RESTAURANT_OUTPUT_COUNT;
              if(task.contentType && body.autoGenerate===true && (!Number.isInteger(outputCount) || outputCount<1 || outputCount>30)) throw new RestaurantError('请选择1—30张套图。',400,'INVALID_OUTPUT_COUNT');
              const next = await cloneTask(userId, task, body.requestId, body.reuseCompletedImages === true);
              if(task.contentType && body.autoGenerate===true) {
                const claimed=await store.claimTask(userId,next.id,['awaiting_selection'],{status:'analysing',autoGenerate:true,requestedOutputCount:outputCount,error:null,code:null,
                  progress:{stage:'planning',message:'正在编排整套宣传图片。'}});
                if(claimed)launch(userId,next.id,()=>analyseTask(userId,next.id));
                return claimed ?? next;
              }
              return next;
            }
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
              const reserved = await reserveTaskCredits(userId, task, task.selection.workflow === GALLERY_WORKFLOW ? task.selection.outputCount : task.selection.imageIds.length);
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
  handler.shutdown = () => shutdownPromise ||= (async () => { closing = true; model.stop?.(); clearInterval(cleanupTimer); await ready.catch(() => {}); await Promise.allSettled([...serial.values()]); await Promise.allSettled([...running]); await model.close?.(); await subjectMasker.close?.(); await store.close?.(); })();
  handler.store = store;
  return handler;
}
