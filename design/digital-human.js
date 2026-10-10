import { digitalHumanApi as api } from './digital-human-api.js';
import { accountStorageKey } from './account-storage.js';

import { videoPoints, estimatedSpeechSeconds, videoCreditEstimateText, creditInsufficiency, refreshWorkspaceCredits, subscribeWorkspaceCredits, observeCreditTask, billingPointsText } from './workspace-credits.js';
let unsubscribeCredits = null;
const speechEstimate = () => estimatedSpeechSeconds(state.script, state.toneProfile === 'high' ? 1.2 : 1);
const STORAGE_KEY = accountStorageKey('store-studio:digital-human:v1');
const state = {
  hydrated: false, loaded: false, loading: false, status: null, session: null,
  avatars: [], voices: [], tasks: [], avatarId: '', voiceId: '', activeTaskId: '',
  script: '', toneProfile: 'low', videoFit: 'smart', emotionIntensity: 0.8, engine: 'b',
  errors: {}, upload: null, submitting: false, busy: new Set(),
  pollError: '',
  library: { kind: 'all', items: [], nextCursor: null, hasMore: false, total: 0, counts: { all: 0, avatars: 0, tasks: 0 }, loading: false, loaded: false, error: '' },
};
let root = null;
let context = null;
let pollTimer = null;
let polling = false;
let binding = null;
let libraryObserver = null;
let viewVersion = 0;
let libraryVersion = 0;
const cardMarkupCache = new Map();
const isCurrentView = version => version === viewVersion && root?.isConnected;

const currentAvatar = () => state.avatars.find(item => item.id === state.avatarId);
const currentVoice = () => state.voices.find(item => item.id === state.voiceId);
const currentTask = () => state.tasks.find(item => item.id === state.activeTaskId);
const running = task => task && ['pending', 'processing'].includes(task.status);
const hasRunningTask = () => state.tasks.some(running);
const safeUrl = value => api.safeMediaUrl(value || '');
const shortDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const duration = value => {
  const seconds = Math.round(Number(value));
  return Number.isFinite(seconds) && seconds > 0 ? `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}` : '视频形象';
};
const refreshIcon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 3 M18 17a7 7 0 0 1-12 1l-2-3"/></svg>';
const taskLabel = task => task?.status === 'completed' && task.results?.deliveryMode === 'narration_fallback' ? '基础配音视频' : ({ pending: '等待处理', processing: '正在制作', completed: '已完成', failed: '制作失败' })[task?.status] || '等待开始';
const stepLabel = step => ({ idle: '等待处理', voice: '制作口播配音', prepare: '准备形象视频', check: '准备口型画面', render: '合成口型', finalize: '整理成片', done: '视频已完成', error: '本次制作未完成' })[step] || '正在处理';
const errorMessage = error => error?.status === 401 ? '登录状态已失效，请重新登录数字人服务后重试。' : error?.message || '暂时无法连接数字人服务，请稍后重试。';

function persist(ctx = context) {
  if (ctx?.configs?.avatar) ctx.configs.avatar.prompt = state.script;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      script: state.script, avatarId: state.avatarId, voiceId: state.voiceId, activeTaskId: state.activeTaskId,
      toneProfile: state.toneProfile, videoFit: state.videoFit, emotionIntensity: state.emotionIntensity, engine: state.engine,
      emotionReferenceVersion: 1,
    }));
  } catch { /* Editing and generating still work when local storage is unavailable. */ }
}

function hydrate(ctx) {
  if (!state.hydrated) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const key of ['script', 'avatarId', 'voiceId', 'activeTaskId']) if (typeof saved[key] === 'string') state[key] = saved[key];
      if (['low', 'high'].includes(saved.toneProfile)) state.toneProfile = saved.toneProfile;
      if (['smart', 'preserve'].includes(saved.videoFit)) state.videoFit = saved.videoFit;
      if (['a', 'b', 'c'].includes(saved.engine)) state.engine = saved.engine;
      if (saved.emotionReferenceVersion === 1 && Number.isFinite(saved.emotionIntensity)) state.emotionIntensity = Math.max(0.1, Math.min(0.85, saved.emotionIntensity));
    } catch { /* Ignore an invalid browser draft. */ }
    state.script = (ctx.configs.avatar.prompt || state.script).slice(0, 5000);
    ctx.configs.avatar.prompt = state.script;
    state.hydrated = true;
  } else if (ctx.configs.avatar.prompt !== state.script) {
    state.script = String(ctx.configs.avatar.prompt || '').slice(0, 5000);
    persist(ctx);
  }
}

function uploadControl(ctx, kind, className, label) {
  const { icon, esc } = ctx;
  const busy = Boolean(state.upload);
  return `<label class="${className} dh-upload-label ${busy ? 'is-disabled' : ''}" ${busy ? 'aria-disabled="true"' : ''}>${icon('plus')}<span>${esc(label)}</span><input type="file" data-dh-upload="${kind}" aria-label="${kind === 'avatar' ? '上传口播形象视频' : '上传参考声音'}" accept="${kind === 'avatar' ? '.mp4,.mov,.webm,.mkv,.m4v' : '.mp3,.wav,.m4a,.aac,.mp4,.mov'}" ${busy ? 'disabled' : ''}></label>`;
}

function inlineError(ctx, text, section) {
  return `<div class="dh-inline-error" role="alert"><span>${ctx.esc(text)}</span>${ctx.button('dh-reload', '重新加载', 'dh-link-button', `data-section="${section}"`)}</div>`;
}

function statusMarkup(ctx) {
  if (state.errors.session || state.errors.status) return `<span class="dh-service-state is-offline"><i></i>连接异常</span>${ctx.button('dh-reload', '重试', 'dh-link-button')}`;
  if (!state.status) return `<span class="dh-service-state"><i></i>正在连接服务</span>`;
  return `<span class="dh-service-state ${state.status.ready ? 'is-ready' : ''}"><i></i>${state.status.ready ? '生成服务已就绪' : '生成服务待配置'}</span>${!state.status.ready ? ctx.button('dh-reload', '刷新状态', 'dh-link-button') : ''}`;
}


