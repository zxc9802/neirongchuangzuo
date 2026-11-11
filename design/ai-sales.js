import { mapConcurrent } from './async-pool.js';
import { setSalesHtml as setHtml, renderSalesMaterials } from './ai-sales-render.js';
import { canUseAiSales, SALES_SETTINGS } from './ai-sales-policy.js';
import { VIDEO_IMAGE_MAX_BYTES, VIDEO_AUDIO_MAX_BYTES, VIDEO_DIRECTORS, DEFAULT_VIDEO_DIRECTOR } from './video-catalog.js';
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
  try { localStorage.setItem(key(s.owner), JSON.stringify({ form:s.form, directorMode:s.directorMode, directPrompt:s.directPrompt, conversationId:s.conversationId, createId:s.createId, scriptRequest:s.scriptRequest, videoRequest:s.videoRequest })); }
  catch { s.ctx.toast(t('草稿未保存，请保留当前页面')); }
}
const latest = s => s.session?.operations.at(-1);
const latestTask = s => s.session?.tasks.at(-1);
const active = s => s.busy || s.session?.operations.some(o => pending(o.status)) || s.session?.tasks.some(o => pending(o.status));
const materialLocked = s => active(s) || Boolean(s.session?.operations.some(o=>o.status!=='failed') || s.session?.tasks.length);
function needed(s) {
  const assets = s.session?.assets || [];
  return [['character','出镜人物照'],['voice','参考声音'],['reference','产品与场景']].filter(([role]) => !assets.some(a => a.purpose === role && !a.expired)).map(([,name]) => t(name));
}
function message() {
  return '根据上传的实拍自动判断行业并创作文案，无需用户提供行业、店名或文案。为义鹏创作“用AI挑战不同行业宣传片”的社媒视频，推广他的AI创作能力。开场人物融入实拍场景提出挑战，中段展示行业广告作品，结尾回到创作者邀请关注或出题。全片口播、字幕、标题与生成画面都不出现具体店名、商场名、品牌标识或地址；招牌、菜单、杯盘等可辨店名应通过取景避开或自然去字处理，不替换为虚构店名。保留真实产品与空间特点，不把义鹏写成店老板或真实探店顾客。';
}
function directPrompt(s) {
  return s.directPrompt ?? `${message()}\n\n请直接生成30秒、9:16竖屏、有中文口播的视频。围绕这些真实素材自由发挥创意，以吸引观看、展示产品卖点和自然转化为目标，自主设计镜头、动作、节奏和转场，不虚构价格、效果或口碑。保持出镜人物身份及产品外形一致，人物照背景不作为产品场景。\n${(s.session?.assets || []).filter(a=>a.type==='image').map((a,i)=>`图片${i+1}：${a.purpose==='character'?'出镜人物形象参考，开场和结尾出镜':'真实产品与场景参考，保留其可见特征'}`).join('\n')}\n声音参考1仅用于音色参考，不复述参考音频中的台词。`;
}

