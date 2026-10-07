import { accountStorageKey } from './account-storage.js';
import { displayModelName, brandModelText } from './model-labels.js';
const STORAGE_KEY = accountStorageKey('store-ai-agent-conversations-v1');
const MAX_LENGTH = 2000;
const MAX_CONTEXT_MESSAGES = 20;
const MAX_CONTEXT_TEXT = 32000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
const STOPPED_MESSAGE = '已停止接收回答；可查询原回答，不会重复提交。';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const attachmentsInMemory = new Map();
const pendingRequests = new Map();
let serviceStatus = null;
let statusRequest = null;
let storageWarningShown = false;
let historyCollapsed = typeof window !== 'undefined' && window.innerWidth < 900;
let historySearch = '';
let focusComposer = false;
let scrollToLatest = false;

function createSession() {
  return { id: crypto.randomUUID(), title: '新对话', updatedAt: new Date().toISOString(), messages: [], draft: { text: '', attachments: [] } };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.version === 1 && Array.isArray(saved.sessions)) {
      const sessions = saved.sessions.filter(session => session && typeof session.id === 'string' && typeof session.title === 'string' && Array.isArray(session.messages)).map(session => ({
        id: session.id,
        title: session.title,
        updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date().toISOString(),
        messages: session.messages.filter(message => message && typeof message.id === 'string' && typeof message.text === 'string').map(message => ({
          id: message.id, text: message.text, role: message.role === 'assistant' ? 'assistant' : 'user',
          requestId: typeof message.requestId === 'string' ? message.requestId : '',
          submitted: message.submitted === true && typeof message.requestId === 'string' && !!message.requestId,
          attachments: Array.isArray(message.attachments) ? message.attachments.filter(name => typeof name === 'string') : [],
          status: message.status === 'pending' ? 'error' : message.status === 'error' ? 'error' : 'complete',
          error: message.status === 'pending' ? '上次回答因页面关闭而中断，可查询原回答。' : typeof message.error === 'string' ? message.error : '',
          errorCode: typeof message.errorCode === 'string' ? message.errorCode : '',
          omitImages: message.omitImages === true,
          model: typeof message.model === 'string' ? message.model : '',
        })),
        draft: { text: typeof session.draft?.text === 'string' ? session.draft.text : '', attachments: Array.isArray(session.draft?.attachments) ? session.draft.attachments.filter(name => typeof name === 'string') : [] },
      }));
      if (sessions.length) return { version: 1, sessions, activeId: sessions.some(session => session.id === saved.activeId) ? saved.activeId : sessions[0].id };
    }
  } catch { /* The conversation remains usable when storage is unavailable. */ }
  const session = createSession();
  return { version: 1, sessions: [session], activeId: session.id };
}

let state = loadState();
function activeSession() { return state.sessions.find(session => session.id === state.activeId) || state.sessions[0]; }
function runtimeFor(session) {
  if (!attachmentsInMemory.has(session.id)) attachmentsInMemory.set(session.id, { draft: [], messages: new Map() });
  return attachmentsInMemory.get(session.id);
}
function persist(ctx) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); storageWarningShown = false; return true; }
  catch {
    if (!storageWarningShown) ctx.toast('浏览器存储不可用，这次对话只保留在当前页面。');
    storageWarningShown = true;
    return false;
  }
}
function sessionTitle(session) {
  const text = (session.messages.find(message => message.role !== 'assistant')?.text || session.draft.text || '').trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 22) + (text.length > 22 ? '…' : '') : '新对话';
}
function saveDraft(ctx) {
  const input = document.getElementById('agent-chat-input');
  const session = activeSession();
  if (input) session.draft.text = input.value;
  session.title = sessionTitle(session);
  persist(ctx);
}
function validAssetIds(ids, ctx) { return ids.filter(id => ctx.assets.some(asset => asset.id === id && asset.type === 'image')); }
function refreshChat(ctx, sessionId, latest = false) {
  if (document.body?.dataset.page !== 'agent') return;
  if (latest && state.activeId === sessionId) scrollToLatest = true;
  saveDraft(ctx);
  ctx.refresh();
}
function requestError(message, code = '') { return Object.assign(new Error(message), { code }); }

