import BrowserMaterials from './browser-materials.js';
import { accountStorageKey } from './account-storage.js';

const JOB_ID = /^[a-f0-9]{32}$/;
const complete = job => ['done', 'completed'].includes(job?.state);
const terminal = job => complete(job) || ['failed', 'cancelled', 'error', 'interrupted', 'expired'].includes(job?.state);
const resumable = job => ['failed', 'interrupted'].includes(job?.state);
const emptyStatus = () => ({ text: '选择素材文件夹', error: '', scanned: 0, indexed: 0, total: 0, connected: false, needsPermission: false });
const emptyAudio = () => ({ voice: [], music: [], configured: null, missing: [], busy: false, loading: false, error: '', progress: null });
const audioBindings = new WeakSet();
const state = { ownerKey: null, ctx: null, client: null, status: emptyStatus(), health: null, media: [], fileCount: 0,
  audio: emptyAudio(),
  job: null, jobs: [], pending: null, busy: false, error: '', view: 'materials', revision: 0, started: false,
  timer: null, loading: null, refreshPanels: null, controllers: new Set(), urls: new Map() };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const storageKey = () => accountStorageKey('mix-active-job');
const stopped = () => Object.assign(new Error('素材连接已停止'), { name: 'AbortError' });
const message = error => String(error?.message || error || '连接暂时不可用，请重试。').replace(/sk-[\w.-]+/gi, '[已隐藏]').slice(0, 600);

export function safeMixArtifactUrl(value, origin = globalThis.location?.origin) {
  if (typeof value !== 'string' || !/^\/api\/mix\/jobs\/[a-f0-9]{32}\/(video|captions|plan)$/.test(value)) return '';
  try { return new URL(value, origin).origin === origin ? value : ''; } catch { return ''; }
}

export function safeMixAudioUrl(value, origin = globalThis.location?.origin) {
  if (typeof value !== 'string' || !/^\/api\/mix\/audio\/[a-f0-9]{32}\/stream$/.test(value)) return '';
  try { return new URL(value, origin).origin === origin ? value : ''; } catch { return ''; }
}

function audioItem(item, kind) {
  return item?.kind === kind && JOB_ID.test(item.id || '') && safeMixAudioUrl(item.url) === `/api/mix/audio/${item.id}/stream`;
}

function guard(revision = state.revision, ownerKey = state.ownerKey) {
  if (state.ownerKey !== storageKey()) stopMixMaterials();
  if (!state.started || revision !== state.revision || ownerKey !== state.ownerKey) throw stopped();
}

export function stopMixMaterials() {
  state.revision++;
  state.started = false;
  state.client?.stop();
  state.client = null;
  clearTimeout(state.timer);
  state.timer = null;
  for (const controller of state.controllers) controller.abort();
  state.controllers.clear();
  for (const item of state.urls.values()) URL.revokeObjectURL(item.url);
  state.urls.clear();
  if (state.ctx?.configs?.mix) Object.assign(state.ctx.configs.mix, { voice_id: '', music_id: '', music: false });
  Object.assign(state, { ownerKey: null, status: emptyStatus(), health: null, media: [], fileCount: 0, job: null,
    jobs: [], pending: null, busy: false, error: '', view: 'materials', loading: null, refreshPanels: null, audio: emptyAudio() });
  updateAudio();
  updateStatus();
}

export function getMixState() {
  if (state.ownerKey && state.ownerKey !== storageKey()) stopMixMaterials();
  return state;
}

function remember(value) {
  if (value) localStorage.setItem(state.ownerKey, JSON.stringify(value));
  else localStorage.removeItem(state.ownerKey);
}

function remembered() {
  try {
    const value = JSON.parse(localStorage.getItem(state.ownerKey) || 'null');
    if (JOB_ID.test(value?.id || '')) return { id: value.id };
    if (/^[\da-f-]{36}$/i.test(value?.key || '') && value.body && typeof value.body.text === 'string') return value;
  } catch { /* A saved server job remains discoverable in task history. */ }
  return null;
}

