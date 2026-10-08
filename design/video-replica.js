import { billingPointsText, observeCreditTask, refreshWorkspaceCredits } from './workspace-credits.js';

const API = '/api/video-replica';
const labels = { draft: '等待提交', reserving: '正在预留积分', reviewing: '正在审核人物素材', submitting: '正在提交生成', running: '正在替换人物', downloading: '正在保存成片', settling: '正在确认积分', completed: '复刻完成', failed: '生成未完成', expired: '已过期' };
const pending = task => task && !['draft', 'completed', 'failed', 'expired'].includes(task.status);
let state = { owner: null, config: null, tasks: [], current: null, files: {}, urls: {}, busy: false, error: '', loading: true };
let context, timer, polling = false;
function resetFiles() { for (const url of Object.values(state.urls)) URL.revokeObjectURL(url); state.files = {}; state.urls = {}; state.uploaded = false; }
function account() {
  const owner = globalThis.workspaceUser?.id || 'local-dev';
  if (state.owner !== owner) { resetFiles(); state = { owner, config: null, tasks: [], current: null, files: {}, urls: {}, busy: false, error: '', loading: true }; }
}
async function request(path, options = {}) {
  const response = await fetch(API + path, { credentials: 'same-origin', cache: 'no-store', ...options });
  let data;
  try { data = await response.json(); } catch { throw new Error('视频服务暂时不可用，请刷新任务记录。'); }
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。');
  return data;
}
function jsonPost(body = {}) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
function remember(task) {
  state.current = task;
  state.tasks = [task, ...state.tasks.filter(item => item.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt);
  observeCreditTask(task);
}
function refresh() { if (context && document.body.dataset.page === 'video') context.refresh(); }
function slot(kind, ctx) {
  const video = kind === 'video', title = video ? '参考视频' : '目标人物照片', selected = state.files[kind];
  const saved = state.current?.[kind];
  const disabled = state.busy || pending(state.current) || state.current && state.current.status !== 'draft';
  const source = state.urls[kind] || state.current?.[video ? 'sourceVideoUrl' : 'sourcePhotoUrl'];
  const preview = source ? video
    ? `<video src="${ctx.esc(source)}" controls playsinline preload="metadata" aria-label="参考视频预览"></video>`
    : `<img src="${ctx.esc(source)}" alt="目标人物照片预览">` : `<div class="replica-upload-symbol">${ctx.icon(video ? 'video' : 'image')}</div>`;
  return `<section class="replica-upload"><div class="replica-slot-title"><span>${video ? '01' : '02'}</span><h3>${title}</h3></div>
    <div class="replica-input-preview">${preview}</div>
    <strong class="replica-file-name">${ctx.esc(selected?.name || (saved ? '素材已上传并保存' : video ? '上传你想保留动作的视频' : '上传你想替换成的人物'))}</strong>
    <p>${video ? '单个人物 · 2–15 秒 · MP4 / MOV · 最大 50 MB' : '清晰正脸 · JPG / PNG / WebP · 最大 10 MB'}</p>
    <input id="replica-${kind}" type="file" accept="${video ? 'video/mp4,video/quicktime,.mp4,.mov' : 'image/jpeg,image/png,image/webp'}" ${disabled ? 'disabled' : ''} aria-label="上传${title}">
    <label for="replica-${kind}" class="secondary replica-file-button ${disabled ? 'disabled' : ''}">${selected || saved ? '更换' : '选择'}${title}</label></section>`;
}
function result(ctx) {
  const task = state.current;
  if (!task) return `<div class="replica-empty">${ctx.icon('video')}<h3>原视频的表演，照片中的人物</h3><p>保留动作、镜头与说话内容<br>人物形象跟随照片，自然表达情绪</p><span>成片在这里预览</span></div>`;
  if (task.resultUrl) return `<video controls playsinline preload="metadata" src="${ctx.esc(task.resultUrl)}" aria-label="人物复刻成片"></video>`;
  return `<div class="replica-empty ${pending(task) ? 'replica-working' : ''}"><div class="replica-progress-symbol">${ctx.icon(task.status === 'failed' ? 'info' : 'video')}</div><h3>${labels[task.status] || '正在处理'}</h3><p>${ctx.esc(task.error || (pending(task) ? '生成通常需要几分钟，可以离开页面，稍后回来查看。' : task.status === 'draft' ? '素材就绪后，点击开始人物复刻。' : '请重新上传素材创建任务。'))}</p></div>`;
}
function history(ctx) {
  return state.tasks.length ? state.tasks.map(task => `<button type="button" class="replica-history-item ${task.id === state.current?.id ? 'active' : ''}" data-replica-task="${ctx.esc(task.id)}" ${state.busy ? 'disabled' : ''}><span>${labels[task.status] || '正在处理'}</span><small>${ctx.esc(new Date(task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))} · ${task.duration || '—'} 秒</small></button>`).join('') : '<p class="replica-muted">你的复刻记录会保存在这里</p>';
}
function summary(ctx) {
  const task = state.current;
  return task ? `<div><strong>${labels[task.status] || '正在处理'}</strong><span>${task.actualDuration || task.duration || '—'} 秒 · ${ctx.esc(task.ratio || '自动比例')} · 720p${billingPointsText(task) ? ` · ${ctx.esc(billingPointsText(task))}` : ''}</span></div>${task.resultUrl ? `<a class="primary replica-download" href="${ctx.esc(task.resultUrl)}?download=1" download>下载成片</a>` : ''}` : '';
}
export function renderVideoReplica(ctx) {
  account(); context = ctx;
  const task = state.current, finished = task && ['completed', 'failed', 'expired'].includes(task.status);
  return `<div class="replica-heading"><div><span class="replica-eyebrow">AI 视频 · SEEDANCE 2.0</span><h1>人物 1:1 复刻</h1><p>上传一个视频和一张照片，让照片中的人物出演原视频。</p></div><span class="replica-badge">人物替换</span></div>
    <div class="replica-layout"><section class="replica-form"><div class="replica-uploads">${slot('video', ctx)}${slot('photo', ctx)}</div>
      <div class="replica-direction"><strong>已为你设定复刻要求</strong><div><span>保持人物形象</span><span>自然情绪与表情</span><span>无字幕、无文字</span></div><details><summary>查看复刻提示词</summary><p>${ctx.esc(state.config?.prompt || '正在读取…')}</p></details></div>
      <p class="replica-note">请使用有权使用的视频和人物照片。人物相似度与表演效果以实际生成结果为准。</p>
      <div class="replica-submit-area"><p id="replica-cost">${task?.estimatedPoints ? `预计冻结 ${task.estimatedPoints} 积分 · ${task.duration} 秒 · 成功后按成片时长结算，不超过预估` : '上传后确认时长和积分；失败退回预留积分。'}</p><p id="replica-error" class="replica-error" role="alert">${ctx.esc(state.error || (!state.loading && !state.config?.enabled ? '人物复刻服务尚未配置，请联系管理员。' : ''))}</p>
        <button type="button" id="replica-submit" class="primary" ${state.busy || pending(task) || finished || !state.config?.enabled ? 'disabled' : ''}>${state.busy ? '正在上传与提交…' : pending(task) ? labels[task.status] : state.uploaded || (task?.photo && task?.video && !Object.keys(state.files).length) ? '开始人物复刻' : '上传素材，查看费用'}</button>
        <button type="button" id="replica-new" class="textbutton" ${state.busy || pending(task) ? 'disabled' : ''}>新建复刻</button></div></section>
      <section class="replica-output"><div class="replica-output-title"><h2>成片预览</h2><span>结果保留 3 天</span></div><div id="replica-result" class="replica-player">${result(ctx)}</div><div id="replica-result-summary" class="replica-result-summary">${summary(ctx)}</div><div class="replica-history-heading"><h3>最近的复刻</h3><button type="button" id="replica-refresh" class="textbutton">刷新记录</button></div><div id="replica-history" class="replica-history">${history(ctx)}</div></section></div>`;
}
async function selectFile(kind, file) {
  if (!file) return;
  const limit = kind === 'video' ? 50 : 10;
  if (file.size > limit * 1024 * 1024) { state.error = `文件过大，${kind === 'video' ? '视频' : '照片'}不能超过 ${limit} MB。`; refresh(); return; }
  if (state.urls[kind]) URL.revokeObjectURL(state.urls[kind]);
  state.uploaded = false; state.files[kind] = file; state.urls[kind] = URL.createObjectURL(file); state.error = ''; refresh();
}
async function submit() {
  if (state.busy || pending(state.current)) return;
  if ((!state.files.video && !state.current?.video) || (!state.files.photo && !state.current?.photo)) { state.error = '请先上传一段参考视频和一张人物照片。'; refresh(); return; }
  state.busy = true; state.error = ''; refresh();
  try {
    const id = state.current?.id || crypto.randomUUID();
    // Keep the request ID before networking so an uncertain response can be retried safely.
    if (!state.current) state.current = { id, status: 'draft', createdAt: Date.now() };
    remember((await request('/tasks', jsonPost({ requestId: id }))).task);
    if (state.current.status === 'draft' && !state.uploaded && Object.keys(state.files).length) {
      for (const kind of ['video', 'photo']) {
        if (!state.files[kind]) continue;
        remember((await request(`/tasks/${id}/${kind}`, { method: 'PUT', headers: { 'Content-Type': state.files[kind].type || 'application/octet-stream' }, body: state.files[kind] })).task);
      }
      state.uploaded = true;
    } else if (state.current.status === 'draft') {
      remember((await request(`/tasks/${id}/start`, jsonPost())).task);
    }
    void refreshWorkspaceCredits();
  } catch (cause) { state.error = cause.message; }
  finally { state.busy = false; refresh(); }
}
async function poll() {
  if (polling || state.busy || !context) return;
  polling = true;
  const owner = state.owner;
  try {
    const [config, data] = await Promise.all([state.config ? Promise.resolve(state.config) : request('/config'), request('/tasks')]);
    if (state.owner !== owner) return;
    const previous = state.current && JSON.stringify(state.current), firstLoad = state.loading;
    state.config = config; state.tasks = data.tasks; state.loading = false;
    if (state.current) state.current = data.tasks.find(item => item.id === state.current.id) || state.current;
    else if (!Object.keys(state.files).length) state.current = data.tasks.find(pending) || null;
    for (const task of data.tasks) observeCreditTask(task);
    if (!document.querySelector('#replica-submit')) return;
    if (firstLoad || previous !== (state.current && JSON.stringify(state.current))) refresh();
    else { document.querySelector('#replica-history').innerHTML = history(context); document.querySelector('#replica-error').textContent = state.error || (!config.enabled ? '人物复刻服务尚未配置，请联系管理员。' : ''); }
  } catch (cause) {
    state.error = cause.message;
    const message = document.querySelector('#replica-error'); if (message) message.textContent = state.error;
  } finally { polling = false; }
}
export function bindVideoReplica(ctx) {
  context = ctx;
  for (const kind of ['video', 'photo']) document.querySelector(`#replica-${kind}`).onchange = event => { void selectFile(kind, event.target.files[0]); };
  document.querySelector('#replica-submit').onclick = () => { void submit(); };
  document.querySelector('#replica-new').onclick = () => { resetFiles(); state.current = null; state.error = ''; refresh(); };
  document.querySelector('#replica-refresh').onclick = () => { state.error = ''; void poll(); };
  document.querySelector('#replica-history').onclick = event => {
    const button = event.target.closest('[data-replica-task]'); if (!button || state.busy) return;
    resetFiles(); state.current = state.tasks.find(task => task.id === button.dataset.replicaTask); state.error = ''; refresh();
  };
  if (!timer) { void poll(); timer = setInterval(() => { void poll(); }, 5000); }
}
export function disposeVideoReplica() { clearInterval(timer); timer = null; context = null; }
