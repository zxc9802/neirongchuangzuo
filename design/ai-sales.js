import { canUseAiSales, SALES_SETTINGS } from './ai-sales-policy.js';
import { VIDEO_IMAGE_MAX_BYTES, VIDEO_AUDIO_MAX_BYTES } from './video-catalog.js';
import { t } from './workspace-preferences.js';
import { markdownText } from './markdown.js';
import { refreshWorkspaceCredits } from './workspace-credits.js';

const API = '/api/video-creator';
const pending = s => ['queued','running','processing','settling','reserving','preparing','reviewing','submitting','downloading'].includes(s);
let current;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const post = value => ({ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value) });
async function api(path, options = {}) {
  const response = await fetch(API + path, { credentials:'same-origin', signal:AbortSignal.timeout(120000), ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || t('请求失败，请重试。')), { status:response.status });
  return data;
}
const key = id => 'qiya-ai-sales-persona-v2:' + id;
function save(s) {
  try { localStorage.setItem(key(s.owner), JSON.stringify({ form:s.form, conversationId:s.conversationId, createId:s.createId, scriptRequest:s.scriptRequest, videoRequest:s.videoRequest })); }
  catch { s.ctx.toast(t('草稿未保存，请保留当前页面')); }
}
const latest = s => s.session?.operations.at(-1);
const latestTask = s => s.session?.tasks.at(-1);
const active = s => s.busy || s.session?.operations.some(o => pending(o.status)) || s.session?.tasks.some(o => pending(o.status));
const materialLocked = s => active(s) || Boolean(s.session?.operations.length || s.session?.tasks.length);
function needed(s) {
  const assets = s.session?.assets || [];
  return [['character','出镜人物照'],['voice','参考声音'],['reference','产品与场景']].filter(([role]) => !assets.some(a => a.purpose === role && !a.expired)).map(([,name]) => t(name));
}
function message(s) {
  return [s.form.name && `产品或门店：${s.form.name}`, s.form.goal && `卖点与要求：${s.form.goal}`,
    s.form.copy && `以下是用户定稿台词，按原文编排，保留全文，不重写、不删句：\n${s.form.copy}`,
    '请为义鹏创作社媒人设视频：他是展示自己用AI制作各类宣传片的创作者；开场提出本次创作挑战，中段展示实拍支持的行业宣传片案例，结尾回到义鹏介绍创作能力并邀请关注或咨询。门店是案例，推广主体是义鹏。不要整片写成食客探店或餐厅到店广告。'].filter(Boolean).join('\n\n');
}
function button(action, label, disabled = false, primary = false) {
  return `<button type="button" data-sales="${action}" class="${primary?'primary':'secondary'}" ${disabled?'disabled':''}>${esc(t(label))}</button>`;
}
function shell(s) {
  s.root.innerHTML = `<div class="sales-shell"><header class="sales-heading"><div><h1>${t('AI带货')}</h1><p>${t('用作品展示你的AI创作能力')}</p></div><span>30s · 480p · 9:16</span>${button('new','新建创作')}</header>
  <div class="sales-layout"><section class="sales-card"><h2>01 · ${t('素材与文案')}</h2><div class="sales-uploads">${[['character','出镜人物照'],['voice','参考声音'],['reference','产品与场景']].map(([role,label])=>`<div><strong>${t(label)}</strong><label class="sales-upload">＋ ${t('上传')}<input type="file" data-role="${role}" accept="${role==='voice'?'audio/mpeg,audio/wav,.mp3,.wav':'image/jpeg,image/png,image/webp'}" ${role==='reference'?'multiple':''}></label><button type="button" class="textbutton" data-sales="library" data-role="${role}">${t('从资产库选择')}</button></div>`).join('')}</div><div id="sales-materials" class="sales-materials"></div>
  <div class="sales-fields"><label>${t('案例门店或行业')}<input id="sales-name" maxlength="120" value="${esc(s.form.name)}"></label><label>${t('本次想展示的AI能力')}<textarea id="sales-goal" rows="3" maxlength="2000" placeholder="${t('这次用什么素材做什么视频，想让商家看到什么？')}">${esc(s.form.goal)}</textarea></label><label>${t('指定文案（可选）')}<textarea id="sales-copy" rows="7" maxlength="4000" placeholder="${t('已有文案可直接粘贴，编导按原文安排画面')}">${esc(s.form.copy)}</textarea></label></div>
  <div id="sales-status" role="status" aria-live="polite"></div><p id="sales-error" role="alert"></p><div class="sales-actions">${button('script','生成人设脚本',true,true)}<small id="sales-usage"></small></div></section>
  <section class="sales-card"><h2>02 · ${t('编导脚本')}</h2><div id="sales-script" class="sales-script"></div><div class="sales-actions">${button('generate','生成视频',true,true)}<small id="sales-quote"></small></div><h2>03 · ${t('视频成品')}</h2><div id="sales-result"></div></section></div>
  <section class="sales-card sales-history"><h2>${t('我的人设视频')}</h2><div id="sales-history"></div></section></div>`;
  for (const field of ['name','goal','copy']) s.root.querySelector('#sales-'+field).oninput = e => { s.form[field]=e.target.value; s.scriptRequest=null; save(s); update(s); };
  s.root.querySelectorAll('input[type=file]').forEach(input => { input.onchange = () => { const files=[...input.files];input.value='';void action(s,()=>upload(s,files,input.dataset.role)); }; });
  s.root.onclick = e => { const b=e.target.closest('[data-sales]'); if(!b || b.disabled)return; e.preventDefault();void action(s,()=>handle(s,b.dataset.sales,b)); };
  update(s);
}
function setHtml(root, selector, html) { const node=root.querySelector(selector);if(node && node.innerHTML!==html)node.innerHTML=html; }
function update(s) {
  if(current!==s)return;
  const op=latest(s), task=latestTask(s), busy=active(s), missing=needed(s), script=op?.status==='completed' && op.result?.script;
  const unchanged=script && op.message===message(s);
  s.root.querySelectorAll('input[type=file],[data-sales=library]').forEach(n=>n.disabled=materialLocked(s));
  s.root.querySelector('[data-sales=script]').disabled=Boolean(busy || missing.length || !(s.form.name.trim() || s.form.copy.trim()) || s.config?.directorEnabled===false);
  s.root.querySelector('[data-sales=generate]').disabled=Boolean(busy || !unchanged || missing.length || s.config?.generationEnabled===false || s.quote?.affordable===false || task?.scriptId===op?.id && ['completed','uncertain','expired'].includes(task?.status));
  s.root.querySelector('[data-sales=generate]').textContent=t(task?.canRecover?'恢复成片':task?.status==='failed'?'重新生成视频':'生成视频');
  s.root.querySelectorAll('.sales-fields input,.sales-fields textarea').forEach(n=>n.disabled=Boolean(busy));
  s.root.querySelector('[data-sales=new]').disabled=Boolean(s.busy);
  s.root.querySelector('#sales-status').textContent=s.busy || pending(op?.status) ? s.activity || op?.progress || t('正在编导…') : pending(task?.status) ? t('视频生成中，可稍后回来查看') : missing.length ? t('请添加')+'：'+missing.join('、') : script&&!unchanged ? t('文案已修改，请重新编导') : t('素材已就绪');
  s.root.querySelector('#sales-error').textContent=s.error || (op?.status==='failed'?op.error:'') || (task?.status==='failed'?task.error:'') || s.pollError || '';
  const usage=s.session?.operations.reduce((n,o)=>n+(o.billing?.usagePoints ?? o.billing?.chargedPoints ?? 0),0)||0;
  s.root.querySelector('#sales-usage').textContent=t('编导已消耗')+' '+usage+' '+t('积分');
  s.root.querySelector('#sales-quote').textContent=s.quote?t('预计')+' '+s.quote.points+' '+t('积分')+(s.quote.unlimited?' · '+t('无限积分'):''):'';
  setHtml(s.root,'#sales-materials',(s.session?.assets||[]).map(a=>`<figure>${a.expired?`<span>${t('文件已过期')}</span>`:a.type==='audio'?`<audio controls preload="metadata" src="${esc(a.url)}"></audio>`:`<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="${esc(a.name)}"></a>`}<figcaption>${esc(a.name)}${!materialLocked(s)?`<button type="button" data-sales="remove" data-id="${a.id}" aria-label="${esc(t('删除')+' '+a.name)}">×</button>`:''}</figcaption></figure>`).join(''));
  setHtml(s.root,'#sales-script',script?`<h3>${esc(script.title)}</h3>${markdownText(op.result.text||'')}<ol>${script.shots.map(shot=>`<li><strong>${shot.start}–${shot.end}s</strong><p>${esc(shot.visual)}</p><p>${esc(shot.action||'')}</p><blockquote>${esc(shot.voiceover)}</blockquote></li>`).join('')}</ol>${button('copy','复制脚本')}`:op?.result?markdownText([op.result.text,...op.result.questions||[]].join('\n\n')):`<p class="sales-empty">${t('用实拍做案例，展示你的AI创作能力')}</p>`);
  const resultKey=task?.resultUrl||task?.status||'';
  if(s.resultKey!==resultKey){s.resultKey=resultKey;setHtml(s.root,'#sales-result',task?.resultUrl?`<video controls preload="metadata" src="${esc(task.resultUrl)}"></video><a class="secondary" href="${esc(task.resultUrl)}?download=1" download>${t('下载视频')}</a><p>${t('成品保留3天，请及时下载')}</p>`:`<p class="sales-empty">${pending(task?.status)?t('视频生成中，可稍后回来查看'):t('成片会显示在这里')}</p>`);}
  setHtml(s.root,'#sales-history',s.conversations.map(c=>`<button type="button" class="sales-history-row" data-sales="open" data-id="${c.id}" ${s.busy?'disabled':''}><strong>${esc(c.title)}</strong><span>${esc(new Date(c.updatedAt).toLocaleString())}</span></button>`).join('')||`<p>${t('还没有生成记录')}</p>`);
}
async function action(s, work) {
  if(s.busy || current!==s)return;
  s.busy=true;s.error='';update(s);
  try { await work(); } catch(e){s.error=e.message;} finally{s.busy=false;s.activity='';save(s);update(s);}
}
async function ensureSession(s) {
  if(s.session)return s.session.id;
  s.createId ||= crypto.randomUUID();save(s);
  const data=await api('/conversations',post({requestId:s.createId,skill:'ai-sales',settings:SALES_SETTINGS}));
  s.session=data.conversation;s.conversationId=s.session.id;save(s);return s.session.id;
}
async function upload(s, files, purpose) {
  if(materialLocked({...s,busy:false}))throw new Error(t('素材已用于脚本，请新建创作后调整'));
  if(purpose!=='reference' && (files.length>1 || s.session?.assets.some(a=>a.purpose===purpose)))throw new Error(t('请先移除已有的人物或声音再替换'));
  const imageCount=s.session?.assets.filter(a=>a.type==='image').length||0;
  if(purpose!=='voice' && files.length+imageCount>30)throw new Error(t('最多上传30张图片。'));
  for(const f of files) {
    if(purpose==='voice'?!/^audio\/(mpeg|wav|x-wav)$/.test(f.type):!/^image\/(jpeg|png|webp)$/.test(f.type))throw new Error(t('图片支持 JPG、PNG、WebP，音频支持 MP3、WAV。'));
    if(f.size >= (purpose==='voice'?VIDEO_AUDIO_MAX_BYTES+1:VIDEO_IMAGE_MAX_BYTES))throw new Error(purpose==='voice'?t('声音文件不能超过15MB。'):t('单张图片需小于50MB。'));
  }
  const id=await ensureSession(s);
  for(const [i,f] of files.entries()) {
    s.activity=t('正在上传')+` ${i+1}/${files.length}`;update(s);
    const result=await api(`/conversations/${id}/assets/${crypto.randomUUID()}`,{method:'PUT',headers:{'Content-Type':f.type,'X-File-Name':encodeURIComponent(f.name),'X-Asset-Purpose':purpose},body:f});
    s.session=result.conversation;save(s);update(s);
  }
}
async function open(s,id) {
  const {conversation}=await api('/conversations/'+id);
  if(conversation.skill!=='ai-sales')throw new Error(t('请在对应模块打开创作'));
  s.session=conversation;s.conversationId=id;s.createId=null;s.scriptRequest=null;s.videoRequest=null;s.resultKey=null;
  const op=latest(s);if(op) {
    const source=op.message;
    s.form={name:source.match(/^产品或门店：(.*)$/m)?.[1]||'',goal:source.match(/卖点与要求：([\s\S]*?)(?=\n\n以下是用户定稿|\n\n请(?:根据实拍|为义鹏)|$)/)?.[1]||'',copy:source.match(/以下是用户定稿台词，按原文编排，保留全文，不重写、不删句：\n([\s\S]*?)(?=\n\n请(?:根据实拍|为义鹏)|$)/)?.[1]||''};
  }
  save(s);if(current===s)shell(s);
}
async function handle(s, actionName, b) {
  if(actionName==='new') {s.session=null;s.conversationId=null;s.createId=null;s.scriptRequest=null;s.videoRequest=null;s.form={name:'',goal:'',copy:''};s.resultKey=null;shell(s);await loadPreset(s);}
  else if(actionName==='open')await open(s,b.dataset.id);
  else if(actionName==='remove')s.session=(await api(`/conversations/${s.session.id}/assets/${b.dataset.id}`,{method:'DELETE'})).conversation;
  else if(actionName==='copy')await navigator.clipboard.writeText(latest(s).result.script.videoPrompt);
  else if(actionName==='library')await library(s,b.dataset.role);
  else if(actionName==='script') {
    const id=await ensureSession(s),body={settings:SALES_SETTINGS,message:message(s),fixedNarration:s.form.copy,expectedScriptId:s.session.operations.findLast(o=>o.status==='completed')?.id||null};
    if(!s.scriptRequest || s.scriptRequest.fingerprint!==JSON.stringify(body))s.scriptRequest={fingerprint:JSON.stringify(body),requestId:crypto.randomUUID()};save(s);
    const {operation}=await api(`/conversations/${id}/script`,post({...body,requestId:s.scriptRequest.requestId}));
    s.session.operations=[...s.session.operations.filter(o=>o.id!==operation.id),operation];s.videoRequest=null;
  } else if(actionName==='generate') {
    if(latestTask(s)?.canRecover) {const {task}=await api(`/tasks/${latestTask(s).id}/recover`,post({}));s.session.tasks=s.session.tasks.map(x=>x.id===task.id?task:x);return;}
    const op=latest(s),script=op.result.script;
    if(latestTask(s)?.status==='failed')s.videoRequest=null;
    s.videoRequest ||= {requestId:crypto.randomUUID(),scriptId:op.id};save(s);
    const {task}=await api(`/conversations/${s.session.id}/generate`,post({...s.videoRequest,settings:SALES_SETTINGS,prompt:script.videoPrompt,referenceImageIds:script.referenceImageIds}));
    s.session.tasks=[...s.session.tasks.filter(x=>x.id!==task.id),task];
  }
}
async function library(s, purpose) {
  const response=await fetch('/api/assets/materials',{credentials:'same-origin'});
  if(!response.ok)throw new Error(t('素材库暂时无法加载'));
  const data=await response.json(),assets=(data.materials||[]).filter(a=>a.type===(purpose==='voice'?'audio':'image') && a.url?.startsWith('/api/') && !a.expired);
  s.ctx.openModal(t('从资产库选择'),'',`<div class="sales-library">${assets.map(a=>`<button type="button" data-sales-asset="${esc(a.id)}">${purpose==='voice'?'♪':`<img src="${esc(a.url)}" alt="">`}<span>${esc(a.name)}</span></button>`).join('')||t('暂无可用素材，请上传')}</div>`,true);
  document.querySelectorAll('[data-sales-asset]').forEach(b=>b.onclick=()=>{const a=assets.find(a=>a.id===b.dataset.salesAsset);document.querySelector('#modal').close();void action(s,async()=>{const r=await fetch(a.url,{credentials:'same-origin'});if(!r.ok)throw new Error(t('素材下载失败'));const blob=await r.blob();await upload(s,[new File([blob],a.name,{type:blob.type})],purpose);});});
}
async function poll(s) {
  if(current!==s || s.polling || s.busy)return;s.polling=true;
  const id=s.conversationId;
  try {
    const [history,session]=await Promise.all([api('/conversations?module=ai-sales'),id?api('/conversations/'+id):Promise.resolve(null)]);
    if(current!==s || id!==s.conversationId || s.busy)return;
    s.pollError='';
    s.conversations=history.conversations;
    if(session){const before=JSON.stringify(s.session?.operations.map(o=>o.billing));s.session=session.conversation;if(before!==JSON.stringify(s.session.operations.map(o=>o.billing)))void refreshWorkspaceCredits();}
    update(s);
  }catch(e){if(current===s && id===s.conversationId && !s.busy){s.pollError=e.message;update(s);}}finally{s.polling=false;}
}
export function mountAiSales(root, ctx) {
  if(!canUseAiSales(globalThis.workspaceUser)){root.textContent=t('此账号暂未开放AI带货。');return;}
  if(current?.root===root && root.querySelector('.sales-shell'))return;
  disposeAiSales();const owner=globalThis.workspaceUser.id;let saved={};try{saved=JSON.parse(localStorage.getItem(key(owner))||'{}');}catch{}
  const s=current={root,ctx,owner,form:{name:'',goal:'',copy:'',...saved.form},conversationId:saved.conversationId,createId:saved.createId,scriptRequest:saved.scriptRequest,videoRequest:saved.videoRequest,session:null,conversations:[],resultKey:null,busy:false,error:''};
  shell(s);
  void action(s,async()=>{[s.config,s.quote]=await Promise.all([api('/config'),api('/quote',post({settings:SALES_SETTINGS}))]);if(s.conversationId)s.session=(await api('/conversations/'+s.conversationId)).conversation;else await loadPreset(s);});
  s.timer=setInterval(()=>void poll(s),4000);
  s.language=()=>{if(current===s)shell(s);};window.addEventListener('workspace:languagechange',s.language);
}
export function disposeAiSales() {if(!current)return;save(current);clearInterval(current.timer);window.removeEventListener('workspace:languagechange',current.language);current.root.onclick=null;current=null;}

async function loadPreset(s) {
  const {assets}=await api('/sales-preset');
  for(const asset of assets) {
    if(current!==s)return;
    const response=await fetch(asset.url,{credentials:'same-origin'});
    if(!response.ok)throw new Error(t('默认人物或声音暂不可用，请自行上传。'));
    await upload(s,[new File([await response.blob()],asset.name,{type:asset.mime})],asset.purpose);
  }
}
