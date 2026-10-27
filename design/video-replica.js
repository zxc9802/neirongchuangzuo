import { uiLocale, t } from './workspace-preferences.js';
import { billingPointsText, creditEstimateText, observeCreditTask, refreshWorkspaceCredits, subscribeWorkspaceCredits, workspaceCreditsState } from './workspace-credits.js';
import { MALAYSIAN_PRICE_NOTE, generationPrice, generationPoints } from './malaysian-prices.js';
import { openReplicaAssetPicker } from './replica-asset-picker.js';
import { uploadSharedMaterial } from './generated-assets.js';

const API = '/api/video-replica';
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128';
const MINIMAX_MODEL = 'MiniMax-H3';
const WAN3_MODEL = 'wan3.0-video', WAN3_FAST_MODEL = 'wan3.0-video-prime';
const MODELS = [
  { id: DEFAULT_MODEL, name: 'qiya-2.0', maxDuration: 15, extendedDuration: 60 },
  { id: 'doubao-seedance-2-5-260628', name: 'qiya-2.5', maxDuration: 30, extendedDuration: 60 },
  { id: 'doubao-seedance-2-0-fast-260128', name: 'qiya-2.0-f1', maxDuration: 15, extendedDuration: 60 },
  { id: 'doubao-seedance-2-0-mini-260615', name: 'qiya-20-m1', maxDuration: 15, extendedDuration: 60 },
  { id: 'wan3.0-video', name: 'qiya-3.0', maxDuration: 15, extendedDuration: 60 },
  { id: WAN3_FAST_MODEL, name: 'qiya-3.0 快速版', maxDuration: 15, extendedDuration: 60, fast: true },
  { id: MINIMAX_MODEL, name: 'MiniMax-H3', maxDuration: 15, extendedDuration: 60 },
];
const DEFAULT_VOICE = { voiceEngine: 'chatterbox', sourceAudioMode: 'original' };
const REPLACEMENTS = { photo: '人物', voice: '声音', product: '商品', background: '背景' };
const emptyReplacements = () => ({ photo: false, voice: false, product: false, background: false });
let mode = 'classic', editMode = 'standard', replacements = emptyReplacements(), modeDrafts = {};
const deepMode = () => mode === 'deep';
const inputKinds = () => deepMode() ? ['video', ...Object.keys(REPLACEMENTS).filter(kind => replacements[kind])] : ['video', 'photo', 'voice'];
const LANGUAGES = [{ id: 'zh', name: '中文' }, { id: 'en', name: '英语' }, { id: 'ms', name: '马来语' }];
const languageName = code => LANGUAGES.find(item => item.id === code)?.name || code || '待识别';
const displayMessage = value => String(value || '').replace(/IndexTTS2/gi, '配音服务').replace(/Wan\s*3\.0/gi, 'qiya-3.0');
const labels = { draft: '等待提交', reserving: '正在预留积分', preparing: '正在自动分析字幕与人声', reviewing: '正在审核人物素材', submitting: '正在提交生成', running: '正在替换人物', downloading: '正在保存成片', verifying: '正在核对台词与开口时间', settling: '正在确认积分', completed: '复刻完成', failed: '生成失败', waiting: '处理暂停', cancelled: '已停止处理', expired: '已过期' };
const taskLabel = task => [WAN3_MODEL, WAN3_FAST_MODEL].includes(task.model) && task.status === 'reviewing' ? '正在准备参考素材' : task.mode === 'deep' && task.status === 'running' ? '正在生成深度复刻' : task.mode === 'deep' && task.status === 'reviewing' ? '正在审核参考素材' : task.mode === 'deep' && task.status === 'verifying' && !task.replacements?.voice ? '正在合成原视频声音' : task.status === 'queued' ? '排队等待生成' : task.status === 'preparing' && ['en', 'ms'].includes(task.targetLanguage) && !task.languageRouting
  ? '正在识别原视频语言' : task.languageRouting?.translate && task.status === 'preparing'
  ? '正在翻译台词并生成配音' : task.languageRouting?.translate && task.status === 'verifying'
  ? '正在按译后配音同步口型' : task.voiceConversionProgress?.preserveBackground && !task.voiceConversionProgress.separationReady && task.status === 'preparing'
  ? '正在分离人声与背景声' : task.voiceConversionProgress?.preserveBackground && task.status === 'verifying'
  ? '正在合成新声音与原背景声' : task.voiceEngine === 'chatterbox' && task.status === 'preparing'
  ? '正在保留原声节奏并转换音色' : task.voiceEngine === 'chatterbox' && task.status === 'verifying'
  ? '正在合成人物画面与目标声音' : task.voiceEngine === 'seedance' && task.sourceAudioMode === 'silent' && task.status === 'preparing'
  ? '正在将原视频语音转为台词' : task.voiceEngine === 'indextts2' && task.status === 'verifying'
  ? task.narrationProgress?.ready ? '正在同步口型与参考配音' : '正在完成参考声音配音'
  : task.voiceEngine === 'indextts2' && task.status === 'running' && !task.narrationProgress?.ready
    ? '正在替换人物并生成参考配音' : task.segments && task.status === 'downloading'
    ? '正在保存并拼接分段成片' : task.status === 'cleaning'
    ? task.subtitleRemoval?.stage === 'queued' ? '排队等待字幕与水印清理'
      : task.subtitleRemoval?.stage === 'processing' ? `正在全屏清理字幕与水印（${Number(task.subtitleRemoval.progress) || 0}%）`
        : task.subtitleRemoval?.stage === 'downloading' ? '正在保存清理后的成片' : '正在全屏清理字幕与水印'
    : labels[task.status] || '正在处理';
