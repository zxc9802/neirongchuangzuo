import { INDUSTRIES, PLATFORMS, getPurposes, createBrief, normalizeBrief, getBriefFields, validateBrief, buildContentPlan } from './business-catalog.js';

import { accountStorageKey } from './account-storage.js';
const storageKey = accountStorageKey('business-ai-brief-v1');
const modes = ['image', 'video', 'mix', 'avatar'];
let cachedBrief;
let session;

export function getBusinessBrief(profile = {}) {
  if (!cachedBrief) {
    try { cachedBrief = normalizeBrief(JSON.parse(localStorage.getItem(storageKey) || 'null') || createBrief(profile), profile); }
    catch { cachedBrief = createBrief(profile); }
  }
  return { ...cachedBrief };
}

export function updateBusinessProfile(profile, toast = () => {}) {
  const base = getBusinessBrief(profile);
  const fresh = createBrief(profile);
  const sameBusiness = base.industry === fresh.industry && base.businessName === fresh.businessName;
  cachedBrief = normalizeBrief({ ...(sameBusiness ? base : { platform: base.platform }), ...Object.fromEntries(['industry', 'businessName', 'location', 'highlights', 'hours'].map(key => [key, fresh[key]])) });
  try { localStorage.setItem(storageKey, JSON.stringify(cachedBrief)); }
  catch { toast('宣传信息暂时只保留在本次页面中。'); }
}

function remember(ctx) {
  cachedBrief = normalizeBrief(session.brief, ctx.storeInfo);
  try { localStorage.setItem(storageKey, JSON.stringify(cachedBrief)); }
  catch { ctx.toast('宣传信息暂时只保留在本次页面中。'); }
}

function labels(brief) {
  return [INDUSTRIES.find(x => x.id === brief.industry)?.label,
    getPurposes(brief.industry).find(x => x.id === brief.purpose)?.label,
    PLATFORMS.find(x => x.id === brief.platform)?.label].filter(Boolean);
}

export function renderBusinessEntry(ctx, mode) {
  const config = ctx.configs[mode];
  const brief = config?.brief;
  return `<section class="business-entry" aria-label="行业宣传方案"><div><strong>${brief ? ctx.esc(brief.product || brief.businessName) : '宣传信息'}</strong><p>${brief ? ctx.esc(labels(brief).join(' · ')) : ''}</p></div><div class="business-entry-actions">${ctx.button('business-open', brief ? '修改信息' : '整理宣传方案', 'business-link', `data-mode="${mode}"`)}${config?.contentPlan ? ctx.button('business-plan', '查看方案', 'business-link', `data-mode="${mode}"`) : ''}</div></section>`;
}

export function renderContentPlanPreview(ctx, mode) {
  const { esc, button, icon } = ctx;
  const config = ctx.configs[mode];
  const plan = config?.contentPlan;
  if (!plan) return '';
  return `<article class="business-preview"><div class="business-preview-label"><span>${esc(labels(config.brief || {}).join(' · '))}</span><small>创作方案</small></div><h2>${esc(plan.title)}</h2><p class="business-preview-style">${esc(plan.style)}</p><section class="business-preview-caption"><h3>发布文案</h3><p>${esc(plan.caption)}</p></section><section class="business-preview-story"><h3>${mode === 'image' ? '组图顺序' : '镜头顺序'}</h3><ol>${plan.shots.map((shot, index) => `<li><span>${String(index + 1).padStart(2, '0')}</span><strong>${esc(shot.title)}</strong><p>${esc(shot.description)}</p></li>`).join('')}</ol></section><div class="business-preview-footer"><p></p>${button('business-plan', `完整方案与素材清单 ${icon('arrow')}`, 'business-link', `data-mode="${mode}"`)}</div></article>`;
}

export function openBusinessFlow(ctx, options = {}) {
  const mode = modes.includes(options.mode) ? options.mode : (modes.includes(ctx.mode) ? ctx.mode : 'image');
  const brief = normalizeBrief({ ...getBusinessBrief(ctx.storeInfo), ...(options.newBrief ? {} : ctx.configs[mode].brief),
    ...Object.fromEntries(['industry', 'purpose', 'platform'].filter(key => options[key] !== undefined).map(key => [key, options[key]])) }, ctx.storeInfo);
  session = { mode, brief, extraRequest: options.prompt ?? (options.newBrief ? '' : ctx.configs[mode].contentPlan?.extraRequest || ''), files: [...(options.initialFiles ?? ctx.configs[mode].files)], errors: {}, plan: null };
  renderForm(ctx);
}

