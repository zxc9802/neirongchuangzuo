import { accountStorageKey } from './account-storage.js';
import { brandModelText } from './model-labels.js';
import { validatePhotoSelection, preparePhotoBatches } from './image-upload.js';

import { imagePoints, creditEstimateText, creditInsufficiency, refreshWorkspaceCredits, subscribeWorkspaceCredits, observeCreditTask, billingPointsText, workspaceCreditsState } from './workspace-credits.js';
let unsubscribeCredits = null;
const API = '/api/restaurant';
const GALLERY_WORKFLOW = 'store-gallery-v1';
const ACTIVE = new Set(['uploading', 'analysing', 'generating', 'retrying']);
const LABELS = { uploading: '保存照片中', analysing: '分析照片中', awaiting_selection: '待选内容方向', awaiting_facts: '待补充信息', generating: '制作发布包中', retrying: '自动重试中', awaiting_confirmation: '待确认提示', completed: '生成成功', failed: '生成失败' };
const REQUIRED = [['name', '门店名称'], ['city', '城市 / 商圈'], ['address', '门店地址'], ['category', '主营品类']];
const OPTIONAL = [['hours', '营业时间'], ['signatureDishes', '招牌菜'], ['averagePrice', '大致人均'], ['parking', '停车信息'], ['groupBuy', '团购套餐、价格及使用条件'], ['features', '其他真实特点'], ['history', '可确认的门店历史'], ['craft', '制作工艺'], ['ingredients', '食材来源']];
const FACT_NAMES = Object.fromEntries([...REQUIRED, ...OPTIONAL, ['dishName', '菜品名称'], ['price', '真实价格'], ['portion', '菜品分量'], ['taste', '口味'], ['setMeal', '套餐内容'], ['conditions', '使用条件'], ['verifiedHistory', '可核实的历史信息']]);
const IMAGE_NAMES = { food: '菜品', interior: '店内环境', exterior: '门头', customers: '顾客消费场景', staff: '员工工作', owner: '老板', preparation: '制作过程', people: '人物 / 消费场景', menu: '菜单', other: '其他实拍' };
const timestamp = value => value == null || value === '' ? NaN : new Date(value).getTime();
const state = { ownerKey: null, ctx: null, profile: {}, profileDraft: {}, profileDirty: false, profileOpen: false, files: [], rights: false, status: null, usage: null, task: null, tasks: [], cursor: null, selected: '', imageMode: 'promotional', outputCount: 0, facts: {}, acceptSparse: false, confirmWarnings: false, pending: null, uploadDraft: null, uploadProgress: null, uploadController: null, uploadOutputCount: 0, busy: false, loading: false, error: '', notice: '', controllers: new Set(), timer: null, expiryTimer: null, quotaTimer: null, observer: null, revision: 0, loaded: false };

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const txt = value => typeof value === 'string' ? value : value?.message || value?.reason || value?.label || '';
const message = value => brandModelText(String(txt(value) || '服务暂时不可用，请稍后刷新。').replace(/sk-[\w.-]+/gi, '[已隐藏]')).slice(0, 300);
const icon = name => state.ctx?.icon?.(name) || '';
const button = (action, label, cls = 'restaurant-secondary', extra = '') => `<button type="button" class="${cls}" data-action="rest-${action}" ${extra}>${label}</button>`;
const dateLabel = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); };

export function validateRestaurantProfile(profile = {}, { required = true } = {}) {
  const missing = required ? REQUIRED.filter(([field]) => typeof profile[field] !== 'string' || !profile[field].trim()) : [];
  if (missing.length) return `请填写${missing.map(([, label]) => label).join('、')}。`;
  return Object.values(profile).some(value => typeof value === 'string' && value.length > 1500) ? '门店资料过长，请精简后保存。' : '';
}
export function validateRestaurantUploads(files = []) {
  return validatePhotoSelection(files.map(item => item?.file || item));
}
export function restaurantAvailablePhotos(task, direction) {
  const ids = Array.isArray(direction?.supportingImageIds) && direction.supportingImageIds.length ? new Set(direction.supportingImageIds) : null;
  return (task?.analysis || []).filter(item => item.usable && (!ids || ids.has(item.imageId))).length;
}
function directionCoreCount(direction) {
  return new Set((Array.isArray(direction?.coreImageIds) ? direction.coreImageIds : []).filter(id => typeof id === 'string' && id)).size;
}
export function restaurantOutputCount(task, direction, requested = 0, imageMode = '') {
  const available = restaurantAvailablePhotos(task, direction);
  const count = Number(requested);
  if (imageMode === 'promotional' || task?.selection?.workflow === GALLERY_WORKFLOW) return Number.isInteger(count) && count >= 1 && count <= 30 ? count : Math.min(30, task?.autoGenerate ? task.requestedOutputCount || task.imageCount || available || 1 : available || 1);
  return Number.isInteger(count) && count > 0 ? count : Math.max(Math.min(9, available), directionCoreCount(direction));
}
export function safeRestaurantFileUrl(value, origin = globalThis.location?.origin) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return '';
  try {
    const url = new URL(value, origin);
    return url.origin === origin && /^\/api\/restaurant\/tasks\/[\da-f-]{36}\/files\/[\w.-]+$/i.test(url.pathname) && !url.search && !url.hash ? url.pathname : '';
  } catch { return ''; }
}
export function restaurantMissingFacts(task, direction, facts = {}) {
  const previousDirectionId = task?.selectedDirectionId || task?.selection?.directionId;
  const taskFacts = direction?.id && previousDirectionId === direction.id ? task?.missingFacts || [] : [];
  const items = [...(direction?.missingFacts || []), ...taskFacts];
  const unique = [...new Map(items.filter(item => item && typeof item.field === 'string').map(item => [item.field, item])).values()];
  return unique.filter(item => !String(facts[item.field] || '').trim());
}
export function restaurantCanGenerate(task, direction, options = {}) {
  if (!task || !direction || !['awaiting_selection', 'awaiting_facts'].includes(task.status)) return false;
  if (!(task.analysis || []).some(item => item.usable)) return false;
  if (task.sourceImages?.some(file => file.expired || timestamp(file.expiresAt) <= Date.now())) return false;
  const available = options.imageMode === 'promotional' ? restaurantAvailablePhotos(task) : restaurantAvailablePhotos(task, direction);
  const count = restaurantOutputCount(task, direction, options.outputCount, options.imageMode);
  if (options.imageMode === 'promotional') return available > 0 && count >= 1 && count <= 30 && !restaurantMissingFacts(task, direction, options.facts).some(item => item.requiredForGeneration);
  if (!available || count > available || count > 15 || count < 1 || count < directionCoreCount(direction) || available >= 6 && count < 6) return false;
  if ((task.sparsePhotos || available < 6) && !options.acceptSparse) return false;
  return !restaurantMissingFacts(task, direction, options.facts).some(item => item.requiredForGeneration);
}
export function restaurantCopyText(task, section) {
  const copy = task?.copy || {};
  if (section === 'body') return String(copy.body || '');
  if (section === 'tags') return (copy.tags || []).map(tag => String(tag).startsWith('#') ? String(tag) : '#' + tag).join(' ');
  if (/^title-[0-2]$/.test(section)) return String(copy.titles?.[Number(section.slice(-1))] || '');
  return [...(copy.titles || []).map((title, index) => `标题 ${index + 1}：${title}`), '', String(copy.body || ''), '', restaurantCopyText(task, 'tags')].join('\n').trim();
}