// One whole sentence per seam reason, so each is localized as a unit.
function segmentText(task) {
  if (!task.segments) return '';
  const total = task.segments.total, seam = Number(Number(task.segments.seam).toFixed(2));
  if (task.mode === 'deep' && !task.replacements?.voice) return `分 ${total} 段生成，整条保留原视频声音`;
  if (total > 2) return `分 ${total} 段生成，整条统一换声`;
  if (task.segments.boundary === 'scene') return `分 ${total} 段生成 · 第 ${seam} 秒接续（镜头切换处），整条统一换声`;
  if (task.segments.boundary === 'pause') return `分 ${total} 段生成 · 第 ${seam} 秒接续（说话停顿处），整条统一换声`;
  return `分 ${total} 段生成 · 第 ${seam} 秒接续（按生成时长切分），整条统一换声`;
}
const pending = task => task && !['draft', 'completed', 'failed', 'expired', 'waiting', 'cancelled'].includes(task.status);
let state = { owner: null, config: null, tasks: [], current: null, model: DEFAULT_MODEL, files: {}, urls: {}, busy: false, error: '', pollError: '', loading: true };
let context, timer, polling = false, unsubscribeCredits;
let selectedMaterials = {};
const assetUploads = new WeakMap();
function resetFiles() { for (const url of Object.values(state.urls)) if (url.startsWith('blob:')) URL.revokeObjectURL(url); state.files = {}; state.urls = {}; selectedMaterials = {}; }
function account() {
  const owner = globalThis.workspaceUser?.id || 'local-dev';
  if (state.owner !== owner) {
    for (const draft of Object.values(modeDrafts)) for (const url of Object.values(draft.urls)) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    modeDrafts = {}; mode = 'classic'; editMode = 'standard'; replacements = emptyReplacements();
    resetFiles(); state = { owner, config: null, tasks: [], current: null, model: DEFAULT_MODEL, files: {}, urls: {}, busy: false, error: '', pollError: '', loading: true };
  }
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
  if (task.mode === 'deep') { replacements = { ...task.replacements }; editMode = task.editMode || 'standard'; }
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
  const message = displayMessage(task?.canRecheck ? task.error?.replace('请核对素材后重新生成。', '请重新检查成片。') : task?.error);
  return message ? `${message}${task.code ? `（错误码：${task.code}）` : ''}` : displayMessage(task?.recovery?.message);
}
function actionMessage() {
  if (state.pollError) return `${displayMessage(state.pollError)} 正在重新连接，已有任务进度已保留。`;
  if (state.error) return displayMessage(state.error);
  if (Object.values(state.files).some(file => assetUploads.get(file)?.pending)) return '正在保存素材到资产库…';
  if (state.busy) return '';
  if (state.current?.status === 'queued') return '任务已进入队列，轮到后自动生成，无需重复提交。';
  if (state.current?.error || state.current?.recovery) return failureMessage(state.current);
  if (state.current?.status === 'cleaning') return `${taskLabel(state.current)}，无需框选，请稍候。`;
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
function modelName(task) {
  const name = (task.model === 'fal-ai/pixverse/swap' ? 'PixVerse Swap' : MODELS.find(model => model.id === (task.model || DEFAULT_MODEL))?.name) || '';
  return name + (task.editMode === 'enhanced' ? ' · 视频编辑增强 2.0' : '');
}
function modelPicker(ctx) {
  const selected = selectedModel(), locked = state.busy || state.current && state.current.status !== 'draft';
  const wan3 = [WAN3_MODEL, WAN3_FAST_MODEL].includes(selected.id), minimax = selected.id === MINIMAX_MODEL;
  const enhancedSupported = selected.id.startsWith('doubao-seedance-');
  const fast = wan3 ? `<div class="replica-fast-option"><label for="replica-wan3-fast"><input id="replica-wan3-fast" type="checkbox" aria-describedby="replica-wan3-fast-hint" ${selected.fast ? 'checked' : ''} ${locked || !state.config?.models?.find(model => model.id === WAN3_FAST_MODEL)?.enabled ? 'disabled' : ''}>快速版</label><span id="replica-wan3-fast-hint">选择快速版后生成速度加快，但是积分消耗增加50%</span></div>` : '';
  const price = generationPrice('video', selected.id);
  const description = minimax ? '768P · 每段按原片时长选择生成4或15秒 · 输入、输出视频各0.5元/秒；前5张图片免费，超出每张0.20元' : price ? `单段最多 ${selected.maxDuration} 秒，RM ${price.rmPerSecond}/秒（${price.pointsPerSecond} 积分/秒）` : '历史版本，仅供查看已有成片';
  const automatic = selected.extendedDuration ? `<p class="replica-model-description">${ctx.esc(`自动识别原视频时长，超过 ${selected.maxDuration} 秒自动分段，支持整条最长 ${selected.extendedDuration} 秒。`)}</p>` : '';
  const editing = deepMode() ? `<div class="replica-model-setting"><label for="replica-edit-mode">编辑方式</label><select id="replica-edit-mode" class="replica-models" aria-describedby="replica-edit-hint" ${locked || !state.config?.enabled ? 'disabled' : ''}><option value="standard" ${editMode === 'standard' ? 'selected' : ''}>标准复刻</option><option value="enhanced" ${editMode === 'enhanced' ? 'selected' : ''} ${state.config?.enhancedEditing === false || !enhancedSupported ? 'disabled' : ''}>Seedance 视频编辑增强 2.0</option></select><p id="replica-edit-hint" class="replica-model-description">${!enhancedSupported ? '视频编辑增强 2.0 可在 qiya-2.0、2.5、2.0-f1、20-m1 下使用。' : editMode === 'enhanced' ? '根据替换内容自动选择编辑模板，保留原视频动作与镜头。' : '使用当前复刻流程，可切换增强版对比效果。'}</p></div>` : '';
  return `${editing}<div class="replica-model-setting"><label for="replica-models">生成版本</label><select id="replica-models" class="replica-models" aria-describedby="replica-model-description" ${locked || !state.config?.enabled ? 'disabled' : ''}>${!MODELS.some(model => model.id === selected.id) ? `<option value="${ctx.esc(selected.id)}" selected disabled>${ctx.esc(selected.name)}（历史版本）</option>` : ''}${MODELS.filter(model => !model.fast && !(deepMode() && editMode === 'enhanced' && !model.id.startsWith('doubao-seedance-'))).map(model => {
    const configured = state.config?.models?.find(item => item.id === model.id);
    const unavailable = !state.config?.enabled || configured?.enabled === false || [WAN3_MODEL, MINIMAX_MODEL].includes(model.id) && !configured?.enabled;
    return `<option value="${model.id}" ${selected.id === model.id || selected.fast && model.id === WAN3_MODEL ? 'selected' : ''} ${unavailable ? 'disabled' : ''}>${ctx.esc(model.name)}</option>`;
  }).join('')}</select>${fast}<p id="replica-model-description" class="replica-model-description" title="${ctx.esc(minimax ? '按输入视频与生成视频的时长分别计费' : MALAYSIAN_PRICE_NOTE)}">${ctx.esc(description)}</p>${automatic}</div>`;
}
function slot(kind, ctx) {
  const video = kind === 'video', voice = kind === 'voice', extra = ['product', 'background'].includes(kind), title = video ? '参考视频' : voice ? '声音参考' : extra ? `${REPLACEMENTS[kind]}参考图` : '目标人物照片', selected = state.files[kind] || selectedMaterials[kind];
  const saved = state.current?.[kind];
  const voiceRequired = voice && (!state.current || state.current.status === 'draft' || ['indextts2', 'chatterbox'].includes(state.current.voiceEngine) || state.current.sourceAudioMode === 'silent');
  const disabled = state.busy || pending(state.current) || state.current && state.current.status !== 'draft' && !(video && state.current.canReplaceSource) || voice && !state.config?.voiceEnabled;
  const source = state.urls[kind] || state.current?.[{ video: 'sourceVideoUrl', voice: 'sourceVoiceUrl', photo: 'sourcePhotoUrl', product: 'sourceProductUrl', background: 'sourceBackgroundUrl' }[kind]];
  const preview = source ? video
    ? `<video src="${ctx.esc(source)}" controls playsinline preload="metadata" aria-label="参考视频预览"></video>`
    : voice ? `<audio src="${ctx.esc(source)}" controls preload="metadata" aria-label="声音参考试听"></audio>`
      : `<img src="${ctx.esc(source)}" alt="${title}预览">` : `<div class="replica-upload-symbol">${ctx.icon(video ? 'video' : voice ? 'audio' : 'image')}</div>`;
  return `<section class="replica-upload ${voice ? 'replica-voice-slot' : ''}"><div class="replica-slot-title">${deepMode() ? '' : `<span>${video ? '01' : voice ? '03' : '02'}</span>`}<h3>${t(title)}${voice ? `<small>${t(voiceRequired ? '必填' : '选填')} · ${t('更换音色')}</small>` : ''}</h3></div>
    ${voice ? voiceHint() : ''}<div class="replica-input-preview">${preview}</div>
    <strong class="replica-file-name">${ctx.esc(selected?.name || (saved?.assetId ? '已存入资产，长期保留' : saved ? '素材已上传并保存' : video ? '上传你想保留动作的视频' : voice ? '选择想使用的单人声音' : extra ? `上传想替换成的${REPLACEMENTS[kind]}` : '上传你想替换成的人物'))}</strong>
    <p>${video ? `${deepMode() ? '参考原视频动作与镜头' : '单个人物'} · 2–${selectedModel().extendedDuration || selectedModel().maxDuration} 秒 · MP4 / MOV · 上限 300 MB` : voice ? state.config && !state.config.voiceEnabled ? '换声服务尚未配置，请联系管理员。' : '清晰单人声音 · 2–15 秒 · MP3 / WAV · 最大 15 MB' : `${extra ? '清晰图片 · 宽高至少 300 像素' : '清晰正脸'} · JPG / PNG / WebP · 最大 10 MB`}</p>
    <input id="replica-${kind}" type="file" accept="${video ? 'video/mp4,video/quicktime,.mp4,.mov' : voice ? 'audio/mpeg,audio/wav,.mp3,.wav' : 'image/jpeg,image/png,image/webp'}" ${disabled ? 'disabled' : ''} aria-label="${t('上传')} ${t(title)}">
    <label for="replica-${kind}" class="secondary replica-file-button ${disabled ? 'disabled' : ''}">${t(selected || saved ? '更换' : '选择')} ${t(title)}</label>${!video && !extra ? `<a href="#assets" class="replica-asset-link" data-replica-select-${kind}>${t(voice ? '从资产选择声音' : '从资产选择形象')}</a>` : ''}</section>`;
}
function openMaterialPreview(kind, ctx) {
  const images = ['product', 'photo', 'background'].filter(key => replacements[key]).map(key => ({
    kind: key, title: key === 'photo' ? '人物' : REPLACEMENTS[key],
    source: state.urls[key] || state.current?.[{ product: 'sourceProductUrl', photo: 'sourcePhotoUrl', background: 'sourceBackgroundUrl' }[key]],
  })).filter(image => image.source);
  let index = images.findIndex(image => image.kind === kind);
  if (index < 0) return;
  ctx.openModal(t('图片预览'), '', `<section id="replica-image-preview"><div class="replica-image-stage"><button type="button" id="replica-image-prev" aria-label="${t('上一张')}" ${images.length < 2 ? 'hidden' : ''}>‹</button><img id="replica-image-full" alt=""><button type="button" id="replica-image-next" aria-label="${t('下一张')}" ${images.length < 2 ? 'hidden' : ''}>›</button></div><p id="replica-image-caption" aria-live="polite"></p></section>`);
  const root = document.querySelector('#replica-image-preview');
  const show = offset => {
    index = (index + offset + images.length) % images.length;
    const image = images[index], full = root.querySelector('#replica-image-full');
    full.src = image.source; full.alt = t(image.title);
    root.querySelector('#replica-image-caption').textContent = `${t(image.title)} · ${index + 1} / ${images.length}`;
  };
  root.querySelector('#replica-image-prev').onclick = () => show(-1);
  root.querySelector('#replica-image-next').onclick = () => show(1);
  root.onkeydown = event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); show(event.key === 'ArrowLeft' ? -1 : 1);
    }
  };
  show(0);
  if (images.length > 1) root.querySelector('#replica-image-next').focus();
}
function deepInputs(ctx) {
  const locked = state.busy || state.current && state.current.status !== 'draft';
  const cards = ['product', 'photo', 'background', 'voice'].map(kind => {
    const active = replacements[kind], selected = state.files[kind] || selectedMaterials[kind], saved = state.current?.[kind];
    const source = active && (state.urls[kind] || state.current?.[{ product: 'sourceProductUrl', photo: 'sourcePhotoUrl', background: 'sourceBackgroundUrl', voice: 'sourceVoiceUrl' }[kind]]);
    const disabled = locked || kind === 'voice' && !state.config?.voiceEnabled;
    const title = kind === 'photo' ? '人物' : REPLACEMENTS[kind];
    const name = active ? selected?.name || (saved ? '已上传' : '待添加素材') : '';
    const tile = source && kind !== 'voice'
      ? `<button type="button" id="replica-preview-${kind}" class="replica-material-tile replica-material-zoom" aria-label="放大预览${title}" title="放大预览${title}"><img src="${ctx.esc(source)}" alt="${ctx.esc(title)}参考素材"></button>${disabled ? '' : `<label for="replica-${kind}" class="replica-material-add" title="更换${title}参考素材" aria-label="更换${title}参考素材">+</label>`}`
      : `<label for="replica-${kind}" class="replica-material-tile ${disabled ? 'is-disabled' : ''}" title="${ctx.esc(selected?.name || `添加${title}参考素材`)}">${ctx.icon(kind === 'photo' ? 'avatar' : kind === 'voice' ? 'audio' : kind === 'product' ? 'store' : 'image')}<span class="replica-material-add" aria-hidden="true">+</span></label>`;
    return `<div class="replica-material ${active ? 'is-selected' : ''}"><div class="replica-material-preview"><input id="replica-${kind}" class="replica-hidden-input" type="file" accept="${kind === 'voice' ? 'audio/mpeg,audio/wav,.mp3,.wav' : 'image/jpeg,image/png,image/webp'}" ${disabled ? 'disabled' : ''} aria-label="上传${title}参考素材">${tile}<input id="replica-toggle-${kind}" class="replica-material-toggle" type="checkbox" aria-label="替换${REPLACEMENTS[kind]}" ${active ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${active ? `<button type="button" class="replica-material-remove" id="replica-remove-${kind}" aria-label="取消选择" title="取消选择" ${locked ? 'disabled' : ''}><span aria-hidden="true">×</span></button>` : ''}</div><span class="replica-material-label">${title}<small>可选</small></span><span class="replica-material-name" title="${ctx.esc(name)}">${ctx.esc(name)}</span><div class="replica-material-actions"><button type="button" data-replica-select-${kind} ${disabled ? 'disabled' : ''}>从资产库选择</button></div></div>`;
  }).join('');
  const voiceSource = replacements.voice && (state.urls.voice || state.current?.sourceVoiceUrl);
  return `<div class="replica-material-heading"><span>替换素材</span><small>已选 ${Object.values(replacements).filter(Boolean).length} / 4 项</small></div><div class="replica-materials">${cards}</div>${voiceSource ? `<audio class="replica-material-audio" src="${ctx.esc(voiceSource)}" controls preload="metadata" aria-label="声音参考试听"></audio>` : ''}${deepSource(ctx)}<button type="button" class="replica-source-library" data-replica-select-video ${locked ? 'disabled' : ''}>从资产库选择参考视频</button><p class="replica-deep-guidance">人物替换包含脸部、发型和服装，请上传能看清服装的参考图。<br>${replacements.background ? '替换背景时清除原场景中的商品和道具；如需展示商品，请同时上传商品参考图。' : '未选择的项目保留原视频内容。'}<br>沿用原片的动作、镜头和时长，自由组合替换内容。</p>`;
}
function deepSource(ctx) {
  const source = state.urls.video || state.current?.sourceVideoUrl, saved = state.current?.video;
  const disabled = state.busy || state.current && state.current.status !== 'draft' && !state.current.canReplaceSource;
  return `<section class="replica-deep-source"><input id="replica-video" class="replica-hidden-input" type="file" accept="video/mp4,video/quicktime,.mp4,.mov" ${disabled ? 'disabled' : ''} aria-label="上传参考视频"><div class="replica-source-stage ${source ? 'has-video' : ''}">${source ? `<video src="${ctx.esc(source)}" controls playsinline preload="metadata" aria-label="参考视频预览"></video><label for="replica-video" class="replica-source-replace ${disabled ? 'is-disabled' : ''}" title="更换参考视频">${ctx.icon('plus')}<span>更换</span></label>` : `<label for="replica-video" class="replica-source-empty ${disabled ? 'is-disabled' : ''}">${ctx.icon('video')}<strong>添加参考视频</strong><span>必选 · 2–${selectedModel().extendedDuration || selectedModel().maxDuration} 秒</span><small>支持 MP4、MOV · 上限 300 MB</small></label>`}</div>${source ? `<p class="replica-source-name" title="${ctx.esc(state.files.video?.name || selectedMaterials.video?.name || '参考视频')}">${ctx.esc(state.files.video?.name || selectedMaterials.video?.name || '参考视频已上传')}${saved?.duration ? `<span>${saved.duration} 秒</span>` : ''}</p>` : ''}</section>`;
}
function renderDeepReplica(ctx) {
  const task = state.current;
  return `<div class="replica-deep-studio"><section class="replica-deep-editor" aria-label="深度复刻素材与设置"><header class="replica-deep-heading"><div class="replica-deep-title">${ctx.icon('replica')}<div><h1>深度复刻</h1><p>参考动作与镜头，替换人物、商品或背景</p></div></div><button type="button" id="replica-new" class="textbutton" ${state.busy ? 'disabled' : ''}>${ctx.icon('plus')}新建</button></header><div class="replica-mode-switch" role="group" aria-label="复刻模式"><button type="button" id="replica-mode-classic" aria-pressed="false" ${state.busy ? 'disabled' : ''}>原版复刻</button><button type="button" id="replica-mode-deep" aria-pressed="true" ${state.busy ? 'disabled' : ''}>深度复刻</button></div><div class="replica-deep-inputs">${deepInputs(ctx)}</div><div class="replica-deep-settings">${modelPicker(ctx)}<div id="replica-submit-area" class="replica-submit-area">${submitArea(ctx)}</div></div></section><section class="replica-deep-preview" aria-label="深度复刻成片预览"><header class="replica-preview-heading"><h2>预览</h2><span>结果保留 3 天</span></header><div class="replica-preview-content"><div id="replica-result" class="replica-player" style="${playerStyle(task)}">${result(ctx)}</div><div id="replica-result-summary" class="replica-result-summary">${summary(ctx)}</div><div id="replica-progress" class="replica-progress" aria-live="polite">${progress(ctx)}</div></div></section><aside class="replica-deep-history" aria-label="最近的复刻"><header><h2>最近</h2><button type="button" id="replica-refresh" class="textbutton" title="刷新记录" aria-label="刷新记录">${ctx.icon('refresh')}</button></header><div id="replica-history" class="replica-history">${history(ctx)}</div></aside></div>`;
}
function switchMode(next) {
  if (state.busy || !['classic', 'deep'].includes(next) || mode === next) return;
  modeDrafts[mode] = { current: state.current, model: state.model, files: state.files, urls: state.urls, selectedMaterials, replacements, editMode };
  mode = next;
  const draft = modeDrafts[mode];
  state.current = draft?.current || null; state.model = draft?.model || DEFAULT_MODEL;
  state.files = draft?.files || {}; state.urls = draft?.urls || {};
  selectedMaterials = draft?.selectedMaterials || {}; replacements = draft?.replacements || emptyReplacements();
  editMode = draft?.editMode || 'standard';
  state.error = ''; refresh();
}
async function toggleReplacement(kind, enabled) {
  if (!deepMode() || state.busy || state.current && state.current.status !== 'draft') return;
  const next = { ...replacements, [kind]: enabled };
  const clear = () => {
    if (!enabled) {
      if (state.urls[kind]?.startsWith('blob:')) URL.revokeObjectURL(state.urls[kind]);
      delete state.files[kind]; delete state.urls[kind]; delete selectedMaterials[kind];
    }
  };
  if (!state.current) { replacements = next; clear(); state.error = ''; refresh(); return; }
  state.busy = true; state.error = ''; refresh();
  try { remember((await request(`/tasks/${state.current.id}/options`, jsonPost({ replacements: next }))).task); clear(); }
  catch (cause) { state.error = cause.message; }
  finally { state.busy = false; refresh(); }
}
async function selectEditMode(next) {
  if (!deepMode() || state.busy || state.current && state.current.status !== 'draft'
    || !['standard', 'enhanced'].includes(next) || next === 'enhanced' && [WAN3_MODEL, WAN3_FAST_MODEL].includes(selectedModel().id)) return;
  if (!state.current) { editMode = next; state.error = ''; refresh(); return; }
  state.busy = true; state.error = ''; refresh();
  try { remember((await request(`/tasks/${state.current.id}/options`, jsonPost({ editMode: next }))).task); }
  catch (cause) { state.error = cause.message; }
  finally { state.busy = false; refresh(); }
}
function generationEstimate() {
  const model = selectedModel();
  if (!MODELS.some(item => item.id === model.id)) return '';
  if ([WAN3_MODEL, WAN3_FAST_MODEL, MINIMAX_MODEL].includes(model.id)) return '<p class="replica-time-estimate">生成时间受视频时长和排队情况影响，请留意任务进度。</p>';
  return '<p class="replica-time-estimate">生成时间约为 5–10 分钟</p>';
}
function result(ctx) {
  const task = state.current;
  if (!task && deepMode()) return `<div class="replica-empty">${ctx.icon('video')}<h3>沿用原片表演，自选替换内容</h3><p>人物、声音、商品、背景可自由组合<br>上传参考视频，开启需要替换的项目</p>${generationEstimate()}<span>深度复刻成片在这里预览</span></div>`;
  if (!task) return `<div class="replica-empty">${ctx.icon('video')}<h3>原视频的表演，照片中的人物</h3><p>保留动作、镜头与说话内容<br>人物形象跟随照片，自然表达情绪</p>${generationEstimate()}<span>成片在这里预览</span></div>`;
  if (task.resultUrl) return `<video controls playsinline preload="metadata" src="${ctx.esc(task.resultUrl)}" aria-label="人物复刻成片"></video>`;
  const message = failureMessage(task);
  return `<div class="replica-empty ${pending(task) ? 'replica-working' : ''}"><div class="replica-progress-symbol">${ctx.icon(task.status === 'failed' ? 'info' : 'video')}</div><h3>${taskLabel(task)}</h3><p>${ctx.esc(message || (pending(task) ? '任务正在处理，可以离开页面，稍后回来查看。' : task.status === 'draft' ? '素材就绪后，点击一键生成。' : '请重新上传素材创建任务。'))}</p>${pending(task) || task.status === 'draft' ? generationEstimate() : ''}</div>`;
}
function progress(ctx) {
  const task = state.current;
  if (!pending(task) && task?.status !== 'waiting') return '';
  const now = Date.now(), elapsed = Math.max(0, now - (task.startedAt || task.createdAt));
  const duration = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; };
  const received = Number(task.downloadProgress?.receivedBytes), total = Number(task.downloadProgress?.totalBytes);
  const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const size = total > 0 ? ` / ${mb(total)}` : '';
  // Whole sentences, so the interface localizer can match each one.
  const saving = task.downloadProgress?.segments ? `保存第 ${task.downloadProgress.segment} / ${task.downloadProgress.segments} 段成片：${mb(received)}${size}` : `保存成片：${mb(received)}${size}`;
  const segments = task.segments && ['queued', 'submitting', 'running'].includes(task.status) ? `<p>分段生成：已提交 ${task.segments.submitted} / ${task.segments.total} 段 · 已完成 ${task.segments.completed} / ${task.segments.total} 段</p>` : '';
  const queue = task.queue?.position > 0 ? `<p>排队第 ${task.queue.position} 位，轮到后自动开始。</p>` : '';
  const download = Number.isFinite(received) && received >= 0 ? `<p>${saving}</p>${total > 0 ? `<progress aria-label="成片保存进度" max="${total}" value="${Math.min(received, total)}"></progress>` : ''}` : '';
  const voiceProgress = task.localizationProgress || task.narrationProgress;
  const narration = voiceProgress ? `<p>配音已完成 ${voiceProgress.completed} / ${voiceProgress.total} 段</p>` : '';
  return queue + `${narration}${segments}<p>已等待 ${duration(elapsed)} · ${task.status === 'queued' ? '排队等待生成' : task.status === 'waiting' ? '进度已保存' : task.lastCheckedAt ? `最近收到模型回复：${duration(now - task.lastCheckedAt)}前` : '等待模型回复'}</p>${download}
    ${state.pollError ? '<p>正在重新连接，已有任务进度已保留。</p>' : task.status !== 'queued' && pending(task) && elapsed >= 600_000 ? '<p>等待时间较长，仍在查询原任务，请勿重复提交。</p>' : ''}
    <small>任务编号：${ctx.esc(task.id)}</small>`;
}
function generationDuration(task) {
  const startedAt = task.generationStartedAt ?? task.startedAt, completedAt = task.completedAt;
  if (Number.isFinite(startedAt) && startedAt > 0 && Number.isFinite(completedAt) && completedAt >= startedAt) {
    const seconds = Math.floor((completedAt - startedAt) / 1000);
    if (seconds < 60) return `${seconds} 秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒`;
  }
  return ({ draft: '待生成', queued: '排队中', waiting: '已暂停', failed: '未完成', cancelled: '已停止' })[task.status]
    || (pending(task) ? '生成中' : '暂无记录');
}
function history(ctx) {
  if (deepMode()) return state.tasks.length ? state.tasks.map(task => `<button type="button" class="replica-history-item ${task.id === state.current?.id ? 'active' : ''}" data-replica-task="${ctx.esc(task.id)}" title="${ctx.esc(failureMessage(task))}" ${state.busy ? 'disabled' : ''}><span class="replica-history-thumb">${task.resultUrl || task.sourceVideoUrl ? `<video src="${ctx.esc(task.resultUrl || task.sourceVideoUrl)}#t=0.001" muted playsinline preload="metadata" aria-hidden="true" tabindex="-1"></video>` : ctx.icon(task.status === 'completed' ? 'video' : 'list')}</span><span class="replica-history-copy"><strong>${ctx.esc(taskLabel(task))}</strong><small>${task.mode === 'deep' ? '深度复刻' : '原版复刻'} · ${ctx.esc(modelName(task) || task.modelName || task.model || '未知模型')}</small><small class="replica-history-time">${task.status === 'draft' ? '创建时间' : '生成时间'}：${ctx.esc(new Date(task.generationStartedAt || task.startedAt || task.createdAt).toLocaleString(uiLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }))}</small><small class="replica-history-duration">生成耗时：${ctx.esc(generationDuration(task))}</small></span></button>`).join('') : '<p class="replica-muted replica-history-empty">还没有复刻记录<br>生成后会显示在这里</p>';
  return state.tasks.length ? state.tasks.map(task => `<button type="button" class="replica-history-item ${task.id === state.current?.id ? 'active' : ''}" data-replica-task="${ctx.esc(task.id)}" title="${ctx.esc(failureMessage(task))}" ${state.busy ? 'disabled' : ''}><span>${task.mode === 'deep' ? '深度复刻 · ' : ''}${ctx.esc(['waiting', 'failed'].includes(task.status) && task.error ? failureMessage(task).split('原始原因：')[0] : taskLabel(task))}</span><small>${modelName(task) ? ctx.esc(modelName(task)) + ' · ' : ''}${ctx.esc(new Date(task.createdAt).toLocaleString(uiLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))} · ${task.duration || '—'} 秒</small></button>`).join('') : '<p class="replica-muted">你的复刻记录会保存在这里</p>';
}
function summary(ctx) {
  const task = state.current;
  const route = task?.languageRouting;
  const language = route ? `<span>原视频：${ctx.esc(languageName(route.source))} · 所选语言：${ctx.esc(languageName(route.target))} · ${route.translate ? '翻译配音并同步口型' : route.reason === 'same-language' ? '语言一致，沿用原方案' : '中文沿用原方案'}</span>` : '';
  return task ? `<div><strong>${taskLabel(task)}</strong>${language}<span>${modelName(task) ? ctx.esc(modelName(task)) + ' · ' : ''}${task.actualDuration || task.duration || '—'} 秒 · ${ctx.esc(task.ratio || '自动比例')} · ${ctx.esc(task.resolution || '720p')}${billingPointsText(task) ? ` · ${ctx.esc(billingPointsText(task))}` : ''}</span>${segmentText(task) ? `<span>${ctx.esc(segmentText(task))}</span>` : ''}${task.captionCheck?.warning ? `<span>${ctx.esc(displayMessage(task.captionCheck.warning))}</span>` : ''}${task.audioCheck ? `<span>${task.audioCheck.originalAudioPreserved ? '已保留原视频声音。' : task.audioCheck.engine === 'indextts2' ? '已使用参考声音配音，并按新配音处理口型；请预览核对效果。' : task.audioCheck.warning ? ctx.esc(displayMessage(task.audioCheck.warning)) : `${task.audioCheck.transcriptDifferences ? `台词有 ${ctx.esc(task.audioCheck.transcriptDifferences)} 字轻微识别差异` : '台词一致'} · 开口偏差 ${Math.abs(task.audioCheck.afterOffsetMs)} 毫秒；请预览核对台词、音色与口型。`}</span>` : ''}</div>${task.resultUrl ? `<a class="primary replica-download" href="${ctx.esc(task.resultUrl)}?download=1" download>下载成片</a>` : ''}` : '';
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
  const conversionCost = (!deepMode() || replacements.voice) && (!task || task.status === 'draft' || task.voiceEngine === 'chatterbox') ? '；音色转换另按实际用量结算' : '';
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
  if (deepMode()) return renderDeepReplica(ctx);
  const task = state.current;
  return `<div class="replica-heading"><div><span class="replica-eyebrow">1:1复刻 · ${ctx.esc(selectedModel().name)}</span><h1>${deepMode() ? '深度复刻' : '人物 1:1 复刻'}</h1><p>${deepMode() ? '参考原视频的动作和镜头，自选替换人脸、声音、商品或背景。' : '上传一个视频和一张照片，让照片中的人物出演原视频。'}</p></div><span class="replica-badge">${deepMode() ? '按需替换' : '人物替换'}</span></div>
    <div class="replica-toolbar"><div class="replica-mode-switch" role="group" aria-label="复刻模式"><button type="button" id="replica-mode-classic" aria-pressed="${!deepMode()}" ${state.busy ? 'disabled' : ''}>原版复刻</button><button type="button" id="replica-mode-deep" aria-pressed="${deepMode()}" ${state.busy ? 'disabled' : ''}>深度复刻</button></div><button type="button" id="replica-new" class="secondary" ${state.busy ? 'disabled' : ''}>新建复刻</button></div>
    <div class="replica-layout"><section class="replica-form">${deepMode() ? deepInputs(ctx) : `<div class="replica-uploads">${slot('video', ctx)}${slot('photo', ctx)}${slot('voice', ctx)}</div>`}${modelPicker(ctx)}
      <p class="replica-note">${deepMode() ? '画面替换效果以实际生成结果为准，生成后请预览核对人脸、商品和背景。' : '请使用有权使用的视频和人物照片。人物相似度与表演效果以实际生成结果为准。'}</p>
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
    if (state.files.video || selectedMaterials.video) {
      const video = state.files.video;
      remember((await request(`/tasks/${state.current.id}/video`, selectedMaterials.video ? jsonPost({ assetId: selectedMaterials.video.id }) : { method: 'PUT', headers: { 'Content-Type': video.type || 'application/octet-stream' }, body: video })).task);
      delete state.files.video; delete selectedMaterials.video;
    }
    remember((await request(`/tasks/${state.current.id}/model`, jsonPost({ model: id }))).task);
  }
  catch (cause) { state.error = cause.message; }
  finally { state.busy = false; refresh(); }
}
async function selectFile(kind, file) {
  if (!file) return;
  const limit = kind === 'video' ? 300 : kind === 'voice' ? 15 : 10;
  if (file.size > limit * 1024 * 1024) { state.error = `文件过大，${kind === 'video' ? '视频' : kind === 'voice' ? '声音参考' : '照片'}不能超过 ${limit} MB。`; refresh(); return; }
  if (state.urls[kind]) URL.revokeObjectURL(state.urls[kind]);
  delete selectedMaterials[kind];
  state.files[kind] = file; state.urls[kind] = URL.createObjectURL(file); state.error = '';
  const owner = state.owner, upload = { pending: true, error: null };
  assetUploads.set(file, upload);
  upload.promise = uploadSharedMaterial(kind, file).catch(cause => {
    upload.error = cause;
    if (state.owner === owner && state.files[kind] === file) state.error = cause.message;
  }).finally(() => { upload.pending = false; if (state.owner === owner && state.files[kind] === file) refresh(); });
  refresh();
  await upload.promise;
  if (upload.error) return false;
  if (state.owner !== owner || state.files[kind] !== file) return;
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
  if (deepMode()) {
    for (const kind of inputKinds()) if (!state.files[kind] && !selectedMaterials[kind] && !state.current?.[kind]) {
      state.error = kind === 'video' ? '请先上传参考视频。' : `请先上传${REPLACEMENTS[kind]}参考素材。`; refresh(); return;
    }
  } else {
    if ((!state.files.video && !selectedMaterials.video && !state.current?.video) || (!state.files.photo && !selectedMaterials.photo && !state.current?.photo)) { state.error = '请先上传一段参考视频和一张人物照片。'; refresh(); return; }
    if (!state.files.voice && !selectedMaterials.voice && !state.current?.voice) { state.error = '请先上传声音参考。'; refresh(); return; }
  }
  state.busy = true; state.error = ''; refresh();
  try {
    for (const kind of inputKinds()) {
      const upload = assetUploads.get(state.files[kind]);
      await upload?.promise;
      if (upload?.error) throw upload.error;
    }
    const id = state.current?.id || crypto.randomUUID();
    const model = selectedModel().id, { voiceEngine, sourceAudioMode } = deepMode() && !replacements.voice ? { voiceEngine: 'seedance', sourceAudioMode: 'original' } : DEFAULT_VOICE;
    const deep = deepMode() ? { mode: 'deep', editMode, replacements } : {};
    // Keep the request ID before networking so an uncertain response can be retried safely.
    if (!state.current) state.current = { id, status: 'draft', createdAt: Date.now(), model, ...deep };
    remember((await request('/tasks', jsonPost({ requestId: id, model, voiceEngine, sourceAudioMode, ...deep }))).task);
    if (state.current.status === 'draft') {
      for (const kind of inputKinds()) {
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
    const inputs = () => deepMode() ? deepInputs(context) : ['video', 'photo', 'voice'].map(kind => slot(kind, context)).join('');
    const previous = { inputs: inputs(), models: modelPicker(context), result: result(context), style: playerStyle(state.current), actions: submitArea(context), history: history(context) };
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
      if (previous.history !== history(context)) document.querySelector('#replica-history').innerHTML = history(context);
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
export function useReplicaMaterial(material, kind = material.kind) {
  account();
  if (state.busy) throw new Error('素材正在提交，请完成后再选择。');
  const assetKind = ['product', 'background'].includes(kind) ? 'photo' : kind;
  if (!['photo', 'voice', 'video'].includes(assetKind) || material.kind !== assetKind || !new RegExp(`^${assetKind}-[a-f0-9]{64}$`).test(material.id)) throw new Error('素材无效。');
  if (state.current && state.current.status !== 'draft') { resetFiles(); state.current = null; }
  if (deepMode() && kind !== 'video' && !replacements[kind]) {
    if (state.current) throw new Error('请先在深度复刻草稿中开启对应的替换项目。');
    replacements = { ...replacements, [kind]: true };
  }
  if (state.urls[kind]?.startsWith('blob:')) URL.revokeObjectURL(state.urls[kind]);
  delete state.files[kind]; selectedMaterials[kind] = material;
  state.urls[kind] = `/api/assets/materials/${material.id}/media`; state.error = ''; refresh();
}
export function bindVideoReplica(ctx) {
  context = ctx;
  if (!unsubscribeCredits) unsubscribeCredits = subscribeWorkspaceCredits(refreshCredits);
  document.querySelector('#replica-models').onchange = event => { void selectModel(event.target.value); };
  const editing = document.querySelector('#replica-edit-mode');
  if (editing) editing.onchange = event => { void selectEditMode(event.target.value); };
  const fast = document.querySelector('#replica-wan3-fast');
  if (fast) fast.onchange = event => { void selectModel(event.target.checked ? WAN3_FAST_MODEL : WAN3_MODEL); };
  for (const kind of deepMode() ? ['video', ...Object.keys(REPLACEMENTS)] : inputKinds()) document.querySelector(`#replica-${kind}`).onchange = async event => {
    const file = event.target.files[0];
    if (!file || state.busy) return;
    if (deepMode() && kind !== 'video' && !replacements[kind]) {
      await toggleReplacement(kind, true);
      if (!replacements[kind]) return;
    }
    await selectFile(kind, file);
  };
  for (const next of ['classic', 'deep']) document.querySelector(`#replica-mode-${next}`).onclick = () => switchMode(next);
  if (deepMode()) for (const kind of Object.keys(REPLACEMENTS)) document.querySelector(`#replica-toggle-${kind}`).onchange = event => { void toggleReplacement(kind, event.target.checked); };
  for (const kind of ['video', ...Object.keys(REPLACEMENTS)]) {
    const preview = document.querySelector(`#replica-preview-${kind}`);
    if (preview) preview.onclick = () => openMaterialPreview(kind, ctx);
    const remove = document.querySelector(`#replica-remove-${kind}`);
    if (remove) remove.onclick = () => { void toggleReplacement(kind, false); };
    const select = document.querySelector(`[data-replica-select-${kind}]`);
    if (select) select.onclick = event => {
      event.preventDefault();
      if (state.busy || state.current && state.current.status !== 'draft') return;
      void openReplicaAssetPicker(ctx, kind, async choice => {
        if (deepMode() && kind !== 'video' && !replacements[kind]) {
          await toggleReplacement(kind, true);
          if (!replacements[kind]) throw new Error(state.error || '请先开启对应的替换项目。');
        }
        if (choice.material) useReplicaMaterial(choice.material, kind);
        else if (await selectFile(kind, choice.file) === false) throw new Error(state.error);
      });
    };
  }
  const retry = document.querySelector('#replica-recheck'); if (retry) retry.onclick = () => { void recheck(); };
  const resume = document.querySelector('#replica-resume'); if (resume) resume.onclick = () => { void recoverTask('resume'); };
  const cancel = document.querySelector('#replica-cancel'); if (cancel) cancel.onclick = () => { void recoverTask('cancel'); };
  document.querySelector('#replica-submit').onclick = () => { void submit(); };
  document.querySelector('#replica-new').onclick = () => { resetFiles(); state.current = null; state.model = DEFAULT_MODEL; editMode = 'standard'; replacements = emptyReplacements(); state.error = ''; refresh(); };
  document.querySelector('#replica-refresh').onclick = () => { state.error = ''; state.pollError = ''; void poll(); };
  document.querySelector('#replica-history').onclick = event => {
    const button = event.target.closest('[data-replica-task]'); if (!button || state.busy) return;
    const task = state.tasks.find(task => task.id === button.dataset.replicaTask); if (!task) return;
    switchMode(task.mode === 'deep' ? 'deep' : 'classic');
    resetFiles(); state.current = task; replacements = task.replacements ? { ...task.replacements } : emptyReplacements(); editMode = task.editMode || 'standard'; state.model = task.model || DEFAULT_MODEL; state.error = ''; refresh();
  };
  if (!timer) { void poll(); timer = setInterval(() => { void poll(); }, 5000); }
}
export function disposeVideoReplica() { clearInterval(timer); timer = null; context = null; unsubscribeCredits?.(); unsubscribeCredits = null; }
