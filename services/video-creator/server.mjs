import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { VIDEO_SKILLS, VIDEO_MODELS, VIDEO_RATIOS, VIDEO_LANGUAGES, DEFAULT_VIDEO_SETTINGS } from '../../design/video-catalog.js';
import { createCreatorStore, UUID } from './store.mjs';
import { createDirectorModel, creatorError } from './model.mjs';
import { DIRECTOR_OUTPUT_TOKENS, directorAttemptSummary } from './director-response.mjs';
import { createCreatorProvider, creatorConfig } from './provider.mjs';
import { downloadVideo, probeVideo, serveMedia } from '../video/media.mjs';
import { normalizeVoice } from '../video/speech.mjs';
import { loadAIConfig } from '../ai/server.mjs';
import { createApiCostMeter } from '../credits/meter.mjs';
import { calculateCredits } from '../credits/store.mjs';
import { costPoints } from '../credits/costs.mjs';

const PREFIX = '/api/video-creator', DAY = 86400000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending = task => ['reserving', 'preparing', 'reviewing', 'submitting', 'running', 'downloading'].includes(task.status);
const scriptPending = op => ['queued', 'running', 'settling'].includes(op.status);
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
const safe = cause => cause?.code && /^[A-Z_]+$/.test(cause.code) && /[\u3400-\u9fff]/.test(cause.message || '')
  ? { error: cause.message, code: cause.code } : { error: '服务暂时无法完成请求，请稍后查看原任务。', code: 'VIDEO_CREATOR_UNAVAILABLE' };
export const isCreatorSourcePath = path => /^\/api\/video-creator\/source\/[a-f\d-]{36}\/[a-f\d-]{36}$/.test(path);
export function normalizeVideoSettings(value = {}) {
  const settings = { ...DEFAULT_VIDEO_SETTINGS, ...value }, model = VIDEO_MODELS.find(m => m.id === settings.model);
  if (!model || !model.durations.includes(settings.duration) || !VIDEO_RATIOS.includes(settings.ratio)
    || !model.resolutions.includes(settings.resolution) || !VIDEO_LANGUAGES.some(l => l.id === settings.language)
    || typeof settings.generateAudio !== 'boolean') throw creatorError('视频设置无效，请重新选择。');
  return Object.fromEntries(Object.keys(DEFAULT_VIDEO_SETTINGS).map(key => [key, settings[key]]));
}
async function bytes(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw creatorError('文件过大，请压缩后重试。', 413, 'CREATOR_UPLOAD_TOO_LARGE');
  const chunks = []; let total = 0;
  const timer = setTimeout(() => req.destroy(), 120000); timer.unref?.();
  try { for await (const chunk of req) { total += chunk.length; if (total > limit) throw creatorError('上传内容过大。', 413, 'CREATOR_UPLOAD_TOO_LARGE'); chunks.push(chunk); } return Buffer.concat(chunks); }
  finally { clearTimeout(timer); }
}
async function body(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw creatorError('请求格式无效。', 415);
  try { return JSON.parse((await bytes(req, 96 * 1024)).toString()); }
  catch (cause) { if (cause.status) throw cause; throw creatorError('请求内容无法读取。'); }
}