function button(action, label, disabled = false, primary = false) {
  return `<button type="button" data-sales="${action}" class="${primary?'primary':'secondary'}" ${disabled?'disabled':''}>${esc(t(label))}</button>`;
}
function shell(s) {
  s.root.innerHTML = `<div class="sales-shell"><header class="sales-heading"><div><h1>${t('AI带货')}</h1><p>${t('用作品展示你的AI创作能力')}</p></div><span>30s · 480p · 9:16</span>${button('new','新建创作')}</header>
  <div class="sales-layout"><section class="sales-card"><h2>01 · ${t('素材')}</h2><div class="sales-uploads">${[['character','出镜人物照'],['voice','参考声音'],['reference','产品与场景']].map(([role,label])=>`<div data-sales-drop="${role}"><strong>${t(label)}</strong><label class="sales-upload"><span>${t(role==='reference'?'拖入多张图片或点击上传':role==='voice'?'拖入声音或点击上传':'拖入人物照或点击上传')}</span><input type="file" data-role="${role}" aria-label="${t(label)}" accept="${role==='voice'?'audio/mpeg,audio/wav,.mp3,.wav':'image/jpeg,image/png,image/webp'}" ${role==='reference'?'multiple':''}></label><small class="sales-upload-hint">${t(role==='reference'?'JPG / PNG / WebP · 图片合计最多30张':role==='voice'?'MP3 / WAV · 1个声音':'JPG / PNG / WebP · 1张人物照')}</small><button type="button" class="textbutton" data-sales="library" data-role="${role}">${t('从资产库选择')}</button></div>`).join('')}</div><div id="sales-materials" class="sales-materials"></div>

  <div class="sales-directors" role="group" aria-label="${t('编导方式')}">${[...VIDEO_DIRECTORS,{id:'direct',name:'直接生成'}].map(m=>`<button type="button" class="secondary" data-director="${m.id}" title="${esc(m.model || t('不使用编排模型'))}">${esc(t(m.name))}</button>`).join('')}</div><p id="sales-mode-hint" class="sales-mode-hint"></p>
  <div id="sales-status" role="status" aria-live="polite"></div><p id="sales-error" role="alert"></p><div class="sales-actions">${button('script','生成人设脚本',true,true)}<small id="sales-usage"></small></div></section>
  <section class="sales-card"><h2 id="sales-script-heading">02 · ${t('编导脚本')}</h2><div class="sales-fields sales-direct" hidden><label for="sales-direct-prompt">${t('视频生成要求')}</label><textarea id="sales-direct-prompt" rows="12" maxlength="12000"></textarea></div><div id="sales-script" class="sales-script"></div><div class="sales-actions">${button('generate','生成视频',true,true)}<small id="sales-quote"></small></div><h2>03 · ${t('视频成品')}</h2><div id="sales-result"></div></section></div>
  <section class="sales-card sales-history"><h2>${t('我的人设视频')}</h2><div id="sales-history"></div></section></div>`;
  s.root.querySelectorAll('input[type=file]').forEach(input => { input.onchange = () => { const files=[...input.files];input.value='';void action(s,()=>upload(s,files,input.dataset.role)); }; });
  s.root.querySelector('#sales-direct-prompt').oninput = e => {s.directPrompt=e.target.value;save(s);update(s);};
  s.root.onclick = e => {
    const mode=e.target.closest('[data-director]');
    if(mode && !mode.disabled){s.directorMode=mode.dataset.director;s.error='';save(s);update(s);return;}
    const b=e.target.closest('[data-sales]'); if(!b || b.disabled)return; e.preventDefault();void action(s,()=>handle(s,b.dataset.sales,b));
  };
  const clearDrag = () => s.root.querySelectorAll('.is-dragover').forEach(n=>n.classList.remove('is-dragover'));
  s.root.ondragenter = s.root.ondragover = e => {
    if(!Array.from(e.dataTransfer?.types || []).includes('Files'))return;
    e.preventDefault();clearDrag();
    const zone=e.target.closest('[data-sales-drop]');
    const allowed=zone && !materialLocked(s);
    e.dataTransfer.dropEffect=allowed?'copy':'none';
    if(allowed)zone.classList.add('is-dragover');
  };
  s.root.ondragleave = e => {
    const zone=e.target.closest('[data-sales-drop]');
    if(!zone?.contains(e.relatedTarget))clearDrag();
  };
  s.root.ondrop = e => {
    const files=Array.from(e.dataTransfer?.files || []);
    if(!files.length && !Array.from(e.dataTransfer?.types || []).includes('Files'))return;
    e.preventDefault();clearDrag();
    const zone=e.target.closest('[data-sales-drop]');
    if(zone && files.length && !materialLocked(s))void action(s,()=>upload(s,files,zone.dataset.salesDrop));
  };
  update(s);
}
function update(s) {
  if(current!==s)return;
  const op=latest(s), task=latestTask(s), busy=active(s), missing=needed(s), result=op?.result || op?.draftResult, script=result?.script;
  const direct=s.directorMode==='direct', prompt=directPrompt(s);
  const unchanged=op?.status==='completed' && script && op.message===message(s);
  const sameVideo=direct ? task?.directGeneration && task.prompt===prompt.trim() : task?.scriptId===op?.id;
  s.root.querySelectorAll('[data-director]').forEach(n=>{n.disabled=Boolean(busy);n.setAttribute('aria-pressed',String(n.dataset.director===s.directorMode));});
  s.root.querySelector('#sales-mode-hint').textContent=t(direct?'直接把素材与生成要求交给视频模型，不使用编排模型。':s.directorMode==='kimi'?'Kimi 编导 · 最高思考强度':'Gemini 编导 · 最高思考强度');
  s.root.querySelector('#sales-script-heading').textContent='02 · '+t(direct?'直接生成':'编导脚本');
  s.root.querySelector('.sales-direct').hidden=!direct;
  s.root.querySelector('#sales-script').hidden=direct;
  const promptInput=s.root.querySelector('#sales-direct-prompt');if(promptInput.value!==prompt)promptInput.value=prompt;
  s.root.querySelectorAll('input[type=file],[data-sales=library]').forEach(n=>n.disabled=materialLocked(s));
  s.root.querySelectorAll('[data-sales-drop]').forEach(n=>{n.setAttribute('aria-disabled',String(Boolean(materialLocked(s))));if(materialLocked(s))n.classList.remove('is-dragover');});
  s.root.querySelector('[data-sales=script]').hidden=direct;
  s.root.querySelector('[data-sales=script]').disabled=Boolean(direct || busy || missing.length || s.config?.directorEnabled===false);
  s.root.querySelector('[data-sales=generate]').disabled=Boolean(busy || (direct?!prompt.trim():!unchanged) || missing.length || s.config?.generationEnabled===false || s.quote?.affordable===false || sameVideo && ['completed','uncertain','expired'].includes(task?.status));
  s.root.querySelector('[data-sales=generate]').textContent=t(task?.canRecover?'恢复成片':task?.status==='failed'?'重新生成视频':'生成视频');
  s.root.querySelectorAll('.sales-fields input,.sales-fields textarea').forEach(n=>n.disabled=Boolean(busy));
  s.root.querySelector('[data-sales=new]').disabled=Boolean(s.busy);
  s.root.querySelector('#sales-status').textContent=s.busy || pending(op?.status) ? s.activity || op?.progress || t(direct?'正在提交…':'正在编导…') : pending(task?.status) ? t('视频生成中，可稍后回来查看') : missing.length ? t('请添加')+'：'+missing.join('、') : direct ? t('素材已就绪，可直接生成视频') : op?.draftResult ? t('待审核脚本') : script&&!unchanged ? t('文案已修改，请重新编导') : t('素材已就绪');
  s.root.querySelector('#sales-error').textContent=s.error || (op?.status==='failed'?op.error:'') || (task?.status==='failed'?task.error:'') || s.pollError || '';
  const usage=s.session?.operations.reduce((n,o)=>n+(o.billing?.usagePoints ?? o.billing?.chargedPoints ?? 0),0)||0;
  s.root.querySelector('#sales-usage').textContent=t('编导已消耗')+' '+usage+' '+t('积分');
  s.root.querySelector('#sales-quote').textContent=s.quote?t('预计')+' '+s.quote.points+' '+t('积分')+(s.quote.unlimited?' · '+t('无限积分'):''):'';
  renderSalesMaterials(s.root.querySelector('#sales-materials'), s.session?.assets || [], { locked:materialLocked(s), expiredLabel:t('文件已过期'), deleteLabel:t('删除') });
  setHtml(s.root,'#sales-script',script?`${op.draftResult?`<p>${t('待审核脚本')}</p>`:''}<h3>${esc(script.title)}</h3>${markdownText(result.text||'')}<ol>${script.shots.map(shot=>`<li><strong>${shot.start}–${shot.end}s</strong><p>${esc(shot.visual)}</p><p>${esc(shot.action||'')}</p><blockquote>${esc(shot.voiceover)}</blockquote></li>`).join('')}</ol>${button('copy','复制脚本')}`:op?.result?markdownText([op.result.text,...op.result.questions||[]].join('\n\n')):`<p class="sales-empty">${t('用实拍做案例，展示你的AI创作能力')}</p>`);
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
  if(!files.length)return;
  if(materialLocked({...s,busy:false}))throw new Error(t('素材已用于脚本，请新建创作后调整'));
  if(purpose!=='reference' && files.length>1)throw new Error(t('人物照和参考声音各支持1个文件；多张产品图片请拖入“产品与场景”。'));
  if(purpose!=='reference' && s.session?.assets.some(a=>a.purpose===purpose))throw new Error(t('请先移除已有的人物或声音再替换'));
  const imageCount=s.session?.assets.filter(a=>a.type==='image').length||0;
  if(purpose!=='voice' && files.length+imageCount>30)throw new Error(t('最多上传30张图片。'));
  for(const f of files) {
    if(purpose==='voice'?!/^audio\/(mpeg|wav|x-wav)$/.test(f.type):!/^image\/(jpeg|png|webp)$/.test(f.type))throw new Error(t('图片支持 JPG、PNG、WebP，音频支持 MP3、WAV。'));
    if(f.size >= (purpose==='voice'?VIDEO_AUDIO_MAX_BYTES+1:VIDEO_IMAGE_MAX_BYTES))throw new Error(purpose==='voice'?t('声音文件不能超过15MB。'):t('单张图片需小于50MB。'));
  }
  const id=await ensureSession(s);
  let completed = 0;
  await mapConcurrent(files, 3, async f => {
    s.activity=t('正在上传')+` ${completed}/${files.length}`;update(s);
    const result=await api(`/conversations/${id}/assets/${crypto.randomUUID()}`,{method:'PUT',headers:{'Content-Type':f.type,'X-File-Name':encodeURIComponent(f.name),'X-Asset-Purpose':purpose},body:f});
    if(current!==s)return;
    completed++;
    if((result.conversation.version||0)>=(s.session?.version||0))s.session=result.conversation;
    s.activity=t('正在上传')+` ${completed}/${files.length}`;save(s);update(s);
  });
}
async function open(s,id) {
  const {conversation}=await api('/conversations/'+id);
  if(conversation.skill!=='ai-sales')throw new Error(t('请在对应模块打开创作'));
  s.session=conversation;s.conversationId=id;s.createId=null;s.scriptRequest=null;s.videoRequest=null;s.resultKey=null;
  const task=latestTask(s);
  s.directorMode=task?.directGeneration ? 'direct' : latest(s)?.directorModel || DEFAULT_VIDEO_DIRECTOR;
  s.directPrompt=task?.directGeneration ? task.prompt : undefined;
  const op=latest(s);if(op) {
    const source=op.message;
    s.form={name:source.match(/^产品或门店：(.*)$/m)?.[1]||'',goal:source.match(/卖点与要求：([\s\S]*?)(?=\n\n以下是用户定稿|\n\n请(?:根据实拍|为义鹏)|$)/)?.[1]||'',copy:source.match(/以下是用户定稿台词，按原文编排，保留全文，不重写、不删句：\n([\s\S]*?)(?=\n\n请(?:根据实拍|为义鹏)|$)/)?.[1]||''};
  }
  save(s);if(current===s)shell(s);
}
async function handle(s, actionName, b) {
  if(actionName==='new') {s.session=null;s.conversationId=null;s.createId=null;s.scriptRequest=null;s.videoRequest=null;s.directPrompt=undefined;s.form={name:'',goal:'',copy:''};s.resultKey=null;shell(s);await loadPreset(s);}
  else if(actionName==='open')await open(s,b.dataset.id);
  else if(actionName==='remove')s.session=(await api(`/conversations/${s.session.id}/assets/${b.dataset.id}`,{method:'DELETE'})).conversation;
  else if(actionName==='copy')await navigator.clipboard.writeText((latest(s).result || latest(s).draftResult).script.videoPrompt);
  else if(actionName==='library')await library(s,b.dataset.role);
  else if(actionName==='script') {
    const id=await ensureSession(s),body={settings:SALES_SETTINGS,directorModel:s.directorMode,message:message(s),expectedScriptId:s.session.operations.findLast(o=>o.status==='completed')?.id||null};
    if(s.session.operations.some(o=>o.id===s.scriptRequest?.requestId && o.status==='failed'))s.scriptRequest=null;
    if(!s.scriptRequest || s.scriptRequest.fingerprint!==JSON.stringify(body))s.scriptRequest={fingerprint:JSON.stringify(body),requestId:crypto.randomUUID()};save(s);
    const {operation}=await api(`/conversations/${id}/script`,post({...body,requestId:s.scriptRequest.requestId}));
    s.session.operations=[...s.session.operations.filter(o=>o.id!==operation.id),operation];s.videoRequest=null;
  } else if(actionName==='generate') {
    if(latestTask(s)?.canRecover) {const {task}=await api(`/tasks/${latestTask(s).id}/recover`,post({}));s.session.tasks=s.session.tasks.map(x=>x.id===task.id?task:x);return;}
    const op=latest(s),script=op?.result?.script;
    const body=s.directorMode==='direct'
      ? {settings:SALES_SETTINGS,directGeneration:true,prompt:directPrompt(s),referenceImageIds:s.session.assets.filter(a=>a.type==='image').map(a=>a.id)}
      : {settings:SALES_SETTINGS,scriptId:op.id,prompt:script.videoPrompt,referenceImageIds:script.referenceImageIds};
    if(latestTask(s)?.status==='failed')s.videoRequest=null;
    if(!s.videoRequest || s.videoRequest.fingerprint!==JSON.stringify(body))s.videoRequest={requestId:crypto.randomUUID(),fingerprint:JSON.stringify(body)};save(s);
    const {task}=await api(`/conversations/${s.session.id}/generate`,post({...body,requestId:s.videoRequest.requestId}));
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
  const s=current={root,ctx,owner,form:{name:'',goal:'',copy:'',...saved.form},directorMode:[...VIDEO_DIRECTORS.map(m=>m.id),'direct'].includes(saved.directorMode)?saved.directorMode:DEFAULT_VIDEO_DIRECTOR,directPrompt:saved.directPrompt,conversationId:saved.conversationId,createId:saved.createId,scriptRequest:saved.scriptRequest,videoRequest:saved.videoRequest,session:null,conversations:[],resultKey:null,busy:false,error:''};
  shell(s);
  void action(s,async()=>{[s.config,s.quote]=await Promise.all([api('/config'),api('/quote',post({settings:SALES_SETTINGS}))]);if(s.conversationId)s.session=(await api('/conversations/'+s.conversationId)).conversation;else await loadPreset(s);});
  s.timer=setInterval(()=>void poll(s),4000);
  s.language=()=>{if(current===s)shell(s);};window.addEventListener('workspace:languagechange',s.language);
}
export function disposeAiSales() {if(!current)return;save(current);clearInterval(current.timer);window.removeEventListener('workspace:languagechange',current.language);for(const event of ['onclick','ondragenter','ondragover','ondragleave','ondrop'])current.root[event]=null;current=null;}

async function loadPreset(s) {
  const {assets}=await api('/sales-preset');
  for(const asset of assets) {
    if(current!==s)return;
    const response=await fetch(asset.url,{credentials:'same-origin'});
    if(!response.ok)throw new Error(t('默认人物或声音暂不可用，请自行上传。'));
    await upload(s,[new File([await response.blob()],asset.name,{type:asset.mime})],asset.purpose);
  }
}