function materialsMarkup(ctx) {
  const avatar = currentAvatar(), cover = safeUrl(avatar?.coverUrl);
  return `<div class="dh-field-heading"><label>出镜形象</label></div>${avatar ? `<div class="dh-selected-avatar"><button class="dh-selected-avatar-cover" data-action="dh-preview-media" data-kind="avatar" data-id="${ctx.esc(avatar.id)}" aria-label="预览形象：${ctx.esc(avatar.name)}">${cover ? `<img src="${ctx.esc(cover)}" alt="" loading="lazy">` : ctx.icon('avatar')}<span class="dh-cover-play">${ctx.icon('play')}</span></button><div class="dh-selected-avatar-copy"><strong>${ctx.esc(avatar.name)}</strong><small>${duration(avatar.durationSeconds)} · 已选中</small>${ctx.button('dh-browse-avatars', '更换形象', 'dh-link-button')}</div></div><div class="dh-avatar-bottom">${uploadControl(ctx, 'avatar', 'dh-small-upload', '上传新形象')}</div>` : `${uploadControl(ctx, 'avatar', 'dh-avatar-upload', '上传口播视频')}<div class="dh-avatar-guidance"><p>正面清晰的口播视频</p></div>${ctx.button('dh-browse-avatars', ctx.icon('folder') + '从素材库选择', 'dh-browse-button')}`}<p class="dh-upload-note">MP4 / MOV 等视频，最大 500 MB</p><div id="dh-upload-progress">${uploadProgress(ctx, 'avatar')}</div>`;
}

function libraryTabsMarkup(ctx) {
  return [['all', '全部'], ['avatars', '视频形象'], ['tasks', '生成作品']].map(([key, label]) => `<button data-action="dh-library-tab" data-kind="${key}" id="dh-tab-${key}" role="tab" aria-controls="dh-library-grid" aria-selected="${state.library.kind === key}" class="${state.library.kind === key ? 'active' : ''}">${label}<span>${Number(state.library.counts[key]) || 0}</span></button>`).join('');
}

