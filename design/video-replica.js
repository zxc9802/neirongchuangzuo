import { uiLocale, t } from './workspace-preferences.js';
import { billingPointsText, creditEstimateText, observeCreditTask, refreshWorkspaceCredits, subscribeWorkspaceCredits, workspaceCreditsState } from './workspace-credits.js';
import { MALAYSIAN_PRICE_NOTE, generationPrice, generationPoints } from './malaysian-prices.js';

const API = '/api/video-replica';
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128';
const MODELS = [
  { id: DEFAULT_MODEL, name: 'qiya-2.0', maxDuration: 15 },
  { id: 'doubao-seedance-2-5-260628', name: 'qiya-2.5', maxDuration: 30, extendedDuration: 60 },
  { id: 'doubao-seedance-2-0-fast-260128', name: 'qiya-2.0-f1', maxDuration: 15 },
  { id: 'doubao-seedance-2-0-mini-260615', name: 'qiya-20-m1', maxDuration: 15 },
  { id: 'wan3.0-video', name: 'qiya-3.0', maxDuration: 15 },
];
const DEFAULT_VOICE = { voiceEngine: 'chatterbox', sourceAudioMode: 'original' };
const LANGUAGES = [{ id: 'zh', name: '中文' }, { id: 'en', name: '英语' }, { id: 'ms', name: '马来语' }];
const languageName = code => LANGUAGES.find(item => item.id === code)?.name || code || '待识别';
const displayMessage = value => String(value || '').replace(/IndexTTS2/gi, '配音服务').replace(/Wan\s*3\.0/gi, 'qiya-3.0');
const labels = { draft: '等待提交', reserving: '正在预留积分', preparing: '正在自动分析字幕与人声', reviewing: '正在审核人物素材', submitting: '正在提交生成', running: '正在替换人物', downloading: '正在保存成片', verifying: '正在核对台词与开口时间', settling: '正在确认积分', completed: '复刻完成', failed: '进度已保存', waiting: '等待继续处理', cancelled: '已停止处理', expired: '已过期' };
const taskLabel = task => task.status === 'preparing' && ['en', 'ms'].includes(task.targetLanguage) && !task.languageRouting
  ? '正在识别原视频语言' : task.languageRouting?.translate && task.status === 'preparing'
  ? '正在翻译台词并生成配音' : task.languageRouting?.translate && task.status === 'verifying'
  ? '正在按译后配音同步口型' : task.voiceEngine === 'chatterbox' && task.status === 'preparing'
  ? '正在保留原声节奏并转换音色' : task.voiceEngine === 'chatterbox' && task.status === 'verifying'
  ? '正在合成人物画面与目标声音' : task.voiceEngine === 'seedance' && task.sourceAudioMode === 'silent' && task.status === 'preparing'
  ? '正在将原视频语音转为台词' : task.voiceEngine === 'indextts2' && task.status === 'verifying'
  ? task.narrationProgress?.ready ? '正在同步口型与参考配音' : '正在完成参考声音配音'
  : task.voiceEngine === 'indextts2' && task.status === 'running' && !task.narrationProgress?.ready
    ? '正在替换人物并生成参考配音' : task.segments && task.status === 'downloading'
    ? '正在保存并拼接两段成片' : labels[task.status] || '正在处理';