async function request(path, options = {}, raw = false) {
  const revision = state.revision;
  const ownerKey = state.ownerKey;
  guard(revision, ownerKey);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  state.controllers.add(controller);
  const timer = setTimeout(abort, /\/(analyze|frames|complete)$/.test(path) ? 600000 : 45000);
  try {
    const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1', ...options.headers }, signal: controller.signal });
    guard(revision, ownerKey);
    if (response.status === 401) {
      stopMixMaterials();
      state.error = '登录已失效，请重新登录后连接素材。';
      updateStatus();
      throw Object.assign(new Error('登录已失效，请重新登录后连接素材。'), { status: 401 });
    }
    if (raw) return response;
    const body = await response.json();
    guard(revision, ownerKey);
    if (!response.ok) throw Object.assign(new Error(message(body.error || body.message || (typeof body.detail === 'string' ? body.detail : ''))), { status: response.status });
    return body;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    state.controllers.delete(controller);
  }
}

function catalog() {
  const entries = Object.values(state.client?.record?.manifest || {});
  state.fileCount = entries.length;
  const visible = entries.filter(entry => state.client.files.has(entry.relativePath)).slice(0, 30);
  const keep = new Set(visible.map(entry => entry.assetId));
  for (const [id, item] of state.urls) if (!keep.has(id)) { URL.revokeObjectURL(item.url); state.urls.delete(id); }
  const media = visible.map(entry => {
    const file = state.client.files.get(entry.relativePath);
    if (!state.urls.has(entry.assetId)) state.urls.set(entry.assetId, { file, url: URL.createObjectURL(file) });
    return { id: entry.assetId, name: entry.relativePath, type: 'video', file, url: state.urls.get(entry.assetId).url, duration: entry.duration };
  });
  const changed = state.media.map(item => item.id).join() !== media.map(item => item.id).join();
  state.media = media;
  return changed;
}

function refreshPreview(catalogChanged = false) {
  if (typeof document === 'undefined' || !document.querySelector('.mix-studio')) return;
  if (state.refreshPanels) state.refreshPanels(catalogChanged);
  else state.ctx?.refresh?.();
}

function folderReadiness() {
  if (!state.health?.configured) return '生成服务尚未配置完成';
  if (state.status.needsPermission) return '请重新连接素材文件夹';
  if (!state.status.connected) return '先选择素材文件夹';
  if (state.client?.scanning) return '素材正在上传，请稍候';
  if (!state.status.indexed) return '素材正在上传，请稍候';
  const readable = Object.values(state.client?.record?.manifest || {}).some(entry =>
    state.client.files.has(entry.relativePath) && entry.clips?.some(clip => clip.state === 'indexed'));
  return readable ? '' : '请重新扫描可读取的素材';
}

export function mixFolderLocked() { return state.busy || state.audio.busy || !!(state.job && !terminal(state.job)) || !!(state.pending && !state.pending.id); }

export function mixReadiness(ctx = state.ctx) {
  const folderHint = folderReadiness();
  if (folderHint) return folderHint;
  if (!ctx?.configs?.mix?.prompt?.trim()) return '填写宣传文案后即可开始';
  if (state.busy || state.job && !terminal(state.job)) return '正在制作，请保持网页连接';
  if (state.pending && !state.pending.id) return '请确认上次提交的任务状态';
  if (state.audio.busy) return '正在保存音频，请稍候';
  const c = ctx?.configs?.mix;
  if ((c.voice_mode || 'synthesized') === 'synthesized') {
    if (state.health?.voice_configured === false) return '配音服务尚未配置，可选择保留素材原声';
    if (c.voice_id ? !state.audio.voice.some(item => item.id === c.voice_id) : state.health?.default_voice_configured === false) return '上传并选择一个音色后即可合成人声';
  }
  if (c.music_id && !state.audio.music.some(item => item.id === c.music_id)) return '请重新选择背景音乐';
  return '';
}