function libraryItemMarkup(entry, ctx) {
  const { esc, icon, button } = ctx;
  if (entry.kind === 'avatar') {
    const item = state.avatars.find(value => value.id === entry.id) || entry.avatar;
    if (!item) return '';
    const cover = safeUrl(item.coverUrl), selected = item.id === state.avatarId;
    return `<article class="dh-library-card ${selected ? 'is-selected' : ''}" data-library-key="avatar:${esc(item.id)}"><button class="dh-card-media" data-action="dh-preview-media" data-kind="avatar" data-id="${esc(item.id)}" aria-label="预览视频形象：${esc(item.name)}">${cover ? `<img src="${esc(cover)}" alt="${esc(item.name)}" loading="lazy" decoding="async">` : `<span class="dh-card-placeholder">${icon('avatar')}<small>视频形象</small></span>`}<span class="dh-card-kind">视频形象</span><span class="dh-card-play">${icon('play')}</span><span class="dh-card-duration">${duration(item.durationSeconds)}</span>${selected ? `<span class="dh-card-selected">${icon('check')}已选中</span>` : ''}</button><div class="dh-card-copy"><strong title="${esc(item.name)}">${esc(item.name)}</strong><small>${shortDate(item.createdAt)}${item.width && item.height ? ` · ${item.width} × ${item.height}` : ''}</small></div><div class="dh-card-actions">${button('dh-select-avatar', selected ? '已选中形象' : '使用此形象', 'dh-card-use', `data-id="${esc(item.id)}" aria-pressed="${selected}"`)}${item.canManage !== false ? `${button('dh-rename-avatar', '改名', 'dh-card-icon', `data-id="${esc(item.id)}" aria-label="重命名形象"`)}${button('dh-delete-avatar', icon('trash'), 'dh-card-icon dh-delete-link', `data-id="${esc(item.id)}" aria-label="删除形象" title="删除"`)}` : ''}</div></article>`;
  }
  const task = state.tasks.find(value => value.id === entry.id) || entry.task;
  if (!task) return '';
  const avatar = state.avatars.find(value => value.id === task.inputs?.avatarId || value.id === task.avatarId);
  const cover = safeUrl(task.results?.coverUrl || task.coverUrl || avatar?.coverUrl);
  const title = task.inputs?.scriptText?.trim().slice(0, 60) || task.inputs?.videoName || '口播视频';
  const hasVideo = task.status === 'completed' && safeUrl(task.results?.finalVideoUrl);
  const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
  return `<article class="dh-library-card dh-task-card" data-library-key="task:${esc(task.id)}"><button class="dh-card-media ${running(task) ? 'is-processing' : ''}" data-action="${hasVideo ? 'dh-preview-media' : 'dh-task-details'}" data-kind="task" data-id="${esc(task.id)}" aria-label="${hasVideo ? '播放作品' : '查看制作记录'}：${esc(title)}">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async">` : `<span class="dh-card-placeholder">${icon(task.status === 'completed' ? 'video' : 'avatar')}<small>${task.status === 'completed' ? '口播作品' : '口播制作'}</small></span>`}<span class="dh-card-kind">生成作品</span><span class="dh-card-status ${esc(task.status)}">${taskLabel(task)}</span>${hasVideo ? `<span class="dh-card-play">${icon('play')}</span>` : running(task) ? `<span class="dh-card-progress"><strong>${progress}%</strong><small>${stepLabel(task.step)}</small><progress value="${progress}" max="100" aria-label="制作进度"></progress></span>` : task.status === 'failed' ? '<span class="dh-card-failure">查看失败原因</span>' : ''}</button><div class="dh-card-copy"><strong title="${esc(title)}">${esc(title)}</strong><small>${shortDate(task.createdAt)} · ${esc(task.results?.resolution || taskLabel(task))}</small></div><div class="dh-card-actions">${button('dh-reuse-task', '复用文案', 'dh-card-use', `data-id="${esc(task.id)}"`)}${hasVideo ? `<a class="dh-card-icon" href="${esc(api.downloadUrl(task, 'video'))}" download aria-label="下载口播视频" title="下载">${icon('save')}</a>` : ''}${!running(task) ? button('dh-delete-task', icon('trash'), 'dh-card-icon dh-delete-link', `data-id="${esc(task.id)}" aria-label="删除作品记录" title="删除"`) : ''}</div></article>`;
}

function libraryStateMarkup(ctx) {
  const library = state.library;
  if (library.error) return `<div class="dh-library-message is-error" role="alert"><p>${ctx.esc(library.error)}</p>${ctx.button('dh-library-more', '重新加载', 'dh-outline-button')}</div>`;
  if (library.loading || !library.loaded) return `<div class="dh-library-message" role="status"><span class="dh-loading-dot"></span>${library.items.length ? '正在加载更多…' : '正在读取素材和作品…'}</div>`;
  if (!library.items.length) {
    const text = library.kind === 'tasks' ? ['还没有生成作品', ''] : ['暂无视频形象', ''];
    return `<div class="dh-library-empty">${ctx.icon(library.kind === 'tasks' ? 'video' : 'folder')}<strong>${text[0]}</strong>${library.kind !== 'tasks' ? uploadControl(ctx, 'avatar', 'dh-outline-button', '上传第一个视频形象') : ctx.button('dh-scroll-generator', '开始准备口播', 'dh-outline-button')}</div>`;
  }
  return library.hasMore ? `<div class="dh-library-message">${ctx.button('dh-library-more', '加载更多', 'dh-outline-button')}</div>` : '<div class="dh-library-message dh-library-end">已经看到全部内容了</div>';
}
function uploadProgress(ctx, kind) {
  const item = state.upload;
  if (!item || item.kind !== kind) return '';
  return `<div class="dh-upload-progress" role="status"><div><span>${item.percent >= 100 ? '正在保存素材…' : '正在上传'}</span><strong>${Math.round(item.percent)}%</strong></div><progress max="100" value="${item.percent}" aria-label="上传进度"></progress></div>`;
}

function taskMarkup(ctx) {
  const task = currentTask();
  if (!task || task.status === 'completed') return state.pollError ? inlineError(ctx, state.pollError, 'tasks') : '';
  const { esc, button, icon } = ctx;
  const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
  const failed = task.status === 'failed';
  return `<div class="dh-task-status ${failed ? 'is-failed' : ''}" aria-live="polite"><div class="dh-task-status-line"><span>${icon(task.status === 'completed' ? 'check' : 'video')}<strong>${stepLabel(task.step)}</strong></span><small>${running(task) ? `${progress}%` : taskLabel(task)}</small></div>${running(task) ? `<progress value="${progress}" max="100" aria-label="制作进度"></progress>` : ''}${failed ? `<p>${esc(task.error || '生成服务未完成本次任务，请调整素材或稍后重试。')}</p>` : ''}${state.pollError ? `<p>${esc(state.pollError)}</p>${button('dh-poll-retry', '重新获取进度', 'dh-link-button')}` : ''}<div class="dh-task-links">${task.status === 'completed' && safeUrl(task.results?.finalVideoUrl) ? `<a class="dh-download-link" href="${esc(api.downloadUrl(task, 'video'))}" download>${icon('save')}下载视频</a>` : ''}${task.status === 'completed' && safeUrl(task.results?.exactAudioUrl) ? `<a class="dh-link-button" href="${esc(api.downloadUrl(task, 'audio'))}" download>下载配音</a>` : ''}${failed && task.recoverable ? button('dh-recover-task', '继续获取成片', 'dh-link-button', `data-id="${esc(task.id)}" ${state.busy.has(task.id) ? 'disabled' : ''}`) : ''}${button('dh-task-details', '任务详情', 'dh-link-button', `data-id="${esc(task.id)}"`)}</div></div>`;
}

function voiceMarkup(ctx) {
  const { esc, icon, button } = ctx;
  const voice = currentVoice();
  return `<div class="dh-field-heading"><label for="dh-voice-select">口播声音</label>${button('dh-manage-voices', '管理声音', 'dh-link-button')}</div>${state.errors.voices ? inlineError(ctx, state.errors.voices, 'voices') : ''}<div class="dh-voice-field"><span class="studio-voice-icon">${icon('audio')}</span><select id="dh-voice-select" data-dh-option="voiceId" aria-label="选择口播声音"><option value="">${state.voices.some(item => safeUrl(item.audioUrl)) ? '选择一个声音' : '先上传一段参考声音'}</option>${state.voices.map(item => `<option value="${esc(item.id)}" ${item.id === state.voiceId ? 'selected' : ''} ${safeUrl(item.audioUrl) ? '' : 'disabled'}>${esc(item.name)}${safeUrl(item.audioUrl) ? '' : '（待配置）'}</option>`).join('')}</select></div><div id="dh-voice-preview">${voicePreview(ctx, voice)}</div>${uploadControl(ctx, 'voice', 'dh-add-voice', '上传参考声音')}<p class="dh-voice-hint">建议 5–15 秒清晰人声，支持音频或视频</p><div id="dh-voice-upload-progress">${uploadProgress(ctx, 'voice')}</div>`;
}

function voicePreview(ctx, voice = currentVoice()) {
  const url = safeUrl(voice?.audioUrl);
  return url ? `<audio controls preload="none" src="${ctx.esc(url)}" aria-label="试听${ctx.esc(voice.name)}"></audio>` : '';
}

function engineMarkup(ctx) {
  const engines = Array.isArray(state.status?.engines) ? state.status.engines : [];
  return `<option value="">${state.status ? '选择生成方案' : '正在读取生成方案'}</option>${engines.map(item => `<option value="${ctx.esc(item.id)}" ${item.id === state.engine ? 'selected' : ''} ${item.available ? '' : 'disabled'}>${ctx.esc(item.label)}${item.available ? '' : '（待配置）'}</option>`).join('')}`;
}

function generateHint() {
  if (state.errors.session || state.errors.status) return '服务连接异常，请先重试';
  if (!state.status) return '正在连接生成服务';
  if (!state.status.ready) return '生成服务待配置';
  if (state.submitting) return '正在提交，请稍候';
  if (hasRunningTask()) return '当前视频正在制作，请等待完成';
  if (state.upload) return '请等待素材上传完成';
  if (!currentAvatar()) return '先添加并选择一个视频形象';
  if (!safeUrl(currentVoice()?.audioUrl)) return '请选择可用的口播声音';
  if (!state.script.trim()) return '请填写口播文案';
  if (state.script.length > 5000) return '口播稿请控制在 5000 字以内';
  if (!state.status.engines?.some(item => item.id === state.engine && item.available)) return '请选择可用的生成方案';
  return creditInsufficiency(videoPoints(speechEstimate()));
}


export function renderDigitalHuman(ctx) {
  hydrate(ctx);
  const { icon, esc, button, storeInfo } = ctx;
  const hint = generateHint();
  return `<header class="studio-header"><div class="studio-heading"><span class="studio-mode-icon">${icon('avatar')}</span><div><h1>数字人口播</h1></div></div><div class="studio-header-actions">${button('store', icon('store') + `<span>${esc(storeInfo.name || '商家资料')}</span>`, 'studio-text-button')}${button('prompts', icon('list') + '<span>我的草稿</span>', 'studio-quiet-button')}${button('dh-save-draft', icon('save') + '<span>保存草稿</span>', 'studio-quiet-button')}</div></header>
  <div class="dh-workspace">
    <section class="dh-generator" id="dh-generator" aria-labelledby="dh-generator-title">
      <div class="dh-generator-heading"><div><h2 id="dh-generator-title">制作口播视频</h2></div><span class="dh-generator-type">${icon('avatar')}视频数字人</span></div>
      <div class="dh-composer"><div class="dh-avatar-setting" id="dh-materials">${materialsMarkup(ctx)}</div><div class="dh-composer-main">${ctx.renderBusinessEntry?.('avatar') || ''}<div class="dh-field-heading"><label for="dh-script">口播文案</label></div><div class="dh-script-box"><textarea id="dh-script" maxlength="5000" placeholder="填写口播文案">${esc(state.script)}</textarea><div><span id="dh-script-duration">${state.script.trim() ? `约 ${Math.max(1, Math.round(state.script.replace(/\s/g, '').length / 4))} 秒口播` : ''}</span><small id="dh-script-count">${state.script.length} / 5000</small></div></div><div class="dh-script-ideas"><span>宣传方案</span>${button('dh-template', '使用方案口播稿', '', 'data-template="brief"')}${button('business-open', '重新整理宣传信息', '', 'data-mode="avatar"')}</div><section id="dh-voice" class="dh-voice-section" aria-label="口播声音">${voiceMarkup(ctx)}</section></div></div>
      <details class="dh-advanced"><summary>${icon('settings')}高级设置${icon('chevron')}</summary><div class="dh-advanced-body"><label class="studio-field">生成方案<select id="dh-engine" data-dh-option="engine">${engineMarkup(ctx)}</select></label><label class="studio-field">语速<select data-dh-option="toneProfile"><option value="low" ${state.toneProfile === 'low' ? 'selected' : ''}>自然（1.0×）</option><option value="high" ${state.toneProfile === 'high' ? 'selected' : ''}>提速（1.2×）</option></select></label><label class="studio-field">视频适配<select data-dh-option="videoFit"><option value="smart" ${state.videoFit === 'smart' ? 'selected' : ''}>智能适配</option><option value="preserve" ${state.videoFit === 'preserve' ? 'selected' : ''}>保留原视频</option></select></label><div class="dh-emotion-field"><label class="dh-emotion-label" for="dh-emotion">表达强度<output id="dh-emotion-value">${Math.round(state.emotionIntensity * 100)}%</output></label><input id="dh-emotion" data-dh-option="emotionIntensity" type="range" min="0.1" max="0.85" step="0.05" value="${state.emotionIntensity}" aria-label="表达强度"><div class="dh-range-labels"><span>平稳</span><span>鲜明</span></div></div></div></details>
      <footer class="dh-generate-footer"><div class="dh-generation-note"><div id="dh-service-status">${statusMarkup(ctx)}</div><p id="dh-credit-estimate" class="credit-estimate">${esc(videoCreditEstimateText(speechEstimate()))}</p><p id="dh-generate-hint">${esc(hint || '')}</p></div>${button('dh-generate', icon('star') + '<span>生成口播视频</span>', 'studio-primary', hint ? `disabled title="${esc(hint)}"` : '')}</footer><div id="dh-task-status">${taskMarkup(ctx)}</div>
    </section>
    <section class="dh-library" id="dh-library" aria-labelledby="dh-library-title"><div class="dh-library-heading"><div><h2 id="dh-library-title">我的创作</h2><p>成品保留 3 天，请及时下载</p></div><div class="dh-library-tools">${uploadControl(ctx, 'avatar', 'dh-outline-button', '上传视频')}${button('dh-library-refresh', refreshIcon, 'dh-refresh-button', 'aria-label="刷新素材和作品" title="刷新素材和作品"')}</div></div><div class="dh-library-tabs" id="dh-library-tabs" role="tablist" aria-label="素材与作品分类">${libraryTabsMarkup(ctx)}</div><div class="dh-library-grid" id="dh-library-grid" role="tabpanel" aria-labelledby="dh-tab-${state.library.kind}">${state.library.items.map(item => libraryItemMarkup(item, ctx)).join('')}</div><div id="dh-library-state">${libraryStateMarkup(ctx)}</div><div class="dh-library-sentinel" id="dh-library-sentinel" aria-hidden="true"></div></section>
  </div>`;
}

function setRegion(id, markup) {
  const node = root?.querySelector(`#${id}`);
  if (node && node.innerHTML !== markup) node.innerHTML = markup;
}

