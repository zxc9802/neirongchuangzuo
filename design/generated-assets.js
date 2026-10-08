const RETENTION_MS = 72 * 60 * 60 * 1000;
const TYPES = { all: '全部', image: '图片', video: '视频', audio: '音频' };
const state = { ctx: null, type: 'all', limit: 24, records: [], errors: [], loading: false, controller: null, timer: null, revision: 0 };

function timestamp(value) {
  if (value == null || value === '') return NaN;
  return new Date(value).getTime();
}

export function generatedAssetWindow(task, now = Date.now()) {
  if (task?.status !== 'completed' || task.expired || task.outputExpired) return null;
  const completed = timestamp(task.completedAt ?? task.updatedAt ?? task.createdAt);
  const serverExpiry = timestamp(task.expiresAt);
  const expires = Math.min(completed + RETENTION_MS, Number.isFinite(serverExpiry) ? serverExpiry : Infinity);
  return Number.isFinite(completed) && completed <= now && expires > now ? { completed, expires } : null;
}

function localUrl(value, pattern) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return '';
  return pattern.test(value) ? value : '';
}

function imageTitle(prompt) {
  const text = String(prompt || '图片作品');
  const title = /(?:^|\n)主标题[：:]\s*([^\n]+)/.exec(text)?.[1];
  return (title || '图片作品').slice(0, 64);
}

// Only successful generated outputs enter the library; uploads and example images never do.
export function collectGeneratedAssets(imageTasks = [], avatarTasks = [], now = Date.now(), restaurantTasks = []) {
  const records = [];
  for (const task of imageTasks) {
    const window = generatedAssetWindow(task, now);
    if (!window || typeof task.id !== 'string') continue;
    for (const [index, image] of (Array.isArray(task.images) ? task.images : []).entries()) {
      const url = localUrl(image?.url, /^\/api\/ai\/media\/[a-f\d-]+\/result-(?:[1-9]|1[0-5])\.(?:png|jpg|webp)$/i);
      if (!url || !url.startsWith(`/api/ai/media/${task.id}/`)) continue;
      records.push({ key: `image:${task.id}:${index}`, type: 'image', source: 'AI 图片', title: imageTitle(task.prompt), url, download: url + '?download=1', filename: image.filename || 'generated-image.png', ...window });
    }
  }
  for (const task of avatarTasks) {
    const window = generatedAssetWindow(task, now);
    if (!window || typeof task.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(task.id) || (task.billing?.isExternalUser && task.billing.status !== 'settled')) continue;
    const base = `/api/tasks/${encodeURIComponent(task.id)}`;
    const title = String(task.inputs?.scriptText || '数字人作品').split('\n')[0].slice(0, 64);
    for (const [type, field, kind, filename] of [['video', 'finalVideoUrl', 'final', 'final.mp4'], ['audio', 'exactAudioUrl', 'voice', task.results?.audioFormat === 'mp3' ? 'voice-track.mp3' : 'voice-track.wav']]) {
      if (task.results?.[field] !== `${base}/media/${kind}`) continue;
      records.push({ key: `avatar:${task.id}:${type}`, type, source: '数字人', title, url: `${base}/media/${kind}`, download: `${base}/download/${filename}`, filename, ...window });
    }
  }
  for (const task of restaurantTasks) {
    const window = generatedAssetWindow(task, now);
    if (!window || task.filesExpired || task.review?.status === 'blocked' || typeof task.id !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(task.id)) continue;
    for (const file of Array.isArray(task.files) ? task.files : []) {
      if (file?.role !== 'image' || file.expired || !/^(?:0[1-9]|1[0-5])\.(?:jpg|png|webp)$/i.test(file.filename || '')) continue;
      const url = localUrl(file.url, /^\/api\/restaurant\/tasks\/[a-f\d-]{36}\/files\/(?:0[1-9]|1[0-5])\.(?:jpg|png|webp)$/i);
      if (!url || url !== `/api/restaurant/tasks/${task.id}/files/${file.filename}`) continue;
      const fileExpiry = timestamp(file.expiresAt);
      const expires = Math.min(window.expires, fileExpiry);
      if (!Number.isFinite(expires) || expires <= now) continue;
      const title = String(task.copy?.titles?.[0] || task.selection?.direction?.label || task.selectedDirection?.label || task.profileSnapshot?.name || '餐饮图文').slice(0, 64);
      records.push({ key: `restaurant:${task.id}:${file.filename}`, type: 'image', source: '餐饮小红书', title, url, download: url, filename: file.filename, completed: window.completed, expires });
    }
  }
  return [...new Map(records.map(record => [record.key, record])).values()].sort((a, b) => b.completed - a.completed);
}

