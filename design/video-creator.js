import { CLOUD_COLLECTIONS, createWorkspaceSync } from './video-creator-sync.js';
import { uiLocale, t } from './workspace-preferences.js';
import { markdownText } from './markdown.js';
import { collectGeneratedAssets } from './generated-assets.js';
import { uiIcon, SKILL_ART, mediaUrl, readUiStore, writeUiStore, promptMarkup, readPromptEditor, insertEditorText, directorDocument, emptyDirectorArt, previewArtwork, encodeWav } from './video-creator-ui.js';
import { VIDEO_SKILLS, VIDEO_HOOKS, VIDEO_MODELS, VIDEO_RATIOS, VIDEO_LANGUAGES, DEFAULT_VIDEO_SETTINGS, VIDEO_IMAGE_MAX_BYTES, VIDEO_AUDIO_MAX_BYTES, videoAssetPurpose } from './video-catalog.js';
import { draftSnapshot, remapMaterialReferences, hasMissingReferences } from './video-creator-drafts.js';
import { accountStorageKey } from './account-storage.js';
import { refreshWorkspaceCredits, workspaceCreditsState } from './workspace-credits.js';

const API = '/api/video-creator';
const labels = { reserving: '预留积分', preparing: '准备素材', reviewing: '素材审核', submitting: '提交生成', running: '生成中', downloading: '保存成片', completed: '已完成', failed: '未完成', uncertain: '结果待核对', settling: '费用待核对', expired: '已过期' };
const busyTask = task => ['reserving', 'preparing', 'reviewing', 'submitting', 'running', 'downloading', 'settling'].includes(task.status);
let context, timer, stream, voiceSession, loading = false, loadPromise, quoteVersion = 0;
let state, cloud, cloudOwner;
function ensureCloud() {
  if (cloudOwner === owner() && cloud) return cloud;
  cloud?.close(); const account = owner(); cloudOwner = account;
  if (!readUiStore(uiKey('prompts'), null)) writeUiStore(uiKey('prompts'), readUiStore(accountStorageKey('video-creator-prompts'), []));
  const keys = Object.fromEntries([...CLOUD_COLLECTIONS, 'cloud-cache','cloud-pending','cloud-migrated'].map(k => [k,uiKey(k)]));
  cloud = createWorkspaceSync({ read:(key,fallback)=>readUiStore(keys[key],fallback), write:(key,value)=>writeUiStore(keys[key],value), request:(...args)=>{if(owner()!==account)throw new Error('账号已切换');return request(...args);},
    protect:()=>state?.owner===account ? state.draftId : null,
    changed:()=>{ if(state?.owner===account) { const label=document.querySelector('#vc-draft-status'); if(label) label.textContent=syncLabel(); } },
    conflict:(collection,oldId,newId)=>{ if(state?.owner!==account)return; if(collection==='drafts' && state.draftId===oldId && newId) state.draftId=newId; context?.toast(newId ? '其他页面已修改，已保留两个版本。' : '其他页面已修改，请刷新确认最新记录。'); } });
  return cloud;
}
function syncLabel() { return state?.draftSaveFailed ? '草稿未保存，请保留当前页面' : ({synced:'已同步',syncing:'同步中…',pending:'待同步',offline:'已存本机，联网后同步',rejected:'云端未保存，请检查记录容量'})[cloud?.status] || '已存本机'; }
function owner() { return globalThis.workspaceUser?.id || 'local-dev'; }
const editableSettings = settings => ({ ...DEFAULT_VIDEO_SETTINGS, ...settings, resolution: DEFAULT_VIDEO_SETTINGS.resolution });
function replanResolution(settings) {
  state.settings = editableSettings(settings); state.stage = 'director'; state.scriptId = null; state.referenceImageIds = null; state.prompt = '';
  state.input = '按720p重新输出上一版完整脚本，保留原有分镜、内容和其他设置。';
}
function reset() { closePopover(); stopVoice(); stopRecording(true); state = { owner: owner(), skill: VIDEO_SKILLS[0].id, settings: { ...DEFAULT_VIDEO_SETTINGS }, config: null, session: null,
  tasks: [], conversations: [], input: '', prompt: '', scriptId: null, referenceImageIds: null, stage: 'director', busy: false, activity: '', actionToken: null, error: '', errorSource: '', errorKind: '', selectedTask: null,
  draftId: null, draftRestored: false, expandedMaterials: true, preview: 'result', sidebar: uiRead('sidebar', typeof innerWidth !== 'number' || innerWidth >= 1180), queue: uiRead('queue', true), popover: null, picker: null, quote: null, quoteError: '', uploadLabel: '', bridge: null }; }
