import { IMAGE_PRESETS, PRESET_FIELD_LIMITS, getImagePreset, getPresetDefaults, validatePresetFields, buildPresetPrompt } from './image-presets.js';

const qualityNames = { medium: '标准', high: '精细' };
let lastStyleChange;
const fieldSpecs = [
  ['title', '主标题', '例如：找加工厂，这4点先说清', true],
  ['subtitle', '副标题', '用一句话补充这张图想表达的内容'],
  ['points', '展示要点', '每行一项，可用“主题｜说明”组织文案', true],
  ['callToAction', '咨询引导', '例如：带上图纸或样件，聊聊加工需求'],
  ['businessName', '商家 / 企业名称', '选填，只填写自己的真实名称'],
];

function currentPreset(ctx) {
  const saved = ctx.configs.image.imagePreset;
  return saved && getImagePreset(saved.id) ? saved : null;
}

export function renderImagePresetEntry(ctx) {
  const { esc, button } = ctx;
  const saved = currentPreset(ctx);
  const preset = saved && getImagePreset(saved.id);
  const canUndo = lastStyleChange?.config === ctx.configs.image && lastStyleChange.appliedPrompt === ctx.configs.image.prompt;
  return `<section class="image-preset-entry" aria-label="图片风格"><div class="image-preset-entry-heading"><div><strong>选择风格</strong><small>点选即用，文案已备好</small></div>${preset ? button('image-preset-edit', '修改文案（选填）', 'textbutton', `data-id="${esc(preset.id)}"`) : ''}</div><div class="image-preset-shortcuts">${IMAGE_PRESETS.map(item => button('image-preset-select', `<img src="${esc(item.cover)}" alt=""><span>${esc(item.name)}<small>${saved?.id === item.id ? '✓ 已选择' : item.id === 'factory-poster' ? '大图 · 精简文字' : '大标题 · 多文案'}</small></span>`, saved?.id === item.id ? 'selected' : '', `data-id="${esc(item.id)}" aria-pressed="${saved?.id === item.id}"`)).join('')}</div>${preset ? `<p class="image-preset-copy-summary" id="image-preset-active-note">${ctx.configs.image.prompt === saved.appliedPrompt ? `标题：${esc(saved.fields.title)}` : '使用你手动调整的创作要求'}</p>` : ''}${canUndo ? `<div class="image-preset-undo"><span>已切换风格，原图已保留</span>${button('image-preset-undo', '撤销切换', 'textbutton')}</div>` : ''}</section>`;
}

function presetGallery(ctx) {
  const { esc, button, icon } = ctx;
  ctx.openModal('选择图片风格', '点选即可使用，需要时再修改文案。', `<div class="image-preset-gallery">${IMAGE_PRESETS.map(preset => button('image-preset-select', `<div class="image-preset-cover"><img src="${esc(preset.cover)}" alt="${esc(preset.name)}效果示例"></div><div class="image-preset-card-copy"><strong>${esc(preset.name)}</strong><p>${esc(preset.description)}</p><small>${esc(preset.ratio)} · ${esc(qualityNames[preset.quality])}画质</small><span>使用这个风格 ${icon('arrow')}</span></div>`, 'image-preset-card', `data-id="${esc(preset.id)}"`)).join('')}</div><p class="image-preset-footnote">示例图片用于看风格；生成时使用你上传的原图。</p>`, true);
}

function presetFields(ctx, id) {
  const saved = currentPreset(ctx);
  if (saved && !Object.keys(validatePresetFields(saved.id, saved.fields)).length) {
    const defaults = getPresetDefaults(saved.id);
    // Carry merchants' edited copy across layouts, but give untouched styles their own defaults.
    if (saved.id === id || Object.keys(defaults).some(key => key !== 'businessName' && saved.fields[key] !== defaults[key])) return { ...saved.fields };
  }
  const fields = getPresetDefaults(id);
  const name = saved?.fields?.businessName ?? ctx.storeInfo?.name;
  if (typeof name === 'string' && name.length <= PRESET_FIELD_LIMITS.businessName) fields.businessName = name;
  return fields;
}