function dateLabel(value) {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function remainingLabel(expires) {
  const hours = Math.max(1, Math.ceil((expires - Date.now()) / 3600000));
  return hours > 24 ? `剩余 ${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `剩余 ${hours} 小时`;
}
function available() { return state.records.filter(record => record.expires > Date.now()); }
function active() { return state.ctx && document.body.dataset.page === 'assets'; }

function renderResults(ctx) {
  const { button, esc, icon } = ctx;
  const records = available();
  const filtered = records.filter(record => state.type === 'all' || record.type === state.type);
  const filters = `<div class="generated-assets-filters" role="group" aria-label="成品类型">${Object.entries(TYPES).map(([type, label]) => button('generated-assets-filter', `${label}<span>${type === 'all' ? records.length : records.filter(item => item.type === type).length}</span>`, type === state.type ? 'selected' : '', `data-type="${type}" aria-pressed="${type === state.type}"`)).join('')}</div>`;
  const errors = state.errors.length ? `<div class="generated-assets-errors" role="status">${state.errors.map(error => `<p>${esc(error)}</p>`).join('')}${button('generated-assets-refresh', '重新加载', 'textbutton')}</div>` : '';
  if (state.loading && !records.length) return filters + `<div class="generated-assets-empty" role="status">${icon('clock')}<h2>正在读取生成的作品</h2><p>图片、视频和配音会集中显示在这里。</p></div>`;
  if (!filtered.length) return filters + errors + `<div class="generated-assets-empty">${icon('folder')}<h2>${records.length ? `近 3 天还没有${TYPES[state.type]}成品` : state.errors.length ? '暂时没有可展示的成品' : '近 3 天还没有生成作品'}</h2><p>生成成功的作品会自动进入资产，请在到期前下载保存。</p>${button('generated-assets-create', '去生成图片 ' + icon('arrow'), 'primary')}</div>`;
  return filters + errors + `<div class="generated-assets-grid">${filtered.slice(0, state.limit).map(record => `<article class="generated-asset-card"><button class="generated-asset-cover ${record.type}" data-action="generated-asset-preview" data-key="${esc(record.key)}" aria-label="${record.type === 'image' ? '查看图片' : record.type === 'video' ? '播放视频' : '试听配音'}：${esc(record.title)}">${record.type === 'image' ? `<img src="${esc(record.url)}" alt="${esc(record.title)}" loading="lazy">` : record.type === 'video' ? `<video src="${esc(record.url)}" preload="metadata" muted playsinline aria-hidden="true"></video><span class="generated-asset-play">${icon('play')}</span>` : `<span class="generated-asset-audio">${icon('audio')}<small>生成配音</small></span>`}<span class="generated-asset-kind">${esc(record.source)} · ${TYPES[record.type]}</span></button><div class="generated-asset-copy"><h2 title="${esc(record.title)}">${esc(record.title)}</h2><time datetime="${new Date(record.completed).toISOString()}">${dateLabel(record.completed)} 生成</time><div class="generated-asset-footer"><span class="generated-asset-expiry ${record.expires - Date.now() <= 24 * 3600000 ? 'soon' : ''}" title="${dateLabel(record.expires)} 到期">${remainingLabel(record.expires)}</span><a href="${esc(record.download)}" download="${esc(record.filename)}" class="generated-asset-download" aria-label="下载${TYPES[record.type]}：${esc(record.title)}">${icon('save')}下载</a></div><small class="generated-asset-deadline">${dateLabel(record.expires)} 到期清理</small></div></article>`).join('')}</div>${filtered.length > state.limit ? `<div class="generated-assets-more">${button('generated-assets-more', '加载更多作品', 'secondary')}</div>` : ''}`;
}

export function renderGeneratedAssets(ctx) {
  return `<section class="generated-assets-heading"><div><span class="generated-assets-eyebrow">我的创作</span><h1>生成资产 <span>近 3 天</span></h1><p>网站生成的图片、视频与配音，集中在这里。</p></div>${ctx.button('generated-assets-refresh', ctx.icon('refresh') + '刷新作品', 'secondary')}</section><div class="generated-assets-policy">${ctx.icon('clock')}<p>每份成品自生成成功起保留 <strong>72 小时</strong>，到期自动清理，请及时下载。</p></div><section id="generated-assets-results" aria-label="已生成素材">${renderResults(ctx)}</section>`;
}

function paint() {
  if (!active()) return;
  const results = document.querySelector('#generated-assets-results');
  if (results) results.innerHTML = renderResults(state.ctx);
}
function scheduleExpiry() {
  clearTimeout(state.timer);
  const next = Math.min(...available().map(record => record.expires));
  if (!active() || !Number.isFinite(next)) return;
  state.timer = setTimeout(() => {
    if (!active()) return;
    const preview = document.querySelector('#generated-asset-preview');
    if (preview && Number(preview.dataset.expires) <= Date.now()) document.querySelector('#modal')?.close();
    paint(); scheduleExpiry();
  }, Math.max(1, next - Date.now() + 10));
}
async function fetchTaskPage(path, signal, source) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal });
  if (response.status === 401 || response.status === 403) throw new Error(`${source}作品需登录后查看。`);
  if (!response.ok) throw new Error(`${source}作品暂时无法加载，请稍后刷新。`);
  const body = await response.json();
  if (!Array.isArray(body.tasks)) throw new Error(`${source}作品列表暂时无法读取。`);
  return body;
}
async function fetchTasks(path, signal, source) { return (await fetchTaskPage(path, signal, source)).tasks; }
async function fetchRestaurantTasks(signal) {
  const tasks = [], cursors = new Set();
  const after = Date.now() - RETENTION_MS;
  let cursor;
  do {
    const page = await fetchTaskPage('/api/restaurant/tasks?limit=50&completed=true&completedAfter=' + after + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), signal, '餐饮图文');
    tasks.push(...page.tasks);
    cursor = page.nextCursor;
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new Error('餐饮图文作品分页暂时无法读取，请刷新重试。');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tasks;
}
async function load() {
  if (!active() || state.loading) return;
  const revision = ++state.revision;
  const controller = new AbortController(); state.controller = controller;
  const timer = setTimeout(() => controller.abort(), 15000);
  state.loading = true; paint();
  const sources = ['图片', '数字人', '餐饮图文'];
  const results = await Promise.allSettled([fetchTasks('/api/ai/images?completed=true', controller.signal, sources[0]), fetchTasks('/api/tasks?completed=true', controller.signal, sources[1]), fetchRestaurantTasks(controller.signal)]);
  clearTimeout(timer);
  if (revision !== state.revision || !active()) return;
  state.errors = results.flatMap((result, index) => result.status === 'rejected' ? [result.reason?.name === 'AbortError' ? `${sources[index]}作品读取超时，请刷新重试。` : /[\u3400-\u9fff]/.test(result.reason?.message) ? result.reason.message : `${sources[index]}作品暂时无法读取。`] : []);
  const [images, avatars, restaurant] = results.map(result => result.status === 'fulfilled' ? result.value : []);
  state.records = collectGeneratedAssets(images, avatars, Date.now(), restaurant);
  state.loading = false; state.controller = null; paint(); scheduleExpiry();
}
export function bindGeneratedAssets(ctx) { state.ctx = ctx; void load(); }
export function disposeGeneratedAssets() {
  state.revision++; state.controller?.abort(); state.controller = null; clearTimeout(state.timer); state.loading = false; state.ctx = null; state.records = []; state.errors = [];
}
export function handleGeneratedAssetsAction(action, element, ctx) {
  if (ctx.mode !== 'assets') return false;
  if (action === 'generated-assets-refresh') { state.limit = 24; void load(); return true; }
  if (action === 'generated-assets-create') { ctx.navigate('image'); return true; }
  if (action === 'generated-assets-more') { state.limit += 24; paint(); return true; }
  if (action === 'generated-assets-filter') {
    state.limit = 24;
    if (Object.hasOwn(TYPES, element.dataset.type)) state.type = element.dataset.type;
    paint();
    document.querySelector(`[data-action="generated-assets-filter"][data-type="${state.type}"]`)?.focus({ preventScroll: true });
    return true;
  }
  if (action === 'generated-asset-preview') {
    const record = available().find(item => item.key === element.dataset.key);
    if (!record) { paint(); ctx.toast('这份成品已到期，请刷新作品列表。'); return true; }
    const url = ctx.esc(record.url);
    const media = record.type === 'image' ? `<img src="${url}" alt="${ctx.esc(record.title)}">` : record.type === 'video' ? `<video src="${url}" controls playsinline preload="metadata" aria-label="生成视频"></video>` : `<div class="generated-preview-audio">${ctx.icon('audio')}<audio src="${url}" controls preload="metadata" aria-label="生成配音"></audio></div>`;
    ctx.openModal(record.title, `${record.source} · ${dateLabel(record.expires)} 到期`, `<div id="generated-asset-preview" class="generated-asset-preview" data-expires="${record.expires}">${media}</div><footer class="modal-actions"><a class="primary" href="${ctx.esc(record.download)}" download="${ctx.esc(record.filename)}">${ctx.icon('save')}下载${TYPES[record.type]}</a></footer>`, true);
    return true;
  }
  return false;
}
