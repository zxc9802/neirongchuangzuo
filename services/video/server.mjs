import { mkdir, readFile, writeFile, rename, readdir, rm, stat, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRequestLedger } from '../ai/request-ledger.mjs';
import { calculateCredits } from '../credits/store.mjs';
import { costPoints } from '../credits/costs.mjs';
import { generationPrice, generationPoints } from '../../design/malaysian-prices.js';
import { createApiCostMeter } from '../credits/meter.mjs';
import { loadAIConfig } from '../ai/server.mjs';
import { createVideoProvider, videoConfig, VideoError, MODEL, MODELS, DURATIONS, PROMPT, PIXVERSE_MODEL, WAN_MODEL, WAN3_MODEL } from './provider.mjs';
import { VIDEO_LIMIT, PHOTO_LIMIT, probeVideo, normalizeSeedanceVideo, removeVideoAudio, normalizePhoto, downloadVideo, serveMedia } from './media.mjs';
import { createSpeechService, confirmSpeech, normalizeVoice, compareSpeech, VOICE_LIMIT } from './speech.mjs';
import { createFalVideoProvider, FAL_MODEL } from './fal.mjs';
import { createPixverseProvider } from './pixverse.mjs';
import { createWanProvider } from './wan.mjs';
import { createWan3Provider, wan3Price, wan3Usage } from './wan3.mjs';
import { createCaptionService, captionSpeech } from './captions.mjs';
import { createNarrationService } from './narration.mjs';
import { createVoiceConversionService } from './voice-conversion.mjs';
import { createLipsyncService } from './lipsync.mjs';
import { createProviderStorage } from './provider-storage.mjs';
import { languageRoute } from './languages.mjs';
import { createLocalizationService } from './localization.mjs';
import { createHeygenLipsyncService } from './heygen.mjs';
import { planSegments, speechPauses, detectSceneCuts, cutVideoSegment, joinVideoSegments } from './segments.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PREFIX = '/api/video-replica';
const DAY = 86400_000;
const MATERIAL_QUERY_RETRIES = 5;
const ACTIVE = new Set(['reserving', 'preparing', 'reviewing', 'submitting', 'running', 'downloading', 'verifying']);
const RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const isFalReplacement = model => model === PIXVERSE_MODEL || model === WAN_MODEL;
const error = (message, status = 400, code) => new VideoError(message, status, code);
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify(value)); };
export const isVideoSourcePath = path => /^\/api\/video-replica\/source\/[a-f0-9-]{36}\/(video|photo|voice|generated|narration|emotion-\d{1,2}|segment-\d)$/.test(path);

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
  config = videoConfig(env, publicOrigin), provider, falProvider, pixverseProvider, wanProvider, wan3Provider, fetchImpl = fetch, probe = probeVideo,
  photo = normalizePhoto, voice = normalizeVoice, speech, captions = createCaptionService(env),
  narration, lipsync, voiceConversion, localization, heygen, materialLibrary, providerStorage = createProviderStorage(env), download = downloadVideo,
  scenes = detectSceneCuts, cutSegment = cutVideoSegment, joinSegments = joinVideoSegments, now = Date.now, pollIntervalMs = 5000 } = {}) {
  const jobs = new Map(), locks = new Map(), processors = new Map();
  const costMeter=createApiCostMeter({credits,config:loadAIConfig(env),fetchImpl});
  if (speech === undefined) speech = createSpeechService(env, costMeter.fetch);
  if (narration === undefined) narration = createNarrationService(env, { fetchImpl: costMeter.fetch, recoverReceipt: costMeter.recoverFalRequest, now });
  if (lipsync === undefined) lipsync = createLipsyncService(env, costMeter.fetch);
  if (voiceConversion === undefined) voiceConversion = createVoiceConversionService(env, { fetchImpl: costMeter.fetch, download, upload: providerStorage.upload });
  if (heygen === undefined) heygen = createHeygenLipsyncService(env, costMeter.fetch);
  if (localization === undefined) localization = createLocalizationService(env, { fetchImpl: costMeter.fetch, download,
    upload: providerStorage.upload, detect: path => speech.detect(path) });
  provider ||= createVideoProvider(config,costMeter.fetch);
  falProvider ||= createFalVideoProvider(config,costMeter.fetch);
  pixverseProvider ||= createPixverseProvider(config,costMeter.fetch);
  wanProvider ||= createWanProvider(config,costMeter.fetch);
  wan3Provider ||= createWan3Provider(config,costMeter.fetch);
  const models = MODELS.map(model => ({ ...model, enabled: Boolean(isFalReplacement(model.id)
    ? config.falEnabled && (!credits || costMeter.enabled) : model.id === WAN3_MODEL
      ? config.wan3Enabled : config.enabled) }));
  const voiceEngines = [{ id: 'seedance', name: 'Seedance 2.0', enabled: Boolean(config.enabled) },
    { id: 'indextts2', name: 'IndexTTS2', enabled: Boolean(narration?.enabled && lipsync?.enabled) },
    { id: 'chatterbox', name: 'Chatterbox 音色转换', enabled: Boolean(voiceConversion?.enabled) }];
  const enabled = models.some(model => model.enabled);
  function selectedVoiceEngine(id = 'indextts2') {
    if (!voiceEngines.some(engine => engine.id === id)) throw error('配音模型无效，请刷新页面后重新选择。', 400, 'VIDEO_VOICE_ENGINE_INVALID');
    return id;
  }
  function selectedModel(id = MODEL) {
    const model = models.find(model => model.id === id);
    if (!model) throw error('请选择有效的生成版本，请刷新页面后重新提交。', 400, 'VIDEO_MODEL_INVALID');
    if (!model.enabled) throw error(`${model.name}尚未配置，请联系管理员。`, 503, 'VIDEO_NOT_CONFIGURED');
    return model.id;
  }
  function selectedSourceAudioMode(mode = 'original', model = MODEL) {
    if (!['original', 'silent'].includes(mode) || mode === 'silent' && !MODELS.some(item => item.id === model && !isFalReplacement(item.id))) {
      throw error('参考视频声音模式无效，无原声参考模式仅适用于 Seedance 生成版本。', 400, 'VIDEO_SOURCE_AUDIO_MODE_INVALID');
    }
    return mode;
  }
  function cnyPerSecond(task) {
    if (task.model === WAN3_MODEL) return task.status === 'draft' ? wan3Price(now()) : task.cnyPerSecond ?? wan3Price(task.startedAt);
    // Submitted tasks without a snapshot predate model pricing and retain 1 CNY/second.
    return task.cnyPerSecond ?? (task.status === 'draft' ? models.find(model => model.id === (task.model || MODEL))?.cnyPerSecond ?? 1 : 1);
  }
  const generationReceipt = task => task.model === WAN3_MODEL ? 'wan3' : 'seedance';
  const costPrepared = task => task.model === WAN3_MODEL ? task.wan3CostPrepared : task.seedanceCostPrepared;
  const generationQuote = task => (task.model === WAN3_MODEL ? task.video.duration + task.duration : task.duration) * cnyPerSecond(task);
  async function prepareGenerationCost(task) {
    const record = await credits.prepareCostCall({ userId: task.userId, taskId: task.billingTaskId || task.id,
      receiptId: generationReceipt(task), quoteCny: generationQuote(task), provider: task.model === WAN3_MODEL ? 'dashscope' : 'video-replica',
      metadata: { model: task.model || MODEL, currency: 'CNY', unitPrice: cnyPerSecond(task) } });
    if (task.model === WAN3_MODEL) task.wan3CostPrepared = true; else task.seedanceCostPrepared = true;
    return record;
  }
  async function finishWan3Cost(task, result) {
    if (result.usage) task.wan3Usage = wan3Usage(result.usage);
    if (task.billing?.mode !== 'api_cost' || !task.wan3CostPrepared) return;
    const terminal = ['failed', 'cancelled', 'expired'].includes(task.status);
    const usage = task.segments ? task.segments.every(segment => segment.wan3Usage || segment.failed || terminal && !segment.providerDispatched)
      ? { duration: task.segments.reduce((sum, segment) => sum + (segment.wan3Usage?.duration || 0), 0) } : undefined : task.wan3Usage;
    await credits.finishCostCall({ userId: task.userId, taskId: task.billingTaskId || task.id, receiptId: 'wan3',
      ...(result.failed && !task.segments ? { costCny: 0 } : usage ? { costCny: usage.duration * cnyPerSecond(task) } : { uncertain: true }),
      ...(task.providerId ? { providerRequestId: task.providerId } : {}) });
  }
  // Without a custom duration the whole source must fit the model's own limit, as before.
  // With one, only that many opening seconds are generated, up to the extended limit.
  function selectedTargetDuration(value, modelId) {
    if (value === undefined || value === null) return undefined;
    const limit = models.find(model => model.id === modelId)?.extendedDuration;
    if (!limit) throw error('所选生成版本不支持自定义时长。', 400, 'VIDEO_TARGET_DURATION_INVALID');
    if (!Number.isInteger(value) || value < 2 || value > limit) throw error(`自定义时长需为 2–${limit} 之间的整数秒。`, 400, 'VIDEO_TARGET_DURATION_INVALID');
    return value;
  }
  const targetFor = (task, modelId) => models.find(model => model.id === modelId)?.extendedDuration ? task.targetDuration : undefined;
  const clip = (video, target) => target && video.duration > target ? { ...video, duration: target } : video;
  function videoDuration(source, modelId, target) {
    const model = models.find(model => model.id === modelId), limit = target ? model.extendedDuration : model.maxDuration;
    const video = clip(source, target);
    if (video.duration < 2 || video.duration > limit) {
      const guidance = video.duration > limit ? `请截取不超过 ${limit} 秒的片段后上传。` : '请上传至少 2 秒的视频。';
      throw error(`参考视频实际为 ${Number(video.duration.toFixed(2))} 秒，所选 ${model.name} 支持 2–${limit} 秒。${guidance}`, 400, 'VIDEO_DURATION_INVALID');
    }
    if (!modelId.startsWith('doubao-seedance-') && (video.width < 300 || video.height < 300)) {
      throw error(`参考视频为 ${video.width}×${video.height} 像素，宽高至少需要 300 像素。`, 400, 'VIDEO_DIMENSIONS_INVALID');
    }
    if (modelId === PIXVERSE_MODEL && Math.max(video.width, video.height) > 1920) throw error('PixVerse 参考视频的长边不能超过 1920 像素，请压缩后上传。');
    if (modelId === WAN3_MODEL) return Math.round(video.duration * 1000) / 1000;
    const plan = segmentPlan(video, modelId);
    if (plan) return plan.segments.reduce((total, segment) => total + segment.duration, 0);
    return model.durations.find(value => value >= Math.ceil(video.duration - 0.05)) || model.maxDuration;
  }
  // Beyond one call's limit the (clipped) source is generated in parts on its own timeline.
  function segmentPlan(video, modelId) {
    const model = models.find(model => model.id === modelId);
    return model?.extendedDuration ? planSegments(video.duration, { maxSegment: model.maxDuration, durations: model.durations, ...video.boundaries }) : null;
  }
  async function segmentBoundaries(path, video, modelId) {
    const [frames, intervals] = await Promise.all([scenes(path, models.find(model => model.id === modelId).extendedDuration).catch(() => ({ cuts: [] })),
      video.audio && speech ? speech.detect(path).catch(() => []) : []]);
    return { ...(frames.fps ? { fps: frames.fps } : {}), cuts: frames.cuts || [], pauses: speechPauses(intervals) };
  }
  // Each part is an ordinary generation of its own source span.
  const segmentTask = (task, segment) => ({ ...task, duration: segment.duration,
    video: { ...task.video, duration: Math.round((segment.end - segment.start) * 1000) / 1000 },
    materials: { ...task.materials, video: task.materials[`segment-${segment.index}`] } });
  const segmentResult = (task, segment) => join(folder(task), `segment-${segment.index}-result.mp4`);
  const segmentConfirmed = segment => Boolean(segment.providerId || segment.resultSource);
  // Share the existing durable single-writer lock implementation, in a separate directory.
  const instance = createRequestLedger({ storageDir });
  let closing = false, fatal = false, timer, shutdownPromise;
  const folder = task => join(storageDir, task.id);
  const file = (task, kind) => join(folder(task), kind === 'photo' ? 'photo.jpg' : kind === 'video' ? 'source.mp4' : kind === 'voice' ? 'reference.wav' : /^segment-\d$/.test(kind) ? `${kind}.mp4` : 'result.mp4');
  const mime = kind => kind === 'photo' ? 'image/jpeg' : kind === 'voice' ? 'audio/wav' : 'video/mp4';
  const isExpired = task => !ACTIVE.has(task.status) && task.expiresAt <= now();
  function serialize(key, action) {
    const pending = (locks.get(key) || Promise.resolve()).catch(() => {}).then(action);
    locks.set(key, pending);
    pending.finally(() => { if (locks.get(key) === pending) locks.delete(key); }).catch(() => {});
    return pending;
  }
  async function save(task) {
    return serialize(`save:${task.id}`, async () => {
      try {
        await mkdir(folder(task), { recursive: true });
        const temporary = join(folder(task), 'task.json.tmp');
        await writeFile(temporary, JSON.stringify(task), { mode: 0o600 });
        await rename(temporary, join(folder(task), 'task.json'));
      } catch { fatal = true; throw error('任务存储暂时不可用，已暂停新的生成。', 503, 'VIDEO_STORAGE_UNAVAILABLE'); }
    });
  }
  function segmentView(task) {
    let plan = task.segments && { boundary: task.segmentBoundary, segments: task.segments };
    if (!plan && task.status === 'draft' && task.video) {
      const model = task.model || MODEL;
      try { plan = segmentPlan(clip(task.video, targetFor(task, model)), model); } catch { /* The upload already rejected this duration. */ }
    }
    if (!plan) return undefined;
    const count = key => plan.segments.filter(segment => segment[key]).length;
    return { total: plan.segments.length, boundary: plan.boundary, seam: plan.segments[1].start,
      submitted: count('providerId'), completed: count('resultSource'), downloaded: count('downloaded') };
  }
  function view(task) {
    const settled = !credits || task.billing?.status === 'settled';
    // Boundary candidates are internal planning data.
    const { boundaries, ...video } = task.video || {};
    const expired = isExpired(task);
    const costPricing = task.billing?.mode === 'api_cost' || (!task.billing && costMeter.enabled);
    const pricingKey = task.billing?.pricingKey || task.pricingKey || (!task.billing && task.status === 'draft' ? generationPrice('video', task.model || MODEL)?.key : undefined);
    return { id: task.id, kind: 'video', status: expired ? 'expired' : task.status === 'completed' && !settled ? 'settling' : task.status,
      createdAt: task.createdAt, completedAt: task.completedAt, expiresAt: task.expiresAt, duration: task.duration, actualDuration: task.actualDuration,
      startedAt: task.recheckStartedAt || task.startedAt, lastCheckedAt: task.lastCheckedAt,
      ratio: task.ratio, video: task.video && video, targetDuration: task.targetDuration, segments: segmentView(task), photo: task.photo, voice: task.voice, speech: task.speech, captions: task.captions,
      captionsChecked: task.captionsChecked, captionCheck: task.captionCheck, audioCheck: task.audioCheck,
      error: task.recoveryPolicy ? '' : task.error || '', code: task.recoveryPolicy ? undefined : task.code,
      recovery: task.recovery && { state: task.recovery.state, message: task.recovery.message, nextAttemptAt: task.recovery.nextAttemptAt },
      canResume: !expired && task.status === 'waiting' && task.recovery?.resumeStatus !== 'submitting' && !task.lipsync?.submitting
        && !task.voiceConversion?.submitting && !task.voiceConversion?.failed
        && !task.languageDetection?.pending
        && !task.localization?.failed && !task.localization?.translating && !task.localization?.segments?.some(segment => segment.status === 'submitting')
        && !task.localization?.translationFallback?.submitting
        && ['resume', 'account', 'confirm'].includes(task.recovery?.action),
      canReplaceSource: !expired && task.status === 'waiting' && task.recovery?.action === 'input' && !task.billing && !task.providerDispatched,
      canCancel: !expired && (ACTIVE.has(task.status) || task.status === 'waiting'),
      sourceAudioMode: task.sourceAudioMode || 'original',
      targetLanguage: task.targetLanguage, languageRouting: task.languageRouting,
      localizationProgress: task.localization && { ready: task.localization.ready, text: task.localization.text,
        completed: task.localization.segments?.filter(segment => segment.status === 'ready').length || 0,
        total: task.localization.segments?.length || 0 },
      voiceConversionProgress: task.voiceConversion && { ready: task.voiceConversion.ready },
      voiceEngine: task.voiceEngine || (task.model === FAL_MODEL ? undefined : 'seedance'), narrationProgress: task.narration && { ready: task.narration.ready,
        completed: task.narration.segments.filter(segment => segment.status === 'ready').length, total: task.narration.segments.length },
      model: task.model || MODEL, modelName: task.model === FAL_MODEL ? '极速模型' : task.model === WAN_MODEL ? 'Wan 2.2 人物替换' : models.find(model => model.id === (task.model || MODEL))?.name,
      resolution: task.model === FAL_MODEL ? '768p' : '720p',
      sourceVideoUrl: !expired && task.video ? `${PREFIX}/tasks/${task.id}/video` : null,
      sourcePhotoUrl: !expired && task.photo ? `${PREFIX}/tasks/${task.id}/photo` : null,
      sourceVoiceUrl: !expired && task.voice ? `${PREFIX}/tasks/${task.id}/voice` : null,
      canRecheck: !expired && task.status === 'failed' && task.rawReady === true && Boolean(task.voice && task.speech)
        && (!credits || task.billing?.status === 'released'),
      downloadProgress: task.downloadProgress,
      estimatedPoints: task.billing?.exempt === true ? 0 : task.duration ? pricingKey ? generationPoints(task.duration, pricingKey) : costPricing
        ? isFalReplacement(task.model) ? null : costPoints(generationQuote(task)) : calculateCredits('video', task.duration) : null,
      billing: task.billing && { source: 'workspace', status: task.billing.status, reservedPoints: task.billing.reservedPoints, chargedPoints: task.billing.chargedPoints, exempt: task.billing.exempt === true,
        ...(task.billing.pricingKey ? { mode: 'model_price', pricingKey: task.billing.pricingKey } : {}),
        ...(task.billing.mode==='api_cost'?{mode:'api_cost',costCny:task.billing.costCny}:{}) },
      resultUrl: !expired && task.status === 'completed' && settled ? `${PREFIX}/tasks/${task.id}/result` : null };
  }
  async function reconcile(task) {
    if (!credits || !['completed', 'failed', 'expired', 'cancelled'].includes(task.status) || ['settled', 'released'].includes(task.billing?.status)) return;
    try {
      const taskId = task.billingTaskId || task.id;
      let record = await credits.reservation(task.userId, taskId);
      if (task.model === WAN3_MODEL && record?.status === 'reserved' && ['pending', 'uncertain'].includes(record.costItems?.wan3?.status)) {
        if (task.segments) {
          for (const segment of task.segments) {
            if (segment.wan3Usage || segment.failed || !segment.providerId) continue;
            const result = await wan3Provider.query(segment.providerId);
            if (result.usage) segment.wan3Usage = wan3Usage(result.usage);
            if (result.failed) segment.failed = true;
          }
          await save(task); await finishWan3Cost(task, {}); record = await credits.reservation(task.userId, taskId);
        } else if (task.providerId) {
          const result = task.wan3Usage ? { completed: true, usage: task.wan3Usage } : await wan3Provider.query(task.providerId);
          if (result.completed || result.failed) { await finishWan3Cost(task, result); record = await credits.reservation(task.userId, taskId); }
        }
      }
      if ((isFalReplacement(task.model) || task.voiceEngine === 'chatterbox') && record?.kind === 'api-cost' && record.status === 'reserved') {
        // A playable result can arrive before its usage header. Re-read only saved receipts.
        const urls = [task.falQueue?.result, task.lipsync?.resultUrl, task.voiceConversion?.resultUrl, task.localization?.translationFallback?.resultUrl,
          ...(task.localization?.segments || []).map(segment => segment.resultUrl), ...(task.narration?.segments || []).flatMap(segment =>
          [segment.falQueue?.result, ...(segment.previousJobs || []).map(job => job.falQueue?.result)])];
        for (const name of ['source.mp4', 'generated.mp4', 'result.tmp']) {
          const transcription = await readFile(join(folder(task), name + '.asr.json'), 'utf8').then(JSON.parse).catch(() => null);
          if (transcription?.resultUrl) urls.push(transcription.resultUrl);
        }
        await costMeter.run({ userId: task.userId, taskId }, () => Promise.allSettled(urls.filter(Boolean).map(async value => {
          const url = new URL(value), id = /\/requests\/([^/]+)$/.exec(url.pathname)?.[1];
          if (url.origin !== 'https://queue.fal.run' || url.username || url.password
            || !Object.values(record.costItems || {}).some(item => item.providerRequestId === id && ['pending', 'uncertain'].includes(item.status))) return;
          const response = await costMeter.fetch(url, { method: 'GET', redirect: 'error', headers: { Authorization: `Key ${config.falKey}` },
            signal: AbortSignal.timeout(15_000) });
          await response.body?.cancel();
        })));
      }
      if (record?.kind==='api-cost' && record.status==='reserved' && task.status !== 'completed'
        && !task.providerDispatched && !task.providerId && costPrepared(task)
        && record.costItems[generationReceipt(task)]?.status==='pending') {
        record = await credits.finishCostCall({userId:task.userId,taskId,receiptId:generationReceipt(task),costCny:0});
      }
      if (record?.status === 'reserved') record = record.kind==='api-cost' ? await credits.settleCost({userId:task.userId,taskId}) : task.status === 'completed'
        ? await credits.settle({ userId: task.userId, taskId, units: Math.min(task.duration, task.actualDuration) })
        : await credits.release({ userId: task.userId, taskId });
      task.billing = record ? { status: record.status, reservedPoints: record.reservedPoints, chargedPoints: record.chargedPoints, exempt: record.exempt === true,
        ...(record.pricingKey ? { mode: 'model_price', pricingKey: record.pricingKey } : {}),
        ...(record.kind==='api-cost'?{mode:'api_cost',costCny:(record.settledUnits||0)/1e6}:{}) }
        : { status: 'released', reservedPoints: 0, chargedPoints: 0 };
    } catch { task.billing = { ...task.billing, status: task.status === 'completed' ? 'settle_pending' : 'release_pending' }; }
    await save(task);
  }
  async function fail(task, message, code) {
    if (task.recoveryPolicy) {
      const action = /REVIEW_REJECTED|MATERIAL_INVALID|SPEECH_INVALID/.test(code || '') ? 'input'
        : /POINTS|CREDITS|NOT_CONFIGURED|IP_DENIED|PROVIDER_REJECTED/.test(code || '') ? 'account'
          : /UNCERTAIN|INTERRUPTED|SUBMISSION/.test(code || '') ? 'confirm' : 'resume';
      await hold(task, { message, code, recoveryAction: action }); return;
    }
    if(task.billing?.mode==='api_cost') message=message.replace(/预留积分将退回[，。]?/g,'费用将按实际调用核对。');
    task.status = 'failed'; task.error = message; task.code = code;
    await save(task); await reconcile(task);
  }
  async function hold(task, cause) {
    const action = cause.recoveryAction || 'resume';
    task.recovery = { state: 'waiting', action, resumeStatus: task.status === 'waiting' ? task.recovery?.resumeStatus : task.status,
      message: action === 'input' ? !task.billing && !task.providerDispatched
        ? task.voiceEngine === 'indextts2' ? '请补充至少 5 秒且包含清晰原声的视频，当前进度已保存。' : '请补充包含清晰原声的参考视频，当前进度已保存。'
        : '素材需要调整，进度已保存；可停止处理后新建复刻。'
        : action === 'account' ? '等待账户或额度恢复，当前进度已保存。'
          : action === 'limit' ? '自动处理次数已达上限，当前进度已保存。'
            : action === 'confirm' ? '等待确认原生成记录，当前进度已保存。' : '进度已保存，可以继续处理。',
      code: cause.code, at: now() };
    task.error = cause.message; task.code = cause.code; task.status = 'waiting'; await save(task);
  }
  async function recover(task, cause) {
    if (['VIDEO_LANGUAGE_UNCERTAIN', 'VIDEO_LOCALIZATION_FAILED', 'VIDEO_LOCALIZATION_UNCERTAIN'].includes(cause.code)) {
      await hold(task, { message: cause.message, code: cause.code, recoveryAction: cause.code === 'VIDEO_LOCALIZATION_UNCERTAIN' ? 'confirm' : 'input' });
      task.recovery.message = cause.message; await save(task); return;
    }
    if (['VIDEO_CONVERSION_FAILED', 'VIDEO_CONVERSION_UNCERTAIN'].includes(cause.code)) {
      await hold(task, { message: cause.message, code: cause.code, recoveryAction: cause.code.endsWith('UNCERTAIN') ? 'confirm' : 'input' }); return;
    }
    if (cause.code === 'VIDEO_NARRATION_WAITING') { await hold(task, cause); return; }
    if (['VIDEO_NARRATION_FAILED', 'VIDEO_LIPSYNC_FAILED', 'VIDEO_LIPSYNC_UNCERTAIN'].includes(cause.code)) {
      await hold(task, { message: cause.message, code: cause.code, recoveryAction: cause.code.endsWith('UNCERTAIN') ? 'confirm' : 'resume' }); return;
    }
    const startedAt = task.recovery?.startedAt || now(), attempts = (task.recovery?.attempts || 0) + 1;
    if (now() - startedAt >= 30 * 60_000 || task.status === 'preparing' && attempts >= 3) {
      await hold(task, { message: cause.message, code: cause.code, recoveryAction: 'resume' }); return;
    }
    task.recovery = { state: 'retrying', startedAt, attempts, code: cause.code,
      nextAttemptAt: now() + Math.min(60_000, 5000 * 2 ** Math.min(attempts - 1, 4)),
      message: task.status === 'preparing' ? '正在整理原视频声音。' : task.status === 'downloading' ? '正在保存已有成片。'
        : '正在确认生成进度，已完成内容已保留。' };
    task.error = cause.message; task.code = cause.code; await save(task);
  }
  function signature(id, kind, expires) {
    return createHmac('sha256', config.signingSecret).update(`${id}:${kind}:${expires}`).digest('hex');
  }
  function sourceUrl(task, kind) {
    const expires = task.startedAt + DAY;
    return `${config.publicOrigin}${PREFIX}/source/${task.id}/${kind}?expires=${expires}&signature=${signature(task.id, kind, expires)}`;
  }
  async function analyzeSource(task) {
    if (task.voiceEngine === 'chatterbox') {
      // Whole-track conversion uses audio directly; only legacy translation needs text.
      if (!task.targetLanguage) return;
      if (task.speech?.source !== 'audio' || ['en', 'ms'].includes(task.targetLanguage) && !task.speech.language) {
        task.speech = { ...await speech.analyze(file(task, 'video'), task.video.duration,
          { diagnosticsPath: join(folder(task), 'verification-source.json') }), source: 'audio' };
        task.originalSpeech = structuredClone(task.speech);
      }
      await save(task); return;
    }
    const audioOnly = task.voiceEngine === 'seedance' && task.sourceAudioMode === 'silent';
    if (audioOnly) {
      // A draft may already contain a partial subtitle transcript from another mode.
      delete task.captions; delete task.captionsChecked; delete task.captionCheck;
    }
    if (!audioOnly && !task.captionsChecked) {
      try { task.captions = await captions.extract(file(task, 'video')); }
      catch { task.captionCheck = { warning: '原视频字幕未能提取，将继续使用原视频人声。' }; }
      task.captionsChecked = true;
    }
    if (!audioOnly && (!task.speech || task.speech.source !== 'subtitles') && task.captions?.cues?.length) {
      const intervals = task.video.audio ? await speech.detect(file(task, 'video')).catch(() => []) : [];
      task.speech = captionSpeech(task.captions, intervals);
      task.originalSpeech = structuredClone(task.speech);
    } else if (audioOnly ? task.speech?.source !== 'audio' : !task.speech && task.voice) {
      if (!task.video.audio) throw error('参考视频没有音轨，无法保留原台词。', 422, 'VIDEO_SPEECH_INVALID');
      task.speech = { ...await speech.analyze(file(task, 'video'), task.video.duration,
        { diagnosticsPath: join(folder(task), 'verification-source.json') }), source: 'audio' };
      task.originalSpeech = structuredClone(task.speech);
      delete task.speechConfirmedAt;
    }
    if (task.code === 'VIDEO_TRANSCRIPTION_PENDING') { task.error = ''; delete task.code; }
    await save(task);
  }
  async function renderCaptions(task, input) {
    if (!task.captions?.cues?.length) return;
    const output = join(folder(task), 'result-caption.tmp');
    try {
      const captionCheck = await captions.render(input, output, task.captions);
      const metadata = await probe(output);
      if (!metadata.audio || Math.abs(metadata.duration - task.actualDuration) > 0.1) throw new Error('Invalid caption render');
      await rename(output, input);
      task.captionCheck = captionCheck || { rendered: true, source: 'subtitles', cueCount: task.captions.cues.length };
    } catch {
      // Caption processing must never discard a playable model result.
      await rm(output, { force: true });
      task.captionCheck = { rendered: false, warning: '原字幕合成未完成，已保留可播放成片，请预览核对字幕。' };
    }
  }
  async function acceptResult(task, result) {
    task.lastCheckedAt = now();
    if (result.taskId) task.providerId = result.taskId;
    if (task.model === WAN3_MODEL) {
      // Save the paid receipt before settlement; restarting must only query this job.
      if (result.usage) task.wan3Usage = wan3Usage(result.usage);
      await save(task);
      if (result.completed || result.failed) await finishWan3Cost(task, result);
    }
    if (result.failed) { await fail(task, '视频生成失败，预留积分将退回。请检查参考素材后重新创建任务。', 'VIDEO_GENERATION_FAILED'); return; }
    if (task.billing?.mode==='api_cost' && task.seedanceCostPrepared && (result.completed || result.url)) {
      await credits.finishCostCall({userId:task.userId,taskId:task.billingTaskId||task.id,receiptId:'seedance',costCny:task.duration * cnyPerSecond(task),
        ...(task.providerId?{providerRequestId:task.providerId}:{})});
    }
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
  async function submissionFailed(task, cause, segment) {
    if (fatal) throw cause;
    const rejected = cause instanceof VideoError && ['VIDEO_PROVIDER_REJECTED', 'VIDEO_PROVIDER_IP_DENIED'].includes(cause.code);
    // A rejected part created no job, so resuming submits only the parts still without one.
    if (cause.providerNotDispatched || segment && rejected) {
      if (segment) { segment.providerDispatched = false; task.providerDispatched = task.segments.some(item => item.providerDispatched); }
      else task.providerDispatched = false;
      if (task.recoveryPolicy) task.status = 'reviewing';
      await fail(task, cause.message, cause.code || 'CREDITS_UNAVAILABLE'); return;
    }
    if(task.billing?.mode==='api_cost' && costPrepared(task)) await credits.finishCostCall({userId:task.userId,taskId:task.billingTaskId||task.id,
      receiptId:generationReceipt(task),...(rejected?{costCny:0}:{uncertain:true})}).catch(()=>{});
    await fail(task, rejected ? cause.message : `${segment ? `第 ${segment.index + 1} 段` : ''}提交未获得确认，未自动重复生成。请核对模型服务记录后再创建任务，预留积分将退回。`,
      rejected ? cause.code : 'VIDEO_SUBMISSION_UNCERTAIN');
  }
  async function submitSegments(task, taskProvider) {
    for (const segment of task.segments) {
      if (segmentConfirmed(segment)) continue;
      // Persist each part's dispatch boundary; a restart never replays an unconfirmed part.
      segment.providerDispatched = true; await save(task);
      let result;
      try { result = await taskProvider.generate(segmentTask(task, segment)); }
      catch (cause) { await submissionFailed(task, cause, segment); return; }
      if (result.taskId) segment.providerId = result.taskId;
      if (result.url) segment.resultSource = result.url;
      if (task.model === WAN3_MODEL && result.usage) segment.wan3Usage = wan3Usage(result.usage);
      if (result.failed) segment.failed = true;
      await save(task);
      if (result.failed) { await fail(task, `第 ${segment.index + 1} 段视频生成失败，预留积分将退回。请检查参考素材后重新创建任务。`, 'VIDEO_GENERATION_FAILED'); return; }
      if (!segmentConfirmed(segment)) { await fail(task, `第 ${segment.index + 1} 段未返回任务编号，未自动重试。请核对模型服务记录后再创建任务。`, 'VIDEO_SUBMISSION_UNCERTAIN'); return; }
    }
    task.status = 'running'; task.lastCheckedAt = now(); task.error = ''; delete task.code; await save(task);
  }
  async function querySegments(task, taskProvider) {
    task.lastCheckedAt = now();
    for (const segment of task.segments) {
      if (segment.resultSource) continue;
      const result = await taskProvider.query(segment.providerId, segmentTask(task, segment));
      if (task.model === WAN3_MODEL && result.usage) segment.wan3Usage = wan3Usage(result.usage);
      if (result.failed) { segment.failed = true; await save(task); }
      if (result.failed) { await fail(task, `第 ${segment.index + 1} 段视频生成失败，预留积分将退回。请检查参考素材后重新创建任务。`, 'VIDEO_GENERATION_FAILED'); return; }
      if (result.url) { segment.resultSource = result.url; await save(task); }
      else if (result.completed) {
        task.error = `第 ${segment.index + 1} 段已返回完成状态，但尚未提供可下载成片，正在重新查询原任务。`; task.code = 'VIDEO_RESULT_PENDING';
      }
    }
    if (task.segments.some(segment => !segment.resultSource)) { await save(task); return; }
    if (task.model === WAN3_MODEL) await finishWan3Cost(task, {});
    if (task.billing?.mode === 'api_cost' && task.seedanceCostPrepared) {
      await credits.finishCostCall({ userId: task.userId, taskId: task.billingTaskId || task.id, receiptId: 'seedance',
        costCny: task.duration * cnyPerSecond(task), providerRequestId: task.segments[0].providerId });
    }
    task.status = 'downloading'; task.error = ''; delete task.code; await save(task);
  }
  async function fetchResult(task, source, temporary, part) {
    let savedAt = 0, progressWrites = Promise.resolve();
    try {
      await download(source, temporary, { onProgress: progress => {
        task.downloadProgress = { receivedBytes: progress.bytes, totalBytes: progress.totalBytes, ...part };
        if (progress.complete || now() - savedAt >= 1000) {
          savedAt = now(); progressWrites = progressWrites.then(() => save(task));
          void progressWrites.catch(() => {});
        }
      } });
    } finally { await progressWrites; }
    return probe(temporary);
  }
  async function processVideoTask(task) {
    if (closing || fatal) return;
    // Retain the provider only to finish tasks submitted before H3 Max was removed.
    const taskProvider = task.model === WAN3_MODEL ? wan3Provider : task.model === WAN_MODEL ? wanProvider : task.model === PIXVERSE_MODEL ? pixverseProvider : task.model === FAL_MODEL ? falProvider : provider;
    if (isExpired(task)) {
      if (task.status !== 'expired') {
        task.status = 'expired'; task.error = '素材和成片已超过保存期限。'; task.code = 'VIDEO_EXPIRED'; delete task.recovery; await save(task);
      }
      await reconcile(task);
      if (!task.cleaned) {
        await archiveTaskMaterials(task);
        for (const name of ['photo.jpg', 'source.mp4', 'source-clean.mp4', 'source-clean.mp4.captions.json', 'source-silent.mp4', 'reference.wav', 'voice.tmp.wav', 'generated.mp4', 'result.mp4', 'result.mp4.borders.mp4', 'result-caption.tmp', 'result-caption.tmp.captions.json', 'upload.tmp', 'result.tmp', 'result.tmp.download.json', 'verification-source.json', 'verification-generated.json', 'verification-aligned.json', 'source.mp4.asr.wav', 'source.mp4.vad.pcm', 'reference.wav.vad.pcm', 'voice.tmp.wav.vad.pcm', 'generated.mp4.asr.wav', 'generated.mp4.vad.pcm', 'result.tmp.asr.wav', 'result.tmp.vad.pcm', 'result.tmp.aligned.pcm']) await rm(join(folder(task), name), { force: true });
        await rm(join(folder(task), 'narration'), { recursive: true, force: true });
        await rm(join(folder(task), 'localization'), { recursive: true, force: true });
        for (const name of ['localized-voice.wav', 'localized-voice.wav.asr.json', 'localized-voice.wav.asr.json.tmp',
          'localized-voice.wav.asr.wav', 'localized-voice.wav.vad.pcm', 'verification-localized.json']) await rm(join(folder(task), name), { force: true });
        for (const name of ['source.mp4', 'generated.mp4', 'result.tmp']) {
          await rm(join(folder(task), name + '.asr.json'), { force: true });
          await rm(join(folder(task), name + '.asr.json.tmp'), { force: true });
        }
        for (const name of ['narration.wav', 'narration.wav.pcm', 'narration.wav.tmp.wav', 'lipsync.mp4', 'lipsync.mp4.download.json']) await rm(join(folder(task), name), { force: true });
        for (const name of ['conversion-source.wav', 'converted-voice.wav', 'converted-voice.wav.download.json',
          'converted-voice.wav.asr.wav', 'converted-voice.wav.asr.json', 'converted-voice.wav.asr.json.tmp',
          'converted-voice.wav.vad.pcm', 'verification-converted.json']) await rm(join(folder(task), name), { force: true });
        for (const name of ['source-clip.mp4', 'source-clip.mp4.tmp.mp4', 'generated.mp4.join.mp4', 'result.mp4.join.mp4', ...(task.segments || []).flatMap(({ index }) => [`segment-${index}.mp4`,
          `segment-${index}.mp4.tmp.mp4`, `segment-${index}-result.mp4`, `segment-${index}-result.tmp`, `segment-${index}-result.tmp.download.json`])]) {
          await rm(join(folder(task), name), { force: true });
        }
        task.cleaned = true; await save(task);
      }
      return;
    }
    if (['completed', 'failed', 'expired', 'cancelled'].includes(task.status)) { await reconcile(task); return; }
    if (!ACTIVE.has(task.status)) return;
    if (task.status === 'preparing') {
      await analyzeSource(task);
      // Only already-started legacy tasks retain translation and paid-job recovery.
      if (task.targetLanguage && task.voiceEngine === 'chatterbox') {
        await localization?.detectLanguage?.(task, () => save(task));
        task.languageRouting = languageRoute(task.speech, task.targetLanguage); await save(task);
      }
      if (task.languageRouting?.translate) {
        if (!localization?.enabled || !heygen?.enabled) throw error('翻译配音或 HeyGen 官方对口型尚未配置。', 503, 'VIDEO_LOCALIZATION_NOT_CONFIGURED');
        await localization.advance(task, folder(task), () => save(task));
        if (!task.localization.ready) return;
      } else if (task.voiceEngine === 'chatterbox') {
        await costMeter.run({ userId: task.userId, taskId: task.billingTaskId || task.id, legacy: task.billing?.mode !== 'api_cost' },
          () => voiceConversion.advance(task, folder(task), () => save(task)));
        if (!task.voiceConversion.ready) return;
      }
      if (task.sourceAudioMode === 'silent' && task.video.audio && !task.videoAudioRemoved) {
        await removeVideoAudio(file(task, 'video'), join(folder(task), 'source-silent.mp4'));
        task.videoAudioRemoved = true; await save(task);
      }
      if (task.voiceEngine === 'indextts2' && !task.narration) {
        task.narration = await narration.prepare(task, folder(task)); await save(task);
      }
      task.status = 'reviewing'; await save(task);
      if (task.voiceEngine === 'indextts2') return;
    }
    if (task.status === 'reviewing') {
      for (const segment of task.segments || []) {
        if (segment.cut) continue;
        await cutSegment(file(task, 'video'), file(task, `segment-${segment.index}`), segment.start, segment.end);
        segment.cut = true; await save(task);
      }
      const videoKinds = task.segments ? task.segments.map(segment => `segment-${segment.index}`) : ['video'];
      for (const kind of ['photo', ...videoKinds, ...(task.voice && !['indextts2', 'chatterbox'].includes(task.voiceEngine) ? ['voice'] : [])]) {
        if (!task.materials[kind]) {
          task.materials[kind] = task.model === WAN3_MODEL
            ? await wan3Provider.upload(kind === 'video' && task.videoAudioRemoved ? join(folder(task), 'source-silent.mp4') : file(task, kind), mime(kind))
            : isFalReplacement(task.model)
            ? { id: await providerStorage.upload(file(task, kind), mime(kind)), status: 2 }
            : await taskProvider.createMaterial(sourceUrl(task, kind), kind);
          await save(task);
        }
        const material = task.materials[kind];
        if (material.status !== 2) {
          try { material.status = await taskProvider.queryMaterial(material.id); }
          catch {
            material.queryFailures = (material.queryFailures || 0) + 1;
            if (material.queryFailures > MATERIAL_QUERY_RETRIES) {
              await fail(task, `素材审核状态查询已重试 ${MATERIAL_QUERY_RETRIES} 次仍未成功，请稍后新建复刻。`, 'VIDEO_MATERIAL_QUERY_FAILED'); return;
            }
            task.error = `素材审核状态查询暂时失败，正在重试（${material.queryFailures}/${MATERIAL_QUERY_RETRIES}）。`;
            task.code = 'VIDEO_MATERIAL_QUERY_RETRYING'; await save(task); return;
          }
          delete material.queryFailures;
          if (task.code === 'VIDEO_MATERIAL_QUERY_RETRYING') { task.error = ''; delete task.code; }
        }
        if (material.status === 3) {
          const part = /^segment-(\d)$/.exec(kind);
          await fail(task, `${kind === 'photo' ? '人物照片' : kind === 'voice' ? '声音参考' : part ? `参考视频第 ${Number(part[1]) + 1} 段` : '参考视频'}未通过素材审核，请更换清晰、符合要求的素材。`, 'VIDEO_REVIEW_REJECTED'); return;
        }
        await save(task);
      }
      if (Object.values(task.materials).some(value => value.status !== 2)) return;
      if(task.billing?.mode==='api_cost' && !isFalReplacement(task.model) && !costPrepared(task)) {
        try { await prepareGenerationCost(task); }
        catch(cause) {await fail(task,cause.message,cause.code||'CREDITS_UNAVAILABLE');return;}
        await save(task);
      }
      if (task.model === WAN3_MODEL && task.cnyPerSecond !== wan3Price(now())) {
        const price = wan3Price(now());
        if (task.billing?.mode === 'api_cost') await credits.extendCostCall({ userId: task.userId, taskId: task.billingTaskId || task.id,
          receiptId: 'wan3', quoteCny: (task.video.duration + task.duration) * price });
        task.cnyPerSecond = price;
        await save(task);
      }
      // Persist the dispatch boundary before making the paid call. Never replay it after a restart.
      task.status = 'submitting'; task.providerDispatched = true; await save(task);
      if (task.segments) await submitSegments(task, taskProvider);
      else try { await acceptResult(task, await taskProvider.generate(task)); }
      catch (cause) { await submissionFailed(task, cause); }
    } else if (task.status === 'running') {
      if (task.segments) await querySegments(task, taskProvider);
      else await acceptResult(task, await taskProvider.query(task.providerId, task));
    }
    if (task.status === 'downloading') {
      const target = task.voice || task.captions ? join(folder(task), 'generated.mp4') : file(task, 'result');
      let metadata;
      if (task.segments) {
        for (const segment of task.segments) {
          if (segment.downloaded) continue;
          const temporary = join(folder(task), `segment-${segment.index}-result.tmp`);
          const part = await fetchResult(task, segment.resultSource, temporary, { segment: segment.index + 1, segments: task.segments.length });
          await rename(temporary, segmentResult(task, segment));
          segment.downloaded = true; segment.actualDuration = Math.round(part.duration * 1000) / 1000; await save(task);
        }
        // Each part is trimmed to its source span, so the joined video keeps the source timeline.
        metadata = await joinSegments(task.segments.map(segment => segmentResult(task, segment)), task.segments, target);
      } else {
        const temporary = join(folder(task), 'result.tmp');
        metadata = await fetchResult(task, task.resultSource, temporary);
        await rename(temporary, target);
      }
      task.actualDuration = Math.round(metadata.duration * 1000) / 1000;
      if (task.voice || task.captions) { task.rawReady = true; task.status = 'verifying'; task.error = ''; delete task.code; await save(task); }
      else { await complete(task); }
    }
    if (task.status === 'verifying') {
      const generated = join(folder(task), 'generated.mp4'), aligned = join(folder(task), 'result.tmp');
      if (task.languageRouting?.translate) {
        if (!task.localization?.ready) throw error('译后配音尚未就绪。', 502, 'VIDEO_LOCALIZATION_PENDING');
        if (!task.lipsync) {
          task.lipsyncFiles ||= {};
          for (const [kind, input, type] of [['video', generated, 'video/mp4'], ['audio', join(folder(task), 'localized-voice.wav'), 'audio/wav']]) {
            if (!task.lipsyncFiles[kind]) { task.lipsyncFiles[kind] = await providerStorage.upload(input, type); await save(task); }
          }
          task.lipsync = { submitting: true, provider: 'heygen' }; await save(task);
          try { task.lipsync = await heygen.submit(task.lipsyncFiles.video, task.lipsyncFiles.audio); }
          catch (cause) { if (cause.providerNotDispatched) { delete task.lipsync; await save(task); } throw cause; }
          await save(task); return;
        }
        if (task.lipsync.submitting) throw error('HeyGen 提交未获确认，请核对原任务，未重复提交。', 502, 'VIDEO_LIPSYNC_UNCERTAIN');
        if (!task.lipsync.url) {
          const url = await heygen.query(task.lipsync); if (!url) return;
          task.lipsync.url = url; await save(task);
        }
        const mouth = join(folder(task), 'lipsync.mp4');
        try { await download(task.lipsync.url, mouth); }
        catch { throw error('正在保存已完成的 HeyGen 成片，不会重新生成。', 502, 'VIDEO_LIPSYNC_PENDING'); }
        await localization.mux(mouth, join(folder(task), 'localized-voice.wav'), aligned, task.actualDuration);
        task.audioCheck = { engine: 'chatterbox-multilingual', language: task.targetLanguage, referenceApplied: true,
          lipSync: 'heygen-precision', warning: '已翻译并按参考声音配音、同步口型，请试听核对译文和遮挡效果。' };
      } else if (task.voiceEngine === 'chatterbox') {
        if (!task.voiceConversion?.ready) throw error('换声结果尚未就绪。', 502, 'VIDEO_CONVERSION_PENDING');
        await voiceConversion.mux(generated, join(folder(task), 'converted-voice.wav'), aligned, task.actualDuration);
        task.audioCheck = { engine: 'chatterbox', referenceApplied: true, emotionSource: 'original-video', tempoAdjusted: false,
          lipSync: 'needs_preview',
          warning: '已按原声转换音色，未调整语速；请预览核对音色、情绪和口型。' };
      } else if (task.voiceEngine === 'indextts2') {
        if (!task.narration.ready) return;
        if (!task.lipsync) {
          task.lipsyncFiles ||= {};
          for (const [kind, input, type] of [['video', generated, 'video/mp4'], ['audio', join(folder(task), 'narration.wav'), 'audio/wav']]) {
            if (!task.lipsyncFiles[kind]) { task.lipsyncFiles[kind] = await providerStorage.upload(input, type); await save(task); }
          }
          task.lipsync = { submitting: true }; await save(task);
          task.lipsync = await lipsync.submit(task.lipsyncFiles.video, task.lipsyncFiles.audio); await save(task); return;
        }
        if (task.lipsync.submitting) throw error('口型提交确认中断，未自动重复生成，请核对原口型任务。', 502, 'VIDEO_LIPSYNC_UNCERTAIN');
        if (!task.lipsync.url) {
          const url = await lipsync.query(task.lipsync); if (!url) return;
          task.lipsync.url = url; await save(task);
        }
        const mouth = join(folder(task), 'lipsync.mp4');
        try { await download(task.lipsync.url, mouth); }
        catch { throw error('口型视频已生成，正在重试下载原结果，不会重新生成。', 502, 'VIDEO_LIPSYNC_PENDING'); }
        await narration.mux(mouth, join(folder(task), 'narration.wav'), aligned, task.actualDuration);
        task.audioCheck = { engine: 'indextts2', referenceApplied: true, emotionSource: task.narration.emotionSource, lipSync: 'processed' };
      } else if (!task.voice) await copyFile(generated, aligned);
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
        if (fatal || !/^VIDEO_(SPEECH|TRANSCRIPTION)_/.test(cause.code || '')) throw cause;
        // Transcript/timing checks decide whether correction is safe, never whether to deliver.
        await copyFile(generated, aligned);
        task.audioCheck = { corrected: false, transcriptMatched: null, transcriptDifferences: null, afterOffsetMs: null,
          warning: '已保留模型生成的声音，请预览核对台词、音色与开口时间。', lipSync: 'needs_preview' };
      }
      const metadata = await probe(aligned);
      task.actualDuration = Math.round(metadata.duration * 1000) / 1000;
      await renderCaptions(task, aligned);
      await rename(aligned, file(task, 'result')); await complete(task);
    }
  }
  async function processTask(task) {
    if (!isExpired(task) && (task.status === 'waiting' || task.recovery?.nextAttemptAt > now())) return;
    if (task.recoveryPolicy && ACTIVE.has(task.status) && now() >= (task.recoveryDeadline || task.startedAt + 30 * 60_000)) {
      await hold(task, { code: 'VIDEO_RECOVERY_WAITING', recoveryAction: 'resume', message: '本轮等待时间已到，进度已保存。' }); return;
    }
    if (task.voiceEngine !== 'indextts2' || !task.narration || !ACTIVE.has(task.status) || closing || fatal) return processVideoTask(task);
    const replies = await Promise.allSettled([processVideoTask(task),
      narration.advance(task, folder(task), kind => sourceUrl(task, kind), () => save(task))]);
    const rejected = replies.find(reply => reply.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
  async function complete(task) {
      task.status = 'completed'; task.error = ''; delete task.code;
      delete task.recovery;
      task.completedAt = now();
      task.expiresAt = now() + 3 * DAY;
      await save(task); await reconcile(task);
  }
  async function tick() {
    if (closing || fatal) return;
    for (const task of jobs.values()) {
      if (processors.has(task.id)) continue;
      const processing = serialize(task.id, async () => {
      try {
        const recovery = task.recovery;
        await costMeter.run({userId:task.userId,taskId:task.billingTaskId||task.id,
          legacy:task.billing?.mode!=='api_cost',aggregate:task.billing?.mode==='api_cost' && !isFalReplacement(task.model) && task.model !== WAN3_MODEL},()=>processTask(task));
        if (recovery?.state === 'retrying' && recovery === task.recovery && recovery.nextAttemptAt <= now()) {
          delete task.recovery; task.error = ''; delete task.code; await save(task);
        }
      }
      catch (cause) {
        if (fatal) return;
        if (task.recoveryPolicy) { await recover(task, cause); return; }
        if (cause.code === 'VIDEO_TRANSCRIPTION_PENDING') {
          task.error = cause.message; task.code = cause.code; await save(task); return;
        }
        if (['VIDEO_NARRATION_FAILED', 'VIDEO_NARRATION_UNCERTAIN', 'VIDEO_LIPSYNC_FAILED', 'VIDEO_LIPSYNC_UNCERTAIN'].includes(cause.code)) {
          await fail(task, cause.message, cause.code); return;
        }
        if (task.status === 'preparing') { await fail(task, cause instanceof VideoError ? cause.message : '素材自动处理未完成，预留积分将退回。', cause.code || 'VIDEO_SPEECH_FAILED'); return; }
        if (task.status === 'verifying' && !['VIDEO_NARRATION_PENDING', 'VIDEO_LIPSYNC_PENDING'].includes(cause.code)) { await fail(task, cause instanceof VideoError ? cause.message : '成片声音检查未完成，预留积分将退回。', cause.code || 'VIDEO_SPEECH_FAILED'); return; }
        if (task.status === 'reviewing' && cause instanceof VideoError && ['VIDEO_PROVIDER_IP_DENIED', 'VIDEO_PROVIDER_REJECTED', 'VIDEO_MATERIAL_INVALID'].includes(cause.code)) {
          await fail(task, cause.message, cause.code); return;
        }
        // Queries and result downloads can be retried without another paid generation call.
        task.error = ['VIDEO_NARRATION_PENDING', 'VIDEO_LIPSYNC_PENDING'].includes(cause.code) ? cause.message
          : task.status === 'downloading' ? '成片正在保存，将自动重试下载。' : '模型服务暂时不可用，正在查询原任务。';
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
      // Retired quality checks must not leave already-generated audio permanently held.
      if (task.status === 'waiting' && task.code === 'VIDEO_CONVERSION_FAILED' && task.voiceConversion
        && /^(换声后识别的台词与原声差异较大|换声时长与原声相差超过|换人视频短于原声)/.test(task.error || '')) {
        delete task.voiceConversion.failed;
        task.recovery.action = 'resume';
        task.recovery.message = '校验拦截已移除，可以继续处理。';
        await save(task);
      }
      if (task.voice && task.actualDuration && !task.cleaned) {
        task.rawReady = await stat(join(folder(task), 'generated.mp4')).then(info => info.isFile() && info.size > 0, () => false);
      }
      // Parts that were never sent or already have a job can continue without replaying a paid call.
      if (task.status === 'submitting' && task.segments?.every(segment => !segment.providerDispatched || segmentConfirmed(segment))) {
        task.status = 'reviewing'; task.providerDispatched = task.segments.some(segment => segment.providerDispatched); await save(task);
      } else if (['reserving', 'submitting'].includes(task.status)) {
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
      const source = /^\/api\/video-replica\/source\/([a-f0-9-]{36})\/(video|photo|voice|generated|narration|emotion-\d{1,2}|segment-\d)$/.exec(path);
      if (source) {
        const task = jobs.get(source[1]), expires = Number(url.searchParams.get('expires')), supplied = url.searchParams.get('signature') || '';
        const valid = config.signingSecret && /^\d{13}$/.test(url.searchParams.get('expires') || '') && /^[a-f0-9]{64}$/.test(supplied)
          && timingSafeEqual(Buffer.from(supplied), Buffer.from(signature(source[1], source[2], expires)));
        // Keep the original signed URL usable while its generation is still active.
        if (!['GET', 'HEAD'].includes(req.method) || !task || !valid || (expires <= now() && !ACTIVE.has(task.status)) || expires !== task.startedAt + DAY || task.status === 'expired') throw error('素材链接不可用或已过期。', 403, 'VIDEO_SOURCE_FORBIDDEN');
        const kind = source[2], emotion = /^emotion-(\d{1,2})$/.exec(kind), part = /^segment-(\d)$/.exec(kind);
        if (emotion ? !task.video?.audio || !task.narration?.segments[Number(emotion[1])]
          : part ? !task.segments?.[Number(part[1])]?.cut : kind === 'generated' ? !task.rawReady : kind === 'narration' ? !task.narration?.ready : !task[kind]) throw error('素材尚未准备好。', 404, 'VIDEO_NOT_FOUND');
        const input = emotion ? join(folder(task), 'narration', `${kind}.wav`) : kind === 'generated' ? join(folder(task), 'generated.mp4')
          : kind === 'narration' ? join(folder(task), 'narration.wav') : kind === 'video' && task.videoAudioRemoved ? join(folder(task), 'source-silent.mp4')
          : source[2] === 'video' && task.videoCaptionsRemoved ? join(folder(task), 'source-clean.mp4') : file(task, source[2]);
        await serveMedia(req, res, input, emotion || kind === 'narration' ? 'audio/wav' : mime(kind)); return;
      }
      const userId = req.authenticatedUserId;
      if (!userId) throw error('请先登录后继续。', 401, 'UNAUTHENTICATED');
      if (!['GET', 'HEAD'].includes(req.method)) {
        const expected = publicOrigin ? new URL(publicOrigin).origin : `http://${req.headers.host}`;
        if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && req.headers.origin !== expected) throw error('请求来源无效。', 403, 'VIDEO_ORIGIN_REJECTED');
        if (closing || fatal) throw error('视频服务暂时不可用，请稍后查询原任务。', 503, 'VIDEO_UNAVAILABLE');
      }
      if (path === `${PREFIX}/config` && req.method === 'GET') {
        const availableModels = models.filter(model => !isFalReplacement(model.id)).map(model => model.id === WAN3_MODEL
          ? { ...model, cnyPerSecond: wan3Price(now()), description: `参考视频最多15秒 · 720P · 输入＋输出 ${wan3Price(now())}元/秒，换声另计` } : model);
        json(res, 200, { enabled: availableModels.some(model => model.enabled), models: availableModels,
          voiceEnabled: Boolean(voiceConversion?.enabled), voiceEngines: voiceEngines.filter(engine => engine.id === 'chatterbox'),
          voiceEngine: 'chatterbox', sourceAudioMode: 'original', model: availableModels.find(model => model.enabled)?.id || MODEL,
          prompt: PROMPT, durations: DURATIONS, videoLimit: VIDEO_LIMIT, photoLimit: PHOTO_LIMIT, voiceLimit: VOICE_LIMIT }); return;
      }
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
          const model = selectedModel(body.model);
          // Keep explicit legacy parameters compatible; new clients convert the source voice.
          const targetDuration = selectedTargetDuration(body.targetDuration, model);
          const task = { id: body.requestId, userId, model, voiceEngine: selectedVoiceEngine(body.voiceEngine ?? 'chatterbox'),
            sourceAudioMode: selectedSourceAudioMode(body.sourceAudioMode ?? 'original', model), ...(targetDuration ? { targetDuration } : {}),
            status: 'draft', createdAt: now(), expiresAt: now() + DAY, materials: {} };
          await save(task); jobs.set(task.id, task); json(res, 201, { task: view(task) });
        }); return;
      }
      const match = /^\/api\/video-replica\/tasks\/([a-f0-9-]{36})(?:\/(video|photo|voice|model|duration|language|source-audio|analyze|speech|recheck|start|result|resume|cancel))?$/.exec(path);
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
        if (match[2] === 'cancel' && req.method === 'POST') {
          await readJSON(req);
          if (view(task).canCancel) {
            task.status = 'cancelled'; task.error = ''; delete task.code; delete task.recovery;
            await save(task); await reconcile(task);
          }
          json(res, 200, { task: view(task) }); return;
        }
        if (match[2] === 'resume' && req.method === 'POST') {
          await readJSON(req);
          if (view(task).canResume) {
            for (const segment of task.narration?.segments || []) {
              if (segment.status !== 'waiting' || segment.recoveryAction === 'limit') continue;
              segment.status = segment.id ? 'pending' : undefined;
            }
            task.status = task.recovery.resumeStatus === 'reserving' ? 'draft' : task.recovery.resumeStatus;
            task.recoveryDeadline = now() + 30 * 60_000;
            delete task.recovery; task.error = ''; delete task.code; await save(task);
          }
          json(res, 200, { task: view(task) }); return;
        }
        if (match[2] === 'model' && req.method === 'POST') {
          const body = await readJSON(req);
          if (task.status !== 'draft') throw error('任务已提交，不能切换生成版本。', 409);
          const model = selectedModel(body.model);
          // A custom duration belongs to editions that support it; others fall back to their own limit.
          const target = targetFor(task, model);
          const duration = task.video ? videoDuration(task.video, model, target) : undefined;
          task.model = model;
          if (!target) delete task.targetDuration;
          if (isFalReplacement(model)) {
            if (task.sourceAudioMode === 'silent' && task.voiceEngine === 'seedance') task.voiceEngine = 'indextts2';
            task.sourceAudioMode = 'original';
          }
          if (task.video) task.duration = duration;
          await save(task); json(res, 200, { task: view(task) }); return;
        }
        if (match[2] === 'duration' && req.method === 'POST') {
          const body = await readJSON(req);
          if (task.status !== 'draft') throw error('任务已提交，不能修改生成时长。', 409);
          const model = task.model || MODEL, target = selectedTargetDuration(body?.targetDuration, model);
          if (task.video) {
            videoDuration(task.video, model, target);
            if (segmentPlan(clip(task.video, target), model) && !task.video.boundaries) {
              task.video = { ...task.video, boundaries: await segmentBoundaries(file(task, 'video'), task.video, model) };
            }
            // The seam, and with it the quoted tiers, depends on the detected boundaries.
            task.duration = videoDuration(task.video, model, target);
          }
          if (target) task.targetDuration = target; else delete task.targetDuration;
          await save(task); json(res, 200, { task: view(task) }); return;
        }
        if (match[2] === 'language' && req.method === 'POST') {
          await readJSON(req);
          throw error('复刻已改为保留原视频语言，请刷新页面后继续。', 410, 'VIDEO_LANGUAGE_SELECTION_REMOVED');
        }
        if (match[2] === 'source-audio' && req.method === 'POST') {
          const body = await readJSON(req);
          if (task.status !== 'draft') throw error('任务已提交，不能切换参考视频声音模式。', 409);
          const sourceAudioMode = selectedSourceAudioMode(body.sourceAudioMode, task.model);
          const voiceEngine = selectedVoiceEngine(body.voiceEngine ?? task.voiceEngine ?? 'seedance');
          if (task.model === WAN3_MODEL && voiceEngine === 'seedance') throw error('Wan 3.0 换声请使用 Chatterbox 音色转换。', 400, 'VIDEO_VOICE_ENGINE_INVALID');
          if (voiceEngine === 'chatterbox' && sourceAudioMode !== 'original') throw error('音色转换需要保留原视频声音。', 400, 'VIDEO_SOURCE_AUDIO_MODE_INVALID');
          if (isFalReplacement(task.model) && body.voiceEngine === 'seedance') throw error('此生成版本需使用独立配音和口型同步。', 400, 'VIDEO_VOICE_ENGINE_INVALID');
          task.sourceAudioMode = sourceAudioMode;
          task.voiceEngine = voiceEngine;
          await save(task); json(res, 200, { task: view(task) }); return;
        }
        if (['video', 'photo', 'voice'].includes(match[2]) && (req.method === 'PUT' || req.method === 'POST' && match[2] !== 'video')) {
          const replacingSource = match[2] === 'video' && view(task).canReplaceSource;
          if (task.status !== 'draft' && !replacingSource) throw error('任务已提交，不能替换素材。', 409);
          const kind = match[2];
          const imported = req.method === 'POST' && materialLibrary ? await materialLibrary.get(userId, (await readJSON(req)).assetId) : null;
          if (req.method === 'POST' && (!imported || imported.kind !== kind)) throw error('请选择相应类型的本人素材。', 400);
          const bytes = imported ? imported.bytes : await readBody(req, kind === 'video' ? VIDEO_LIMIT : kind === 'voice' ? VOICE_LIMIT : PHOTO_LIMIT);
          let name = imported?.name;
          if (!name && req.headers['x-file-name']) { try { name = decodeURIComponent(req.headers['x-file-name']); } catch {} }
          const temporary = join(folder(task), 'upload.tmp');
          if (kind === 'photo') {
            const normalized = imported ? bytes : await photo(bytes); await writeFile(temporary, normalized, { mode: 0o600 });
            const asset = materialLibrary && (imported || await materialLibrary.save(userId, { kind, path: temporary, name }));
            task.photo = { ready: true, ...(asset ? { assetId: asset.id } : {}) };
          } else if (kind === 'voice') {
            await writeFile(temporary, bytes, { mode: 0o600 });
            const normalized = join(folder(task), 'voice.tmp.wav');
            const metadata = imported ? imported.metadata : await voice(temporary, normalized);
            if (imported) await writeFile(normalized, bytes, { mode: 0o600 });
            const intervals = imported || task.voiceEngine === 'chatterbox' ? [] : await speech.detect(normalized).catch(() => []);
            const voiceMetadata = { ...metadata, speechStart: imported ? metadata.speechStart : intervals[0]?.start ?? null };
            const asset = materialLibrary && (imported || await materialLibrary.save(userId, { kind, path: normalized, name, metadata: voiceMetadata }));
            await rename(normalized, file(task, 'voice')); task.voice = { ...voiceMetadata, ...(asset ? { assetId: asset.id } : {}) }; delete task.speech; delete task.originalSpeech; delete task.speechConfirmedAt;
            await save(task); json(res, 200, { task: view(task) }); return;
          } else {
            if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw error('请上传 MP4 或 MOV 视频。');
            await writeFile(temporary, bytes, { mode: 0o600 });
            let metadata = await probe(temporary);
            const model = selectedModel(models.some(model => model.id === task.model) ? task.model : MODEL);
            const target = targetFor(task, model);
            videoDuration(metadata, model, target);
            if (model.startsWith('doubao-seedance-')) metadata = await normalizeSeedanceVideo(temporary, metadata);
            if (segmentPlan(clip(metadata, target), model)) metadata = { ...metadata, boundaries: await segmentBoundaries(temporary, metadata, model) };
            const duration = videoDuration(metadata, model, target);
            task.model = model;
            task.video = metadata;
            delete task.languageRouting; delete task.languageDetection; delete task.localization;
            delete task.voiceConversion; delete task.segments; delete task.segmentBoundary;
            delete task.videoAudioRemoved;
            delete task.videoCaptionsRemoved; delete task.captions; delete task.captionsChecked; delete task.captionCheck;
            delete task.speech;
            delete task.originalSpeech; delete task.speechConfirmedAt;
            task.duration = duration;
            task.ratio = RATIOS.reduce((best, ratio) => {
              const value = text => text.split(':').reduce((a, b) => a / b);
              return Math.abs(value(ratio) - metadata.width / metadata.height) < Math.abs(value(best) - metadata.width / metadata.height) ? ratio : best;
            });
          }
          await rename(temporary, file(task, kind));
          if (replacingSource) { task.status = 'draft'; delete task.recovery; task.error = ''; delete task.code; }
          await save(task); json(res, 200, { task: view(task) }); return;
        }
        if (match[2] === 'analyze' && req.method === 'POST') {
          await readJSON(req);
          if (task.status !== 'draft' || !task.video) throw error('请先上传参考视频，再分析台词。', 409);
          // Draft analysis has no reservation; generation includes transcription in its existing billing scope.
          await costMeter.run({ legacy: true }, () => analyzeSource(task));
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
              const record = task.pricingKey ? await credits.reserve({ userId, taskId: task.billingTaskId, kind: 'video', units: task.duration, pricingKey: task.pricingKey })
                : costMeter.enabled ? await credits.reserveCost({userId,taskId:task.billingTaskId}) : await credits.reserve({ userId, taskId: task.billingTaskId, kind: 'video', units: task.duration });
              task.billing = { status: record.status, reservedPoints: record.reservedPoints, chargedPoints: record.chargedPoints, exempt: record.exempt === true,
                ...(record.pricingKey ? { mode: 'model_price', pricingKey: record.pricingKey } : record.kind === 'api-cost' ? { mode: 'api_cost' } : {}) };
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
          const voiceEngine = selectedVoiceEngine(body.voiceEngine ?? task.voiceEngine ?? 'seedance');
          if (voiceEngine === 'chatterbox') {
            if (!task.voice) throw error('请先上传目标声音参考。', 400, 'VIDEO_VOICE_REQUIRED');
            if (!voiceConversion?.enabled) throw error('音色转换服务尚未配置，请联系管理员。', 503, 'VIDEO_VOICE_NOT_CONFIGURED');
          }
          if (voiceEngine === 'indextts2') {
            if (!task.voice) throw error('使用 IndexTTS2 请先上传声音参考。', 400, 'VIDEO_VOICE_REQUIRED');
            if (!narration?.enabled || !lipsync?.enabled) throw error('参考声音配音或口型服务尚未配置，请联系管理员。', 503, 'VIDEO_VOICE_NOT_CONFIGURED');
          }
          const model = selectedModel(body.model ?? (models.some(model => model.id === task.model) ? task.model : MODEL));
          if (model === WAN3_MODEL && task.voice && !['indextts2', 'chatterbox'].includes(voiceEngine)) throw error('Wan 3.0 换声请使用 Chatterbox 音色转换。', 400, 'VIDEO_VOICE_ENGINE_INVALID');
          const sourceAudioMode = selectedSourceAudioMode(body.sourceAudioMode ?? task.sourceAudioMode, model);
          if (voiceEngine === 'chatterbox' && sourceAudioMode !== 'original') throw error('音色转换需要保留原视频声音。', 400, 'VIDEO_SOURCE_AUDIO_MODE_INVALID');
          if (sourceAudioMode === 'silent' && !task.voice) throw error('请先上传声音参考。', 400, 'VIDEO_VOICE_REQUIRED');
          if (isFalReplacement(model) && task.voice && !['indextts2', 'chatterbox'].includes(voiceEngine)) throw error(`${models.find(item => item.id === model).name} 更换声音需使用独立配音和口型同步，请新建复刻后上传声音参考。`, 400, 'VIDEO_VOICE_ENGINE_INVALID');
          const target = targetFor(task, model);
          if (!target) delete task.targetDuration;
          videoDuration(task.video, model, target);
          if (model.startsWith('doubao-seedance-')) {
            const metadata = await normalizeSeedanceVideo(file(task, 'video'), task.video);
            if (metadata !== task.video) {
              task.video = metadata;
              delete task.videoAudioRemoved; delete task.videoCaptionsRemoved;
              delete task.captions; delete task.captionsChecked; delete task.captionCheck;
              delete task.materials.video;
            }
          }
          if (segmentPlan(clip(task.video, target), model)) {
            // Whole-track conversion keeps one continuous voice across the joined parts.
            if (voiceEngine !== 'chatterbox') throw error(`超过 ${models.find(item => item.id === model).maxDuration} 秒的生成时长需使用 Chatterbox 音色转换分段生成。`, 400, 'VIDEO_VOICE_ENGINE_INVALID');
            if (!task.video.boundaries) task.video = { ...task.video, boundaries: await segmentBoundaries(file(task, 'video'), task.video, model) };
          }
          if (target && task.video.duration - target > 0.05) {
            // Only the chosen opening seconds are generated; the clip replaces the draft source.
            const clipped = join(folder(task), 'source-clip.mp4');
            try { await cutSegment(file(task, 'video'), clipped, 0, target); }
            catch { throw error('参考视频截取未完成，尚未扣费或提交生成，请稍后重试。', 502, 'VIDEO_CLIP_FAILED'); }
            await rename(clipped, file(task, 'video'));
            const { boundaries } = task.video;
            task.video = { ...await probe(file(task, 'video')), ...(boundaries ? { boundaries } : {}) };
            delete task.videoAudioRemoved; delete task.videoCaptionsRemoved; delete task.captions; delete task.captionsChecked; delete task.captionCheck;
            delete task.speech; delete task.originalSpeech; delete task.speechConfirmedAt; delete task.materials.video;
            await save(task);
          }
          const duration = videoDuration(task.video, model, target), plan = segmentPlan(clip(task.video, target), model);
          for (const kind of Object.keys(task.materials)) if (kind.startsWith('segment-')) delete task.materials[kind];
          if (plan) { task.segments = plan.segments; task.segmentBoundary = plan.boundary; }
          else { delete task.segments; delete task.segmentBoundary; }
          task.model = model;
          task.duration = duration;
          task.pricingKey = generationPrice('video', model)?.key;
          task.cnyPerSecond = model === WAN3_MODEL ? wan3Price(now()) : models.find(item => item.id === model).cnyPerSecond;
          task.voiceEngine = voiceEngine;
          // Ignore cached clients and clear draft choices from before language selection was removed.
          delete task.targetLanguage; delete task.languageRouting; delete task.languageDetection; delete task.localization;
          task.recoveryPolicy = ['indextts2', 'chatterbox'].includes(voiceEngine) || sourceAudioMode === 'silent' ? 1 : undefined;
          if (task.recoveryPolicy) task.recoveryDeadline = now() + 30 * 60_000;
          task.sourceAudioMode = sourceAudioMode;
          task.status = 'reserving'; task.startedAt = now(); task.expiresAt = now() + 3 * DAY; await save(task);
          if (voiceEngine === 'chatterbox' && !task.video.audio) {
            await hold(task, { code: 'VIDEO_SOURCE_AUDIO_REQUIRED', recoveryAction: 'input', message: '音色转换需要包含清晰人声的原视频。' });
            json(res, 202, { task: view(task) }); return;
          }
          if (voiceEngine === 'indextts2' && (!task.video.audio || task.video.duration < 5)) {
            await hold(task, { code: 'VIDEO_NARRATION_SOURCE_REQUIRED', recoveryAction: 'input', message: '原视频需包含至少 5 秒原声。' });
            json(res, 202, { task: view(task) }); return;
          }
          if (sourceAudioMode === 'silent' && !task.video.audio) {
            await hold(task, { code: 'VIDEO_SOURCE_AUDIO_REQUIRED', recoveryAction: 'input', message: '无原声直配需先识别原视频的人声。' });
            json(res, 202, { task: view(task) }); return;
          }
          try {
            if (credits) {
              if(costMeter.enabled && !task.pricingKey && !isFalReplacement(model)) {
                const wallet=await credits.snapshot(userId);
                if(wallet.unlimited!==true&&costPoints(generationQuote(task))>wallet.available) throw error('积分不足，请选择更短的视频。',402,'INSUFFICIENT_POINTS');
              }
              let record;
              if (task.pricingKey) {
                record = await credits.reserve({ userId, taskId: task.id, kind: 'video', units: task.duration, pricingKey: task.pricingKey });
              } else if (costMeter.enabled) {
                record = await credits.reserveCost({userId,taskId:task.id});
                if (!isFalReplacement(model)) {
                  record = await prepareGenerationCost(task);
                }
              } else record = await credits.reserve({ userId, taskId: task.id, kind: 'video', units: task.duration });
              task.billing = { status: record.status, reservedPoints: record.reservedPoints, chargedPoints: record.chargedPoints, exempt: record.exempt === true,
                ...(record.pricingKey ? { mode: 'model_price', pricingKey: record.pricingKey } : record.kind === 'api-cost' ? { mode: 'api_cost' } : {}) };
            }
            task.status = 'preparing'; await save(task);
          } catch (cause) {
            if (fatal) throw cause;
            await fail(task, cause.code === 'INSUFFICIENT_POINTS' ? '积分不足，未开始生成。' : '积分预留失败，未开始生成。', cause.code || 'CREDITS_UNAVAILABLE');
            if (task.recoveryPolicy) { json(res, 202, { task: view(task) }); return; }
            throw cause;
          }
          json(res, 202, { task: view(task) }); return;
        }
        throw error('请求方式不受支持。', 405, 'METHOD_NOT_ALLOWED');
      });
    } catch (cause) {
      if (res.headersSent) { res.destroy(); return; }
      const safe = cause instanceof VideoError || ['INSUFFICIENT_POINTS', 'CREDITS_STORAGE_UNAVAILABLE', 'ASSET_STORAGE_ERROR'].includes(cause.code);
      json(res, safe ? cause.status || 503 : 503, { error: safe ? cause.message : '视频服务暂时不可用，请稍后查询原任务。', code: safe ? cause.code : 'VIDEO_UNAVAILABLE' });
    }
  };
  handler.ready = ready;
  async function archiveTaskMaterials(task) {
    if (!materialLibrary) return;
    for (const kind of ['photo', 'voice']) {
      if (!task[kind] || task[kind].assetId || !(await stat(file(task, kind)).catch(() => null))?.isFile()) continue;
      const asset = await materialLibrary.save(task.userId, { kind, path: file(task, kind), metadata: task[kind] });
      task[kind].assetId = asset.id; await save(task);
    }
  }
  handler.archiveMaterials = async userId => {
    await ready;
    for (const task of jobs.values()) {
      if (task.userId !== userId || task.cleaned) continue;
      await serialize(task.id, () => archiveTaskMaterials(task));
    }
  };
  handler.shutdown = () => shutdownPromise ||= (async () => {
    closing = true; clearInterval(timer); await ready.catch(() => {}); clearInterval(timer);
    await Promise.allSettled([...processors.values()]); await Promise.allSettled([...locks.values()]); await instance.close();
  })();
  return handler;
}