function focusSelectedPreset(id) {
  globalThis.document?.querySelector(`.image-preset-shortcuts [data-action="image-preset-select"][data-id="${id}"][aria-pressed="true"]`)?.focus({ preventScroll: true });
}

export function selectImagePreset(ctx, id, options = {}) {
  const preset = getImagePreset(id);
  if (!preset) return;
  const config = ctx.configs.image;
  const saved = currentPreset(ctx);
  if (saved?.id === id && !Object.keys(validatePresetFields(id, saved.fields)).length) {
    if (options.initialFiles) config.files = [...options.initialFiles];
    ctx.beginCreation('image');
    focusSelectedPreset(id);
    return;
  }
  const fields = presetFields(ctx, id);
  const prompt = buildPresetPrompt(id, fields);
  const keys = ['prompt', 'ratio', 'quality', 'skill', 'imagePreset', 'brief', 'contentPlan'];
  lastStyleChange = config.prompt ? { config, appliedPrompt: prompt, previous: structuredClone(Object.fromEntries(keys.filter(key => key in config).map(key => [key, config[key]]))), keys } : undefined;
  Object.assign(config, { prompt, ratio: preset.ratio, quality: preset.quality, skill: preset.name, imagePreset: { id, fields, appliedPrompt: prompt } });
  if (options.initialFiles) config.files = [...options.initialFiles];
  delete config.brief;
  delete config.contentPlan;
  ctx.setMaterialIndustry?.('industrial');
  ctx.beginCreation('image');
  focusSelectedPreset(id);
}

function fieldHtml(spec, values, esc) {
  const [name, label, placeholder, required] = spec;
  const help = name === 'points' ? '每行一项，填写 1–4 项，每项最多 60 字。可用“主题｜说明”写详细文案。' : name === 'businessName' ? '留空时不会添加名称。' : `最多 ${PRESET_FIELD_LIMITS[name]} 字。`;
  const attributes = `id="image-preset-${name}" name="${name}" maxlength="${PRESET_FIELD_LIMITS[name]}" placeholder="${esc(placeholder)}" aria-describedby="image-preset-${name}-hint image-preset-${name}-error"${required ? ' required' : ''}`;
  return `<label class="image-preset-field" for="image-preset-${name}"><span>${label}<small>${required ? '必填' : '选填'}</small></span>${['points', 'callToAction'].includes(name) ? `<textarea ${attributes} rows="${name === 'points' ? 5 : 2}">${esc(values[name])}</textarea>` : `<input ${attributes} value="${esc(values[name])}" type="text">`}<small id="image-preset-${name}-hint">${help}</small><span class="image-preset-field-error" id="image-preset-${name}-error" aria-live="polite"></span></label>`;
}