export function renderMixAudio(ctx = state.ctx) {
  const c = ctx?.configs?.mix || {};
  const locked = mixFolderLocked() || state.audio.busy || state.audio.loading;
  const disabled = locked ? 'disabled' : '';
  const mode = c.voice_mode || 'synthesized';
  const section = kind => {
    const voice = kind === 'voice', selected = c[`${kind}_id`] || '';
    const item = state.audio[kind].find(item => item.id === selected);
    return `<div class="mix-audio-library"><label class="studio-field">${voice ? '音色库' : '背景音乐库'}<select data-mix-audio-field="${kind}_id" ${disabled} ${voice && mode === 'original' ? 'disabled' : ''}><option value="">${voice ? state.health?.default_voice_configured ? '使用默认音色' : '请选择音色' : '不加背景音乐'}</option>${state.audio[kind].map(item => `<option value="${item.id}" ${item.id === selected ? 'selected' : ''}>${escape(item.name)}</option>`).join('')}</select></label><div class="mix-audio-actions"><label class="mix-audio-upload">上传${voice ? '人声' : '音乐'}<input type="file" accept=".mp3,.wav,.m4a" data-mix-audio-upload="${kind}" ${disabled || (state.audio.configured !== true ? 'disabled' : '')}></label>${item ? `<button data-action="mix-audio-delete" data-kind="${kind}" data-id="${item.id}" ${disabled}>删除</button>` : ''}</div>${item ? `<audio controls preload="none" src="${escape(safeMixAudioUrl(item.url))}" aria-label="试听${escape(item.name)}"></audio>` : ''}<small>${voice ? 'MP3 / WAV / M4A，最多 32 MiB，取前 15 秒作参考' : 'MP3 / WAV / M4A，最多 128 MiB'}</small></div>`;
  };
  const progress = state.audio.progress;
  return `<label class="studio-field">视频声音<select data-mix-audio-field="voice_mode" ${disabled}><option value="synthesized" ${mode === 'synthesized' ? 'selected' : ''}>合成人声</option><option value="original" ${mode === 'original' ? 'selected' : ''}>保留素材原声（不配音）</option></select></label><small>${mode === 'original' ? '保留视频原声音，画面与字幕时长按文案估算' : '按照文案合成配音，替换素材原声'}</small>${section('voice')}${section('music')}<div role="status" aria-live="polite">${state.audio.busy ? `<small>${progress && progress.loaded < progress.total ? '正在上传音频' : '正在处理音频'}</small>` : ''}${progress ? `<progress max="${progress.total || 1}" value="${progress.loaded}" aria-label="音频上传进度"></progress>` : ''}${state.audio.configured === false ? '<small>音频库待管理员配置</small>' : ''}${state.audio.error ? `<small class="mix-status-error">${escape(state.audio.error)}</small>` : ''}</div><div class="mix-audio-actions"><button data-action="mix-audio-refresh" ${disabled}>${state.audio.loading ? '正在加载音频库' : '刷新音频库'}</button></div>`;
}

function bindAudioControls(root) {
  root.querySelectorAll('[data-mix-audio-field]').forEach(input => {
    if (audioBindings.has(input)) return;
    audioBindings.add(input);
    input.addEventListener('change', () => {
    if (mixFolderLocked() || state.audio.busy || state.audio.loading) return;
    const c = state.ctx.configs.mix;
    c[input.dataset.mixAudioField] = input.value;
    c.music = !!c.music_id;
    updateAudio(); updateStatus();
    });
  });
  root.querySelectorAll('[data-mix-audio-upload]').forEach(input => {
    if (audioBindings.has(input)) return;
    audioBindings.add(input);
    input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) uploadMixAudio(input.dataset.mixAudioUpload, file);
    });
  });
}

function updateAudio() {
  const root = typeof document !== 'undefined' && document.querySelector('#mix-audio-settings');
  if (!root) return;
  root.innerHTML = renderMixAudio();
  bindAudioControls(root);
}

async function loadAudio() {
  if (state.audio.loading || state.audio.busy) return;
  const revision = state.revision;
  state.audio.loading = true;
  state.audio.error = '';
  updateAudio(); updateStatus();
  try {
    const lists = await Promise.all(['voice', 'music'].map(kind => request('/api/mix/audio?kind=' + kind)));
    guard(revision);
    lists.forEach((result, index) => { const kind = index ? 'music' : 'voice'; state.audio[kind] = (result.items || []).filter(item => audioItem(item, kind)); });
    state.audio.configured = lists.every(result => result.configured === true);
    state.audio.missing = [...new Set(lists.flatMap(result => result.missing || []))];
  } catch (error) {
    if (revision !== state.revision) return;
    state.audio.error = error.name === 'AbortError' ? '音频库连接超时，请重试' : message(error);
  } finally {
    if (revision === state.revision) { state.audio.loading = false; updateAudio(); updateStatus(); }
  }
}