function optionsHtml(items, selected, esc) {
  return items.map(item => `<option value="${esc(item.id ?? item.value)}" ${(item.id ?? item.value) === selected ? 'selected' : ''}>${esc(item.label)}</option>`).join('');
}

function fieldHtml(field, ctx) {
  const { esc } = ctx;
  const value = session.brief[field.key] ?? '';
  const error = session.errors[field.key];
  const id = `brief-${field.key}`;
  const describedBy = `${id}-hint${error ? ` ${id}-error` : ''}`;
  const attrs = `id="${id}" name="${esc(field.key)}" ${field.required ? 'required' : ''} aria-describedby="${describedBy}" ${error ? 'aria-invalid="true"' : ''}`;
  const max = field.maxLength || 180;
  const input = field.options
    ? `<select ${attrs}>${optionsHtml(field.options, value, esc)}</select>`
    : ['highlights', 'caseDetails', 'selectionTips', 'restrictions', 'includes'].includes(field.key)
      ? `<textarea ${attrs} rows="2" maxlength="${max}" placeholder="${esc(field.placeholder || '')}">${esc(value)}</textarea>`
      : `<input ${attrs} type="text" ${field.type === 'number' || /Amount|Value|price/.test(field.key) ? 'inputmode="decimal"' : ''} maxlength="${max}" value="${esc(value)}" placeholder="${esc(field.placeholder || '')}">`;
  return `<label class="business-field ${['highlights', 'caseDetails', 'selectionTips', 'restrictions', 'includes'].includes(field.key) ? 'business-field-wide' : ''}" for="${id}"><span>${esc(field.label)} <small>${field.required ? '必填' : '选填'}</small></span>${input}<small id="${id}-hint" class="business-field-hint">${esc(field.help || '')}</small><span id="${id}-error" class="business-field-error" ${error ? '' : 'hidden'}>${esc(error || '')}</span></label>`;
}

function selectedAssets(ctx) {
  return session.files.map(id => ctx.assets.find(asset => asset.id === id)).filter(asset => asset && (asset.type === ctx.modules[session.mode].type || (session.mode === 'video' && asset.type === 'audio')));
}

function renderMaterials(ctx) {
  if (session.mode === 'avatar') return `<div class="business-material-note">${ctx.icon('avatar')}<span>使用已授权的形象和声音</span></div>`;
  const assets = selectedAssets(ctx);
  const type = ctx.modules[session.mode].type;
  return `<div class="business-materials"><div><strong>真实素材 <span>${assets.length} / ${ctx.modules[session.mode].limit}</span></strong><p>${session.mode === 'mix' ? '上传门店、车间或产品的实拍视频' : '上传环境、产品、服务或工艺的原图'}</p></div><label class="business-upload">${ctx.icon('plus')} 添加${type === 'video' ? '视频' : '图片'}<input id="brief-upload" type="file" accept="${type}/*" multiple></label>${assets.length ? `<ul>${assets.map(asset => `<li>${ctx.icon(asset.type)}<span>${ctx.esc(asset.name)}</span><button type="button" data-brief-remove="${ctx.esc(asset.id)}" aria-label="移除 ${ctx.esc(asset.name)}">×</button></li>`).join('')}</ul>` : ''}</div>`;
}