function patchGenerate() {
  if (!root?.isConnected || !context) return;
  const hint = generateHint();
  const button = root.querySelector('[data-action="dh-generate"]');
  if (button) {
    button.disabled = Boolean(hint); button.title = hint;
    button.querySelector('span').textContent = state.submitting ? '正在提交…' : '生成口播视频';
  }
  const note = root.querySelector('#dh-generate-hint');
  if (note) note.textContent = hint || '';
  const estimate = root.querySelector('#dh-credit-estimate');
  if (estimate) estimate.textContent = videoCreditEstimateText(speechEstimate());
  setRegion('dh-service-status', statusMarkup(context));
}

function patchLibrary() {
  if (!root?.isConnected || !context) return;
  setRegion('dh-library-tabs', libraryTabsMarkup(context));
  const grid = root.querySelector('#dh-library-grid');
  grid.setAttribute('aria-labelledby', `dh-tab-${state.library.kind}`);
  grid.setAttribute('aria-busy', String(state.library.loading));
  const keys = new Set();
  state.library.items.forEach(entry => {
    const key = `${entry.kind}:${entry.id}`;
    keys.add(key);
    const markup = libraryItemMarkup(entry, context);
    const existing = Array.from(grid.children).find(node => node.dataset.libraryKey === key);
    if (!existing) grid.insertAdjacentHTML('beforeend', markup);
    else if (cardMarkupCache.get(key) !== markup) existing.outerHTML = markup;
    cardMarkupCache.set(key, markup);
  });
  Array.from(grid.children).forEach(node => {
    if (!keys.has(node.dataset.libraryKey)) { cardMarkupCache.delete(node.dataset.libraryKey); node.remove(); }
  });
  state.library.items.forEach((entry, index) => {
    const node = Array.from(grid.children).find(item => item.dataset.libraryKey === `${entry.kind}:${entry.id}`);
    if (node && grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
  });
  setRegion('dh-library-state', libraryStateMarkup(context));
  observeLibrary();
}

function patchTask() {
  if (!root?.isConnected || !context) return;
  setRegion('dh-task-status', taskMarkup(context));
  patchLibrary();
  patchGenerate();
}

function patchCollections() {
  if (!root?.isConnected || !context) return;
  setRegion('dh-materials', materialsMarkup(context));
  setRegion('dh-voice', voiceMarkup(context));
  setRegion('dh-engine', engineMarkup(context));
  patchTask();
}

function normalizeSelections(libraryOnly = false) {
  if (!currentAvatar()) state.avatarId = state.avatars[0]?.id || '';
  if (!libraryOnly) {
    if (!state.errors.voices && !safeUrl(currentVoice()?.audioUrl)) {
      const availableVoices = state.voices.filter(item => safeUrl(item.audioUrl));
      state.voiceId = (availableVoices.find(item => item.isDefault) || availableVoices[0])?.id || '';
    }
    if (!state.errors.status && !state.status?.engines?.some(item => item.id === state.engine && item.available)) state.engine = state.status?.engines?.find(item => item.available)?.id || '';
  }
  if (!currentTask()) state.activeTaskId = state.tasks.find(running)?.id || '';
  persist();
}

function mergeItem(collection, item) {
  if (!item?.id) return;
  if (collection === 'tasks') observeCreditTask(item);
  const index = state[collection].findIndex(value => value.id === item.id);
  if (index === -1) state[collection].push(item); else state[collection][index] = item;
}

function applyLibraryPage(page, reset, requestedSelection) {
  // A refreshed page is authoritative; preserve only a choice changed during this request.
  const newerAvatar = requestedSelection && state.avatarId !== requestedSelection.avatarId ? currentAvatar() : null;
  const newerTask = requestedSelection && state.activeTaskId !== requestedSelection.taskId ? currentTask() : null;
  if (reset) { state.avatars = []; state.tasks = []; }
  for (const task of page.activeTasks || []) mergeItem('tasks', task);
  if (page.selection?.avatar) mergeItem('avatars', page.selection.avatar);
  if (page.selection?.task) mergeItem('tasks', page.selection.task);
  const next = reset ? [] : [...state.library.items];
  for (const entry of page.items || []) {
    if (entry.avatar) mergeItem('avatars', entry.avatar);
    if (entry.task) mergeItem('tasks', entry.task);
    const index = next.findIndex(item => item.id === entry.id && item.kind === entry.kind);
    if (index === -1) next.push(entry); else next[index] = entry;
  }
  if (newerAvatar) mergeItem('avatars', newerAvatar);
  if (newerTask) mergeItem('tasks', newerTask);
  state.library.items = next;
  state.library.nextCursor = page.nextCursor || null;
  state.library.hasMore = Boolean(page.hasMore && page.nextCursor);
  state.library.total = Number(page.total) || 0;
  state.library.counts = page.counts || state.library.counts;
  state.library.loaded = true;
}

async function loadLibrary(reset = false) {
  if (!root?.isConnected || state.library.loading && !reset) return;
  const version = viewVersion, request = ++libraryVersion;
  const requestedSelection = { avatarId: state.avatarId, taskId: state.activeTaskId };
  if (reset) { state.library.items = []; state.library.nextCursor = null; state.library.hasMore = false; state.library.loaded = false; }
  state.library.loading = true; state.library.error = '';
  patchLibrary();
  try {
    const page = await api.listLibrary({ kind: state.library.kind, limit: 12, ...(!reset && state.library.nextCursor ? { cursor: state.library.nextCursor } : {}), ...(state.avatarId ? { avatarId: state.avatarId } : {}), ...(state.activeTaskId ? { taskId: state.activeTaskId } : {}) });
    if (!isCurrentView(version) || request !== libraryVersion) return;
    applyLibraryPage(page, reset, requestedSelection);
    normalizeSelections(true);
  } catch (error) {
    if (!isCurrentView(version) || request !== libraryVersion) return;
    state.library.error = errorMessage(error);
  } finally {
    if (isCurrentView(version) && request === libraryVersion) {
      state.library.loading = false;
      setRegion('dh-materials', materialsMarkup(context));
      patchTask(); schedulePoll();
    }
  }
}

function observeLibrary() {
  libraryObserver?.disconnect();
  const sentinel = root?.querySelector('#dh-library-sentinel');
  if (!sentinel || !state.library.hasMore || state.library.loading || state.library.error || !('IntersectionObserver' in window)) return;
  libraryObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && !state.library.loading && state.library.hasMore && !state.library.error) void loadLibrary();
  }, { root: null, rootMargin: '400px 0px', threshold: 0 });
  libraryObserver.observe(sentinel);
}