// Keep whole recent messages, with a user message at the start of the request.
export function agentContextMessages(messages) {
  const recent = messages.filter(message => message.text?.trim()).slice(-MAX_CONTEXT_MESSAGES);
  while (recent.length > 1 && (recent[0].role === 'assistant' || recent.reduce((sum, message) => sum + message.text.length, 0) > MAX_CONTEXT_TEXT)) recent.shift();
  if (recent.reduce((sum, message) => sum + message.text.length, 0) > MAX_CONTEXT_TEXT) throw requestError('这段内容过长，请精简后重试。', 'context_too_long');
  return recent;
}

async function imageData(asset, signal, remainingBytes) {
  if (!asset) throw requestError('参考图片已不在当前页面，请重新选择图片，或仅用文字继续。', 'attachments_missing');
  let file = asset.file;
  if (!file) {
    try {
      const url = new URL(asset.url, window.location.href);
      if (!['blob:', 'data:'].includes(url.protocol) && url.origin !== window.location.origin) throw new Error('Unsupported image origin');
      const response = await fetch(url.href, { signal });
      if (!response.ok) throw new Error('Image unavailable');
      file = await response.blob();
    } catch (error) {
      if (signal.aborted) throw error;
      throw requestError(`图片“${asset.name}”已失效，请重新选择，或仅用文字继续。`, 'attachments_missing');
    }
  }
  if (!IMAGE_TYPES.has(file.type)) throw requestError(`图片“${asset.name}”需使用 PNG、JPEG 或 WebP 格式。`, 'image_type');
  if (file.size > MAX_IMAGE_BYTES) throw requestError(`图片“${asset.name}”超过 8 MB，请压缩后重新选择。`, 'image_too_large');
  if (file.size > remainingBytes) throw requestError('本轮对话携带的图片合计超过 24 MB，请压缩图片或新建对话选择需要的图片。', 'image_total_too_large');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => { reader.abort(); reject(requestError(STOPPED_MESSAGE, 'cancelled')); };
    reader.onload = () => { signal.removeEventListener('abort', abort); resolve(reader.result); };
    reader.onerror = () => { signal.removeEventListener('abort', abort); reject(requestError('图片读取失败，请重新选择。', 'attachments_missing')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    reader.readAsDataURL(file);
  });
  return { name: asset.name || '参考图片', dataUrl, bytes: file.size };
}

async function requestMessages(session, ctx, signal) {
  const recent = agentContextMessages(session.messages);
  const imageCount = recent.reduce((count, message) => count + (message.role !== 'assistant' && !message.omitImages ? message.attachments.length : 0), 0);
  if (imageCount > MAX_IMAGES) throw requestError('本轮对话最多携带 4 张图片，请新建对话选择需要的图片，或仅用文字继续。', 'image_limit');
  const runtime = runtimeFor(session);
  const result = [];
  let imageBytes = 0;
  for (const message of recent) {
    const item = { role: message.role === 'assistant' ? 'assistant' : 'user', content: message.text };
    if (item.role === 'user' && !message.omitImages && message.attachments.length) {
      const ids = runtime.messages.get(message.id) || [];
      item.images = [];
      for (let index = 0; index < message.attachments.length; index++) {
        if (signal.aborted) throw requestError(STOPPED_MESSAGE, 'cancelled');
        const { bytes, ...image } = await imageData(ctx.assets.find(asset => asset.id === ids[index] && asset.type === 'image'), signal, MAX_TOTAL_IMAGE_BYTES - imageBytes);
        imageBytes += bytes;
        item.images.push(image);
      }
    }
    result.push(item);
  }
  return result;
}

function checkService(ctx) {
  if (statusRequest || serviceStatus) return;
  statusRequest = fetch('/api/ai/status').then(response => response.ok ? response.json() : null).then(data => {
    serviceStatus = data?.chat || { configured: null };
  }).catch(() => { serviceStatus = { configured: null }; }).finally(() => {
    statusRequest = null;
    refreshChat(ctx, state.activeId);
  });
}
function dateLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '历史对话';
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

