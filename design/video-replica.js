import { billingPointsText, creditEstimateText, observeCreditTask, refreshWorkspaceCredits, subscribeWorkspaceCredits, workspaceCreditsState } from './workspace-credits.js';

const API = '/api/video-replica';
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128';
const labels = { draft: '等待提交', reserving: '正在预留积分', preparing: '正在自动分析字幕与人声', reviewing: '正在审核人物素材', submitting: '正在提交生成', running: '正在替换人物', downloading: '正在保存成片', verifying: '正在核对台词与开口时间', settling: '正在确认积分', completed: '复刻完成', failed: '生成未完成', expired: '已过期' };
const pending = task => task && !['draft', 'completed', 'failed', 'expired'].includes(task.status);
let state = { owner: null, config: null, tasks: [], current: null, files: {}, urls: {}, busy: false, error: '', pollError: '', loading: true };
let context, timer, polling = false, unsubscribeCredits;
function resetFiles() { for (const url of Object.values(state.urls)) URL.revokeObjectURL(url); state.files = {}; state.urls = {}; }
function account() {
  const owner = globalThis.workspaceUser?.id || 'local-dev';
  if (state.owner !== owner) { resetFiles(); state = { owner, config: null, tasks: [], current: null, files: {}, urls: {}, busy: false, error: '', pollError: '', loading: true }; }
}
async function request(path, options = {}) {
  const signal = options.method ? undefined : AbortSignal.timeout(15_000);
  try {
    const response = await fetch(API + path, { credentials: 'same-origin', cache: 'no-store', signal, ...options });
    let data;
    try { data = await response.json(); } catch { throw new Error('视频服务暂时不可用，请刷新任务记录。'); }
    if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。');
    return data;
  } catch (cause) {
    if (signal?.aborted) throw new Error('查询任务超时，正在自动重试；不会重新生成。');
    throw cause;
  }
}
function jsonPost(body = {}) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
function remember(task) {
  state.current = task;
  state.tasks = [task, ...state.tasks.filter(item => item.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt);
  observeCreditTask(task);
}
function refresh() { if (context && document.body.dataset.page === 'video') context.refresh(); }
function failureMessage(task) {
  return task?.canRecheck ? task.error?.replace('请核对素材后重新生成。', '请重新检查成片。') : task?.error;
}
function actionMessage() {
  if (state.error || state.pollError) return state.error || state.pollError;
  if (state.busy) return '';
  if (state.current?.status === 'verifying') return '正在核对已有成片的台词与开口时间，请稍候。';
  if (state.current?.status === 'failed') return failureMessage(state.current);
  return !state.loading && !state.config?.enabled ? '人物复刻服务尚未配置，请联系管理员。' : '';
}
function slot(kind, ctx) {
  const video = kind === 'video', voice = kind === 'voice', title = video ? '参考视频' : voice ? '声音参考' : '目标人物照片', selected = state.files[kind];
  const saved = state.current?.[kind];
  const disabled = state.busy || pending(state.current) || state.current && state.current.status !== 'draft' || voice && !state.config?.voiceEnabled;
  const source = state.urls[kind] || state.current?.[video ? 'sourceVideoUrl' : voice ? 'sourceVoiceUrl' : 'sourcePhotoUrl'];
  const preview = source ? video
    ? `<video src="${ctx.esc(source)}" controls playsinline preload="metadata" aria-label="参考视频预览"></video>`
    : voice ? `<audio src="${ctx.esc(source)}" controls preload="metadata" aria-label="声音参考试听"></audio>`
      : `<img src="${ctx.esc(source)}" alt="目标人物照片预览">` : `<div class="replica-upload-symbol">${ctx.icon(video ? 'video' : voice ? 'audio' : 'image')}</div>`;
  return `<section class="replica-upload ${voice ? 'replica-voice-slot' : ''}"><div class="replica-slot-title"><span>${video ? '01' : voice ? '03' : '02'}</span><h3>${title}${voice ? '<small>选填 · 更换音色</small>' : ''}</h3></div>
    <div class="replica-input-preview">${preview}</div>
    <strong class="replica-file-name">${ctx.esc(selected?.name || (saved ? '素材已上传并保存' : video ? '上传你想保留动作的视频' : voice ? '选择想使用的单人声音' : '上传你想替换成的人物'))}</strong>
    <p>${video ? '单个人物 · 2–15 秒 · MP4 / MOV · 最大 50 MB' : voice ? state.config && !state.config.voiceEnabled ? '声音分析服务尚未配置，请联系管理员。' : '清晰单人声音 · 2–15 秒 · MP3 / WAV · 最大 15 MB' : '清晰正脸 · JPG / PNG / WebP · 最大 10 MB'}</p>
    <input id="replica-${kind}" type="file" accept="${video ? 'video/mp4,video/quicktime,.mp4,.mov' : voice ? 'audio/mpeg,audio/wav,.mp3,.wav' : 'image/jpeg,image/png,image/webp'}" ${disabled ? 'disabled' : ''} aria-label="上传${title}">
    <label for="replica-${kind}" class="secondary replica-file-button ${disabled ? 'disabled' : ''}">${selected || saved ? '更换' : '选择'}${title}</label></section>`;
}
function result(ctx) {
  const task = state.current;
  if (!task) return `<div class="replica-empty">${ctx.icon('video')}<h3>原视频的表演，照片中的人物</h3><p>保留动作、镜头与说话内容<br>人物形象跟随照片，自然表达情绪</p><span>成片在这里预览</span></div>`;
  if (task.resultUrl) return `<video controls playsinline preload="metadata" src="${ctx.esc(task.resultUrl)}" aria-label="人物复刻成片"></video>`;
  const message = task.status === 'failed' ? failureMessage(task) : task.error;
  return `<div class="replica-empty ${pending(task) ? 'replica-working' : ''}"><div class="replica-progress-symbol">${ctx.icon(task.status === 'failed' ? 'info' : 'video')}</div><h3>${labels[task.status] || '正在处理'}</h3><p>${ctx.esc(message || (pending(task) ? '任务正在处理，可以离开页面，稍后回来查看。' : task.status === 'draft' ? '素材就绪后，点击一键生成。' : '请重新上传素材创建任务。'))}</p></div>`;
}
function progress(ctx) {
  const task = state.current;
  if (!pending(task)) return '';
  const now = Date.now(), elapsed = Math.max(0, now - (task.startedAt || task.createdAt));
  const duration = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; };
  const received = Number(task.downloadProgress?.receivedBytes), total = Number(task.downloadProgress?.totalBytes);
  const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const download = Number.isFinite(received) && received >= 0 ? `<p>保存成片：${mb(received)}${total > 0 ? ` / ${mb(total)}` : ''}</p>${total > 0 ? `<progress aria-label="成片保存进度" max="${total}" value="${Math.min(received, total)}"></progress>` : ''}` : '';
  return `<p>已等待 ${duration(elapsed)} · ${task.lastCheckedAt ? `最近收到模型回复：${duration(now - task.lastCheckedAt)}前` : '等待模型回复'}</p>${download}
    ${state.pollError ? `<p class="replica-error">${ctx.esc(state.pollError)}</p>` : elapsed >= 600_000 ? '<p>等待时间较长，仍在查询原任务，请勿重复提交。</p>' : ''}
    <small>任务编号：${ctx.esc(task.id)}</small>`;
}
function history(ctx) {
  return state.tasks.length ? state.tasks.map(task => `<button type="button" class="replica-history-item ${task.id === state.current?.id ? 'active' : ''}" data-replica-task="${ctx.esc(task.id)}" ${state.busy ? 'disabled' : ''}><span>${labels[task.status] || '正在处理'}</span><small>${ctx.esc(new Date(task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))} · ${task.duration || '—'} 秒</small></button>`).join('') : '<p class="replica-muted">你的复刻记录会保存在这里</p>';
}
function summary(ctx) {
  const task = state.current;
  return task ? `<div><strong>${labels[task.status] || '正在处理'}</strong><span>${ctx.esc(task.modelName || '旗舰模型')} · ${task.actualDuration || task.duration || '—'} 秒 · ${ctx.esc(task.ratio || '自动比例')} · ${ctx.esc(task.resolution || '720p')}${billingPointsText(task) ? ` · ${ctx.esc(billingPointsText(task))}` : ''}</span>${task.captionCheck?.warning ? `<span>${ctx.esc(task.captionCheck.warning)}</span>` : ''}${task.audioCheck ? `<span>${task.audioCheck.warning ? ctx.esc(task.audioCheck.warning) : `${task.audioCheck.transcriptDifferences ? `台词有 ${ctx.esc(task.audioCheck.transcriptDifferences)} 字轻微识别差异` : '台词一致'} · 开口偏差 ${Math.abs(task.audioCheck.afterOffsetMs)} 毫秒；请预览核对台词、音色与口型。`}</span>` : ''}</div>${task.resultUrl ? `<a class="primary replica-download" href="${ctx.esc(task.resultUrl)}?download=1" download>下载成片</a>` : ''}` : '';
}
export function renderVideoReplica(ctx) {
  account(); context = ctx;
  const task = state.current, finished = task && ['completed', 'failed', 'expired'].includes(task.status);
  const unlimited = workspaceCreditsState().snapshot?.unlimited === true, exempt = task?.billing?.exempt === true;
  const cost = unlimited ? `${creditEstimateText(task?.estimatedPoints)}${task?.duration ? ` · ${task.duration} 秒` : ''}`
    : exempt ? task?.duration ? `${task.duration} 秒` : '上传后自动识别时长。'
      : task?.estimatedPoints ? `预计冻结 ${task.estimatedPoints} 积分 · ${task.duration} 秒 · 成功后按成片时长结算，不超过预估` : '按视频时长预留积分；失败退回预留积分。';
  return `<div class="replica-heading"><div><span class="replica-eyebrow">AI 视频 · 旗舰模型</span><h1>人物 1:1 复刻</h1><p>上传一个视频和一张照片，让照片中的人物出演原视频。</p></div><span class="replica-badge">人物替换</span></div>
    <div class="replica-layout"><section class="replica-form"><div class="replica-uploads">${slot('video', ctx)}${slot('photo', ctx)}${slot('voice', ctx)}</div>
      <p class="replica-note">请使用有权使用的视频和人物照片。人物相似度与表演效果以实际生成结果为准。</p>
      <div class="replica-submit-area"><p id="replica-cost">${ctx.esc(cost)}</p><p id="replica-error" class="replica-error" role="alert">${ctx.esc(actionMessage())}</p>
        <button type="button" id="replica-submit" class="primary" ${finished ? 'hidden' : ''} ${state.busy || pending(task) || finished || !state.config?.enabled ? 'disabled' : ''}>${state.busy ? '正在上传并提交…' : pending(task) ? labels[task.status] : '一键生成'}</button>
        ${task?.status === 'failed' && task.canRecheck === true ? `<button type="button" id="replica-recheck" class="primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在提交复核…' : '重新检查成片'}</button>` : ''}<button type="button" id="replica-new" class="textbutton" ${state.busy ? 'disabled' : ''}>新建复刻</button></div></section>
      <section class="replica-output"><div class="replica-output-title"><h2>成片预览</h2><span>结果保留 3 天</span></div><div id="replica-result" class="replica-player">${result(ctx)}</div><div id="replica-result-summary" class="replica-result-summary">${summary(ctx)}</div><div id="replica-progress" class="replica-progress" aria-live="polite">${progress(ctx)}</div><div class="replica-history-heading"><h3>最近的复刻</h3><button type="button" id="replica-refresh" class="textbutton">刷新记录</button></div><div id="replica-history" class="replica-history">${history(ctx)}</div></section></div>`;
}
async function selectFile(kind, file) {
  if (!file) return;
  const limit = kind === 'video' ? 50 : kind === 'voice' ? 15 : 10;
  if (file.size > limit * 1024 * 1024) { state.error = `文件过大，${kind === 'video' ? '视频' : kind === 'voice' ? '声音参考' : '照片'}不能超过 ${limit} MB。`; refresh(); return; }
  if (state.urls[kind]) URL.revokeObjectURL(state.urls[kind]);
  state.files[kind] = file; state.urls[kind] = URL.createObjectURL(file); state.error = ''; refresh();
}
async function submit() {
  if (state.busy || pending(state.current) || state.current && state.current.status !== 'draft') return;
  if ((!state.files.video && !state.current?.video) || (!state.files.photo && !state.current?.photo)) { state.error = '请先上传一段参考视频和一张人物照片。'; refresh(); return; }
  state.busy = true; state.error = ''; refresh();
  try {
    const id = state.current?.id || crypto.randomUUID();
    const model = DEFAULT_MODEL;
    // Keep the request ID before networking so an uncertain response can be retried safely.
    if (!state.current) state.current = { id, status: 'draft', createdAt: Date.now() };
    remember((await request('/tasks', jsonPost({ requestId: id, model }))).task);
    if (state.current.status === 'draft') {
      for (const kind of ['video', 'photo', 'voice']) {
        if (!state.files[kind]) continue;
        remember((await request(`/tasks/${id}/${kind}`, { method: 'PUT', headers: { 'Content-Type': state.files[kind].type || 'application/octet-stream' }, body: state.files[kind] })).task);
      }
      resetFiles();
      remember((await request(`/tasks/${id}/start`, jsonPost({ model }))).task);
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
async function poll() {
  if (polling || state.busy || !context) return;
  polling = true;
  const owner = state.owner;
  try {
    const [config, data] = await Promise.all([state.config ? Promise.resolve(state.config) : request('/config'), request('/tasks')]);
    if (state.owner !== owner) return;
    const previous = state.current && JSON.stringify({ ...state.current, lastCheckedAt: null }), firstLoad = state.loading;
    state.config = config; state.tasks = data.tasks; state.loading = false; state.pollError = '';
    if (state.current) state.current = data.tasks.find(item => item.id === state.current.id) || state.current;
    else if (firstLoad && !Object.keys(state.files).length) state.current = data.tasks.find(pending)
      || data.tasks.find(task => task.resultUrl || task.status === 'failed') || null;
    for (const task of data.tasks) observeCreditTask(task);
    if (!document.querySelector('#replica-submit')) return;
    if (firstLoad || previous !== (state.current && JSON.stringify({ ...state.current, lastCheckedAt: null }))) refresh();
    else { document.querySelector('#replica-history').innerHTML = history(context); document.querySelector('#replica-error').textContent = actionMessage(); }
    const details = document.querySelector('#replica-progress'); if (details) details.innerHTML = progress(context);
  } catch (cause) {
    state.pollError = cause.message;
    const message = document.querySelector('#replica-error'); if (message) message.textContent = actionMessage();
    const details = document.querySelector('#replica-progress'); if (details && context) details.innerHTML = progress(context);
  } finally { polling = false; }
}
export function bindVideoReplica(ctx) {
  context = ctx;
  if (!unsubscribeCredits) unsubscribeCredits = subscribeWorkspaceCredits(refresh);
  for (const kind of ['video', 'photo', 'voice']) document.querySelector(`#replica-${kind}`).onchange = event => { void selectFile(kind, event.target.files[0]); };
  const retry = document.querySelector('#replica-recheck'); if (retry) retry.onclick = () => { void recheck(); };
  document.querySelector('#replica-submit').onclick = () => { void submit(); };
  document.querySelector('#replica-new').onclick = () => { resetFiles(); state.current = null; state.error = ''; refresh(); };
  document.querySelector('#replica-refresh').onclick = () => { state.error = ''; state.pollError = ''; void poll(); };
  document.querySelector('#replica-history').onclick = event => {
    const button = event.target.closest('[data-replica-task]'); if (!button || state.busy) return;
    resetFiles(); state.current = state.tasks.find(task => task.id === button.dataset.replicaTask); state.error = ''; refresh();
  };
  if (!timer) { void poll(); timer = setInterval(() => { void poll(); }, 5000); }
}
export function disposeVideoReplica() { clearInterval(timer); timer = null; context = null; unsubscribeCredits?.(); unsubscribeCredits = null; }