async function loadData() {
  if (state.loading) return;
  const version = viewVersion;
  state.loading = true; state.errors = {};
  try {
    const session = await api.getSession();
    if (!isCurrentView(version)) return;
    const userKey = value => value?.data?.user?.id || value?.data?.user?.email || value?.data?.authMode || '';
    if (state.session && userKey(state.session) !== userKey(session)) {
      state.avatars = []; state.voices = []; state.tasks = [];
      state.avatarId = ''; state.voiceId = ''; state.activeTaskId = '';
      state.library.items = []; state.library.counts = { all: 0, avatars: 0, tasks: 0 };
      state.status = null; clearTimeout(pollTimer);
      patchCollections();
    }
    state.session = session;
  }
  catch (error) {
    if (!isCurrentView(version)) return;
    state.session = null; state.avatars = []; state.voices = []; state.tasks = [];
    state.errors.session = errorMessage(error); state.errors.voices = state.errors.session;
    state.library.items = []; state.library.error = state.errors.session; state.library.hasMore = false;
    state.status = null; state.loading = false; state.loaded = true;
    clearTimeout(pollTimer); patchCollections(); return;
  }
  if (!isCurrentView(version)) return;
  const results = await Promise.allSettled([api.getStatus(), api.listVoices(), loadLibrary(true)]);
  if (!isCurrentView(version)) return;
  ['status', 'voices'].forEach((key, index) => {
    if (results[index].status === 'fulfilled') state[key] = results[index].value;
    else { state.errors[key] = errorMessage(results[index].reason); if (key === 'status') state.status = null; }
  });
  state.loaded = true; state.loading = false; state.pollError = '';
  normalizeSelections(); patchCollections(); schedulePoll();
}

function upsertTask(task) {
  mergeItem('tasks', task);
  const entry = state.library.items.find(item => item.kind === 'task' && item.id === task?.id);
  if (entry) entry.task = task;
}

function schedulePoll(delay = 2500) {
  clearTimeout(pollTimer);
  if (!root?.isConnected || !hasRunningTask() || state.pollError) return;
  pollTimer = setTimeout(pollTasks, delay);
}

