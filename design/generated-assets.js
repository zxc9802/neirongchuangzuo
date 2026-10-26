import { uiLocale, t } from './workspace-preferences.js';
import { imageTaskTitle } from './image-presets.js';
import { digitalHumanModelLabel } from './model-labels.js';
import { assetFolders, materialFolder, organizeAssets, relativeAssetMove } from './asset-organization.js';
import { renderAssetFolders, openFolderEditor, openMaterialMove, openAssetUpload } from './asset-folders.js';
const RETENTION_MS = 72 * 60 * 60 * 1000;
const TYPES = { all: '全部', image: '图片', video: '视频', audio: '音频' };
const state = { ctx: null, category: 'all', folderId: null, type: 'all', materialType: 'all', limit: 24, materialLimit: 24, records: [], materials: [], rawRecords: [], rawMaterials: [], organization: {}, deleted: false, selection: new Set(), busy: false, dragKey: null, errors: [], loading: false, controller: null, timer: null, revision: 0 };
let libraryCache;
function currentLibrary() {
  const owner = globalThis.workspaceUser?.id;
  if (!libraryCache || libraryCache.owner !== owner) {
    libraryCache?.controller.abort();
    libraryCache = { owner, values: [[], [], [], [], [], []], organization: { order: [], deleted: [] }, organizationRevision: 0, errors: [], loadedAt: 0, pending: null, uploads: [], listeners: new Set(), controller: new AbortController() };
  }
  return libraryCache;
}
function librarySnapshot(cache, loading = Boolean(cache.pending)) {
  const [images, avatars, restaurant, videos, creativeVideos, materials] = cache.values;
  const rawMaterials = materials.map(item => ({ ...item, key: `material:${item.id}` }));
  const rawRecords = collectGeneratedAssets(images, avatars, Date.now(), restaurant, videos, creativeVideos).filter(item => !cache.organization.retained?.[item.key]);
  return { rawMaterials, rawRecords, organization: cache.organization,
    materials: organizeAssets(rawMaterials, cache.organization), records: organizeAssets(rawRecords, cache.organization), errors: cache.errors.filter(Boolean), loading };
}
function notifyLibrary(cache) { for (const listener of cache.listeners) listener(librarySnapshot(cache)); }