export async function uploadMixAudio(kind, file, ctx = state.ctx) {
  if (!['voice', 'music'].includes(kind) || mixFolderLocked() || state.audio.busy || state.audio.loading) return;
  const revision = state.revision;
  try {
    guard(revision);
    if (state.audio.configured !== true) throw new Error('音频库待管理员配置');
    if (!/\.(mp3|wav|m4a)$/i.test(file?.name || '') || !file.size) throw new Error('请选择 MP3、WAV 或 M4A 音频');
    if (file.size > (kind === 'voice' ? 32 : 128) * 1024 * 1024) throw new Error(kind === 'voice' ? '人声音频最大 32 MiB' : '背景音乐最大 128 MiB');
    state.audio.busy = true; state.audio.error = ''; state.audio.progress = { loaded: 0, total: file.size };
    updateAudio(); updateStatus();
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      state.controllers.add(xhr);
      const finish = (fn, value) => { state.controllers.delete(xhr); fn(value); };
      xhr.open('POST', `/api/mix/audio?kind=${kind}&name=${encodeURIComponent(file.name)}`);
      xhr.withCredentials = true; xhr.timeout = 600000;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Workbench-Request', '1');
      xhr.upload.onprogress = event => {
        try { guard(revision); } catch { return; }
        if (event.lengthComputable) { state.audio.progress = { loaded: event.loaded, total: event.total }; updateAudio(); }
      };
      xhr.onload = () => {
        try {
          guard(revision);
          if (xhr.status === 401) { stopMixMaterials(); state.error = '登录已失效，请重新登录'; updateStatus(); throw stopped(); }
          const body = JSON.parse(xhr.responseText);
          if (xhr.status < 200 || xhr.status >= 300) throw new Error(message(body.error || body.detail));
          finish(resolve, body);
        } catch (error) { finish(reject, error); }
      };
      xhr.onerror = xhr.ontimeout = () => finish(reject, new Error('音频上传未完成，请重试'));
      xhr.onabort = () => finish(reject, stopped());
      try { xhr.send(file); } catch (error) { finish(reject, error); }
    });
    guard(revision);
    if (!audioItem(result.item, kind)) throw new Error('服务器未返回有效音频，请重新加载');
    state.audio[kind] = [result.item, ...state.audio[kind].filter(item => item.id !== result.item.id)];
    ctx.configs.mix[`${kind}_id`] = result.item.id;
    ctx.configs.mix.music = !!ctx.configs.mix.music_id;
  } catch (error) {
    if (revision !== state.revision || error.name === 'AbortError') return;
    state.audio.error = message(error);
    ctx?.toast?.(state.audio.error);
  } finally {
    if (revision === state.revision) { state.audio.busy = false; state.audio.progress = null; updateAudio(); updateStatus(); }
  }
}

async function deleteAudio(kind, id) {
  if (!['voice', 'music'].includes(kind) || !state.audio[kind].some(item => item.id === id) || mixFolderLocked() || state.audio.busy || state.audio.loading) return;
  const revision = state.revision;
  state.audio.busy = true; state.audio.error = '';
  updateAudio(); updateStatus();
  try {
    await request('/api/mix/audio/' + id, { method: 'DELETE' });
    guard(revision);
    state.audio[kind] = state.audio[kind].filter(item => item.id !== id);
    const c = state.ctx.configs.mix;
    if (c[`${kind}_id`] === id) c[`${kind}_id`] = '';
    c.music = !!c.music_id;
  } catch (error) {
    if (revision !== state.revision || error.name === 'AbortError') return;
    state.audio.error = message(error);
    state.ctx?.toast?.(state.audio.error);
  } finally {
    if (revision === state.revision) { state.audio.busy = false; updateAudio(); updateStatus(); }
  }
}