async function pollTasks() {
  if (polling || !root?.isConnected) return;
  const version = viewVersion;
  polling = true;
  const ids = state.tasks.filter(running).map(task => task.id);
  const results = await Promise.allSettled(ids.map(id => api.getTask(id)));
  if (!isCurrentView(version)) return;
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') upsertTask(result.value);
    else {
      state.pollError = errorMessage(result.reason);
      if (result.reason?.status === 404) state.tasks = state.tasks.filter(task => task.id !== ids[index]);
    }
  });
  polling = false; patchTask(); schedulePoll();
}

function updateScript(value, ctx = context) {
  state.script = value.slice(0, 5000); persist(ctx);
  if (!root?.isConnected) return;
  const textarea = root.querySelector('#dh-script');
  if (textarea && textarea.value !== state.script) textarea.value = state.script;
  root.querySelector('#dh-script-count').textContent = `${state.script.length} / 5000`;
  root.querySelector('#dh-script-duration').textContent = state.script.trim() ? `约 ${Math.max(1, Math.round(state.script.replace(/\s/g, '').length / 4))} 秒口播` : '';
  patchGenerate();
}

async function uploadFile(kind, file, ctx) {
  if (!file || state.upload) return;
  const version = viewVersion;
  const limit = (kind === 'avatar' ? 500 : 50) * 1024 * 1024;
  const video = file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name);
  const audio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac)$/i.test(file.name);
  if (!(kind === 'avatar' ? video : video || audio)) return ctx.toast(kind === 'avatar' ? '请选择口播视频文件，照片不能用于这个形象流程。' : '请选择音频或带人声的视频文件。');
  if (!file.size || file.size > limit) return ctx.toast(`文件应大于 0 且不超过 ${kind === 'avatar' ? 500 : 50} MB。`);
  state.upload = { kind, percent: 0 };
  patchCollections();
  const onProgress = value => {
    if (!state.upload) return;
    const percent = typeof value === 'number' ? value : value?.percent ?? (value?.total ? value.loaded / value.total * 100 : 0);
    state.upload.percent = Math.max(0, Math.min(100, Number(percent) || 0));
    if (isCurrentView(version)) setRegion(kind === 'avatar' ? 'dh-upload-progress' : 'dh-voice-upload-progress', uploadProgress(context, kind));
  };
  try {
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || (kind === 'avatar' ? '我的形象' : '我的声音');
    const item = kind === 'avatar' ? await api.createAvatar(file, { name, onProgress }) : await api.createVoice(file, { name, onProgress });
    if (!isCurrentView(version)) return;
    if (kind === 'avatar') {
      state.avatars.unshift(item);
      state.avatarId = item.id;
    } else {
      state.voices.unshift(item);
      state.voiceId = item.id;
    }
    delete state.errors[kind === 'avatar' ? 'avatars' : 'voices'];
    persist(ctx);
    ctx.toast(kind === 'avatar' ? '视频形象已保存，可以继续填写口播稿。' : '参考声音已保存并选中。');
    if (kind === 'avatar') await loadLibrary(true);
  } catch (error) {
    ctx.toast(errorMessage(error));
  } finally {
    state.upload = null;
    if (isCurrentView(version)) patchCollections();
  }
}

export function bindDigitalHuman(ctx) {
  binding?.abort();
  binding = new AbortController();
  viewVersion += 1;
  cardMarkupCache.clear();
  context = ctx;
  unsubscribeCredits?.(); unsubscribeCredits = subscribeWorkspaceCredits(patchGenerate);
  root = document.querySelector('.avatar-studio');
  if (!root) return;
  root.addEventListener('input', event => {
    if (event.target.id === 'dh-script') updateScript(event.target.value, ctx);
    if (event.target.dataset.dhOption === 'emotionIntensity') {
      state.emotionIntensity = Number(event.target.value);
      root.querySelector('#dh-emotion-value').textContent = `${Math.round(state.emotionIntensity * 100)}%`;
      persist(ctx);
    }
  }, { signal: binding.signal });
  root.addEventListener('change', event => {
    const input = event.target;
    if (input.dataset.dhUpload) {
      const file = input.files?.[0];
      input.value = '';
      void uploadFile(input.dataset.dhUpload, file, ctx);
    }
    const option = input.dataset.dhOption;
    if (['voiceId', 'toneProfile', 'videoFit', 'engine'].includes(option)) {
      state[option] = input.value;
      persist(ctx);
      if (option === 'voiceId') setRegion('dh-voice-preview', voicePreview(ctx));
      patchGenerate();
    }
  }, { signal: binding.signal });
  void loadData();
}

export function disposeDigitalHuman() {
  unsubscribeCredits?.(); unsubscribeCredits = null;
  viewVersion += 1; libraryVersion += 1;
  libraryObserver?.disconnect(); libraryObserver = null;
  state.loading = false; state.library.loading = false; polling = false;
  cardMarkupCache.clear();
  clearTimeout(pollTimer);
  binding?.abort();
  binding = null;
  root = null;
  context = null;
}


const fallbackNotice = task => task.results?.deliveryMode === 'narration_fallback' ? '<p class="dh-modal-script">已保留原画面并配上本次声音，未调整口型，本次免扣积分。</p>' : '';