function displayedMaterials() { return organizeAssets(state.rawMaterials, state.organization, state.deleted).filter(item => (state.category === 'all' || item.type === state.category) && (!state.folderId || materialFolder(item, state.organization) === state.folderId) && (state.materialType === 'all' || item.kind === state.materialType)); }
function displayedRecords() { return organizeAssets(state.rawRecords.filter(item => item.expires > Date.now() && !state.organization.retained?.[item.key]), state.organization, state.deleted).filter(item => !state.folderId && (state.category === 'all' || item.type === state.category) && (state.type === 'all' || item.type === state.type)); }
function assetTools(item, items, ctx) {
  const key = ctx.esc(item.key), index = items.findIndex(value => value.key === item.key), disabled = state.busy ? 'disabled' : '';
  return `<div class="asset-item-tools"><label><input type="checkbox" data-asset-select="${key}" aria-label="选择：${ctx.esc(item.name || item.title)}" ${state.selection.has(item.key) ? 'checked' : ''} ${disabled}>选择</label><div>${state.deleted ? ctx.button('asset-restore', '恢复', 'textbutton', `data-key="${key}" ${disabled}`) : `${ctx.button('asset-move-prev', '前移', 'textbutton', `data-key="${key}" ${disabled || index === 0 ? 'disabled' : ''}`)}${ctx.button('asset-move-next', '后移', 'textbutton', `data-key="${key}" ${disabled || index === items.length - 1 ? 'disabled' : ''}`)}${ctx.button('asset-place', item.permanent ? '移动' : '存为素材', 'textbutton', `data-key="${key}" ${disabled}`)}${ctx.button('asset-delete', '删除', 'textbutton', `data-key="${key}" ${disabled}`)}`}</div></div>`;
}
function organizationToolbar(ctx) {
  const disabled = state.busy ? 'disabled' : '', hasSelection = state.selection.size > 0;
  return `<div class="asset-organization-toolbar"><div>${ctx.button('asset-view-active', '全部资产', state.deleted ? 'secondary' : 'primary', disabled)}${ctx.button('asset-view-deleted', '已删除', state.deleted ? 'primary' : 'secondary', disabled)}</div><div>${ctx.button('asset-select-page', '选择当前展示', 'secondary', disabled)}${hasSelection ? `<span>已选 ${state.selection.size} 项</span>${ctx.button(state.deleted ? 'asset-restore-selected' : 'asset-delete-selected', state.deleted ? '恢复所选' : '删除所选', 'secondary', disabled)}${!state.deleted ? ctx.button('asset-place-selected', '移动到文件夹', 'secondary', disabled) : ''}${ctx.button('asset-clear-selection', '取消选择', 'textbutton', disabled)}` : ''}<span role="status">${state.busy ? '正在保存…' : state.deleted ? '删除的生成作品仍按原到期时间清理' : '拖动卡片调整顺序'}</span></div></div>`;
}
async function updateOrganization(input, ctx) {
  if (state.busy) return;
  const cache = currentLibrary(), owner = cache.owner;
  state.busy = true; cache.organizationRevision++; paint();
  try {
    const response = await fetch('/api/assets/materials/organization', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, order: [...organizeAssets(state.rawMaterials, state.organization), ...organizeAssets(state.rawRecords, state.organization)].map(item => item.key) }), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.organization?.order) || !Array.isArray(data.organization?.deleted)) throw new Error(data.error || '保存失败，请重试。');
    if (cache !== libraryCache || owner !== globalThis.workspaceUser?.id) return;
    cache.organization = data.organization; cache.organizationRevision++;
    notifyLibrary(cache);
    if (active()) { Object.assign(state, librarySnapshot(cache)); state.selection.clear(); ctx.toast(input.action === 'delete' ? '已移入已删除' : input.action === 'restore' ? '已恢复' : '排列已保存'); }
  } catch (error) { if (active() && owner === globalThis.workspaceUser?.id) ctx.toast(error.name === 'TimeoutError' ? '保存超时，请刷新确认后重试。' : error.message || '保存失败，请重试。'); }
  finally { if (cache === libraryCache) { state.busy = false; paint(); } }
}
async function assetRequest(path, input) {
  const response = await fetch('/api/assets/materials/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(240000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '保存失败，请重试。');
  if (!Array.isArray(data.organization?.order) || !Array.isArray(data.organization?.deleted) || path === 'retain' && !collectMaterialAssets([data.material]).length) throw new Error('保存结果无法确认，请刷新重试。');
  return data;
}
function applyLibraryResult(cache, data) {
  if (cache !== libraryCache || cache.owner !== globalThis.workspaceUser?.id) return false;
  cache.organization = data.organization; cache.organizationRevision++;
  if (data.material) {
    cache.values[5] = [data.material, ...cache.values[5].filter(item => item.id !== data.material.id)];
    if (cache.pending) cache.uploads.push(data.material);
  }
  Object.assign(state, librarySnapshot(cache));
  if (state.folderId && !assetFolders(state.organization).some(folder => folder.id === state.folderId)) state.folderId = null;
  notifyLibrary(cache); return true;
}
async function folderRequest(input, ctx) {
  const cache = currentLibrary(); state.busy = true; cache.organizationRevision++; paint();
  try { if (applyLibraryResult(cache, await assetRequest('folders', input))) { state.selection.clear(); ctx.toast('已保存'); } }
  catch (error) { if (cache === libraryCache) ctx.toast(error.message || '保存失败，请重试。'); }
  finally { if (cache === libraryCache) { state.busy = false; paint(); } }
}
async function placeAssets(items, folderId, type, ctx) {
  if (!items.length) return;
  const cache = currentLibrary(); state.busy = true; cache.organizationRevision++; paint();
  let saved = 0;
  try {
    const originals = items.filter(item => item.permanent);
    if (originals.length) {
      if (!applyLibraryResult(cache, await assetRequest('folders', { action: 'assign', ids: originals.map(item => item.id), folderId, type }))) return;
      saved += originals.length;
    }
    for (const item of items.filter(item => !item.permanent)) {
      if (cache !== libraryCache || cache.owner !== globalThis.workspaceUser?.id) return;
      if (!applyLibraryResult(cache, await assetRequest('retain', { key: item.key, url: item.url, name: item.title, folderId }))) return;
      saved++; state.selection.delete(item.key);
    }
    state.selection.clear(); ctx.toast('已保存到素材文件夹');
  } catch (error) { if (cache === libraryCache) { ctx.toast(`${saved ? '部分素材已保存。' : ''}${error.message || '保存失败，请重试。'}`); cache.loadedAt = 0; } }
  finally { if (cache === libraryCache) { state.busy = false; paint(); } }
}
function confirmAssetDelete(keys, ctx) {
  ctx.openModal('删除资产', `将 ${keys.length} 项资产移入“已删除”，可以恢复。已创建的任务不受影响。`, `<footer class="modal-actions">${ctx.button('asset-cancel-delete', '取消', 'secondary')}${ctx.button('asset-confirm-delete', '删除', 'primary', `data-keys="${ctx.esc(JSON.stringify(keys))}"`)}</footer>`, true);
}

export function collectMaterialAssets(items = []) {
  return items.filter(item => item?.permanent === true && ['photo', 'voice', 'video'].includes(item.kind)
    && new RegExp(`^${item.kind}-[a-f0-9]{64}$`).test(item.id || '')
    && item.url === `/api/assets/materials/${item.id}/media` && Number.isFinite(item.createdAt));
}
export async function uploadSharedMaterial(kind, file, signal, placement) {
  const cache = currentLibrary();
  const assetKind = ['product', 'background'].includes(kind) ? 'photo' : kind;
  if (placement) cache.organizationRevision++;
  const route = placement ? `upload/${assetKind}?folderId=${encodeURIComponent(placement.folderId || '')}` : assetKind;
  const response = await fetch(`/api/assets/materials/${route}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file, signal: signal || AbortSignal.timeout(180000) });
  let data;
  try { data = await response.json(); } catch { throw new Error(t('素材入库失败，请重试。')); }
  if (!response.ok) throw new Error(data.error || t('素材入库失败，请重试。'));
  if (!collectMaterialAssets([data.material]).length || data.material.kind !== assetKind) throw new Error(t('素材入库失败，请重试。'));
  if (cache === libraryCache && cache.owner === globalThis.workspaceUser?.id) {
    if (placement) {
      if (!Array.isArray(data.organization?.order) || !Array.isArray(data.organization?.deleted)) throw new Error(t('保存结果无法确认，请刷新重试。'));
      cache.organization = data.organization; cache.organizationRevision++;
    }
    cache.values[5] = [data.material, ...cache.values[5].filter(item => item.id !== data.material.id)];
    if (cache.pending) cache.uploads.push(data.material);
    notifyLibrary(cache);
  }
  return data.material;
}
export function materialDestinations(kind) {
  return kind === 'photo' ? [['replica', '1:1 复刻 · 人物照片'], ['image', 'AI 图片 · 参考图片'], ['video', 'AI 视频 · 角色参考']]
    : kind === 'voice' ? [['replica', '1:1 复刻 · 参考声音'], ['avatar', '数字人 · 口播声音'], ['video', 'AI 视频 · 参考声音']]
      : kind === 'video' ? [['replica', '1:1 复刻 · 参考视频']] : [];
}
async function useMaterial(item, target, ctx) {
  const owner = globalThis.workspaceUser?.id || 'local-dev';
  const current = () => active() && owner === (globalThis.workspaceUser?.id || 'local-dev');
  if (target === 'replica') {
    const module = await import('./video-replica.js');
    if (!current()) return;
    ctx.navigate('replica'); module.useReplicaMaterial(item); return;
  }
  const response = await fetch(item.url, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('素材下载失败，请重试。');
  const blob = await response.blob();
  if (!current()) return;
  const file = new File([blob], item.filename, { type: item.mime || (item.kind === 'photo' ? 'image/jpeg' : item.kind === 'video' ? 'video/mp4' : 'audio/wav') });
  if (target === 'image') {
    const ids = ctx.importBusinessAssets([file], 'image', ctx.configs.image.files.length);
    if (!ids.length) return;
    ctx.configs.image.files.push(...ids); ctx.setImageMode('generic'); ctx.navigate('image');
  } else if (target === 'avatar') {
    const module = await import('./digital-human.js');
    if (!current()) return;
    ctx.navigate('avatar'); await module.useDigitalHumanVoice(file, ctx);
  } else if (target === 'video') {
    const module = await import('./video-creator.js');
    if (!current()) return;
    ctx.navigate('video'); await module.useVideoMaterial(file, item.kind);
  }
}
function renderMaterialResults(ctx) {
  const { esc, icon, button } = ctx, filtered = displayedMaterials();
  return `<div class="material-assets-heading"><h2>素材库</h2><span>长期保存，随时复用</span></div><div class="generated-assets-filters" role="group" aria-label="长期素材类型">${[['all', '全部素材'], ['photo', '图片'], ['voice', '参考声音'], ['video', '视频']].map(([kind, name]) => button('material-filter', name, state.materialType === kind ? 'selected' : '', `data-kind="${kind}" aria-pressed="${state.materialType === kind}"`)).join('')}</div>${filtered.length ? `<div class="generated-assets-grid">${filtered.slice(0, state.materialLimit).map(item => `<article class="generated-asset-card" data-asset-key="${esc(item.key)}" data-asset-group="materials" draggable="${!state.deleted && !state.busy}">${assetTools(item, filtered, ctx)}<button class="generated-asset-cover ${item.type}" data-action="material-preview" data-id="${esc(item.id)}" aria-label="${item.kind === 'photo' ? '查看图片' : item.kind === 'video' ? '查看视频' : '试听声音'}：${esc(item.name)}">${item.kind === 'photo' ? `<img src="${esc(item.url)}" alt="${esc(item.name)}" loading="lazy">` : `<span class="generated-asset-audio">${icon(item.type === 'video' ? 'video' : 'audio')}<small>${item.type === 'video' ? '参考视频' : '参考声音'}</small></span>`}<span class="generated-asset-kind">${item.kind === 'photo' ? '图片' : item.kind === 'video' ? '参考视频' : '参考声音'}</span></button><div class="generated-asset-copy"><h2>${esc(item.name)}</h2><time>${dateLabel(item.createdAt)} 保存</time><div class="generated-asset-footer"><span class="material-permanent">长期保留</span>${button('material-preview', state.deleted ? '预览' : '使用到…', 'secondary', `data-id="${esc(item.id)}"`)}</div></div></article>`).join('')}</div>` : `<p class="material-assets-empty">${state.loading ? '正在读取已保存的素材…' : state.deleted ? '暂无已删除素材' : '点击上传素材，保存图片、音频和视频。'}</p>`}${filtered.length > state.materialLimit ? button('material-more', '加载更多素材', 'secondary') : ''}`;
}

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

// Only successful generated outputs enter the library; uploads and example images never do.
export function collectGeneratedAssets(imageTasks = [], avatarTasks = [], now = Date.now(), restaurantTasks = [], videoTasks = [], creativeVideoTasks = []) {
  const records = [];
  for (const task of creativeVideoTasks) {
    const window = generatedAssetWindow(task, now);
    if (!window || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(task.id || '') || task.billing && task.billing.status !== 'settled') continue;
    const url = `/api/video-creator/tasks/${task.id}/result`;
    if (task.resultUrl !== url) continue;
    records.push({ key: `creative-video:${task.id}`, type: 'video', source: 'AI 视频', title: String(task.title || '同城到店视频').slice(0, 80), url, download: url + '?download=1', filename: 'qiya-video.mp4', ...window });
  }
  for (const task of videoTasks) {
    const window = generatedAssetWindow(task, now);
    if (!window || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(task.id || '') || task.billing && task.billing.status !== 'settled') continue;
    const url = `/api/video-replica/tasks/${task.id}/result`;
    if (task.resultUrl !== url) continue;
    records.push({ key: `video:${task.id}`, type: 'video', source: '人物复刻', title: '人物 1:1 复刻', url, download: url + '?download=1', filename: 'person-replica.mp4', ...window });
  }
  for (const task of imageTasks) {
    const window = generatedAssetWindow(task, now);
    if (!window || typeof task.id !== 'string') continue;
    for (const [index, image] of (Array.isArray(task.images) ? task.images : []).entries()) {
      const url = localUrl(image?.url, /^\/api\/ai\/media\/[a-f\d-]+\/result-(?:[1-9]|1[0-5])\.(?:png|jpg|webp)$/i);
      if (!url || !url.startsWith(`/api/ai/media/${task.id}/`)) continue;
      records.push({ key: `image:${task.id}:${index}`, type: 'image', source: 'AI 图片', title: imageTaskTitle(task), url, download: url + '?download=1', filename: image.filename || 'generated-image.png', ...window });
    }
  }
  for (const task of avatarTasks) {
    const window = generatedAssetWindow(task, now);
    if (!window || typeof task.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(task.id) || (task.billing?.isExternalUser && task.billing.status !== 'settled')) continue;
    const base = `/api/tasks/${encodeURIComponent(task.id)}`;
    const title = String(task.inputs?.scriptText || '数字人作品').split('\n')[0].slice(0, 64);
    for (const [type, field, kind, filename] of [['video', 'finalVideoUrl', 'final', 'final.mp4'], ['audio', 'exactAudioUrl', 'voice', task.results?.audioFormat === 'mp3' ? 'voice-track.mp3' : 'voice-track.wav']]) {
      if (task.results?.[field] !== `${base}/media/${kind}`) continue;
      records.push({ key: `avatar:${task.id}:${type}`, type, source: '数字人', title, url: `${base}/media/${kind}`, download: `${base}/download/${filename}`, filename, ...(type === 'video' ? { modelLabel: digitalHumanModelLabel(task) } : {}), ...window });
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
  return new Date(value).toLocaleString(uiLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function remainingLabel(expires) {
  const hours = Math.max(1, Math.ceil((expires - Date.now()) / 3600000));
  return hours > 24 ? `剩余 ${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `剩余 ${hours} 小时`;
}
function available() { return state.records.filter(record => record.expires > Date.now()); }
function active() { return state.ctx && document.body.dataset.page === 'assets'; }

function renderResults(ctx) {
  const { button, esc, icon } = ctx;
  const records = organizeAssets(state.rawRecords.filter(record => record.expires > Date.now() && !state.organization.retained?.[record.key]), state.organization, state.deleted);
  if (state.folderId) return '';
  const filtered = displayedRecords();
  const filters = `<div class="generated-assets-filters" role="group" aria-label="成品类型">${Object.entries(TYPES).map(([type, label]) => button('generated-assets-filter', `${label}<span>${type === 'all' ? records.length : records.filter(item => item.type === type).length}</span>`, type === state.type ? 'selected' : '', `data-type="${type}" aria-pressed="${type === state.type}"`)).join('')}</div>`;
  const errors = state.errors.length ? `<div class="generated-assets-errors" role="status">${state.errors.map(error => `<p>${esc(error)}</p>`).join('')}${button('generated-assets-refresh', '重新加载', 'textbutton')}</div>` : '';
  if (state.loading && !records.length) return filters + `<div class="generated-assets-empty" role="status">${icon('clock')}<h2>正在读取生成的作品</h2></div>`;
  if (!filtered.length) return filters + errors + `<div class="generated-assets-empty">${icon('folder')}<h2>${state.deleted ? '暂无已删除作品' : records.length ? `近 3 天还没有${TYPES[state.type]}成品` : state.errors.length ? '暂时没有可展示的成品' : '近 3 天还没有生成作品'}</h2>${button('generated-assets-create', '去生成图片 ' + icon('arrow'), 'primary')}</div>`;
  return filters + errors + `<div class="generated-assets-grid">${filtered.slice(0, state.limit).map(record => `<article class="generated-asset-card" data-asset-key="${esc(record.key)}" data-asset-group="records" draggable="${!state.deleted && !state.busy}">${assetTools(record, filtered, ctx)}<button class="generated-asset-cover ${record.type}" data-action="generated-asset-preview" data-key="${esc(record.key)}" aria-label="${record.type === 'image' ? '查看图片' : record.type === 'video' ? '播放视频' : '试听配音'}：${esc(record.title)}">${record.type === 'image' ? `<img src="${esc(record.url)}" alt="${esc(record.title)}" loading="lazy">` : record.type === 'video' ? `<video src="${esc(record.url)}" preload="metadata" muted playsinline aria-hidden="true"></video><span class="generated-asset-play">${icon('play')}</span>` : `<span class="generated-asset-audio">${icon('audio')}<small>生成配音</small></span>`}<span class="generated-asset-kind">${esc(record.source)} · ${TYPES[record.type]}</span></button><div class="generated-asset-copy"><h2 title="${esc(record.title)}">${esc(record.title)}</h2>${record.modelLabel ? `<p class="generated-asset-model">生成模型：${esc(record.modelLabel)}</p>` : ''}<time datetime="${new Date(record.completed).toISOString()}">${dateLabel(record.completed)} 生成</time><div class="generated-asset-footer"><span class="generated-asset-expiry ${record.expires - Date.now() <= 24 * 3600000 ? 'soon' : ''}" title="${dateLabel(record.expires)} 到期">${remainingLabel(record.expires)}</span><a href="${esc(record.download)}" download="${esc(record.filename)}" class="generated-asset-download" aria-label="下载${TYPES[record.type]}：${esc(record.title)}">${icon('save')}下载</a></div><small class="generated-asset-deadline">${dateLabel(record.expires)} 到期清理</small></div></article>`).join('')}</div>${filtered.length > state.limit ? `<div class="generated-assets-more">${button('generated-assets-more', '加载更多作品', 'secondary')}</div>` : ''}`;
}

export function renderGeneratedAssets(ctx) {
  return `<section class="generated-assets-heading"><div><span class="generated-assets-eyebrow">我的创作</span><h1>我的资产</h1></div><div class="asset-heading-actions">${ctx.button('asset-upload', '上传素材', 'primary')}${ctx.button('generated-assets-refresh', ctx.icon('refresh') + '刷新资产', 'secondary')}</div></section><section id="asset-folder-panel">${renderAssetFolders(state, ctx)}</section><section id="asset-organization-tools">${organizationToolbar(ctx)}</section><section id="material-assets-results" aria-label="长期保存的素材">${renderMaterialResults(ctx)}</section><div id="asset-generated-section"${state.folderId ? ' hidden' : ''}><div class="material-assets-heading"><h2>生成作品</h2><span>近 3 天</span></div><div class="generated-assets-policy">${ctx.icon('clock')}<p>成品保留 <strong>3 天</strong>，移入素材文件夹后长期保留。</p></div><section id="generated-assets-results" aria-label="已生成素材">${renderResults(ctx)}</section></div>`;
}

function paint() {
  if (!active()) return;
  const folders = document.querySelector('#asset-folder-panel');
  if (folders) folders.innerHTML = renderAssetFolders(state, state.ctx);
  const toolbar = document.querySelector('#asset-organization-tools');
  if (toolbar) toolbar.innerHTML = organizationToolbar(state.ctx);
  const generatedSection = document.querySelector('#asset-generated-section');
  if (generatedSection) generatedSection.hidden = Boolean(state.folderId);
  const results = document.querySelector('#generated-assets-results');
  if (results) results.innerHTML = renderResults(state.ctx);
  const materials = document.querySelector('#material-assets-results');
  if (materials) materials.innerHTML = renderMaterialResults(state.ctx);
}
function scheduleExpiry() {
  clearTimeout(state.timer);
  const next = Math.min(...state.rawRecords.filter(record => record.expires > Date.now()).map(record => record.expires));
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
  if (response.status === 401 || response.status === 403) throw new Error(`${t(source)}作品需登录后查看。`);
  if (!response.ok) throw new Error(`${t(source)}作品暂时无法加载，请稍后刷新。`);
  const body = await response.json();
  if (!Array.isArray(body.tasks)) throw new Error(`${t(source)}作品列表暂时无法读取。`);
  return body;
}
async function fetchTasks(path, signal, source) { return (await fetchTaskPage(path, signal, source)).tasks; }
async function fetchMaterials(signal) {
  const response = await fetch('/api/assets/materials', { cache: 'no-store', credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('形象与参考声音暂时无法加载，请刷新重试。');
  const data = await response.json();
  if (data.configured === false) throw new Error('长期素材云存储尚未配置，请联系管理员。');
  if (!Array.isArray(data.materials)) throw new Error('长期素材列表暂时无法读取。');
  return { materials: collectMaterialAssets(data.allMaterials || data.materials), organization: data.organization || { order: [], deleted: [] } };
}
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
export async function loadAssetLibrary(signal, { onUpdate, force = false } = {}) {
  const cache = currentLibrary(), refresh = force || Date.now() - cache.loadedAt >= 30000;
  const update = snapshot => { if (!signal?.aborted && cache.owner === globalThis.workspaceUser?.id) onUpdate?.(snapshot); };
  const detach = () => cache.listeners.delete(update);
  if (signal?.aborted) return librarySnapshot(cache);
  cache.listeners.add(update); signal?.addEventListener('abort', detach, { once: true });
  update(librarySnapshot(cache, Boolean(cache.pending) || refresh));
  if (!cache.pending && refresh) {
    // A dialog closing detaches its listener; other pickers can reuse the same requests.
    const requestSignal = AbortSignal.any([cache.controller.signal, AbortSignal.timeout(120000)]);
    const organizationRevision = cache.organizationRevision;
    const sources = ['图片', '数字人', '餐饮图文', '人物复刻', 'AI视频', '长期素材'];
    cache.errors = []; cache.uploads = [];
    cache.pending = Promise.allSettled([
      fetchTasks('/api/ai/images?completed=true', requestSignal, sources[0]), fetchTasks('/api/tasks?completed=true', requestSignal, sources[1]), fetchRestaurantTasks(requestSignal),
      fetchTasks('/api/video-replica/tasks?completed=true', requestSignal, sources[3]), fetchTasks('/api/video-creator/tasks?completed=true', requestSignal, sources[4]), fetchMaterials(requestSignal),
    ].map(async (request, index) => {
      try {
        const value = await request;
        if (index === 5) {
          cache.values[index] = [...new Map([...value.materials, ...cache.uploads].map(item => [item.id, item])).values()];
          if (cache.organizationRevision === organizationRevision) cache.organization = value.organization;
        } else cache.values[index] = value;
      } catch (error) {
        cache.errors[index] = ['AbortError', 'TimeoutError'].includes(error?.name) ? `${t(sources[index])}作品读取超时，请刷新重试。` : /[\u3400-\u9fff]/.test(error?.message) ? error.message : `${t(sources[index])}作品暂时无法读取。`;
      }
      notifyLibrary(cache);
    })).then(() => {
      cache.loadedAt = cache.errors.some(Boolean) ? 0 : Date.now(); cache.pending = null; cache.uploads = [];
      notifyLibrary(cache);
    });
  }
  try { await cache.pending; return librarySnapshot(cache); }
  finally { detach(); signal?.removeEventListener('abort', detach); }
}
async function load(force = false) {
  if (!active() || state.loading) return;
  const revision = ++state.revision;
  const controller = new AbortController(); state.controller = controller;
  const timer = setTimeout(() => controller.abort(), 120000);
  state.loading = true; paint();
  const owner = globalThis.workspaceUser?.id;
  const current = () => revision === state.revision && active() && owner === globalThis.workspaceUser?.id;
  const library = await loadAssetLibrary(controller.signal, { force, onUpdate: snapshot => { if (current()) { Object.assign(state, snapshot); paint(); scheduleExpiry(); } } });
  clearTimeout(timer);
  if (!current()) return;
  Object.assign(state, library);
  state.loading = false; state.controller = null; paint(); scheduleExpiry();
}
let eventController;
export function bindGeneratedAssets(ctx) {
  state.ctx = ctx;
  eventController?.abort(); eventController = new AbortController();
  const root = document.querySelector('#main');
  root?.addEventListener('change', event => {
    const key = event.target?.dataset?.assetSelect;
    if (!key || state.busy) return;
    if (event.target.checked) state.selection.add(key); else state.selection.delete(key);
    const toolbar = document.querySelector('#asset-organization-tools');
    if (toolbar) toolbar.innerHTML = organizationToolbar(ctx);
  }, { signal: eventController.signal });
  root?.addEventListener('dragstart', event => {
    const card = event.target.closest?.('[data-asset-key]');
    if (!card || state.deleted || state.busy || event.target.closest('input, audio, video, a')) { event.preventDefault(); return; }
    state.dragKey = card.dataset.assetKey;
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', state.dragKey);
    card.classList.add('asset-dragging');
  }, { signal: eventController.signal });
  root?.addEventListener('dragover', event => {
    const card = event.target.closest?.('[data-asset-key]');
    if (!card || !state.dragKey || state.busy || card.dataset.assetKey === state.dragKey) return;
    if (card.dataset.assetKey.startsWith('material:') !== state.dragKey.startsWith('material:')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    root.querySelectorAll('.asset-drop-target').forEach(node => node.classList.remove('asset-drop-target'));
    card.classList.add('asset-drop-target');
  }, { signal: eventController.signal });
  root?.addEventListener('drop', event => {
    const target = event.target.closest?.('[data-asset-key]')?.dataset.assetKey, key = state.dragKey;
    if (!key || !target || target === key || state.busy || target.startsWith('material:') !== key.startsWith('material:')) return;
    event.preventDefault();
    const items = key.startsWith('material:') ? displayedMaterials() : displayedRecords();
    if (!items.some(item => item.key === target)) return;
    void updateOrganization({ action: 'move', keys: [key], target, position: items.findIndex(item => item.key === key) < items.findIndex(item => item.key === target) ? 'after' : 'before' }, ctx);
    state.dragKey = null;
  }, { signal: eventController.signal });
  root?.addEventListener('dragend', () => { state.dragKey = null; root.querySelectorAll('.asset-drop-target,.asset-dragging').forEach(node => node.classList.remove('asset-drop-target', 'asset-dragging')); }, { signal: eventController.signal });
  void load();
}
export function disposeGeneratedAssets() {
  eventController?.abort(); state.selection.clear(); state.deleted = false; state.category = 'all'; state.folderId = null; state.busy = false; state.dragKey = null; state.rawMaterials = []; state.rawRecords = []; state.organization = {};
  state.revision++; state.controller?.abort(); state.controller = null; clearTimeout(state.timer); state.loading = false; state.ctx = null; state.records = []; state.materials = []; state.errors = [];
}
export function handleGeneratedAssetsAction(action, element, ctx) {
  if (ctx.mode !== 'assets') return false;
  if (action.startsWith('asset-')) {
    if (state.busy) return true;
    if (action === 'asset-upload') {
      const cache = currentLibrary();
      openAssetUpload(state, ctx, async (kind, file, folderId) => {
        if (cache !== currentLibrary() || cache.owner !== globalThis.workspaceUser?.id) throw new Error(t('账号已切换，请重新上传'));
        await uploadSharedMaterial(kind, file, AbortSignal.any([cache.controller.signal, AbortSignal.timeout(180000)]), { folderId });
        if (active()) { state.deleted = false; paint(); }
      }); return true;
    }
    if (action === 'asset-category' || action === 'asset-folder-open') {
      state.category = element.dataset.type || 'all'; state.folderId = action === 'asset-folder-open' ? element.dataset.id || null : null;
      state.materialType = 'all'; state.type = 'all'; state.selection.clear(); state.materialLimit = 24; paint(); return true;
    }
    if (['asset-folder-create', 'asset-folder-rename', 'asset-folder-move', 'asset-folder-delete'].includes(action)) { openFolderEditor(action.slice(6), element.dataset.id, state, ctx); return true; }
    if (action === 'asset-folder-submit') {
      const input = { action: element.dataset.op, id: element.dataset.id, type: document.querySelector('#asset-folder-type')?.value || element.dataset.type,
        name: document.querySelector('#asset-folder-name')?.value, parentId: element.dataset.op === 'folder-create' ? state.folderId : document.querySelector('#asset-folder-parent')?.value || null };
      document.querySelector('#modal')?.close(); void folderRequest(input, ctx); return true;
    }
    if (action === 'asset-placement-submit') {
      let keys; try { keys = JSON.parse(element.dataset.keys); } catch { return true; }
      const target = document.querySelector('#asset-move-target')?.value || null;
      const selected = [...state.rawMaterials, ...state.rawRecords].filter(item => keys.includes(item.key));
      document.querySelector('#modal')?.close(); void placeAssets(selected, target, element.dataset.type, ctx); return true;
    }
    if (action === 'asset-view-active' || action === 'asset-view-deleted') { state.deleted = action === 'asset-view-deleted'; state.selection.clear(); paint(); return true; }
    if (action === 'asset-select-page') { state.selection = new Set([...displayedMaterials().slice(0, state.materialLimit), ...displayedRecords().slice(0, state.limit)].map(item => item.key)); paint(); return true; }
    if (action === 'asset-clear-selection') { state.selection.clear(); paint(); return true; }
    if (action === 'asset-cancel-delete') { document.querySelector('#modal')?.close(); return true; }
    if (action === 'asset-confirm-delete') {
      let keys; try { keys = JSON.parse(element.dataset.keys); } catch { return true; }
      document.querySelector('#modal')?.close(); void updateOrganization({ action: 'delete', keys }, ctx); return true;
    }
    const key = element.dataset.key;
    const items = [...displayedMaterials(), ...displayedRecords()];
    const keys = action.endsWith('-selected') ? [...state.selection].filter(key => items.some(item => item.key === key)) : items.some(item => item.key === key) ? [key] : [];
    if (!keys.length) return true;
    if (action === 'asset-place' || action === 'asset-place-selected') { openMaterialMove(items.filter(item => keys.includes(item.key)), state, ctx); return true; }
    if (action === 'asset-delete' || action === 'asset-delete-selected') { confirmAssetDelete(keys, ctx); return true; }
    if (action === 'asset-restore' || action === 'asset-restore-selected') { void updateOrganization({ action: 'restore', keys }, ctx); return true; }
    if (action === 'asset-move-prev' || action === 'asset-move-next') {
      const move = relativeAssetMove(key.startsWith('material:') ? displayedMaterials() : displayedRecords(), key, action === 'asset-move-prev' ? -1 : 1);
      if (move) void updateOrganization(move, ctx); return true;
    }
    return false;
  }
  if (action === 'material-filter') { if (['all', 'photo', 'voice', 'video'].includes(element.dataset.kind)) state.materialType = element.dataset.kind; state.materialLimit = 24; state.selection.clear(); paint(); return true; }
  if (action === 'material-more') { state.materialLimit += 24; paint(); return true; }
  if (action === 'material-preview') {
    const item = displayedMaterials().find(item => item.id === element.dataset.id);
    if (!item) { ctx.toast('素材不存在，请刷新重试。'); return true; }
    const media = item.kind === 'photo' ? `<img src="${ctx.esc(item.url)}" alt="${ctx.esc(item.name)}">` : item.kind === 'video' ? `<video src="${ctx.esc(item.url)}" controls playsinline preload="metadata"></video>` : `<audio src="${ctx.esc(item.url)}" controls preload="metadata"></audio>`;
    ctx.openModal(item.name, state.deleted ? '已删除 · 恢复后可继续使用' : '长期保存 · 选择要使用的功能', `<div class="generated-asset-preview">${media}</div><div class="material-destinations">${(state.deleted ? [] : materialDestinations(item.kind)).map(([target, label]) => ctx.button('material-use', label, 'secondary', `data-id="${ctx.esc(item.id)}" data-target="${target}"`)).join('')}</div>`, true);
    return true;
  }
  if (action === 'material-use') {
    const item = state.materials.find(item => item.id === element.dataset.id), target = element.dataset.target;
    if (!item || !materialDestinations(item.kind).some(([value]) => value === target) || element.disabled) return true;
    element.disabled = true;
    void useMaterial(item, target, ctx).catch(error => ctx.toast(error.message || '素材读取失败，请重试。')).finally(() => { element.disabled = false; });
    return true;
  }
  if (action === 'generated-assets-refresh') { state.limit = 24; void load(true); return true; }
  if (action === 'generated-assets-create') { ctx.navigate('image'); return true; }
  if (action === 'generated-assets-more') { state.limit += 24; paint(); return true; }
  if (action === 'generated-assets-filter') {
    state.limit = 24; state.selection.clear();
    if (Object.hasOwn(TYPES, element.dataset.type)) state.type = element.dataset.type;
    paint();
    document.querySelector(`[data-action="generated-assets-filter"][data-type="${state.type}"]`)?.focus({ preventScroll: true });
    return true;
  }
  if (action === 'generated-asset-preview') {
    const record = displayedRecords().find(item => item.key === element.dataset.key);
    if (!record) { paint(); ctx.toast('这份成品已到期，请刷新作品列表。'); return true; }
    const url = ctx.esc(record.url);
    const media = record.type === 'image' ? `<img src="${url}" alt="${ctx.esc(record.title)}">` : record.type === 'video' ? `<video src="${url}" controls playsinline preload="metadata" aria-label="生成视频"></video>` : `<div class="generated-preview-audio">${ctx.icon('audio')}<audio src="${url}" controls preload="metadata" aria-label="生成配音"></audio></div>`;
    ctx.openModal(record.title, `${record.source} · ${dateLabel(record.expires)} 到期`, `<div id="generated-asset-preview" class="generated-asset-preview" data-expires="${record.expires}">${media}</div>${record.modelLabel ? `<p class="generated-asset-model">生成模型：${ctx.esc(record.modelLabel)}</p>` : ''}<footer class="modal-actions"><a class="primary" href="${ctx.esc(record.download)}" download="${ctx.esc(record.filename)}">${ctx.icon('save')}下载${TYPES[record.type]}</a></footer>`, true);
    return true;
  }
  return false;
}
