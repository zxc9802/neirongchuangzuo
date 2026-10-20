import { markdownText } from './markdown.js';
import { VIDEO_SKILLS, VIDEO_HOOKS, VIDEO_MODELS, VIDEO_RATIOS, VIDEO_LANGUAGES, DEFAULT_VIDEO_SETTINGS, videoAssetPurpose } from './video-catalog.js';
import { accountStorageKey } from './account-storage.js';
import { refreshWorkspaceCredits, workspaceCreditsState } from './workspace-credits.js';

const API = '/api/video-creator';
const labels = { reserving: '预留积分', preparing: '准备素材', reviewing: '素材审核', submitting: '提交生成', running: '生成中', downloading: '保存成片', completed: '已完成', failed: '未完成', uncertain: '结果待核对', settling: '费用待核对', expired: '已过期' };
const busyTask = task => ['reserving', 'preparing', 'reviewing', 'submitting', 'running', 'downloading', 'settling'].includes(task.status);
let context, timer, stream, voiceSession, loading = false, quoteVersion = 0;
let state;
function owner() { return globalThis.workspaceUser?.id || 'local-dev'; }
const editableSettings = settings => ({ ...DEFAULT_VIDEO_SETTINGS, ...settings, resolution: DEFAULT_VIDEO_SETTINGS.resolution });
function replanResolution(settings) {
  state.settings = editableSettings(settings); state.stage = 'director'; state.scriptId = null; state.referenceImageIds = null; state.prompt = '';
  state.input = '按720p重新输出上一版完整脚本，保留原有分镜、内容和其他设置。';
}
function reset() { stopVoice(); state = { owner: owner(), skill: VIDEO_SKILLS[0].id, settings: { ...DEFAULT_VIDEO_SETTINGS }, config: null, session: null,
  tasks: [], conversations: [], input: '', prompt: '', scriptId: null, referenceImageIds: null, stage: 'director', busy: false, error: '', errorSource: '', selectedTask: null,
  preview: 'result', queue: true, quote: null, quoteError: '', uploadLabel: '', bridge: null }; }