function showMedia(kind, id, ctx) {
  const item = (kind === 'avatar' ? state.avatars : state.tasks).find(value => value.id === id);
  if (!item) return;
  const url = safeUrl(kind === 'avatar' ? item.videoUrl : item.results?.finalVideoUrl);
  if (!url) { if (kind === 'task') showTaskDetails(id, ctx); return; }
  const title = kind === 'avatar' ? item.name : '口播作品';
  const cover = kind === 'avatar' ? safeUrl(item.coverUrl) : '';
  ctx.openModal(title, kind === 'avatar' ? '原始视频形象 · 可重复用于新的口播内容' : `${shortDate(item.createdAt)} · ${taskLabel(item)}`, `${fallbackNotice(item)}<div class="dh-modal-video"><video controls playsinline preload="metadata" src="${ctx.esc(url)}" ${cover ? `poster="${ctx.esc(cover)}"` : ''} aria-label="${ctx.esc(title)}"></video></div>${kind === 'task' ? `<p class="dh-modal-script">${ctx.esc(item.inputs?.scriptText || '').replace(/\n/g, '<br>')}</p>` : ''}<footer class="modal-actions">${ctx.button('cancel', '关闭', 'secondary')}${kind === 'avatar' ? ctx.button('dh-use-preview-avatar', '使用此形象', 'primary', `data-id="${ctx.esc(id)}"`) : `<a class="primary dh-modal-download" href="${ctx.esc(api.downloadUrl(item, 'video'))}" download>${ctx.icon('save')}下载视频</a>${ctx.button('dh-task-details', '任务详情', 'secondary', `data-id="${ctx.esc(id)}"`)}`}</footer>`, true);
  const dialog = document.querySelector('dialog[open]'), video = dialog?.querySelector('video');
  dialog?.addEventListener('close', () => { if (video) { video.pause(); video.removeAttribute('src'); video.load(); } }, { once: true });
}
function scrollGenerator() { root?.querySelector('#dh-generator')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

function closeModal() {
  document.querySelector('dialog[open]')?.close();
}

function templateText(kind, ctx) {
  if (kind !== 'brief') return '';
  const script = ctx.configs.avatar.contentPlan?.script;
  return typeof script === 'string' ? script : '';
}

function showTemplate(kind, ctx) {
  const script = templateText(kind, ctx);
  if (!script) {
    ctx.openBusinessFlow?.({ mode: 'avatar' });
    return;
  }
  if (!state.script.trim()) {
    updateScript(script, ctx);
    root?.querySelector('#dh-script')?.focus();
    return;
  }
  ctx.openModal('使用宣传方案口播稿', '根据已填写的商家信息整理。请核对内容；替换前也可返回保存当前草稿。', `<div class="studio-template-preview">${ctx.esc(script).replace(/\n/g, '<br>')}</div><footer class="modal-actions">${ctx.button('cancel', '保留原文', 'secondary')}${ctx.button('dh-confirm-template', '替换口播稿', 'primary', `data-template="${ctx.esc(kind)}"`)}</footer>`);
}

function showVoices(ctx) {
  ctx.openModal('我的声音', '', `<div class="dh-voice-library">${state.voices.length ? state.voices.map(voice => `<div class="dh-library-voice"><div><strong>${ctx.esc(voice.name)}</strong><span>${voice.isDefault ? '默认声音' : '我的参考声音'}</span></div>${safeUrl(voice.audioUrl) ? `<audio controls preload="none" src="${ctx.esc(safeUrl(voice.audioUrl))}" aria-label="试听${ctx.esc(voice.name)}"></audio>` : '<p class="muted">此声音尚未配置</p>'}<div class="dh-library-voice-actions">${ctx.button('dh-select-voice', voice.id === state.voiceId ? '已选中' : '使用这个声音', 'secondary', `data-id="${ctx.esc(voice.id)}" ${safeUrl(voice.audioUrl) ? '' : 'disabled'}`)}${voice.canManage !== false && !voice.isDefault ? ctx.button('dh-delete-voice', '删除', 'dh-link-button dh-delete-link', `data-id="${ctx.esc(voice.id)}"`) : ''}</div></div>`).join('') : '<p class="muted">还没有参考声音，请在口播内容中上传一段音频。</p>'}</div><footer class="modal-actions">${ctx.button('cancel', '完成', 'primary')}</footer>`);
}

function confirmDelete(kind, id, ctx) {
  const collections = { avatar: state.avatars, voice: state.voices, task: state.tasks };
  const item = collections[kind].find(value => value.id === id);
  if (!item) return;
  const name = { avatar: '视频形象', voice: '参考声音', task: '作品记录及文件' }[kind];
  ctx.openModal(`删除${name}`, kind === 'task' ? '删除后无法恢复，请先下载需要保留的成片。' : '删除后，这份素材将从库中移除。', `<p class="dh-confirm-copy">${ctx.esc(item.name || item.inputs?.scriptText?.slice(0, 60) || name)}</p><footer class="modal-actions">${ctx.button('cancel', '保留', 'secondary')}${ctx.button(`dh-confirm-delete-${kind}`, '确认删除', 'primary', `data-id="${ctx.esc(id)}"`)}</footer>`);
}

async function deleteItem(kind, id, ctx) {
  if (state.busy.has(id)) return;
  const version = viewVersion;
  state.busy.add(id);
  try {
    await ({ avatar: api.deleteAvatar, voice: api.deleteVoice, task: api.deleteTask })[kind](id);
    if (!isCurrentView(version)) return;
    const key = { avatar: 'avatars', voice: 'voices', task: 'tasks' }[kind];
    state[key] = state[key].filter(item => item.id !== id);
    state.library.items = state.library.items.filter(item => !(item.kind === kind && item.id === id));
    normalizeSelections();
    closeModal();
    patchCollections();
    if (kind !== 'voice') await loadLibrary(true);
    ctx.toast('已删除。');
  } finally {
    state.busy.delete(id);
  }
}

function renameAvatar(id, ctx) {
  const avatar = state.avatars.find(item => item.id === id);
  if (!avatar) return;
  const version = viewVersion;
  ctx.openModal('重命名视频形象', '', `<form id="dh-rename-form"><label class="field">形象名称<input name="name" required maxlength="80" value="${ctx.esc(avatar.name)}" autocomplete="off"></label><p id="dh-rename-error" class="dh-form-error" role="alert"></p><footer class="modal-actions">${ctx.button('cancel', '取消', 'secondary', 'type="button"')}<button class="primary" type="submit">保存名称</button></footer></form>`);
  document.querySelector('#dh-rename-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    const name = new FormData(form).get('name').trim();
    if (!name || state.busy.has(id)) return;
    state.busy.add(id);
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const updated = await api.renameAvatar(id, name);
      if (!isCurrentView(version)) return;
      state.avatars = state.avatars.map(item => item.id === id ? updated : item);
      closeModal();
      patchCollections();
      ctx.toast('形象名称已更新。');
    } catch (error) {
      form.querySelector('#dh-rename-error').textContent = errorMessage(error);
    } finally {
      state.busy.delete(id);
      button.disabled = false;
    }
  });
}

