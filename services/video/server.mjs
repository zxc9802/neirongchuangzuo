import { mkdir, readFile, writeFile, rename, readdir, rm, stat, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRequestLedger } from '../ai/request-ledger.mjs';
import { calculateCredits } from '../credits/store.mjs';
import { createVideoProvider, videoConfig, VideoError, MODEL, DURATIONS, PROMPT } from './provider.mjs';
import { VIDEO_LIMIT, PHOTO_LIMIT, probeVideo, normalizePhoto, muteVideo, downloadVideo, serveMedia } from './media.mjs';
import { createSpeechService, confirmSpeech, normalizeVoice, compareSpeech, VOICE_LIMIT } from './speech.mjs';
import { createFalVideoProvider, FAL_MODEL } from './fal.mjs';
import { createCaptionService, captionSpeech } from './captions.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PREFIX = '/api/video-replica';
const DAY = 86400_000;
const ACTIVE = new Set(['reserving', 'preparing', 'reviewing', 'submitting', 'running', 'downloading', 'verifying']);
const RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const error = (message, status = 400, code) => new VideoError(message, status, code);
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify(value)); };
export const isVideoSourcePath = path => /^\/api\/video-replica\/source\/[a-f0-9-]{36}\/(video|photo|voice)$/.test(path);

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
  try { return JSON.parse((await readBody(req, 20_000)).toString()); }
  catch (cause) { if (cause instanceof VideoError) throw cause; throw error('请求格式无效。'); }
}