export function renderMixMaterials() {
  const status = state.status;
  const uploading = !status.needsPermission && (state.client?.scanning || status.uploadTotal || status.connected && status.indexed < status.total);
  const text = status.needsPermission ? '请点击上方按钮重新连接素材文件夹' : uploading ? '素材正在上传' : status.connected && !status.error ? status.total ? '素材上传完成' : '未找到可用的视频素材' : '';
  const progress = status.uploadTotal ? `<progress max="${status.uploadTotal}" value="${status.uploadBytes || 0}" aria-label="素材上传进度"></progress>` : state.client?.scanning ? '<progress aria-label="素材上传进度"></progress>' : status.total && !status.needsPermission ? `<progress max="${status.total}" value="${status.indexed}" aria-label="素材上传进度"></progress>` : '';
  const locked = mixFolderLocked();
  const disabled = locked ? 'disabled title="制作时请保持原素材文件夹连接"' : '';
  const scan = status.connected && !status.needsPermission && !uploading;
  const resumeHint = state.audio.busy ? '正在保存音频，请稍候' : state.busy ? '正在继续制作' : folderReadiness();
  const resume = resumable(state.job) ? `<button data-action="mix-resume-job" ${resumeHint ? `disabled title="${escape(resumeHint)}"` : ''}>继续制作</button>` : '';
  const actions = `${scan ? `<button data-action="mix-scan" ${disabled}>扫描新增 / 修改</button><button data-action="mix-disconnect" ${disabled}>断开</button>` : ''}${resume}${state.pending && !state.pending.id && !state.busy ? '<button data-action="mix-retry-submit">重试这次提交</button>' : ''}${state.error && state.job ? '<button data-action="mix-refresh-job">刷新任务</button>' : ''}`;
  return `<div class="mix-material-status" id="mix-material-status" role="status" aria-live="polite">${text ? `<span>${text}</span>` : ''}${progress}${status.error || state.error || state.job?.error ? `<small class="mix-status-error">${escape(status.error || state.error || state.job.error)}</small>` : ''}${actions ? `<div class="mix-folder-actions">${actions}</div>` : ''}</div>`;
}

export function mixJobLabel(job = state.job) {
  const labels = { queued: '任务已提交', matching: '正在匹配素材', waiting_materials: '正在等待本机素材', running: '正在制作视频', rendering: '正在合成视频', done: '成片已完成', completed: '成片已完成', failed: '制作失败', error: '制作失败', cancelled: '任务已取消', interrupted: '制作已中断', expired: '任务已过期' };
  return labels[job?.state] || '正在制作视频';
}

function updateStatus() {
  if (typeof document === 'undefined') return;
  const root = document.querySelector('.mix-studio');
  if (!root) return;
  const footer = root.querySelector('#mix-material-status');
  if (footer) footer.innerHTML = renderMixMaterials().replace(/^<div[^>]*>|<\/div>$/g, '');
  const folderLabel = root.querySelector('.studio-add-material .mix-folder-label');
  if (folderLabel) folderLabel.textContent = state.status.needsPermission ? '重新连接素材文件夹' : state.status.connected ? '更换素材文件夹' : '选择本地素材文件夹';
  const hint = mixReadiness();
  const generate = root.querySelector('[data-action="studio-generate"]');
  if (generate) { generate.disabled = !!hint; generate.title = hint; }
  const hintNode = root.querySelector('#studio-generation-hint');
  if (hintNode) hintNode.textContent = hint || `${state.status.indexed} 个片段可供匹配`;
  const timingNode = root.querySelector('#mix-timing-hint');
  if (timingNode) timingNode.textContent = state.ctx?.configs?.mix?.voice_mode === 'original' ? '按文案阅读速度估算' : '文案与配音自动确定';
  const jobNode = root.querySelector('#mix-job-progress');
  if (jobNode && state.job) jobNode.textContent = mixJobLabel();
  const resultButton = root.querySelector('[data-action="mix-show-result"]');
  if (resultButton) resultButton.hidden = !complete(state.job) || state.view === 'result';
  root.querySelectorAll('[data-action="mix-choose-folder"], [data-action="mix-disconnect"], [data-action="mix-scan"]').forEach(button => {
    const locked = mixFolderLocked() && (button.dataset.action !== 'mix-choose-folder' || state.status.connected && !state.status.needsPermission);
    button.disabled = locked;
    button.title = locked ? '制作时请保持原素材文件夹连接' : '';
  });
  root.querySelectorAll('[data-mix-audio-field], [data-mix-audio-upload], [data-action="mix-audio-delete"], [data-action="mix-audio-refresh"]').forEach(input => {
    input.disabled = mixFolderLocked() || state.audio.busy || state.audio.loading || input.dataset.mixAudioUpload && state.audio.configured !== true
      || input.dataset.mixAudioField === 'voice_id' && state.ctx?.configs?.mix?.voice_mode === 'original';
  });
}

function acceptJob(job, revision) {
  guard(revision);
  if (!JOB_ID.test(job?.id || '')) throw new Error('服务器未返回有效任务，请重试这次提交。');
  const previous = state.job;
  state.job = job;
  state.jobs = [job, ...state.jobs.filter(item => item.id !== job.id)].slice(0, 20);
  state.pending = { id: job.id };
  try { remember(state.pending); } catch { state.error = '浏览器无法保存任务编号，重新打开时可在制作记录中查看。'; }
  if (complete(job) && !previous) state.view = 'result';
  if (previous?.id !== job.id || terminal(job) && previous?.state !== job.state) refreshPreview();
  updateStatus();
  if (terminal(job)) { clearTimeout(state.timer); state.timer = null; }
  else schedulePoll(revision);
}

