import { accountStorageKey } from './account-storage.js';
import { displayModelName, brandModelText } from './model-labels.js';
import { validatePhotoSelection, preparePhotoBatches } from './image-upload.js';
import { imageTaskTitle } from './image-presets.js';
import { imagePoints, creditEstimateText, creditInsufficiency, refreshWorkspaceCredits, subscribeWorkspaceCredits, observeCreditTask, billingPointsText } from './workspace-credits.js';
let unsubscribeCredits = null;
const API = '/api/ai';
const PENDING_KEY = accountStorageKey('store-ai-pending-image-request');
const UPLOAD_KEY = accountStorageKey('store-ai-image-upload-draft');
const ACTIVE = new Set(['queued', 'running']);
const QUALITY_NAMES = { auto: '自动', low: '快速', medium: '标准', high: '精细' };
const GENERATION_MODES = {
  single: { label: '单张图片', hint: '基于你的原图，生成一张宣传图片。' },
  series: { label: '统一风格套图', hint: '围绕同一主题，生成色彩与排版统一的一组图片。' },
  variations: { label: '同主题多风格', hint: '围绕同一主题，生成不同视觉风格，方便比较和挑选。' },
};
const state = { status: null, statusError: '', tasks: [], loaded: false, loading: false, submitting: false, error: '', submissionError: '', pendingId: readPending(), uploadDraft: readUploadDraft(), uploadProgress: null, uploadController: null, timer: null, expiryTimer: null, lastRead: 0, ctx: null };

function readUploadDraft() { try { const value = JSON.parse(sessionStorage.getItem(UPLOAD_KEY) || 'null'); return /^[\da-f-]{36}$/i.test(value?.id || '') && Number.isInteger(value.imageCount) && value.imageCount > 0 && value.imageCount <= 30 ? value : null; } catch { return null; } }
function rememberUpload(value) { state.uploadDraft = value; try { if (value) sessionStorage.setItem(UPLOAD_KEY, JSON.stringify(value)); else sessionStorage.removeItem(UPLOAD_KEY); } catch { /* The server retains the upload progress. */ } }
function fingerprints(files) { return files.map(file => [file?.name, file?.size, file?.type, file?.lastModified || 0]); }
function sameUploadFiles(files, draft = state.uploadDraft) { return !!draft && JSON.stringify(fingerprints(files)) === JSON.stringify(draft.fingerprints); }
function completeUpload(ctx) { const files = selectedImages(ctx); return !!state.uploadDraft && state.uploadDraft.uploadedCount === state.uploadDraft.imageCount && (!files.length || sameUploadFiles(files.map(item => item.file))); }