function refresh() {
  persistDraft();
  if (!context || document.body.dataset.page !== 'video' || state.owner !== owner()) return;
  if (state.popover || document.querySelector('#modal[open]')) { state.refreshQueued = true; return; }
  const active = document.activeElement, editor = active?.matches('.vc-rich-editor') && active;
  const conversation = document.querySelector('.vc-conversation');
  state.view = { focus: active?.id, start: active?.selectionStart, end: active?.selectionEnd, scroll: conversation?.scrollTop, follow: conversation && conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop < 100, queueScroll: document.querySelector('.vc-task-list')?.scrollTop, richScroll: document.querySelector('#vc-prompt')?.scrollTop };
  if (editor) {
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.contains(selection.anchorNode)) { const range = document.createRange(); range.selectNodeContents(editor); range.setEnd(selection.anchorNode, selection.anchorOffset); state.view.caret = range.toString().length; }
  }
  const video = document.querySelector('#vc-result-video');
  if (video) state.view.playback = { id: state.selectedTask, time: video.currentTime, paused: video.paused, muted: video.muted };
  context.refresh();
}
function localDrafts() { return uiRead('drafts', []).filter(d => d && typeof d.id === 'string' && VIDEO_SKILLS.some(s => s.id === d.skill)); }
function persistDraft(force = false) {
  if (!state || state.owner !== owner() || state.restoringDraft) return true;
  if (!state.draftId && (force || !state.selectedTask && (state.input || state.prompt || state.session?.assets.length))) state.draftId = crypto.randomUUID();
  if (!state.draftId) return true;
  const snapshot = draftSnapshot(state), drafts = localDrafts(), old = drafts.find(d => d.id === snapshot.id);
  const fingerprint = JSON.stringify(snapshot);
  if (old?.fingerprint === fingerprint) { state.draftSaveFailed = false; return true; }
  const saved = { ...snapshot, fingerprint, updatedAt: Date.now() };
  if (!uiWrite('drafts', [saved, ...drafts.filter(d => d.id !== saved.id)])) { state.draftSaveFailed = true; const label = document.querySelector('#vc-draft-status'); if (label) label.textContent = '草稿未保存，请保留当前页面'; return false; }
  state.draftSaveFailed = false; uiWrite('active-draft', saved.id);
  const label = document.querySelector('#vc-draft-status'); if (label) label.textContent = syncLabel();
  return true;
}
async function openLocalDraft(id) {
  if (!persistDraft()) return;
  const draft = localDrafts().find(d => d.id === id); if (!draft) return;
  const account = state.owner;
  let session = null;
  try { if (draft.conversationId) session = (await request(`/conversations/${draft.conversationId}`)).conversation; }
  catch (cause) { if (cause.status !== 404 && cause.status !== 410) throw cause; context.toast('原素材已过期，文字已恢复，请重新添加素材。'); }
  if (state.owner !== account) return;
  state.restoringDraft = true;
  state.session = null; if (session) saveSession(session);
  Object.assign(state, { draftId: draft.id, skill: draft.skill, settings: editableSettings(draft.settings), input: draft.input || '', prompt: draft.prompt || '',
    stage: draft.stage === 'generation' ? 'generation' : 'director', scriptId: draft.scriptId || null, referenceImageIds: draft.referenceImageIds || null,
    selectedTask: draft.selectedTask || null, preview: 'result', pendingScriptRequest: null, generationRequest: null });
  state.restoringDraft = false; uiWrite('active-draft', draft.id); state.quote = null; void quote();
}
const meaningfulDraft = d => Boolean(d.conversationId || d.input?.trim() || d.prompt?.trim());
function localDraftRows(ctx) {
  return localDrafts().filter(d => d.id !== state.draftId && meaningfulDraft(d) && !uiRead('hidden-local-drafts', []).includes(d.id)).map(d => `<article class="vc-task-row"><button type="button" class="vc-task" data-action="vc-open-local-draft" data-id="${ctx.esc(d.id)}" ${state.busy ? 'disabled' : ''} aria-label="打开草稿 ${ctx.esc(d.title)}"><span class="vc-task-thumb vc-draft-thumb">${ctx.icon('list')}</span><span class="vc-task-copy"><strong>${ctx.esc(d.title)}</strong><span class="vc-task-status">草稿</span><small>${new Date(d.updatedAt).toLocaleString(uiLocale(), {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</small></span></button></article>`).join('');
}
function editorAssets(root) { return root?.id === 'vc-message' ? state.session?.assets || [] : referenceAssets(); }
function editorField(root) { return root?.id === 'vc-message' ? 'input' : 'prompt'; }
function missingReferenceNotice() { return hasMissingReferences(state.stage === 'director' ? state.input : state.prompt) ? '<p class="vc-reference-warning" role="status">有素材已移除，请修改标记处的引用后继续。</p>' : ''; }
function currentTask() { return state.tasks.find(t => t.id === state.selectedTask); }
function pendingOp() { return state.session?.operations.findLast(o => ['queued', 'running', 'settling'].includes(o.status)); }
function locked() { return state.busy || Boolean(voiceSession) || Boolean(pendingOp()) || state.session?.tasks.some(busyTask); }
function latestScript() { return state.session?.operations.findLast(o => o.status === 'completed' && o.skill === state.skill && o.result?.script); }
function canSendDirector() {
  return !locked() && !hasMissingReferences(state.input) && state.config?.directorEnabled !== false && state.session?.assets.some(a => a.type === 'image' && !a.expired && a.url)
    && (Boolean(state.input.trim()) || !state.session.operations.length);
}
function updateDirectorControls() {
  const send = document.querySelector('[data-action="vc-send"]'); if (send) send.disabled = !canSendDirector();
}
function settledSnapshot(previous, incoming) {
  return previous?.status === 'completed' && ['queued', 'reserving', 'preparing', 'reviewing', 'submitting', 'running', 'downloading', 'settling'].includes(incoming.status) ? previous : incoming;
}
function putOperation(operation) {
  const previous = state.session.operations.find(o => o.id === operation.id);
  state.session.operations = [...state.session.operations.filter(o => o.id !== operation.id), settledSnapshot(previous, operation)];
}
function acknowledgeRequest(kind) {
  if (state.activity === kind) { state.busy = false; state.activity = ''; state.actionToken = null; }
  if (state.errorSource === 'action' && state.errorKind === kind) { state.error = ''; state.errorSource = ''; state.errorKind = ''; }
}
function recoverAcceptedRequests() {
  let changed = false;
  const pending = state.pendingScriptRequest;
  if (pending && state.session?.operations.some(o => o.id === pending.body.requestId)) {
    if (state.input === pending.input) state.input = '';
    state.pendingScriptRequest = null; acknowledgeRequest('director'); changed = true;
  }
  const generation = state.generationRequest;
  const task = generation && state.tasks.find(t => t.id === generation.id);
  if (task && state.session?.id === task.conversationId) {
    state.selectedTask = task.id; state.stage = 'generation'; state.preview = 'result';
    state.generationRequest = null; acknowledgeRequest('generation'); void refreshWorkspaceCredits(); changed = true;
  }
  return changed;
}
const speechEngine = () => globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const composerIcon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${name === 'person' ? 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2' : name === 'voice' ? 'M11 5 6 9H3v6h3l5 4V5 M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14' : 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5 M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8'}"/></svg>`;
function stopVoice() {
  const current = voiceSession; if (!current) return;
  voiceSession = null; clearTimeout(current.timer);
  if (state?.owner === current.owner) state[current.target] = current.final ? (current.prefix + current.final).slice(0, current.target === 'prompt' ? 12000 : 8000) : current.initial;
  try { current.recognition.abort(); } catch {}
}
function syncVoiceControls() {
  document.querySelectorAll('[data-action="vc-direct-voice"]').forEach(b => { b.disabled = !voiceSession && (!speechEngine() || locked()); b.setAttribute('aria-label', voiceSession ? '停止语音输入' : '语音输入视频提示词'); b.classList.toggle('is-listening', Boolean(voiceSession)); });
  const root = document.querySelector('#vc-expanded-prompt'); if (root) { root.setAttribute('contenteditable', String(!locked())); root.innerHTML = promptMarkup(state.prompt, referenceAssets()); }
}
function toggleVoice() {
  if (voiceSession) { try { voiceSession.recognition.stop(); } catch { stopVoice(); refresh(); } return; }
  if (locked()) return;
  const Engine = speechEngine(); if (!Engine) { context.toast('当前浏览器不支持语音输入，请使用 Chrome 或直接输入文字。'); return; }
  const target = state.stage === 'generation' ? 'prompt' : 'input', initial = state[target];
  const recognition = new Engine(), current = { recognition, owner: state.owner, target, initial, prefix: initial ? initial + '\n' : '', final: '' };
  voiceSession = current; state.error = ''; state.errorSource = '';
  recognition.lang = ({ zh: 'zh-CN', en: 'en-US', th: 'th-TH', ms: 'ms-MY', pt: 'pt-BR' })[state.settings.language] || 'zh-CN';
  recognition.continuous = true; recognition.interimResults = true;
  const valid = () => voiceSession === current && state.owner === current.owner && owner() === current.owner && document.body.dataset.page === 'video';
  const finish = () => { if (voiceSession !== current) return; clearTimeout(current.timer); voiceSession = null; if (state.owner === current.owner) state[current.target] = current.final ? (current.prefix + current.final).slice(0, current.target === 'prompt' ? 12000 : 8000) : current.initial; syncVoiceControls(); refresh(); };
  recognition.onresult = event => {
    if (!valid()) return; let final = '', interim = '';
    for (let i = 0; i < event.results.length; i++) { const result = event.results[i]; if (result.isFinal) final += result[0].transcript; else interim += result[0].transcript; }
    current.final = final; state[current.target] = (current.prefix + final + interim).slice(0, current.target === 'prompt' ? 12000 : 8000);
    const input = document.querySelector(current.target === 'prompt' ? '#vc-expanded-prompt' : '#vc-message') || document.querySelector('#vc-prompt'); if (input) { if (current.target === 'prompt') input.innerHTML = promptMarkup(state.prompt, referenceAssets()); else input.innerHTML = promptMarkup(state.input, state.session?.assets || []); }
    persistDraft(true);
    if (current.prefix.length + final.length + interim.length >= (current.target === 'prompt' ? 12000 : 8000)) recognition.stop();
  };
  recognition.onerror = event => {
    if (!valid()) return;
    if (event.error !== 'aborted') { state.error = ({ 'not-allowed': '请允许浏览器使用麦克风后重试。', 'service-not-allowed': '浏览器暂不允许语音识别，请直接输入文字。', 'audio-capture': '未找到可用麦克风，请检查设备。', network: '语音识别连接失败，请重试或直接输入文字。', 'no-speech': '没有识别到声音，请重试。' })[event.error] || '语音识别未完成，请重试或直接输入文字。'; state.errorSource = 'action'; }
    if (state.error && document.querySelector('#modal[open]')) context.toast(state.error);
    finish();
  };
  recognition.onend = finish;
  try { recognition.start(); current.timer = setTimeout(() => { if (valid()) recognition.stop(); }, 90000); syncVoiceControls(); refresh(); }
  catch { state.error = '无法启动语音输入，请检查浏览器和麦克风权限。'; state.errorSource = 'action'; finish(); }
}
async function request(path, options = {}) {
  const response = await fetch(API + path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(options.method === 'PUT' ? 120000 : 20000), ...options });
  let data; try { data = await response.json(); } catch { throw new Error('视频服务暂时不可用，请稍后重试。'); }
  if (!response.ok) throw Object.assign(new Error(data.error || '操作未完成，请稍后重试。'), { status: response.status, code: data.code }); return data;
}
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
async function perform(work, kind = 'general') {
  if (state.busy || voiceSession) return;
  const account = state.owner, token = Symbol(kind); state.actionToken = token; state.activity = kind; state.busy = true; state.error = ''; state.errorSource = ''; state.errorKind = ''; refresh();
  try { await work(); }
  catch (cause) { if (state.owner === account && state.actionToken === token) {
    state.error = cause.name === 'TimeoutError' ? '请求超时，正在核对任务状态。' : cause.message === 'Failed to fetch' ? '连接中断，正在核对任务状态。' : cause.message;
    state.errorSource = 'action'; state.errorKind = kind;
    if (cause.status >= 400 && cause.status < 500) { if (kind === 'director') state.pendingScriptRequest = null; if (kind === 'generation') state.generationRequest = null; }
  } }
  finally { if (state.owner === account && state.actionToken === token) { state.busy = false; state.activity = ''; state.actionToken = null; state.uploadLabel = ''; refresh(); } }
}
function saveSession(session) {
  const previous = state.session?.id === session.id && state.session;
  if (previous && previous.version > session.version) return;
  if (previous) session = { ...session,
    operations: session.operations.map(op => settledSnapshot(previous.operations.find(p => p.id === op.id), op)),
    tasks: session.tasks.map(task => settledSnapshot(previous.tasks.find(p => p.id === task.id), task)) };
  state.session = session; state.skill = session.skill; rememberAssets();
}
async function ensureSession() {
  if (state.session) return state.session.id;
  const account = state.owner, requestId = state.draftRequestId ||= crypto.randomUUID();
  const data = await request('/conversations', post({ requestId, skill: state.skill, settings: state.settings }));
  if (account !== state.owner) throw new Error('账号已切换，请重新打开创作。');
  saveSession(data.conversation); return state.session.id;
}
async function upload(files, purpose) {
  const reopen = state.uploadReturnExpanded; state.uploadReturnExpanded = false;
  const uploadFolderId = state.uploadFolderId; state.uploadFolderId = null;
  const replaceId = state.replaceUploadId; state.replaceUploadId = null;
  if (replaceId) {
    const file = files[0], before = referenceAssets(), old = before.find(a => a.id === replaceId);
    if (!old || !file) return;
    const image = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type), audio = ['audio/mpeg','audio/wav','audio/x-wav'].includes(file.type);
    if (old.type === 'image' ? !image || file.size >= VIDEO_IMAGE_MAX_BYTES : !audio || file.size > VIDEO_AUDIO_MAX_BYTES) { context.toast('请选择大小符合要求的同类型素材。'); return; }
    const replacement = { id: crypto.randomUUID(), file, name: file.name, type: old.type, purpose: videoAssetPurpose(old) };
    await perform(() => replaceMaterialSet(before.map(a => a.id === old.id ? replacement : a), { [old.id]: replacement.id }));
    if (reopen) expandEditor(); return;
  }
  await perform(async () => {
    for (const file of files) {
      const image = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type), audio = ['audio/mpeg', 'audio/wav', 'audio/x-wav'].includes(file.type);
      if (!image && !audio) throw new Error('图片支持 JPG、PNG、WebP，声音支持 MP3、WAV。');
      if (image ? file.size >= VIDEO_IMAGE_MAX_BYTES : file.size > VIDEO_AUDIO_MAX_BYTES) throw new Error(image ? '单张图片需小于50MB。' : '声音文件不能超过15MB。');
    }
    const account = state.owner;
    if (state.session && (state.session.operations.length || state.session.tasks.length || state.prompt || purpose === 'voice' && state.session.assets.some(a => a.type === 'audio'))) {
      const previous = referenceAssets().filter(a => purpose !== 'voice' || a.type !== 'audio');
      const added = files.map(file => ({ id: crypto.randomUUID(), file, name: file.name, type: file.type.startsWith('audio/') ? 'audio' : 'image', purpose: purpose || 'reference' }));
      return replaceMaterialSet([...previous, ...added]);
    }
    if (state.owner !== account || owner() !== account) return;
    const id = await ensureSession();
    for (let index = 0; index < files.length; index++) {
      if (state.owner !== account) return;
      const file = files[index], image = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type), audio = ['audio/mpeg', 'audio/wav', 'audio/x-wav'].includes(file.type);
      if (!image && !audio) throw new Error('图片支持 JPG、PNG、WebP，声音支持 MP3、WAV。');
      const assetPurpose = purpose || (audio ? 'voice' : 'reference');
      if (image && assetPurpose === 'voice' || audio && assetPurpose !== 'voice') throw new Error('请按当前入口选择图片或声音文件。');
      if (image ? file.size >= VIDEO_IMAGE_MAX_BYTES : file.size > VIDEO_AUDIO_MAX_BYTES) throw new Error(image ? '单张图片需小于50MB。' : '声音文件不能超过15MB。');
      if (state.session.assets.filter(a => a.type === (image ? 'image' : 'audio')).length >= (image ? 30 : 1)) throw new Error(image ? '最多添加30张图片。' : '最多选择一段声音参考。');
      if (assetPurpose === 'character' && state.session.assets.filter(a => videoAssetPurpose(a) === 'character').length >= 10) throw new Error('最多添加10张角色参考图。');
      state.uploadLabel = `上传素材 ${index + 1}/${files.length}`; refresh();
      let data; try { data = await request(`/conversations/${id}/assets/${crypto.randomUUID()}`, { method: 'PUT', headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), 'X-Asset-Purpose': assetPurpose }, body: file }); }
      catch(cause) { throw Object.assign(new Error(`${file.name} 上传未完成：${cause.message}。已成功上传的素材会保留。`),{status:cause.status,code:cause.code}); }
      if (state.owner !== account) return; saveSession(data.conversation);
      if(uploadFolderId && uiRead('folders',[]).some(f=>f.id===uploadFolderId)) { const asset=data.conversation.assets.at(-1), key=asset.originKey||asset.id; uiWrite('asset-meta',[...uiRead('asset-meta',[]).filter(a=>a.id!==key),{id:key,folderId:uploadFolderId}]); }
    }
    state.scriptId = null; state.referenceImageIds = null; state.quote = null; void quote();
    state.expandedMaterials = true;
  });
  if (reopen) expandEditor();
}
function consumedCredits() {
  const operations = state.session?.operations || [];
  const points = operations.reduce((sum, op) => sum + (op.billing?.status === 'settled' && Number.isSafeInteger(op.billing.chargedPoints) ? op.billing.chargedPoints : 0), 0);
  return `已消耗 ${points.toLocaleString(uiLocale())} 积分${operations.some(op => op.billing && !['settled', 'released'].includes(op.billing.status)) ? ' · 核对中' : ''}`;
}
async function quote() {
  const revision = ++quoteVersion, account = state.owner;
  try {
    const data = await request('/quote', post({ settings: state.settings }));
    if (revision !== quoteVersion || account !== state.owner) return;
    state.quote = data; state.quoteError = ''; refresh();
  } catch (cause) { if (revision === quoteVersion && account === state.owner) { state.quote = null; state.quoteError = cause.message; refresh(); } }
}
function load() {
  if (!loadPromise) {
    const pending = loadOnce().finally(() => { if (loadPromise === pending) loadPromise = null; });
    loadPromise = pending;
  }
  return loadPromise;
}
async function loadOnce() {
  if (loading || !context) return; loading = true; const account = state.owner;
  const conversationId = state.session?.id;
  const workspaceBefore=JSON.stringify(CLOUD_COLLECTIONS.map(key=>uiRead(key,[])));
  try {
    const current = conversationId ? request(`/conversations/${conversationId}`).then(data => {
      if (state.owner !== account || state.session?.id !== conversationId) return;
      let changed = JSON.stringify(data.conversation) !== JSON.stringify(state.session);
      saveSession(data.conversation);
      for (const task of state.session.tasks) state.tasks = [settledSnapshot(state.tasks.find(t => t.id === task.id), task), ...state.tasks.filter(t => t.id !== task.id)];
      changed = recoverAcceptedRequests() || changed;
      if (changed) refresh();
    }) : Promise.resolve();
    const catalog = Promise.all([state.config ? Promise.resolve(state.config) : request('/config'), request('/tasks'), request('/conversations')]).then(([config, tasks, conversations]) => {
      if (state.owner !== account) return;
      const previous = state.tasks;
      const merged = tasks.tasks.map(task => settledSnapshot(previous.find(t => t.id === task.id), task));
      let changed = JSON.stringify(previous) !== JSON.stringify(merged) || JSON.stringify(state.conversations) !== JSON.stringify(conversations.conversations) || !state.config;
      state.config = config; state.tasks = merged; state.conversations = conversations.conversations;
      if (state.session) state.session.tasks = state.session.tasks.map(task => settledSnapshot(task, merged.find(t => t.id === task.id) || task));
      changed = recoverAcceptedRequests() || changed;
      if (changed) refresh();
    });
    const results = await Promise.allSettled([current, catalog, ensureCloud().sync(), request('/library').then(data => { if (state.owner === account) state.cloudAssets = data.assets; })]);
    if (state.owner !== account) return;
    if(workspaceBefore!==JSON.stringify(CLOUD_COLLECTIONS.map(key=>uiRead(key,[])))) { refresh(); if(state.picker&&document.querySelector('#vc-library-grid'))renderLibraryGrid(); }
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    if (state.errorSource === 'poll') { state.error = ''; state.errorSource = ''; refresh(); }
    if (!state.quote && !state.quoteError) void quote();
  } catch (cause) { if (state.owner === account && state.errorSource !== 'action') { state.error = cause.name === 'TimeoutError' ? '读取视频任务超时，正在重新连接。' : cause.message; state.errorSource = 'poll'; refresh(); } }
  finally { loading = false; }
}
function uiKey(suffix) { return accountStorageKey('video-creator-ui-' + suffix); }
function uiRead(suffix, fallback) { return readUiStore(uiKey(suffix), fallback); }
function uiWrite(suffix, value) { try { if (CLOUD_COLLECTIONS.includes(suffix)) ensureCloud().set(suffix,value); else writeUiStore(uiKey(suffix), value); return true; } catch { context?.toast('浏览器存储空间不足，请清理后重试。'); return false; } }
function referenceAssets() {
  const assets = state.session?.assets || [], images = state.stage === 'generation' && state.referenceImageIds ? state.referenceImageIds.map(id => assets.find(a => a.id === id)).filter(Boolean) : assets.filter(a => a.type === 'image');
  return images.concat(assets.filter(a => a.type === 'audio'));
}
function rememberAssets() {
  if (!state.session) return;
  const previous = uiRead('assets', []), timestamp = Date.now(), current = state.session.assets.filter(a => mediaUrl(a.url) && !a.expired).map(a => ({ ...previous.find(p => p.id === a.id), ...a, source: 'uploaded', conversationId: state.session.id, createdAt: previous.find(p => p.id === a.id)?.createdAt || timestamp, expiresAt: state.session.mediaExpiresAt }));
  uiWrite('assets', [...current, ...previous.filter(a => !current.some(c => c.id === a.id))].filter(a => !a.expiresAt || a.expiresAt > timestamp).slice(0, 180));
}
function assetLibrary() {
  const stored = uiRead('assets', []), map = new Map(stored.filter(a => mediaUrl(a.url) && (!a.expiresAt || a.expiresAt > Date.now())).map(a => [a.originKey || a.id, a]));
  for (const a of state.session?.assets || []) if (a.url && !a.expired) { const merged = { ...stored.find(item => item.id === a.id), ...a }; map.set(merged.originKey || a.id, merged); }
  for (const a of context.assets || []) if (a.type === 'image' && mediaUrl(a.url)) map.set('workspace-' + a.id, { ...a, id: 'workspace-' + a.id, purpose: 'reference', source: 'uploaded' });
  for (const a of state.cloudAssets || []) map.set(a.originKey || a.id, {...map.get(a.originKey || a.id),...a});
  const metadata=new Map(uiRead('asset-meta',[]).map(a=>[a.id,a]));
  return [...map.values()].map(a=>({...a, folderId:metadata.get(a.originKey || a.id)?.folderId || null}));
}
function rememberOrigin(asset, origin) {
  if (!asset || !origin) return;
  const previous = uiRead('assets', []), original = previous.find(a => a.id === origin.id) || origin;
  uiWrite('assets', previous.map(a => a.id === asset.id ? { ...a, originKey: original.originKey || origin.id, category: original.category, libraryKind: original.libraryKind } : a));
}
function modal(title, body, wide = false) {
  if (title !== '视频提示词 · 指令编辑' && document.querySelector('#modal')?.classList.contains('vc-expanded-modal')) state.returnExpanded = true;
  document.querySelector('#modal').classList.remove('vc-expanded-modal', 'vc-lightbox-modal', 'vc-asset-modal', 'vc-tool-modal');
  context.openModal(title, '', body.replace(/<button(?![^>]*\btype=)/g, '<button type="button"'), wide);
  document.querySelector('#modal').classList.add('vc-dialog');
}
function closePopover() {
  document.querySelector('.vc-popover')?.remove();
  document.querySelectorAll('[data-popover-open]').forEach(el => { delete el.dataset.popoverOpen; el.setAttribute('aria-expanded', 'false'); });
  if (state) { state.popover = null; if (state.refreshQueued) { state.refreshQueued = false; queueMicrotask(() => refresh()); } }
}
function openPopover(kind, anchor, content, width = 380) {
  if (state.popover === kind) { closePopover(); return; }
  closePopover(); state.popover = kind;
  const node = document.createElement('div'); node.className = 'vc-popover vc-popover-' + kind; node.setAttribute('role', 'dialog'); node.setAttribute('aria-label', ({ skills: '选择视频技能', director: '编导设置', models: '选择视频模型', generation: '视频生成设置', references: '引用素材' })[kind]); node.innerHTML = content;
  node.style.width = Math.min(width, innerWidth - 24) + 'px'; (document.querySelector('#modal[open]') || document.body).append(node);
  const rect = anchor.getBoundingClientRect(), height = node.getBoundingClientRect().height;
  node.style.left = Math.max(12, Math.min(rect.left, innerWidth - node.offsetWidth - 12)) + 'px';
  node.style.top = (rect.bottom + height + 16 < innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - height - 8)) + 'px';
  anchor.dataset.popoverOpen = kind; anchor.setAttribute('aria-expanded', 'true'); node.querySelector('input[type="search"]')?.focus();
  node.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...node.querySelectorAll('button:not(:disabled),input,select,[tabindex="0"]')];
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  });
}
function skillCards(query = '') {
  const { esc, button } = context;
  const skills = VIDEO_SKILLS.filter(s => (s.name + s.description).includes(query.trim()));
  return skills.map(s => button('vc-skill', `<img src="${SKILL_ART[s.id]}" alt=""><span><strong>${esc(s.name)}</strong><small>${esc(s.description)}</small></span>${state.skill === s.id ? uiIcon('check') : ''}`, `vc-skill-card ${state.skill === s.id ? 'selected' : ''}`, `data-value="${s.id}"`)).join('') || '<p class="vc-muted">没有找到相关场景</p>';
}
function skillPicker(anchor) {
  openPopover('skills', anchor, `<header><div><strong>你想创作什么？</strong><small>让每一个想法，都能成为影像</small></div>${context.button('vc-close-popover', uiIcon('close'), 'vc-icon', 'aria-label="关闭技能选择"')}</header><div class="vc-skill-tabs"><button class="selected" type="button">同城到店</button></div><div class="vc-search">${context.icon('search')}<input id="vc-skill-search" type="search" placeholder="搜一搜" aria-label="搜索视频技能"></div><div id="vc-skill-grid" class="vc-skill-grid">${skillCards()}</div>`, 490);
  const input = document.querySelector('#vc-skill-search'); if (input) input.oninput = () => { document.querySelector('#vc-skill-grid').innerHTML = skillCards(input.value); };
}
function navigation(ctx) {
  return `<aside class="vc-skill-sidebar ${state.sidebar ? '' : 'is-collapsed'}" aria-label="AI视频技能导航"><header><strong>AI 视频</strong>${ctx.button('vc-sidebar', uiIcon(state.sidebar ? 'fold' : 'unfold'), 'vc-icon', `aria-label="${state.sidebar ? '收起' : '展开'}技能导航" aria-expanded="${state.sidebar}"`)}</header><div class="vc-sidebar-content"><p>同城到店</p>${VIDEO_SKILLS.map(s => ctx.button('vc-skill', `<img src="${SKILL_ART[s.id]}" alt=""><span><strong>${s.name}</strong><small>${ctx.esc(s.description)}</small></span>`, `vc-sidebar-skill ${state.skill === s.id ? 'selected' : ''}`, `data-value="${s.id}" ${locked() ? 'disabled' : ''}`)).join('')}</div></aside>`;
}
function composerMedia(ctx, assets, disabled) {
  const groups = `<div class="vc-reference-groups" aria-label="创作参考素材">${[['reference', '添加图片', 'image'], ['character', '添加角色', 'person'], ['voice', '添加声音', 'voice']].map(([purpose, label, symbol]) => {
    const selected = assets.filter(a => videoAssetPurpose(a) === purpose), images = selected.filter(a => a.type === 'image');
    return ctx.button('vc-reference-group', `<span class="vc-reference-tile ${selected.length > 1 ? 'is-stacked' : ''}">${images[0] ? `<img src="${ctx.esc(mediaUrl(images[0].url))}" alt="${ctx.esc(images[0].name)}">` : symbol === 'image' ? ctx.icon('image') : composerIcon(symbol)}${selected.length ? `<span class="vc-reference-count">${selected.length}</span>` : ''}<span class="vc-reference-plus">+</span></span><span class="vc-reference-label">${label}${purpose !== 'reference' ? '<small>（可选）</small>' : ''}</span>`, 'vc-reference-group', `data-purpose="${purpose}" aria-label="${label}" ${disabled ? 'disabled' : ''}`);
  }).join('')}</div>`;
  const tiles = assets.map(asset => {
    const index = asset.type === 'image' ? assets.filter(a => a.type === 'image').indexOf(asset) + 1 : assets.filter(a => a.type === 'audio').indexOf(asset) + 1;
    return `<div class="vc-inline-material"><button type="button" class="vc-inline-preview" data-action="vc-preview-asset" data-id="${ctx.esc(asset.id)}" aria-label="${asset.type === 'image' ? '预览' : '试听'} ${ctx.esc(asset.name)}">${asset.type === 'image' ? `<img src="${ctx.esc(mediaUrl(asset.url))}" alt="${ctx.esc(asset.name)}">` : composerIcon('voice')}<span>${asset.type === 'image' ? '图片' : '声音'}${index}</span></button><div class="vc-inline-actions">${ctx.button('vc-inline-replace', uiIcon('edit'), 'vc-icon', `data-id="${ctx.esc(asset.id)}" aria-label="替换 ${ctx.esc(asset.name)}" ${disabled ? 'disabled' : ''}`)}${ctx.button('vc-inline-remove', uiIcon('close'), 'vc-icon', `data-id="${ctx.esc(asset.id)}" aria-label="移除 ${ctx.esc(asset.name)}" ${disabled ? 'disabled' : ''}`)}</div><div class="vc-inline-hover" aria-hidden="true">${asset.type === 'image' ? `<img src="${ctx.esc(mediaUrl(asset.url))}" alt="">` : ''}<small>${ctx.esc(asset.name)}</small></div></div>`;
  }).join('');
  return `<div class="vc-material-composer">${groups}${assets.length ? `${ctx.button('vc-toggle-materials', state.expandedMaterials ? '收起素材' : '展开素材', 'vc-material-toggle', `aria-expanded="${state.expandedMaterials}"`)}<div class="vc-inline-materials" ${state.expandedMaterials ? '' : 'hidden'}>${tiles}</div>` : ''}</div>`;
}
function filteredLibrary() {
  const picker = state.picker; if (!picker) return [];
  return assetLibrary().filter(a => {
    if (picker.purpose === 'voice' ? a.type !== 'audio' : a.type !== 'image') return false;
    if (picker.tab !== 'assets' && videoAssetPurpose(a) !== 'character') return false;
    if (picker.tab === 'faces' && a.libraryKind !== 'faces' || picker.tab === 'roles' && a.libraryKind === 'faces') return false;
    if (picker.tab !== 'assets' && picker.category && !['all','mine'].includes(picker.category) && a.category !== picker.category) return false;
    if (picker.filetype && picker.filetype !== 'all' && !a.name.toLowerCase().endsWith('.' + picker.filetype)) return false;
    if (picker.folderId !== undefined && picker.folderId !== 'all' && (a.folderId || '') !== picker.folderId) return false;
    if (picker.query && !a.name.toLowerCase().includes(picker.query.toLowerCase())) return false;
    if (picker.source !== 'all' && a.source !== picker.source) return false;
    return true;
  });
}
function assetStatus(a) {
  if (a.expired || a.expiresAt && a.expiresAt <= Date.now()) return '已过期';
  const review=({approved:'审核通过',rejected:'审核未通过',pending:'待审核',not_submitted:'尚未提交审核'})[a.review?.status] || '尚未提交审核';
  return `${a.width && a.height ? `${a.width} × ${a.height} · ` : ''}${a.source==='generated'?'已生成':'已上传'} · ${review}`;
}
function folderOptions(selected, includeAll = true) {
  const folders=uiRead('folders',[]), esc=context.esc;
  const path=(f,seen=new Set())=>{ if(!f || seen.has(f.id)) return ''; seen.add(f.id); return (f.parentId ? path(folders.find(x=>x.id===f.parentId),seen)+' / ' : '')+f.name; };
  return [...(includeAll?[['all','全部素材']]:[]),['','根目录'],...folders.map(f=>[f.id,path(f)])].map(([id,name])=>`<option value="${esc(id)}" ${id===selected?'selected':''}>${esc(name)}</option>`).join('');
}
function renderFolders() { const node=document.querySelector('#vc-folder-select'); if(node) node.innerHTML=folderOptions(state.picker?.folderId || ''); }
function folderAction(action,el) {
  const picker=state.picker;if(!picker)return;
  const folders=uiRead('folders',[]), folder=folders.find(f=>f.id===picker.folderId);
  const reopen=()=>{referencePicker(picker.purpose,context,picker.replaceId);state.picker.folderId=picker.folderId;renderLibraryGrid();};
  if(action==='vc-folder-delete') {
    if(!folder){context.toast('请先选择文件夹。');return;}
    if(folders.some(f=>f.parentId===folder.id) || uiRead('asset-meta',[]).some(a=>a.folderId===folder.id)){context.toast('请先移出素材和子文件夹。');return;}
    uiWrite('folders',folders.filter(f=>f.id!==folder.id));picker.folderId='';renderLibraryGrid();return;
  }
  if(action==='vc-folder-move') {
    modal('移动素材',`<form id="vc-folder-form"><label>选择目录<select name="folder" aria-label="选择目录">${folderOptions('',false)}</select></label><footer class="modal-actions"><button type="submit" class="primary">移动</button></footer></form>`);
    document.querySelector('#vc-folder-form').onsubmit=e=>{e.preventDefault();const value=e.target.elements.folder.value;const entries=uiRead('asset-meta',[]);uiWrite('asset-meta',[...entries.filter(a=>a.id!==el.dataset.id),{id:el.dataset.id,folderId:value||null}]);reopen();};return;
  }
  if(action==='vc-folder-rename'&&!folder){context.toast('请先选择文件夹。');return;}
  modal(action==='vc-folder-new'?'新建文件夹':'重命名文件夹',`<form id="vc-folder-form"><label>名称<input name="name" required maxlength="60" value="${context.esc(action==='vc-folder-rename'?folder.name:'')}"></label><footer class="modal-actions"><button type="submit" class="primary">保存</button></footer></form>`);
  document.querySelector('#vc-folder-form').onsubmit=e=>{e.preventDefault();const name=e.target.elements.name.value.trim();if(!name)return;
    const value=action==='vc-folder-new'?{id:crypto.randomUUID(),name,parentId:folder?.id||null}:{...folder,name};
    if(folders.some(f=>f.id!==value.id&&f.parentId===value.parentId&&f.name===name)){context.toast('此目录已有同名文件夹。');return;}
    uiWrite('folders',[...folders.filter(f=>f.id!==value.id),value]);reopen();};
}
function phaseSummary(task,esc) {
  const phases=task.timeline||[];if(!phases.length)return '';
  const seconds=ms=>`${Math.round(ms/1000)}秒`;
  return `<details class="vc-phase-summary"><summary>处理耗时</summary>${task.timelineCoverage==='partial'?'<p>仅记录本次服务恢复后的耗时</p>':''}<ol>${phases.map(p=>`<li>${esc(labels[p.phase]||p.phase)}：${seconds(p.elapsedMs)}${p.endedAt?'':'（进行中）'}</li>`).join('')}${task.settlement?`<li>积分结算：${seconds((task.settlement.completedAt||Date.now())-task.settlement.startedAt)}</li>`:''}</ol>${task.events?.length?`<p>恢复与异常记录 ${task.events.length} 条</p><ul>${task.events.map(e=>`<li>${esc(new Date(e.at).toLocaleTimeString())} · ${esc(({query_retry:'查询中断，自动重连',download_retry:'保存重试',server_resumed:'服务恢复',reconnected:'已恢复连接',failed:'任务未完成',material:'素材处理异常'})[e.action]||e.action)}${e.code?' · '+esc(e.code):''}</li>`).join('')}</ul>`:''}</details>`;
}
function renderLibraryGrid() {
  const { esc, button, icon } = context, picker = state.picker, assets = filteredLibrary(), max = picker.replaceId || picker.purpose === 'voice' ? 1 : picker.purpose === 'character' ? 10 : 30;
  const grid = document.querySelector('#vc-library-grid'); if (!grid) return;
  grid.innerHTML = `<button type="button" data-action="vc-library-upload" class="vc-library-upload">${icon('plus')}<span>上传文件</span><small>${picker.purpose === 'voice' ? 'MP3、WAV · 最大15MB' : 'JPG、PNG、WebP · 单张小于50MB'}</small></button>${assets.slice(0, picker.limit).map(a => `<article class="vc-library-item ${picker.ids.has(a.id) ? 'selected' : ''}"><button type="button" data-action="vc-library-toggle" data-id="${esc(a.id)}" aria-pressed="${picker.ids.has(a.id)}" ${a.expired ? 'disabled' : ''} aria-label="选择 ${esc(a.name)}"><span class="vc-library-image">${a.type === 'image' ? `<img src="${esc(mediaUrl(a.url))}" alt="" loading="lazy">` : composerIcon('voice')}<span class="vc-library-check">${picker.ids.has(a.id) ? uiIcon('check') : ''}</span></span><strong title="${esc(a.name)}">${esc(a.name)}</strong><small>${esc(assetStatus(a))}</small></button><div class="vc-library-item-actions">${button('vc-preview-asset', a.type === 'audio' ? '试听' : '预览', 'textbutton', `data-id="${esc(a.id)}" ${a.expired ? 'disabled' : ''}`)}${button('vc-folder-move','移动','textbutton',`data-id="${esc(a.id)}"`)}</div></article>`).join('')}${!assets.length ? '<p class="vc-library-empty">上传素材后，在这里选择使用</p>' : ''}`;
  document.querySelector('#vc-library-confirm').disabled = Boolean(picker.replaceId && picker.ids.size !== 1);
  document.querySelector('#vc-library-count').textContent = `已选 ${picker.ids.size}/${max}`;
  document.querySelector('#vc-library-confirm').textContent = `确认选择（${picker.ids.size}/${max}）`;
  const more = document.querySelector('#vc-library-more'); if (more) more.hidden = assets.length <= picker.limit;
  const all = document.querySelector('#vc-library-all'); if (all) { all.checked = assets.length > 0 && assets.every(a => picker.ids.has(a.id)); all.indeterminate = !all.checked && assets.some(a => picker.ids.has(a.id)); }
  renderRoleCategories(); renderFolders();
  const account = state.owner;
  grid.querySelectorAll('.vc-library-image img').forEach(image => {
    const show = () => {
      if (state.owner !== account || !image.naturalWidth) return;
      const card = image.closest('.vc-library-item'), id = card.querySelector('[data-action="vc-library-toggle"]').dataset.id;
      const info = card.querySelector('small'); if (info) info.textContent = assetStatus({...assetLibrary().find(a=>a.id===id),width:image.naturalWidth,height:image.naturalHeight});
    };
    image.onload = show; if (image.complete) show();
  });
}
const ROLE_CATEGORIES = ['都市蓝领','新锐白领','小镇青年','Z世代','都市银发','资深中产','小镇中老年','精致妈妈'];
function renderRoleCategories() {
  let node = document.querySelector('#vc-role-categories');
  if (!node && document.querySelector('#vc-library-grid')) { node = document.createElement('div'); node.id = 'vc-role-categories'; node.className = 'vc-role-categories'; document.querySelector('#vc-library-grid').before(node); }
  if (!node) return;
  node.hidden = state.picker?.tab === 'assets';
  node.innerHTML = [['all','全部'],['mine','我的角色'],...ROLE_CATEGORIES.map(c=>[c,c])].map(([value,label])=>context.button('vc-role-category',label,(state.picker?.category||'all')===value?'selected':'',`data-value="${value}"`)).join('');
}
function createCharacter() {
  const kind = state.picker?.tab === 'faces' ? 'faces' : 'roles';
  modal(kind === 'faces' ? '添加人脸' : '创建角色', `<form id="vc-character-form"><label class="vc-form-label">角色名称<input name="title" required maxlength="50" placeholder="给角色起个名字"></label><label class="vc-form-label">角色分类<select name="category"><option value="">不分类</option>${ROLE_CATEGORIES.map(c=>`<option>${c}</option>`).join('')}</select></label><label class="vc-character-upload">${uiIcon('plus')}<span>选择参考图片</span><small>JPG、PNG、WebP，单张小于50MB</small><input id="vc-character-file" type="file" accept="image/jpeg,image/png,image/webp" required></label><p id="vc-character-file-name" class="vc-tool-notice"></p><footer class="modal-actions">${context.button('vc-close-dialog','取消','secondary')}<button type="submit" class="primary">创建</button></footer></form>`);
  const form = document.querySelector('#vc-character-form');
  document.querySelector('#vc-character-file').onchange = e => { const file = e.target.files[0]; if (!file) return; document.querySelector('#vc-character-file-name').textContent = file.name; if (!form.elements.title.value) form.elements.title.value = file.name.replace(/\.[^.]+$/, ''); };
  form.onsubmit = async e => {
    e.preventDefault(); const file = document.querySelector('#vc-character-file').files[0]; if (!file) return;
    const name = form.elements.title.value.trim(); if (!name) return;
    const category = form.elements.category.value, account = state.owner;
    if (file.size >= VIDEO_IMAGE_MAX_BYTES) { context.toast('单张图片需小于50MB。'); return; }
    const copy = new File([file], name + (/\.[a-z0-9]+$/i.exec(file.name)?.[0] || '.jpg'), { type: file.type });
    document.querySelector('#modal').close(); await upload([copy], 'character'); if (state.owner !== account) return;
    const added = state.session?.assets.findLast(a=>a.name===copy.name && videoAssetPurpose(a)==='character');
    if (added) uiWrite('assets',uiRead('assets',[]).map(a=>a.id===added.id?{...a,category,libraryKind:kind}:a));
  };
}
function referencePicker(purpose, ctx, replaceId = null) {
  state.replaceUploadId = null;
  if (locked()) return;
  state.picker = { purpose, replaceId, tab: purpose === 'character' ? 'roles' : 'assets', query: '', source: 'all', folderId:'all', limit: 24, ids: new Set(replaceId ? [] : referenceAssets().filter(a => videoAssetPurpose(a) === purpose).map(a => a.id)) };
  modal(replaceId ? '替换素材' : purpose === 'voice' ? '选择声音' : '选择素材', `<div class="vc-library-tabs">${[['assets', '我的资产'], ['roles', '角色库'], ['faces', '人脸库']].filter(([key]) => purpose !== 'voice' || key === 'assets').map(([key, label]) => ctx.button('vc-library-tab', label, state.picker.tab === key ? 'selected' : '', `data-value="${key}"`)).join('')}<span id="vc-library-count"></span></div><div class="vc-library-toolbar"><select id="vc-folder-select" aria-label="素材文件夹"></select>${ctx.button('vc-folder-new','新建文件夹','textbutton')}${ctx.button('vc-folder-rename','重命名','textbutton')}${ctx.button('vc-folder-delete','删除空文件夹','textbutton')}<div class="vc-search">${ctx.icon('search')}<input id="vc-library-search" type="search" placeholder="搜索文件名称" aria-label="搜索素材"></div><select id="vc-library-type" aria-label="文件类型"><option value="all">全部类型</option>${(purpose === 'voice' ? ['mp3','wav'] : ['jpg','jpeg','png','webp']).map(type=>`<option value="${type}">${type.toUpperCase()}</option>`).join('')}</select>${purpose === 'voice' ? ctx.button('vc-record', composerIcon('mic') + '录音', 'vc-outline', typeof MediaRecorder === 'undefined' ? 'disabled title="当前浏览器不支持录音"' : '') : ctx.button('vc-create-character', uiIcon('plus') + '创建角色', 'vc-outline')}</div><div class="vc-library-sources">${[['all', '全部'], ['uploaded', '我上传的'], ['generated', 'AI生成的']].map(([id, label]) => ctx.button('vc-library-source', label, id === 'all' ? 'selected' : '', `data-value="${id}"`)).join('')}</div><div id="vc-library-grid" class="vc-library-grid"></div><button type="button" class="vc-library-more" id="vc-library-more" data-action="vc-library-more">加载更多</button><footer class="modal-actions"><label class="vc-select-all"><input id="vc-library-all" type="checkbox">全选</label>${ctx.button('vc-cancel-library', '取消', 'secondary')}${ctx.button('vc-confirm-library', '确认选择', 'primary', 'id="vc-library-confirm"')}</footer>`, true);
  document.querySelector('#modal').classList.add('vc-asset-modal');
  renderFolders();
  document.querySelector('#vc-folder-select').onchange=e=>{state.picker.folderId=e.target.value;renderLibraryGrid();};
  document.querySelector('#vc-library-type').onchange = e => { state.picker.filetype = e.target.value; renderLibraryGrid(); };
  document.querySelector('#vc-library-search').oninput = e => { state.picker.query = e.target.value; renderLibraryGrid(); };
  document.querySelector('#vc-library-all').onchange = e => {
    const max = replaceId || purpose === 'voice' ? 1 : purpose === 'character' ? 10 : 30;
    state.picker.ids = new Set(e.target.checked ? filteredLibrary().filter(a=>!a.expired).slice(0, max).map(a => a.id) : []); renderLibraryGrid();
  };
  renderLibraryGrid();
  if (purpose !== 'voice') void loadGeneratedLibrary();
}
async function loadGeneratedLibrary() {
  const account = state.owner;
  const results = await Promise.allSettled(['/api/ai/images?completed=true', '/api/restaurant/tasks?limit=50&completed=true'].map(async path => {
    const response = await fetch(path, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return []; return (await response.json()).tasks || [];
  }));
  if (state.owner !== account || !context || document.body.dataset.page !== 'video') return;
  const records = collectGeneratedAssets(results[0].status === 'fulfilled' ? results[0].value : [], [], Date.now(), results[1].status === 'fulfilled' ? results[1].value : []);
  const generated = records.filter(r => r.type === 'image').map(r => ({ id: r.key, name: r.title + ' · ' + r.filename, type: 'image', purpose: 'reference', source: 'generated', url: r.url, createdAt: r.completed, expiresAt: r.expires }));
  const previous = uiRead('assets', []);
  uiWrite('assets', [...generated, ...previous.filter(a => !generated.some(g => g.id === a.id))].filter(a => !a.expiresAt || a.expiresAt > Date.now()).slice(0, 180));
  if (state.picker && document.querySelector('#vc-library-grid')) renderLibraryGrid();
}
async function fileForAsset(asset) {
  if (asset.file instanceof Blob) return asset.file;
  const url = mediaUrl(asset.url); if (!url) throw new Error('这份素材已过期，请重新上传。');
  const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('素材读取失败，请重新上传。');
  return new File([await response.blob()], asset.name, { type: asset.type === 'audio' ? 'audio/wav' : 'image/jpeg' });
}
async function replaceMaterialSet(next, replacements = {}) {
  const account = state.owner, before = state.session?.assets || [], oldRefs = referenceAssets(), previous = { session: state.session, input: state.input, prompt: state.prompt, stage: state.stage, selectedTask: state.selectedTask, scriptId: state.scriptId, referenceImageIds: state.referenceImageIds };
  if (next.filter(a => a.type === 'image').length > 30) throw new Error('图片与角色参考合计最多30张。');
  if (next.filter(a => a.type === 'audio').length > 1) throw new Error('最多选择一段声音参考。');
  if (next.filter(a => videoAssetPurpose(a) === 'character').length > 10) throw new Error('最多添加10张角色参考图。');
  const files = await Promise.all(next.map(async a => ({ file: await fileForAsset(a), purpose: videoAssetPurpose(a), origin: a })));
  if (state.owner !== account) return;
  // Build the replacement separately. A failed upload leaves the previous draft intact.
  const data = await request('/conversations', post({ requestId: crypto.randomUUID(), skill: state.skill, settings: state.settings }));
  let session = data.conversation; const ids = {};
  for (const [index, item] of files.entries()) {
    if (state.owner !== account) return;
    state.uploadLabel = `准备素材 ${index + 1}/${files.length}`; refresh();
    const { file, purpose, origin } = item;
    const uploaded = await request(`/conversations/${session.id}/assets/${crypto.randomUUID()}`, { method: 'PUT', headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), 'X-Asset-Purpose': purpose }, body: file });
    session = uploaded.conversation; ids[origin.id] = session.assets.at(-1).id;
  }
  if (state.owner !== account) return;
  persistDraft();
  if (previous.session && !previous.session.operations.length && !previous.session.tasks.length) uiWrite('hidden-drafts', [...new Set([...uiRead('hidden-drafts', []), previous.session.id])]);
  state.session = null; saveSession(session);
  const selected = next.map(a => ({ ...a, id: ids[a.id] }));
  const mapping = { ...ids }; for (const [old, replacement] of Object.entries(replacements)) mapping[old] = ids[replacement];
  state.input = remapMaterialReferences(previous.input, before, selected, mapping);
  state.prompt = remapMaterialReferences(previous.prompt, oldRefs, selected, mapping);
  state.referenceImageIds = selected.filter(a => a.type === 'image').map(a => a.id);
  state.selectedTask = null; state.scriptId = null; state.pendingScriptRequest = null; state.generationRequest = null; state.stage = previous.stage; state.expandedMaterials = true;
  for (const item of files) rememberOrigin(session.assets.find(a => a.id === ids[item.origin.id]), item.origin);
  persistDraft(true); state.quote = null; void quote();
}
async function applyLibrarySelection(picker = state.picker) {
  if (!picker) return;
  const before = referenceAssets(), library = assetLibrary();
  if (picker.replaceId) {
    const replacement = library.find(a => a.id === [...picker.ids][0]); if (!replacement) return;
    if (before.some(a => a.id === replacement.id && a.id !== picker.replaceId)) throw new Error('这份素材已在当前创作中，请选择另一份。');
    const next = before.map(a => a.id === picker.replaceId ? { ...replacement, purpose: videoAssetPurpose(a) } : a);
    return replaceMaterialSet(next, { [picker.replaceId]: replacement.id });
  }
  const group = [...picker.ids].map(id => library.find(a => a.id === id)).filter(Boolean).map(a => ({ ...a, purpose: picker.purpose }));
  const next = before.filter(a => videoAssetPurpose(a) !== picker.purpose || picker.ids.has(a.id));
  next.push(...group.filter(a => !next.some(n => n.id === a.id)));
  if (before.length === next.length && before.every((a, i) => a.id === next[i].id)) return;
  return replaceMaterialSet(next);
}
function previewAsset(id) {
  const asset = assetLibrary().find(a => a.id === id); if (!asset) return;
  state.libraryReturn = document.querySelector('#modal')?.classList.contains('vc-asset-modal') ? state.picker : null;
  state.previewAsset = asset; state.zoom = 1;
  modal(asset.name, `<div class="vc-lightbox-media">${asset.type === 'image' ? `<img id="vc-lightbox-image" src="${context.esc(mediaUrl(asset.url))}" alt="${context.esc(asset.name)}">` : `<audio controls src="${context.esc(mediaUrl(asset.url))}" aria-label="声音参考试听"></audio>`}</div><footer class="vc-lightbox-controls">${asset.type === 'image' ? context.button('vc-zoom', '−', 'vc-icon', 'data-value="-0.25" aria-label="缩小图片"') + '<span id="vc-zoom-label">100%</span>' + context.button('vc-zoom', '+', 'vc-icon', 'data-value="0.25" aria-label="放大图片"') : ''}<a href="${context.esc(mediaUrl(asset.url))}" download="${context.esc(asset.name)}" class="vc-icon" aria-label="下载素材">${uiIcon('download')}</a>${context.button('vc-lightbox-done', '关闭预览', 'vc-outline')}</footer>`, true);
  document.querySelector('#modal').classList.add('vc-lightbox-modal');
}
function durationControl() {
  const s = state.settings, model = VIDEO_MODELS.find(m => m.id === s.model), durations = model.durations;
  return `<div class="vc-setting-title"><span>视频时长</span><strong id="vc-duration-value">${s.duration}s</strong></div><input id="vc-duration-range" type="range" min="0" max="${durations.length - 1}" step="1" value="${Math.max(0, durations.indexOf(s.duration))}" aria-label="视频时长"><div class="vc-range-labels"><span>${durations[0]}s</span><span>${durations.at(-1)}s</span></div>`;
}
function settings(ctx, kind = 'generation', anchor) {
  const s = state.settings, { button, esc } = ctx;
  const body = kind === 'director' ? `<div class="vc-setting-group"><h3>脚本语言</h3><div class="vc-choice-grid">${VIDEO_LANGUAGES.map(l => button('vc-setting-choice', esc(l.name), s.language === l.id ? 'selected' : '', `data-field="language" data-value="${l.id}" aria-pressed="${s.language === l.id}"`)).join('')}</div></div>${durationControl()}` : kind === 'models' ? `<h3>生成模型</h3><div class="vc-model-options">${VIDEO_MODELS.map((m, i) => button('vc-setting-choice', `<span class="vc-model-symbol">${uiIcon('sparkle')}</span><span><strong>${m.name}${i === 2 ? '<small>推荐</small>' : ''}</strong><small>${['快速创作，适合日常宣传', '细节与表现力兼顾', '丰富分镜，适合完整门店故事'][i]}</small></span>${s.model === m.id ? uiIcon('check') : ''}`, s.model === m.id ? 'selected' : '', `data-field="model" data-value="${m.id}" aria-pressed="${s.model === m.id}"`)).join('')}</div>` : `<div class="vc-setting-group"><h3>画面比例</h3><div class="vc-ratio-options">${['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].map(r => { const [w, h] = r.split(':').map(Number); return button('vc-setting-choice', `<i style="width:${Math.round(24 * w / Math.max(w, h))}px;height:${Math.round(24 * h / Math.max(w, h))}px"></i><span>${r}</span>`, s.ratio === r ? 'selected' : '', `data-field="ratio" data-value="${r}" aria-pressed="${s.ratio === r}"`); }).join('')}</div></div><div class="vc-setting-columns"><div class="vc-setting-group"><h3>分辨率</h3><div class="vc-choice-grid"><button type="button" class="selected" aria-pressed="true">720p</button></div></div><div class="vc-setting-group"><h3>音频</h3><div class="vc-choice-grid">${[['true', '含音频'], ['false', '静音']].map(([v, label]) => button('vc-setting-choice', label, String(s.generateAudio) === v ? 'selected' : '', `data-field="generateAudio" data-value="${v}" aria-pressed="${String(s.generateAudio) === v}"`)).join('')}</div></div></div>${durationControl()}`;
  openPopover(kind, anchor, body, kind === 'models' ? 330 : 390);
  const range = document.querySelector('#vc-duration-range');
  if (range) { range.oninput = () => { document.querySelector('#vc-duration-value').textContent = VIDEO_MODELS.find(m => m.id === state.settings.model).durations[Number(range.value)] + 's'; }; range.onchange = () => applySettings({ ...state.settings, duration: VIDEO_MODELS.find(m => m.id === state.settings.model).durations[Number(range.value)] }); }
}
function applySettings(next) {
  const model = VIDEO_MODELS.find(m => m.id === next.model); if (!model) return;
  if (!model.durations.includes(next.duration)) next.duration = model.durations.at(-1);
  const changed = Object.keys(DEFAULT_VIDEO_SETTINGS).some(key => state.settings[key] !== next[key]);
  if (!changed) return;
  const scripted = Boolean(state.scriptId); state.settings = editableSettings(next); state.quote = null; state.quoteError = ''; closePopover();
  if (scripted) {
    state.stage = 'director'; state.scriptId = null; state.referenceImageIds = null; state.prompt = '';
    state.input = `按当前${next.duration}秒、${VIDEO_LANGUAGES.find(l => l.id === next.language)?.name}、${next.generateAudio ? '含音频' : '静音'}设置调整上一版脚本，保留其他创作方向与事实。`;
    context.toast('设置已更改，请让编导调整脚本。');
  }
  refresh(); void quote();
}
function savePromptDialog(id) {
  const existing = id && savedPrompts().find(p => p.id === id), prompt = existing?.prompt ?? state.prompt;
  if (!prompt.trim()) { context.toast('先填写或应用一份脚本。'); return; }
  const { esc } = context;
  modal(existing ? '编辑提示词' : '保存提示词', `<form id="vc-save-form"><label class="vc-form-label">提示词名称<input name="title" required maxlength="60" placeholder="给提示词起个名字" value="${esc(existing?.title || '')}"></label><label class="vc-checkbox"><input type="checkbox" name="references" ${existing?.references?.length ? 'checked' : ''}>同时保存参考素材</label><div class="vc-save-references">${(existing?.references || referenceAssets()).map((a, i) => `<span>${a.type === 'image' ? `<img src="${esc(mediaUrl(a.url))}" alt="">@图片${i + 1}` : uiIcon('sound') + '@声音1'}</span>`).join('')}</div><label class="vc-form-label">提示词内容<textarea name="prompt" required maxlength="12000">${esc(prompt)}</textarea></label><footer class="modal-actions">${context.button('vc-close-dialog', '取消', 'secondary')}<button type="submit" class="primary">保存</button></footer></form>`);
  document.querySelector('#vc-save-form').onsubmit = e => {
    e.preventDefault(); const data = new FormData(e.target), saved = { id: existing?.id || crypto.randomUUID(), title: String(data.get('title')).trim(), prompt: String(data.get('prompt')).trim(), settings: { ...(existing?.settings || state.settings) }, createdAt: existing?.createdAt || Date.now(), references: data.has('references') ? (existing?.references || referenceAssets()).map(({ id, name, type, purpose, url, expiresAt, file }) => ({ id, name, type, purpose, url: mediaUrl(url), expiresAt })) : [] };
    if (!saved.title || !saved.prompt) return;
    try { uiWrite('prompts', [saved, ...savedPrompts().filter(p => p.id !== saved.id)].slice(0, 40)); document.querySelector('#modal').close(); context.toast('提示词已保存。'); } catch { context.toast('保存失败，请复制提示词保留。'); }
  };
}
function promptLibrary() {
  const { esc, button } = context;
  modal('我的提示词', `<div class="vc-prompt-library">${savedPrompts().map(p => `<article><header><strong>${esc(p.title || '未命名提示词')}</strong><span>AI 视频</span></header><small>${p.createdAt ? new Date(p.createdAt).toLocaleDateString(uiLocale()) : ''} · ${p.references?.length ? p.references.length + '份参考素材' : '无参考素材'}</small><p>${esc(p.prompt.slice(0, 220))}</p><footer>${button('vc-edit-prompt', uiIcon('edit'), 'vc-icon', `data-id="${p.id}" aria-label="编辑提示词 ${esc(p.title || '')}"`)}${button('vc-delete-prompt', uiIcon('trash'), 'vc-icon', `data-id="${p.id}" aria-label="删除提示词 ${esc(p.title || '')}"`)}${button('vc-use-prompt', '使用提示词', 'vc-outline', `data-id="${p.id}"`)}</footer></article>`).join('') || '<div class="vc-blank"><span>还没有保存的提示词</span></div>'}</div>`, true);
}
function expandEditor() {
  state.returnExpanded = false;
  modal('视频提示词 · 指令编辑', `<div class="vc-expanded-content"><div class="vc-expanded-toolbar"><span>${referenceAssets().length}/31</span><span>${context.button('vc-save-prompt', context.icon('save'), 'vc-icon', `aria-label="保存当前提示词" ${state.prompt.trim() ? '' : 'disabled'}`)}${context.button('vc-saved-prompts', context.icon('list'), 'vc-icon', 'aria-label="我的提示词"')}${context.button('vc-collapse-editor', uiIcon('expand'), 'vc-icon', 'aria-label="收起"')}</span></div>${composerMedia(context, referenceAssets(), locked())}<div id="vc-expanded-prompt" class="vc-rich-editor" role="textbox" aria-label="完整视频提示词" aria-multiline="true" contenteditable="${!locked()}" data-placeholder="描述画面、镜头、氛围和声音…">${promptMarkup(state.prompt, referenceAssets())}</div>${missingReferenceNotice()}<footer><span id="vc-expanded-count">${state.prompt.length}/12000</span><span>${context.button('vc-reference-menu', '@', 'vc-icon', 'aria-label="引用素材"')}${context.button('vc-direct-voice', composerIcon('mic'), 'vc-voice', `aria-label="${voiceSession ? '停止语音输入' : '语音输入视频提示词'}" ${!voiceSession && (!speechEngine() || locked()) ? 'disabled' : ''}`)}</span></footer></div>`, true);
  document.querySelector('#modal').classList.add('vc-expanded-modal'); bindRichEditor(document.querySelector('#vc-expanded-prompt'));
}
function bindRichEditor(root) {
  if (!root) return;
  const field = editorField(root), limit = field === 'input' ? 8000 : 12000;
  root.addEventListener('input', event => {
    if (voiceSession) return;
    const value = typeof event?.target?.value === 'string' ? event.target.value : readPromptEditor(root);
    if (value.length > limit) { root.innerHTML = promptMarkup(state[field], editorAssets(root)); context.toast(`最多${limit}字。`); return; }
    state[field] = value; if (field === 'prompt') state.scriptId = null;
    persistDraft(true); updateDirectorControls();
    document.querySelectorAll('[data-action="vc-save-prompt"]').forEach(el => { el.disabled = !state.prompt.trim(); });
    document.querySelectorAll('#vc-prompt-count,#vc-expanded-count').forEach(el => { el.textContent = state.prompt.length + '/12000'; });
    const generate = document.querySelector('[data-action="vc-generate"]'); if (generate) generate.disabled = !canGenerate();
  });
  root.addEventListener('paste', e => { e.preventDefault(); insertEditorText(root, e.clipboardData.getData('text/plain').slice(0, limit)); });
  root.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (state.popover === 'references' && e.key === 'ArrowDown') { e.preventDefault(); document.querySelector('.vc-popover-references button')?.focus(); return; }
    if (e.key === '@' && editorAssets(root).length) setTimeout(() => { if (root.isConnected) referenceMenu(root); }, 0);
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); document.querySelector(`[data-action="${field === 'input' ? 'vc-send' : 'vc-generate'}"]`)?.click(); }
  });
}
function referenceMenu(root) {
  if (!root) return; state.editorTarget = root.id;
  const selection = window.getSelection(); state.editorRange = selection?.rangeCount && root.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : state.referenceCaret?.target === root.id && root.contains(state.referenceCaret.range.commonAncestorContainer) ? state.referenceCaret.range : null;
  state.referenceCaret = null;
  openPopover('references', root, `<h3>引用素材</h3><div class="vc-reference-options">${editorAssets(root).map((a, i) => context.button('vc-insert-reference', `${a.type === 'image' ? `<img src="${context.esc(mediaUrl(a.url))}" alt="">` : composerIcon('voice')}<span>${a.type === 'image' ? `@图片${editorAssets(root).filter(x => x.type === 'image').indexOf(a) + 1}` : '@声音1'}</span><small>${context.esc(a.name)}</small>`, '', `data-id="${a.id}"`)).join('')}</div>`, 330);
  const menu = document.querySelector('.vc-popover-references');
  menu?.addEventListener('keydown', event => {
    const options = [...menu.querySelectorAll('[data-action="vc-insert-reference"]')], index = options.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus(); }
  });
}
function canGenerate() {
  const images = referenceAssets().filter(a => a.type === 'image');
  return !locked() && !hasMissingReferences(state.prompt) && images.every(a => !a.expired && a.url) && images.length > 0 && images.length <= VIDEO_MODELS.find(m => m.id === state.settings.model).maxImages && Boolean(state.prompt.trim()) && Boolean(state.config?.generationEnabled) && state.quote?.affordable !== false;
}
function workflowFeedback(ctx) {
  if (state.error) return `<div class="vc-workflow-feedback is-error" id="vc-error" role="alert"><span>${ctx.esc(state.error)}</span>${['director', 'generation'].includes(state.errorKind) && !locked() ? ctx.button('vc-retry-request', '重试', 'vc-outline') : state.errorSource === 'poll' ? ctx.button('vc-refresh', '重新连接', 'vc-outline') : ''}</div>`;
  const operation = pendingOp(), task = state.session?.tasks.find(busyTask);
  const text = state.uploadLabel || (operation ? operation.status === 'settling' ? '脚本已生成，正在核对费用。' : operation.progress || '正在生成脚本…' : state.busy ? state.activity === 'director' ? '正在提交编导…' : state.activity === 'generation' ? '正在提交视频…' : '正在处理…' : task ? `${labels[task.status]}，请在右侧查看进度。` : '');
  return text ? `<div class="vc-workflow-feedback" role="status"><span class="vc-progress-dot" aria-hidden="true"></span><span>${ctx.esc(text)}</span></div>` : '';
}
function editor(ctx) {
  const { esc, icon, button } = ctx, assets = state.session?.assets || [], disabled = locked(), op = pendingOp(), current = VIDEO_SKILLS.find(s => s.id === state.skill), imageCount = assets.filter(a => a.type === 'image').length, latest = latestScript();
  const scriptCards = (state.session?.operations || []).map(o => `<article class="vc-message"><p class="vc-user-message">${esc(o.message)}</p>${o.status === 'completed' && o.result ? `<div class="vc-assistant-message">${o.result.script ? `<div class="vc-script-document" data-script-id="${o.id}" title="点击应用当前脚本" tabindex="0" role="group" aria-label="编导脚本">${promptMarkup(directorDocument(o.result, assets), assets)}</div><div class="vc-script-actions">${button('vc-copy', uiIcon('copy'), 'vc-icon', `data-id="${o.id}" aria-label="复制脚本"`)}${button('vc-apply', '应用脚本 ' + icon('arrow'), 'vc-apply', `data-id="${o.id}" ${disabled || o.skill !== state.skill ? 'disabled' : ''}`)}</div>` : `${markdownText(o.result.text)}${o.result.questions?.length ? `<ul>${o.result.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}`}${o.result.warnings?.length ? `<details class="vc-warnings"><summary>需要确认</summary>${o.result.warnings.map(w => `<p>${esc(w)}</p>`).join('')}</details>` : ''}</div>` : `<div class="vc-assistant-message ${o.status === 'failed' ? 'vc-error' : 'vc-thinking'}" role="status">${['failed', 'settling'].includes(o.status) ? esc(o.error || '费用待核对，请稍后查看。') : icon('star') + esc(o.progress || '编导处理中…')}</div>`}</article>`).join('');
  const quoteText = state.quote?.unlimited ? '无限积分' : state.quote ? `预计 ${state.quote.points} 积分` : state.quoteError ? '费用暂不可用' : '读取费用…';
  return `<section class="vc-editor panel" aria-label="AI视频创作编辑区"><header class="vc-editor-heading">${button('vc-skills', `<img class="vc-skill-thumb" src="${SKILL_ART[current.id]}" alt=""><span><strong>${esc(current.name)}</strong><small>${esc(current.description)}</small></span>${icon('chevron')}`, 'skill-trigger', `aria-haspopup="dialog" aria-expanded="false" ${disabled ? 'disabled' : ''}`)}${button('vc-new', '＋ 新建', 'textbutton', state.busy ? 'disabled' : '')}</header><input type="file" id="vc-images" accept="image/jpeg,image/png,image/webp" multiple hidden><input type="file" id="vc-characters" accept="image/jpeg,image/png,image/webp" multiple hidden><input type="file" id="vc-audio" accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" hidden>${workflowFeedback(ctx)}<span id="vc-draft-status" class="vc-draft-status" role="status">${state.draftSaveFailed ? '草稿未保存，请保留当前页面' : state.draftId ? syncLabel() : ''}</span>
  ${state.stage === 'director' ? `<div class="vc-conversation-wrap"><div class="vc-conversation" aria-label="编导对话">${scriptCards || `<div class="vc-empty-director">${emptyDirectorArt()}<h1>你想创作一条什么视频？</h1><div class="vc-hooks">${VIDEO_HOOKS.map(h => button('vc-hook', esc(h), 'vc-hook', `data-value="${esc(h)}"`)).join('')}</div></div>`}</div>${button('vc-scroll-bottom', uiIcon('down'), 'vc-scroll-bottom', 'aria-label="回到对话底部" hidden')}</div><div class="vc-stage-link">${latest && !disabled ? `<div class="vc-next-step"><span>脚本已生成</span>${button('vc-apply', '应用最新脚本 ' + icon('arrow'), 'vc-next-apply', `data-id="${latest.id}"`)}</div>` : ''}${button('vc-stage-generation', '退出编导', 'vc-exit-director', disabled ? 'disabled' : '')}</div><div class="vc-composer">${composerMedia(ctx, assets, disabled)}<label class="sr-only" for="vc-message">编导要求</label><div id="vc-message" class="vc-rich-editor vc-director-input" role="textbox" aria-label="编导要求" aria-multiline="true" contenteditable="${!disabled}" data-placeholder="${latest ? '补充修改要求，或应用脚本生成视频' : '分析素材，并生成脚本'}">${promptMarkup(state.input, assets)}</div>${missingReferenceNotice()}${state.uploadLabel ? `<p class="vc-upload-status" role="status">${esc(state.uploadLabel)}</p>` : ''}<div class="vc-composer-bottom">${button('vc-director-settings', `${esc(t(VIDEO_LANGUAGES.find(l => l.id === state.settings.language)?.name))} · ${state.settings.duration}s ${uiIcon('down')}`, 'textbutton', `aria-label="配置脚本语言和视频时长" aria-haspopup="dialog" ${disabled ? 'disabled' : ''}`)}${button('vc-director-reference', '@', 'vc-icon', `aria-label="在编导中引用素材" ${disabled || !assets.length ? 'disabled' : ''}`)}<span class="vc-consumed" aria-label="编导积分消耗">✦ ${esc(consumedCredits())}</span>${button('vc-voice', composerIcon('mic'), `vc-voice ${voiceSession ? 'is-listening' : ''}`, `aria-label="${voiceSession ? '停止语音输入' : '语音输入'}" aria-pressed="${Boolean(voiceSession)}" ${!voiceSession && (disabled || !speechEngine()) ? 'disabled' : ''}`)}${button('vc-send', op ? icon('clock') : '<span>↑</span>', 'vc-send', `aria-label="${imageCount ? '发送给超级编导' : '请先添加图片'}" ${!canSendDirector() ? 'disabled' : ''}`)}</div>${voiceSession ? '<p class="vc-voice-status" role="status">正在听，点击麦克风停止</p>' : ''}</div>` : `<div class="vc-generation"><div class="vc-generation-top"><span>${referenceAssets().length}/31</span><span>${button('vc-save-prompt', icon('save'), 'vc-icon', `aria-label="保存当前提示词" ${state.prompt.trim() ? '' : 'disabled'}`)}${button('vc-saved-prompts', icon('list'), 'vc-icon', 'aria-label="我的提示词"')}${button('vc-expand-editor', uiIcon('expand'), 'vc-icon', 'aria-label="展开编辑"')}</span></div><div class="vc-direct-input">${composerMedia(ctx, referenceAssets(), disabled)}<div id="vc-prompt" class="vc-rich-editor" role="textbox" aria-label="视频提示词" aria-multiline="true" contenteditable="${!disabled}" data-placeholder="描述画面、镜头、氛围和声音…">${promptMarkup(state.prompt, referenceAssets())}</div><div class="vc-rich-bottom">${button('vc-stage-director', uiIcon('sparkle') + '超级编导', 'vc-director-link', disabled ? 'disabled' : '')}${button('vc-reference-menu', '@', 'vc-icon', 'aria-label="引用素材"')}<span id="vc-prompt-count">${state.prompt.length}/12000</span>${button('vc-direct-voice', composerIcon('mic'), 'vc-voice', `aria-label="语音输入视频提示词" ${disabled || !speechEngine() ? 'disabled' : ''}`)}</div></div>${missingReferenceNotice()}<div class="vc-generation-settings">${button('vc-models', icon('star') + (VIDEO_MODELS.find(m => m.id === state.settings.model)?.name || '') + uiIcon('down'), 'setting-button', `aria-haspopup="dialog" ${disabled ? 'disabled' : ''}`)}${button('vc-settings', icon('settings') + `${state.settings.ratio} · 720p · ${state.settings.duration}s` + uiIcon('down'), 'setting-button', `aria-haspopup="dialog" ${disabled ? 'disabled' : ''}`)}</div>${button('vc-generate', `<span>${state.busy ? state.uploadLabel || (state.activity === 'generation' ? '提交中…' : '正在处理…') : currentTask()?.resultUrl ? '再次生成视频' : '立即生成视频'}</span><small>${esc(quoteText)}</small>`, 'primary vc-generate', canGenerate() ? '' : 'disabled')}${state.config?.generationEnabled === false ? '<p class="vc-quote">生成服务暂未连接</p>' : state.quote?.affordable === false ? '<p class="vc-quote vc-error">积分不足</p>' : state.quoteError ? `<p class="vc-quote vc-error">${esc(state.quoteError)}</p>` : ''}</div>`}</section>`;
}
function favorites() { return uiRead('favorites', []); }
function hiddenTasks() { return uiRead('hidden-tasks', []); }
function visibleTasks() { return state.tasks.filter(t => !hiddenTasks().includes(t.id)); }
function taskThumbnail(task, ctx) {
  const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
  const imageId = task.referenceImageIds?.[0];
  if (!task.resultUrl || !uuid.test(task.conversationId || '') || !uuid.test(imageId || '')) return ctx.icon(busyTask(task) ? 'clock' : 'video');
  return `<img src="${API}/conversations/${task.conversationId}/assets/${imageId}" alt="" loading="lazy" decoding="async">`;
}
function preview(ctx) {
  const { esc, icon, button } = ctx, task = currentTask(); let content;
  if (state.preview === 'favorites') {
    const saved = state.tasks.filter(t => favorites().includes(t.id) && !hiddenTasks().includes(t.id));
    content = saved.length ? `<div class="vc-favorites-grid">${saved.map(t => `<article>${button('vc-select-task', `<div>${taskThumbnail(t, ctx)}${uiIcon('play')}</div><strong>${esc(t.title)}</strong><small>${t.duration}s · ${labels[t.status]}</small>`, '', `data-id="${t.id}"`)}${button('vc-favorite', uiIcon('heart'), 'vc-favorite is-favorite', `data-id="${t.id}" aria-label="取消收藏 ${esc(t.title)}" aria-pressed="true"`)}</article>`).join('')}</div>` : `<div class="vc-blank">${uiIcon('heart')}<h2>还没有收藏的视频</h2><p>收藏的视频会显示在这里</p></div>`;
  } else if (task) content = task.resultUrl ? `<div class="vc-result"><div class="vc-result-toolbar">${[['edit', '视频编辑', 'edit'], ['enhance', '画质增强', 'sparkle'], ['subtitle', '字幕擦除', 'edit'], ['watermark', '水印擦除', 'edit']].map(([value, label, symbol]) => button('vc-video-tool', uiIcon(symbol) + label, 'vc-result-tool', `data-value="${value}"`)).join('')}<a class="vc-result-tool" href="${esc(task.resultUrl)}?download=1" download="qiya-video.mp4">${uiIcon('download')}下载</a>${button('vc-favorite', uiIcon('heart'), `vc-icon ${favorites().includes(task.id) ? 'is-favorite' : ''}`, `data-id="${task.id}" aria-label="${favorites().includes(task.id) ? '取消收藏视频' : '收藏视频'}" aria-pressed="${favorites().includes(task.id)}"`)}</div><div class="vc-player" id="vc-player"><video id="vc-result-video" playsinline preload="metadata" src="${esc(task.resultUrl)}" aria-label="AI视频成片"></video>${button('vc-player-play', uiIcon('play'), 'vc-player-big', 'aria-label="播放视频"')}<div class="vc-player-controls">${button('vc-player-play', uiIcon('play'), 'vc-icon', 'aria-label="播放或暂停视频"')}<span id="vc-play-time">0:00 / ${formatTime(task.actualDuration || task.duration)}</span><input id="vc-seek" type="range" min="0" max="1000" value="0" aria-label="视频播放进度">${button('vc-player-mute', uiIcon('sound'), 'vc-icon', 'aria-label="静音视频"')}${button('vc-player-fullscreen', uiIcon('expand'), 'vc-icon', 'aria-label="全屏播放"')}</div></div><div class="vc-video-metadata"><span>尺寸 <strong id="vc-video-size">—</strong></span><span>格式 <strong>MP4</strong></span><span>分辨率 <strong>${esc(task.settings?.resolution || '720p')}</strong></span><span>比例 <strong>${esc(task.settings?.ratio || '—')}</strong></span><span>大小 <strong id="vc-video-bytes">—</strong></span></div><p class="vc-retention">成片保留3天，请及时下载。</p>${phaseSummary(task,esc)}${task.warning ? `<p class="vc-warning">${esc(task.warning)}</p>` : ''}</div>` : `<div class="vc-preview-empty ${busyTask(task) ? 'vc-working' : ''}">${icon(busyTask(task) ? 'clock' : 'video')}<h2>${labels[task.status] || '处理中'}</h2>${phaseSummary(task,esc)}<p>${esc(task.error || (task.status === 'preparing' ? `参考素材 ${task.materialProgress?.prepared || 0}/${task.materialProgress?.total || 0}` : task.status === 'reviewing' ? `审核通过 ${task.materialProgress?.approved || 0}/${task.materialProgress?.total || 0}` : busyTask(task) ? '可以离开页面，稍后回来查看' : ''))}</p>${task.canRecover ? button('vc-recover', '恢复下载', 'secondary', `data-id="${task.id}" ${state.busy ? 'disabled' : ''}`) : ''}</div>`;
  else content = `<div class="vc-preview-empty">${previewArtwork()}<h2>视频创作</h2><p>上传素材，用「超级编导」一键成片</p></div>`;
  return `<section class="vc-preview panel" aria-label="AI视频预览"><header class="preview-tabs" role="tablist" aria-label="视频预览内容">${button('vc-preview', task ? '预览' : '参考示例', state.preview === 'result' ? 'active' : '', `data-value="result" role="tab" aria-selected="${state.preview === 'result'}"`)}${button('vc-preview', '我的收藏', state.preview === 'favorites' ? 'active' : '', `data-value="favorites" role="tab" aria-selected="${state.preview === 'favorites'}"`)}<span></span>${button('vc-queue', uiIcon('fold'), 'vc-icon vc-mobile-queue-toggle', 'aria-label="显示或收起任务列表"')}${!state.sidebar ? button('vc-sidebar', uiIcon('unfold'), 'vc-icon vc-mobile-skill-toggle', 'aria-label="展开技能导航"') : ''}</header><div class="vc-preview-body">${content}</div></section>`;
}
function formatTime(value) { return `${Math.floor(Number(value) / 60)}:${String(Math.floor(Number(value) % 60)).padStart(2, '0')}`; }
function queue(ctx) {
  const { esc, button, icon } = ctx, hiddenDrafts = uiRead('hidden-drafts', []), tasks = visibleTasks(), drafts = state.conversations.filter(c => !state.tasks.some(t => t.conversationId === c.id) && c.id !== state.session?.id && !hiddenDrafts.includes(c.id) && !localDrafts().some(d => d.conversationId === c.id));
  return `<aside class="vc-queue panel ${state.queue ? '' : 'is-collapsed'}" aria-label="视频任务队列"><header><strong>任务队列</strong><div>${hiddenTasks().length || hiddenDrafts.length || uiRead('hidden-local-drafts', []).length ? button('vc-hidden-records', uiIcon('trash'), 'vc-icon', 'aria-label="已移除记录"') : ''}${button('vc-clear-drafts', '清空草稿', 'textbutton', drafts.length || localDrafts().some(d => d.id !== state.draftId && meaningfulDraft(d) && !uiRead('hidden-local-drafts', []).includes(d.id)) ? '' : 'disabled')}${button('vc-queue', uiIcon(state.queue ? 'fold' : 'unfold'), 'vc-icon', `aria-label="${state.queue ? '收起' : '展开'}视频任务队列"`)}</div></header><div class="vc-task-list">${localDraftRows(ctx)}${(state.draftId || state.session) && !tasks.some(t => t.conversationId === state.session?.id) ? `<article class="vc-task-row ${!state.selectedTask ? 'active' : ''}">${button('vc-current', `<span class="vc-task-thumb vc-draft-thumb">${icon('list')}</span><span class="vc-task-copy"><strong>${esc(t('当前创作'))}</strong><small>${esc(VIDEO_SKILLS.find(s => s.id === state.skill).name)}</small></span>`, 'vc-task', 'title="当前创作"')}</article>` : ''}${tasks.slice(0, 50).map(t => `<article class="vc-task-row ${state.selectedTask === t.id ? 'active' : ''}">${button('vc-select-task', `<span class="vc-task-thumb">${taskThumbnail(t, ctx)}${busyTask(t) ? '<i class="vc-task-pulse"></i>' : ''}</span><span class="vc-task-copy"><strong>${esc(t.title)}</strong><span class="vc-task-status ${t.status === 'failed' ? 'failed' : ''}">${labels[t.status] || '处理中'}</span><small>${esc(new Date(t.createdAt).toLocaleString(uiLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))}</small></span>`, 'vc-task', `data-id="${t.id}" title="${esc(t.title)} · ${labels[t.status]}" ${state.busy ? 'disabled' : ''}`)}<div class="vc-task-actions">${button('vc-favorite', uiIcon('heart'), `vc-icon ${favorites().includes(t.id) ? 'is-favorite' : ''}`, `data-id="${t.id}" aria-label="${favorites().includes(t.id) ? '取消收藏' : '收藏'} ${esc(t.title)}" aria-pressed="${favorites().includes(t.id)}"`)}${button('vc-hide-task', uiIcon('trash'), 'vc-icon', `data-id="${t.id}" aria-label="移除任务 ${esc(t.title)}" ${busyTask(t) ? 'disabled' : ''}`)}</div></article>`).join('')}${drafts.map(c => `<article class="vc-task-row">${button('vc-open-conversation', `<span class="vc-task-thumb vc-draft-thumb">${icon('list')}</span><span class="vc-task-copy"><strong>${esc(c.title)}</strong><span class="vc-task-status">脚本草稿</span><small>${new Date(c.updatedAt).toLocaleDateString(uiLocale())}</small></span>`, 'vc-task', `data-id="${c.id}" title="${esc(c.title)}" ${state.busy ? 'disabled' : ''}`)}<div class="vc-task-actions">${button('vc-hide-draft', uiIcon('trash'), 'vc-icon', `data-id="${c.id}" aria-label="移除草稿 ${esc(c.title)}"`)}</div></article>`).join('')}${!tasks.length && !drafts.length && !state.session && !localDrafts().length ? '<p class="vc-muted">还没有生成记录</p>' : ''}</div></aside>`;
}
function videoTool(kind) {
  const task = currentTask(); if (!task?.resultUrl) return;
  const titles = { edit: '视频编辑', enhance: '画质增强', subtitle: '字幕擦除', watermark: '水印擦除' };
  modal(titles[kind], `<div class="vc-tool-layout"><div class="vc-tool-preview"><video controls playsinline src="${context.esc(task.resultUrl)}" aria-label="${titles[kind]}预览"></video>${['subtitle', 'watermark'].includes(kind) ? '<div id="vc-erase-region" class="vc-erase-region"></div>' : ''}</div><div class="vc-tool-options">${kind === 'edit' ? `<h3>截取片段</h3><label>开始时间（秒）<input type="number" min="0" max="${task.actualDuration || task.duration}" value="0" id="vc-tool-start" step="0.1"></label><label>结束时间（秒）<input type="number" min="0.1" max="${task.actualDuration || task.duration}" value="${task.actualDuration || task.duration}" id="vc-tool-end" step="0.1"></label><label class="vc-checkbox"><input type="checkbox" id="vc-tool-muted">移除声音</label>` : kind === 'enhance' ? '<h3>画面调整</h3><label>亮度<input type="range" id="vc-tool-brightness" min="70" max="140" value="100"></label><label>对比度<input type="range" id="vc-tool-contrast" min="70" max="140" value="100"></label><label>饱和度<input type="range" id="vc-tool-saturation" min="0" max="160" value="100"></label>' : '<h3>选择擦除区域</h3><label>横向位置<input type="range" id="vc-tool-x" min="0" max="70" value="5"></label><label>纵向位置<input type="range" id="vc-tool-y" min="0" max="80" value="70"></label><label>区域宽度<input type="range" id="vc-tool-w" min="10" max="90" value="70"></label><label>区域高度<input type="range" id="vc-tool-h" min="5" max="40" value="15"></label>'}<p class="vc-tool-notice">${kind === 'enhance' ? '可预览画面调整，增强导出服务待接入。' : kind === 'edit' ? '可预览截取片段，编辑导出服务待接入。' : '可调整选区，擦除处理服务待接入。'}</p></div></div><footer class="modal-actions">${context.button('vc-close-dialog', '完成预览', 'secondary')}<button class="primary" type="button" disabled title="处理服务待接入">${kind === 'edit' || kind === 'enhance' ? '导出视频' : '开始擦除'}</button></footer>`, true);
  document.querySelector('#modal').classList.add('vc-tool-modal');
  const video = document.querySelector('.vc-tool-preview video');
  if (kind === 'enhance') document.querySelectorAll('.vc-tool-options input').forEach(input => { input.oninput = () => { video.style.filter = `brightness(${document.querySelector('#vc-tool-brightness').value}%) contrast(${document.querySelector('#vc-tool-contrast').value}%) saturate(${document.querySelector('#vc-tool-saturation').value}%)`; }; });
  if (kind === 'edit') {
    const start = document.querySelector('#vc-tool-start'), end = document.querySelector('#vc-tool-end');
    start.onchange = () => { start.value = Math.max(0, Math.min(Number(start.value), Number(end.value) - 0.1)); video.currentTime = Number(start.value); };
    end.onchange = () => { end.value = Math.min(task.actualDuration || task.duration, Math.max(Number(start.value) + 0.1, Number(end.value))); };
    video.ontimeupdate = () => { if (video.currentTime > Number(end.value)) { video.pause(); video.currentTime = Number(start.value); } };
    document.querySelector('#vc-tool-muted').onchange = e => { video.muted = e.target.checked; };
  }
  if (['subtitle', 'watermark'].includes(kind)) { const update = () => { const region = document.querySelector('#vc-erase-region'); for (const [key, prop] of [['x', 'left'], ['y', 'top'], ['w', 'width'], ['h', 'height']]) region.style[prop] = document.querySelector('#vc-tool-' + key).value + '%'; }; document.querySelectorAll('.vc-tool-options input').forEach(input => { input.oninput = update; }); update(); }
}
function bindPlayer() {
  const video = document.querySelector('#vc-result-video'); if (!video) return;
  const update = () => {
    document.querySelectorAll('[data-action="vc-player-play"]').forEach(b => { b.innerHTML = uiIcon(video.paused ? 'play' : 'pause'); });
    document.querySelector('.vc-player-big').hidden = !video.paused;
    document.querySelector('#vc-play-time').textContent = `${formatTime(video.currentTime)} / ${formatTime(Number.isFinite(video.duration) ? video.duration : currentTask()?.duration || 0)}`;
    document.querySelector('#vc-seek').value = video.duration > 0 ? video.currentTime / video.duration * 1000 : 0;
  };
  for (const event of ['play', 'pause', 'timeupdate', 'ended']) video.addEventListener(event, update);
  video.onloadedmetadata = () => { document.querySelector('#vc-video-size').textContent = `${video.videoWidth} × ${video.videoHeight}`; update(); };
  document.querySelector('#vc-seek').oninput = e => { if (Number.isFinite(video.duration)) video.currentTime = Number(e.target.value) / 1000 * video.duration; };
  const account = state.owner, selected = state.selectedTask;
  fetch(video.src, { method: 'HEAD', credentials: 'same-origin', signal: AbortSignal.timeout(15000) }).then(response => {
    if (state.owner !== account || state.selectedTask !== selected || !response.ok) return;
    const size = Number(response.headers.get('Content-Length')); if (size > 0 && document.querySelector('#vc-video-bytes')) document.querySelector('#vc-video-bytes').textContent = (size / 1024 / 1024).toFixed(1) + ' MB';
  }).catch(() => {});
}
async function startRecording() {
  if (state.recording || locked()) return;
  const account = state.owner;
  try {
    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (state.owner !== account || document.body.dataset.page !== 'video') { media.getTracks().forEach(t => t.stop()); return; }
    const recorder = new MediaRecorder(media), chunks = [], session = { recorder, media, account, started: Date.now() }; state.recording = session;
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      clearInterval(session.timer); clearTimeout(session.timeout); media.getTracks().forEach(t => t.stop());
      if (state.recording !== session || session.cancelled || state.owner !== account) return;
      state.recording = null;
      try { const audioContext = new AudioContext(); let buffer; try { buffer = await audioContext.decodeAudioData(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer()); } finally { await audioContext.close(); } const file = new File([encodeWav(buffer)], '录音参考-' + new Date().toISOString().slice(11, 19).replaceAll(':', '') + '.wav', { type: 'audio/wav' }); if (state.owner !== account || document.body.dataset.page !== 'video') return; document.querySelector('#modal').close(); await upload([file], 'voice'); } catch { context?.toast('录音读取失败，请重新录制或上传MP3、WAV。'); }
    };
    modal('录制声音', `<div class="vc-recording"><span class="vc-record-dot"></span><strong id="vc-record-time">00:00</strong><p>录制一段声音参考</p></div><footer class="modal-actions">${context.button('vc-record-cancel', '取消', 'secondary')}${context.button('vc-record-stop', '结束录音', 'primary')}</footer>`);
    session.timer = setInterval(() => { const el = document.querySelector('#vc-record-time'); if (el) el.textContent = formatTime((Date.now() - session.started) / 1000); }, 300);
    session.timeout = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), 60000); recorder.start();
  } catch { context?.toast('无法使用麦克风，请检查浏览器权限。'); }
}
function stopRecording(cancelled = false) { const session = state?.recording; if (!session) return; session.cancelled = cancelled; clearInterval(session.timer); clearTimeout(session.timeout); if (session.recorder.state !== 'inactive') session.recorder.stop(); session.media.getTracks().forEach(t => t.stop()); if (cancelled) state.recording = null; }


export function renderVideoCreator(ctx) {
  if (!state || state.owner !== owner()) reset(); context = ctx;
  return `<div class="vc-shell ${state.sidebar ? '' : 'vc-sidebar-hidden'}">${navigation(ctx)}<div class="vc-layout ${state.queue ? '' : 'vc-queue-hidden'}">${editor(ctx)}${preview(ctx)}${queue(ctx)}</div></div>`;
}
export async function useVideoMaterial(file, kind) {
  const account = state.owner;
  await load();
  if (owner() !== account || document.body.dataset.page !== 'video') throw new Error('页面已切换，请重新选择素材。');
  if (locked()) throw new Error('当前正在处理，请完成后再选择素材。');
  await upload([file], kind === 'voice' ? 'voice' : 'character');
}
export function bindVideoCreator(ctx) {
  context = ctx;
  bindRichEditor(document.querySelector('#vc-message'));
  if (!state.draftRestored) { state.draftRestored = true; const saved = uiRead('active-draft', null); if (saved && localDrafts().some(d => d.id === saved)) void perform(() => openLocalDraft(saved)); }

  bindRichEditor(document.querySelector('#vc-prompt'));
  bindPlayer();
  restoreView();
  document.querySelector('#vc-images').onchange = e => { if (e.target.files.length) void upload([...e.target.files]); e.target.value = ''; };
  document.querySelector('#vc-characters').onchange = e => { if (e.target.files.length) void upload([...e.target.files], 'character'); e.target.value = ''; };
  document.querySelector('#vc-audio').onchange = e => { if (e.target.files.length) void upload([...e.target.files], 'voice'); e.target.value = ''; };
  for (const id of ['#vc-images', '#vc-characters', '#vc-audio']) document.querySelector(id).oncancel = () => { state.replaceUploadId = null; if (state.uploadReturnExpanded) { state.uploadReturnExpanded = false; expandEditor(); } };
  if (!timer) { void load(); timer = setInterval(() => void load(), 3000); }
  const bridge = ctx.configs.video, fingerprint = JSON.stringify({ prompt: bridge.prompt, files: bridge.files, skill: bridge.skill });
  if (state.bridge !== fingerprint) {
    state.bridge = fingerprint;
    if (!state.session && (bridge.prompt || bridge.files.length)) {
      state.input = bridge.prompt;
      state.skill = VIDEO_SKILLS.find(s => s.name === bridge.skill)?.id || state.skill;
      const files = bridge.files.map(id => ctx.assets.find(a => a.id === id)?.file).filter(Boolean);
      if (files.length) void upload(files); else refresh();
    }
  }
}
function savedPrompts() { return uiRead('prompts', readUiStore(accountStorageKey('video-creator-prompts'), [])).filter(p => typeof p.prompt === 'string').slice(0,40); }
async function openConversation(id, task) {
  if (!persistDraft()) return;
  const account = state.owner, data = await request(`/conversations/${id}`); if (state.owner !== account) return; saveSession(data.conversation);
  const previousSettings = task?.settings || data.conversation.settings;
  state.draftId = null; uiWrite('active-draft', null); state.settings = editableSettings(previousSettings); state.input = ''; state.prompt = task?.prompt || '';
  state.scriptId = task?.scriptId || null; state.referenceImageIds = task?.referenceImageIds || null; state.stage = task ? 'generation' : 'director'; state.selectedTask = task?.id || null; state.preview = 'result'; void quote();
  if (previousSettings.resolution !== state.settings.resolution && data.conversation.operations.some(o => o.result?.script)) replanResolution(previousSettings);
}
export function handleVideoCreatorAction(action, el, ctx) {
  if (!action.startsWith('vc-') || ctx.mode !== 'video') return false;
  const { button, icon, esc } = ctx;
  if (handleUiAction(action, el, ctx)) return true;
  if (action === 'vc-upload-image') document.querySelector('#vc-images').click();
  else if (action === 'vc-upload-audio') document.querySelector('#vc-audio').click();
  else if (action === 'vc-reference-group') referencePicker(el.dataset.purpose, ctx);
  else if (action === 'vc-add-reference') { document.querySelector('#modal').close(); document.querySelector(({ reference: '#vc-images', character: '#vc-characters', voice: '#vc-audio' })[el.dataset.purpose])?.click(); }
  else if (action === 'vc-close-reference') document.querySelector('#modal').close();
  else if (action === 'vc-remove-reference') { document.querySelector('#modal').close(); void perform(async () => { saveSession((await request(`/conversations/${state.session.id}/assets/${el.dataset.id}`, { method: 'DELETE' })).conversation); state.scriptId = null; state.referenceImageIds = null; }); }
  else if (action === 'vc-voice') toggleVoice();
  else if (action === 'vc-hook') { state.input = el.dataset.value; persistDraft(true); refresh(); }
  else if (action === 'vc-new') { stopVoice(); if (!persistDraft()) return true; const config = state.config, tasks = state.tasks, conversations = state.conversations, bridge = state.bridge; reset(); Object.assign(state, { config, tasks, conversations, bridge, draftRestored: true }); uiWrite('active-draft', null); refresh(); void quote(); }
  else if (action === 'vc-skills') skillPicker(el);
  else if (action === 'vc-skill') { closePopover(); document.querySelector('#modal').close(); void perform(async () => { const skill = VIDEO_SKILLS.find(s => s.id === el.dataset.value); if (!skill) return; if (state.session) { const data = await request(`/conversations/${state.session.id}`, { ...post({ skill: skill.id, settings: state.settings }), method: 'PATCH' }); saveSession(data.conversation); } state.skill = skill.id; state.scriptId = null; state.pendingScriptRequest = null; state.generationRequest = null; state.stage = 'director'; state.prompt = ''; state.referenceImageIds = null; }); }
  else if (action === 'vc-settings' || action === 'vc-models' || action === 'vc-director-settings') settings(ctx, action === 'vc-models' ? 'models' : action === 'vc-director-settings' ? 'director' : 'generation', el);
  else if (action === 'vc-stage-director') { state.stage = 'director'; refresh(); }
  else if (action === 'vc-stage-generation') { state.stage = 'generation'; refresh(); void quote(); }
  else if (action === 'vc-preview') { state.preview = el.dataset.value; refresh(); }
  else if (action === 'vc-queue') { state.queue = !state.queue; uiWrite('queue', state.queue); refresh(); }
  else if (action === 'vc-refresh') { state.error = ''; state.errorSource = ''; void load(); }
  else if (action === 'vc-current') { state.selectedTask = null; state.preview = 'result'; refresh(); }
  else if (action === 'vc-select-task') { const task = state.tasks.find(t => t.id === el.dataset.id); if (task) void perform(() => openConversation(task.conversationId, task)); }
  else if (action === 'vc-open-local-draft') void perform(() => openLocalDraft(el.dataset.id));
  else if (action === 'vc-open-conversation') void perform(() => openConversation(el.dataset.id));
  else if (action === 'vc-remove') void perform(async () => { saveSession((await request(`/conversations/${state.session.id}/assets/${el.dataset.id}`, { method: 'DELETE' })).conversation); state.scriptId = null; });
  else if (action === 'vc-send') {
    if (!canSendDirector()) return true;
    state.followConversation = true; state.scriptId = null; state.referenceImageIds = null;
    void perform(async () => {
    const id = await ensureSession(), message = state.input.trim() || VIDEO_SKILLS.find(s => s.id === state.skill)?.request || '分析素材，并生成一条适合发布到抖音的同城到店视频脚本';
    const fingerprint = JSON.stringify({ id, message, settings: state.settings });
    if (state.pendingScriptRequest?.fingerprint !== fingerprint) state.pendingScriptRequest = { fingerprint, input: state.input,
      body: { requestId: crypto.randomUUID(), message, settings: { ...state.settings }, expectedScriptId: state.session.operations.findLast(o => o.status === 'completed')?.id || null } };
    const account = state.owner, data = await request(`/conversations/${id}/script`, post(state.pendingScriptRequest.body));
    if (state.owner !== account || state.session?.id !== id) return;
    putOperation(data.operation); recoverAcceptedRequests(); refresh();
    stream?.close();
    if (typeof EventSource !== 'undefined') {
      stream = new EventSource(API + `/conversations/${id}/operations/${data.operation.id}/stream`);
      stream.addEventListener('script.snapshot', event => {
        if (state.owner !== account || state.session?.id !== id) return;
        try { const op = JSON.parse(event.data); const old = state.session.operations.find(o => o.id === op.id);
          if (old && JSON.stringify(old) !== JSON.stringify(op)) { putOperation(op); recoverAcceptedRequests(); refresh(); }
          if (!['queued', 'running'].includes(op.status)) { stream?.close(); void refreshWorkspaceCredits(); void load(); }
        } catch { stream?.close(); }
      }); stream.onerror = () => stream?.close();
    }
    void load();
    }, 'director');
  }
  else if (action === 'vc-apply') {
    if (locked()) return true;
    const op = state.session?.operations.find(o => o.id === el.dataset.id && o.status === 'completed' && o.skill === state.skill && o.result?.script); if (!op) return true;
    if (op.settings.resolution !== DEFAULT_VIDEO_SETTINGS.resolution) { replanResolution(op.settings); state.quote = null; ctx.toast('当前仅支持720p，请让编导调整旧脚本。'); refresh(); void quote(); return true; }
    state.prompt = op.result.script.videoPrompt; state.settings = { ...op.settings }; state.scriptId = op.id; state.referenceImageIds = op.result.script.referenceImageIds || null; state.stage = 'generation'; state.quote = null; state.error = ''; state.errorSource = ''; state.errorKind = ''; refresh(); void quote();
  }
  else if (action === 'vc-copy') { const op = state.session.operations.find(o => o.id === el.dataset.id); if (op?.result?.script) void navigator.clipboard.writeText(op.result.script.videoPrompt).then(() => ctx.toast('脚本已复制。')).catch(() => ctx.toast('复制失败，请手动选择脚本。')); }
  else if (action === 'vc-generate') {
    if (!canGenerate()) return true;
    void perform(async () => {
    const id = await ensureSession(), fingerprint = JSON.stringify({ id, prompt: state.prompt, settings: state.settings, scriptId: state.scriptId, referenceImageIds: state.referenceImageIds });
    if (state.generationRequest?.fingerprint !== fingerprint) state.generationRequest = { fingerprint, id: crypto.randomUUID() };
    const account = state.owner, data = await request(`/conversations/${id}/generate`, post({ requestId: state.generationRequest.id, prompt: state.prompt, settings: state.settings, scriptId: state.scriptId, referenceImageIds: state.referenceImageIds }));
    if (state.owner !== account || state.session?.id !== id) return;
    const task = settledSnapshot(state.tasks.find(t => t.id === data.task.id), data.task);
    state.tasks = [task, ...state.tasks.filter(t => t.id !== task.id)]; state.session.tasks = [task, ...state.session.tasks.filter(t => t.id !== task.id)];
    state.selectedTask = data.task.id; state.preview = 'result'; state.generationRequest = null; void refreshWorkspaceCredits();
    }, 'generation');
  }
  else if (action === 'vc-retry-request') {
    return handleVideoCreatorAction(state.errorKind === 'generation' ? 'vc-generate' : 'vc-send', el, ctx);
  }
  else if (action === 'vc-recover') void perform(async () => { const data = await request(`/tasks/${el.dataset.id}/recover`, post({})); state.tasks = state.tasks.map(t => t.id === data.task.id ? data.task : t); });
  else if (action === 'vc-save-prompt') savePromptDialog();
  else if (action === 'vc-saved-prompts') promptLibrary();
  else if (action === 'vc-use-prompt') void useSavedPrompt(el.dataset.id);
  return true;
}
export function disposeVideoCreator() { closePopover(); stopRecording(true); stopVoice(); persistDraft(); cloud?.close(); cloud=null; cloudOwner=null; clearInterval(timer); stream?.close(); stream = null; timer = null; context = null; }

function restoreView() {
  const view = state.view; state.view = null;
  const conversation = document.querySelector('.vc-conversation'), queueList = document.querySelector('.vc-task-list');
  if (conversation) {
    if (state.followConversation || view?.follow || view?.scroll === undefined && state.session?.operations.length) conversation.scrollTop = conversation.scrollHeight;
    else if (view?.scroll !== undefined) conversation.scrollTop = view.scroll;
    state.followConversation = false;
    const update = () => { const button = document.querySelector('[data-action="vc-scroll-bottom"]'); if (button) button.hidden = conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop < 100; };
    conversation.onscroll = update; update();
  }
  if (queueList && view?.queueScroll !== undefined) queueList.scrollTop = view.queueScroll;
  if (view?.richScroll !== undefined && document.querySelector('#vc-prompt')) document.querySelector('#vc-prompt').scrollTop = view.richScroll;
  const active = view?.focus && document.getElementById(view.focus);
  if (active) {
    active.focus({ preventScroll: true });
    if (typeof view.start === 'number' && typeof active.setSelectionRange === 'function') active.setSelectionRange(view.start, view.end);
    if (view.caret !== undefined && active.isContentEditable) {
      const walker = document.createTreeWalker(active, NodeFilter.SHOW_TEXT); let left = view.caret, node;
      while ((node = walker.nextNode())) { if (left <= node.length) { const range = document.createRange(), chip = node.parentElement.closest('[contenteditable="false"]'); if (chip) range.setStartAfter(chip); else range.setStart(node, Math.max(0, left)); range.collapse(true); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); break; } left -= node.length; }
    }
  }
  const playback = view?.playback, video = document.querySelector('#vc-result-video');
  if (video && playback?.id === state.selectedTask) { video.muted = playback.muted; video.addEventListener('loadedmetadata', () => { video.currentTime = playback.time; if (!playback.paused) video.play().catch(() => {}); }, { once: true }); }
}
async function useSavedPrompt(id) {
  const item = savedPrompts().find(p => p.id === id); if (!item || locked()) return;
  const reopen = state.returnExpanded; state.returnExpanded = false; document.querySelector('#modal').close();
  await perform(async () => {
    if (item.references?.length) await replaceMaterialSet(item.references);
    state.prompt = item.prompt; state.stage = 'generation'; state.scriptId = null;
    if (VIDEO_MODELS.some(m => m.id === item.settings?.model)) state.settings = editableSettings(item.settings);
    state.quote = null; void quote();
  });
  if (reopen) expandEditor();
}
function confirmListAction(kind, id) {
  const clear = kind === 'drafts';
  modal(clear ? '清空草稿' : '移除记录', `<p class="vc-confirm-copy">${clear ? '从当前浏览器列表移除全部草稿？' : '从当前浏览器列表移除这条记录？'}已生成文件不受影响。</p><footer class="modal-actions">${context.button('vc-close-dialog', '取消', 'secondary')}${context.button('vc-confirm-hide', clear ? '清空草稿' : '移除', 'primary', `data-kind="${kind}" data-id="${id || ''}"`)}</footer>`);
}
function handleUiAction(action, el, ctx) {
  const { esc, button } = ctx;
  if (action === 'vc-inline-replace') { const asset = referenceAssets().find(a => a.id === el.dataset.id); if (asset) referencePicker(videoAssetPurpose(asset), ctx, asset.id); }
  else if (action === 'vc-inline-remove') { if (!locked()) { const reopen = document.querySelector('#modal').classList.contains('vc-expanded-modal'); state.returnExpanded = false; document.querySelector('#modal').close(); void perform(() => replaceMaterialSet(referenceAssets().filter(a => a.id !== el.dataset.id))).then(() => { if (reopen) expandEditor(); }); } }
  else if (action === 'vc-toggle-materials') { state.expandedMaterials = !state.expandedMaterials; if (document.querySelector('#modal')?.classList.contains('vc-expanded-modal')) expandEditor(); else refresh(); }
  else if (action === 'vc-sidebar') { state.sidebar = !state.sidebar; uiWrite('sidebar', state.sidebar); refresh(); }
  else if (action === 'vc-close-popover') closePopover();
  else if (action === 'vc-close-dialog') document.querySelector('#modal').close();
  else if (action === 'vc-scroll-bottom') document.querySelector('.vc-conversation')?.scrollTo({ top: document.querySelector('.vc-conversation').scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  else if (action === 'vc-direct-voice') toggleVoice();
  else if (action === 'vc-expand-editor') expandEditor();
  else if (action === 'vc-collapse-editor') { document.querySelector('#modal').close(); refresh(); }
  else if (action === 'vc-setting-choice') {
    const field = el.dataset.field, value = field === 'generateAudio' ? el.dataset.value === 'true' : el.dataset.value;
    if (!['language', 'model', 'ratio', 'generateAudio'].includes(field)) return true;
    applySettings({ ...state.settings, [field]: value });
  }
  else if (action.startsWith('vc-folder-')) folderAction(action,el);
  else if (action === 'vc-library-tab') {
    state.picker.tab = el.dataset.value; state.picker.limit = 24;
    document.querySelectorAll('[data-action="vc-library-tab"]').forEach(b => b.classList.toggle('selected', b === el)); renderLibraryGrid();
  }
  else if (action === 'vc-library-source') {
    state.picker.source = el.dataset.value;
    document.querySelectorAll('[data-action="vc-library-source"]').forEach(b => b.classList.toggle('selected', b === el)); renderLibraryGrid();
  }
  else if (action === 'vc-library-more') { state.picker.limit += 24; renderLibraryGrid(); }
  else if (action === 'vc-library-toggle') {
    const ids = state.picker.ids, max = state.picker.replaceId || state.picker.purpose === 'voice' ? 1 : state.picker.purpose === 'character' ? 10 : 30;
    if (assetLibrary().find(a=>a.id===el.dataset.id)?.expired) return true;
    if (ids.has(el.dataset.id)) ids.delete(el.dataset.id); else if (ids.size < max) ids.add(el.dataset.id); else if (max === 1) { ids.clear(); ids.add(el.dataset.id); } else ctx.toast(`最多选择${max}张素材。`);
    renderLibraryGrid();
  }
  else if (action === 'vc-role-category') { state.picker.category = el.dataset.value; renderLibraryGrid(); }
  else if (action === 'vc-create-character') createCharacter();
  else if (action === 'vc-library-upload') {
    const purpose = state.picker.purpose; state.uploadFolderId = state.picker.folderId; state.replaceUploadId = state.picker.replaceId; state.uploadReturnExpanded = state.returnExpanded; state.returnExpanded = false;
    document.querySelector('#modal').close(); document.querySelector(({ reference: '#vc-images', character: '#vc-characters', voice: '#vc-audio' })[purpose])?.click();
  }
  else if (action === 'vc-cancel-library') { state.picker = null; document.querySelector('#modal').close(); }
  else if (action === 'vc-confirm-library') { const picker = state.picker, reopen = state.returnExpanded; state.returnExpanded = false; document.querySelector('#modal').close(); void perform(() => applyLibrarySelection(picker)).then(() => { if (reopen) expandEditor(); }); }
  else if (action === 'vc-preview-asset') previewAsset(el.dataset.id);
  else if (action === 'vc-lightbox-done') {
    const old = state.libraryReturn; state.libraryReturn = null; document.querySelector('#modal').close(); if (old) { referencePicker(old.purpose, ctx, old.replaceId); state.picker = old; document.querySelector('#vc-library-search').value = old.query; document.querySelectorAll('[data-action="vc-library-tab"]').forEach(b => b.classList.toggle('selected', b.dataset.value === old.tab)); document.querySelectorAll('[data-action="vc-library-source"]').forEach(b => b.classList.toggle('selected', b.dataset.value === old.source)); renderLibraryGrid(); }
  }
  else if (action === 'vc-zoom') {
    state.zoom = Math.max(0.25, Math.min(4, state.zoom + Number(el.dataset.value))); const image = document.querySelector('#vc-lightbox-image'); if (image) image.style.transform = `scale(${state.zoom})`; document.querySelector('#vc-zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  }
  else if (action === 'vc-director-reference') referenceMenu(document.querySelector('#vc-message'));
  else if (action === 'vc-reference-menu') referenceMenu(document.querySelector('#vc-expanded-prompt') || document.querySelector('#vc-prompt'));
  else if (action === 'vc-insert-reference') {
    const root = document.getElementById(state.editorTarget), asset = editorAssets(root).find(a => a.id === el.dataset.id); if (!root || !asset) return true;
    root.focus(); const range = state.editorRange;
    if (range && root.contains(range.commonAncestorContainer)) { const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
    if (!range || !root.contains(range.commonAncestorContainer)) { const end = document.createRange(); end.selectNodeContents(root); end.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(end); }
    const token = asset.type === 'image' ? `@图片${editorAssets(root).filter(a => a.type === 'image').indexOf(asset) + 1}` : '@声音1';
    if (range?.startContainer.nodeType === 3 && range.startOffset > 0 && range.startContainer.textContent[range.startOffset - 1] === '@') { range.setStart(range.startContainer, range.startOffset - 1); }
    const marker = '\uE000'; insertEditorText(root, token + ' ' + marker); closePopover();
    const marked = readPromptEditor(root), value = marked.replace(marker, ''); root.innerHTML = promptMarkup(marked, editorAssets(root)); state[editorField(root)] = value; persistDraft(true); root.focus();
    document.querySelectorAll('#vc-prompt-count,#vc-expanded-count').forEach(el => { el.textContent = state.prompt.length + '/12000'; });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let text;
    while ((text = walker.nextNode())) { const at = text.textContent.indexOf(marker); if (at < 0) continue; text.textContent = text.textContent.replace(marker, ''); const caret = document.createRange(); caret.setStart(text, at); caret.collapse(true); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(caret); break; }
  }
  else if (action === 'vc-edit-prompt') savePromptDialog(el.dataset.id);
  else if (action === 'vc-delete-prompt') {
    modal('删除提示词', `<p>删除这份保存的提示词？</p><footer class="modal-actions">${button('vc-close-dialog', '取消', 'secondary')}${button('vc-confirm-delete-prompt', '删除', 'primary', `data-id="${el.dataset.id}"`)}</footer>`);
  }
  else if (action === 'vc-confirm-delete-prompt') { try { uiWrite('prompts', savedPrompts().filter(p => p.id !== el.dataset.id)); promptLibrary(); } catch { ctx.toast('删除失败，请重试。'); } }
  else if (action === 'vc-favorite') { const ids = favorites(); if (uiWrite('favorites', ids.includes(el.dataset.id) ? ids.filter(id => id !== el.dataset.id) : [...ids, el.dataset.id])) refresh(); }
  else if (action === 'vc-hidden-records') {
    const locals = localDrafts().filter(d => uiRead('hidden-local-drafts', []).includes(d.id));
    const tasks = state.tasks.filter(t => hiddenTasks().includes(t.id)), drafts = state.conversations.filter(c => uiRead('hidden-drafts', []).includes(c.id));
    modal('已移除记录', `<div class="vc-removed-list">${locals.map(d => `<article><span>${esc(d.title)}</span>${button('vc-restore-record','恢复','vc-outline',`data-id="${esc(d.id)}" data-kind="local"`)}</article>`).join('')}${tasks.map(t => `<article><span>${esc(t.title)}</span>${button('vc-restore-record','恢复','vc-outline',`data-id="${t.id}" data-kind="task"`)}</article>`).join('')}${drafts.map(c => `<article><span>${esc(c.title)}</span>${button('vc-restore-record','恢复','vc-outline',`data-id="${c.id}" data-kind="draft"`)}</article>`).join('') || (!tasks.length && !locals.length ? '<p>没有已移除记录</p>' : '')}</div>`);
  }
  else if (action === 'vc-restore-record') {
    const key = el.dataset.kind === 'task' ? 'hidden-tasks' : el.dataset.kind === 'local' ? 'hidden-local-drafts' : 'hidden-drafts'; uiWrite(key, uiRead(key, []).filter(id => id !== el.dataset.id)); document.querySelector('#modal').close(); refresh();
  }
  else if (action === 'vc-hide-task') confirmListAction('task', el.dataset.id);
  else if (action === 'vc-hide-draft') confirmListAction('draft', el.dataset.id);
  else if (action === 'vc-clear-drafts') confirmListAction('drafts');
  else if (action === 'vc-confirm-hide') {
    if (el.dataset.kind === 'drafts' && !uiWrite('hidden-local-drafts', localDrafts().filter(d => d.id !== state.draftId).map(d => d.id))) return true;
    if (el.dataset.kind === 'task') { if (!uiWrite('hidden-tasks', [...hiddenTasks(), el.dataset.id])) return true; if (state.selectedTask === el.dataset.id) state.selectedTask = null; }
    else { const ids = uiRead('hidden-drafts', []), next = el.dataset.kind === 'drafts' ? state.conversations.filter(c => c.id !== state.session?.id && !state.tasks.some(t => t.conversationId === c.id)).map(c => c.id) : [el.dataset.id]; if (!uiWrite('hidden-drafts', [...new Set([...ids, ...next])])) return true; }
    document.querySelector('#modal').close(); refresh();
  }
  else if (action === 'vc-video-tool') videoTool(el.dataset.value);
  else if (action === 'vc-player-play') { const video = document.querySelector('#vc-result-video'); if (video.paused) void video.play().catch(() => ctx.toast('视频暂时无法播放，请刷新后重试。')); else video.pause(); }
  else if (action === 'vc-player-mute') { const video = document.querySelector('#vc-result-video'); video.muted = !video.muted; el.innerHTML = uiIcon(video.muted ? 'mute' : 'sound'); el.setAttribute('aria-label', video.muted ? '取消静音' : '静音视频'); }
  else if (action === 'vc-player-fullscreen') { const player = document.querySelector('#vc-player'); if (document.fullscreenElement) void document.exitFullscreen(); else player.requestFullscreen?.(); }
  else if (action === 'vc-record') void startRecording();
  else if (action === 'vc-record-stop') stopRecording();
  else if (action === 'vc-record-cancel') { stopRecording(true); document.querySelector('#modal').close(); }
  else return false;
  return true;
}
document.addEventListener('pointerdown', event => {
  const referenceButton = event.target.closest('[data-action="vc-reference-menu"],[data-action="vc-director-reference"]');
  if (referenceButton) {
    const root = referenceButton.dataset.action === 'vc-director-reference' ? document.querySelector('#vc-message') : document.querySelector('#vc-expanded-prompt') || document.querySelector('#vc-prompt');
    const selection = window.getSelection();
    if (root && selection?.rangeCount && root.contains(selection.anchorNode)) { state.referenceCaret = { target: root.id, range: selection.getRangeAt(0).cloneRange() }; event.preventDefault(); }
  }
  if (!state?.popover || event.target.closest('.vc-popover,[data-popover-open]')) return;
  closePopover();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state?.popover) { const trigger = document.querySelector('[data-popover-open]'); closePopover(); trigger?.focus(); event.preventDefault(); }
});
document.addEventListener('click', event => {
  const script = event.target.closest('.vc-script-document');
  if (script && !event.target.closest('button,a') && !String(window.getSelection())) handleVideoCreatorAction('vc-apply', { dataset: { id: script.dataset.scriptId } }, context);
});
document.addEventListener('keydown', event => {
  if (event.target.matches('.vc-script-document') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); handleVideoCreatorAction('vc-apply', { dataset: { id: event.target.dataset.scriptId } }, context); }
});
document.querySelector('#modal')?.addEventListener('close', () => {
  const dialog = document.querySelector('#modal'); if (dialog.open) return;
  const expanded = dialog.classList.contains('vc-expanded-modal');
  stopRecording(true); state && (state.picker = null); dialog.classList.remove('vc-dialog', 'vc-expanded-modal', 'vc-lightbox-modal', 'vc-asset-modal', 'vc-tool-modal');
  if (state?.returnExpanded) { state.returnExpanded = false; queueMicrotask(() => { if (context && !dialog.open && document.body.dataset.page === 'video') expandEditor(); }); }
  if (expanded) { stopVoice(); }
  if (state?.refreshQueued || expanded) { state.refreshQueued = false; refresh(); }
});