function showTaskDetails(id, ctx) {
  const task = state.tasks.find(item => item.id === id);
  if (!task) return;
  const completed = task.status === 'completed';
  const video = completed && safeUrl(task.results?.finalVideoUrl);
  const audio = completed && safeUrl(task.results?.exactAudioUrl);
  ctx.openModal('口播任务详情', `${shortDate(task.createdAt)} · ${taskLabel(task)}`, `<div class="dh-task-detail">${fallbackNotice(task)}${billingPointsText(task) ? `<p class="credit-estimate">${ctx.esc(billingPointsText(task))}</p>` : ''}${audio ? `<h3>口播配音</h3><audio controls preload="none" src="${ctx.esc(audio)}" aria-label="试听生成的口播配音"></audio>` : ''}<h3>口播文案</h3><p>${ctx.esc(task.inputs?.scriptText || '').replace(/\n/g, '<br>')}</p>${task.error ? `<div class="dh-inline-error">${ctx.esc(task.error)}</div>` : ''}<h3>处理记录</h3><ol>${(task.logs || []).slice(-12).map(log => `<li><time>${new Date(log.timestamp).toLocaleTimeString('zh-CN')}</time><span>${ctx.esc(log.message)}</span></li>`).join('') || '<li>任务已登记，暂时没有处理记录。</li>'}</ol></div><footer class="modal-actions">${ctx.button('cancel', '关闭', 'secondary')}${audio ? `<a class="secondary dh-modal-download" href="${ctx.esc(api.downloadUrl(task, 'audio'))}" download>下载配音</a>` : ''}${video ? `<a class="secondary dh-modal-download" href="${ctx.esc(api.downloadUrl(task, 'video'))}" download>下载视频</a>` : ''}${task.status === 'failed' && task.recoverable ? ctx.button('dh-recover-task', '继续获取成片', 'secondary', `data-id="${ctx.esc(id)}" ${state.busy.has(id) ? 'disabled' : ''}`) : ''}${ctx.button('dh-reuse-task', '复用这份文案', 'primary', `data-id="${ctx.esc(id)}"`)}</footer>`, true);
  const dialog = document.querySelector('dialog[open]'), player = dialog?.querySelector('audio');
  dialog?.addEventListener('close', () => { if (player) { player.pause(); player.removeAttribute('src'); player.load(); } }, { once: true });
}

async function generateTask(ctx) {
  const hint = generateHint();
  if (hint) return ctx.toast(hint);
  const version = viewVersion;
  state.submitting = true;
  patchGenerate();
  try {
    const task = await api.createTask({ avatarId: state.avatarId, speakerVoiceId: state.voiceId, scriptText: state.script.trim(), toneProfile: state.toneProfile, videoFit: state.videoFit, emotionIntensity: state.emotionIntensity, engine: state.engine });
    if (!isCurrentView(version)) return;
    upsertTask(task);
    state.activeTaskId = task.id;
    state.pollError = '';
    persist(ctx);
    ctx.toast('口播任务已提交，可在下方作品库查看进度。');
    state.library.kind = 'tasks'; await loadLibrary(true);
    schedulePoll(1500);
  } finally {
    void refreshWorkspaceCredits({ afterCurrent: true });
    state.submitting = false;
    if (isCurrentView(version)) patchTask();
  }
}

async function actionAsync(action, el, ctx) {
  const id = el.dataset.id;
  const version = viewVersion;
  if (action === 'dh-generate') await generateTask(ctx);
  else if (action === 'dh-reload') { void refreshWorkspaceCredits(); await loadData(); }
  else if (action === 'dh-library-more') await loadLibrary(!state.library.loaded);
  else if (action === 'dh-library-refresh') await loadLibrary(true);
  else if (action === 'dh-library-tab') {
    if (state.library.kind === el.dataset.kind) return;
    state.library.kind = el.dataset.kind;
    await loadLibrary(true);
  } else if (action === 'dh-browse-avatars') {
    state.library.kind = 'avatars';
    const loading = loadLibrary(true);
    root?.querySelector('#dh-library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    await loading;
  }
  else if (action === 'dh-poll-retry') {
    state.pollError = '';
    await pollTasks();
  } else if (action === 'dh-recover-task') {
    if (state.busy.has(id)) return;
    state.busy.add(id);
    patchTask();
    try {
      const task = await api.recoverTask(id);
      if (!isCurrentView(version)) return;
      upsertTask(task);
      state.activeTaskId = id;
      state.pollError = '';
      persist(ctx);
      closeModal();
      schedulePoll(1500);
    } finally {
      state.busy.delete(id);
      if (isCurrentView(version)) patchTask();
    }
  } else if (action.startsWith('dh-confirm-delete-')) await deleteItem(action.replace('dh-confirm-delete-', ''), id, ctx);
}

export function handleDigitalHumanAction(action, el, ctx) {
  if (!action.startsWith('dh-')) return false;
  if (action === 'dh-save-draft') { persist(ctx); ctx.saveDraft(); }
  else if (action === 'dh-select-avatar' || action === 'dh-use-preview-avatar') {
    state.avatarId = el.dataset.id;
    persist(ctx);
    if (action === 'dh-use-preview-avatar') closeModal();
    patchCollections();
    scrollGenerator();
  } else if (action === 'dh-preview-media') showMedia(el.dataset.kind, el.dataset.id, ctx);
  else if (action === 'dh-scroll-generator') scrollGenerator();
  else if (action === 'dh-template') showTemplate(el.dataset.template, ctx);
  else if (action === 'dh-confirm-template') { const script = templateText(el.dataset.template, ctx); if (script) updateScript(script, ctx); closeModal(); }
  else if (action === 'dh-manage-voices') showVoices(ctx);
  else if (action === 'dh-select-voice') {
    if (!safeUrl(state.voices.find(item => item.id === el.dataset.id)?.audioUrl)) return true;
    state.voiceId = el.dataset.id;
    persist(ctx);
    closeModal();
    setRegion('dh-voice', voiceMarkup(ctx));
    patchGenerate();
  } else if (action === 'dh-rename-avatar') renameAvatar(el.dataset.id, ctx);
  else if (['dh-delete-avatar', 'dh-delete-voice', 'dh-delete-task'].includes(action)) confirmDelete(action.replace('dh-delete-', ''), el.dataset.id, ctx);
  else if (action === 'dh-task-details') showTaskDetails(el.dataset.id, ctx);
  else if (action === 'dh-reuse-task') {
    const task = state.tasks.find(item => item.id === el.dataset.id);
    if (task) ctx.openModal('复用口播文案', '将替换当前编辑中的口播稿，形象和声音保持当前选择。', `<div class="studio-template-preview">${ctx.esc(task.inputs?.scriptText || '').replace(/\n/g, '<br>')}</div><footer class="modal-actions">${ctx.button('cancel', '返回', 'secondary')}${ctx.button('dh-confirm-reuse', '填入文案', 'primary', `data-id="${ctx.esc(task.id)}"`)}</footer>`);
  } else if (action === 'dh-confirm-reuse') {
    const task = state.tasks.find(item => item.id === el.dataset.id);
    if (task) updateScript(task.inputs?.scriptText || '', ctx);
    closeModal(); scrollGenerator();
  } else {
    const version = viewVersion;
    void actionAsync(action, el, ctx).catch(error => { if (isCurrentView(version)) ctx.toast(errorMessage(error)); });
  }
  return true;
}