function renderForm(ctx) {
  const { esc } = ctx;
  const brief = session.brief;
  ctx.openModal('这次，你想宣传什么？', '', `<form id="business-form" class="business-form" novalidate>

    <div class="business-selects">
      <label class="business-field"><span>我的行业</span><select name="industry" id="brief-industry">${optionsHtml(INDUSTRIES, brief.industry, esc)}</select></label>
      <label class="business-field"><span>宣传用途</span><select name="purpose" id="brief-purpose">${optionsHtml(getPurposes(brief.industry), brief.purpose, esc)}</select></label>
      <label class="business-field"><span>发布平台</span><select name="platform" id="brief-platform">${optionsHtml(PLATFORMS, brief.platform, esc)}</select></label>
      <label class="business-field"><span>制作内容</span><select name="mode" id="brief-mode">${optionsHtml(modes.map(id => ({ id, label: ctx.modules[id].title })), session.mode, esc)}</select></label>
    </div>

    <div class="business-fields">${getBriefFields(brief).map(field => fieldHtml(field, ctx)).join('')}</div>
    <label class="business-field business-extra"><span>还有什么要求？ <small>选填</small></span><textarea name="extraRequest" id="brief-extra" rows="2" maxlength="400" placeholder="例如：语气朴实；保留产品原色；重点展示加工细节。">${esc(session.extraRequest)}</textarea></label>
    ${renderMaterials(ctx)}
    <p class="business-form-message" role="alert" ${Object.keys(session.errors).length ? '' : 'hidden'}>${esc(session.errors._form || (Object.keys(session.errors).length ? '请补充表单中标出的信息，再整理方案。' : ''))}</p>
    <footer class="business-form-footer"><small>宣传信息仅保存在当前浏览器</small><button type="submit" class="primary">整理宣传方案 ${ctx.icon('arrow')}</button></footer>
    </form>`, true);
  bindForm(ctx);
}

function readForm() {
  const form = document.querySelector('#business-form');
  if (!form) return;
  const data = Object.fromEntries(new FormData(form));
  const { extraRequest, mode, ...fields } = data;
  session.brief = normalizeBrief({ ...session.brief, ...fields });
  session.extraRequest = extraRequest || '';
  if (modes.includes(mode)) session.mode = mode;
}

function showFieldError(field, error) {
  const input = document.querySelector(`#brief-${field.key}`);
  const message = document.querySelector(`#brief-${field.key}-error`);
  if (!input || !message) return;
  input.setAttribute('aria-invalid', String(Boolean(error)));
  input.setAttribute('aria-describedby', `brief-${field.key}-hint${error ? ` brief-${field.key}-error` : ''}`);
  message.textContent = error || '';
  message.hidden = !error;
}