function schedulePoll(revision = state.revision) {
  clearTimeout(state.timer);
  state.timer = null;
  if (state.started && (state.job || state.pending?.id) && !terminal(state.job)) state.timer = setTimeout(() => pollJob(revision), 2500);
}

async function pollJob(revision = state.revision) {
  try {
    guard(revision);
    const id = state.job?.id || state.pending?.id;
    if (!JOB_ID.test(id || '')) return;
    const job = await request('/api/mix/jobs/' + id);
    guard(revision);
    if (state.busy) return;
    if (state.pending?.key || (state.job?.id || state.pending?.id) !== id) return;
    state.error = '';
    acceptJob(job, revision);
  } catch (error) {
    if (revision !== state.revision || error.name === 'AbortError') return;
    state.error = message(error);
    if (error.status === 404 && state.pending?.id) {
      acceptJob({ id: state.pending.id, state: 'expired', error: '任务已过期，填写文案后可重新制作。' }, revision);
      return;
    }
    updateStatus();
    schedulePoll(revision);
  }
}

async function submit(pending) {
  const revision = state.revision;
  state.busy = true;
  state.error = '';
  updateStatus();
  try {
    guard(revision);
    remember(pending);
    const job = await request('/api/mix/jobs', { method: 'POST', headers: { 'Idempotency-Key': pending.key }, body: JSON.stringify(pending.body) });
    acceptJob(job, revision);
  } catch (error) {
    if (revision !== state.revision || error.name === 'AbortError') return;
    state.error = message(error);
    if ([400, 403, 404, 422].includes(error.status)) {
      state.pending = null;
      try { remember(null); } catch { /* Current error is still visible. */ }
    }
    state.ctx?.toast?.(state.error);
  } finally {
    if (revision === state.revision) { state.busy = false; updateStatus(); }
  }
}

async function resumeJob() {
  if (state.busy || state.audio.busy || !resumable(state.job)) return;
  const hint = folderReadiness();
  if (hint) { state.ctx?.toast?.(hint); return; }
  const revision = state.revision;
  const id = state.job.id;
  state.busy = true;
  state.error = '';
  state.view = 'result';
  updateStatus();
  try {
    const job = await request('/api/mix/jobs/' + id + '/resume', { method: 'POST', body: '{}' });
    guard(revision);
    if (job.id !== id) throw new Error('服务器未确认原任务，请刷新任务状态。');
    acceptJob(job, revision);
    refreshPreview();
  } catch (error) {
    if (revision !== state.revision || error.name === 'AbortError') return;
    state.error = message(error);
    state.ctx?.toast?.(state.error);
  } finally {
    if (revision === state.revision) { state.busy = false; updateStatus(); }
  }
}

let lifecycleBound = false;
export function initializeMixMaterials(ctx) {
  state.ctx = ctx;
  const refreshPanels = ctx?.refreshMixPanels || state.refreshPanels;
  const changingAccount = state.ownerKey && state.ownerKey !== storageKey();
  if (state.ownerKey !== storageKey()) stopMixMaterials();
  if (!changingAccount) state.refreshPanels = refreshPanels;
  if (!lifecycleBound && typeof window !== 'undefined') {
    lifecycleBound = true;
    window.addEventListener('pagehide', stopMixMaterials);
    window.addEventListener('pageshow', event => { if (event.persisted && state.ctx) initializeMixMaterials(state.ctx); });
    window.addEventListener('workspace-account-change', stopMixMaterials);
    document.addEventListener('click', event => { if (event.target.closest?.('#account-logout')) stopMixMaterials(); }, true);
  }
  if (state.started) { updateStatus(); return state.loading || Promise.resolve(); }
  state.started = true;
  state.ownerKey = storageKey();
  const revision = state.revision;
  state.pending = remembered();
  state.client = new BrowserMaterials({ api: request, fetch: (path, options) => request(path, options, true),
    onStatus: status => {
      try { guard(revision); } catch { return; }
      state.status = { ...status };
      const changed = catalog();
      updateStatus();
      if (changed) refreshPreview(true);
    } });
  state.loading = (async () => {
    const results = await Promise.allSettled([
      (async () => { const health = await request('/api/mix/health'); guard(revision); state.health = health; updateAudio(); updateStatus(); })(),
      loadAudio(),
      state.client.restore(),
      (async () => {
        const result = await request('/api/mix/jobs');
        guard(revision);
        state.jobs = (result.jobs || []).filter(job => JOB_ID.test(job.id));
        const savedId = state.pending?.id;
        const job = savedId ? state.jobs.find(job => job.id === savedId) : !state.pending ? state.jobs[0] : null;
        if (job) acceptJob(job, revision);
        if (savedId) await pollJob(revision);
        else if (job) refreshPreview();
      })(),
    ]);
    if (revision !== state.revision) return;
    try { guard(revision); } catch { return; }
    const failed = results.find(result => result.status === 'rejected' && result.reason?.name !== 'AbortError');
    if (failed) state.error = message(failed.reason);
    updateStatus();
  })();
  return state.loading;
}