function readPending() { try { const id = sessionStorage.getItem(PENDING_KEY); return /^[\da-f-]{36}$/i.test(id || '') ? id : null; } catch { return null; } }
function rememberPending(id) { state.pendingId = id; try { if (id) sessionStorage.setItem(PENDING_KEY, id); else sessionStorage.removeItem(PENDING_KEY); } catch { /* The server still preserves accepted tasks. */ } }
function pageIsActive() { return typeof document !== 'undefined' && document.body.dataset.page === 'image'; }
function selectedImages(ctx) { return ctx.configs.image.files.map(id => ctx.assets.find(asset => asset.id === id)).filter(Boolean); }
export function imageQualityName(value) { return QUALITY_NAMES[value] || QUALITY_NAMES.auto; }
export function imageGenerationSettings(config = {}) {
  const generationMode = Object.hasOwn(GENERATION_MODES, config.generationMode) ? config.generationMode : 'single';
  const count = Number(config.count);
  return { generationMode, outputCount: generationMode === 'single' ? 1 : Number.isInteger(count) && count >= 2 && count <= 15 ? count : 6 };
}
export function imageGenerationLabel(config = {}) {
  const { generationMode, outputCount } = imageGenerationSettings(config);
  return generationMode === 'series' ? `生成${outputCount}张套图` : generationMode === 'variations' ? `生成${outputCount}张不同风格` : '立即生成图片';
}
export function renderImageGenerationOptions(ctx) {
  const { generationMode, outputCount } = imageGenerationSettings(ctx.configs.image);
  const { esc, button } = ctx;
  const locked = state.submitting || !!state.pendingId || state.tasks.some(task => ACTIVE.has(task.status));
  const counts = [...(outputCount < 6 ? [outputCount] : []), ...Array.from({ length: 10 }, (_, index) => index + 6)];
  return `<section class="image-generation-options" aria-label="生成方式与图片数量"><fieldset class="image-mode-options"><legend>生成方式</legend><div>${Object.entries(GENERATION_MODES).map(([mode, item]) => button('image-generation-mode', esc(item.label), `image-mode-option${generationMode === mode ? ' selected' : ''}`, `data-value="${mode}" aria-pressed="${generationMode === mode}" ${locked ? 'disabled' : ''}`)).join('')}</div></fieldset><div class="image-output-settings"><label class="image-count-options">图片数量 ${generationMode === 'single' ? '<span class="image-single-count">1 张</span>' : `<select id="image-output-count" aria-label="生成图片数量" ${locked ? 'disabled' : ''}>${counts.map(count => `<option value="${count}" ${outputCount === count ? 'selected' : ''}>${count} 张</option>`).join('')}</select>`}</label><span class="image-quota-estimate">${esc(creditEstimateText(imagePoints(outputCount)))}</span></div></section>`;
}
export function validateImageRequest(prompt, images, maxLength = 1000) {
  if (!prompt.trim()) return '填写想要生成的画面或修改要求。';
  if (prompt.length > maxLength) return `创作要求最多 ${maxLength} 字，请缩短后继续。`;
  if (!images.length) return '添加至少 1 张原图后开始创作。';
  if (images.some(asset => !asset.file)) return '有原图已失效，请移除后重新上传。';
  return validatePhotoSelection(images.map(asset => asset.file));
}
export function safeImageResultUrl(value, origin = globalThis.location?.origin) {
  try { const url = new URL(value, origin); return url.origin === origin && /^\/api\/ai\/media\/[\da-f-]+\/[\w.-]+$/i.test(url.pathname) && !url.search && !url.hash ? url.pathname : ''; } catch { return ''; }
}
function shortError(value) { return brandModelText(String(value || '暂时无法获取任务状态，请稍后刷新。').replace(/sk-[a-z\d_-]+/ig, '[已隐藏]')).slice(0, 240); }
function dateLabel(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function visibleTasks() { return state.tasks.filter(task => task.status !== 'expired' && (!task.expiresAt || Date.parse(task.expiresAt) > Date.now())); }
function taskCounts(task) {
  const count = Number(task.outputCount);
  const total = Number.isInteger(count) && count >= 1 && count <= 15 ? count : Math.max(1, task.images?.length || 0);
  const completed = Number.isInteger(task.completedCount) ? task.completedCount : task.images?.length || 0;
  return { total, completed: Math.max(0, Math.min(total, completed)) };
}
function statusLabel(task) {
  const { total, completed } = taskCounts(task);
  if (ACTIVE.has(task.status)) return `${task.status === 'queued' ? '等待生成' : '正在生成'} ${completed} / ${total}`;
  if (task.partial) return '部分完成';
  return ({ completed: '已完成', failed: '生成失败' })[task.status] || '状态待确认';
}
function mergeTask(task) { if (!task?.id) return; observeCreditTask(task); state.tasks = [task, ...state.tasks.filter(item => item.id !== task.id)].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); }
async function request(path, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), options.method === 'POST' ? 45000 : 15000);
  try {
    const response = await fetch(API + path, { ...options, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
    let body;
    try { body = await response.json(); } catch { throw new Error('服务暂时没有返回有效结果，请刷新任务状态。'); }
    if (!response.ok) { if (response.status === 402) void refreshWorkspaceCredits({ afterCurrent: true }); const error = new Error(shortError(body.error?.message || body.error || body.message)); error.status = response.status; error.code = body.error?.code || body.code; throw error; }
    return body;
  } catch (error) { if (error.name === 'AbortError') throw new Error('连接超时，请刷新任务状态。'); throw error; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
function schedulePoll() {
  clearTimeout(state.timer);
  clearTimeout(state.expiryTimer);
  const expiry = Math.min(...visibleTasks().map(task => Date.parse(task.expiresAt)).filter(Number.isFinite));
  if (pageIsActive() && Number.isFinite(expiry)) state.expiryTimer = setTimeout(() => { if (pageIsActive()) { paint(); void loadTasks(); } }, Math.max(1, expiry - Date.now() + 10));
  if (!pageIsActive() || (!state.pendingId && !state.tasks.some(task => ACTIVE.has(task.status)))) return;
  state.timer = setTimeout(() => { if (pageIsActive()) void loadTasks(); }, 5000);
}
async function loadTasks({ status = false } = {}) {
  if (state.loading) return;
  state.loading = true; paint();
  try {
    const [history, availability] = await Promise.allSettled([request('/images'), request('/status')]);
    if (availability.status === 'fulfilled' && availability.value) { state.status = availability.value.image; state.statusError = ''; }
    else if (availability.status === 'rejected') state.statusError = '暂时无法连接图片服务，请刷新状态。';
    if (history.status === 'rejected') throw history.reason;
    if (!Array.isArray(history.value.tasks)) throw new Error('任务记录暂时无法读取，请稍后刷新。');
    state.tasks = history.value.tasks; state.tasks.forEach(observeCreditTask); state.loaded = true; state.error = ''; state.lastRead = Date.now();
    if (state.pendingId) {
      const found = state.tasks.find(task => task.id === state.pendingId);
      if (found) { rememberPending(null); rememberUpload(null); }
      else {
        try { const result = await request('/images/' + encodeURIComponent(state.pendingId)); if (result.task) { mergeTask(result.task); rememberPending(null); rememberUpload(null); } }
        catch (error) { if (error.status === 404) {
          state.error = '尚未查到原生成任务，请稍后再次查询。不会自动重复生成。';
          if (state.uploadDraft) {
            try {
              const upload = await readUploadProgress();
              if (upload?.submitted === false) { rememberPending(null); state.error = '原任务尚未提交生成，素材已保留。请点“继续原任务”重试原提交。'; }
            } catch (uploadError) {
              if (uploadError.status !== 410) throw uploadError;
              rememberPending(null); state.error = uploadError.message;
            }
          }
        } else throw error; }
      }
    }
    if (state.uploadDraft && !state.pendingId && !state.submitting) {
      try { await readUploadProgress(); } catch (error) { if (error.status !== 404) state.submissionError = shortError(error.message); }
    }
  } catch (error) { state.error = shortError(error.message); }
  finally { state.loading = false; paint(); schedulePoll(); }
}
function controlState(ctx) {
  const { outputCount } = imageGenerationSettings(ctx.configs.image);
  const label = imageGenerationLabel(ctx.configs.image);
  if (state.submitting) return { label: state.uploadProgress?.phase === 'preparing' ? `正在压缩 ${state.uploadProgress.current} / ${state.uploadProgress.total}` : '正在保存素材…', disabled: true, hint: `正在上传 ${state.uploadDraft?.uploadedCount || 0} / ${state.uploadDraft?.imageCount || 0} 张` };
  if (state.pendingId) return { label: '提交状态待确认', disabled: true, hint: '正在查询原任务' };
  const running = state.tasks.find(task => ACTIVE.has(task.status));
  if (running) { const { completed, total } = taskCounts(running); return { label: `图片生成中 ${completed} / ${total}`, disabled: true, hint: '' }; }
  if (!state.status) return { label, disabled: true, hint: state.statusError || (state.loading ? '正在连接图片服务…' : '图片服务状态待确认，请刷新状态。') };
  if (!state.status.configured) return { label, disabled: true, hint: '图片服务尚未配置，请联系管理员。' };
  if (state.status.remaining === 0) return { label: '今日生成服务已达上限', disabled: true, hint: '请明日再试，未使用的积分保留。' };
  if (Number.isFinite(state.status.remaining) && state.status.remaining < outputCount) return { label, disabled: true, hint: `本次张数超出今日服务限额，请减少张数。` };
  const creditsError = creditInsufficiency(imagePoints(outputCount));
  if (creditsError) return { label: '积分不足', disabled: true, hint: creditsError };
  const prompt = ctx.configs.image.prompt, maxLength = ctx.modules.image.max || 1000;
  const error = completeUpload(ctx) ? !prompt.trim() ? '填写创作要求后继续。' : prompt.length > maxLength ? `创作要求最多 ${maxLength} 字，请缩短后继续。` : '' : validateImageRequest(prompt, selectedImages(ctx), maxLength);
  return { label, disabled: !!error, hint: !ctx.configs.image.prompt.trim() ? '选择风格或填写创作要求' : error || '' };
}
export function updateImageGenerationControls(ctx) {
  if (!pageIsActive()) return;
  const button = document.querySelector('[data-action="generate"]');
  const hint = document.querySelector('#input-requirement');
  const controls = controlState(ctx);
  if (button) { button.disabled = controls.disabled; button.innerHTML = controls.label + ctx.icon('arrow'); }
  if (hint) hint.textContent = controls.hint;
  const options = document.querySelector('#image-generation-options');
  if (options) {
    const focused = document.activeElement;
    const focusAction = focused?.dataset?.action;
    const focusValue = focused?.dataset?.value;
    options.innerHTML = renderImageGenerationOptions(ctx);
    document.querySelector('#image-output-count')?.addEventListener('change', event => handleImageGenerationAction('image-output-count', { dataset: { value: event.target.value } }, ctx));
    if (focusAction === 'image-generation-mode' && ['single', 'series', 'variations'].includes(focusValue)) document.querySelector(`#image-generation-options [data-action="${focusAction}"][data-value="${focusValue}"]`)?.focus?.({ preventScroll: true });
    if (focused?.id === 'image-output-count') document.querySelector('#image-output-count')?.focus?.({ preventScroll: true });
  }
}
export function renderImageGenerationNotice(ctx) {
  const { esc, button, icon } = ctx;
  const draft = state.uploadDraft;
  const upload = draft ? `<div class="image-upload-progress" role="status"><span>素材已保存 ${draft.uploadedCount || 0} / ${draft.imageCount} 张${state.uploadProgress?.phase === 'preparing' ? ` · 正在压缩 ${state.uploadProgress.current} / ${state.uploadProgress.total}` : ''}</span>${!state.submitting && !state.pendingId ? button('image-resume-upload', '继续原任务', 'textbutton') : ''}${!state.submitting && !state.pendingId ? '<small>请重新选择原照片继续上传。</small>' : ''}</div>` : '';
  return `<div id="image-generation-notice"><div class="image-service-note"><span>${icon('image')} ${esc(state.status?.configured ? `${displayModelName(state.status.model, 'Max模型')} · 图片创作` : '图片生成服务')}</span>${button('image-refresh', '刷新状态', 'textbutton', state.loading ? 'disabled' : '')}</div>${upload}${state.submissionError || state.error ? `<p class="image-generation-error" role="alert">${esc(state.submissionError || state.error)}</p>` : ''}</div>`;
}
export function renderImageTaskQueue(ctx) {
  const { esc, icon, button } = ctx;
  return `<div id="image-task-queue">${visibleTasks().length ? `<p class="image-queue-heading">生成任务 · ${visibleTasks().length}</p>${visibleTasks().slice(0, 12).map(task => button('image-show-task', `<span class="draft-icon">${icon(ACTIVE.has(task.status) ? 'clock' : 'image')}</span><strong>${esc(imageTaskTitle(task))}</strong><small>${esc(dateLabel(task.createdAt))}</small><span class="image-task-state ${esc(task.status)}">${statusLabel(task)}</span>`, 'draft image-task-row', `data-id="${esc(task.id)}"`)).join('')}` : ''}</div>`;
}
export function renderImageResults(ctx) {
  const { esc, button, icon } = ctx;
  const content = visibleTasks().length ? `<div class="image-results-list">${visibleTasks().map(task => {
    const title = imageTaskTitle(task);
    const images = (task.images || []).map(item => ({ ...item, url: safeImageResultUrl(item.url) })).filter(item => item.url);
    const { total, completed } = taskCounts(task);
    const modeLabel = GENERATION_MODES[task.generationMode]?.label || GENERATION_MODES.single.label;
    const partial = task.partial ? `<div class="image-partial-notice" role="status"><strong>已生成 ${completed} 张，剩余 ${Math.max(0, total - completed)} 张未完成。</strong><p>${esc(task.warning ? shortError(task.warning) : '已完成的图片可下载。')}</p></div>` : '';
    const gallery = task.status === 'completed' && images.length ? `<div class="generated-image-grid">${images.map((item, index) => {
      const label = item.label || `生成作品 ${Number.isInteger(item.index) ? item.index : index + 1}`;
      return `<figure><button class="generated-image-open" data-action="image-open-result" data-id="${esc(task.id)}" data-index="${index}" aria-label="放大查看${esc(label)}"><img src="${esc(item.url)}" alt="${esc(title)} · ${esc(label)}" loading="lazy"></button><figcaption><span>${esc(label)}${item.style && item.style !== label ? `<small>${esc(item.style)}</small>` : ''}</span><a class="secondary" href="${esc(item.url)}" download="${esc(item.filename || 'generated-image.png')}">${icon('save')} 下载图片</a></figcaption></figure>`;
    }).join('')}</div>` : task.status === 'failed' ? `<div class="image-task-message failed" role="status">${icon('help')}<div><strong>这次没有生成成功</strong><p>${esc(shortError(task.error?.message || task.error || '生成服务未完成任务，请调整要求或稍后再试。'))}</p></div></div>` : `<div class="image-task-message" role="status">${icon(task.status === 'completed' ? 'help' : 'clock')}<div><strong>${task.status === 'completed' ? '结果文件暂时无法显示' : task.status === 'queued' ? '任务已提交，等待生成' : '正在制作你的图片'}</strong><p>${task.status === 'completed' ? '请刷新记录后再查看。' : `已生成 ${completed} / ${total} 张`}</p></div></div>`;
    return `<article class="image-result-card" id="image-task-${esc(task.id)}"><header><div><strong>${esc(title)}</strong><small>${esc(dateLabel(task.createdAt))}${task.ratio ? ' · ' + esc(task.ratio) : ''} · ${esc(imageQualityName(task.quality))}</small><span class="image-result-mode">${esc(modeLabel)} · ${completed} / ${total} 张${billingPointsText(task) ? ` · ${esc(billingPointsText(task))}` : ''}</span></div><span class="image-task-state ${esc(task.status)}${task.partial ? ' partial' : ''}">${statusLabel(task)}</span></header>${partial}${gallery}<details class="image-result-prompt"><summary>查看创作要求</summary><p>${esc(task.prompt)}</p></details></article>`;
  }).join('')}</div>` : `<div class="empty-preview image-results-empty">${icon('image')}<h2>${state.loading ? '正在读取作品' : '暂无作品'}</h2>${state.error ? `<p class="image-generation-error" role="alert">${esc(state.error)}</p>` : ''}</div>`;
  return `<div id="image-generated-results"><div class="image-results-heading"><div><strong>我的图片作品</strong><small>成品保留 3 天，请及时下载</small></div>${button('image-refresh', icon('refresh') + '刷新记录', 'textbutton', state.loading ? 'disabled' : '')}</div>${content}</div>`;
}
function paint() {
  const ctx = state.ctx;
  if (!ctx || !pageIsActive()) return;
  const lightbox = document.querySelector('.image-result-lightbox[data-expires]');
  if (lightbox && Number(lightbox.dataset.expires) <= Date.now()) document.querySelector('#modal')?.close();
  const notice = document.querySelector('#image-generation-notice'); if (notice) notice.outerHTML = renderImageGenerationNotice(ctx);
  const queue = document.querySelector('#image-task-queue'); if (queue) queue.outerHTML = renderImageTaskQueue(ctx);
  const results = document.querySelector('#image-generated-results'); if (results) results.outerHTML = renderImageResults(ctx);
  updateImageGenerationControls(ctx);
}
async function readUploadProgress() {
  const draft = state.uploadDraft;
  if (!draft) return null;
  let data;
  try { data = await request('/image-uploads/' + encodeURIComponent(draft.id)); }
  catch (error) {
    if (state.uploadDraft?.id !== draft.id) return null;
    if (error.status === 410) {
      rememberUpload(null);
      error.message = '原素材已超过3天保留期，已清除过期上传进度。请重新选择原图后点击生成。';
      state.submissionError = error.message;
    }
    throw error;
  }
  if (state.uploadDraft?.id !== draft.id) return null;
  if (!data.upload) throw new Error('素材保存状态暂时无法读取，请刷新状态。');
  const upload = data.upload;
  rememberUpload({ ...draft, uploadedCount: Math.max(0, Math.min(draft.imageCount, Number(upload.uploadedCount) || 0)), expiresAt: upload.expiresAt, stage: upload.complete ? 'ready' : 'uploading' });
  if (upload.submitted && upload.taskId) rememberPending(upload.taskId);
  return upload;
}
async function submit(ctx) {
  if (controlState(ctx).disabled) return;
  const c = ctx.configs.image;
  const { generationMode, outputCount } = imageGenerationSettings(c);
  const selected = selectedImages(ctx);
  const prompt = c.prompt.trim();
  const ratio = ['1:1', '3:4', '4:3', '9:16', '16:9'].includes(c.ratio) ? c.ratio : '3:4';
  const quality = Object.hasOwn(QUALITY_NAMES, c.quality) ? c.quality : 'auto';
  const files = selected.map(item => item.file);
  if (state.uploadDraft && !completeUpload(ctx) && !sameUploadFiles(files)) {
    if (!files.length) { state.submissionError = '请重新选择原来的整组照片，继续尚未完成的上传。'; paint(); return; }
  }
  if (!state.uploadDraft || files.length && !sameUploadFiles(files)) {
    const requestId = crypto.randomUUID();
    rememberUpload({ id: requestId, imageCount: files.length, uploadedCount: 0, fingerprints: fingerprints(files), stage: 'creating', config: { prompt, ratio, quality, generationMode, count: String(outputCount) } });
  }
  state.submitting = true; state.error = ''; state.submissionError = ''; paint();
  state.uploadController = new AbortController();
  const signal = state.uploadController.signal;
  let sent = false;
  try {
    let draft = state.uploadDraft;
    const requestId = draft.id;
    let upload;
    try { upload = await readUploadProgress(); }
    catch (error) {
      if (error.status !== 404) throw error;
      const data = await request('/image-uploads', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, imageCount: draft.imageCount }) });
      if (!data.upload) throw new Error('素材任务创建状态待确认，请刷新状态。');
      rememberUpload({ ...draft, uploadedCount: Number(data.upload.uploadedCount) || 0, stage: 'uploading' });
      upload = data.upload;
    }
    if (upload?.submitted) { rememberPending(upload.taskId || requestId); sent = true; return; }
    draft = state.uploadDraft;
    if (draft.uploadedCount < draft.imageCount) {
      if (!sameUploadFiles(files)) throw new Error('请重新选择原来的整组照片，继续尚未完成的上传。');
      for await (const batch of preparePhotoBatches(files, { signal, startIndex: draft.uploadedCount, onProgress: progress => { state.uploadProgress = progress; paint(); } })) {
        try {
          const data = await request('/image-uploads/' + encodeURIComponent(requestId) + '/batches', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
          if (!data.upload) throw new Error('素材保存状态待确认，请刷新状态。');
          rememberUpload({ ...state.uploadDraft, uploadedCount: Number(data.upload.uploadedCount) || 0, stage: data.upload.complete ? 'ready' : 'uploading' });
        } catch (error) {
          if (signal.aborted) throw error;
          const fresh = await readUploadProgress();
          if (!fresh || fresh.uploadedCount < batch.startIndex + batch.images.length) throw error;
        }
        paint();
      }
    }
    if (state.uploadDraft.uploadedCount !== state.uploadDraft.imageCount) throw new Error('还有素材尚未保存完成，请继续原任务。');
    state.uploadProgress = null;
    rememberUpload({ ...state.uploadDraft, stage: 'submitted' });
    rememberPending(requestId); sent = true;
    const result = await request('/images', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, uploadId: requestId, prompt, ratio, quality, generationMode, outputCount }) });
    if (!result.task?.id) throw new Error('未收到任务编号，正在核对提交状态。');
    mergeTask(result.task); rememberPending(null); rememberUpload(null); state.loaded = true;
    if (pageIsActive()) { ctx.setPreviewTab?.('我的作品'); ctx.refresh(); ctx.toast('创作已提交，完成后可在「我的作品」下载。'); }
  } catch (error) {
    if (error.status >= 400 && error.status < 500) rememberPending(null);
    if (state.pendingId) state.error = '提交连接中断，正在核对任务状态。不会自动重复提交。';
    else state.submissionError = signal.aborted ? '上传已暂停，已保存的素材会保留，可以继续原任务。' : shortError(error.message);
  } finally {
    state.submitting = false; state.uploadController = null; state.uploadProgress = null; paint();
    if (sent) await loadTasks(); else schedulePoll();
  }
}
export function bindImageGeneration(ctx) {
  if (ctx.mode !== 'image') return;
  state.ctx = ctx;
  unsubscribeCredits?.(); unsubscribeCredits = subscribeWorkspaceCredits(paint);
  if (state.uploadDraft?.config && !ctx.configs.image.prompt.trim()) Object.assign(ctx.configs.image, state.uploadDraft.config);
  updateImageGenerationControls(ctx);
  if (!state.loaded || Date.now() - state.lastRead > 10000) void loadTasks(); else schedulePoll();
}
export function disposeImageGeneration() { unsubscribeCredits?.(); unsubscribeCredits = null; clearTimeout(state.timer); clearTimeout(state.expiryTimer); state.uploadController?.abort(); state.ctx = null; }
function creationBlockReason() {
  if (state.submitting) return '正在提交素材，请完成后再新建。';
  if (state.pendingId) return '提交状态待确认，请先查询原任务。';
  if (state.tasks.some(task => ACTIVE.has(task.status))) return '图片正在生成，请完成后再新建。';
  if (!state.loaded) return '正在查询任务，请稍后新建。';
  return '';
}
export function resetImageCreation(ctx) {
  const blocked = creationBlockReason();
  if (blocked) { ctx.toast?.(blocked); return false; }
  rememberUpload(null);
  state.uploadProgress = null; state.submissionError = ''; state.error = '';
  return true;
}
export function handleImageGenerationAction(action, el, ctx) {
  if (ctx.mode !== 'image') return false;
  if (action === 'new' && creationBlockReason()) { ctx.toast?.(creationBlockReason()); return true; }
  if (action === 'image-generation-mode' || action === 'image-output-count') {
    if (state.submitting || state.pendingId || state.tasks.some(task => ACTIVE.has(task.status))) return true;
    const c = ctx.configs.image;
    if (action === 'image-generation-mode' && Object.hasOwn(GENERATION_MODES, el.dataset.value)) {
      c.generationMode = el.dataset.value;
      c.count = String(c.generationMode === 'single' ? 1 : Number.isInteger(Number(c.count)) && Number(c.count) >= 2 && Number(c.count) <= 15 ? Number(c.count) : 6);
    }
    if (action === 'image-output-count' && imageGenerationSettings(c).generationMode !== 'single' && Number.isInteger(Number(el.dataset.value)) && Number(el.dataset.value) >= 2 && Number(el.dataset.value) <= 15) c.count = String(Number(el.dataset.value));
    updateImageGenerationControls(ctx);
    return true;
  }
  if (action === 'generate' || action === 'image-resume-upload') { void submit(ctx); return true; }
  if (action === 'image-refresh') { void refreshWorkspaceCredits(); state.submissionError = ''; void loadTasks({ status: true }); return true; }
  if (action === 'image-show-task') { ctx.setPreviewTab?.('我的作品'); ctx.refresh(); document.getElementById('image-task-' + el.dataset.id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return true; }
  if (action === 'image-open-result') {
    const task = visibleTasks().find(item => item.id === el.dataset.id);
    const images = (task?.images || []).filter(item => safeImageResultUrl(item.url));
    const image = images[Number(el.dataset.index)];
    if (image) ctx.openModal(imageTaskTitle(task), dateLabel(task.createdAt) + ' · ' + imageQualityName(task.quality), `<div class="image-result-lightbox" ${task.expiresAt?`data-expires="${Date.parse(task.expiresAt)}"`:''}><img src="${ctx.esc(safeImageResultUrl(image.url))}" alt="${ctx.esc(imageTaskTitle(task))}"><a class="primary" href="${ctx.esc(safeImageResultUrl(image.url))}" download="${ctx.esc(image.filename || 'generated-image.png')}">${ctx.icon('save')} 下载图片</a></div>`, true);
    return true;
  }
  return false;
}