export function openImagePreset(ctx, id) {
  const preset = getImagePreset(id);
  if (!preset) { presetGallery(ctx); return; }
  const { esc, button } = ctx;
  const config = ctx.configs.image;
  const saved = currentPreset(ctx);
  const reuse = saved?.id === id && !Object.keys(validatePresetFields(id, saved.fields)).length;
  const values = presetFields(ctx, id);
  const edited = reuse && config.prompt !== saved.appliedPrompt;
  ctx.openModal('修改文案', '只改你需要的文字，其他内容可以直接沿用。', `<div class="image-preset-editor"><aside class="image-preset-example"><img src="${esc(preset.cover)}" alt="${esc(preset.name)}效果示例"><strong>${esc(preset.name)}</strong><p>${esc(preset.description)}</p><small>效果示例 · 请上传自己的原图</small></aside><form id="image-preset-form" novalidate><div class="image-preset-form-heading"><strong>${esc(preset.name)}</strong></div>${fieldSpecs.map(spec => fieldHtml(spec, values, esc)).join('')}<details class="image-preset-prompt"><summary>查看完整创作要求 <small id="image-preset-prompt-count"></small></summary><p id="image-preset-prompt-preview"></p></details><p class="image-preset-apply-note">将采用 ${esc(preset.ratio)}、${esc(qualityNames[preset.quality])}画质，原图继续保留。${config.prompt ? edited ? '你已手动修改过创作要求；保存会用这里的文案重新整理。' : '保存后更新当前创作要求。' : '示例文案可先体验，发布前请换成自己的信息。'}</p><p id="image-preset-form-error" class="image-preset-field-error" role="alert"></p><footer class="modal-actions">${button('cancel', '返回', 'secondary', 'type="button"')}<button class="primary" type="submit">保存文案</button></footer></form></div>`, true);

  const form = document.querySelector('#image-preset-form');
  const read = () => Object.fromEntries(new FormData(form));
  function showError(name, message = '') {
    const input = form.elements.namedItem(name);
    input?.setAttribute('aria-invalid', String(!!message));
    const note = document.querySelector(`#image-preset-${name}-error`);
    if (note) note.textContent = message;
  }
  function updatePreview() {
    const fields = read();
    const errors = validatePresetFields(id, fields);
    const output = document.querySelector('#image-preset-prompt-preview');
    const count = document.querySelector('#image-preset-prompt-count');
    if (Object.keys(errors).length) { output.textContent = '补齐标题与展示要点后，这里会显示完整创作要求。'; count.textContent = ''; return; }
    try {
      const prompt = buildPresetPrompt(id, fields);
      output.textContent = prompt;
      count.textContent = `${prompt.length} / 1000 字`;
    } catch (error) { output.textContent = error.message; count.textContent = ''; }
  }
  form.addEventListener('input', event => {
    if (fieldSpecs.some(([name]) => name === event.target.name)) {
      if (event.target.getAttribute('aria-invalid') === 'true') showError(event.target.name, validatePresetFields(id, read())[event.target.name]);
      document.querySelector('#image-preset-form-error').textContent = '';
      updatePreview();
    }
  });
  form.addEventListener('focusout', event => {
    if (fieldSpecs.some(([name]) => name === event.target.name)) showError(event.target.name, validatePresetFields(id, read())[event.target.name]);
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const fields = read();
    const errors = validatePresetFields(id, fields);
    fieldSpecs.forEach(([name]) => showError(name, errors[name]));
    if (Object.keys(errors).length) {
      document.querySelector('#image-preset-form-error').textContent = '请先修改标出的内容。';
      form.elements.namedItem(Object.keys(errors)[0])?.focus();
      return;
    }
    let prompt;
    try { prompt = buildPresetPrompt(id, fields); }
    catch (error) { document.querySelector('#image-preset-form-error').textContent = error.message; return; }
    Object.assign(config, { prompt, ratio: preset.ratio, quality: preset.quality, skill: preset.name, imagePreset: { id, fields: { ...fields }, appliedPrompt: prompt } });
    lastStyleChange = undefined;
    delete config.brief;
    delete config.contentPlan;
    document.querySelector('#modal').close();
    ctx.setMaterialIndustry?.('industrial');
    ctx.beginCreation('image');
    ctx.toast('文案已修改，可以直接生成。');
  });
  updatePreview();
}

export function handleImagePresetAction(action, element, ctx) {
  if (action === 'image-preset-select') {
    selectImagePreset(ctx, element.dataset.id);
    return true;
  }
  if (action === 'image-preset-undo') {
    if (lastStyleChange?.config === ctx.configs.image && lastStyleChange.appliedPrompt === ctx.configs.image.prompt) {
      const { config, keys, previous } = lastStyleChange;
      keys.forEach(key => delete config[key]);
      Object.assign(config, previous);
      lastStyleChange = undefined;
      ctx.beginCreation('image');
    }
    return true;
  }
  if (action === 'image-presets') {
    presetGallery(ctx);
    return true;
  }
  if (action === 'image-preset-edit') {
    openImagePreset(ctx, element.dataset.id);
    return true;
  }
  return false;
}