const suggestions = [
  { icon: 'image', title: '讲清餐饮活动', prompt: '我想宣传门店的餐饮活动。先区分套餐、代金券或单品优惠，再核对价格、包含内容、适用人数、时间和限制，整理成顾客能看懂的图文。没有提供的事实先留待确认。' },
  { icon: 'video', title: '展示美业服务案例', prompt: '我想用真实案例介绍美业服务。请整理顾客诉求、服务项目、过程和适合人群，提醒我补充已获授权的实拍图，不夸大效果，也不伪造前后对比。' },
  { icon: 'image', title: '做一份到店选购攻略', prompt: '我想宣传零售门店。请按顾客的使用场景整理产品选择、材质或规格、实拍细节和到店路线。请先确认价格与适用条件，不编造销量和优惠。' },
  { icon: 'avatar', title: '让工厂接到有效询价', prompt: '我想介绍工厂的生产加工业务。请帮我梳理加工范围、目标采购商、材料或工艺、规格、起订量、打样和交期。让采购商知道询价时要提供什么，不编造产能、资质或客户案例。' },
];

function renderHistory(ctx) {
  const { button, esc, icon } = ctx;
  const sessions = [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(session => !historySearch || [session.title, session.draft.text, ...session.messages.map(message => message.text)].join(' ').toLowerCase().includes(historySearch.toLowerCase()));
  return sessions.map(session => `<div class="agent-history-row ${session.id === state.activeId ? 'active' : ''}">${button('agent-restore', `<span class="agent-history-row-icon">${icon('list')}</span><span><strong>${esc(session.title)}</strong><small>${session.messages.length ? dateLabel(session.updatedAt) : '未发送草稿'}</small></span>`, 'agent-history-entry', `data-id="${esc(session.id)}" ${session.id === state.activeId ? 'aria-current="true"' : ''}`)}${button('agent-delete-request', icon('trash'), 'agent-history-delete', `data-id="${esc(session.id)}" aria-label="删除对话 ${esc(session.title)}" title="删除对话"`)}</div>`).join('') || '<p class="agent-history-empty">没有找到相关对话</p>';
}

function renderAttachments(names, ids, ctx, draft = false) {
  const { esc, button, icon } = ctx;
  if (!names.length) return '';
  let missing = false;
  const items = names.map((name, index) => {
    const asset = ids[index] && ctx.assets.find(item => item.id === ids[index] && item.type === 'image');
    if (!asset) missing = true;
    return `<div class="agent-attachment ${asset ? '' : 'needs-reselect'}">${asset ? `<img src="${esc(asset.url)}" alt="${esc(name)}">` : `<span class="agent-missing-image">${icon('image')}</span>`}<span title="${esc(name)}">${esc(name)}</span>${draft ? button('agent-remove-attachment', '×', 'agent-remove-attachment', `type="button" data-index="${index}" aria-label="移除图片 ${esc(name)}"`) : ''}</div>`;
  }).join('');
  return `<div class="agent-attachments">${items}</div>${missing ? '<small class="agent-attachment-note">图片仅保留在当前页面，历史附件请重新选择。</small>' : ''}`;
}

function renderConversation(ctx) {
  const { icon, esc, button } = ctx;
  const session = activeSession();
  const runtime = runtimeFor(session);
  if (!session.messages.length) return `<div class="agent-welcome"><span class="agent-welcome-mark">${icon('star')}</span><h1>你好，今天想做点什么？</h1><p>说清行业、客户与真实优势，把宣传需求整理清楚</p><div class="agent-suggestions">${suggestions.map((suggestion, index) => button('agent-suggestion', `${icon(suggestion.icon)}<span>${suggestion.title}</span>${icon('arrow')}`, 'agent-suggestion', `data-index="${index}"`)).join('')}</div>${ctx.openBusinessFlow ? button('business-open', icon('list') + '按行业整理宣传信息', 'agent-brief-start', 'data-mode="image"') : ''}</div>`;
  return `<div class="agent-message-list">${session.messages.map((message, index) => {
    if (message.role === 'assistant') return `<article class="agent-assistant-message"><div class="agent-message-meta"><i>${icon('star')}</i><span>宣传助手${message.model ? ` · ${esc(displayModelName(message.model))}` : ''}</span></div><div class="agent-assistant-bubble"><p>${esc(message.text)}</p></div><div class="agent-answer-actions">${Object.entries(ctx.modules).map(([key, module]) => button('agent-transfer-answer', `${icon(key)}用于${esc(module.title)}`, 'agent-transfer', `data-mode="${key}" data-id="${esc(message.id)}"`)).join('')}</div></article>`;
    const last = index === session.messages.length - 1;
    return `<article class="agent-user-message"><div class="agent-message-meta"><span>我</span><i>我</i></div><div class="agent-user-bubble"><p>${esc(message.text)}</p>${renderAttachments(message.attachments, runtime.messages.get(message.id) || [], ctx)}${message.omitImages && message.attachments.length ? '<small class="agent-attachment-note">本轮仅发送了文字，未包含这些图片。</small>' : ''}</div></article>${last && message.status === 'pending' ? `<aside class="agent-answer-state" role="status" aria-live="polite"><span class="agent-thinking-dot"></span><span>正在整理你的宣传方案…</span>${button('agent-stop', '停止', 'agent-inline-action')}</aside>` : last && message.status === 'error' ? `<aside class="agent-answer-state agent-answer-error" role="alert"><div><strong>这次没有完成回答</strong><p>${esc(brandModelText(message.error || '连接暂时不可用，请重试。'))}</p><div class="agent-answer-actions">${button('agent-retry', message.submitted ? '查询原回答' : '重试', 'agent-transfer', `data-id="${esc(message.id)}"`)}${['attachments_missing', 'image_limit', 'image_type', 'image_too_large', 'image_total_too_large'].includes(message.errorCode) ? button('agent-retry-text', '仅用文字重试', 'agent-transfer', `data-id="${esc(message.id)}"`) : ''}${button('agent-edit-failed', '修改这条需求', 'agent-transfer', `data-id="${esc(message.id)}"`)}</div></div></aside>` : ''}`;
  }).join('')}</div>`;
}

export function renderAgentChat(ctx) {
  const { button, esc, icon } = ctx;
  const pending = pendingRequests.has(state.activeId);
  const session = activeSession();
  const runtime = runtimeFor(session);
  return `<div class="agent-layout ${historyCollapsed ? 'history-collapsed' : ''}"><aside class="agent-history" aria-label="历史对话"><div class="agent-history-heading"><h2>历史对话</h2>${button('agent-toggle-history', icon('list'), 'agent-history-toggle', `title="${historyCollapsed ? '展开历史对话' : '收起历史对话'}" aria-label="${historyCollapsed ? '展开历史对话' : '收起历史对话'}" aria-expanded="${!historyCollapsed}"`)}</div>${button('agent-new', icon('plus') + '<span>新对话</span>', 'agent-new-chat', 'title="新对话" aria-label="新对话"')}<label class="agent-history-search">${icon('search')}<input id="agent-history-search" type="search" placeholder="搜索对话" aria-label="搜索历史对话" value="${esc(historySearch)}"></label><div id="agent-history-list" class="agent-history-list">${renderHistory(ctx)}</div><p class="agent-history-note">对话与草稿保存在此浏览器</p></aside><section class="agent-chat-main" aria-label="Agent 对话"><header class="agent-chat-header"><div>${button('agent-toggle-history', icon('list'), 'agent-mobile-history', 'aria-label="打开历史对话"')}<strong>Agent 对话</strong><span>${esc(session.title)}</span></div><small>${serviceStatus?.configured === false ? '服务待配置' : '商家与工厂宣传助手'}</small></header><div id="agent-chat-scroll" class="agent-chat-scroll" tabindex="0" aria-label="对话内容">${renderConversation(ctx)}</div><div class="agent-bottom"><form id="agent-chat-form" class="agent-composer"><div class="agent-composer-input">${button('agent-attach', icon('plus') + '<small>添加图片</small>', 'agent-add-image', 'type="button" aria-label="添加参考图片" title="添加参考图片"')}<div class="agent-input-body"><label class="agent-visually-hidden" for="agent-chat-input">发给 Agent 的宣传需求</label><textarea id="agent-chat-input" maxlength="${MAX_LENGTH}" rows="3" placeholder="告诉我你的行业、想吸引的客户，以及这次要宣传的产品或服务……" aria-describedby="agent-composer-hint agent-char-count">${esc(session.draft.text)}</textarea>${renderAttachments(session.draft.attachments, runtime.draft, ctx, true)}</div></div><div class="agent-composer-footer"><span>${icon('star')}<span>商家与工厂宣传助手</span></span><div><small id="agent-char-count">${session.draft.text.length} / ${MAX_LENGTH}</small><button type="submit" id="agent-send" class="agent-send" aria-label="发送需求" title="发送需求" ${pending || !session.draft.text.trim() || session.draft.text.length > MAX_LENGTH ? 'disabled' : ''}>${icon('arrow')}</button></div></div></form><div class="agent-composer-hint" id="agent-composer-hint"><span>Enter 发送 · Shift + Enter 换行</span><span>最近 20 条参与对话 · 图片仅在当前页面保留</span></div><div class="agent-bottom-tools" aria-label="直接进入创作">${Object.entries(ctx.modules).map(([key, module]) => button('agent-transfer', icon(key) + esc(module.title), 'agent-tool', `data-mode="${key}"`)).join('')}</div></div></section>${!historyCollapsed ? button('agent-toggle-history', '', 'agent-history-backdrop', 'aria-label="关闭历史对话"') : ''}</div>`;
}

function updateComposer(ctx) {
  const session = activeSession();
  const counter = document.getElementById('agent-char-count');
  const send = document.getElementById('agent-send');
  if (counter) counter.textContent = `${session.draft.text.length} / ${MAX_LENGTH}`;
  if (send) send.disabled = pendingRequests.has(session.id) || !session.draft.text.trim() || session.draft.text.length > MAX_LENGTH;
  document.getElementById('agent-chat-input')?.setAttribute('aria-invalid', String(session.draft.text.length > MAX_LENGTH));
}

export function bindAgentChat(ctx) {
  checkService(ctx);
  const input = document.getElementById('agent-chat-input');
  input?.addEventListener('input', () => { saveDraft(ctx); updateComposer(ctx); });
  input?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage(ctx);
    }
  });
  document.getElementById('agent-chat-form')?.addEventListener('submit', event => { event.preventDefault(); sendMessage(ctx); });
  document.getElementById('agent-history-search')?.addEventListener('input', event => {
    historySearch = event.target.value;
    document.getElementById('agent-history-list').innerHTML = renderHistory(ctx);
  });
  if (focusComposer) { input?.focus(); focusComposer = false; }
  if (scrollToLatest) {
    const scroller = document.getElementById('agent-chat-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    scrollToLatest = false;
  }
  updateComposer(ctx);
}