export function createVideoHandler({ storageDir, env = process.env, publicOrigin, credits,
  config = videoConfig(env, publicOrigin), provider = createVideoProvider(config), falProvider = createFalVideoProvider(config), probe = probeVideo,
  photo = normalizePhoto, mute = muteVideo, voice = normalizeVoice, speech = createSpeechService(env), captions = createCaptionService(env), download = downloadVideo, now = Date.now, pollIntervalMs = 5000 } = {}) {
  const jobs = new Map(), locks = new Map(), processors = new Map();
  const models = [{ id: MODEL, name: '旗舰模型', resolution: '720p', enabled: Boolean(config.enabled) }];
  const enabled = models.some(model => model.enabled);
  function selectedModel(id = MODEL) {
    const model = models.find(model => model.id === id);
    if (!model) throw error('当前仅支持旗舰模型，请刷新页面后重新提交。', 400, 'VIDEO_MODEL_INVALID');
    if (!model.enabled) throw error(`${model.name}尚未配置，请联系管理员。`, 503, 'VIDEO_NOT_CONFIGURED');
    return model.id;
  }
  // Share the existing durable single-writer lock implementation, in a separate directory.
  const instance = createRequestLedger({ storageDir });
  let closing = false, fatal = false, timer, shutdownPromise;
  const folder = task => join(storageDir, task.id);
  const file = (task, kind) => join(folder(task), kind === 'photo' ? 'photo.jpg' : kind === 'video' ? 'source.mp4' : kind === 'voice' ? 'reference.wav' : 'result.mp4');
  const mime = kind => kind === 'photo' ? 'image/jpeg' : kind === 'voice' ? 'audio/wav' : 'video/mp4';
  const isExpired = task => !ACTIVE.has(task.status) && task.expiresAt <= now();
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
    const expired = isExpired(task);
    return { id: task.id, kind: 'video', status: expired ? 'expired' : task.status === 'completed' && !settled ? 'settling' : task.status,
      createdAt: task.createdAt, completedAt: task.completedAt, expiresAt: task.expiresAt, duration: task.duration, actualDuration: task.actualDuration,
      startedAt: task.recheckStartedAt || task.startedAt, lastCheckedAt: task.lastCheckedAt,
      ratio: task.ratio, video: task.video, photo: task.photo, voice: task.voice, speech: task.speech, captions: task.captions,
      captionsChecked: task.captionsChecked, captionCheck: task.captionCheck, audioCheck: task.audioCheck, error: task.error || '', code: task.code,
      model: task.model || MODEL, modelName: task.model === FAL_MODEL ? '极速模型' : '旗舰模型',
      resolution: task.model === FAL_MODEL ? '768p' : '720p',
      sourceVideoUrl: !expired && task.video ? `${PREFIX}/tasks/${task.id}/video` : null,
      sourcePhotoUrl: !expired && task.photo ? `${PREFIX}/tasks/${task.id}/photo` : null,
      sourceVoiceUrl: !expired && task.voice ? `${PREFIX}/tasks/${task.id}/voice` : null,
      canRecheck: !expired && task.status === 'failed' && task.rawReady === true && Boolean(task.voice && task.speech)
        && (!credits || task.billing?.status === 'released'),
      downloadProgress: task.downloadProgress,
      estimatedPoints: task.billing?.exempt === true ? 0 : task.duration ? calculateCredits('video', task.duration) : null,
      billing: task.billing && { source: 'workspace', status: task.billing.status, reservedPoints: task.billing.reservedPoints, chargedPoints: task.billing.chargedPoints, exempt: task.billing.exempt === true },
      resultUrl: !expired && task.status === 'completed' && settled ? `${PREFIX}/tasks/${task.id}/result` : null };
  }
  async function reconcile(task) {
    if (!credits || !['completed', 'failed', 'expired'].includes(task.status) || ['settled', 'released'].includes(task.billing?.status)) return;
    try {
      const taskId = task.billingTaskId || task.id;
      let record = await credits.reservation(task.userId, taskId);
      if (record?.status === 'reserved') record = task.status === 'completed'
        ? await credits.settle({ userId: task.userId, taskId, units: Math.min(task.duration, task.actualDuration) })
        : await credits.release({ userId: task.userId, taskId });
      task.billing = record ? { status: record.status, reservedPoints: record.reservedPoints, chargedPoints: record.chargedPoints, exempt: record.exempt === true }
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
  async function analyzeSource(task) {
    if (!task.captionsChecked) {
      try { task.captions = await captions.extract(file(task, 'video')); }
      catch { task.captionCheck = { warning: '原视频字幕未能提取，将继续使用原视频人声。' }; }
      task.captionsChecked = true;
    }
    if ((!task.speech || task.speech.source !== 'subtitles') && task.captions?.cues?.length) {
      const intervals = task.video.audio ? await speech.detect(file(task, 'video')).catch(() => []) : [];
      task.speech = captionSpeech(task.captions, intervals);
      task.originalSpeech = structuredClone(task.speech);
    } else if (!task.speech && task.voice) {
      if (!task.video.audio) throw error('参考视频没有音轨，无法保留原台词。', 422, 'VIDEO_SPEECH_INVALID');
      task.speech = await speech.analyze(file(task, 'video'), task.video.duration, { diagnosticsPath: join(folder(task), 'verification-source.json') });
      task.originalSpeech = structuredClone(task.speech);
    }
    await save(task);
  }
  async function renderCaptions(task, input) {
    if (!task.captions?.cues?.length) return;
    const output = join(folder(task), 'result-caption.tmp');
    try {
      await captions.render(input, output, task.captions);
      const metadata = await probe(output);
      if (!metadata.audio || Math.abs(metadata.duration - task.actualDuration) > 0.1) throw new Error('Invalid caption render');
      await rename(output, input);
      task.captionCheck = { rendered: true, source: 'subtitles', cueCount: task.captions.cues.length };
    } catch {
      // Caption processing must never discard a playable model result.
      await rm(output, { force: true });
      task.captionCheck = { rendered: false, warning: '原字幕合成未完成，已保留可播放成片，请预览核对字幕。' };
    }
  }
  async function acceptResult(task, result) {
    task.lastCheckedAt = now();
    if (result.failed) { await fail(task, '视频生成失败，预留积分将退回。请检查参考素材后重新创建任务。', 'VIDEO_GENERATION_FAILED'); return; }
    if (result.taskId) task.providerId = result.taskId;
    if (result.falQueue) task.falQueue = result.falQueue;
    if (result.url) { task.resultSource = result.url; task.status = 'downloading'; }
    else if (task.providerId) task.status = 'running';
    else { await fail(task, '模型未返回任务编号，未自动重试。请核对模型服务记录后再创建任务。', 'VIDEO_SUBMISSION_UNCERTAIN'); return; }
    task.error = ''; delete task.code;
    if (result.completed && !result.url) {
      task.error = '模型已返回完成状态，但尚未提供可下载成片，正在重新查询原任务。';
      task.code = 'VIDEO_RESULT_PENDING';
    }
    await save(task);
  }
  async function processTask(task) {
    if (closing || fatal) return;
    // Retain the provider only to finish tasks submitted before H3 Max was removed.
    const taskProvider = task.model === FAL_MODEL ? falProvider : provider;
    if (isExpired(task)) {
      if (task.status !== 'expired') {
        task.status = 'expired'; task.error = '素材和成片已超过保存期限。'; task.code = 'VIDEO_EXPIRED'; await save(task);
      }
      await reconcile(task);
      if (!task.cleaned) {
        for (const name of ['photo.jpg', 'source.mp4', 'source-clean.mp4', 'source-clean.mp4.captions.json', 'source-silent.mp4', 'reference.wav', 'voice.tmp.wav', 'generated.mp4', 'result.mp4', 'result-caption.tmp', 'result-caption.tmp.captions.json', 'upload.tmp', 'result.tmp', 'result.tmp.download.json', 'verification-source.json', 'verification-generated.json', 'verification-aligned.json', 'source.mp4.asr.wav', 'source.mp4.vad.pcm', 'reference.wav.vad.pcm', 'voice.tmp.wav.vad.pcm', 'generated.mp4.asr.wav', 'generated.mp4.vad.pcm', 'result.tmp.asr.wav', 'result.tmp.vad.pcm', 'result.tmp.aligned.pcm']) await rm(join(folder(task), name), { force: true });
        task.cleaned = true; await save(task);
      }
      return;
    }
    if (['completed', 'failed', 'expired'].includes(task.status)) { await reconcile(task); return; }
    if (!ACTIVE.has(task.status)) return;
    if (task.status === 'preparing') {
      await analyzeSource(task);
      if (task.voice && !task.videoAudioRemoved) {
        await mute(file(task, 'video'), join(folder(task), 'source-silent.mp4'));
        task.videoAudioRemoved = true;
      }
      task.status = 'reviewing'; await save(task);
    }
    if (task.status === 'reviewing') {
      for (const kind of ['photo', 'video', ...(task.voice ? ['voice'] : [])]) {
        if (!task.materials[kind]) { task.materials[kind] = await taskProvider.createMaterial(sourceUrl(task, kind), kind); await save(task); }
        const material = task.materials[kind];
        if (material.status !== 2) material.status = await taskProvider.queryMaterial(material.id);
        if (material.status === 3) { await fail(task, `${kind === 'photo' ? '人物照片' : kind === 'voice' ? '声音参考' : '参考视频'}未通过素材审核，请更换清晰、符合要求的素材。`, 'VIDEO_REVIEW_REJECTED'); return; }
        await save(task);
      }
      if (Object.values(task.materials).some(value => value.status !== 2)) return;
      // Persist the dispatch boundary before making the paid call. Never replay it after a restart.
      task.status = 'submitting'; await save(task);
      try { await acceptResult(task, await taskProvider.generate(task)); }
      catch (cause) {
        if (fatal) throw cause;
        await fail(task, cause instanceof VideoError && cause.code === 'VIDEO_PROVIDER_REJECTED' ? cause.message : '提交未获得确认，未自动重复生成。请核对模型服务记录后再创建任务，预留积分将退回。', cause.code === 'VIDEO_PROVIDER_REJECTED' ? cause.code : 'VIDEO_SUBMISSION_UNCERTAIN');
      }
    } else if (task.status === 'running') await acceptResult(task, await taskProvider.query(task.providerId, task));
    if (task.status === 'downloading') {
      const temporary = join(folder(task), 'result.tmp');
      let savedAt = 0;
      let progressWrites = Promise.resolve();
      try {
        await download(task.resultSource, temporary, { onProgress: progress => {
          task.downloadProgress = { receivedBytes: progress.bytes, totalBytes: progress.totalBytes };
          if (progress.complete || now() - savedAt >= 1000) {
            savedAt = now(); progressWrites = progressWrites.then(() => save(task));
            void progressWrites.catch(() => {});
          }
        } });
      } finally { await progressWrites; }
      const metadata = await probe(temporary);
      if (metadata.duration > task.duration + 1 || metadata.duration < 1 || !metadata.audio) throw error('成片缺少声音或时长不符合要求，预留积分将退回。', 502, 'VIDEO_RESULT_INVALID');
      await rename(temporary, task.voice || task.captions ? join(folder(task), 'generated.mp4') : file(task, 'result'));
      task.actualDuration = Math.round(metadata.duration * 1000) / 1000;
      if (task.voice || task.captions) { task.rawReady = true; task.status = 'verifying'; task.error = ''; delete task.code; await save(task); }
      else { await complete(task); }
    }
    if (task.status === 'verifying') {
      const generated = join(folder(task), 'generated.mp4'), aligned = join(folder(task), 'result.tmp');
      if (!task.voice) await copyFile(generated, aligned);
      else try {
        task.verificationStage = 'generated'; await save(task);
        const timeline = await speech.analyze(generated, task.actualDuration, { diagnosticsPath: join(folder(task), 'verification-generated.json') });
        task.verificationStage = 'aligning'; await save(task);
        const check = await speech.align(generated, aligned, task.speech, timeline, task.actualDuration);
        task.verificationStage = 'aligned'; await save(task);
        const verified = await speech.analyze(aligned, task.actualDuration, { diagnosticsPath: join(folder(task), 'verification-aligned.json') });
        const rawComparison = compareSpeech(task.speech.text, timeline.text), comparison = compareSpeech(task.speech.text, verified.text);
        if (!rawComparison.accepted || !comparison.accepted
          || verified.segments.length !== task.speech.segments.length
          || verified.segments.some((segment, index) => Math.abs(segment.start - task.speech.segments[index].start) > 0.1 || Math.abs(segment.end - task.speech.segments[index].end) > 0.1)) {
          throw error('声音无法可靠校正，保留模型生成的声音。', 422, 'VIDEO_SPEECH_INVALID');
        }
        task.audioCheck = { ...check, transcriptMatched: rawComparison.exact && comparison.exact,
          transcriptDifferences: Math.max(rawComparison.differences, comparison.differences),
          afterOffsetMs: Math.round((verified.start - task.speech.start) * 1000), lipSync: 'needs_preview' };
      } catch (cause) {
        if (cause.code !== 'VIDEO_SPEECH_INVALID') throw cause;
        // Transcript/timing checks decide whether correction is safe, never whether to deliver.
        await copyFile(generated, aligned);
        task.audioCheck = { corrected: false, transcriptMatched: null, transcriptDifferences: null, afterOffsetMs: null,
          warning: '已保留模型生成的声音，请预览核对台词、音色与开口时间。', lipSync: 'needs_preview' };
      }
      const metadata = await probe(aligned);
      if (!metadata.audio || Math.abs(metadata.duration - task.actualDuration) > 0.1) throw error('声音校正后的成片无效。', 502, 'VIDEO_RESULT_INVALID');
      await renderCaptions(task, aligned);
      await rename(aligned, file(task, 'result')); await complete(task);
    }
  }
  async function complete(task) {
      task.status = 'completed'; task.error = ''; delete task.code;
      task.completedAt = now();
      task.expiresAt = now() + 3 * DAY;
      await save(task); await reconcile(task);
  }
  async function tick() {
    if (closing || fatal) return;
    for (const task of jobs.values()) {
      if (processors.has(task.id)) continue;
      const processing = serialize(task.id, async () => {
      try { await processTask(task); }
      catch (cause) {
        if (fatal) return;
        if (task.status === 'preparing') { await fail(task, cause instanceof VideoError ? cause.message : '素材自动处理未完成，预留积分将退回。', cause.code || 'VIDEO_SPEECH_FAILED'); return; }
        if (task.status === 'verifying') { await fail(task, cause instanceof VideoError ? cause.message : '成片声音检查未完成，预留积分将退回。', cause.code || 'VIDEO_SPEECH_FAILED'); return; }
        if (task.status === 'reviewing' && cause instanceof VideoError && ['VIDEO_PROVIDER_IP_DENIED', 'VIDEO_PROVIDER_REJECTED', 'VIDEO_MATERIAL_INVALID'].includes(cause.code)) {
          await fail(task, cause.message, cause.code); return;
        }
        if (cause.code === 'VIDEO_RESULT_INVALID') { await fail(task, cause.message, cause.code); return; }
        // Queries and result downloads can be retried without another paid generation call.
        task.error = task.status === 'downloading' ? '成片正在保存，将自动重试下载。' : '模型服务暂时不可用，正在查询原任务。';
        task.code = 'VIDEO_QUERY_PENDING'; await save(task);
      }
      });
      processors.set(task.id, processing);
      void processing.finally(() => processors.delete(task.id)).catch(() => { fatal = true; });
    }
  }
  const ready = (async () => {
    await instance.ready;
    for (const entry of await readdir(storageDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const task = JSON.parse(await readFile(join(storageDir, entry.name, 'task.json'), 'utf8'));
      if (task.id !== entry.name || typeof task.userId !== 'string') throw new Error('Invalid video task');
      jobs.set(task.id, task);
      if (task.voice && task.actualDuration && !task.cleaned) {
        task.rawReady = await stat(join(folder(task), 'generated.mp4')).then(info => info.isFile() && info.size > 0, () => false);
      }
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
      const source = /^\/api\/video-replica\/source\/([a-f0-9-]{36})\/(video|photo|voice)$/.exec(path);
      if (source) {
        const task = jobs.get(source[1]), expires = Number(url.searchParams.get('expires')), supplied = url.searchParams.get('signature') || '';
        const valid = config.signingSecret && /^\d{13}$/.test(url.searchParams.get('expires') || '') && /^[a-f0-9]{64}$/.test(supplied)
          && timingSafeEqual(Buffer.from(supplied), Buffer.from(signature(source[1], source[2], expires)));
        // Keep the original signed URL usable while its generation is still active.
        if (!['GET', 'HEAD'].includes(req.method) || !task || !valid || (expires <= now() && !ACTIVE.has(task.status)) || expires !== task.startedAt + DAY || task.status === 'expired') throw error('素材链接不可用或已过期。', 403, 'VIDEO_SOURCE_FORBIDDEN');
        if (!task[source[2]]) throw error('素材尚未上传。', 404, 'VIDEO_NOT_FOUND');
        const input = source[2] === 'video' && task.videoAudioRemoved ? join(folder(task), 'source-silent.mp4')
          : source[2] === 'video' && task.videoCaptionsRemoved ? join(folder(task), 'source-clean.mp4') : file(task, source[2]);
        await serveMedia(req, res, input, mime(source[2])); return;
      }
      const userId = req.authenticatedUserId;
      if (!userId) throw error('请先登录后继续。', 401, 'UNAUTHENTICATED');
      if (!['GET', 'HEAD'].includes(req.method)) {
        const expected = publicOrigin ? new URL(publicOrigin).origin : `http://${req.headers.host}`;
        if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && req.headers.origin !== expected) throw error('请求来源无效。', 403, 'VIDEO_ORIGIN_REJECTED');
        if (closing || fatal) throw error('视频服务暂时不可用，请稍后查询原任务。', 503, 'VIDEO_UNAVAILABLE');
      }
      if (path === `${PREFIX}/config` && req.method === 'GET') { json(res, 200, { enabled, models, voiceEnabled: speech.enabled, model: models.find(model => model.enabled)?.id || MODEL, prompt: PROMPT, durations: DURATIONS, videoLimit: VIDEO_LIMIT, photoLimit: PHOTO_LIMIT, voiceLimit: VOICE_LIMIT }); return; }
      if (path === `${PREFIX}/tasks` && req.method === 'GET') {
        const tasks = [...jobs.values()].filter(task => task.userId === userId).sort((a, b) => b.createdAt - a.createdAt).map(view);
        json(res, 200, { tasks: url.searchParams.get('completed') === 'true' ? tasks.filter(task => task.status === 'completed') : tasks.slice(0, 50) }); return;
      }
      if (path === `${PREFIX}/tasks` && req.method === 'POST') {
        if (!enabled) throw error('人物复刻服务尚未配置，请联系管理员。', 503, 'VIDEO_NOT_CONFIGURED');
        const body = await readJSON(req);
        if (!UUID.test(body?.requestId)) throw error('任务编号无效。');
        await serialize('create', async () => {
          const existing = jobs.get(body.requestId);
          if (existing) { if (existing.userId !== userId) throw error('任务不存在。', 404); json(res, 200, { task: view(existing) }); return; }
          const task = { id: body.requestId, userId, model: selectedModel(body.model), status: 'draft', createdAt: now(), expiresAt: now() + DAY, materials: {} };
          await save(task); jobs.set(task.id, task); json(res, 201, { task: view(task) });
        }); return;
      }
      const match = /^\/api\/video-replica\/tasks\/([a-f0-9-]{36})(?:\/(video|photo|voice|analyze|speech|recheck|start|result))?$/.exec(path);
      const task = match && jobs.get(match[1]);
      if (!task || task.userId !== userId) throw error('任务不存在。', 404, 'VIDEO_NOT_FOUND');
      if (!match[2] && req.method === 'GET') { json(res, 200, { task: view(task) }); return; }
      if (isExpired(task)) throw error('素材或成片已过期，请重新上传。', 410, 'VIDEO_EXPIRED');
      if (['video', 'photo', 'voice'].includes(match[2]) && ['GET', 'HEAD'].includes(req.method)) {
        if (!task[match[2]]) throw error('素材尚未上传。', 404, 'VIDEO_NOT_FOUND');
        await serveMedia(req, res, file(task, match[2]), mime(match[2])); return;
      }
      if (match[2] === 'result' && ['GET', 'HEAD'].includes(req.method)) {
        if (!view(task).resultUrl) throw error('成片尚未准备好。', 409, 'VIDEO_NOT_READY');
        await serveMedia(req, res, file(task, 'result'), 'video/mp4', url.searchParams.get('download') === '1'); return;
      }
      await serialize(task.id, async () => {
        if (['video', 'photo', 'voice'].includes(match[2]) && req.method === 'PUT') {
          if (task.status !== 'draft') throw error('任务已提交，不能替换素材。', 409);
          const kind = match[2], bytes = await readBody(req, kind === 'video' ? VIDEO_LIMIT : kind === 'voice' ? VOICE_LIMIT : PHOTO_LIMIT);
          const temporary = join(folder(task), 'upload.tmp');
          if (kind === 'photo') {
            const normalized = await photo(bytes); await writeFile(temporary, normalized, { mode: 0o600 });
            task.photo = { ready: true };
          } else if (kind === 'voice') {
            if (!speech.enabled) throw error('声音参考的语音识别服务尚未配置。', 503, 'VIDEO_SPEECH_NOT_CONFIGURED');
            await writeFile(temporary, bytes, { mode: 0o600 });
            const normalized = join(folder(task), 'voice.tmp.wav');
            const metadata = await voice(temporary, normalized);
            const intervals = await speech.detect(normalized).catch(cause => {
              if (cause.code !== 'VIDEO_SPEECH_INVALID') throw cause;
              return [];
            });
            await rename(normalized, file(task, 'voice')); task.voice = { ...metadata, speechStart: intervals[0]?.start ?? null }; delete task.speech; delete task.originalSpeech; delete task.speechConfirmedAt;
            await save(task); json(res, 200, { task: view(task) }); return;
          } else {
            if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw error('请上传 MP4 或 MOV 视频。');
            await writeFile(temporary, bytes, { mode: 0o600 });
            const metadata = await probe(temporary);
            if (metadata.duration < 2 || metadata.duration > 15 || metadata.width < 300 || metadata.height < 300) throw error('参考视频需为 2–15 秒，宽高至少 300 像素。');
            task.video = metadata;
            delete task.videoAudioRemoved;
            delete task.videoCaptionsRemoved; delete task.captions; delete task.captionsChecked; delete task.captionCheck;
            delete task.speech;
            delete task.originalSpeech; delete task.speechConfirmedAt;
            task.duration = DURATIONS.find(value => value >= Math.ceil(metadata.duration - 0.05)) || 15;
            task.ratio = RATIOS.reduce((best, ratio) => {
              const value = text => text.split(':').reduce((a, b) => a / b);
              return Math.abs(value(ratio) - metadata.width / metadata.height) < Math.abs(value(best) - metadata.width / metadata.height) ? ratio : best;
            });
          }
          await rename(temporary, file(task, kind)); await save(task); json(res, 200, { task: view(task) }); return;
        }
        if (match[2] === 'analyze' && req.method === 'POST') {
          await readJSON(req);
          if (task.status !== 'draft' || !task.video) throw error('请先上传参考视频，再分析台词。', 409);
          await analyzeSource(task);
          json(res, 200, { task: view(task) }); return;
        }
        if (match[2] === 'speech' && req.method === 'POST') {
          const body = await readJSON(req);
          if (task.status !== 'draft' && !view(task).canRecheck) throw error('当前任务不能修改台词。', 409);
          if (!task.speech) throw error('请先分析原视频台词。', 409);
          const original = task.originalSpeech || structuredClone(task.speech);
          let confirmed;
          if (task.captions) {
            const edited = confirmSpeech({ segments: task.captions.cues }, body.segments);
            task.captions.cues = edited.segments;
            confirmed = captionSpeech(task.captions, original.segments);
          } else confirmed = confirmSpeech(original, body.segments);
          task.originalSpeech = original; task.speech = confirmed; task.speechConfirmedAt = now();
          await save(task); json(res, 200, { task: view(task) }); return;
        }
        if (match[2] === 'recheck' && req.method === 'POST') {
          await readJSON(req);
          if (task.status !== 'failed') { json(res, 200, { task: view(task) }); return; }
          await reconcile(task);
          if (!view(task).canRecheck || !(await stat(join(folder(task), 'generated.mp4')).catch(() => null))?.isFile()) throw error('没有可复核的成片，请重新上传素材。', 409);
          // A refunded reservation is immutable. A separate recovery reservation
          // keeps the original refund auditable and can settle this delivery once.
          task.recheckAttempt = (task.recheckAttempt || 0) + 1;
          task.billingTaskId = `video-recheck:${task.id}:${task.recheckAttempt}`;
          task.recheckStartedAt = now();
          task.billing = { status: 'reserve_pending', reservedPoints: 0, chargedPoints: 0, exempt: task.billing?.exempt === true };
          task.status = 'reserving'; task.error = ''; delete task.code; await save(task);
          try {
            if (credits) {
              const record = await credits.reserve({ userId, taskId: task.billingTaskId, kind: 'video', units: task.duration });
              task.billing = { status: record.status, reservedPoints: record.reservedPoints, chargedPoints: record.chargedPoints, exempt: record.exempt === true };
            }
            task.status = 'verifying'; await save(task);
          } catch (cause) {
            if (fatal) throw cause;
            await fail(task, cause.code === 'INSUFFICIENT_POINTS' ? '积分不足，未开始复核。' : '积分服务暂时不可用，未开始复核。', cause.code || 'CREDITS_UNAVAILABLE'); throw cause;
          }
          json(res, 202, { task: view(task) }); return;
        }
        if (match[2] === 'start' && req.method === 'POST') {
          const body = await readJSON(req);
          if (task.status !== 'draft') { json(res, 200, { task: view(task) }); return; }
          if (!task.photo || !task.video) throw error('请先上传一段参考视频和一张人物照片。');
          task.model = selectedModel(body.model);
          task.status = 'reserving'; task.startedAt = now(); task.expiresAt = now() + 3 * DAY; await save(task);
          try {
            if (credits) {
              const record = await credits.reserve({ userId, taskId: task.id, kind: 'video', units: task.duration });
              task.billing = { status: record.status, reservedPoints: record.reservedPoints, chargedPoints: record.chargedPoints, exempt: record.exempt === true };
            }
            task.status = 'preparing'; await save(task);
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
    await Promise.allSettled([...processors.values()]); await Promise.allSettled([...locks.values()]); await instance.close();
  })();
  return handler;
}