function active() { return !!state.ctx && state.ownerKey === memoryKey() && typeof document !== 'undefined' && !!document.querySelector('#restaurant-workspace'); }
function memoryKey() { return accountStorageKey('restaurant-active-task'); }
function uploadKey() { return accountStorageKey('restaurant-upload-draft'); }
function recommendationKey() { return accountStorageKey('restaurant-pending-recommendation'); }
function readPendingRecommendation() {
  try { const value = JSON.parse(sessionStorage.getItem(recommendationKey()) || 'null'); return /^[\da-f-]{36}$/i.test(value?.id || '') && /^[\da-f-]{36}$/i.test(value?.requestId || '') ? { id: value.id, requestId: value.requestId, kind: 'recommend' } : null; } catch { return null; }
}
function rememberRecommendation(value) { try { if (value) sessionStorage.setItem(recommendationKey(), JSON.stringify({ id: value.id, requestId: value.requestId })); else sessionStorage.removeItem(recommendationKey()); } catch { /* The current page still queries the original task. */ } }
function readUploadDraft() { try { const value = JSON.parse(sessionStorage.getItem(uploadKey()) || 'null'); return /^[\da-f-]{36}$/i.test(value?.id || '') ? value : null; } catch { return null; } }
function rememberUpload(value) { state.uploadDraft = value; try { if (value) sessionStorage.setItem(uploadKey(), JSON.stringify(value)); else sessionStorage.removeItem(uploadKey()); } catch { /* The task stores the uploaded count on the server. */ } }
function fileFingerprint(files) { return JSON.stringify(files.map(item => { const file = item?.file || item; return [file.name, file.size, file.type, file.lastModified || 0]; })); }
function clearAccountData(ownerKey) {
  Object.assign(state, { ownerKey, profile: {}, profileDraft: {}, profileDirty: false, profileOpen: false, rights: false, status: null, usage: null, task: null, tasks: [], cursor: null, selected: '', imageMode: 'promotional', outputCount: 0, facts: {}, acceptSparse: false, confirmWarnings: false, pending: readPendingRecommendation(), uploadDraft: readUploadDraft(), uploadProgress: null, busy: false, loading: false, error: '', notice: '', loaded: false });
}
function ensureAccount() {
  const key = memoryKey();
  if (state.ownerKey === key) return;
  disposeRestaurant(); clearAccountData(key);
}
function remember(id) { try { if (id) sessionStorage.setItem(memoryKey(), id); else sessionStorage.removeItem(memoryKey()); } catch { /* Server history remains available. */ } }
function remembered() { try { const id = sessionStorage.getItem(memoryKey()); return /^[\da-f-]{36}$/i.test(id || '') ? id : null; } catch { return null; } }
async function request(path, options = {}) {
  const ownerKey = memoryKey();
  if (state.ownerKey !== ownerKey) throw Object.assign(new Error('账号已切换'), { name: 'DisposedError' });
  const controller = new AbortController();
  state.controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), options.method === 'POST' ? 45000 : 18000);
  const revision = state.revision;
  try {
    const response = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    let body;
    try { body = await response.json(); } catch { throw new Error('服务未返回有效数据，请刷新任务状态。'); }
    if (revision !== state.revision || ownerKey !== memoryKey()) throw Object.assign(new Error('离开页面'), { name: 'DisposedError' });
    if (!response.ok) { if (response.status === 402) void refreshWorkspaceCredits({ afterCurrent: true }); throw Object.assign(new Error(message(body.error || body.message)), { status: response.status, code: body.code, missingFacts: body.missingFacts }); }
    return body;
  } catch (error) {
    if (revision !== state.revision || ownerKey !== memoryKey()) throw Object.assign(new Error('离开页面'), { name: 'DisposedError' });
    if (error.name === 'AbortError') throw new Error('连接超时，请刷新任务状态。已提交的任务不会自动重复发送。');
    throw error;
  } finally { clearTimeout(timeout); state.controllers.delete(controller); }
}
function mergeTask(task) {
  if (!task?.id) return;
  state.tasks = [task, ...state.tasks.filter(item => item.id !== task.id)].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
}
function chooseTask(task, reset = false) {
  if (!task?.id) return;
  observeCreditTask(task);
  const changed = state.task?.id !== task.id;
  state.task = task; mergeTask(task); remember(task.id);
  if (changed || reset) {
    state.selected = task.selectedDirectionId || task.selection?.directionId || task.directionId || '';
    state.imageMode = task.selection?.imageMode || (task.selection ? 'natural' : 'promotional');
    state.outputCount = task.selection?.outputCount || task.outputCount || 0;
    state.facts = { ...(task.selection?.facts || task.facts || {}) }; state.acceptSparse = false; state.confirmWarnings = false;
    state.error = ''; state.notice = '';
  }
  if (!state.selected && task.directions?.length === 1) state.selected = task.directions[0].id;
  if (state.selected && !state.outputCount) state.outputCount = restaurantOutputCount(task, selectedDirection(), 0, state.imageMode);
  if (task.status === 'uploading') {
    state.uploadOutputCount = task.requestedOutputCount || state.uploadDraft?.outputCount || state.uploadOutputCount;
    if (state.uploadDraft?.id === task.id) rememberUpload({ ...state.uploadDraft, uploadedCount: task.uploadedCount || 0 });
    state.rights = state.uploadDraft?.rightsConfirmed === true;
  } else if (state.uploadDraft?.id === task.id) rememberUpload(null);
}
function restaurantCreditEstimate(task, direction) {
  if (!direction) return null;
  return imagePoints(state.imageMode === 'promotional' ? restaurantOutputCount(task, direction, state.outputCount, state.imageMode)
    : Math.min(restaurantOutputCount(task, direction, state.outputCount), restaurantAvailablePhotos(task, direction)));
}
function restaurantImagePrice() {
  const snapshot = workspaceCreditsState().snapshot;
  if (snapshot?.unlimited === true) return '无限积分';
  const unit = snapshot?.pricing?.imagePerUnit;
  return Number.isFinite(unit) ? `${unit} 积分 / 张` : '按图片张数计费，价格以服务器为准';
}
function renderRestaurantCredits(task, direction) {
  const points = restaurantCreditEstimate(task, direction), error = creditInsufficiency(points);
  return `<p id="restaurant-credit-estimate" class="credit-estimate${error ? ' is-error' : ''}" role="status">${escape(error || creditEstimateText(points))}</p>`;
}
function selectedDirection() { return state.task?.directions?.find(item => item.id === state.selected); }
function resetDirectionSelection() { state.selected = ''; state.outputCount = 0; state.facts = {}; state.acceptSparse = false; state.confirmWarnings = false; }
function chooseRecommendedTask(task) {
  chooseTask(task, true); resetDirectionSelection();
  if (task.directions?.length === 1) state.selected = task.directions[0].id;
  if (state.selected) state.outputCount = restaurantOutputCount(task, selectedDirection());
}
function resolveRecommendation(task) {
  if (task.recommendationRequestId === state.pending?.requestId) {
    chooseRecommendedTask(task); state.pending = null; rememberRecommendation(null); state.notice = '';
    return;
  }
  chooseTask(task);
  if (ACTIVE.has(task.status)) state.notice = '正在核对重新推荐是否已受理，请稍候。不会自动重复提交。';
  else { state.pending = null; rememberRecommendation(null); state.notice = '尚未确认重新推荐，当前仍为原方案，请核对后手动重新推荐。'; }
}
function renderOutputSettings(task, direction) {
  if (state.imageMode === 'promotional') return `<div class="restaurant-output-settings"><label for="restaurant-output-count">套图张数 <select id="restaurant-output-count">${Array.from({ length: 30 }, (_, i) => i + 1).map(number => `<option value="${number}" ${number === restaurantOutputCount(task, direction, state.outputCount, state.imageMode) ? 'selected' : ''}>${number} 张</option>`).join('')}</select></label></div>`;
  const available = restaurantAvailablePhotos(task, direction);
  const count = restaurantOutputCount(task, direction, state.outputCount);
  if (available < 6) return `<div class="restaurant-output-settings"><strong>简版图文 · ${available} 张真实照片</strong></div>`;
  const maximum = Math.min(15, available);
  return `<div class="restaurant-output-settings"><label for="restaurant-output-count">成品图片数量 <select id="restaurant-output-count" ${state.busy ? 'disabled' : ''}>${Array.from({ length: maximum - 5 }, (_, index) => index + 6).map(number => `<option value="${number}" ${count === number ? 'selected' : ''}>${number} 张</option>`).join('')}</select></label><small>${available} 张可用照片</small></div>`;
}
function taskFiles(task) { return (task?.files || []).map(file => ({ ...file, url: safeRestaurantFileUrl(file.url) })).filter(file => file.url); }
function filesExpired(task) { return task?.filesExpired || (task?.files?.length && task.files.every(file => file.expired || file.expiresAt && timestamp(file.expiresAt) <= Date.now())); }
function originalsExpired(task) { return !task?.sourceImages?.length || task.sourceImages.some(file => file.expired || timestamp(file.expiresAt) <= Date.now()); }
function canRecommend(task) {
  if (!task || state.busy || state.pending || !['awaiting_selection', 'awaiting_facts'].includes(task.status) || originalsExpired(task)) return false;
  const analysedIds = new Set((task.analysis || []).map(item => item.imageId));
  return task.sourceImages.every(image => analysedIds.has(image.id));
}
function warnings(task) { return [...(task?.review?.warnings || []), ...(task?.riskWarnings || [])].map(txt).filter(Boolean); }
function paint() {
  if (!active()) return;
  const current = document.querySelector('#restaurant-workspace');
  const focused = current.contains(document.activeElement) ? document.activeElement : null;
  const focusId = focused?.id;
  const selection = focused?.selectionStart;
  current.outerHTML = renderRestaurant(state.ctx);
  attachInputs();
  scheduleExpiry();
  if (focusId) { const replacement = document.getElementById(focusId); replacement?.focus({ preventScroll: true }); if (Number.isInteger(selection) && replacement?.setSelectionRange) replacement.setSelectionRange(selection, selection); }
}
function paintUploadProgress() {
  if (!active()) return;
  const node = document.querySelector('[data-rest-upload-progress]');
  if (node) node.textContent = `素材已保存 ${state.task?.uploadedCount || 0} / ${state.task?.imageCount || state.uploadDraft?.imageCount || state.files.length} 张${state.uploadProgress ? ` · 正在压缩 ${state.uploadProgress.current} / ${state.uploadProgress.total}` : ''}`;
}
function renderProfile() {
  const summary = [state.profile.name, state.profile.city, state.profile.category].filter(Boolean).join(' · ');
  const value = state.profileDraft;
  const field = ([key, label], required = false) => `<label class="restaurant-field"><span>${escape(label)}${required ? '<b aria-label="必填">*</b>' : ''}</span><input id="rest-profile-${key}" data-rest-profile="${key}" value="${escape(value[key] || '')}" maxlength="${key === 'groupBuy' || key === 'features' ? 1500 : 300}" ${required ? 'required' : ''} ${state.busy ? 'disabled' : ''} autocomplete="${key === 'name' ? 'organization' : key === 'address' ? 'street-address' : 'off'}" placeholder="${key === 'address' ? '真实地址，便于顾客导航' : key === 'category' ? '例如：面馆、火锅、家常菜' : key === 'groupBuy' ? '套餐：牛肉面和饮料；价格：18元；使用条件：工作日午餐' : '填写真实信息'}"></label>`;
  return `<section class="restaurant-profile"><div class="restaurant-section-heading"><div><h2>${icon('store')} 门店资料 <small>选填</small></h2>${summary ? `<p>${escape(summary)}</p>` : ''}</div>${button('profile-toggle', state.profileOpen ? '收起' : summary ? '修改资料' : '填写资料', 'restaurant-text')}</div>${state.profileOpen ? `<form id="restaurant-profile-form" class="restaurant-profile-form"><div class="restaurant-field-grid">${REQUIRED.map(item => field(item)).join('')}</div><details class="restaurant-profile-optional"><summary>更多资料</summary><div class="restaurant-field-grid">${OPTIONAL.map(item => field(item)).join('')}</div></details><div class="restaurant-profile-actions"><button type="submit" class="restaurant-secondary" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在保存…' : '保存门店资料'}</button></div></form>` : ''}</section>`;
}
function renderUpload() {
  return `<section class="restaurant-upload-section"><div class="restaurant-section-heading"><div><h2>上传门店实拍</h2><p>上传菜品、门店、环境或服务实拍</p></div><span class="restaurant-count">${state.files.length} / 30</span></div><div class="restaurant-upload-grid" id="restaurant-dropzone">${state.files.map((item, index) => `<figure class="restaurant-source"><img src="${escape(item.url)}" alt="待分析照片 ${index + 1}：${escape(item.file.name)}" loading="lazy" decoding="async"><figcaption>${escape(item.file.name)}</figcaption>${button('remove-photo', '×', 'restaurant-remove', `data-index="${index}" aria-label="移除照片 ${index + 1}" ${state.busy ? 'disabled' : ''}`)}</figure>`).join('')}${state.files.length < 30 ? `<label class="restaurant-upload-picker${state.files.length ? '' : ' empty'}">${icon('plus')}<strong>${state.files.length ? '添加照片' : '选择照片，或拖放到这里'}</strong><small>JPG / PNG / WebP · 原图单张 ≤ 20MB · 总计 ≤ 400MB</small><input type="file" id="restaurant-file-input" accept="image/jpeg,image/png,image/webp" multiple ${state.busy || state.pending ? 'disabled' : ''} aria-label="上传门店实拍照片"></label>` : ''}</div><div class="restaurant-output-settings"><label for="restaurant-upload-output-count">套图张数 <select id="restaurant-upload-output-count" ${state.busy ? 'disabled' : ''}><option value="0" ${state.uploadOutputCount === 0 ? 'selected' : ''}>与上传张数一致</option>${Array.from({ length: 30 }, (_, i) => i + 1).map(number => `<option value="${number}" ${number === state.uploadOutputCount ? 'selected' : ''}>${number} 张</option>`).join('')}</select></label><small>无字摄影 · 菜品重拍 · 环境美化</small></div><label class="restaurant-check"><input id="restaurant-rights" type="checkbox" ${state.rights ? 'checked' : ''} ${state.busy ? 'disabled' : ''}><span>我拥有这些照片的使用权，并已获得照片中人物的使用授权。</span></label><div class="restaurant-submit-row"><p>${escape(restaurantImagePrice())} · ${state.uploadOutputCount || state.files.length} 张</p>${button('analyse', state.busy ? '正在提交…' : state.pending ? '正在核对提交状态' : state.task?.status === 'uploading' ? `继续上传并分析 ${icon('arrow')}` : `一键生成套图 ${icon('arrow')}`, 'restaurant-primary', state.busy || state.pending || !state.loaded || state.status?.enabled === false ? 'disabled' : '')}</div></section>`;
}
function renderAnalysis(task) {
  const sources = task.sourceImages || [];
  const items = task.analysis || [];
  const usable = items.filter(item => item.usable).length;
  return `<details class="restaurant-analysis"><summary>照片分析 <span>${usable} / ${sources.length || items.length} 张可用</span></summary><div class="restaurant-analysis-grid">${items.map((item, index) => {
    const source = sources.find(image => image.id === item.imageId);
    const url = source?.expired || timestamp(source?.expiresAt) <= Date.now() ? '' : safeRestaurantFileUrl(source?.url);
    const needsConfirmation = item.usable && (item.privacyRisk === 'low' || item.textRisk === 'warning');
    const riskReasons = (Array.isArray(item.riskReasons) ? item.riskReasons : []).map(txt).filter(Boolean);
    const riskHints = needsConfirmation && !riskReasons.length ? [item.privacyRisk === 'low' ? '发布前请确认照片中人物已授权。' : '', item.textRisk === 'warning' ? '发布前请确认图片中文字的真实性。' : ''].filter(Boolean) : riskReasons;
    const label = item.usable ? needsConfirmation ? '可用 · 发布前需确认' : '可用' : '不采用';
    return `<article class="restaurant-analysis-item ${item.usable ? '' : 'excluded'}">${url ? `<img src="${escape(url)}" alt="照片 ${index + 1} ${escape(IMAGE_NAMES[item.imageType] || '实拍')}" loading="lazy">` : '<div class="restaurant-file-placeholder">原图已过期</div>'}<div><strong>照片 ${index + 1} · ${escape(IMAGE_NAMES[item.imageType] || '实拍')}</strong><span>${label}</span><p>${escape(item.usable ? (item.visibleObjects || []).map(txt).join('、') : item.rejectionReason || '不适合当前内容')}</p>${riskHints.map(reason => `<small>${escape(reason)}</small>`).join('')}${item.privacyRisk === 'high' ? '<small>隐私风险较高</small>' : ''}</div></article>`;
  }).join('')}</div></details>`;
}
function renderDirectionCard(task, item) {
  const available = restaurantAvailablePhotos(task, item);
  const core = directionCoreCount(item);
  const minimum = Math.max(available >= 6 ? 6 : 1, core);
  const maximum = Math.min(15, available);
  const range = state.imageMode === 'promotional' ? `可生成 ${available} 张` : maximum >= minimum ? `可生成 ${minimum === maximum ? maximum : `${minimum}—${maximum}`} 张` : '相关素材暂不足以生成';
  const candidates = (Array.isArray(item.supportingImageIds) ? item.supportingImageIds : []).map(id => {
    const index = (task.sourceImages || []).findIndex(source => source.id === id);
    return index >= 0 ? `照片 ${index + 1}` : '实拍照片';
  }).map(escape).join('、') || '门店资料';
  return `<button type="button" role="radio" aria-checked="${state.selected === item.id}" class="restaurant-direction${state.selected === item.id ? ' selected' : ''}" data-action="rest-select" data-id="${escape(item.id)}"><div class="restaurant-direction-top"><span>${escape(item.consumptionScene || '门店日常')}</span><i>${state.selected === item.id ? icon('check') : ''}</i></div><h3>${escape(item.label || item.contentGoal || '门店分享')}</h3><p>${escape(item.targetCustomer)}</p><div class="restaurant-direction-reason">${escape(item.recommendationReason)}</div><small>${available} 张可用素材 · ${range}</small><small>相关素材：${candidates}${item.expectedAction ? ` · ${escape(item.expectedAction)}` : ''}</small></button>`;
}
function renderDirections(task) {
  const directions = task.directions || [];
  const recommendButton = button('recommend', '重新推荐', 'restaurant-text', canRecommend(task) ? '' : 'disabled');
  if (!directions.length) return `<div class="restaurant-empty"><h3>暂时没有可靠的内容方向</h3><p>${escape(task.message || '请补充清晰照片或门店资料后再试。')}</p>${recommendButton}${button('new', '重新上传照片')}</div>`;
  const direction = selectedDirection();
  const facts = restaurantMissingFacts(task, direction);
  const canGenerate = restaurantCanGenerate(task, direction, state) && !creditInsufficiency(restaurantCreditEstimate(task, direction));
  return `<section class="restaurant-directions"><div class="restaurant-section-heading"><div><h2>选择一个内容方向</h2></div><div>${recommendButton}${button('new', '重新上传', 'restaurant-text')}</div></div><div class="restaurant-direction-grid" role="radiogroup" aria-label="内容方向">${directions.map(item => renderDirectionCard(task, item)).join('')}</div>${direction ? `<div class="restaurant-selection-settings">${facts.length ? `<div class="restaurant-facts"><h3>${facts.some(item => item.requiredForGeneration) ? '还需要确认几件事' : '以下信息可以补充，也可以避开'}</h3>${facts.map((item, index) => `<label class="restaurant-field"><span>${escape(item.label || FACT_NAMES[item.field] || '补充信息')} ${item.requiredForGeneration ? '<b>必须补充</b>' : '<small>可选</small>'}</span><input id="restaurant-fact-${index}" data-rest-fact="${escape(item.field)}" value="${escape(state.facts[item.field] || '')}" maxlength="1500" placeholder="${escape(item.reason || '填写真实信息')}" ${item.requiredForGeneration ? 'required' : ''}><small>${escape(item.reason)}${item.supportedAlternative ? ` · 可改选：${escape(Array.isArray(item.supportedAlternative) ? item.supportedAlternative.join('、') : item.supportedAlternative)}` : ''}</small></label>`).join('')}</div>` : ''}<fieldset class="restaurant-modes"><legend>图片风格</legend><label><input type="radio" name="restaurant-image-mode" value="promotional" ${state.imageMode === 'promotional' ? 'checked' : ''}><span><strong>宣传套图</strong><small>门店参考 · 多角度 · 无字</small></span></label><label><input type="radio" name="restaurant-image-mode" value="natural" ${state.imageMode === 'natural' ? 'checked' : ''}><span><strong>自然美化</strong><small>保留实拍内容</small></span></label><label><input type="radio" name="restaurant-image-mode" value="cover" ${state.imageMode === 'cover' ? 'checked' : ''}><span><strong>封面加字</strong><small>首图添加主题文字</small></span></label></fieldset>${renderOutputSettings(task, direction)}${renderRestaurantCredits(task, direction)}${state.imageMode !== 'promotional' && (task.sparsePhotos || restaurantAvailablePhotos(task, direction) < 6) ? `<label class="restaurant-check restaurant-sparse"><input id="restaurant-sparse" type="checkbox" ${state.acceptSparse ? 'checked' : ''}><span>使用 ${restaurantAvailablePhotos(task, direction)} 张照片生成简版图文</span></label>` : ''}<div class="restaurant-submit-row">${button('generate', state.busy ? '正在提交…' : state.usage?.remaining === 0 ? '今日生成服务已达上限' : creditInsufficiency(restaurantCreditEstimate(task, direction)) ? '积分不足' : `生成图文发布包 ${icon('arrow')}`, 'restaurant-primary', !canGenerate || state.busy || state.pending || state.usage?.remaining === 0 ? 'disabled' : '')}</div></div>` : '<p class="restaurant-selection-hint">请选择内容方向</p>'}</section>`;
}
function renderStoryboard(task) {
  const storyboard = task?.galleryStoryboard;
  if (!storyboard?.shots?.length) return '';
  return `<section class="restaurant-storyboard" aria-label="套图编排"><header><h3>套图编排</h3><span>${storyboard.shots.length} 张</span></header><p>${escape(storyboard.theme || '')}</p><ol>${storyboard.shots.map((shot,index)=>`<li><b>${String(index+1).padStart(2,'0')}</b><span>${escape(shot.name || (shot.kind==='food'?'食品摄影':'门店实拍'))}</span></li>`).join('')}</ol></section>`;
}
function renderProgress(task) {
  const upload = task.status === 'uploading' ? `素材已保存 ${task.uploadedCount || 0} / ${task.imageCount || state.uploadDraft?.imageCount || state.files.length} 张${state.uploadProgress ? ` · 正在压缩 ${state.uploadProgress.current} / ${state.uploadProgress.total}` : ''}` : '';
  return `<section class="restaurant-progress" role="status" aria-live="polite"><div class="restaurant-progress-icon">${icon('clock')}</div><div><h2>${LABELS[task.status] || '任务处理中'}</h2><p ${task.status === 'uploading' ? 'data-rest-upload-progress' : ''}>${escape(upload || task.progress?.message || (task.progress?.stage === 'analysis' ? `正在分析实拍 ${task.progress.current || 0} / ${task.progress.total || 0}` : '') || task.message || '处理中…')}</p>${task.status === 'uploading' && !state.busy ? '<small>重新选择原照片可继续上传。</small>' : ''}</div>${button('refresh', '刷新状态', 'restaurant-text')}</section>`;
}
function renderDraftPreview(task) {
  if (task.selection?.workflow === GALLERY_WORKFLOW) {
    const images = taskFiles(task).filter(file => file.role === 'image');
    return `<section class="restaurant-draft-preview" aria-label="套图成品预览"><header><h3>套图成品预览 · ${images.length} 张</h3></header><div class="restaurant-draft-images">${images.map((file, index) => `<figure><img src="${escape(file.url)}" alt="套图成品 ${index + 1}" loading="lazy"><figcaption>${String(index + 1).padStart(2, '0')}</figcaption></figure>`).join('')}</div>${task.copy?.body ? `<p class="restaurant-body-copy">${escape(task.copy.body)}</p>` : ''}</section>`;
  }
  const order = task.copy?.imageOrder || task.selection?.imageIds || [];
  const sources = order.map(id => (task.sourceImages || []).find(photo => photo.id === id)).filter(Boolean);
  return `<section class="restaurant-draft-preview" aria-label="待确认草稿预览"><header><h3>待确认预览</h3><p>照片为原图参考，确认后生成成品。</p></header><div class="restaurant-draft-images">${sources.map((source, index) => {
    const url = source.expired || timestamp(source.expiresAt) <= Date.now() ? '' : safeRestaurantFileUrl(source.url);
    return `<figure>${url ? `<img src="${escape(url)}" alt="${index === 0 ? '封面原图参考' : '配图原图参考'} ${index + 1}" loading="lazy">` : '<div class="restaurant-file-placeholder">原图已过期</div>'}<figcaption>${String(index + 1).padStart(2, '0')} · ${index === 0 ? '封面原图参考' : '配图原图参考'}</figcaption></figure>`;
  }).join('') || '<p class="restaurant-draft-no-source">原图参考暂时无法显示，请核对下方文字和发布提示。</p>'}</div><div class="restaurant-draft-copy"><section><h4>三个标题</h4><ol>${(task.copy?.titles || []).map(title => `<li>${escape(title)}</li>`).join('')}</ol></section><section><h4>封面文字</h4><p>${escape(task.copy?.coverText || '')}</p></section><section><h4>正文</h4><p class="restaurant-body-copy">${escape(task.copy?.body || '')}</p></section><section><h4>话题</h4><p class="restaurant-tag-copy">${escape(restaurantCopyText(task, 'tags'))}</p></section></div></section>`;
}
function renderReview(task) {
  const list = [...warnings(task), ...(task.review?.errors || []).map(txt).filter(Boolean)];
  const blocked = task.review?.status === 'blocked';
  return `<section class="restaurant-review ${blocked ? 'blocked' : ''}"><h2>${blocked ? '暂时不能交付发布包' : '发布前，请确认这些提示'}</h2><ul>${list.map(item => `<li>${escape(item)}</li>`).join('') || `<li>${escape(task.review?.reason || task.message || '请核对内容真实性。')}</li>`}</ul>${blocked ? `<p>补充必要信息或改选其他方向后再试。</p>${button('new', '重新开始')}` : `${renderDraftPreview(task)}<label class="restaurant-check"><input id="restaurant-confirm-warnings" type="checkbox" ${state.confirmWarnings ? 'checked' : ''}><span>我已核对预览和上述提示，确认可以使用这些照片和内容。</span></label>${button('confirm', state.busy ? '正在确认…' : '确认并完成发布包', 'restaurant-primary', !state.confirmWarnings || state.busy || state.pending ? 'disabled' : '')}`}</section>`;
}
function renderResult(task) {
  const files = taskFiles(task);
  const expired = filesExpired(task);
  const images = files.filter(file => file.role === 'image');
  const zip = files.find(file => file.role === 'zip');
  const titles = Array.isArray(task.copy?.titles) ? task.copy.titles : [];
  const list = warnings(task);
  const compact = !expired && images.length > 0 && images.length <= 2;
  return `<section class="restaurant-result"><div class="restaurant-section-heading"><div><h2>${icon('check')} ${task.selection?.workflow === GALLERY_WORKFLOW ? '宣传套图已完成' : '图文发布包已完成'}</h2><p>${escape(task.storeProfile?.name || task.profileSnapshot?.name || state.profile.name || '餐饮门店')} · ${escape(task.selection?.direction?.label || task.selectedDirection?.label || selectedDirection()?.label || '门店分享')} · ${escape(dateLabel(task.completedAt || task.updatedAt))}</p></div>${button('new-direction', '换个方向再生成', 'restaurant-text', state.busy || originalsExpired(task) ? 'disabled' : '')}</div><div class="restaurant-result-toolbar"><span>${expired ? '文件已过期 · 文字记录保留 30 天' : '图片和下载包保留 3 天，请及时下载'}</span>${zip && !expired ? `<a class="restaurant-primary" href="${escape(zip.url)}" download="${escape(zip.filename)}">${icon('save')} 下载完整发布包</a>` : ''}</div><div class="restaurant-result-content${compact ? ' compact' + (images.length === 1 ? ' single' : ' double') : ''}">${expired ? '<div class="restaurant-expired">图片和下载包已过期，仍可复制下方文字。重新制作需要上传原图。</div>' : `<div class="restaurant-result-images">${images.map((file, index) => `<figure><a href="${escape(file.url)}" target="_blank" rel="noopener" aria-label="查看照片 ${index + 1}"><img src="${escape(file.url)}" alt="${index === 0 ? '封面' : '正文配图'} ${index + 1}" loading="lazy"></a><figcaption><span>${String(index + 1).padStart(2, '0')}${index === 0 ? ' · 封面' : ''}</span><a href="${escape(file.url)}" download="${escape(file.filename)}">下载</a></figcaption></figure>`).join('') || '<div class="restaurant-expired">结果图片暂时无法读取，请刷新状态。</div>'}</div>`}${task.copy?.body ? `<div class="restaurant-result-copy"><section><div class="restaurant-copy-heading"><h3>标题</h3></div><ol class="restaurant-titles">${titles.map((title, index) => `<li><span>${escape(title)}</span>${button('copy', '复制', 'restaurant-text', `data-section="title-${index}"`)}</li>`).join('')}</ol></section><section><div class="restaurant-copy-heading"><h3>正文</h3>${button('copy', '复制正文', 'restaurant-text', 'data-section="body"')}</div><p class="restaurant-body-copy">${escape(task.copy?.body || '')}</p></section><section><div class="restaurant-copy-heading"><h3>话题</h3>${button('copy', '复制话题', 'restaurant-text', 'data-section="tags"')}</div><p class="restaurant-tag-copy">${escape(restaurantCopyText(task, 'tags'))}</p></section></div>` : ''}</div>${list.length ? `<details class="restaurant-risk-details"><summary>已确认的发布提示 · ${list.length} 条</summary><ul>${list.map(item => `<li>${escape(item)}</li>`).join('')}</ul></details>` : ''}<div class="restaurant-result-footer"><small>${billingPointsText(task) ? escape(billingPointsText(task)) + ' · ' : ''}</small>${task.copy?.body ? button('copy', '复制全部文字', 'restaurant-secondary', 'data-section="all"') : ''}</div></section>`;
}
function renderTask() {
  const task = state.task;
  if (!task) return renderUpload();
  if (task.status === 'uploading') return renderProgress(task) + renderUpload();
  if (ACTIVE.has(task.status)) return renderProgress(task);
  const analysis = task.analysis?.length ? renderAnalysis(task) : '';
  if (task.review?.status === 'blocked') return analysis + renderReview(task);
  if (task.status === 'completed') return renderResult(task);
  if (['awaiting_selection', 'awaiting_facts'].includes(task.status) && originalsExpired(task)) return `${analysis}<section class="restaurant-empty"><h2>原图已过期，请重新上传</h2><p>照片和下载包保留 3 天；任务文字记录保留 30 天。</p>${button('recommend', '重新推荐', 'restaurant-text', 'disabled')}${button('new', '重新上传照片')}</section>`;
  if (task.status === 'awaiting_confirmation' && filesExpired(task)) return `<section class="restaurant-empty"><h2>发布包已过期，请重新开始</h2>${task.billing?.exempt === true ? '' : '<p>未交付的成品不扣积分。</p>'}${button('new', '重新上传照片')}</section>`;
  if (task.status === 'awaiting_confirmation') return analysis + renderReview(task);
  if (task.status === 'failed') return `${analysis}<section class="restaurant-empty restaurant-failure" role="status"><h2>这次没有完成发布包</h2><p>${escape(message(task.error || task.failureReason || task.message || '请稍后重试，或调整照片和门店资料。'))}</p>${task.billing?.exempt === true ? '' : '<small>未使用的冻结积分将在确认后退回。</small>'}<div>${task.retryable !== false && !task.uncertain && !filesExpired(task) ? button('retry', '重试任务', 'restaurant-secondary', state.busy || state.pending ? 'disabled' : '') : ''}${task.directions?.length && !originalsExpired(task) ? button('new-direction', '复用素材新建套图', 'restaurant-secondary', state.busy || state.pending ? 'disabled' : '') : ''}${button('new', '重新上传照片')}</div></section>`;
  return analysis + renderDirections(task);
}
function renderHistory() {
  return `<section class="restaurant-history"><div class="restaurant-section-heading"><div><h2>我的图文任务</h2><p>文字记录保留 30 天，图片与下载包保留 3 天</p></div>${button('history-refresh', state.loading ? '正在刷新…' : `${icon('refresh')} 刷新记录`, 'restaurant-text', state.loading ? 'disabled' : '')}</div>${state.tasks.length ? `<div class="restaurant-history-grid">${state.tasks.map(task => {
    const file = task.status !== 'completed' || task.review?.status === 'blocked' || filesExpired(task) ? null : taskFiles(task).find(item => item.role === 'image');
    return `<button type="button" class="restaurant-history-item${task.id === state.task?.id ? ' current' : ''}" data-action="rest-open-task" data-id="${escape(task.id)}">${file ? `<img src="${escape(file.url)}" alt="任务封面" loading="lazy">` : `<div class="restaurant-history-placeholder">${icon(task.status === 'completed' ? 'image' : 'clock')}<span>${filesExpired(task) ? '文件已过期' : LABELS[task.status] || '任务记录'}</span></div>`}<div><strong>${escape((task.review?.status !== 'blocked' ? task.copy?.titles?.[0] : '') || task.selection?.direction?.label || task.selectedDirection?.label || task.profileSnapshot?.name || task.storeProfile?.name || '餐饮图文任务')}</strong><small>${escape(dateLabel(task.createdAt))}</small><span class="restaurant-status ${escape(task.status)}">${escape(LABELS[task.status] || '任务记录')}</span></div></button>`;
  }).join('')}</div>` : `<div class="restaurant-history-empty">${icon('image')}<p>${state.loading ? '正在读取任务记录…' : '暂无任务记录'}</p></div>`}${state.cursor ? `<div class="restaurant-load-more">${button('more', state.loading ? '正在加载…' : '加载更多任务', 'restaurant-secondary', `id="restaurant-history-more" ${state.loading ? 'disabled' : ''}`)}</div>` : ''}</section>`;
}
export function renderRestaurant(ctx = {}) {
  ensureAccount();
  if (ctx) state.ctx = ctx;
  const task = state.task;
  const step = task?.autoGenerate && task.status === 'analysing' ? 2 : !task || ['uploading', 'analysing'].includes(task.status) ? 1 : ['completed', 'awaiting_confirmation'].includes(task.status) || ACTIVE.has(task.status) ? 3 : 2;
  return `<div id="restaurant-workspace" class="restaurant-workspace"><header class="restaurant-heading"><div><h1>餐饮小红书</h1></div><div class="restaurant-heading-actions">${task ? button('new', `${icon('plus')} 新建图文`, 'restaurant-secondary', state.busy || state.pending ? 'disabled' : '') : ''}</div></header><ol class="restaurant-steps" aria-label="创作步骤">${['上传实拍', '分析与编排', '宣传套图'].map((label, index) => `<li class="${step === index + 1 ? 'active' : step > index + 1 ? 'done' : ''}"><span>${step > index + 1 ? icon('check') : index + 1}</span>${label}</li>`).join('')}</ol>${state.error ? `<div class="restaurant-error" role="alert">${escape(state.error)} ${state.pending ? button('refresh', '查询已提交任务', 'restaurant-text') : ''}</div>` : ''}${state.notice ? `<div class="restaurant-notice" role="status">${escape(state.notice)}</div>` : ''}${state.status?.enabled === false ? '<div class="restaurant-notice">餐饮内容服务暂不可用。</div>' : ''}<div class="restaurant-creation">${renderProfile()}${renderStoryboard(task)}${renderTask()}</div>${renderHistory()}</div>`;
}
function attachInputs() {
  const root = document.querySelector('#restaurant-workspace');
  if (!root) return;
  root.querySelector('#restaurant-profile-form')?.addEventListener('submit', event => { event.preventDefault(); void saveProfile(); });
  root.querySelectorAll('[data-rest-profile]').forEach(input => input.addEventListener('input', () => { state.profileDraft[input.dataset.restProfile] = input.value; state.profileDirty = true; }));
  root.querySelectorAll('[data-rest-fact]').forEach(input => input.addEventListener('input', () => { state.facts[input.dataset.restFact] = input.value; updateGenerateButton(); }));
  root.querySelectorAll('[name="restaurant-image-mode"]').forEach(input => input.addEventListener('change', () => { state.imageMode = input.value; state.outputCount = restaurantOutputCount(state.task, selectedDirection(), 0, state.imageMode); paint(); }));
  root.querySelector('#restaurant-upload-output-count')?.addEventListener('change', event => { state.uploadOutputCount = Number(event.target.value); paint(); });
  root.querySelector('#restaurant-rights')?.addEventListener('change', event => { state.rights = event.target.checked; });
  root.querySelector('#restaurant-sparse')?.addEventListener('change', event => { state.acceptSparse = event.target.checked; updateGenerateButton(); });
  root.querySelector('#restaurant-output-count')?.addEventListener('change', event => { state.outputCount = Number(event.target.value); updateGenerateButton(); });
  root.querySelector('#restaurant-confirm-warnings')?.addEventListener('change', event => { state.confirmWarnings = event.target.checked; const control = root.querySelector('[data-action="rest-confirm"]'); if (control) control.disabled = !state.confirmWarnings || state.busy || !!state.pending; });
  root.querySelector('#restaurant-file-input')?.addEventListener('change', event => { addFiles([...event.target.files]); event.target.value = ''; });
  const dropzone = root.querySelector('#restaurant-dropzone');
  if (dropzone) {
    dropzone.addEventListener('dragover', event => { event.preventDefault(); if (!state.busy) dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('dragover'); if (!state.busy && !state.pending) addFiles([...event.dataTransfer.files]); });
  }
  state.observer?.disconnect();
  const more = root.querySelector('#restaurant-history-more');
  if (more && typeof IntersectionObserver !== 'undefined') { state.observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && !state.loading) void loadHistory(true); }, { rootMargin: '180px' }); state.observer.observe(more); }
}
function updateGenerateButton() {
  const estimate = document.querySelector('#restaurant-credit-estimate');
  if (estimate) estimate.outerHTML = renderRestaurantCredits(state.task, selectedDirection());
  const control = document.querySelector('[data-action="rest-generate"]');
  if (control) {
    const creditsError = creditInsufficiency(restaurantCreditEstimate(state.task, selectedDirection()));
    control.disabled = !restaurantCanGenerate(state.task, selectedDirection(), state) || !!creditsError || state.busy || !!state.pending || state.usage?.remaining === 0;
    control.innerHTML = state.busy ? '正在提交…' : state.usage?.remaining === 0 ? '今日生成服务已达上限' : creditsError ? '积分不足' : `生成图文发布包 ${icon('arrow')}`;
    control.title = creditsError;
  }
}
function releaseFiles() { for (const item of state.files) URL.revokeObjectURL(item.url); state.files = []; }
function addFiles(files) {
  const combined = [...state.files, ...files.map(file => ({ file }))];
  const error = validateRestaurantUploads(combined);
  if (error) { state.error = error; paint(); return; }
  for (const file of files) state.files.push({ file, url: URL.createObjectURL(file) });
  state.rights = state.uploadDraft?.rightsConfirmed === true && fileFingerprint(state.files) === state.uploadDraft.fingerprint;
  state.error = ''; paint();
}
async function saveProfile({ silent = false } = {}) {
  const revision = state.revision;
  const error = validateRestaurantProfile(state.profileDraft, { required: false });
  if (error) { state.error = error; state.profileOpen = true; paint(); return false; }
  if (!silent) { state.busy = true; state.error = ''; paint(); }
  try {
    const body = await request('/profile', { method: 'PUT', body: JSON.stringify({ profile: state.profileDraft }) });
    state.profile = body.profile || state.profileDraft; state.profileDraft = { ...state.profile }; state.profileDirty = false; state.profileOpen = false;
    if (!silent) state.ctx?.toast?.('门店资料已保存。');
    return true;
  } catch (error) { if (error.name !== 'DisposedError') state.error = message(error.message); return false; }
  finally { if (!silent && revision === state.revision) { state.busy = false; paint(); } }
}
async function loadUsage() { void refreshWorkspaceCredits({ afterCurrent: true }); try { const data = await request('/usage'); state.usage = data.usage || null; } catch (error) { if (error.name !== 'DisposedError') state.notice = '暂时无法读取今日服务容量，生成前由服务器校验；积分按实际成品张数结算。'; } finally { scheduleQuotaRefresh(); } }
async function loadHistory(more = false) {
  if (state.loading || more && !state.cursor) return;
  const revision = state.revision;
  state.loading = true;
  try {
    const data = await request('/tasks?limit=12' + (more ? '&cursor=' + encodeURIComponent(state.cursor) : ''));
    if (!Array.isArray(data.tasks)) throw new Error('任务列表暂时无法读取。');
    state.tasks = more ? [...new Map([...state.tasks, ...data.tasks].map(item => [item.id, item])).values()] : data.tasks;
    state.cursor = data.nextCursor || null;
    if (state.task) { const fresh = data.tasks.find(item => item.id === state.task.id); if (fresh) chooseTask(fresh); }
  } catch (error) { if (error.name !== 'DisposedError') state.error = message(error.message); }
  finally { if (revision === state.revision) { state.loading = false; paint(); } }
}
async function loadInitial() {
  state.loading = true; paint();
  const revision = state.revision;
  const results = await Promise.allSettled([request('/status'), request('/profile'), request('/usage'), request('/tasks?limit=12')]);
  if (revision !== state.revision) return;
  const [status, profile, usage, history] = results;
  if (status.status === 'fulfilled') state.status = status.value;
  if (profile.status === 'fulfilled') { state.profile = profile.value.profile || {}; if (!state.profileDirty) state.profileDraft = { ...state.profile }; }
  if (usage.status === 'fulfilled') state.usage = usage.value.usage || null;
  if (history.status === 'fulfilled' && Array.isArray(history.value.tasks)) { state.tasks = history.value.tasks; state.cursor = history.value.nextCursor || null; }
  const rejected = results.find(item => item.status === 'rejected');
  state.error = rejected ? message(rejected.reason.message) : '';
  state.loaded = status.status === 'fulfilled' && profile.status === 'fulfilled';
  state.loading = false;
  const pendingId = state.pending?.id || remembered();
  if (pendingId) {
    try { const data = await request('/tasks/' + encodeURIComponent(pendingId)); if (data.task) { if (state.pending?.kind === 'recommend') resolveRecommendation(data.task); else { chooseTask(data.task); state.pending = null; } } }
    catch (error) { if (error.status === 404) { state.pending = null; rememberRecommendation(null); remember(null); state.notice = '上次提交未建立任务，请核对资料和照片后手动开始。'; } else if (error.name !== 'DisposedError') state.error = message(error.message); }
  } else if (!state.task) {
    const running = state.tasks.find(task => ACTIVE.has(task.status));
    if (running) chooseTask(running);
  }
  paint(); schedulePoll(); scheduleQuotaRefresh();
}
function schedulePoll() {
  clearTimeout(state.timer);
  if (!active() || !state.pending && !ACTIVE.has(state.task?.status)) return;
  state.timer = setTimeout(() => { if (active()) void refreshTask(); }, 3500);
}
function scheduleExpiry() {
  clearTimeout(state.expiryTimer);
  if (!active()) return;
  const times = [...state.tasks, ...(state.task ? [state.task] : [])].flatMap(task => [...(task.sourceImages || []), ...(task.files || [])]).map(file => timestamp(file.expiresAt)).filter(time => Number.isFinite(time) && time > Date.now());
  const nearest = Math.min(...times);
  if (Number.isFinite(nearest)) state.expiryTimer = setTimeout(() => paint(), Math.min(2147483647, Math.max(1, nearest - Date.now() + 25)));
}
function scheduleQuotaRefresh() {
  clearTimeout(state.quotaTimer);
  if (!active()) return;
  const offsetTime = Date.now() + 8 * 3600000;
  const nextMidnight = Math.floor(offsetTime / 86400000) * 86400000 + 86400000 - 8 * 3600000;
  state.quotaTimer = setTimeout(async () => { await loadUsage(); paint(); }, nextMidnight - Date.now() + 1000);
}
async function refreshTask() {
  const id = state.pending?.id || state.task?.id || remembered();
  if (!id) { await loadInitial(); return; }
  try {
    const data = await request('/tasks/' + encodeURIComponent(id));
    if (data.task) { const previous = state.task?.status; if (state.pending?.kind === 'analysis' && data.task.status !== 'uploading') releaseFiles(); if (state.pending?.kind === 'recommend') resolveRecommendation(data.task); else { chooseTask(data.task); state.pending = null; } state.error = ''; if (previous !== data.task.status && !ACTIVE.has(data.task.status)) await loadUsage(); }
  } catch (error) {
    if (error.name !== 'DisposedError') state.error = error.status === 404 && state.pending ? '尚未查到已提交任务，请稍后再次查询。不会自动重复生成。' : message(error.message);
  } finally { paint(); schedulePoll(); }
}
async function analyse() {
  if (state.busy || state.pending || !state.loaded || state.status?.enabled === false) return;
  const existing = state.task?.status === 'uploading' ? state.task : null;
  const complete = existing && existing.uploadedCount === existing.imageCount;
  state.error = validateRestaurantProfile(state.profileDraft, { required: false }) || (!complete ? validateRestaurantUploads(state.files) : '') || (!complete && !state.rights ? '请确认照片使用权和人物授权后继续。' : '');
  if (state.error) { if (validateRestaurantProfile(state.profileDraft, { required: false })) state.profileOpen = true; paint(); return; }
  state.busy = true; paint();
  const revision = state.revision;
  state.uploadController = new AbortController();
  const signal = state.uploadController.signal;
  try {
    if (state.profileDirty && !await saveProfile({ silent: true })) return;
    let draft = state.uploadDraft || (complete ? { id: existing.id, imageCount: existing.imageCount, uploadedCount: existing.uploadedCount, fingerprint: fileFingerprint(state.files), rightsConfirmed: true, analyseSubmitted: false } : null);
    if (!draft || state.files.length && fileFingerprint(state.files) !== draft.fingerprint) {
      if (existing?.id) { const cancelled = await request('/tasks/' + encodeURIComponent(existing.id) + '/cancel-upload', { method: 'POST', body: '{}' }); if (cancelled.task) mergeTask(cancelled.task); }
      draft = { id: crypto.randomUUID(), imageCount: state.files.length, outputCount: state.uploadOutputCount || state.files.length, uploadedCount: 0, fingerprint: fileFingerprint(state.files), rightsConfirmed: true, analyseSubmitted: false };
      rememberUpload(draft); remember(draft.id);
    }
    const id = draft.id;
    rememberUpload(draft);
    let task;
    try {
      const found = await request('/tasks/' + encodeURIComponent(id)); task = found.task;
    } catch (error) { if (error.status !== 404) throw error; }
    if (!task) {
      state.pending = { id, kind: 'upload' }; remember(id);
      const created = await request('/tasks', { method: 'POST', body: JSON.stringify({ requestId: id, imageCount: draft.imageCount, rightsConfirmed: true,
        autoGenerate: true, outputCount: draft.outputCount || draft.imageCount }) });
      if (!created.task?.id) throw new Error('素材任务创建状态待确认，请查询任务状态。');
      task = created.task; state.pending = null;
    }
    chooseTask(task, true); paint();
    if (task.status !== 'uploading') { releaseFiles(); return; }
    rememberUpload({ ...draft, uploadedCount: Number(task.uploadedCount) || 0 });
    if (task.uploadedCount < draft.imageCount) {
      if (fileFingerprint(state.files) !== draft.fingerprint) throw new Error('请重新选择原来的整组照片，继续尚未完成的上传。');
      const originals = state.files.map(item => item.file);
      for await (const batch of preparePhotoBatches(originals, { signal, startIndex: Number(task.uploadedCount) || 0, onProgress: progress => { state.uploadProgress = progress; paintUploadProgress(); } })) {
        try {
          const saved = await request('/tasks/' + encodeURIComponent(id) + '/photos', { method: 'POST', body: JSON.stringify(batch) });
          if (!saved.task?.id) throw new Error('照片保存状态待确认，请刷新状态。');
          task = saved.task;
        } catch (error) {
          if (signal.aborted || error.name === 'DisposedError') throw error;
          const checked = await request('/tasks/' + encodeURIComponent(id));
          if (!checked.task || checked.task.uploadedCount < batch.startIndex + batch.images.length) throw error;
          task = checked.task;
        }
        if (revision !== state.revision) return;
        chooseTask(task); rememberUpload({ ...state.uploadDraft, uploadedCount: task.uploadedCount }); paintUploadProgress();
      }
    }
    if (task.uploadedCount !== draft.imageCount) throw new Error('照片尚未全部保存完成，请继续原任务。');
    if (revision !== state.revision || signal.aborted) return;
    rememberUpload({ ...state.uploadDraft, analyseSubmitted: true });
    state.pending = { id, kind: 'analysis' }; remember(id);
    const data = await request('/tasks/' + encodeURIComponent(id) + '/analyse', { method: 'POST', body: '{}' });
    if (!data.task?.id) throw new Error('分析提交状态待确认，请查询任务状态。');
    chooseTask(data.task); state.pending = null; releaseFiles(); state.ctx?.toast?.('照片已保存，正在分析并制作套图。');
  } catch (error) {
    if (error.name !== 'DisposedError') { if (error.status >= 400 && error.status < 500) state.pending = null; state.error = state.pending ? '提交连接中断，请查询同一任务。不会自动重复发起分析。' : signal.aborted ? '上传已暂停，可以继续原任务。' : message(error.message); }
  } finally { if (revision === state.revision) { state.busy = false; state.uploadProgress = null; state.uploadController = null; paint(); schedulePoll(); } }
}
async function mutateTask(action, body = {}) {
  if (state.busy || state.pending || !state.task) return;
  const taskId = state.task.id;
  state.busy = true; state.error = ''; state.notice = ''; paint();
  const revision = state.revision;
  try {
    state.pending = { id: action === 'fork' && body.requestId ? body.requestId : taskId, kind: action, ...(action === 'recommend' ? { requestId: body.requestId } : {}) };
    if (action === 'recommend') rememberRecommendation(state.pending);
    remember(state.pending.id);
    const data = await request('/tasks/' + encodeURIComponent(taskId) + '/' + action, { method: 'POST', body: JSON.stringify(body) });
    if (!data.task?.id) throw new Error('任务提交状态待确认，请查询任务状态。');
    if (action === 'recommend') resolveRecommendation(data.task); else { chooseTask(data.task, data.task.id !== taskId); state.pending = null; }
    if (action === 'fork') { state.selected = data.task.directions?.length === 1 ? data.task.directions[0].id : ''; state.acceptSparse = false; state.confirmWarnings = false; }
    if (['completed', 'generating', 'retrying'].includes(data.task.status)) await loadUsage();
  } catch (error) {
    if (error.name !== 'DisposedError') {
      if (error.status >= 400 && error.status < 500) { state.pending = null; if (action === 'recommend') rememberRecommendation(null); remember(taskId); }
      if (error.missingFacts && state.task) state.task.missingFacts = error.missingFacts;
      state.error = state.pending ? '连接中断，正在核对已提交任务，不会自动再次调用。' : message(error.message);
    }
  } finally { if (revision === state.revision) { state.busy = false; paint(); schedulePoll(); } }
}
async function copySection(section) {
  const value = restaurantCopyText(state.task, section);
  if (!value) return;
  try { await navigator.clipboard.writeText(value); state.ctx?.toast?.('已复制，可粘贴到小红书。'); }
  catch { state.error = '浏览器暂不允许自动复制，请选中文字后手动复制。'; paint(); }
}
async function newTask() {
  if (state.busy || state.pending) return;
  const revision = state.revision;
  state.busy = true; paint();
  try {
    if (state.task?.status === 'uploading') {
      try { const cancelled = await request('/tasks/' + encodeURIComponent(state.task.id) + '/cancel-upload', { method: 'POST', body: '{}' }); if (cancelled.task) mergeTask(cancelled.task); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    if (revision !== state.revision) return;
    state.task = null; state.selected = ''; state.facts = {}; state.rights = false; state.acceptSparse = false; state.confirmWarnings = false; state.error = ''; state.notice = ''; state.outputCount = 0; state.uploadOutputCount = 0;
    rememberUpload(null); remember(null); releaseFiles(); clearTimeout(state.timer);
  } catch (error) { if (error.name !== 'DisposedError') state.error = error.status === 409 ? '原任务已进入分析或生成，请刷新查询原任务，不能取消。' : message(error.message); }
  finally { if (revision === state.revision) { state.busy = false; paint(); } }
}
export function bindRestaurant(ctx) {
  ensureAccount();
  state.ctx = ctx; attachInputs();
  unsubscribeCredits?.(); unsubscribeCredits = subscribeWorkspaceCredits(paint);
  void loadInitial();
}
export function handleRestaurantAction(action, el, ctx) {
  if (!String(action).startsWith('rest-')) return false;
  ensureAccount();
  state.ctx = ctx || state.ctx;
  switch (action.slice(5)) {
    case 'edit-profile': state.profileOpen = true; paint(); document.querySelector('.restaurant-profile')?.scrollIntoView({ behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); document.querySelector('#rest-profile-name')?.focus({ preventScroll: true }); break;
    case 'profile-toggle': state.profileOpen = !state.profileOpen; paint(); break;
    case 'remove-photo': { if (state.busy) break; const index = Number(el.dataset.index); const item = state.files[index]; if (item) { URL.revokeObjectURL(item.url); state.files.splice(index, 1); state.error = ''; paint(); } break; }
    case 'analyse': void analyse(); break;
    case 'recommend': if (canRecommend(state.task)) void mutateTask('recommend', { requestId: crypto.randomUUID() }); break;
    case 'select': if (state.task?.directions?.some(item => item.id === el.dataset.id)) { state.selected = el.dataset.id; state.outputCount = restaurantOutputCount(state.task, selectedDirection(), 0, state.imageMode); state.acceptSparse = false; state.error = ''; state.confirmWarnings = false; paint(); } break;
    case 'generate': if (creditInsufficiency(restaurantCreditEstimate(state.task, selectedDirection()))) { state.error = creditInsufficiency(restaurantCreditEstimate(state.task, selectedDirection())); paint(); break; } if (restaurantCanGenerate(state.task, selectedDirection(), state)) void mutateTask('generate', { directionId: state.selected, imageMode: state.imageMode, facts: state.facts, acceptSparse: state.acceptSparse, outputCount: restaurantOutputCount(state.task, selectedDirection(), state.outputCount, state.imageMode), ...(state.imageMode === 'promotional' ? { workflow: GALLERY_WORKFLOW } : {}) }); break;
    case 'confirm': if (state.confirmWarnings) void mutateTask('confirm', { confirmWarnings: true }); break;
    case 'retry': void mutateTask('retry'); break;
    case 'new-direction': if (!originalsExpired(state.task)) void mutateTask('fork', { requestId: crypto.randomUUID(), ...(state.task?.status === 'failed' ? { reuseCompletedImages: true } : {}) }); break;
    case 'refresh': void refreshTask(); break;
    case 'history-refresh': void loadHistory(); void loadUsage(); break;
    case 'more': void loadHistory(true); break;
    case 'copy': void copySection(el.dataset.section); break;
    case 'open-task': { const task = state.tasks.find(item => item.id === el.dataset.id); if (task) { chooseTask(task, true); paint(); document.querySelector('.restaurant-creation')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); void refreshTask(); } break; }
    case 'new': void newTask(); break;
  }
  return true;
}
export function disposeRestaurant() {
  unsubscribeCredits?.(); unsubscribeCredits = null;
  state.revision++; state.ctx = null; clearTimeout(state.timer); clearTimeout(state.expiryTimer); clearTimeout(state.quotaTimer); state.observer?.disconnect(); state.observer = null;
  state.uploadController?.abort(); state.uploadController = null; state.uploadProgress = null;
  for (const controller of state.controllers) controller.abort(); state.controllers.clear();
  state.busy = false; state.loading = false; state.rights = false; releaseFiles();
  if (state.ownerKey !== null && state.ownerKey !== memoryKey()) clearAccountData(memoryKey());
}