function sendMessage(ctx) {
  saveDraft(ctx);
  const session = activeSession();
  if (pendingRequests.has(session.id)) return;
  const text = session.draft.text.trim();
  if (!text) return;
  if (session.draft.text.length > MAX_LENGTH) { ctx.toast(`一条需求最多 ${MAX_LENGTH} 字，请缩短后发送，原文已保留。`); return; }
  const runtime = runtimeFor(session);
  const message = { id: crypto.randomUUID(), requestId: crypto.randomUUID(), submitted: false, role: 'user', text, attachments: [...session.draft.attachments], status: 'pending' };
  session.messages.push(message);
  runtime.messages.set(message.id, [...runtime.draft]);
  session.draft = { text: '', attachments: [] };
  runtime.draft = [];
  session.updatedAt = new Date().toISOString();
  session.title = sessionTitle(session);
  focusComposer = true;
  void answerSession(session, message, ctx);
}

async function answerSession(session, message, ctx) {
  if (pendingRequests.has(session.id)) return;
  const controller = new AbortController();
  const request = { controller, id: crypto.randomUUID() };
  pendingRequests.set(session.id, request);
  message.status = 'pending';
  message.error = '';
  message.errorCode = '';
  persist(ctx);
  scrollToLatest = true;
  ctx.refresh();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
  try {
    let response;
    if (message.submitted) {
      response = await fetch(`/api/ai/chat/${message.requestId}`, { signal: controller.signal });
    } else {
      const messages = await requestMessages(session, ctx, controller.signal);
      message.requestId ||= crypto.randomUUID();
      message.submitted = true;
      persist(ctx);
      response = await fetch('/api/ai/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: message.requestId, messages }), signal: controller.signal,
      });
    }
    const result = await response.json().catch(() => null);
    if (response.status === 202) throw requestError('原回答还在处理中，请稍后查询。', 'still_processing');
    if (!response.ok) throw requestError(typeof result?.error === 'string' ? result.error.slice(0, 800) : '服务暂时不可用，请稍后重试。', result?.code);
    if (typeof result?.text !== 'string' || !result.text.trim()) throw requestError('服务没有返回可用内容，请重试。', 'empty_response');
    if (controller.signal.aborted) throw requestError(STOPPED_MESSAGE, 'cancelled');
    if (pendingRequests.get(session.id) !== request || !state.sessions.includes(session)) return;
    for (const item of session.messages) {
      if (item.role !== 'assistant') { item.status = 'complete'; item.error = ''; item.errorCode = ''; }
    }
    session.messages.push({ id: crypto.randomUUID(), role: 'assistant', text: result.text.trim(), model: typeof result.model === 'string' ? result.model : '', attachments: [], status: 'complete' });
    session.updatedAt = new Date().toISOString();
  } catch (error) {
    if (pendingRequests.get(session.id) !== request || !state.sessions.includes(session)) return;
    message.status = 'error';
    message.error = controller.signal.aborted ? timedOut ? '等待回答已超时，已停止接收。上游服务可能仍在处理，请稍后确认，避免连续重试。' : STOPPED_MESSAGE : error.message || '连接中断，请重试。';
    message.errorCode = controller.signal.aborted ? 'cancelled' : error.code || 'connection_failed';
  } finally {
    clearTimeout(timeout);
    if (pendingRequests.get(session.id) === request) {
      pendingRequests.delete(session.id);
      persist(ctx);
      refreshChat(ctx, session.id, true);
    }
  }
}

