import BrowserMaterials from './browser-materials.js';
import { accountStorageKey } from './account-storage.js';

const JOB_ID = /^[a-f0-9]{32}$/;
const complete = job => ['done', 'completed'].includes(job?.state);
const terminal = job => complete(job) || ['failed', 'cancelled', 'error', 'interrupted', 'expired'].includes(job?.state);
const resumable = job => ['failed', 'interrupted'].includes(job?.state);
const emptyStatus = () => ({ text: '选择素材文件夹', error: '', scanned: 0, indexed: 0, total: 0, connected: false, needsPermission: false });
const state = { ownerKey: null, ctx: null, client: null, status: emptyStatus(), health: null, media: [], fileCount: 0,
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
  Object.assign(state, { ownerKey: null, status: emptyStatus(), health: null, media: [], fileCount: 0, job: null,
    jobs: [], pending: null, busy: false, error: '', view: 'materials', loading: null, refreshPanels: null });
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
  if (state.client?.scanning) return '正在扫描素材文件夹，请稍候';
  if (!state.status.indexed) return '正在建立素材索引，请稍候';
  const readable = Object.values(state.client?.record?.manifest || {}).some(entry =>
    state.client.files.has(entry.relativePath) && entry.clips?.some(clip => clip.state === 'indexed'));
  return readable ? '' : '请重新扫描可读取的素材';
}

export function mixFolderLocked() { return state.busy || !!(state.job && !terminal(state.job)) || !!(state.pending && !state.pending.id); }

export function mixReadiness(ctx = state.ctx) {
  const folderHint = folderReadiness();
  if (folderHint) return folderHint;
  if (!ctx?.configs?.mix?.prompt?.trim()) return '填写宣传文案后即可开始';
  if (state.busy || state.job && !terminal(state.job)) return '正在制作，请保持网页连接';
  if (state.pending && !state.pending.id) return '请确认上次提交的任务状态';
  return '';
}

export function renderMixMaterials(ctx = state.ctx) {
  const status = state.status;
  const icon = ctx?.icon?.('folder') || '';
  const missing = state.health && !state.health.configured ? `生成服务待配置${state.health.missing?.length ? '：' + state.health.missing.join('、') : ''}` : '';
  const indexed = status.total ? `<span>已扫描 ${status.scanned} 个视频 · 已索引 ${status.indexed}/${status.total} 个片段</span>` : '';
  const progress = status.uploadTotal ? `<progress max="${status.uploadTotal}" value="${status.uploadBytes || 0}" aria-label="临时素材上传进度"></progress>` : status.total ? `<progress max="${status.total}" value="${status.indexed}" aria-label="素材索引进度"></progress>` : '';
  const jobState = state.job ? `<span>${escape(mixJobLabel(state.job))}</span>` : '';
  const locked = mixFolderLocked();
  const disabled = locked ? 'disabled title="制作时请保持原素材文件夹连接"' : '';
  const scan = status.connected && !status.needsPermission;
  const resumeHint = state.busy ? '正在继续制作' : folderReadiness();
  const resume = resumable(state.job) ? `<button data-action="mix-resume-job" ${resumeHint ? `disabled title="${escape(resumeHint)}"` : ''}>继续制作</button>` : '';
  return `<div class="mix-material-status" id="mix-material-status" role="status" aria-live="polite"><div class="mix-status-label">${icon}<strong>${escape(status.folderName || '本地素材文件夹')}</strong></div><span>${escape(status.text)}</span>${indexed}${progress}${jobState}${missing ? `<small>${escape(missing)}</small>` : ''}${status.error || state.error || state.job?.error ? `<small class="mix-status-error">${escape(status.error || state.error || state.job.error)}</small>` : ''}<small>原视频保留在本机，制作时临时传输命中的素材。网页关闭后会暂停读取。</small><div class="mix-folder-actions"><button data-action="mix-${scan ? 'scan' : 'choose-folder'}" ${scan ? disabled : ''}>${status.needsPermission ? '重新连接' : scan ? '扫描新增 / 修改' : '选择文件夹'}</button>${status.connected ? `<button data-action="mix-choose-folder" ${status.needsPermission ? '' : disabled}>更换</button><button data-action="mix-disconnect" ${disabled}>断开</button>` : ''}${resume}${state.pending && !state.pending.id && !state.busy ? '<button data-action="mix-retry-submit">重试这次提交</button>' : ''}${state.error && state.job ? '<button data-action="mix-refresh-job">刷新任务</button>' : ''}</div></div>`;
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
  const hint = mixReadiness();
  const generate = root.querySelector('[data-action="studio-generate"]');
  if (generate) { generate.disabled = !!hint; generate.title = hint; }
  const hintNode = root.querySelector('#studio-generation-hint');
  if (hintNode) hintNode.textContent = hint || `${state.status.indexed} 个片段可供匹配`;
  const jobNode = root.querySelector('#mix-job-progress');
  if (jobNode && state.job) jobNode.textContent = mixJobLabel();
  const resultButton = root.querySelector('[data-action="mix-show-result"]');
  if (resultButton) resultButton.hidden = !complete(state.job) || state.view === 'result';
  root.querySelectorAll('[data-action="mix-choose-folder"], [data-action="mix-disconnect"], [data-action="mix-scan"]').forEach(button => {
    const locked = mixFolderLocked() && (button.dataset.action !== 'mix-choose-folder' || state.status.connected && !state.status.needsPermission);
    button.disabled = locked;
    button.title = locked ? '制作时请保持原素材文件夹连接' : '';
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
  if (state.busy || !resumable(state.job)) return;
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
      (async () => { state.health = await request('/api/mix/health'); guard(revision); updateStatus(); })(),
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

export function bindMixMaterials(ctx) { state.ctx = ctx; state.refreshPanels = ctx.refreshMixPanels || state.refreshPanels; updateStatus(); }

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
        ratio: c.ratio, quality: c.quality, subtitles: c.subtitles, music: false, count: 1, duration: null } };
      state.view = 'result';
      submit(state.pending);
    }
    return true;
  }
  if (!action.startsWith('mix-')) return false;
  switch (action) {
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
    case 'mix-retry-submit': if (state.pending?.key && !state.busy) submit(state.pending); break;
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
