import {renderHomeView,bindHomeView,handleHomeAction} from './home.js';
import {renderGeneratedAssets,bindGeneratedAssets,disposeGeneratedAssets,handleGeneratedAssetsAction} from './generated-assets.js';
import {renderStudio,bindStudio,handleStudioAction} from './studios.js';
import {renderWorkbench,bindWorkbench,handleWorkbenchAction} from './workbench.js';
import {disposeImageGeneration} from './image-generation.js';
import {renderAgentChat,bindAgentChat,handleAgentChatAction} from './agent-chat.js';
import {renderDigitalHuman,bindDigitalHuman,handleDigitalHumanAction,disposeDigitalHuman} from './digital-human.js';
import {openBusinessFlow,renderBusinessEntry,getBusinessBrief,handleBusinessAction,updateBusinessProfile,renderContentPlanPreview} from './business-flow.js';
import {selectImagePreset,handleImagePresetAction} from './image-preset-ui.js';
import {INDUSTRIES,createBrief,PURPOSES} from './business-catalog.js';
const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
 agent:'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2z M7 9h10 M7 13h6',
 image:'M4 4h16v16H4z M4 15l5-5 5 5 3-3 3 3 M15 8h.01',
 video:'M3 6h12v12H3z M15 10l6-3v10l-6-3',
 mix:'M4 4l16 16 M4 20L20 4 M7 7a3 3 0 1 0-6 0 3 3 0 0 0 6 0 M7 17a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
 avatar:'M16 7a4 4 0 1 0-8 0 4 4 0 0 0 8 0 M4 21v-3a8 6 0 0 1 16 0v3',
 home:'M3 10l9-7 9 7v11h-6v-7H9v7H3z',
 folder:'M3 6h7l2 3h9v11H3z',
 plus:'M12 5v14 M5 12h14',
 arrow:'M5 12h14 M13 6l6 6-6 6',
 settings:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
 star:'M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
 help:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M9 8a3 3 0 1 1 5 2l-2 2v2 M12 17v.1',
 save:'M4 3h13l3 3v15H4z M8 3v6h8V3 M8 21v-8h8v8',
 expand:'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5',
 audio:'M9 18V5l11-2v12 M9 5v4l11-2 M9 18a3 2 0 1 1-6 0 3 2 0 0 1 6 0 M20 15a3 2 0 1 1-6 0 3 2 0 0 1 6 0',
 store:'M3 10v11h18V10 M2 10l3-7h14l3 7 M2 10q3 5 6 0q4 5 8 0q3 5 6 0 M9 21v-7h6v7',
 chevron:'M9 5l7 7-7 7',
 search:'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14 M15 15l6 6',
 list:'M8 5h13 M8 12h13 M8 19h13 M3 5h.1 M3 12h.1 M3 19h.1',
 play:'M8 4l13 8-13 8z',
 clock:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 6v6l4 3',
 refresh:'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 6 M4 12l2 6a7 7 0 0 0 12-1',
 check:'M5 12l5 5L20 6',
 trash:'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
 back:'M19 12H5 M11 6l-6 6 6 6'
};
const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.star}"/></svg>`;
const button = (action, text, cls='', more='') => `<button class="${cls}" data-action="${action}" ${more}>${text}</button>`;
const modules = {
 image: {title:'AI 图片', action:'立即生成图片', type:'image', limit:9, max:1000, hint:'上传门店、产品或工艺照片，描述你想做的宣传图。输入 / 选择场景，输入 @ 查看已选素材。', names:[['活动海报','活动','把优惠、时间和门店信息放进一张图'],['团购套餐图','活动','让套餐内容与到店权益一目了然'],['招牌项目','门店','突出招牌菜、特色服务或主推产品'],['门店氛围','门店','保留真实空间，让环境更有吸引力'],['朋友圈九宫格','日常','用同一套风格展示门店日常'],['图片精修','日常','调整清晰度、曝光与画面细节']]},
 video: {title:'AI 视频', action:'立即生成视频', type:'image', limit:12, max:10000, hint:'描述想宣传什么，或点击「宣传编导」从脚本开始。', names:[['门店发现','同城到店','突出门店特色，给附近的人一个到店理由'],['到店实录','同城到店','用真实体验建立到店信任'],['招牌体验','同城到店','聚焦一道招牌菜或一个特色项目'],['同城团购','活动推广','说清优惠内容，吸引预约与到店'],['开业预热','活动推广','展示新店亮点与开业安排'],['节日活动','活动推广','为节日促销制作一条宣传短片']]},
 mix: {title:'AI 混剪', action:'开始智能混剪', type:'video', limit:30, max:2000, hint:'例如：用店内实拍剪一条 30 秒宣传视频，开头展示门头，结尾带上地址。', names:[['日常混剪','门店日常','门头、环境与服务片段自动组合'],['探店实拍','门店日常','把拍摄的探店过程整理成片'],['活动快剪','活动推广','剪出主题清晰、节奏明快的活动短片'],['招牌合集','门店日常','集中展示门店最有特色的项目'],['批量宣传','活动推广','同一批素材，设计不同的开场和顺序']]},
 avatar: {title:'数字人', action:'生成口播视频', type:'video', limit:1, max:5000, hint:'写下老板要说的话，或选择一个口播主题。店名、价格和活动日期请使用真实信息。', names:[['老板介绍','信任建立','让老板介绍门店与服务理念'],['招牌讲解','信任建立','讲清项目特色与适合的人群'],['活动通知','到店转化','说清活动内容、时间与参与方式'],['到店路线','到店转化','帮助顾客找到门店'],['常见问题','信任建立','回答营业时间、预约与服务问题']]}
};
for(const module of Object.values(modules))for(const purpose of PURPOSES)if(!module.names.some(item=>item[0]===purpose.label))module.names.push([purpose.label,'行业宣传',purpose.description]);
const validPage=page=>page==='home'||page==='agent'||page==='assets'||Object.hasOwn(modules,page);
let mode = validPage(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
const configs = Object.fromEntries(Object.keys(modules).map(k=>[k,{skill:modules[k].names[0][0],prompt:'',files:[],ratio:k==='image'?'3:4':'9:16',quality:k==='image'?'auto':'1080p',duration:'30',format:'PNG',count:'1',voice:'自然讲述',subtitles:true,music:true,director:false,person:'老板本人',background:'门店实景'}]));
let assets = [], queueOpen = window.innerWidth>1140, previewTab = '参考示例', selectedDraft = null, activeClip = 0;
let drafts = load('store-ai-design-drafts', []), storeInfo = load('store-ai-design-profile', {name:'',industry:'餐饮',address:'',feature:'',hours:''});
let skillCategory = '推荐', skillQuery = '', pickerType = 'all', pickerIds = new Set();
let pickerContext = null;
let businessProfileVersion = 0;
let materialIndustry = storeInfo.name ? createBrief(storeInfo).industry : 'all';
const selectedDrafts = {};
const modal = $('#modal');
function load(key,fallback){try{return JSON.parse(localStorage.getItem(key)||'null')||fallback;}catch{return fallback;}}
function persist(){try{localStorage.setItem('store-ai-design-drafts',JSON.stringify(drafts)); localStorage.setItem('store-ai-design-profile',JSON.stringify(storeInfo));return true;}catch{toast('浏览器存储不可用，本次数据只保留在页面中。');return false;}}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('show'),3800);}
function openModal(title,subtitle,content,wide=false){$('#modal-title').textContent=title;$('#modal-subtitle').textContent=subtitle;$('#modal-body').innerHTML=content;modal.classList.toggle('wide',wide);if(!modal.open)modal.showModal();}
$('#close-modal').onclick=()=>modal.close(); modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close();}});
$('#guide-button').onclick=guide;
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
function guide(){openModal('实体生意创作工作台使用帮助','素材、文案、草稿与创作设置',`<div class="prose"><p>先选择行业与宣传用途，填写真实信息，再将文案、镜头顺序和素材清单带入创作。业务内容面向餐饮、美业、零售、健身、工厂与批发供货。</p><dl><dt>Agent 对话</dt><dd>通过 Luna 分析宣传需求与参考图片，连续问答后转入创作</dd><dt>AI 图片</dt><dd>门店原图 → 宣传场景 → 海报或图组</dd><dt>AI 视频</dt><dd>图片与宣传目标 → 脚本分镜 → 新视频</dd><dt>AI 混剪</dt><dd>实拍视频 → 自动选片编排 → 多条宣传片</dd><dt>数字人</dt><dd>老板形象与声音 → 口播文案 → 宣传视频</dd></dl><p><strong>数字人已接入生成后端。</strong>可保存视频形象和声音，填写口播稿、查看任务记录；生成服务配置完成后可制作并下载成片。AI 图片已接入 Image 2.5，可用自己的原图生成并下载作品；AI 视频与混剪生成仍待接入。</p><p>生成图片、数字人成片与配音可在「资产」查看，自生成成功起保留 72 小时，到期清理，请及时下载。上传形象与声音继续保留，待生成的原图只保留在当前页面。草稿、行业宣传方案与商家资料保存在当前浏览器。画布页面与功能已排除。</p></div>`);}
function context(){return {mode,configs,modules,assets,storeInfo,icon,button,esc,queueOpen,previewTab,setPreviewTab:value=>{previewTab=value;},selectedDraft,drafts,navigate,beginCreation,openModal,toast,picker,saveDraft,generate,settings,personModal,scriptModal,refresh:render,businessProfileVersion,materialIndustry,setMaterialIndustry:industry=>{if(industry==='all'||INDUSTRIES.some(item=>item.id===industry))materialIndustry=industry;},selectImagePreset:(id,options)=>selectImagePreset(context(),id,options),openBusinessFlow:options=>openBusinessFlow(context(),options),renderBusinessEntry:target=>renderBusinessEntry(context(),target),renderContentPlanPreview:target=>renderContentPlanPreview(context(),target),getBusinessBrief:()=>getBusinessBrief(storeInfo),importBusinessAssets,media:{owner:'/media/owner-reference.png'}};}
function importBusinessAssets(files,target,selectedCount=0){
 const module=modules[target],ids=[];if(!module)return ids;
 for(const file of [...files]){
  if(file.type.split('/')[0]!==module.type){toast('请选择当前内容所需的'+(module.type==='video'?'视频':'图片')+'素材。');continue;}
  if(file.size>100*1024*1024){toast('单个素材不能超过 100MB。');continue;}
  if(selectedCount+ids.length>=module.limit){toast('已达到当前创作的素材数量上限。');break;}
  if(assets.length>=50){toast('当前页面最多保留 50 个素材。');break;}
  const id=crypto.randomUUID();assets.push({id,name:file.name,type:module.type,file,url:URL.createObjectURL(file)});ids.push(id);
 }
 return ids;
}
function beginCreation(next){if(mode===next)selectedDraft=null;selectedDrafts[next]=null;navigate(next);}
function navigate(next){if(!validPage(next))return;modal.close();pickerContext=null;if(modules[mode])selectedDrafts[mode]=selectedDraft;mode=next;selectedDraft=selectedDrafts[next]||null;previewTab=configs[next]?.contentPlan?'宣传方案':'参考示例';location.hash=next;render();}
window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(validPage(next)&&next!==mode)navigate(next);});
function render(){
 if(mode!=='avatar')disposeDigitalHuman();
 if(mode!=='image')disposeImageGeneration();
 if(mode!=='assets')disposeGeneratedAssets();
 document.body.dataset.page=mode;
 $('#nav').innerHTML=[['home','首页'],['agent','Agent 对话'],...Object.entries(modules).map(([k,v])=>[k,v.title])].map(([k,title])=>`<a href="#${k}" class="navitem ${mode===k?'active':''}" ${mode===k?'aria-current="page"':''}>${icon(k)}<small>${title}</small></a>`).join('')+`<a href="#assets" class="navitem ${mode==='assets'?'active':''}" ${mode==='assets'?'aria-current="page"':''}>${icon('folder')}<small>资产</small></a>`+button('store',icon('store')+'<small>商家资料</small>','navitem');
 const ctx=context(),main=$('#main');
 $('#workbar').innerHTML=`<div class="workbar-breadcrumb"><span>创作工作台</span>${icon('chevron')}<strong>${modules[mode]?.title||(mode==='assets'?'资产':mode==='agent'?'Agent 对话':'首页')}</strong></div><div>${button('prompts',icon('list')+'我的草稿','textbutton')}${button('store',icon('store')+esc(storeInfo.name||'我的商家'),'textbutton')}</div>`;
 if(mode==='assets'){main.className='generated-assets-workspace';main.innerHTML=renderGeneratedAssets(ctx);bindGeneratedAssets(ctx);return;}
 if(mode==='home'){main.className='home';main.innerHTML=renderHomeView(ctx);bindHomeView(ctx);return;}
 if(mode==='agent'){main.className='agent-workspace';main.innerHTML=renderAgentChat(ctx);bindAgentChat(ctx);return;}
 if(mode==='avatar'){main.className='special-workspace avatar-studio';main.innerHTML=renderDigitalHuman(ctx);bindDigitalHuman(ctx);return;}
 if(mode==='mix'){main.className='special-workspace mix-studio';main.innerHTML=renderStudio(mode,ctx);bindStudio(mode,ctx);return;}
 main.className=`workspace ${queueOpen?'queue-expanded':'queue-hidden'}`;
 main.innerHTML=renderWorkbench(ctx);bindWorkbench(ctx);
}
function skills(){skillCategory='推荐';skillQuery='';openModal('你想创作什么？','选择门店宣传场景，自动带入创作方向',`<div class="skill-filters">${['推荐',...new Set(modules[mode].names.map(s=>s[1]))].map(x=>button('skill-category',x,x===skillCategory?'active':'','data-value="'+x+'"')).join('')}</div><div class="search">${icon('search')}<input id="skill-query" type="search" placeholder="搜一搜" aria-label="搜索场景"></div><div id="skill-grid" class="skill-grid"></div><p class="modal-footnote">门店场景配置 · 可以继续补充创作要求</p>`,true);filterSkills();$('#skill-query').oninput=e=>{skillQuery=e.target.value;filterSkills();};}
function filterSkills(){const items=modules[mode].names.filter(s=>(skillCategory==='推荐'||s[1]===skillCategory)&&s.join('').includes(skillQuery));$('#skill-grid').innerHTML=items.map(([name,cat,desc])=>button('select-skill',`<div class="skill-art">${icon(mode)}</div><div><strong>${name}</strong><small>${desc}</small></div>${configs[mode].skill===name?icon('check'):''}`,'skill-option '+(configs[mode].skill===name?'selected':''),'data-value="'+name+'"')).join('')||'<p class="muted">没有匹配的场景</p>';}
function settings(){
 const c=configs[mode],isImage=mode==='image';
 const qualityNames={auto:'自动',low:'快速',medium:'标准',high:'精细'};
 if(isImage&&!Object.hasOwn(qualityNames,c.quality))c.quality='auto';
 if(isImage&&!['16:9','4:3','1:1','3:4','9:16'].includes(c.ratio))c.ratio='3:4';
 const group=(title,field,values,labels={})=>`<fieldset><legend>${title}</legend><div class="radio-grid">${values.map(v=>`<label><input type="radio" name="${field}" value="${v}" ${c[field]===v?'checked':''}><span>${labels[v]||v}</span></label>`).join('')}</div></fieldset>`;
 openModal(isImage?'图片设置':'视频设置',isImage?'每次生成 1 张 PNG 图片；精细画质通常需要更长时间。':'选择适合发布平台的画面规格',`<form id="settings-form">${group('画面比例','ratio',isImage?['16:9','4:3','1:1','3:4','9:16']:['自适应','16:9','4:3','1:1','3:4','9:16'])}${group(isImage?'画质':'分辨率','quality',isImage?Object.keys(qualityNames):['480p','720p','1080p'],isImage?qualityNames:{})}${isImage?'<p class="muted">按发布位置选择比例，实际像素尺寸以生成结果为准。</p>':`<label class="field">目标时长 <span id="duration-label">${c.duration} 秒</span><input name="duration" id="duration-range" type="range" min="10" max="60" step="5" value="${c.duration}"></label>`}<footer class="modal-actions"><button class="primary" type="submit">应用设置</button></footer></form>`);
 $('#duration-range')?.addEventListener('input',e=>$('#duration-label').textContent=e.target.value+' 秒');
 $('#settings-form').onsubmit=e=>{e.preventDefault();for(const[k,v]of new FormData(e.target))c[k]=v;if(isImage)c.format='PNG';modal.close();render();};
}
function picker(type='image',library=false,options={}){
 const owner=mode, allowed=type, max=options.max||(library?50:modules[owner].limit);
 const existing=options.selected||(library?[]:(configs[owner]?.files||[]));
 const preserved=existing.filter(id=>{const a=assets.find(x=>x.id===id);return a&&type!=='all'&&a.type!==type;});
 pickerIds=new Set(existing.filter(id=>{const a=assets.find(x=>x.id===id);return a&&(type==='all'||a.type===type);}));
 pickerType=type;pickerContext={owner,allowed,library,max,preserved,query:'',onConfirm:options.onConfirm};
 const session=pickerContext;
 openModal(library?'我的素材':'添加'+({image:'图片',video:'视频',audio:'声音'}[type]||'素材'),'文件在当前页面内可复用，刷新后请重新选择。',`<div class="asset-toolbar"><div class="picker-tabs">${(type==='all'?['all','image','video','audio']:[type]).map(k=>button('asset-filter',({all:'全部',image:'图片',video:'视频',audio:'声音'})[k],k===type?'active':'',`data-type="${k}"`)).join('')}</div><label class="upload-local">${icon('plus')} 本地上传<input id="file-picker" type="file" multiple accept="${type==='all'?'image/*,video/*,audio/*':type+'/*'}"></label></div><div class="search">${icon('search')}<input id="asset-search" type="search" placeholder="搜索素材名称" aria-label="搜索素材"></div><div id="asset-grid" class="asset-grid"></div><footer class="modal-actions"><span id="selection-count"></span>${button('cancel','取消','secondary')}${button('confirm-assets',library?'完成':'确认选择','primary')}</footer>`,true);
 drawAssets();$('#asset-search').oninput=e=>{if(pickerContext!==session)return;session.query=e.target.value;drawAssets();};
 $('#file-picker').onchange=e=>{if(pickerContext!==session||!modal.open)return;for(const file of [...e.target.files]){const kind=file.type.split('/')[0];if(!['image','video','audio'].includes(kind)||(session.allowed!=='all'&&kind!==session.allowed)){toast('文件类型不符，请按当前入口选择素材。');continue;}if(file.size>100*1024*1024){toast('单个素材不能超过 100MB。');continue;}if(assets.length>=50){toast('当前页面最多保留 50 个素材。');break;}const id=crypto.randomUUID();assets.push({id,name:file.name,type:kind,file,url:URL.createObjectURL(file)});if(pickerIds.size+session.preserved.length<session.max)pickerIds.add(id);}drawAssets();};
}
function drawAssets(){if(!pickerContext)return;const visible=assets.filter(a=>(pickerType==='all'||a.type===pickerType)&&a.name.toLowerCase().includes(pickerContext.query.toLowerCase()));$('#asset-grid').innerHTML=visible.map(a=>button('pick-asset',`<div>${a.type==='image'?`<img src="${a.url}" alt="">`:icon(a.type==='video'?'video':'audio')}${pickerIds.has(a.id)?`<span class="asset-check">${icon('check')}</span>`:''}</div><small>${esc(a.name)}</small>`,'asset-item '+(pickerIds.has(a.id)?'selected':''),`data-id="${a.id}"`)).join('')||`<div class="asset-empty">${icon('folder')}<p>${pickerContext.query?'没有找到匹配素材':'把生意现场的真实素材放进来'}</p><small>门店、车间、产品、服务过程和工艺细节都可以复用</small></div>`;$('#selection-count').textContent=`已选择 ${pickerIds.size}${pickerContext.preserved.length?' · 另保留 '+pickerContext.preserved.length+' 个其他素材':''}`;}
function storeModal(){const industry=createBrief(storeInfo).industry;openModal('商家资料','门店、工厂和企业都可以使用，填一次供各模块复用。',`<form id="store-form" class="profile-form"><label class="field">所属行业<select name="industry">${INDUSTRIES.map(item=>`<option value="${item.id}" ${industry===item.id?'selected':''}>${esc(item.label)}</option>`).join('')}</select></label>${[['name','商家 / 企业名称','填写真实名称'],['address','地址 / 服务区域','用于到店、看样或供货范围说明'],['hours','营业 / 接待时间','填写实际可接待的时间，选填'],['feature','主营产品与特色','介绍服务、产品或加工能力']].map(([k,t,p])=>`<label class="field">${t}<input name="${k}" value="${esc(storeInfo[k])}" placeholder="${p}" maxlength="200"></label>`).join('')}<p class="muted">资料只保存在当前浏览器，每次宣传的价格、活动和交期在创作时填写。</p><footer class="modal-actions"><button class="primary">保存资料</button></footer></form>`);$('#store-form').onsubmit=e=>{e.preventDefault();storeInfo=Object.fromEntries(new FormData(e.target));updateBusinessProfile(storeInfo,toast);businessProfileVersion++;materialIndustry=createBrief(storeInfo).industry;const saved=persist();modal.close();render();if(saved)toast('商家资料已保存在当前浏览器。');};}
function saveDraft(){const c=configs[mode];if(!c)return;const id=selectedDraft||crypto.randomUUID();const record={...structuredClone(c),files:[],mode,id,time:new Date().toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}),hadFiles:c.files.length>0};drafts=drafts.filter(d=>d.id!==id);drafts.unshift(record);drafts=drafts.slice(0,60);selectedDraft=id;selectedDrafts[mode]=id;const saved=persist();render();if(saved)toast('文案和参数已保存；素材文件不随草稿保存。');}
function generate(){const c=configs[mode];if(!c.prompt.trim()&&!c.files.length){toast('先添加素材或填写宣传要求。');return;}if(c.prompt.length>modules[mode].max){toast('创作要求超出字数限制，请缩短后继续。');return;}openModal('生成服务待接入','本次内容还未提交生成',`<div class="generation-notice">${icon(mode)}<h3>先保存这份创作，稍后继续</h3><p>当前版本可编辑素材、文案和参数。接入生成服务后，才能制作和导出作品。</p><div class="generation-summary"><strong>${esc(c.skill)}</strong><span>${esc(c.ratio)} · ${esc(c.quality)}</span></div></div><footer class="modal-actions">${button('cancel','继续编辑','secondary')}${button('save-close','保存草稿','primary')}</footer>`);}
function personModal(){const c=configs.avatar;openModal('形象与背景','选择出镜身份和画面背景',`<form id="person-form"><fieldset><legend>使用谁来讲？</legend><div class="radio-grid">${['老板本人','店员形象','授权主持人'].map(x=>`<label><input type="radio" name="person" value="${x}" ${c.person===x?'checked':''}><span>${x}</span></label>`).join('')}</div></fieldset><fieldset><legend>画面背景</legend><div class="radio-grid">${['门店实景','简洁背景','形象原背景'].map(x=>`<label><input type="radio" name="background" value="${x}" ${c.background===x?'checked':''}><span>${x}</span></label>`).join('')}</div></fieldset><p class="muted">自有形象和声音将作为可复用资产。上传照片在设计稿中仅用于构图参考。</p><footer class="modal-actions"><button class="primary">确认设置</button></footer></form>`);$('#person-form').onsubmit=e=>{e.preventDefault();Object.assign(c,Object.fromEntries(new FormData(e.target)));modal.close();render();};}
function scriptModal(){openModal('口播文案模板','按门店资料填入的文案模板，可继续调整',`<div class="prose"><p>大家好，我是${esc(storeInfo.name||'【门店名称】')}的老板。</p><p>我们最想让你体验的是${esc(storeInfo.feature||'【招牌项目与特色】')}。</p><p>门店在${esc(storeInfo.address||'【门店地址】')}，欢迎你有空来坐坐。</p></div><footer class="modal-actions">${button('use-script','填入口播稿','primary')}</footer>`);}
function handle(action,el){const ctx=context();if(handleGeneratedAssetsAction(action,el,ctx)||handleImagePresetAction(action,el,ctx)||handleBusinessAction(action,el,ctx)||handleDigitalHumanAction(action,el,ctx)||handleAgentChatAction(action,el,ctx)||handleHomeAction(action,el,ctx)||handleWorkbenchAction(action,el,ctx)||handleStudioAction(action,el,ctx))return;const c=configs[mode];switch(action){
 case 'skills':skills();break;
 case 'skill-category':skillCategory=el.dataset.value;document.querySelectorAll('.skill-filters button').forEach(b=>b.classList.toggle('active',b===el));filterSkills();break;
 case 'select-skill':delete c.imagePreset;c.skill=el.dataset.value;modal.close();render();break;
 case 'settings':settings();break;
 case 'quality':if(mode==='image'){openModal('Image 2.5 图片生成','已连接所选绘图模型',`<div class="prose"><p>上传自己的原图，描述希望调整的内容。每次生成一张图片，作品保存在本地服务端，可以刷新后查看或下载。</p><p>生成时间与费用由模型供应商决定。调整画质和比例可使用图片设置。</p></div>`);break;}openModal('生成与剪辑方案','模型供应商和正式费用待接入后确定。',`<div class="prose"><h3>${mode==='mix'?'自然纪实':'系统推荐'}</h3><p>${mode==='mix'?'优先使用真实素材与自然转场，保留门店环境和服务过程。':'系统根据宣传场景匹配模型，让老板不用先研究复杂参数。正式版保留高级模型切换。'}</p><p>比例、分辨率与时长可以在旁边的设置中调整。</p></div>`);break;
 case 'upload':picker(modules[mode].type);break;
 case 'audio':picker('audio');break;
 case 'assets':navigate('assets');break;
 case 'pick-asset':if(!pickerContext)return;if(pickerIds.has(el.dataset.id))pickerIds.delete(el.dataset.id);else if(pickerIds.size+pickerContext.preserved.length<pickerContext.max)pickerIds.add(el.dataset.id);else toast('已达到当前素材数量上限。');drawAssets();break;
 case 'asset-filter':pickerType=el.dataset.type;document.querySelectorAll('.picker-tabs button').forEach(b=>b.classList.toggle('active',b===el));drawAssets();break;
 case 'confirm-assets':if(!pickerContext)return;if(!pickerContext.library&&configs[pickerContext.owner])configs[pickerContext.owner].files=[...pickerContext.preserved,...pickerIds];pickerContext.onConfirm?.([...pickerIds]);pickerContext=null;modal.close();render();break;
 case 'remove-file':c.files=c.files.filter(x=>x!==el.dataset.id);render();break;
 case 'store':storeModal();break;
 case 'preview':previewTab=el.dataset.value;render();break;
 case 'queue':queueOpen=!queueOpen;render();break;
 case 'saveprompt':saveDraft();break;
 case 'save-close':saveDraft();modal.close();break;
 case 'prompts':openModal('我的文案草稿','选择草稿恢复文字与参数，素材需要重新选择。',`<div class="saved-prompts">${drafts.filter(d=>mode==='home'||mode==='assets'||d.mode===mode).map(d=>button('restore',`<strong>${esc(d.skill)}</strong><p>${esc(d.prompt||'未填写要求')}</p><small>${esc(d.time)}</small>`,'saved-prompt','data-id="'+d.id+'"')).join('')||'<p class="muted">还没有保存过草稿。</p>'}</div>`);break;
 case 'restore':{const d=drafts.find(x=>x.id===el.dataset.id);if(!d)return;mode=d.mode;location.hash=mode;configs[mode]={...structuredClone(d),files:[]};selectedDraft=d.id;selectedDrafts[mode]=d.id;previewTab='草稿详情';modal.close();render();toast('草稿已恢复。素材文件请重新选择。');break;}
 case 'new':openModal('开始一份新创作','当前未保存的文字和素材选择将清空。已保存草稿不受影响。',`<footer class="modal-actions">${button('cancel','返回','secondary')}${button('reset','新建创作','primary')}</footer>`);break;
 case 'reset':c.prompt='';c.files=[];if(c.imagePreset)c.skill=modules[mode].names[0][0];delete c.imagePreset;delete c.brief;delete c.contentPlan;selectedDraft=null;selectedDrafts[mode]=null;modal.close();render();break;
 case 'expand':openModal('展开编辑','专注整理这次创作的要求',`<textarea id="expanded-prompt" aria-label="完整创作要求" maxlength="${modules[mode].max}">${esc(c.prompt)}</textarea><footer class="modal-actions">${button('apply-prompt','完成编辑','primary')}</footer>`,true);break;
 case 'apply-prompt':c.prompt=$('#expanded-prompt').value;modal.close();render();break;
 case 'references':openModal('引用已选素材','将素材名称填入创作要求',`<div class="saved-prompts">${c.files.map(id=>{const a=assets.find(x=>x.id===id);return a?button('insert-reference',esc(a.name),'saved-prompt','data-name="'+esc(a.name)+'"'):'';}).join('')||'<p class="muted">先选择一张图片或视频，再引用它。</p>'}</div>`);break;
 case 'insert-reference':c.prompt=(c.prompt+' @'+el.dataset.name+' ').slice(0,modules[mode].max);modal.close();render();break;
 case 'director':c.director=!c.director;render();break;
 case 'idea':c.prompt=el.dataset.value+'：'+(storeInfo.feature||'请补充你的门店特色');render();break;
 case 'generate':generate();break;
 case 'person':personModal();break;
 case 'voice':openModal('口播声音','选择这次口播的讲述风格',`<div class="voice-list">${['自然讲述','亲切热情','沉稳专业','活力推荐'].map(x=>button('select-voice',icon('audio')+'<span>'+x+'</span>'+ (c.voice===x?icon('check'):''),'voice-option','data-value="'+x+'"')).join('')}</div>`);break;
 case 'select-voice':c.voice=el.dataset.value;modal.close();render();break;
 case 'script':scriptModal();break;
 case 'use-script':c.prompt=`大家好，我是${storeInfo.name||'【门店名称】'}的老板。\n我们最想让你体验的是${storeInfo.feature||'【招牌项目与特色】'}。\n门店在${storeInfo.address||'【门店地址】'}，欢迎你有空来坐坐。`;modal.close();render();toast('已填入固定模板，请核实并补齐门店信息。');break;
 case 'clip':activeClip=Number(el.dataset.index);previewTab='素材预览';render();break;
 case 'move-up':case 'move-down':{const i=Number(el.dataset.index),j=i+(action==='move-up'?-1:1);if(j>=0&&j<c.files.length){[c.files[i],c.files[j]]=[c.files[j],c.files[i]];activeClip=j;render();}break;}
 case 'home-start':{const k=$('#home-mode').value;configs[k].prompt=$('#home-prompt').value;navigate(k);break;}
 case 'scene':configs[el.dataset.mode].skill=el.dataset.skill;navigate(el.dataset.mode);break;
 case 'cancel':modal.close();break;
}}
document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(el&&!el.disabled)handle(el.dataset.action,el);});
document.addEventListener('change',e=>{if(e.target.id==='mix-count')configs.mix.count=e.target.value;if(e.target.id==='subtitles')configs.mix.subtitles=e.target.checked;if(e.target.id==='music')configs.mix.music=e.target.checked;});
window.addEventListener('beforeunload',()=>assets.forEach(a=>URL.revokeObjectURL(a.url)));
render();