function transferToCreation(target, ctx, answerId = '') {
  saveDraft(ctx);
  const session = activeSession();
  const module = ctx.modules[target];
  if (!module) return;
  const answerIndex = answerId ? session.messages.findIndex(message => message.id === answerId && message.role === 'assistant') : -1;
  if (answerId && answerIndex < 0) return;
  const pieces = answerId ? [session.messages[answerIndex].text] : session.messages.map(message => message.text).filter(text => text.trim());
  if (!answerId && session.draft.text.trim()) pieces.push(session.draft.text.trim());
  const text = pieces.join('\n\n');
  if (text.length > module.max) {
    ctx.toast(`本次对话共有 ${text.length} 字，${module.title}最多支持 ${module.max} 字。请新建对话整理精简需求后转入，原对话已保留。`);
    return;
  }
  const runtime = runtimeFor(session);
  const relevantMessages = answerId ? agentContextMessages(session.messages.slice(0, answerIndex)) : session.messages;
  const allIds = [...new Set([...relevantMessages.flatMap(message => message.omitImages ? [] : runtime.messages.get(message.id) || []), ...(!answerId ? runtime.draft : [])])];
  const files = target === 'avatar' ? [] : allIds.filter(id => ctx.assets.some(asset => asset.id === id && asset.type === module.type));
  if (files.length > module.limit) {
    ctx.toast(`这段对话带有 ${files.length} 张图片，${module.title}最多选择 ${module.limit} 个素材。请新建对话只选择需要的素材再转入。`);
    return;
  }
  if (ctx.configs[target].imagePreset) ctx.configs[target].skill = module.names?.[0]?.[0] || '活动海报';
  delete ctx.configs[target].imagePreset;
  ctx.configs[target].prompt = text;
  ctx.configs[target].files = files;
  delete ctx.configs[target].brief;
  delete ctx.configs[target].contentPlan;
  ctx.beginCreation(target);
  if (target === 'avatar') ctx.toast('需求已带入，请单独选择用于口播的人物形象。');
  else if (target === 'mix') ctx.toast('需求已带入，请在混剪页面添加实拍视频。');
  else if ((session.messages.some(message => message.attachments.length) || session.draft.attachments.length) && !files.length) ctx.toast('需求已带入，历史图片请重新选择。');
}