export function createVideoCreatorHandler({ storageDir, env = process.env, publicOrigin, credits, fetchImpl = fetch,
  config = creatorConfig(env, publicOrigin), aiConfig = loadAIConfig(env), provider, director, download = downloadVideo,
  probe = probeVideo, voice = normalizeVoice, now = Date.now, pollIntervalMs = 5000, logger = console } = {}) {
  const store = createCreatorStore(storageDir), locks = new Map(), workers = new Map(), controllers = new Map(), streams = new Set();
  const meter = createApiCostMeter({ credits, config: aiConfig, fetchImpl });
  director ||= createDirectorModel({ config: aiConfig, fetchImpl: meter.fetch,
    maxOutputTokens: env.VIDEO_DIRECTOR_MAX_OUTPUT_TOKENS ? Number(env.VIDEO_DIRECTOR_MAX_OUTPUT_TOKENS) : DIRECTOR_OUTPUT_TOKENS });
  provider ||= createCreatorProvider(config, fetchImpl);
  const cnyPerSecond = Number(env.VIDEO_GENERATION_CNY_PER_SECOND ?? 1);
  if (!Number.isFinite(cnyPerSecond) || cnyPerSecond <= 0) throw creatorError('视频计费配置无效。', 503, 'CREATOR_PRICING_INVALID');
  let closing = false, ticking = false, timer, shutdown;
  const record = id => store.records.get(id);
  const save = c => { c.updatedAt = now(); c.version = (c.version || 0) + 1; return store.save(c); };
  const lock = (id, work) => { const job = (locks.get(id) || Promise.resolve()).catch(() => {}).then(work); locks.set(id, job); job.finally(() => { if (locks.get(id) === job) locks.delete(id); }).catch(() => {}); return job; };
  const owned = (id, userId) => { const c = record(id); if (!c || c.userId !== userId) throw creatorError('任务不存在。', 404, 'CREATOR_NOT_FOUND'); return c; };
  const active = c => c.operations.some(scriptPending) || c.tasks.some(pending);
  const live = c => { if (now() >= c.mediaExpiresAt) throw creatorError('素材已过期，请重新上传。', 410, 'CREATOR_EXPIRED'); };
  const costScope = (c, id) => ({ userId: c.userId, taskId: id });
  const costId = (type, id) => `${type}:${id}`;
  const points = duration => meter.enabled ? costPoints(duration * cnyPerSecond) : calculateCredits('video', duration);
  function taskView(c, task) {
    const expired = task.expiresAt && now() >= task.expiresAt, paid = !credits || task.billing?.status === 'settled';
    return { id: task.id, conversationId: c.id, kind: 'video', status: expired && task.status === 'completed' ? 'expired' : task.status === 'completed' && !paid ? 'settling' : task.status,
      skill: task.skill, title: task.title, settings: task.settings, duration: task.settings.duration, actualDuration: task.actualDuration,
      createdAt: task.createdAt, startedAt: task.startedAt, completedAt: task.completedAt, expiresAt: task.expiresAt,
      error: task.error || '', code: task.code, warning: task.warning, billing: task.billing, estimatedPoints: points(task.settings.duration),
      materialProgress: { total: task.assetIds?.length || 0, prepared: Object.keys(task.materials || {}).length, approved: Object.values(task.materials || {}).filter(m => m.status === 2).length },
      canRecover: task.status === 'failed' && paid && Boolean(task.resultSource) && !expired,
      prompt: task.prompt, scriptId: task.scriptId || null, referenceImageIds: task.assetIds?.filter(id => c.assets.find(a => a.id === id)?.type === 'image'),
      resultUrl: task.status === 'completed' && paid && !expired ? `${PREFIX}/tasks/${task.id}/result` : null };
  }
  function operationView(op) { return { id: op.id, skill: op.skill, settings: op.settings, status: op.status, message: op.message, createdAt: op.createdAt,
    startedAt: op.startedAt, completedAt: op.completedAt, diagnostics: op.diagnostics,
    progress: op.progress, result: op.status === 'completed' ? op.result : undefined, error: op.error, code: op.code, billing: op.billing }; }
  const sessionView = c => ({ id: c.id, version: c.version, skill: c.skill, settings: c.settings, mediaExpiresAt: c.mediaExpiresAt,
    assets: c.assets.map(a => ({ id: a.id, name: a.name, type: a.type, size: a.size, duration: a.duration,
      expired: now() >= c.mediaExpiresAt, url: now() < c.mediaExpiresAt ? `${PREFIX}/conversations/${c.id}/assets/${a.id}` : null })),
    operations: c.operations.map(operationView), tasks: c.tasks.map(t => taskView(c, t)) });
  async function settle(scope, op) {
    if (!credits || !op.billing) return;
    try {
      if (meter.enabled) await meter.reconcile(scope);
      const value = meter.enabled ? await credits.settleCost(scope)
        : op.status === 'completed' ? await credits.settle({ ...scope, units: Math.min(op.settings.duration, op.actualDuration || op.settings.duration) }) : await credits.release(scope);
      op.billing = { status: value.status, reservedPoints: value.reservedPoints, chargedPoints: value.chargedPoints,
        exempt: value.exempt, ...(meter.enabled ? { mode: 'api_cost' } : {}) };
    } catch { op.billing = { ...op.billing, status: 'pending' }; }
  }
  function launch(key, work) {
    if (workers.has(key)) return;
    const promise = work().catch(() => {}).finally(() => workers.delete(key)); workers.set(key, promise);
  }
  async function runScript(c, op) {
    const scope = costScope(c, costId('director', op.id)), controller = new AbortController(); controllers.set(op.id, controller);
    const attempts = [];
    const onAttempt = async entry => {
      attempts[entry.attempt - 1] = entry;
      try { await store.saveDirectorDiagnostic(c.id, op.id, { conversationId: c.id, operationId: op.id, expiresAt: c.mediaExpiresAt, attempts }); }
      catch { throw creatorError('编导诊断记录保存失败，请稍后重试。', 503, 'DIRECTOR_LOG_WRITE_FAILED'); }
      op.diagnostics = { attempts: attempts.map(directorAttemptSummary), rawAvailable: true, rawExpiresAt: c.mediaExpiresAt };
      if (entry.status === 'failed') logger.error('[video-director]', JSON.stringify({ conversationId: c.id, operationId: op.id,
        attempt: entry.attempt, phase: entry.error?.phase, code: entry.error?.code, issue: entry.error?.issue,
        detail: entry.error?.detail, finishReason: entry.finishReason, maxOutputTokens: entry.maxOutputTokens,
        outputTokens: entry.usage?.completion_tokens, providerRequestId: entry.providerRequestId, httpStatus: entry.httpStatus }));
      await save(c);
    };
    try {
      if (meter.enabled) { const hold = await credits.reserveCost(scope); op.billing = { status: hold.status, exempt: hold.exempt, mode: 'api_cost' }; }
      op.status = 'running'; op.startedAt = now(); op.progress = '正在分析素材并编排分镜'; op.dispatched = true; await save(c);
      const result = await meter.run(scope, () => director.generate({ skill: op.skill, settings: op.settings, message: op.message,
        assets: op.assetIds.map(id => ({ ...c.assets.find(a => a.id === id) })),
        history: c.operations.filter(o => o.skill === op.skill && o.status === 'completed' && o.result)
          .flatMap(o => [{ role: 'user', content: o.message }, { role: 'assistant', content: JSON.stringify(o.result) }]).slice(-10) }, { signal: controller.signal, onAttempt,
        onProgress: progress => { op.progress = progress; } }));
      delete result.usage; op.result = result; op.status = 'completed'; op.progress = '';
      c.messages.push({ role: 'user', content: op.message }, { role: 'assistant', content: JSON.stringify(result) });
      c.messages = c.messages.slice(-20);
    } catch (cause) {
      const issue = safe(cause); op.status = 'failed'; op.error = issue.error; op.code = issue.code; op.progress = '';
    } finally {
      op.completedAt = now(); await settle(scope, op);
      if (op.status === 'completed' && op.billing?.status === 'pending') op.status = 'settling';
      await save(c); controllers.delete(op.id);
    }
  }
  function sourceUrl(c, asset) {
    const expires = Math.min(c.mediaExpiresAt, now() + 6 * 3600000);
    const signature = createHmac('sha256', config.signingSecret).update(`${c.id}:${asset.id}:${expires}`).digest('hex');
    return `${config.publicOrigin}${PREFIX}/source/${c.id}/${asset.id}?expires=${expires}&signature=${signature}`;
  }
  async function finishProviderCost(c, task, detail) {
    if (meter.enabled && task.costPrepared) await credits.finishCostCall({ ...costScope(c, costId('video', task.id)), receiptId: 'render', ...detail });
  }
  async function failTask(c, task, cause, uncertain = false) {
    const issue = safe(cause); task.status = uncertain ? 'uncertain' : 'failed'; task.error = issue.error; task.code = issue.code;
    if (!task.dispatched) await finishProviderCost(c, task, { costCny: 0 });
    await settle(costScope(c, costId('video', task.id)), task); await save(c);
  }
  async function accept(c, task, result) {
    if (result.failed) {
      await finishProviderCost(c, task, { costCny: 0 });
      await failTask(c, task, creatorError('视频未生成成功，请调整素材或脚本后重试。', 502, 'VIDEO_GENERATION_FAILED')); return;
    }
    if (result.taskId) task.providerId = result.taskId;
    if (result.url) {
      task.resultSource = result.url; task.status = 'downloading';
      await finishProviderCost(c, task, { costCny: task.settings.duration * cnyPerSecond, ...(task.providerId ? { providerRequestId: task.providerId } : {}) });
    } else if (task.providerId) task.status = 'running';
    else throw creatorError('视频提交结果未确认，系统不会自动重复生成，请联系管理员核对。', 502, 'VIDEO_SUBMISSION_UNCERTAIN');
    await save(c);
  }
  async function runVideo(c, task) {
    const controller = new AbortController(); controllers.set(task.id, controller);
    try {
      if (now() - task.startedAt > 4 * 3600000 && ['running', 'reviewing'].includes(task.status)) {
        await failTask(c, task, creatorError('原视频任务长时间未返回结果，请联系管理员核对，不会重复提交。', 502, 'VIDEO_RESULT_UNCONFIRMED'), Boolean(task.dispatched)); return;
      }
      if (['preparing', 'reviewing'].includes(task.status)) {
        task.materials ||= {};
        let next = 0; const failures = [];
        await Promise.all(Array.from({ length: Math.min(3, task.assetIds.length) }, async () => {
          while (!closing && !failures.length && next < task.assetIds.length) {
            const assetId = task.assetIds[next++], asset = c.assets.find(a => a.id === assetId); let material = task.materials[assetId];
            try {
              if (!material) {
                if (!asset.sourceUrl && provider.uploadSource) { asset.sourceUrl = await provider.uploadSource(asset); await save(c); }
                material = await provider.createMaterial(asset.sourceUrl || sourceUrl(c, asset), asset.type === 'image' ? 'photo' : 'voice'); task.materials[assetId] = material;
              } else if (material.status !== 2) material.status = await provider.queryMaterial(material.id);
              await save(c);
              if (material.status === 3) throw creatorError('部分素材未通过视频服务审核，请换一组清晰的实拍。', 422, 'VIDEO_MATERIAL_REJECTED');
            } catch (cause) { failures.push(cause); }
          }
        }));
        if (failures.length) throw failures[0];
        if (closing) return;
        task.status = 'reviewing'; await save(c);
        if (Object.values(task.materials).some(m => m.status !== 2)) return;
        if (closing) return;
        task.status = 'submitting'; task.dispatched = true; await save(c);
        try {
          await accept(c, task, await provider.generateCreative({ ...task.settings, prompt: task.prompt,
            imageIds: task.assetIds.filter(id => c.assets.find(a => a.id === id).type === 'image').map(id => task.materials[id].id),
            audioIds: task.assetIds.filter(id => c.assets.find(a => a.id === id).type === 'audio').map(id => task.materials[id].id) }));
        } catch (cause) {
          const rejected = ['VIDEO_PROVIDER_REJECTED', 'VIDEO_PROVIDER_IP_DENIED'].includes(cause.code);
          await finishProviderCost(c, task, rejected ? { costCny: 0 } : { uncertain: true });
          await failTask(c, task, rejected ? cause : creatorError('视频提交结果未确认，不会自动重复生成，请联系管理员核对。', 502, 'VIDEO_SUBMISSION_UNCERTAIN'), !rejected); return;
        }
      } else if (task.status === 'running') { await accept(c, task, await provider.query(task.providerId, task.settings.model)); }
      if (task.status === 'downloading') {
        if (closing) return;
        const temporary = await store.path(c.id, task.id + '.tmp'), result = await store.path(c.id, `result-${task.id}.mp4`);
        try {
          await download(task.resultSource, temporary, controller.signal); const metadata = await probe(temporary);
          await rename(temporary, result); task.status = 'completed'; task.completedAt = now(); task.expiresAt = now() + 3 * DAY;
          task.actualDuration = metadata.duration;
          if (task.settings.generateAudio && !metadata.audio) task.warning = '成片没有音轨，请预览确认。';
          task.error = ''; delete task.code;
          await settle(costScope(c, costId('video', task.id)), task); await save(c);
        } catch (cause) {
          if (closing) return;
          task.downloadAttempts = (task.downloadAttempts || 0) + 1;
          if (task.downloadAttempts >= 3) await failTask(c, task, creatorError('视频已生成，保存成片失败。可恢复下载，无需重新生成。', 502, 'VIDEO_DOWNLOAD_FAILED'));
        }
      }
    } catch (cause) {
      if (task.dispatched && task.providerId) { task.error = '原任务查询暂时中断，正在重试查询。'; await save(c); }
      else await failTask(c, task, cause, Boolean(task.dispatched));
    } finally { controllers.delete(task.id); }
  }
  async function tick() {
    if (ticking || closing) return; ticking = true;
    try {
      for (const c of store.records.values()) {
        for (const op of c.operations.filter(o => o.status === 'settling' || o.status === 'failed' && o.billing?.status === 'pending')) {
          await settle(costScope(c, costId('director', op.id)), op);
          if (op.status === 'settling' && op.billing?.status === 'settled') op.status = 'completed';
          await save(c);
        }
        for (const task of c.tasks) {
          if (['completed', 'failed', 'uncertain'].includes(task.status) && task.billing?.status === 'pending') { await settle(costScope(c, costId('video', task.id)), task); await save(c); }
          if (['preparing', 'reviewing', 'running', 'downloading'].includes(task.status) && !workers.has(task.id) && workers.size < 3) launch(task.id, () => runVideo(c, task));
          if (!pending(task) && task.expiresAt && now() >= task.expiresAt) await rm(await store.path(c.id, `result-${task.id}.mp4`), { force: true });
        }
        if (!active(c) && now() >= c.mediaExpiresAt && !c.mediaCleaned) {
          for (const asset of c.assets) await rm(asset.path, { force: true });
          for (const op of c.operations) if (op.diagnostics?.rawAvailable) {
            await rm(await store.path(c.id, `director-${op.id}.json.gz`), { force: true });
            op.diagnostics.rawAvailable = false;
          }
          c.mediaCleaned = true; await save(c);
        }
        if (!active(c) && now() >= (c.recordExpiresAt || c.createdAt + 30 * DAY)) await store.remove(c.id);
      }
    } finally { ticking = false; }
  }
  const ready = (async () => {
    await store.ready;
    for (const c of store.records.values()) {
      for (const op of c.operations.filter(o => ['queued', 'running'].includes(o.status))) { op.status = 'failed'; op.error = '编导请求在服务重启时中断，请核对后再发起。'; op.code = 'DIRECTOR_INTERRUPTED'; await settle(costScope(c, costId('director', op.id)), op); }
      for (const task of c.tasks.filter(t => t.status === 'reserving')) {
        const scope = costScope(c, costId('video', task.id));
        const reserved = credits ? await credits.reservation(c.userId, scope.taskId) : null;
        if (reserved) {
          task.billing = { status: reserved.status, reservedPoints: reserved.reservedPoints, chargedPoints: reserved.chargedPoints, exempt: reserved.exempt };
          if (meter.enabled && reserved.costItems?.render) { task.costPrepared = true; await finishProviderCost(c, task, { costCny: 0 }); }
        }
        task.status = 'failed'; task.error = '视频尚未提交时服务已重启，请重新发起。'; task.code = 'VIDEO_INTERRUPTED_BEFORE_SUBMISSION';
        await settle(scope, task);
      }
      for (const task of c.tasks.filter(t => t.status === 'submitting')) { task.status = 'uncertain'; task.error = '任务提交确认中断，系统不会自动重复生成，请联系管理员核对。'; task.code = 'VIDEO_SUBMISSION_UNCERTAIN'; }
      await save(c);
    }
    timer = setInterval(() => void tick().catch(() => {}), pollIntervalMs); timer.unref();
  })(); ready.catch(() => {});

  const handler = async (req, res) => {
    try {
      await ready;
      const url = new URL(req.url, 'http://localhost'), route = url.pathname.slice(PREFIX.length).split('/').filter(Boolean);
      if (route[0] === 'source') {
        if (!['GET', 'HEAD'].includes(req.method)) throw creatorError('接口不存在。', 404);
        const c = record(route[1]), asset = c?.assets.find(a => a.id === route[2]), expires = Number(url.searchParams.get('expires')), signature = url.searchParams.get('signature');
        if (!asset || !config.signingSecret || !Number.isSafeInteger(expires) || expires < now() || expires > c.mediaExpiresAt || !/^[a-f\d]{64}$/.test(signature || '')) throw creatorError('素材链接无效或已过期。', 403, 'CREATOR_SOURCE_DENIED');
        const expected = createHmac('sha256', config.signingSecret).update(`${c.id}:${asset.id}:${expires}`).digest('hex');
        if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw creatorError('素材链接无效。', 403, 'CREATOR_SOURCE_DENIED');
        await serveMedia(req, res, asset.path, asset.type === 'image' ? 'image/jpeg' : 'audio/wav'); return;
      }
      const userId = req.authenticatedUserId;
      if (!userId) throw creatorError('请先登录。', 401, 'UNAUTHENTICATED');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw creatorError('请求来源无效。', 403, 'CREATOR_ORIGIN_DENIED');
      if (req.headers.origin && ![config.publicOrigin, publicOrigin, `http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin)) throw creatorError('请求来源无效。', 403, 'CREATOR_ORIGIN_DENIED');
      if (!['GET', 'HEAD'].includes(req.method) && closing) throw creatorError('服务正在重启，尚未发起生成。', 503, 'SERVICE_CLOSING');
      if (route[0] === 'config' && req.method === 'GET') { json(res, 200, { skills: VIDEO_SKILLS.map(({ focus, ...s }) => s), models: VIDEO_MODELS, directorEnabled: director.enabled,
        generationEnabled: Boolean(config.enabled), limits: { images: 30, audio: 1, imageBytes: 10 * 1024 * 1024, audioBytes: 15 * 1024 * 1024 }, costMode: meter.enabled, cnyPerSecond }); return; }
      if (route[0] === 'quote' && req.method === 'POST') {
        const settings = normalizeVideoSettings((await body(req)).settings), wallet = credits ? await credits.snapshot(userId) : null;
        json(res, 200, { points: points(settings.duration), affordable: !wallet || wallet.unlimited || wallet.available >= points(settings.duration), unlimited: wallet?.unlimited === true }); return;
      }
      if (route[0] === 'tasks' && route.length === 1 && req.method === 'GET') {
        const tasks = [...store.records.values()].filter(c => c.userId === userId).flatMap(c => c.tasks.map(t => taskView(c, t))).sort((a, b) => b.createdAt - a.createdAt);
        json(res, 200, { tasks: tasks.filter(t => !url.searchParams.has('completed') || t.status === 'completed').slice(0, 100) }); return;
      }
      if (route[0] === 'tasks' && UUID.test(route[1] || '')) {
        const c = [...store.records.values()].find(c => c.userId === userId && c.tasks.some(t => t.id === route[1]));
        if (!c) throw creatorError('任务不存在。', 404, 'CREATOR_NOT_FOUND');
        const task = c.tasks.find(t => t.id === route[1]);
        if (route.length === 2 && req.method === 'GET') { json(res, 200, { task: taskView(c, task) }); return; }
        if (route[2] === 'result' && ['GET', 'HEAD'].includes(req.method)) {
          if (!taskView(c, task).resultUrl) throw creatorError('成片尚未就绪或已过期。', 410, 'CREATOR_EXPIRED');
          await serveMedia(req, res, await store.path(c.id, `result-${task.id}.mp4`), 'video/mp4', url.searchParams.get('download') === '1', 'qiya-video.mp4'); return;
        }
        if (route[2] === 'recover' && req.method === 'POST') { await body(req); await lock(c.id, async () => {
          if (!taskView(c, task).canRecover) throw creatorError('该任务不能恢复下载。', 409);
          task.status = 'downloading'; task.downloadAttempts = 0; task.error = ''; await save(c);
        }); json(res, 202, { task: taskView(c, task) }); void tick(); return; }
      }
      if (route[0] !== 'conversations') throw creatorError('接口不存在。', 404);
      if (route.length === 1) {
        if (req.method === 'GET') { json(res, 200, { conversations: [...store.records.values()].filter(c => c.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50).map(c => ({ id: c.id, skill: c.skill, updatedAt: c.updatedAt, title: c.operations.findLast(o => o.result?.script)?.result.script.title || VIDEO_SKILLS.find(s => s.id === c.skill)?.name })) }); return; }
        if (req.method === 'POST') {
          const input = await body(req), id = input.requestId;
          if (!UUID.test(id || '') || !VIDEO_SKILLS.some(s => s.id === input.skill)) throw creatorError('创作方向无效。');
          await lock(id, async () => {
            if (record(id)) { owned(id, userId); return; }
            if ([...store.records.values()].filter(c => c.userId === userId).length >= 100) throw creatorError('创作记录较多，请稍后再试。', 429);
            const c = { id, userId, skill: input.skill, settings: normalizeVideoSettings(input.settings), createdAt: now(), updatedAt: now(), recordExpiresAt: now() + 30 * DAY, mediaExpiresAt: now() + 3 * DAY, assets: [], messages: [], operations: [], tasks: [] };
            await save(c); store.records.set(id, c);
          }); json(res, 201, { conversation: sessionView(owned(id, userId)) }); return;
        }
      }
      const c = owned(route[1], userId);
      if (route.length === 2 && req.method === 'GET') { json(res, 200, { conversation: sessionView(c) }); return; }
      if (route.length === 2 && req.method === 'PATCH') {
        const input = await body(req); await lock(c.id, async () => {
          live(c); if (active(c)) throw creatorError('请等待当前任务完成。', 409);
          if (!VIDEO_SKILLS.some(s => s.id === input.skill)) throw creatorError('请选择有效的创作方向。');
          c.skill = input.skill; c.settings = normalizeVideoSettings(input.settings); await save(c);
        }); json(res, 200, { conversation: sessionView(c) }); return;
      }
      if (route[2] === 'assets' && UUID.test(route[3] || '')) {
        const id = route[3], asset = c.assets.find(a => a.id === id);
        if (['GET', 'HEAD'].includes(req.method)) { live(c); if (!asset) throw creatorError('素材不存在。', 404); await serveMedia(req, res, asset.path, asset.type === 'image' ? 'image/jpeg' : 'audio/wav'); return; }
        if (req.method === 'PUT') {
          live(c); const data = await bytes(req, 15 * 1024 * 1024), checksum = hash(data.toString('base64'));
          await lock(c.id, async () => {
            const existing = c.assets.find(a => a.id === id); if (existing) { if (existing.checksum !== checksum) throw creatorError('同一素材不能替换为其他文件，请重新添加。', 409); return; }
            if (active(c)) throw creatorError('请等待当前任务完成后再添加素材。', 409);
            const image = /^image\/(jpeg|png|webp)$/.test(req.headers['content-type'] || ''), audio = /^audio\/(mpeg|wav|x-wav)$/.test(req.headers['content-type'] || '');
            if (!image && !audio || image && data.length > 10 * 1024 * 1024) throw creatorError('图片支持 JPG、PNG、WebP，音频支持 MP3、WAV。');
            if (c.assets.filter(a => a.type === (image ? 'image' : 'audio')).length >= (image ? 30 : 1)) throw creatorError(image ? '最多上传30张图片。' : '最多选择一段声音参考。');
            const path = await store.path(c.id, id + (image ? '.jpg' : '.wav')); let metadata = {};
            if (image) {
              try { const img = sharp(data, { limitInputPixels: 40000000, animated: false }), info = await img.metadata();
                if (!['jpeg', 'png', 'webp'].includes(info.format) || info.pages > 1 || info.width < 128 || info.height < 128) throw new Error();
                await writeFile(path, await img.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 93 }).toBuffer(), { mode: 0o600 });
              } catch { throw creatorError('图片无法读取，请上传清晰的 JPG、PNG 或 WebP 图片。'); }
            } else { const input = await store.path(c.id, id + '.upload'); try { await writeFile(input, data, { mode: 0o600 }); metadata = await voice(input, path); } finally { await rm(input, { force: true }); } }
            let name = ''; try { name = decodeURIComponent(req.headers['x-file-name'] || ''); } catch {}
            c.assets.push({ id, path, type: image ? 'image' : 'audio', name: name.replace(/[\u0000-\u001f]/g, '').slice(0, 100) || (image ? '实拍图片' : '声音参考'), size: data.length, checksum, ...metadata });
            await save(c);
          }); json(res, 200, { conversation: sessionView(c) }); return;
        }
        if (req.method === 'DELETE') { await lock(c.id, async () => {
          if (active(c) || c.tasks.length || c.operations.length) throw creatorError('素材已被脚本或视频引用，请新建创作后调整。', 409);
          c.assets = c.assets.filter(a => a.id !== id); await save(c); if (asset) await rm(asset.path, { force: true });
        }); json(res, 200, { conversation: sessionView(c) }); return; }
      }
      if (route[2] === 'operations' && route[3]) {
        const op = c.operations.find(o => o.id === route[3]); if (!op) throw creatorError('编导任务不存在。', 404);
        if (route[4] === 'stream' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
          const emit = () => { res.write('event: script.snapshot\ndata: ' + JSON.stringify(operationView(op)) + '\n\n'); if (!scriptPending(op)) res.end(); };
          emit(); if (res.writableEnded) return; streams.add(res);
          const interval = setInterval(emit, 1000); interval.unref(); res.on('close', () => { clearInterval(interval); streams.delete(res); }); return;
        }
        if (req.method === 'GET') { json(res, 200, { operation: operationView(op) }); return; }
      }
      if (route[2] === 'script' && req.method === 'POST') {
        const input = await body(req); let operation, fresh = false;
        await lock(c.id, async () => {
          live(c); if (!UUID.test(input.requestId || '')) throw creatorError('编导操作标识无效。');
          const fingerprint = hash({ settings: normalizeVideoSettings(input.settings), message: input.message?.trim(), skill: c.skill, expectedScriptId: input.expectedScriptId || null, assetIds: c.assets.map(a => a.id) });
          if (c.operations.some(o => o.id === input.requestId)) { operation = c.operations.find(o => o.id === input.requestId); if (operation.fingerprint !== fingerprint) throw creatorError('不能用同一操作标识修改需求或设置。', 409); return; }
          if ([...store.records.values()].some(x => x.userId === userId && x.operations.some(o => o.id === input.requestId))) throw creatorError('该操作标识已用于其他创作，请重新发起。', 409, 'DIRECTOR_REQUEST_CONFLICT');
          if (!director.enabled) throw creatorError('编导服务尚未配置。', 503, 'DIRECTOR_NOT_CONFIGURED');
          if (active(c)) throw creatorError('请等待当前任务完成。', 409);
          if ([...store.records.values()].filter(x => x.userId === userId).flatMap(x => x.operations).filter(scriptPending).length >= 2 || workers.size >= 3) throw creatorError('已有任务处理中，请稍后再试。', 429);
          if (!c.assets.some(a => a.type === 'image')) throw creatorError('请先添加门店或产品实拍图片。');
          if (typeof input.message !== 'string' || input.message.trim().length > 8000 || !input.message.trim()) throw creatorError('请填写8000字以内的创作需求。');
          if (c.operations.length >= 20) throw creatorError('本次编导轮次已较多，请新建创作。');
          const last = c.operations.findLast(o => o.status === 'completed');
          if ((input.expectedScriptId || null) !== (last?.id || null)) throw creatorError('脚本已更新，请刷新后继续修改。', 409, 'DIRECTOR_REVISION_CONFLICT');
          c.settings = normalizeVideoSettings(input.settings);
          operation = { id: input.requestId, fingerprint, status: 'queued', message: input.message.trim(), settings: c.settings, skill: c.skill, assetIds: c.assets.map(a => a.id), createdAt: now(), progress: '等待编导' };
          c.operations.push(operation); c.recordExpiresAt = now() + 30 * DAY; await save(c); fresh = true;
        }); json(res, 202, { operation: operationView(operation), conversationId: c.id }); if (fresh) launch(operation.id, () => runScript(c, operation)); return;
      }
      if (route[2] === 'generate' && req.method === 'POST') {
        const input = await body(req); let task;
        await lock(c.id, async () => {
          live(c); const settings = normalizeVideoSettings(input.settings);
          if (!UUID.test(input.requestId || '') || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000) throw creatorError('请填写完整的视频提示词。');
          const fingerprint = hash({ settings, prompt: input.prompt.trim(), scriptId: input.scriptId || null, assetIds: c.assets.map(a => a.id),
            ...(input.referenceImageIds ? { referenceImageIds: input.referenceImageIds } : {}) });
          task = c.tasks.find(t => t.id === input.requestId); if (task) { if (task.fingerprint !== fingerprint) throw creatorError('同一任务不能重复提交不同内容。', 409); return; }
          if ([...store.records.values()].some(x => x.userId === userId && x.tasks.some(t => t.id === input.requestId))) throw creatorError('该任务标识已用于其他创作，请重新发起。', 409, 'VIDEO_REQUEST_CONFLICT');
          if (!config.enabled) throw creatorError('视频生成接口尚未配置，请联系管理员。', 503, 'VIDEO_NOT_CONFIGURED');
          if (active(c)) throw creatorError('请等待当前任务完成。', 409);
          if (!c.assets.some(a => a.type === 'image')) throw creatorError('请先添加图片素材。');
          let referenceImageIds = input.referenceImageIds ?? c.assets.filter(a => a.type === 'image').map(a => a.id);
          if (!Array.isArray(referenceImageIds) || !referenceImageIds.length || new Set(referenceImageIds).size !== referenceImageIds.length
            || referenceImageIds.some(id => !c.assets.some(a => a.id === id && a.type === 'image'))) throw creatorError('视频参考图片无效，请重新应用脚本。', 400, 'CREATOR_INVALID_REFERENCES');
          if (input.scriptId) {
            const op = c.operations.find(o => o.id === input.scriptId && o.status === 'completed' && o.result?.script);
            if (!op || op.skill !== c.skill || hash(op.settings) !== hash(settings) || hash(op.assetIds) !== hash(c.assets.map(a => a.id))) throw creatorError('脚本与当前素材或设置不一致，请重新应用脚本。', 409, 'SCRIPT_SETTINGS_CHANGED');
            if (op.result.script.referenceImageIds) {
              if (input.referenceImageIds && hash(input.referenceImageIds) !== hash(op.result.script.referenceImageIds)) throw creatorError('参考图片与编导脚本不一致，请重新应用脚本。', 409, 'SCRIPT_SETTINGS_CHANGED');
              referenceImageIds = op.result.script.referenceImageIds;
              if (!referenceImageIds.length || referenceImageIds.some(id => !c.assets.some(a => a.id === id && a.type === 'image'))) throw creatorError('编导参考图片无效，请重新编导。', 409, 'SCRIPT_SETTINGS_CHANGED');
            }
          }
          const model = VIDEO_MODELS.find(m => m.id === settings.model);
          if (referenceImageIds.length > model.maxImages) throw creatorError(`所选模型最多支持${model.maxImages}张图片，请选择Max模型或新建创作。`, 400, 'CREATOR_MODEL_LIMIT');
          if (settings.model === 'doubao-seedance-2-5-260628' && config.dedicated25 && !Object.values(config.dedicated25).every(Boolean)) throw creatorError('所选模型的独立接口配置不完整。', 503, 'CREATOR_MODEL_NOT_CONFIGURED');
          if (!settings.generateAudio && c.assets.some(a => a.type === 'audio')) throw creatorError('已选择声音参考，请开启音频或移除声音素材。');
          if ([...store.records.values()].filter(x => x.userId === userId).flatMap(x => x.tasks).filter(pending).length >= 2) throw creatorError('已有两条视频处理中，请稍后再试。', 429);
          if (c.tasks.length >= 20) throw creatorError('本次创作视频较多，请新建创作。');
          task = { id: input.requestId, settings, skill: c.skill, scriptId: input.scriptId || null, title: c.operations.find(o => o.id === input.scriptId)?.result?.script?.title || VIDEO_SKILLS.find(s => s.id === c.skill).name,
            prompt: input.prompt.trim(), fingerprint, assetIds: [...referenceImageIds, ...c.assets.filter(a => a.type === 'audio').map(a => a.id)], status: 'reserving', createdAt: now(), startedAt: now() };
          c.tasks.push(task); c.recordExpiresAt = now() + 30 * DAY; await save(c);
          try {
            if (credits) {
              const scope = costScope(c, costId('video', task.id)); let hold;
              if (meter.enabled) { const reserved = await credits.reserveCost(scope); task.billing = { status: reserved.status, exempt: reserved.exempt }; hold = await credits.prepareCostCall({ ...scope, receiptId: 'render', quoteCny: settings.duration * cnyPerSecond, provider: 'seedance', metadata: { model: settings.model, currency: 'CNY', unitPrice: cnyPerSecond } }); task.costPrepared = true; }
              else hold = await credits.reserve({ ...scope, kind: 'video', units: settings.duration });
              task.billing = { status: hold.status, reservedPoints: hold.reservedPoints, chargedPoints: 0, exempt: hold.exempt };
            }
            task.status = 'preparing'; await save(c);
          } catch (cause) { await failTask(c, task, cause); throw cause; }
        }); json(res, 202, { task: taskView(c, task) }); void tick(); return;
      }
      throw creatorError('接口不存在。', 404, 'CREATOR_NOT_FOUND');
    } catch (cause) { if (res.headersSent) { res.end(); return; } json(res, cause.status || 503, safe(cause)); }
  };
  handler.ready = ready;
  handler.shutdown = () => shutdown ||= (async () => { closing = true; clearInterval(timer); for (const c of controllers.values()) c.abort();
    for (const res of streams) res.end(); await ready.catch(() => {}); clearInterval(timer);
    await Promise.allSettled([...workers.values(), ...locks.values()]); await store.close(); })();
  return handler;
}