const SEAMS = { scene: '镜头切换处', pause: '说话停顿处', duration: '按生成时长切分' };
const segmentText = task => task.segments ? `分 ${task.segments.total} 段生成 · 第 ${Number(Number(task.segments.seam).toFixed(2))} 秒接续（${SEAMS[task.segments.boundary] || '自动选择'}），整条统一换声` : '';
const pending = task => task && !['draft', 'completed', 'failed', 'expired', 'waiting', 'cancelled'].includes(task.status);
let state = { owner: null, config: null, tasks: [], current: null, model: DEFAULT_MODEL, targetDuration: null, files: {}, urls: {}, busy: false, error: '', pollError: '', loading: true };
let context, timer, polling = false, unsubscribeCredits;
let selectedMaterials = {};
function resetFiles() { for (const url of Object.values(state.urls)) if (url.startsWith('blob:')) URL.revokeObjectURL(url); state.files = {}; state.urls = {}; selectedMaterials = {}; }
function account() {
  const owner = globalThis.workspaceUser?.id || 'local-dev';
  if (state.owner !== owner) { resetFiles(); state = { owner, config: null, tasks: [], current: null, model: DEFAULT_MODEL, targetDuration: null, files: {}, urls: {}, busy: false, error: '', pollError: '', loading: true }; }
}
async function request(path, options = {}) {
  const signal = AbortSignal.timeout(options.method === 'PUT' ? 180_000 : options.method ? 60_000 : 15_000);
  try {
    const response = await fetch(API + path, { credentials: 'same-origin', cache: 'no-store', signal, ...options });
    let data;
    try { data = await response.json(); } catch { throw new Error('视频服务暂时不可用，请刷新任务记录。'); }
    if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。');
    return data;
  } catch (cause) {
    if (signal.aborted) throw new Error(options.method ? '上传或提交超时，请刷新任务记录后重试；不会自动重新生成。' : '查询任务超时，正在自动重试；不会重新生成。');
    throw cause;
  }
}
function jsonPost(body = {}) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
function remember(task) {
  state.current = task;
  state.model = task.model || state.model;
  state.tasks = [task, ...state.tasks.filter(item => item.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt);
  observeCreditTask(task);
}
function refresh() { if (context && document.body.dataset.page === 'replica') context.refresh(); }
function refreshCredits() {
  if (!context || document.body.dataset.page !== 'replica') return;
  const cost = document.querySelector('#replica-cost'), details = document.querySelector('#replica-result-summary');
  if (cost) cost.textContent = costText();
  if (details) details.innerHTML = summary(context);
}
function failureMessage(task) {
  return displayMessage(task?.canRecheck ? task.error?.replace('请核对素材后重新生成。', '请重新检查成片。') : task?.error);
}
function actionMessage() {
  if (state.pollError) return '正在重新连接，已有任务进度已保留。';
  if (state.error) return displayMessage(state.error);
  if (state.busy) return '';
  if (state.current?.recovery) return state.current.recovery.message;
  if (state.current?.status === 'verifying') return ['indextts2', 'chatterbox'].includes(state.current.voiceEngine) ? `${taskLabel(state.current)}，请稍候。` : '正在核对已有成片的台词与开口时间，请稍候。';
  if (state.current?.status === 'failed') return failureMessage(state.current);
  return !state.loading && !state.config?.enabled ? '人物复刻服务尚未配置，请联系管理员。' : '';
}
function voiceHint() {
  const task = state.current && state.current.status !== 'draft' ? state.current : DEFAULT_VOICE;
  if (['en', 'ms'].includes(task.targetLanguage)) return '<p class="replica-voice-hint">此历史任务沿用提交时的声音处理流程；新建复刻保留原视频语言。</p>';
  return `<p class="replica-voice-hint">${task.voiceEngine === 'chatterbox' ? '保留原视频语言，将原视频人声转换为上传的音色，尽量保留原台词、语速、停顿和情绪，不逐句变速。原片需有清晰单人声音；音色与口型效果请试听核对。' : task.voiceEngine === 'indextts2' ? '上传声音参考后，单独生成配音并同步口型；情绪参考原视频，原片需包含至少 5 秒清晰原声。' : task.sourceAudioMode === 'silent' ? '由视频模型按原片台词和时间线直接配音，音色只参考上传的声音，无需额外口型处理。情绪参考画面和台词，音色效果需试听。' : '由视频模型生成配音，同时参考原视频的情绪和上传的声音。'}</p>`;
}
function selectedModel() {
  return MODELS.find(model => model.id === (state.current?.model || state.model))
    || (state.current?.model === 'fal-ai/pixverse/swap' && state.current.status !== 'draft'
      ? { id: state.current.model, name: 'PixVerse Swap', maxDuration: 30 } : MODELS[0]);
}
function modelName(task) { return (task.model === 'fal-ai/pixverse/swap' ? 'PixVerse Swap' : MODELS.find(model => model.id === (task.model || DEFAULT_MODEL))?.name) || ''; }
// Saved tasks own their custom duration; before creation it is a local choice.
function targetDuration() {
  if (!selectedModel().extendedDuration) return null;
  return (state.current ? state.current.targetDuration : state.targetDuration) || null;
}
function durationSetting(ctx) {
  const model = selectedModel(), target = targetDuration();
  if (!model.extendedDuration) return '';
  const locked = state.busy || state.current && state.current.status !== 'draft' || !state.config?.enabled;
  return `<div class="replica-duration-setting"><label class="replica-duration-toggle"><input type="checkbox" id="replica-custom-duration" ${target ? 'checked' : ''} ${locked ? 'disabled' : ''}>自定义生成时长</label>${target ? `<label class="replica-duration-value">生成开头 <input type="number" id="replica-target-duration" min="2" max="${model.extendedDuration}" step="1" value="${target}" ${locked ? 'disabled' : ''} aria-label="生成时长（秒）"> 秒</label>` : ''}
    <p class="replica-model-description">${ctx.esc(target ? `从参考视频开头截取，最长 ${model.extendedDuration} 秒；视频较短时按实际时长生成。超过 ${model.maxDuration} 秒分两段生成，整条统一换声。` : `不开启时按单次上限 ${model.maxDuration} 秒生成；开启后可选 2–${model.extendedDuration} 秒。`)}</p></div>`;
}
function modelPicker(ctx) {
  const selected = selectedModel(), locked = state.busy || state.current && state.current.status !== 'draft';
  const price = generationPrice('video', selected.id);
  const description = price ? `最多生成${selected.maxDuration}秒视频，RM ${price.rmPerSecond}/秒（${price.pointsPerSecond} 积分/秒）` : '历史版本，仅供查看已有成片';
  return `<div class="replica-model-setting"><label for="replica-models">生成版本</label><select id="replica-models" class="replica-models" aria-describedby="replica-model-description" ${locked || !state.config?.enabled ? 'disabled' : ''}>${!MODELS.some(model => model.id === selected.id) ? `<option value="${ctx.esc(selected.id)}" selected disabled>${ctx.esc(selected.name)}（历史版本）</option>` : ''}${MODELS.map(model => {
    const configured = state.config?.models?.find(item => item.id === model.id);
    const unavailable = !state.config?.enabled || configured?.enabled === false || model.id === 'wan3.0-video' && !configured?.enabled;
    return `<option value="${model.id}" ${selected.id === model.id ? 'selected' : ''} ${unavailable ? 'disabled' : ''}>${ctx.esc(model.name)}</option>`;
  }).join('')}</select><p id="replica-model-description" class="replica-model-description" title="${ctx.esc(MALAYSIAN_PRICE_NOTE)}">${ctx.esc(description)}</p>${durationSetting(ctx)}</div>`;
}
function slot(kind, ctx) {
  const video = kind === 'video', voice = kind === 'voice', title = video ? '参考视频' : voice ? '声音参考' : '目标人物照片', selected = state.files[kind] || selectedMaterials[kind];
  const saved = state.current?.[kind];
  const voiceRequired = voice && (!state.current || state.current.status === 'draft' || ['indextts2', 'chatterbox'].includes(state.current.voiceEngine) || state.current.sourceAudioMode === 'silent');
  const disabled = state.busy || pending(state.current) || state.current && state.current.status !== 'draft' && !(video && state.current.canReplaceSource) || voice && !state.config?.voiceEnabled;
  const source = state.urls[kind] || state.current?.[video ? 'sourceVideoUrl' : voice ? 'sourceVoiceUrl' : 'sourcePhotoUrl'];
  const preview = source ? video
    ? `<video src="${ctx.esc(source)}" controls playsinline preload="metadata" aria-label="参考视频预览"></video>`
    : voice ? `<audio src="${ctx.esc(source)}" controls preload="metadata" aria-label="声音参考试听"></audio>`
      : `<img src="${ctx.esc(source)}" alt="目标人物照片预览">` : `<div class="replica-upload-symbol">${ctx.icon(video ? 'video' : voice ? 'audio' : 'image')}</div>`;
  return `<section class="replica-upload ${voice ? 'replica-voice-slot' : ''}"><div class="replica-slot-title"><span>${video ? '01' : voice ? '03' : '02'}</span><h3>${t(title)}${voice ? `<small>${t(voiceRequired ? '必填' : '选填')} · ${t('更换音色')}</small>` : ''}</h3></div>
    ${voice ? voiceHint() : ''}<div class="replica-input-preview">${preview}</div>
    <strong class="replica-file-name">${ctx.esc(selected?.name || (saved?.assetId ? '已存入资产，长期保留' : saved ? '素材已上传并保存' : video ? '上传你想保留动作的视频' : voice ? '选择想使用的单人声音' : '上传你想替换成的人物'))}</strong>
    <p>${video ? `单个人物 · ${targetDuration() ? `截取开头 ${targetDuration()} 秒` : `2–${selectedModel().maxDuration} 秒`} · MP4 / MOV · 最大 50 MB` : voice ? state.config && !state.config.voiceEnabled ? '换声服务尚未配置，请联系管理员。' : '清晰单人声音 · 2–15 秒 · MP3 / WAV · 最大 15 MB' : '清晰正脸 · JPG / PNG / WebP · 最大 10 MB'}</p>
    <input id="replica-${kind}" type="file" accept="${video ? 'video/mp4,video/quicktime,.mp4,.mov' : voice ? 'audio/mpeg,audio/wav,.mp3,.wav' : 'image/jpeg,image/png,image/webp'}" ${disabled ? 'disabled' : ''} aria-label="${t('上传')} ${t(title)}">
    <label for="replica-${kind}" class="secondary replica-file-button ${disabled ? 'disabled' : ''}">${t(selected || saved ? '更换' : '选择')} ${t(title)}</label>${!video ? `<a href="#assets" class="replica-asset-link">${t(voice ? '从资产选择声音' : '从资产选择形象')}</a>` : ''}</section>`;
}
function generationEstimate() {
  const model = selectedModel();
  if (!MODELS.some(item => item.id === model.id)) return '';
  return `<p class="replica-time-estimate">生成时间约为 ${model.id === 'wan3.0-video' ? '13–17' : '5–10'} 分钟</p>`;
}
function result(ctx) {
  const task = state.current;
  if (!task) return `<div class="replica-empty">${ctx.icon('video')}<h3>原视频的表演，照片中的人物</h3><p>保留动作、镜头与说话内容<br>人物形象跟随照片，自然表达情绪</p>${generationEstimate()}<span>成片在这里预览</span></div>`;
  if (task.resultUrl) return `<video controls playsinline preload="metadata" src="${ctx.esc(task.resultUrl)}" aria-label="人物复刻成片"></video>`;
  const message = task.recovery?.message || (task.status === 'failed' ? failureMessage(task) : displayMessage(task.error));
  return `<div class="replica-empty ${pending(task) ? 'replica-working' : ''}"><div class="replica-progress-symbol">${ctx.icon(task.status === 'failed' ? 'info' : 'video')}</div><h3>${taskLabel(task)}</h3><p>${ctx.esc(message || (pending(task) ? '任务正在处理，可以离开页面，稍后回来查看。' : task.status === 'draft' ? '素材就绪后，点击一键生成。' : '请重新上传素材创建任务。'))}</p>${pending(task) || task.status === 'draft' ? generationEstimate() : ''}</div>`;
}
function progress(ctx) {
  const task = state.current;
  if (!pending(task) && task?.status !== 'waiting') return '';
  const now = Date.now(), elapsed = Math.max(0, now - (task.startedAt || task.createdAt));
  const duration = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; };
  const received = Number(task.downloadProgress?.receivedBytes), total = Number(task.downloadProgress?.totalBytes);
  const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const part = task.downloadProgress?.segments ? `（第 ${task.downloadProgress.segment} / ${task.downloadProgress.segments} 段）` : '';
  const segments = task.segments && ['submitting', 'running'].includes(task.status) ? `<p>分段生成：已提交 ${task.segments.submitted} / ${task.segments.total} 段 · 已完成 ${task.segments.completed} / ${task.segments.total} 段</p>` : '';
  const download = Number.isFinite(received) && received >= 0 ? `<p>保存成片${part}：${mb(received)}${total > 0 ? ` / ${mb(total)}` : ''}</p>${total > 0 ? `<progress aria-label="成片保存进度" max="${total}" value="${Math.min(received, total)}"></progress>` : ''}` : '';
  const voiceProgress = task.localizationProgress || task.narrationProgress;
  const narration = voiceProgress ? `<p>配音已完成 ${voiceProgress.completed} / ${voiceProgress.total} 段</p>` : '';
  return `${narration}${segments}<p>已等待 ${duration(elapsed)} · ${task.status === 'waiting' ? '进度已保存' : task.lastCheckedAt ? `最近收到模型回复：${duration(now - task.lastCheckedAt)}前` : '等待模型回复'}</p>${download}
    ${state.pollError ? '<p>正在重新连接，已有任务进度已保留。</p>' : pending(task) && elapsed >= 600_000 ? '<p>等待时间较长，仍在查询原任务，请勿重复提交。</p>' : ''}
    <small>任务编号：${ctx.esc(task.id)}</small>`;
}
function history(ctx) {
  return state.tasks.length ? state.tasks.map(task => `<button type="button" class="replica-history-item ${task.id === state.current?.id ? 'active' : ''}" data-replica-task="${ctx.esc(task.id)}" ${state.busy ? 'disabled' : ''}><span>${taskLabel(task)}</span><small>${modelName(task) ? ctx.esc(modelName(task)) + ' · ' : ''}${ctx.esc(new Date(task.createdAt).toLocaleString(uiLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))} · ${task.duration || '—'} 秒</small></button>`).join('') : '<p class="replica-muted">你的复刻记录会保存在这里</p>';
}
function summary(ctx) {
  const task = state.current;
  const route = task?.languageRouting;
  const language = route ? `<span>原视频：${ctx.esc(languageName(route.source))} · 所选语言：${ctx.esc(languageName(route.target))} · ${route.translate ? '翻译配音并同步口型' : route.reason === 'same-language' ? '语言一致，沿用原方案' : '中文沿用原方案'}</span>` : '';
  return task ? `<div><strong>${taskLabel(task)}</strong>${language}<span>${modelName(task) ? ctx.esc(modelName(task)) + ' · ' : ''}${task.actualDuration || task.duration || '—'} 秒 · ${ctx.esc(task.ratio || '自动比例')} · ${ctx.esc(task.resolution || '720p')}${billingPointsText(task) ? ` · ${ctx.esc(billingPointsText(task))}` : ''}</span>${segmentText(task) ? `<span>${ctx.esc(segmentText(task))}</span>` : ''}${task.frameBorders?.warning ? `<span>${ctx.esc(task.frameBorders.warning)}</span>` : ''}${task.captionCheck?.warning ? `<span>${ctx.esc(displayMessage(task.captionCheck.warning))}</span>` : ''}${task.audioCheck ? `<span>${task.audioCheck.engine === 'indextts2' ? '已使用参考声音配音，并按新配音处理口型；请预览核对效果。' : task.audioCheck.warning ? ctx.esc(displayMessage(task.audioCheck.warning)) : `${task.audioCheck.transcriptDifferences ? `台词有 ${ctx.esc(task.audioCheck.transcriptDifferences)} 字轻微识别差异` : '台词一致'} · 开口偏差 ${Math.abs(task.audioCheck.afterOffsetMs)} 毫秒；请预览核对台词、音色与口型。`}</span>` : ''}</div>${task.resultUrl ? `<a class="primary replica-download" href="${ctx.esc(task.resultUrl)}?download=1" download>下载成片</a>` : ''}` : '';
}
function playerStyle(task) {
  let width = Number(task?.video?.width), height = Number(task?.video?.height);
  if (!(width > 0 && height > 0)) [width, height] = String(task?.ratio || '').split(':').map(Number);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? `--replica-aspect:${width}/${height};--replica-max-width:${Math.round(440 * width / height)}px` : '';
}
function costText() {
  const task = state.current;
  const unlimited = workspaceCreditsState().snapshot?.unlimited === true, exempt = task?.billing?.exempt === true;
  const actualCost=workspaceCreditsState().snapshot?.pricing?.mode==='api_cost';
  const conversionCost = !task || task.status === 'draft' || task.voiceEngine === 'chatterbox' ? '；音色转换另按实际用量结算' : '';
  const price = generationPrice('video', selectedModel().id);
  if (!unlimited && !exempt && price && (!task || task.status === 'draft' || task.billing?.mode === 'model_price')) {
    return task?.duration ? `预计 ${generationPoints(task.duration, task.billing?.pricingKey || price.key)} 积分 · ${task.duration} 秒 · 按成片时长结算，积分四舍五入；失败退回预留积分。`
      : `${price.pointsPerSecond} 积分/秒；上传后按时长预留积分，失败退回。`;
  }
  return unlimited ? `${creditEstimateText(task?.estimatedPoints)}${task?.duration ? ` · ${task.duration} 秒` : ''}`
    : exempt ? task?.duration ? `${task.duration} 秒` : '上传后自动识别时长。'
      : actualCost ? task?.estimatedPoints ? `生成费用预计 ${task.estimatedPoints} 积分 · ${task.duration} 秒${conversionCost}` : `按实际算力计费${conversionCost}`
        : task?.estimatedPoints ? `预计冻结 ${task.estimatedPoints} 积分 · ${task.duration} 秒 · 成功后按成片时长结算，不超过预估` : '按视频时长预留积分；失败退回预留积分。';
}
function submitArea(ctx) {
  const task = state.current, finished = task && ['completed', 'failed', 'expired', 'waiting', 'cancelled'].includes(task.status);
  return `<p id="replica-cost">${ctx.esc(costText())}</p><p id="replica-error" class="replica-muted" role="status">${ctx.esc(actionMessage())}</p>
    <button type="button" id="replica-submit" class="primary" ${finished ? 'hidden' : ''} ${state.busy || pending(task) || finished || !state.config?.enabled ? 'disabled' : ''}>${state.busy ? '正在上传并提交…' : pending(task) ? taskLabel(task) : '一键生成'}</button>
    ${task?.canResume ? `<button type="button" id="replica-resume" class="primary" ${state.busy ? 'disabled' : ''}>继续处理</button>` : ''}
    ${task?.canCancel ? `<button type="button" id="replica-cancel" class="secondary" ${state.busy ? 'disabled' : ''}>停止处理</button>` : ''}
    ${task?.status === 'failed' && task.canRecheck === true ? `<button type="button" id="replica-recheck" class="primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在提交复核…' : '重新检查成片'}</button>` : ''}`;
}
export function renderVideoReplica(ctx) {
  account(); context = ctx;
  const task = state.current;
  return `<div class="replica-heading"><div><span class="replica-eyebrow">1:1复刻 · ${ctx.esc(selectedModel().name)}</span><h1>人物 1:1 复刻</h1><p>上传一个视频和一张照片，让照片中的人物出演原视频。</p></div><span class="replica-badge">人物替换</span></div>
    <div class="replica-toolbar"><button type="button" id="replica-new" class="secondary" ${state.busy ? 'disabled' : ''}>新建复刻</button></div>
    <div class="replica-layout"><section class="replica-form"><div class="replica-uploads">${slot('video', ctx)}${slot('photo', ctx)}${slot('voice', ctx)}</div>${modelPicker(ctx)}
      <p class="replica-note">请使用有权使用的视频和人物照片。人物相似度与表演效果以实际生成结果为准。</p>
      <div id="replica-submit-area" class="replica-submit-area">${submitArea(ctx)}</div></section>
      <section class="replica-output"><div class="replica-output-title"><h2>成片预览</h2><span>结果保留 3 天</span></div><div id="replica-result" class="replica-player" style="${playerStyle(task)}">${result(ctx)}</div><div id="replica-result-summary" class="replica-result-summary">${summary(ctx)}</div><div id="replica-progress" class="replica-progress" aria-live="polite">${progress(ctx)}</div><div class="replica-history-heading"><h3>最近的复刻</h3><button type="button" id="replica-refresh" class="textbutton">刷新记录</button></div><div id="replica-history" class="replica-history">${history(ctx)}</div></section></div>`;
}
async function selectModel(id) {
  if (state.busy || state.current && state.current.status !== 'draft' || !MODELS.some(model => model.id === id) || !state.config?.enabled) return;
  if (selectedModel().id === id) return;
  if (!state.current) {
    state.model = id;
    state.error = ''; refresh(); return;
  }
  state.busy = true; state.error = ''; refresh();
  try {
    const limit = targetDuration() ? selectedModel().extendedDuration : selectedModel().maxDuration;
    if (state.files.video && MODELS.find(model => model.id === id).maxDuration < limit) {
      const video = state.files.video;
      remember((await request(`/tasks/${state.current.id}/video`, { method: 'PUT', headers: { 'Content-Type': video.type || 'application/octet-stream' }, body: video })).task);
      delete state.files.video;
    }
    remember((await request(`/tasks/${state.current.id}/model`, jsonPost({ model: id }))).task);
  }
  catch (cause) { state.error = cause.message; }
  finally { state.busy = false; refresh(); }
}
async function selectTargetDuration(value) {
  const model = selectedModel();
  if (state.busy || state.current && state.current.status !== 'draft' || !model.extendedDuration || !state.config?.enabled) return;
  const seconds = Math.round(Number.parseFloat(value));
  const target = value === null ? null : Number.isFinite(seconds) ? Math.min(model.extendedDuration, Math.max(2, seconds)) : targetDuration();
  if (target === targetDuration()) { refresh(); return; }
  if (!state.current) { state.targetDuration = target; state.error = ''; refresh(); return; }
  state.busy = true; state.error = ''; refresh();
  try {
    // Turning the option off restores the edition limit, so save a newly chosen video before the saved one is checked.
    if (!target && state.files.video) {
      const video = state.files.video;
      remember((await request(`/tasks/${state.current.id}/video`, { method: 'PUT', headers: { 'Content-Type': video.type || 'application/octet-stream' }, body: video })).task);
      delete state.files.video;
    }
    remember((await request(`/tasks/${state.current.id}/duration`, jsonPost({ targetDuration: target }))).task);
  }
  catch (cause) { state.error = cause.message; }
  finally { state.busy = false; refresh(); }
}
async function selectFile(kind, file) {
  if (!file) return;
  const limit = kind === 'video' ? 50 : kind === 'voice' ? 15 : 10;
  if (file.size > limit * 1024 * 1024) { state.error = `文件过大，${kind === 'video' ? '视频' : kind === 'voice' ? '声音参考' : '照片'}不能超过 ${limit} MB。`; refresh(); return; }
  if (state.urls[kind]) URL.revokeObjectURL(state.urls[kind]);
  delete selectedMaterials[kind];
  state.files[kind] = file; state.urls[kind] = URL.createObjectURL(file); state.error = ''; refresh();
  if (kind === 'video' && state.current?.canReplaceSource) {
    state.busy = true; refresh();
    try {
      remember((await request(`/tasks/${state.current.id}/video`, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })).task);
      resetFiles();
    } catch (cause) { state.error = cause.message; }
    finally { state.busy = false; refresh(); }
  }
}
async function submit() {
  if (state.busy || pending(state.current) || state.current && state.current.status !== 'draft') return;
  if ((!state.files.video && !state.current?.video) || (!state.files.photo && !selectedMaterials.photo && !state.current?.photo)) { state.error = '请先上传一段参考视频和一张人物照片。'; refresh(); return; }
  if (!state.files.voice && !selectedMaterials.voice && !state.current?.voice) { state.error = '请先上传声音参考。'; refresh(); return; }
  state.busy = true; state.error = ''; refresh();
  try {
    const id = state.current?.id || crypto.randomUUID();
    const model = selectedModel().id, { voiceEngine, sourceAudioMode } = DEFAULT_VOICE, target = targetDuration();
    const custom = target ? { targetDuration: target } : {};
    // Keep the request ID before networking so an uncertain response can be retried safely.
    if (!state.current) state.current = { id, status: 'draft', createdAt: Date.now(), model, ...custom };
    remember((await request('/tasks', jsonPost({ requestId: id, model, voiceEngine, sourceAudioMode, ...custom }))).task);
    if (state.current.status === 'draft') {
      for (const kind of ['video', 'photo', 'voice']) {
        if (selectedMaterials[kind]) {
          remember((await request(`/tasks/${id}/${kind}`, jsonPost({ assetId: selectedMaterials[kind].id }))).task);
          continue;
        }
        if (!state.files[kind]) continue;
        remember((await request(`/tasks/${id}/${kind}`, { method: 'PUT', headers: { 'Content-Type': state.files[kind].type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(state.files[kind].name) }, body: state.files[kind] })).task);
      }
      resetFiles();
      remember((await request(`/tasks/${id}/start`, jsonPost({ model, voiceEngine, sourceAudioMode }))).task);
    }
    void refreshWorkspaceCredits();
  } catch (cause) { state.error = cause.message; }
  finally { state.busy = false; refresh(); }
}
async function recheck() {
  const task = state.current;
  if (state.busy || task?.status !== 'failed' || task.canRecheck !== true) return;
  state.busy = true; state.error = ''; state.pollError = ''; refresh();
  try {
    remember((await request(`/tasks/${task.id}/recheck`, jsonPost())).task); void refreshWorkspaceCredits();
  }
  catch (cause) { state.error = cause.message; }
  finally { state.busy = false; refresh(); }
}
async function recoverTask(action) {
  if (state.busy || !state.current || !(action === 'resume' ? state.current.canResume : state.current.canCancel)) return;
  state.busy = true; state.error = ''; refresh();
  try {
    remember((await request(`/tasks/${state.current.id}/${action}`, jsonPost())).task);
    if (action === 'resume' && state.current.status === 'draft') remember((await request(`/tasks/${state.current.id}/start`, jsonPost())).task);
    void refreshWorkspaceCredits();
  }
  catch { state.error = '正在确认任务状态，请稍后刷新记录。'; }
  finally { state.busy = false; refresh(); }
}
async function poll() {
  if (polling || state.busy || !context) return;
  polling = true;
  const owner = state.owner;
  try {
    const [config, data] = await Promise.all([state.config ? Promise.resolve(state.config) : request('/config'), request('/tasks')]);
    if (state.owner !== owner) return;
    const inputs = () => ['video', 'photo', 'voice'].map(kind => slot(kind, context)).join('');
    const previous = { inputs: inputs(), models: modelPicker(context), result: result(context), style: playerStyle(state.current), actions: submitArea(context) };
    const firstLoad = state.loading;
    state.config = config; state.tasks = data.tasks; state.loading = false; state.pollError = '';
    if (state.current) state.current = data.tasks.find(item => item.id === state.current.id) || state.current;
    for (const task of data.tasks) observeCreditTask(task);
    if (!document.querySelector('#replica-submit')) return;
    // Progress changes must not replace the reference video/audio elements.
    if (firstLoad || previous.inputs !== inputs() || previous.models !== modelPicker(context)) refresh();
    else {
      const output = document.querySelector('#replica-result'), actions = submitArea(context);
      if (previous.result !== result(context)) output.innerHTML = result(context);
      if (previous.style !== playerStyle(state.current)) output.setAttribute('style', playerStyle(state.current));
      document.querySelector('#replica-result-summary').innerHTML = summary(context);
      document.querySelector('#replica-history').innerHTML = history(context);
      if (previous.actions !== actions) {
        document.querySelector('#replica-submit-area').innerHTML = actions;
        bindVideoReplica(context);
      }
      document.querySelector('#replica-error').textContent = actionMessage();
    }
    const details = document.querySelector('#replica-progress'); if (details) details.innerHTML = progress(context);
  } catch (cause) {
    state.pollError = cause.message;
    const message = document.querySelector('#replica-error'); if (message) message.textContent = actionMessage();
    const details = document.querySelector('#replica-progress'); if (details && context) details.innerHTML = progress(context);
  } finally { polling = false; }
}
export function useReplicaMaterial(material) {
  account();
  if (state.busy) throw new Error('素材正在提交，请完成后再选择。');
  if (!['photo', 'voice'].includes(material.kind) || !/^(photo|voice)-[a-f0-9]{64}$/.test(material.id)) throw new Error('素材无效。');
  if (state.current && state.current.status !== 'draft') { resetFiles(); state.current = null; }
  const kind = material.kind;
  if (state.urls[kind]?.startsWith('blob:')) URL.revokeObjectURL(state.urls[kind]);
  delete state.files[kind]; selectedMaterials[kind] = material;
  state.urls[kind] = `/api/assets/materials/${material.id}/media`; state.error = ''; refresh();
}
export function bindVideoReplica(ctx) {
  context = ctx;
  if (!unsubscribeCredits) unsubscribeCredits = subscribeWorkspaceCredits(refreshCredits);
  document.querySelector('#replica-models').onchange = event => { void selectModel(event.target.value); };
  const custom = document.querySelector('#replica-custom-duration');
  if (custom) custom.onchange = event => { void selectTargetDuration(event.target.checked ? selectedModel().extendedDuration : null); };
  const seconds = document.querySelector('#replica-target-duration');
  if (seconds) seconds.onchange = event => { void selectTargetDuration(event.target.value); };
  for (const kind of ['video', 'photo', 'voice']) document.querySelector(`#replica-${kind}`).onchange = event => { void selectFile(kind, event.target.files[0]); };
  const retry = document.querySelector('#replica-recheck'); if (retry) retry.onclick = () => { void recheck(); };
  const resume = document.querySelector('#replica-resume'); if (resume) resume.onclick = () => { void recoverTask('resume'); };
  const cancel = document.querySelector('#replica-cancel'); if (cancel) cancel.onclick = () => { void recoverTask('cancel'); };
  document.querySelector('#replica-submit').onclick = () => { void submit(); };
  document.querySelector('#replica-new').onclick = () => { resetFiles(); state.current = null; state.model = DEFAULT_MODEL; state.targetDuration = null; state.error = ''; refresh(); };
  document.querySelector('#replica-refresh').onclick = () => { state.error = ''; state.pollError = ''; void poll(); };
  document.querySelector('#replica-history').onclick = event => {
    const button = event.target.closest('[data-replica-task]'); if (!button || state.busy) return;
    resetFiles(); state.current = state.tasks.find(task => task.id === button.dataset.replicaTask); state.model = state.current?.model || DEFAULT_MODEL; state.error = ''; refresh();
  };
  if (!timer) { void poll(); timer = setInterval(() => { void poll(); }, 5000); }
}
export function disposeVideoReplica() { clearInterval(timer); timer = null; context = null; unsubscribeCredits?.(); unsubscribeCredits = null; }