export function handleAgentChatAction(action, element, ctx) {
  if (!action.startsWith('agent-')) return false;
  const { button, esc } = ctx;
  switch (action) {
    case 'agent-toggle-history': saveDraft(ctx); historyCollapsed = !historyCollapsed; ctx.refresh(); break;
    case 'agent-new': {
      saveDraft(ctx);
      const current = activeSession();
      if (current.messages.length || current.draft.text || current.draft.attachments.length) {
        const session = createSession();
        state.sessions.unshift(session);
        state.activeId = session.id;
      }
      historySearch = '';
      if (window.innerWidth < 900) historyCollapsed = true;
      persist(ctx);
      focusComposer = true;
      ctx.refresh();
      break;
    }
    case 'agent-restore':
      if (!state.sessions.some(session => session.id === element.dataset.id)) break;
      saveDraft(ctx);
      state.activeId = element.dataset.id;
      if (window.innerWidth < 900) historyCollapsed = true;
      persist(ctx);
      scrollToLatest = true;
      ctx.refresh();
      break;
    case 'agent-suggestion': {
      const suggestion = suggestions[Number(element.dataset.index)];
      if (!suggestion) break;
      saveDraft(ctx);
      if (activeSession().draft.text.trim()) {
        const input = document.getElementById('agent-chat-input');
        ctx.toast('输入框已有未发送的内容，请先发送或清空，再使用示例。');
        input?.focus();
        break;
      }
      activeSession().draft.text = suggestion.prompt;
      activeSession().title = sessionTitle(activeSession());
      persist(ctx);
      focusComposer = true;
      ctx.refresh();
      break;
    }
    case 'agent-attach': {
      saveDraft(ctx);
      const session = activeSession();
      const runtime = runtimeFor(session);
      ctx.picker('image', true, { max: MAX_IMAGES, selected: validAssetIds(runtime.draft, ctx), onConfirm: ids => {
        if (!state.sessions.includes(session)) return;
        runtime.draft = validAssetIds(ids, ctx).slice(0, MAX_IMAGES);
        session.draft.attachments = runtime.draft.map(id => ctx.assets.find(asset => asset.id === id).name);
        persist(ctx);
      } });
      break;
    }
    case 'agent-remove-attachment': {
      saveDraft(ctx);
      const session = activeSession();
      const index = Number(element.dataset.index);
      if (!Number.isInteger(index) || index < 0 || index >= session.draft.attachments.length) break;
      session.draft.attachments.splice(index, 1);
      runtimeFor(session).draft.splice(index, 1);
      persist(ctx);
      focusComposer = true;
      ctx.refresh();
      break;
    }
    case 'agent-transfer': transferToCreation(element.dataset.mode, ctx); break;
    case 'agent-transfer-answer': transferToCreation(element.dataset.mode, ctx, element.dataset.id); break;
    case 'agent-stop': pendingRequests.get(state.activeId)?.controller.abort(); break;
    case 'agent-retry':
    case 'agent-retry-text': {
      saveDraft(ctx);
      const session = activeSession();
      const message = session.messages.at(-1);
      if (pendingRequests.has(session.id) || message?.id !== element.dataset.id || message.role === 'assistant' || message.status !== 'error') break;
      if (action === 'agent-retry-text') {
        for (const item of agentContextMessages(session.messages)) if (item.role !== 'assistant' && item.attachments.length) item.omitImages = true;
      }
      void answerSession(session, message, ctx);
      break;
    }
    case 'agent-edit-failed': {
      saveDraft(ctx);
      const session = activeSession();
      const message = session.messages.at(-1);
      if (pendingRequests.has(session.id) || message?.id !== element.dataset.id || message.status !== 'error') break;
      if (session.draft.text.trim() || session.draft.attachments.length) { ctx.toast('输入框中还有草稿，请先保存或清空，再修改这条需求。'); break; }
      const runtime = runtimeFor(session);
      session.draft = { text: message.text, attachments: [...message.attachments] };
      runtime.draft = [...(runtime.messages.get(message.id) || [])];
      session.messages.pop();
      runtime.messages.delete(message.id);
      persist(ctx);
      focusComposer = true;
      ctx.refresh();
      break;
    }
    case 'agent-delete-request': {
      saveDraft(ctx);
      const session = state.sessions.find(item => item.id === element.dataset.id);
      if (!session) break;
      ctx.openModal('删除这段对话？', '删除后，保存在此浏览器的消息和未发送草稿将无法恢复。', `<p class="agent-delete-summary">${esc(session.title)}</p><footer class="modal-actions">${button('cancel', '取消', 'secondary')}${button('agent-delete-confirm', '删除对话', 'primary', `data-id="${esc(session.id)}"`)}</footer>`);
      break;
    }
    case 'agent-delete-confirm': {
      const index = state.sessions.findIndex(session => session.id === element.dataset.id);
      if (index < 0) break;
      pendingRequests.get(element.dataset.id)?.controller.abort();
      pendingRequests.delete(element.dataset.id);
      state.sessions.splice(index, 1);
      attachmentsInMemory.delete(element.dataset.id);
      if (!state.sessions.length) state.sessions.push(createSession());
      if (!state.sessions.some(session => session.id === state.activeId)) state.activeId = state.sessions[0].id;
      persist(ctx);
      document.getElementById('modal')?.close();
      ctx.refresh();
      break;
    }
    default: return false;
  }
  return true;
}