function bindForm(ctx) {
  const form = document.querySelector('#business-form');
  form.addEventListener('input', () => { readForm(); remember(ctx); });
  form.addEventListener('change', event => {
    readForm(); remember(ctx);
    if (['industry', 'purpose', 'platform', 'mode', 'promotionKind'].includes(event.target.name)) {
      const focusId = event.target.id;
      session.errors = {};
      renderForm(ctx);
      document.getElementById(focusId)?.focus();
    }
  });
  form.addEventListener('focusout', event => {
    const field = getBriefFields(session.brief).find(item => item.key === event.target.name);
    if (field && !field.options) {
      readForm();
      showFieldError(field, validateBrief(session.brief)[field.key]);
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault(); readForm();
    session.errors = validateBrief(session.brief);
    if (session.extraRequest.length > 400) session.errors._form = '补充要求最多 400 字，请精简后继续；原文已保留。';
    if (session.mode !== 'avatar' && selectedAssets(ctx).length > ctx.modules[session.mode].limit) session.errors._form = `当前素材超出 ${ctx.modules[session.mode].limit} 个的上限，请移除多余素材。`;
    if (Object.keys(session.errors).length) {
      renderForm(ctx);
      document.querySelector('#business-form [aria-invalid="true"]')?.focus();
      return;
    }
    remember(ctx);
    const plan = buildContentPlan(session.brief, session.mode);
    const extra = session.extraRequest.trim();
    session.plan = { ...plan, extraRequest: extra, prompt: plan.prompt + (extra ? `\n补充要求：${extra}` : '') };
    renderPlan(ctx);
  });
  document.querySelector('#brief-upload')?.addEventListener('change', event => {
    readForm();
    session.files.push(...ctx.importBusinessAssets(event.target.files, session.mode, selectedAssets(ctx).length));
    renderForm(ctx);
  });
  form.querySelectorAll('[data-brief-remove]').forEach(button => button.addEventListener('click', () => {
    readForm();
    session.files = session.files.filter(id => id !== button.dataset.briefRemove);
    renderForm(ctx);
  }));
}

function planText(plan) {
  return `${plan.title}\n\n发布文案\n${plan.caption}\n\n口播稿\n${plan.script}\n\n画面风格\n${plan.style}\n\n镜头 / 组图顺序\n${plan.shots.map((shot, i) => `${i + 1}. ${shot.title}：${shot.description}`).join('\n')}\n\n素材清单\n${plan.checklist.map(item => `• ${item}`).join('\n')}\n\n创作要求\n${plan.prompt}`;
}

function renderPlan(ctx, existing = false) {
  const { esc } = ctx;
  const plan = session.plan;
  const finalPrompt = session.mode === 'avatar' ? plan.script : plan.prompt;
  const tooLong = finalPrompt.length > ctx.modules[session.mode].max;
  ctx.openModal('宣传方案已整理好', '', `<section class="business-plan">

    <div class="business-plan-heading"><span>${esc(labels(session.brief).join(' / '))}</span><h3>${esc(plan.title)}</h3><p>${esc(plan.style)}</p></div>
    <div class="business-plan-grid"><section class="business-plan-copy"><h4>${session.mode === 'avatar' ? '口播稿' : '发布文案'}</h4><p>${esc(session.mode === 'avatar' ? plan.script : plan.caption)}</p></section><section class="business-plan-shots"><h4>${session.mode === 'image' ? '组图顺序' : '镜头顺序'}</h4><ol>${plan.shots.map(shot => `<li><strong>${esc(shot.title)}</strong><p>${esc(shot.description)}</p></li>`).join('')}</ol></section></div>
    <section class="business-plan-checklist"><h4>准备这些真实素材</h4><ul>${plan.checklist.map(item => `<li>${ctx.icon('check')}${esc(item)}</li>`).join('')}</ul></section>
    <details class="business-plan-details"><summary>查看完整创作要求</summary><p>${esc(plan.prompt)}</p></details>
    ${tooLong ? '<p class="business-form-message" role="alert">这份方案超出当前模块字数限制，请返回精简宣传信息或补充要求。</p>' : ''}
    <p class="business-plan-note">${session.mode === 'avatar' ? '请选择形象和声音' : session.mode === 'image' ? '请上传原图' : session.mode === 'mix' ? '请选择素材文件夹' : '视频生成服务待接入'}${!existing && ctx.configs[session.mode].prompt ? ' 将替换当前创作要求。' : ''}</p>
    <footer class="business-plan-footer"><div><button type="button" data-plan-action="back" class="secondary">${existing ? '修改信息' : '返回修改'}</button><button type="button" data-plan-action="download" class="business-link">下载方案</button></div><button type="button" data-plan-action="${existing ? 'close' : 'apply'}" class="primary" ${tooLong && !existing ? 'disabled' : ''}>${existing ? '完成' : `用于${esc(ctx.modules[session.mode].title)} ${ctx.icon('arrow')}`}</button></footer>
    </section>`, true);
  document.querySelectorAll('[data-plan-action]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.planAction === 'back') { renderForm(ctx); return; }
    if (button.dataset.planAction === 'close') { document.querySelector('#modal').close(); return; }
    if (button.dataset.planAction === 'download') {
      const url = URL.createObjectURL(new Blob([planText(plan)], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = '宣传方案.txt'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if (button.dataset.planAction === 'apply' && !tooLong) {
      const config = ctx.configs[session.mode];
      config.brief = { ...session.brief };
      config.contentPlan = structuredClone(plan);
      delete config.imagePreset;
      config.prompt = finalPrompt;
      if (session.mode !== 'avatar') config.files = selectedAssets(ctx).map(asset => asset.id);
      config.skill = getPurposes(session.brief.industry).find(item => item.id === session.brief.purpose)?.label || config.skill;
      config.ratio = plan.ratio || config.ratio;
      remember(ctx);
      ctx.beginCreation(session.mode);
      ctx.toast(session.mode === 'avatar' ? '口播稿已填入，请确认后选择形象和声音。' : '已应用方案');
    }
  }));
}

export function handleBusinessAction(action, element, ctx) {
  if (!['business-open', 'business-plan'].includes(action)) return false;
  const mode = modes.includes(element.dataset.mode) ? element.dataset.mode : (modes.includes(ctx.mode) ? ctx.mode : 'image');
  const config = ctx.configs[mode];
  if (action === 'business-plan' && config.contentPlan && config.brief) {
    session = { mode, brief: normalizeBrief(config.brief), extraRequest: config.contentPlan.extraRequest || '', files: [...config.files], errors: {}, plan: config.contentPlan };
    renderPlan(ctx, true);
  } else openBusinessFlow(ctx, { mode });
  return true;
}