function refresh() { if (context && document.body.dataset.page === 'video' && state.owner === owner()) context.refresh(); }
function currentTask() { return state.tasks.find(t => t.id === state.selectedTask); }
function pendingOp() { return state.session?.operations.findLast(o => ['queued', 'running', 'settling'].includes(o.status)); }
function locked() { return state.busy || Boolean(voiceSession) || Boolean(pendingOp()) || state.session?.tasks.some(busyTask); }
const speechEngine = () => globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const composerIcon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${name === 'person' ? 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2' : name === 'voice' ? 'M11 5 6 9H3v6h3l5 4V5 M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14' : 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5 M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8'}"/></svg>`;
function stopVoice() {
  const current = voiceSession; if (!current) return;
  voiceSession = null; clearTimeout(current.timer);
  if (state?.owner === current.owner) state.input = current.final ? (current.prefix + current.final).slice(0, 8000) : current.initial;
  try { current.recognition.abort(); } catch {}
}
function toggleVoice() {
  if (voiceSession) { try { voiceSession.recognition.stop(); } catch { stopVoice(); refresh(); } return; }
  if (locked()) return;
  const Engine = speechEngine(); if (!Engine) { context.toast('当前浏览器不支持语音输入，请使用 Chrome 或直接输入文字。'); return; }
  const recognition = new Engine(), current = { recognition, owner: state.owner, initial: state.input, prefix: state.input ? state.input + '\n' : '', final: '' };
  voiceSession = current; state.error = ''; state.errorSource = '';
  recognition.lang = ({ zh: 'zh-CN', en: 'en-US', th: 'th-TH', ms: 'ms-MY', pt: 'pt-BR' })[state.settings.language] || 'zh-CN';
  recognition.continuous = true; recognition.interimResults = true;
  const valid = () => voiceSession === current && state.owner === current.owner && owner() === current.owner && document.body.dataset.page === 'video';
  const finish = () => { if (voiceSession !== current) return; clearTimeout(current.timer); voiceSession = null; if (state.owner === current.owner) state.input = current.final ? (current.prefix + current.final).slice(0, 8000) : current.initial; refresh(); };
  recognition.onresult = event => {
    if (!valid()) return; let final = '', interim = '';
    for (let i = 0; i < event.results.length; i++) { const result = event.results[i]; if (result.isFinal) final += result[0].transcript; else interim += result[0].transcript; }
    current.final = final; state.input = (current.prefix + final + interim).slice(0, 8000);
    const input = document.querySelector('#vc-message'); if (input) input.value = state.input;
    if (current.prefix.length + final.length + interim.length >= 8000) recognition.stop();
  };
  recognition.onerror = event => {
    if (!valid()) return;
    if (event.error !== 'aborted') { state.error = ({ 'not-allowed': '请允许浏览器使用麦克风后重试。', 'service-not-allowed': '浏览器暂不允许语音识别，请直接输入文字。', 'audio-capture': '未找到可用麦克风，请检查设备。', network: '语音识别连接失败，请重试或直接输入文字。', 'no-speech': '没有识别到声音，请重试。' })[event.error] || '语音识别未完成，请重试或直接输入文字。'; state.errorSource = 'action'; }
    finish();
  };
  recognition.onend = finish;
  try { recognition.start(); current.timer = setTimeout(() => { if (valid()) recognition.stop(); }, 90000); refresh(); }
  catch { state.error = '无法启动语音输入，请检查浏览器和麦克风权限。'; state.errorSource = 'action'; finish(); }
}
async function request(path, options = {}) {
  const response = await fetch(API + path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(options.method === 'PUT' ? 120000 : 20000), ...options });
  let data; try { data = await response.json(); } catch { throw new Error('视频服务暂时不可用，请稍后重试。'); }
  if (!response.ok) throw new Error(data.error || '操作未完成，请稍后重试。'); return data;
}
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
async function perform(work) {
  if (state.busy || voiceSession) return;
  const account = state.owner; state.busy = true; state.error = ''; state.errorSource = ''; refresh();
  try { await work(); }
  catch (cause) { if (state.owner === account) { state.error = cause.message; state.errorSource = 'action'; } }
  finally { if (state.owner === account) { state.busy = false; state.uploadLabel = ''; refresh(); } }
}
function saveSession(session) { if (state.session?.id === session.id && state.session.version > session.version) return; state.session = session; state.skill = session.skill; }
async function ensureSession() {
  if (state.session) return state.session.id;
  const account = state.owner, requestId = state.draftRequestId ||= crypto.randomUUID();
  const data = await request('/conversations', post({ requestId, skill: state.skill, settings: state.settings }));
  if (account !== state.owner) throw new Error('账号已切换，请重新打开创作。');
  saveSession(data.conversation); return state.session.id;
}
async function upload(files, purpose) {
  await perform(async () => {
    const account = state.owner, id = await ensureSession();
    for (let index = 0; index < files.length; index++) {
      if (state.owner !== account) return;
      const file = files[index], image = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type), audio = ['audio/mpeg', 'audio/wav', 'audio/x-wav'].includes(file.type);
      if (!image && !audio) throw new Error('图片支持 JPG、PNG、WebP，声音支持 MP3、WAV。');
      const assetPurpose = purpose || (audio ? 'voice' : 'reference');
      if (image && assetPurpose === 'voice' || audio && assetPurpose !== 'voice') throw new Error('请按当前入口选择图片或声音文件。');
      if (file.size > (image ? 10 : 15) * 1024 * 1024) throw new Error(image ? '单张图片不能超过10MB。' : '声音文件不能超过15MB。');
      if (state.session.assets.filter(a => a.type === (image ? 'image' : 'audio')).length >= (image ? 30 : 1)) throw new Error(image ? '最多添加30张图片。' : '最多选择一段声音参考。');
      if (assetPurpose === 'character' && state.session.assets.filter(a => videoAssetPurpose(a) === 'character').length >= 10) throw new Error('最多添加10张角色参考图。');
      state.uploadLabel = `上传素材 ${index + 1}/${files.length}`; refresh();
      const data = await request(`/conversations/${id}/assets/${crypto.randomUUID()}`, { method: 'PUT', headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), 'X-Asset-Purpose': assetPurpose }, body: file });
      if (state.owner !== account) return; saveSession(data.conversation);
    }
    state.scriptId = null; state.referenceImageIds = null; state.quote = null; void quote();
  });
}
function composerMedia(ctx, assets, disabled) {
  const { esc, icon, button } = ctx;
  return `<div class="vc-reference-groups" aria-label="创作参考素材">${[['reference', '添加图片', 'image'], ['character', '添加角色', 'person'], ['voice', '添加声音', 'voice']].map(([purpose, label, symbol]) => {
    const selected = assets.filter(a => videoAssetPurpose(a) === purpose), image = selected.find(a => a.type === 'image');
    return button('vc-reference-group', `<span class="vc-reference-tile">${image ? `<img src="${esc(image.url || '')}" alt="${esc(image.name)}">` : symbol === 'image' ? icon('image') : composerIcon(symbol)}${selected.length ? `<span class="vc-reference-count">${selected.length}</span>` : ''}<span class="vc-reference-plus">+</span></span><span class="vc-reference-label">${label}${purpose !== 'reference' ? '<small>（可选）</small>' : ''}</span>`, 'vc-reference-group', `data-purpose="${purpose}" aria-label="${label}" title="${label}${selected.length ? ` · 已选${selected.length}${purpose === 'voice' ? '段' : '张'}` : ''}" ${disabled ? 'disabled' : ''}`);
  }).join('')}</div>`;
}
function referencePicker(purpose, ctx) {
  const { esc, button } = ctx, files = state.session?.assets.filter(a => videoAssetPurpose(a) === purpose) || [];
  const input = ({ reference: '#vc-images', character: '#vc-characters', voice: '#vc-audio' })[purpose]; if (!input || locked()) return;
  if (!files.length) { document.querySelector(input).click(); return; }
  const editable = !state.session.operations.length && !state.session.tasks.length;
  ctx.openModal(({ reference: '图片素材', character: '角色参考', voice: '声音参考' })[purpose], '', `<div class="vc-reference-library">${files.map(a => `<figure>${a.type === 'image' ? `<img src="${esc(a.url || '')}" alt="${esc(a.name)}">` : `<audio src="${esc(a.url || '')}" controls></audio>`}<figcaption>${esc(a.name)}</figcaption>${editable ? button('vc-remove-reference', '移除', 'textbutton', `data-id="${a.id}"`) : ''}</figure>`).join('')}</div><footer class="modal-actions">${button('vc-add-reference', '继续添加', 'secondary', `data-purpose="${purpose}" ${purpose === 'voice' ? 'disabled' : ''}`)}${button('vc-close-reference', '完成', 'primary')}</footer>`);
}
function consumedCredits() {
  const operations = state.session?.operations || [];
  const points = operations.reduce((sum, op) => sum + (op.billing?.status === 'settled' && Number.isSafeInteger(op.billing.chargedPoints) ? op.billing.chargedPoints : 0), 0);
  return `已消耗 ${points.toLocaleString('zh-CN')} 积分${operations.some(op => op.billing && !['settled', 'released'].includes(op.billing.status)) ? ' · 核对中' : ''}`;
}
function creativePlan(result, assets, ctx, withAudio) {
  const { esc } = ctx, plan = result.script.plan;
  if (!plan) return result.script.globalDirection ? `<details class="vc-plan-details"><summary>全片设定</summary>${markdownText(result.script.globalDirection)}</details>` : '';
  const images = assets.filter(a => a.type === 'image'), selected = new Set(result.script.referenceImageIds || []);
  const field = (label, value) => value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '';
  return `<div class="vc-creative-brief"><dl>${field('到店理由', plan.objective)}${field('目标顾客', plan.audience)}${field('叙事视角', plan.perspective)}${field('体验与情绪', plan.storyArc)}</dl></div>
    <details class="vc-plan-details"><summary>素材与职责</summary><div class="vc-asset-roles">${(result.assets || []).map(role => {
      const asset = assets.find(a => a.id === role.id); if (!asset) return '';
      return `<article>${asset.type === 'image' ? `<img src="${esc(asset.url || '')}" alt="${esc(asset.name)}" loading="lazy">` : composerIcon('voice')}<div><strong>${asset.type === 'image' ? `图片${images.indexOf(asset) + 1}` : '声音参考'}${asset.type === 'image' && !selected.has(asset.id) ? '<small>未选用</small>' : ''}</strong><p>${esc(role.role)}</p><p>采用：${esc(role.adopt || role.description)}</p>${role.exclude ? `<p class="vc-role-exclude">不采用：${esc(role.exclude)}</p>` : ''}</div></article>`;
    }).join('')}</div></details>
    <details class="vc-plan-details"><summary>人物、风格与声音</summary><dl>${plan.cast.map(c => field(c.name, `${c.role}；${c.appearance}`)).join('')}${field('画面风格', plan.visualStyle)}${withAudio ? field('口播', plan.audio.voiceDirection) + field('配乐', plan.audio.music) + field('环境声', plan.audio.ambience) : field('声音', '静音')}</dl><div class="vc-continuity"><strong>保持</strong><ul>${plan.keep.map(v => `<li>${esc(v)}</li>`).join('')}</ul><strong>禁止</strong><ul>${plan.avoid.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div></details>`;
}
async function quote() {
  const revision = ++quoteVersion, account = state.owner;
  try {
    const data = await request('/quote', post({ settings: state.settings }));
    if (revision !== quoteVersion || account !== state.owner) return;
    state.quote = data; state.quoteError = ''; refresh();
  } catch (cause) { if (revision === quoteVersion && account === state.owner) { state.quote = null; state.quoteError = cause.message; refresh(); } }
}
async function load() {
  if (loading || !context) return; loading = true; const account = state.owner;
  try {
    const [config, tasks, conversations] = await Promise.all([state.config ? Promise.resolve(state.config) : request('/config'), request('/tasks'), request('/conversations')]);
    if (state.owner !== account) return;
    let changed = JSON.stringify(state.tasks) !== JSON.stringify(tasks.tasks) || JSON.stringify(state.conversations) !== JSON.stringify(conversations.conversations) || !state.config;
    state.config = config; state.tasks = tasks.tasks; state.conversations = conversations.conversations;
    if (state.session) {
      const id = state.session.id, data = await request(`/conversations/${id}`);
      if (state.owner !== account || state.session?.id !== id) return;
      changed ||= JSON.stringify(data.conversation) !== JSON.stringify(state.session);
      saveSession(data.conversation);
    }
    if (state.errorSource === 'poll') { state.error = ''; state.errorSource = ''; changed = true; }
    if (changed) { refresh(); if (state.tasks.some(t => t.status === 'completed') || state.session?.operations.some(o => o.status === 'completed')) void refreshWorkspaceCredits(); }
    if (!state.quote && !state.quoteError) void quote();
  } catch (cause) { if (state.owner === account && state.errorSource !== 'action') { state.error = cause.name === 'TimeoutError' ? '读取视频任务超时，正在重新连接。' : cause.message; state.errorSource = 'poll'; refresh(); } }
  finally { loading = false; }
}
function editor(ctx) {
  const { esc, icon, button } = ctx, assets = state.session?.assets || [], disabled = locked(), op = pendingOp();
  const current = VIDEO_SKILLS.find(s => s.id === state.skill), imageCount = assets.filter(a => a.type === 'image').length;
  const generationImages = state.referenceImageIds?.map(id => assets.find(a => a.id === id)).filter(Boolean);
  const displayedAssets = state.stage === 'generation' ? (generationImages || assets.filter(a => a.type === 'image')).concat(state.settings.generateAudio ? assets.filter(a => a.type === 'audio') : []) : assets;
  const media = `<div class="vc-uploads">${displayedAssets.map(a => `<div class="vc-asset" title="${esc(a.name)}">${a.type === 'image' ? `<img src="${esc(a.url || '')}" alt="${esc(a.name)}">` : icon('audio')}<small>${state.stage === 'generation' && generationImages && a.type === 'image' ? `图片${generationImages.indexOf(a) + 1}` : esc(a.name)}</small>${!state.session.operations.length && !state.session.tasks.length ? button('vc-remove', '×', 'vc-remove', `data-id="${a.id}" aria-label="移除 ${esc(a.name)}" ${disabled ? 'disabled' : ''}`) : ''}</div>`).join('')}
    ${imageCount < 30 ? button('vc-upload-image', icon('image') + '<span>添加图片</span>', 'vc-add', disabled ? 'disabled' : '') : ''}
    ${!assets.some(a => a.type === 'audio') ? button('vc-upload-audio', icon('audio') + '<span>添加声音<small>选填</small></span>', 'vc-add', disabled ? 'disabled' : '') : ''}</div>`;
  const settings = button('vc-settings', icon('settings') + `${esc(VIDEO_LANGUAGES.find(l => l.id === state.settings.language).name)} · ${state.settings.duration}s`, 'textbutton', disabled ? 'disabled' : '');
  const scriptCards = (state.session?.operations || []).map(o => `<article class="vc-message">
    <p class="vc-user-message">${esc(o.message)}</p>
    ${o.status === 'completed' && o.result ? `<div class="vc-assistant-message">${o.result.script ? `<span class="vc-message-skill">${esc(VIDEO_SKILLS.find(s => s.id === o.skill)?.name || '')}</span><h2>${esc(o.result.script.title)}</h2>${markdownText(o.result.script.summary || o.result.text)}${creativePlan(o.result, assets, ctx, o.settings?.generateAudio !== false)}<ol class="vc-shots">${o.result.script.shots.map(s => `<li><span>${s.start}–${s.end}s</span><div>${s.intent ? `<strong>${esc(s.intent)}</strong><p>${esc(s.visual)}</p>` : `<strong>${esc(s.visual)}</strong>`}${s.action ? `<p>动作：${esc(s.action)}</p>` : ''}${s.emotion ? `<p>情绪：${esc(s.emotion)}</p>` : ''}${s.camera ? `<small>${esc(s.camera)}</small>` : ''}${s.voiceover ? `<p>旁白：${esc(s.voiceover)}</p>` : ''}${s.sound ? `<p>拟音：${esc(s.sound)}</p>` : ''}${s.caption ? `<p>字幕：${esc(s.caption)}</p>` : ''}<div class="vc-shot-images">${s.referenceIds.map(id => assets.find(a => a.id === id)).filter(Boolean).map(a => `<img src="${esc(a.url || '')}" alt="${esc(a.name)}" loading="lazy">`).join('')}</div></div></li>`).join('')}</ol>
      <div class="vc-script-actions">${button('vc-copy', '复制脚本', 'textbutton', `data-id="${o.id}"`)}${button('vc-apply', '应用脚本 ' + icon('arrow'), 'vc-apply', `data-id="${o.id}" ${disabled || o.skill !== state.skill ? 'disabled' : ''}`)}</div>`
      : `${markdownText(o.result.text)}${o.result.questions?.length ? `<ul>${o.result.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}`}
      ${o.result.warnings?.length ? `<details class="vc-warnings"><summary>需要确认</summary>${o.result.warnings.map(w => `<p>${esc(w)}</p>`).join('')}</details>` : ''}</div>`
    : `<div class="vc-assistant-message ${o.status === 'failed' ? 'vc-error' : 'vc-thinking'}" role="status">${['failed', 'settling'].includes(o.status) ? esc(o.error || '费用待核对，请稍后查看。') : icon('star') + esc(o.progress || '编导处理中…')}</div>`}</article>`).join('');
  return `<section class="vc-editor panel" aria-label="AI视频创作编辑区"><header class="vc-editor-heading">${button('vc-skills', `<span class="skill-symbol">${icon('store')}</span><span><strong>${esc(current.name)}</strong><small>${esc(current.description)}</small></span>${icon('chevron')}`, 'skill-trigger', disabled ? 'disabled' : '')}${button('vc-new', '＋ 新建', 'textbutton', state.busy ? 'disabled' : '')}</header>
    <input type="file" id="vc-images" accept="image/jpeg,image/png,image/webp" multiple hidden><input type="file" id="vc-characters" accept="image/jpeg,image/png,image/webp" multiple hidden><input type="file" id="vc-audio" accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" hidden>
    ${state.stage === 'director' ? `<div class="vc-conversation" aria-label="编导对话">${scriptCards || `<div class="vc-empty-director">${icon('star')}<h1>你想创作一条什么视频？</h1><div class="vc-hooks">${VIDEO_HOOKS.map(h => button('vc-hook', esc(h), 'vc-hook', `data-value="${esc(h)}"`)).join('')}</div></div>`}</div>
      <div class="vc-stage-link">${button('vc-stage-generation', '退出编导', 'vc-exit-director', disabled ? 'disabled' : '')}</div>
      <div class="vc-composer">${composerMedia(ctx, assets, disabled)}<label class="sr-only" for="vc-message">编导要求</label><textarea id="vc-message" maxlength="8000" placeholder="${state.session?.operations.some(o => o.skill === state.skill) ? '说说哪里需要调整，或补充门店信息…' : esc(current.placeholder || '上传实拍，告诉编导你的宣传要求…')}" ${state.busy ? 'disabled' : voiceSession ? 'readonly' : ''}>${esc(state.input)}</textarea>${state.uploadLabel ? `<p class="vc-upload-status" role="status">${esc(state.uploadLabel)}</p>` : ''}<div class="vc-composer-bottom">${settings}<span class="vc-consumed" aria-label="编导积分消耗" title="本次编导对话已结算的积分">✦ ${esc(consumedCredits())}</span>${button('vc-voice', composerIcon('mic'), `vc-voice ${voiceSession ? 'is-listening' : ''}`, `aria-label="${voiceSession ? '停止语音输入' : '语音输入'}" aria-pressed="${Boolean(voiceSession)}" title="${voiceSession ? '正在听，点击停止' : speechEngine() ? '语音输入' : '当前浏览器不支持语音输入'}" ${!voiceSession && (disabled || !speechEngine()) ? 'disabled' : ''}`)}${button('vc-send', op ? icon('clock') : icon('arrow'), 'vc-send', `aria-label="发送给超级编导" ${disabled || !imageCount || state.config?.directorEnabled === false ? 'disabled' : ''}`)}</div>${voiceSession ? '<p class="vc-voice-status" role="status">正在听，点击麦克风停止</p>' : ''}</div>`
    : `<div class="vc-generation"><div class="vc-generation-top">${button('vc-stage-director', icon('back') + '超级编导', 'textbutton', disabled ? 'disabled' : '')}<span>${button('vc-save-prompt', icon('save'), 'iconbutton', 'aria-label="保存当前提示词"')}${button('vc-saved-prompts', icon('list'), 'iconbutton', 'aria-label="我的提示词"')}</span></div>${media}<label for="vc-prompt">视频提示词</label><textarea id="vc-prompt" maxlength="12000" placeholder="描述画面、镜头、氛围和声音…" ${disabled ? 'disabled' : ''}>${esc(state.prompt)}</textarea><div class="vc-generation-settings">${button('vc-models', icon('star') + (VIDEO_MODELS.find(m => m.id === state.settings.model)?.name || ''), 'setting-button', disabled ? 'disabled' : '')}${button('vc-settings', icon('settings') + `${state.settings.ratio} · ${state.settings.resolution} · ${state.settings.duration}s`, 'setting-button', disabled ? 'disabled' : '')}</div>${button('vc-generate', state.busy ? state.uploadLabel || '提交中…' : '立即生成视频 ' + icon('arrow'), 'primary vc-generate', disabled || !imageCount || !state.prompt.trim() || !state.config?.generationEnabled || state.quote?.affordable === false ? 'disabled' : '')}<p class="vc-quote">${state.config?.generationEnabled === false ? '视频接口尚未配置' : state.quote?.unlimited ? '无限积分' : state.quote ? `预计 ${state.quote.points} 积分${state.quote.affordable ? '' : ' · 积分不足'}` : esc(state.quoteError || '正在读取费用…')}</p></div>`}
    <p class="vc-error" id="vc-error" role="alert">${esc(state.error)}</p></section>`;
}
function preview(ctx) {
  const { esc, icon, button } = ctx, task = currentTask(), assets = state.session?.assets || [];
  let content;
  if (state.preview === 'materials') content = assets.length ? `<div class="vc-material-grid">${assets.map(a => `<figure>${a.type === 'image' ? `<img src="${esc(a.url || '')}" alt="${esc(a.name)}" loading="lazy">` : `<audio src="${esc(a.url || '')}" controls></audio>`}<figcaption>${esc(a.name)}</figcaption></figure>`).join('')}</div>` : '<div class="vc-preview-empty"><p>还没有添加素材</p></div>';
  else if (task) content = `<div class="vc-result">${task.resultUrl ? `<video controls playsinline preload="metadata" src="${esc(task.resultUrl)}" aria-label="AI视频成片"></video><div class="vc-result-caption"><strong>${esc(task.title)}</strong><a class="primary" href="${esc(task.resultUrl)}?download=1" download="qiya-video.mp4">下载视频</a></div><p class="vc-retention">成片保留3天，请及时下载。</p>${task.warning ? `<p>${esc(task.warning)}</p>` : ''}`
    : `<div class="vc-preview-empty ${busyTask(task) ? 'vc-working' : ''}">${icon(busyTask(task) ? 'clock' : 'video')}<h2>${labels[task.status] || '处理中'}</h2><p>${esc(task.error || (task.status === 'preparing' ? `参考素材 ${task.materialProgress?.prepared || 0}/${task.materialProgress?.total || 0}` : task.status === 'reviewing' ? `审核通过 ${task.materialProgress?.approved || 0}/${task.materialProgress?.total || 0}` : busyTask(task) ? '可以离开页面，稍后回来查看' : ''))}</p>${task.canRecover ? button('vc-recover', '恢复下载', 'secondary', `data-id="${task.id}" ${state.busy ? 'disabled' : ''}`) : ''}</div>`}</div>`;
  else content = `<div class="vc-preview-empty"><span class="vc-preview-emblem">${icon('video')}</span><h2>把实拍，变成到店的理由</h2><p>上传素材，用超级编导完成视频脚本</p><div class="vc-preview-photos"><img src="/media/ai-cover-storefront.png" alt="门店展示参考"><img src="/media/ai-cover-service.png" alt="服务体验参考"><img src="/media/ai-cover-brand.png" alt="品牌介绍参考"></div></div>`;
  return `<section class="vc-preview panel" aria-label="AI视频预览"><header class="preview-tabs">${button('vc-preview', '创作预览', state.preview === 'result' ? 'active' : '', 'data-value="result"')}${button('vc-preview', '我的素材', state.preview === 'materials' ? 'active' : '', 'data-value="materials"')}<span></span>${button('vc-queue', icon('list'), 'iconbutton', `aria-label="${state.queue ? '收起' : '展开'}视频任务队列"`)}</header><div class="vc-preview-body">${content}</div></section>`;
}
function queue(ctx) {
  const { esc, button, icon } = ctx;
  return `<aside class="vc-queue panel" aria-label="视频任务队列"><header><strong>任务队列</strong>${button('vc-refresh', icon('refresh'), 'iconbutton', 'aria-label="刷新视频任务"')}</header>${state.session ? button('vc-current', `<strong>当前创作</strong><small>${esc(VIDEO_SKILLS.find(s => s.id === state.skill).name)}</small>`, 'vc-task vc-current') : ''}
    <div class="vc-task-list">${state.tasks.slice(0, 30).map(t => button('vc-select-task', `<span class="vc-task-status">${labels[t.status] || '处理中'}</span><strong>${esc(t.title)}</strong><small>${esc(new Date(t.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))} · ${t.duration}s</small>`, `vc-task ${state.selectedTask === t.id ? 'active' : ''}`, `data-id="${t.id}" ${state.busy ? 'disabled' : ''}`)).join('')}
      ${state.conversations.filter(c => !state.tasks.some(t => t.conversationId === c.id) && c.id !== state.session?.id).slice(0, 12).map(c => button('vc-open-conversation', `<span class="vc-task-status">脚本草稿</span><strong>${esc(c.title)}</strong>`, 'vc-task', `data-id="${c.id}" ${state.busy ? 'disabled' : ''}`)).join('') || (!state.tasks.length ? '<p class="vc-muted">还没有生成记录</p>' : '')}</div></aside>`;
}
export function renderVideoCreator(ctx) {
  if (!state || state.owner !== owner()) reset(); context = ctx;
  return `<div class="vc-layout ${state.queue ? '' : 'vc-queue-hidden'}">${editor(ctx)}${preview(ctx)}${queue(ctx)}</div>`;
}
export function bindVideoCreator(ctx) {
  context = ctx;
  document.querySelector('#vc-message')?.addEventListener('input', e => { state.input = e.target.value; });
  document.querySelector('#vc-message')?.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !locked()) { e.preventDefault(); document.querySelector('[data-action="vc-send"]')?.click(); } });
  document.querySelector('#vc-prompt')?.addEventListener('input', e => {
    state.prompt = e.target.value;
    const button = document.querySelector('[data-action="vc-generate"]'); if (button) button.disabled = locked() || !state.session?.assets.some(a => a.type === 'image') || !state.prompt.trim() || !state.config?.generationEnabled || state.quote?.affordable === false;
  });
  document.querySelector('#vc-images').onchange = e => { if (e.target.files.length) void upload([...e.target.files]); };
  document.querySelector('#vc-characters').onchange = e => { if (e.target.files.length) void upload([...e.target.files], 'character'); };
  document.querySelector('#vc-audio').onchange = e => { if (e.target.files.length) void upload([...e.target.files], 'voice'); };
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
function settings(ctx) {
  const { esc } = ctx, s = state.settings;
  ctx.openModal('视频设置', '', `<form id="vc-settings-form" class="vc-settings-form"><label>生成模型<select name="model">${VIDEO_MODELS.map(m => `<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${m.name}</option>`).join('')}</select></label><label>视频时长<select name="duration" id="vc-duration">${VIDEO_MODELS.find(m => m.id === s.model).durations.map(d => `<option value="${d}" ${d === s.duration ? 'selected' : ''}>${d} 秒</option>`).join('')}</select></label><label>画面比例<select name="ratio">${VIDEO_RATIOS.map(r => `<option ${r === s.ratio ? 'selected' : ''}>${r}</option>`).join('')}</select></label><label>分辨率<select name="resolution">${VIDEO_MODELS.find(m => m.id === s.model).resolutions.map(r => `<option ${r === s.resolution ? 'selected' : ''}>${r}</option>`).join('')}</select></label><label>脚本语言<select name="language">${VIDEO_LANGUAGES.map(l => `<option value="${l.id}" ${l.id === s.language ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label><label>音频<select name="generateAudio"><option value="true" ${s.generateAudio ? 'selected' : ''}>含音频</option><option value="false" ${!s.generateAudio ? 'selected' : ''}>静音</option></select></label><footer class="modal-actions"><button type="submit" class="primary">应用设置</button></footer></form>`);
  const form = document.querySelector('#vc-settings-form');
  form.elements.model.onchange = () => { const m = VIDEO_MODELS.find(m => m.id === form.elements.model.value), selected = Number(form.elements.duration.value); form.elements.resolution.innerHTML = m.resolutions.map(r => `<option ${r === (m.resolutions.includes(form.elements.resolution.value) ? form.elements.resolution.value : '720p') ? 'selected' : ''}>${r}</option>`).join(''); form.elements.duration.innerHTML = m.durations.map(d => `<option value="${d}" ${d === (m.durations.includes(selected) ? selected : m.durations.at(-1)) ? 'selected' : ''}>${d} 秒</option>`).join(''); };
  form.onsubmit = e => {
    e.preventDefault(); const data = Object.fromEntries(new FormData(form)), next = { ...data, duration: Number(data.duration), generateAudio: data.generateAudio === 'true' };
    const applied = state.session?.operations.find(o => o.skill === state.skill && o.result?.script && (o.id === state.scriptId || o.result.script.videoPrompt === state.prompt));
    const changed = applied && Object.keys(DEFAULT_VIDEO_SETTINGS).some(key => applied.settings[key] !== next[key]);
    state.settings = next; state.quote = null; state.quoteError = '';
    if (changed) {
      state.stage = 'director'; state.scriptId = null; state.referenceImageIds = null; state.prompt = '';
      state.input = `按当前${next.duration}秒、${VIDEO_LANGUAGES.find(l => l.id === next.language).name}、${next.generateAudio ? '含音频' : '静音'}设置调整上一版脚本，保留未要求改变的创作方向与事实。`;
      ctx.toast('设置已更改，请让编导调整脚本后再生成。');
    }
    document.querySelector('#modal').close(); refresh(); void quote();
  };
}
function savedPrompts() { try { return JSON.parse(localStorage.getItem(accountStorageKey('video-creator-prompts')) || '[]').filter(p => typeof p.prompt === 'string').slice(0, 40); } catch { return []; } }
async function openConversation(id, task) {
  const account = state.owner, data = await request(`/conversations/${id}`); if (state.owner !== account) return; saveSession(data.conversation);
  const previousSettings = task?.settings || data.conversation.settings;
  state.settings = editableSettings(previousSettings); state.input = ''; state.prompt = task?.prompt || '';
  state.scriptId = task?.scriptId || null; state.referenceImageIds = task?.referenceImageIds || null; state.stage = task ? 'generation' : 'director'; state.selectedTask = task?.id || null; state.preview = 'result'; void quote();
  if (previousSettings.resolution !== state.settings.resolution && data.conversation.operations.some(o => o.result?.script)) replanResolution(previousSettings);
}
export function handleVideoCreatorAction(action, el, ctx) {
  if (!action.startsWith('vc-') || ctx.mode !== 'video') return false;
  const { button, icon, esc } = ctx;
  if (action === 'vc-upload-image') document.querySelector('#vc-images').click();
  else if (action === 'vc-upload-audio') document.querySelector('#vc-audio').click();
  else if (action === 'vc-reference-group') referencePicker(el.dataset.purpose, ctx);
  else if (action === 'vc-add-reference') { document.querySelector('#modal').close(); document.querySelector(({ reference: '#vc-images', character: '#vc-characters', voice: '#vc-audio' })[el.dataset.purpose])?.click(); }
  else if (action === 'vc-close-reference') document.querySelector('#modal').close();
  else if (action === 'vc-remove-reference') { document.querySelector('#modal').close(); void perform(async () => { saveSession((await request(`/conversations/${state.session.id}/assets/${el.dataset.id}`, { method: 'DELETE' })).conversation); state.scriptId = null; state.referenceImageIds = null; }); }
  else if (action === 'vc-voice') toggleVoice();
  else if (action === 'vc-hook') { state.input = el.dataset.value; refresh(); }
  else if (action === 'vc-new') { const config = state.config, tasks = state.tasks, conversations = state.conversations, bridge = state.bridge; reset(); Object.assign(state, { config, tasks, conversations, bridge }); refresh(); void quote(); }
  else if (action === 'vc-skills') ctx.openModal('同城到店', '', `<div class="skill-grid">${VIDEO_SKILLS.map(s => button('vc-skill', `<div class="skill-art">${icon('store')}</div><div><strong>${s.name}</strong><small>${s.description}</small></div>${state.skill === s.id ? icon('check') : ''}`, 'skill-option', `data-value="${s.id}"`)).join('')}</div>`);
  else if (action === 'vc-skill') { document.querySelector('#modal').close(); void perform(async () => { const skill = VIDEO_SKILLS.find(s => s.id === el.dataset.value); if (!skill) return; if (state.session) { const data = await request(`/conversations/${state.session.id}`, { ...post({ skill: skill.id, settings: state.settings }), method: 'PATCH' }); saveSession(data.conversation); } state.skill = skill.id; state.scriptId = null; state.pendingScriptRequest = null; state.generationRequest = null; state.stage = 'director'; state.prompt = ''; state.referenceImageIds = null; }); }
  else if (action === 'vc-settings' || action === 'vc-models') settings(ctx);
  else if (action === 'vc-stage-director') { state.stage = 'director'; refresh(); }
  else if (action === 'vc-stage-generation') { state.stage = 'generation'; refresh(); void quote(); }
  else if (action === 'vc-preview') { state.preview = el.dataset.value; refresh(); }
  else if (action === 'vc-queue') { state.queue = !state.queue; refresh(); }
  else if (action === 'vc-refresh') { state.error = ''; state.errorSource = ''; void load(); }
  else if (action === 'vc-current') { state.selectedTask = null; state.preview = 'result'; refresh(); }
  else if (action === 'vc-select-task') { const task = state.tasks.find(t => t.id === el.dataset.id); if (task) void perform(() => openConversation(task.conversationId, task)); }
  else if (action === 'vc-open-conversation') void perform(() => openConversation(el.dataset.id));
  else if (action === 'vc-remove') void perform(async () => { saveSession((await request(`/conversations/${state.session.id}/assets/${el.dataset.id}`, { method: 'DELETE' })).conversation); state.scriptId = null; });
  else if (action === 'vc-send') void perform(async () => {
    const id = await ensureSession(), message = state.input.trim() || VIDEO_SKILLS.find(s => s.id === state.skill)?.request || '分析素材，并生成一条适合发布到抖音的同城到店视频脚本';
    const fingerprint = JSON.stringify({ id, message, settings: state.settings });
    if (state.pendingScriptRequest?.fingerprint !== fingerprint) state.pendingScriptRequest = { fingerprint,
      body: { requestId: crypto.randomUUID(), message, settings: { ...state.settings }, expectedScriptId: state.session.operations.findLast(o => o.status === 'completed')?.id || null } };
    const data = await request(`/conversations/${id}/script`, post(state.pendingScriptRequest.body));
    state.pendingScriptRequest = null; state.input = ''; state.scriptId = null; state.referenceImageIds = null;
    state.session.operations = [...state.session.operations.filter(o => o.id !== data.operation.id), data.operation];
    stream?.close();
    if (typeof EventSource !== 'undefined') {
      const account = state.owner; stream = new EventSource(API + `/conversations/${id}/operations/${data.operation.id}/stream`);
      stream.addEventListener('script.snapshot', event => {
        if (state.owner !== account || state.session?.id !== id) return;
        try { const op = JSON.parse(event.data); const old = state.session.operations.find(o => o.id === op.id);
          if (old && JSON.stringify(old) !== JSON.stringify(op)) { state.session.operations = state.session.operations.map(o => o.id === op.id ? op : o); refresh(); }
          if (!['queued', 'running'].includes(op.status)) { stream?.close(); void refreshWorkspaceCredits(); void load(); }
        } catch { stream?.close(); }
      }); stream.onerror = () => stream?.close();
    }
    void load();
  });
  else if (action === 'vc-apply') {
    const op = state.session.operations.find(o => o.id === el.dataset.id && o.skill === state.skill && o.result?.script); if (!op) return true;
    if (op.settings.resolution !== DEFAULT_VIDEO_SETTINGS.resolution) { replanResolution(op.settings); state.quote = null; ctx.toast('当前仅支持720p，请让编导调整旧脚本。'); refresh(); void quote(); return true; }
    state.prompt = op.result.script.videoPrompt; state.settings = { ...op.settings }; state.scriptId = op.id; state.referenceImageIds = op.result.script.referenceImageIds || null; state.stage = 'generation'; state.quote = null; refresh(); void quote();
  }
  else if (action === 'vc-copy') { const op = state.session.operations.find(o => o.id === el.dataset.id); if (op?.result?.script) void navigator.clipboard.writeText(op.result.script.videoPrompt).then(() => ctx.toast('脚本已复制。')).catch(() => ctx.toast('复制失败，请手动选择脚本。')); }
  else if (action === 'vc-generate') void perform(async () => {
    const id = await ensureSession(), fingerprint = JSON.stringify({ id, prompt: state.prompt, settings: state.settings, scriptId: state.scriptId, referenceImageIds: state.referenceImageIds });
    if (state.generationRequest?.fingerprint !== fingerprint) state.generationRequest = { fingerprint, id: crypto.randomUUID() };
    const data = await request(`/conversations/${id}/generate`, post({ requestId: state.generationRequest.id, prompt: state.prompt, settings: state.settings, scriptId: state.scriptId, referenceImageIds: state.referenceImageIds }));
    state.tasks = [data.task, ...state.tasks.filter(t => t.id !== data.task.id)]; state.session.tasks = [data.task, ...state.session.tasks.filter(t => t.id !== data.task.id)];
    state.selectedTask = data.task.id; state.preview = 'result'; state.generationRequest = null; void refreshWorkspaceCredits();
  });
  else if (action === 'vc-recover') void perform(async () => { const data = await request(`/tasks/${el.dataset.id}/recover`, post({})); state.tasks = state.tasks.map(t => t.id === data.task.id ? data.task : t); });
  else if (action === 'vc-save-prompt') { if (!state.prompt.trim()) { ctx.toast('先填写或应用一份脚本。'); return true; } try { const items = [{ id: crypto.randomUUID(), prompt: state.prompt, settings: state.settings }, ...savedPrompts()].slice(0, 40); localStorage.setItem(accountStorageKey('video-creator-prompts'), JSON.stringify(items)); ctx.toast('提示词已保存。'); } catch { ctx.toast('保存失败，请复制提示词后保留。'); } }
  else if (action === 'vc-saved-prompts') ctx.openModal('我的提示词', '', `<div class="saved-prompts">${savedPrompts().map(p => button('vc-use-prompt', `<p>${esc(p.prompt.slice(0, 160))}</p>`, 'saved-prompt', `data-id="${p.id}"`)).join('') || '<p class="muted">还没有保存的提示词</p>'}</div>`);
  else if (action === 'vc-use-prompt') { const item = savedPrompts().find(p => p.id === el.dataset.id); if (item) { state.prompt = item.prompt; if (VIDEO_MODELS.some(m => m.id === item.settings?.model)) state.settings = editableSettings(item.settings); state.scriptId = null; state.referenceImageIds = null; state.quote = null; document.querySelector('#modal').close(); refresh(); void quote(); } }
  return true;
}
export function disposeVideoCreator() { stopVoice(); clearInterval(timer); stream?.close(); stream = null; timer = null; context = null; }