export const startMixMaterials = initializeMixMaterials;

export function bindMixMaterials(ctx) {
  state.ctx = ctx; state.refreshPanels = ctx.refreshMixPanels || state.refreshPanels;
  const root = typeof document !== 'undefined' && document.querySelector('#mix-audio-settings');
  if (root) bindAudioControls(root);
  updateStatus();
}

export function handleMixMaterialAction(action, el, ctx) {
  if (ctx.mode !== 'mix' && !action.startsWith('mix-')) return false;
  state.ctx = ctx;
  if (state.ownerKey !== storageKey() || !state.started) initializeMixMaterials(ctx);
  if (action === 'studio-select-clip') { state.view = 'materials'; return false; }
  if (action === 'studio-generate' || action === 'generate') {
    const hint = mixReadiness(ctx);
    if (hint) ctx.toast(hint);
    else {
      const c = ctx.configs.mix;
      if (c.prompt.length > 2000) { ctx.toast('宣传文案最多 2000 字，请精简后继续。'); return true; }
      state.pending = { key: crypto.randomUUID(), body: { text: c.prompt.trim(), device_id: state.client.deviceId,
        ratio: c.ratio, quality: c.quality, subtitles: c.subtitles, voice_mode: c.voice_mode || 'synthesized',
        voice_id: c.voice_mode === 'original' ? null : c.voice_id || null, music_id: c.music_id || null,
        music: !!c.music_id, count: 1, duration: null } };
      state.view = 'result';
      submit(state.pending);
    }
    return true;
  }
  if (!action.startsWith('mix-')) return false;
  switch (action) {
    case 'mix-audio-refresh': if (!mixFolderLocked()) loadAudio(); break;
    case 'mix-audio-delete': deleteAudio(el.dataset.kind, el.dataset.id); break;
    case 'mix-choose-folder':
    case 'mix-scan': {
      const reconnecting = !state.status.connected || state.status.needsPermission;
      if (mixFolderLocked() && !reconnecting) { ctx.toast('制作时请保持原素材文件夹连接'); break; }
      const revision = state.revision;
      const choosing = action === 'mix-scan' && !state.status.needsPermission ? state.client.scan() : state.client.choose({ reconnectOnly: mixFolderLocked() });
      Promise.resolve(choosing).then(() => {
        guard(revision);
        updateStatus();
      }).catch(error => {
        if (revision === state.revision && error.name !== 'AbortError') { state.error = message(error); updateStatus(); }
      });
      break;
    }
    case 'mix-disconnect': {
      if (mixFolderLocked()) { ctx.toast('制作时请保持原素材文件夹连接'); break; }
      const revision = state.revision;
      state.client.disconnect().catch(error => {
        if (revision === state.revision) { state.error = message(error); updateStatus(); }
      });
      break;
    }
    case 'mix-retry-submit': if (state.pending?.key && !state.busy && !state.audio.busy) submit(state.pending); break;
    case 'mix-resume-job': resumeJob(); break;
    case 'mix-refresh-job': pollJob(); break;
    case 'mix-show-result': state.view = 'result'; refreshPreview(); break;
    case 'mix-open-job': {
      if (mixFolderLocked() && el.dataset.id !== state.job?.id) { ctx.toast('请等待当前任务制作完成后再查看其他记录'); break; }
      const job = state.jobs.find(item => item.id === el.dataset.id);
      if (job) { acceptJob(job, state.revision); state.view = 'result'; refreshPreview(); pollJob(); }
      break;
    }
    default: return false;
  }
  return true;
}
