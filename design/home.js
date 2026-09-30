import { accountStorageKey } from './account-storage.js';
// Sources: photography and original AI style examples; see media/SOURCES.md.
// Visual thesis: a calm, spacious creation surface with blue actions and warm, real shop photography.
// Content: business brief → shortcut tools → useful scenarios → browsable inspiration.
// Interaction: focused composer, subtle image zoom, immediate gallery filtering and reusable briefs.
import { INDUSTRIES, PLATFORMS, getPurposes } from './business-catalog.js';
import { inspirationItems, getMaterialItems, MATERIAL_FILTERS, industryForMaterial } from './material-catalog.js';
export { inspirationItems } from './material-catalog.js';
const HOMEMAX = 400;
const GALLERY_INITIAL_COUNT = 12;
const GALLERY_BATCH_SIZE = 6;

const scenes = [
  { title: '门店实景', purpose: 'visit', sub: '给附近的人一个到店理由', mode: 'video', skill: '门店发现', cover: '/media/ai-cover-storefront.png', coverIndustries: ['dining', 'retail'], eyebrow: '吸引到店' },
  { title: '服务案例', purpose: 'case', sub: '用过程和细节建立信任', mode: 'image', skill: '招牌项目', cover: '/media/ai-cover-service.png', coverIndustries: ['beauty'], eyebrow: '展示专业' },
  { title: '活动促销', purpose: 'promotion', sub: '把内容、价格和条件讲清楚', mode: 'image', skill: '活动海报', cover: '/media/ai-cover-promotion.png', coverIndustries: ['dining', 'retail'], eyebrow: '传达优惠' },
  { title: '选购攻略', purpose: 'guide', sub: '帮顾客选到适合自己的', mode: 'image', skill: '朋友圈九宫格', cover: '/media/ai-cover-selection.png', coverIndustries: ['retail'], eyebrow: '回答疑问' },
  { title: '工厂询价', purpose: 'inquiry', sub: '让采购带着明确需求来', mode: 'image', skill: '招牌项目', cover: '/media/ai-cover-production.png', coverIndustries: ['factory-retail', 'oem', 'industrial'], eyebrow: '对接采购' },
  { title: '品牌展示', purpose: 'brand', sub: '讲清你的特色与实力', mode: 'avatar', skill: '老板介绍', cover: '/media/ai-cover-brand.png', coverIndustries: ['factory-retail', 'oem', 'industrial', 'wholesale'], eyebrow: '认识生意' },
];

let currentMode = 'image';
let prompt = '';
let category = 'all';
let industryScenesSelected = false;
let showFavorites = false;
let selectedAssetIds = new Set();
let galleryResizeObserver;
let visibleMaterialCount = GALLERY_INITIAL_COUNT;
let favorites = new Set();
let selectedIndustry = 'dining';
let selectedPurpose = 'visit';
let selectedPlatform = 'xiaohongshu';
let selectionInitialized = false;
let loadedProfileVersion;

function initializeSelection(ctx) {
  if (selectionInitialized && loadedProfileVersion === ctx.businessProfileVersion) return;
  const brief = ctx.getBusinessBrief?.();
  if (INDUSTRIES.some(item => item.id === brief?.industry)) selectedIndustry = brief.industry;
  if (getPurposes(selectedIndustry).some(item => item.id === brief?.purpose)) selectedPurpose = brief.purpose;
  if (!getPurposes(selectedIndustry).some(item => item.id === selectedPurpose)) selectedPurpose = getPurposes(selectedIndustry)[0].id;
  if (PLATFORMS.some(item => item.id === brief?.platform)) selectedPlatform = brief.platform;
  selectionInitialized = true;
  loadedProfileVersion = ctx.businessProfileVersion;
  if (ctx.storeInfo?.name || brief?.businessName) ctx.setMaterialIndustry?.(selectedIndustry);
}

function renderPurposeOptions(ctx) {
  return getPurposes(selectedIndustry).map(item => `<option value="${ctx.esc(item.id)}" ${item.id === selectedPurpose ? 'selected' : ''}>${ctx.esc(item.label)}</option>`).join('');
}

function renderIndustryOptions(ctx) {
  const groups = [...new Set(INDUSTRIES.map(item => item.group))];
  return groups.map(group => `<optgroup label="${ctx.esc(group)}">${INDUSTRIES.filter(item => item.group === group).map(item => `<option value="${ctx.esc(item.id)}" ${item.id === selectedIndustry ? 'selected' : ''}>${ctx.esc(item.label)}</option>`).join('')}</optgroup>`).join('');
}

function syncFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem(accountStorageKey('store-ai-inspiration-favorites')) || '[]');
    if (Array.isArray(saved)) favorites = new Set(saved.filter(id => typeof id === 'string'));
  } catch { /* Keep this page's current favorites if storage is unavailable. */ }
}
syncFavorites();

function mediaIcon(kind, ctx) { return ctx.icon(kind === '图片' ? 'image' : kind === '混剪' ? 'mix' : kind === '数字人' ? 'avatar' : 'video'); }
function filteredItems() {
  const sceneImages = new Set(sceneEntries().map(scene => scene.image));
  return getMaterialItems({ industry: category })
    .filter(item => !showFavorites || favorites.has(item.id))
    .sort((a, b) => Number(sceneImages.has(a.image)) - Number(sceneImages.has(b.image)));
}

function industryLabel(id) {
  return MATERIAL_FILTERS.find(item => item.id === id)?.label || '全部行业';
}

function materialIndustryLabel(item) {
  return category !== 'all' && item.industries?.includes(category)
    ? industryLabel(category)
    : item.category || industryLabel(industryForMaterial(item));
}

function purposeLabel(item) {
  const industry = directionForItem(item).industry;
  return getPurposes(industry).find(purpose => purpose.id === item.purpose)?.label || item.skill;
}

function renderMaterialContext(ctx) {
  const label = category === 'all' ? '门店、工厂与批发，都有适合自己的展示方式' : `正在浏览${industryLabel(category)}的素材方向`;
  return `<p>${ctx.esc(label)}<span>参考画面与表达方式，创作时使用你自己的素材。</span></p>${category === 'all' ? '' : ctx.button('home-reset-filter', '查看全部行业 ' + ctx.icon('arrow'), 'home-view-all')}`;
}

function renderGallery(ctx) {
  syncFavorites();
  const { esc, button, icon } = ctx;
  const items = filteredItems();
  if (!items.length) return `<div class="home-gallery-empty">${icon(showFavorites ? 'star' : 'image')}<strong>${showFavorites ? '这个行业还没有收藏' : '这个行业暂时没有参考'}</strong><p>${showFavorites ? '打开喜欢的素材方向，点击收藏，下次继续创作。' : '切换其他行业，看看新的创作方向。'}</p>${button('home-reset-filter', '浏览全部素材方向', 'home-empty-action')}</div>`;
  return items.slice(0, visibleMaterialCount).map(item => `<article class="home-inspiration-card home-height-${item.height}">${button('home-case', `<div class="home-case-photo"><img src="${esc(item.image)}" alt="${esc(item.description)}" loading="lazy"><span class="home-case-type">${mediaIcon(item.kind, ctx)}${esc(item.kind)}方向</span><span class="home-material-tag">${esc(item.materialTag || item.category)}</span><span class="home-case-open">查看素材方向 ${icon('arrow')}</span></div><div class="home-case-caption"><strong>${esc(item.title)}</strong><span>${esc(materialIndustryLabel(item))}<i>·</i>${esc(item.sourceLabel || '摄影参考')}</span></div>`, 'home-case-button', `data-id="${esc(item.id)}"`)}${button('home-favorite', icon('star'), `home-favorite ${favorites.has(item.id) ? 'is-saved' : ''}`, `data-id="${esc(item.id)}" title="${favorites.has(item.id) ? '取消收藏' : '收藏素材方向'}" aria-label="${favorites.has(item.id) ? '取消收藏' : '收藏'}：${esc(item.title)}" aria-pressed="${favorites.has(item.id)}"`)}</article>`).join('');
}

function sceneEntries() {
  const factoryIndustry = ['factory-retail', 'oem', 'industrial', 'wholesale'].includes(selectedIndustry);
  const useIndustry = industryScenesSelected || factoryIndustry;
  if (!useIndustry) return scenes.map(scene => ({ ...scene, image: scene.cover, sourceLabel: 'AI 风格示例', industry: '' }));
  const matchingMaterials = getMaterialItems({ industry: selectedIndustry });
  const usedImages = new Set();
  const entries = [];
  for (const { id: purpose } of getPurposes(selectedIndustry)) {
    const scene = scenes.find(item => item.purpose === purpose);
    if (!scene) continue;
    const material = matchingMaterials.find(item => item.purpose === purpose && !usedImages.has(item.image))
      || matchingMaterials.find(item => !usedImages.has(item.image));
    const useCover = !material && scene.coverIndustries.includes(selectedIndustry) && !usedImages.has(scene.cover);
    if (!material && !useCover) continue;
    const image = material?.image || scene.cover;
    usedImages.add(image);
    entries.push({
      ...scene,
      image,
      sourceLabel: material?.sourceLabel || 'AI 风格示例',
      industry: selectedIndustry,
      title: factoryIndustry && purpose === 'visit' ? (selectedIndustry === 'wholesale' ? '货盘实景' : '工厂实景')
        : factoryIndustry && purpose === 'case' ? '加工案例'
        : selectedIndustry === 'wholesale' && purpose === 'inquiry' ? '供货询价' : scene.title,
      sub: factoryIndustry && purpose === 'visit' ? '让客户看见真实产品与现场'
        : factoryIndustry && purpose === 'case' ? '从过程到成品，展示你能做什么' : scene.sub,
    });
  }
  return entries;
}

function renderScenes(ctx) {
  const { esc, button, icon } = ctx;
  return sceneEntries().map(scene => button('home-scene', `<img src="${esc(scene.image)}" alt="${esc(scene.title)} · ${esc(scene.sourceLabel)}" loading="lazy"><span class="home-scene-shade"></span><span class="home-scene-source">${esc(scene.sourceLabel)}</span><span class="home-scene-copy"><small>${scene.eyebrow}</small><strong>${scene.title}</strong><span>${scene.sub}</span></span><i>${icon('arrow')}</i>`, 'home-scene-card', `data-mode="${scene.mode}" data-skill="${esc(scene.skill)}" data-purpose="${scene.purpose}" data-industry="${scene.industry}"`)).join('');
}

function sceneCount() {
  return Math.max(1, sceneEntries().length);
}

function renderGalleryPagination(ctx) {
  const count = filteredItems().length;
  if (!count) return '';
  const remaining = Math.max(0, count - visibleMaterialCount);
  return `<span class="home-gallery-count" tabindex="-1">已展示 ${Math.min(visibleMaterialCount, count)} / ${count} 个素材方向</span>${remaining ? ctx.button('home-load-more', `加载更多 ${Math.min(GALLERY_BATCH_SIZE, remaining)} 个 ${ctx.icon('chevron')}`, 'home-load-more', 'aria-controls="home-inspiration-grid"') : '<span class="home-gallery-complete">已经到底了，换个行业继续找灵感</span>'}`;
}

function renderAssetSelection(ctx) {
  const type = ctx.modules[currentMode].type;
  const media = ctx.assets.filter(asset => asset.type === type);
  if (!media.length) return '';
  const { esc, icon, button } = ctx;
  return `<div class="home-attached-assets"><span>我的${type === 'video' ? '视频' : '图片'}</span>${media.map(asset => button('home-asset', `${type === 'image' ? `<img src="${esc(asset.url)}" alt="${esc(asset.name)}">` : icon('video')}${selectedAssetIds.has(asset.id) ? `<i>${icon('check')}</i>` : ''}`, `home-asset-thumb ${selectedAssetIds.has(asset.id) ? 'selected' : ''}`, `data-id="${esc(asset.id)}" title="${esc(asset.name)}" aria-label="选择素材 ${esc(asset.name)}" aria-pressed="${selectedAssetIds.has(asset.id)}"`)).join('')}<small>点击选入本次创作</small></div>`;
}

export function renderHomeView(ctx) {
  syncFavorites();
  initializeSelection(ctx);
  const { esc, icon, button, modules } = ctx;
  const tools = [
    ['image', 'AI 图片', 'image', ''], ['video', 'AI 视频', 'video', ''], ['mix', 'AI 混剪', 'mix', ''],
    ['avatar', '数字人口播', 'avatar', ''], ['image', '图片精修', 'settings', '图片精修'], ['image', '朋友圈九宫格', 'list', '朋友圈九宫格'],
  ];
  return `<div class="home-content">
    <section class="home-hero" aria-label="开始生意宣传创作">
      <div class="home-intro"><h1>让你的<span>生意</span>，被更多人看见</h1><p>门店获客 · 工厂询价 · 批发供货，从真实素材开始</p></div>
      <div class="home-idea-box">
        <div class="home-brief-selectors" aria-label="宣传方向">
          <label for="home-industry"><span><i>01</i> 你做什么生意</span><select id="home-industry">${renderIndustryOptions(ctx)}</select></label>
          <label for="home-purpose"><span><i>02</i> 这次想宣传什么</span><select id="home-purpose">${renderPurposeOptions(ctx)}</select></label>
          <label for="home-platform"><span><i>03</i> 准备发到哪里</span><select id="home-platform">${PLATFORMS.map(item => `<option value="${esc(item.id)}" ${item.id === selectedPlatform ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>
        </div>
        <label class="home-prompt-label" for="home-idea">补充你的想法 <span>选填，不会写也可以开始</span></label>
        <textarea id="home-idea" maxlength="${HOMEMAX}" placeholder="比如：介绍我们的招牌产品，让顾客知道怎么选、怎么联系……">${esc(prompt)}</textarea>
        <div id="home-selected-assets">${renderAssetSelection(ctx)}</div>
        <div class="home-composer-toolbar">
          ${button('home-upload', `${icon('plus')}<span>添加${modules[currentMode].type === 'video' ? '视频' : '原图'}</span>`, 'home-add-image')}
          <span class="home-composer-divider"></span>
          <div class="home-mode-select">${icon(currentMode)}<select id="home-creation-mode" aria-label="选择创作类型">${Object.entries(modules).map(([key, value]) => `<option value="${key}" ${currentMode === key ? 'selected' : ''}>${esc(value.title)}</option>`).join('')}</select>${icon('chevron')}</div>
          <span class="home-composer-spacer"></span><small id="home-input-count" class="home-input-count">${prompt.length} / ${HOMEMAX}</small>
          ${button('home-create', `补充信息并创作 ${icon('arrow')}`, 'home-send', 'aria-label="补充信息并创作"')}
        </div>
      </div>
      <p class="home-workflow-hint"><span>选择宣传方向</span>${icon('chevron')}<span>补充真实信息</span>${icon('chevron')}<span>生成可编辑的创作方案</span></p>
      <div class="home-quick-tools" aria-label="快捷工具">${tools.map(([target, title, symbol, skill]) => button('home-tool', `<span class="home-quick-icon">${icon(symbol)}</span><span>${title}</span>`, 'home-quick-tool', `data-mode="${target}" data-skill="${skill}"`)).join('')}</div>
    </section>
    <section class="home-scene-section" aria-label="常用宣传场景">
      <div class="home-section-title"><h2>把你的业务，讲给对的人</h2><span>常用宣传场景</span></div>
      <div id="home-scene-grid" class="home-scene-grid" style="--scene-columns:${sceneCount()}">${renderScenes(ctx)}</div>
    </section>
    <section class="home-discover" aria-label="发现宣传灵感">
      <div class="home-discover-heading"><h2>找到适合你生意的画面</h2><span>从场景与风格示例里，找到你的创作方向</span></div>
      <div class="home-discover-header"><div class="home-discover-tabs" role="tablist" aria-label="素材方向列表">${button('home-gallery-tab', '素材灵感', showFavorites ? '' : 'active', `data-tab="discover" role="tab" aria-selected="${!showFavorites}"`)}${button('home-gallery-tab', '我的收藏', showFavorites ? 'active' : '', `data-tab="favorites" role="tab" aria-selected="${showFavorites}"`)}</div><span class="home-inspiration-note">摄影参考与 AI 风格示例</span></div>
      <div class="home-category-filters" aria-label="按行业筛选">${MATERIAL_FILTERS.map(item => button('home-category', esc(item.label), category === item.id ? 'active' : '', `data-category="${esc(item.id)}" aria-pressed="${category === item.id}"`)).join('')}</div>
      <div id="home-material-context" class="home-material-context" aria-live="polite">${renderMaterialContext(ctx)}</div>
      <div id="home-inspiration-grid" class="home-inspiration-grid">${renderGallery(ctx)}</div>
      <div id="home-gallery-pagination" class="home-gallery-pagination" aria-live="polite">${renderGalleryPagination(ctx)}</div>
    </section>
    <footer class="home-end">让每一份认真经营，都被看见。</footer>
  </div>`;
}

export function bindHomeView(ctx) {
  galleryResizeObserver?.disconnect();
  const gallery = document.getElementById('home-inspiration-grid');
  layoutGallery();
  if (gallery) {
    let previousWidth = gallery.getBoundingClientRect().width;
    galleryResizeObserver = new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (Math.abs(width - previousWidth) < 0.5) return;
      previousWidth = width;
      layoutGallery();
    });
    galleryResizeObserver.observe(gallery);
  }
  const input = document.getElementById('home-idea');
  document.getElementById('home-industry')?.addEventListener('change', event => {
    selectedIndustry = event.target.value;
    ctx.setMaterialIndustry?.(selectedIndustry);
    const purposes = getPurposes(selectedIndustry);
    if (!purposes.some(item => item.id === selectedPurpose)) selectedPurpose = purposes[0].id;
    document.getElementById('home-purpose').innerHTML = renderPurposeOptions(ctx);
    category = selectedIndustry;
    visibleMaterialCount = GALLERY_INITIAL_COUNT;
    industryScenesSelected = true;
    const sceneGrid = document.getElementById('home-scene-grid');
    if (sceneGrid) {
      sceneGrid.innerHTML = renderScenes(ctx);
      sceneGrid.style.setProperty('--scene-columns', String(sceneCount()));
    }
    updateGallery(ctx);
  });
  document.getElementById('home-purpose')?.addEventListener('change', event => { selectedPurpose = event.target.value; });
  document.getElementById('home-platform')?.addEventListener('change', event => { selectedPlatform = event.target.value; });
  if (input) {
    input.addEventListener('input', () => { prompt = input.value; updateComposerStatus(ctx); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        startCreation(ctx);
      }
    });
  }
  document.getElementById('home-creation-mode')?.addEventListener('change', event => {
    currentMode = event.target.value;
    if (input) input.maxLength = HOMEMAX;
    const oldIcon = event.target.parentElement.querySelector('.icon');
    if (oldIcon) oldIcon.outerHTML = ctx.icon(currentMode);
    const uploadLabel = document.querySelector('[data-action="home-upload"] > span');
    if (uploadLabel) uploadLabel.textContent = ctx.modules[currentMode].type === 'video' ? '添加视频' : '添加原图';
    const assetsContainer = document.getElementById('home-selected-assets');
    if (assetsContainer) assetsContainer.innerHTML = renderAssetSelection(ctx);
    updateComposerStatus(ctx);
    if (prompt.length > HOMEMAX) {
      ctx.toast(`补充想法最多支持 ${HOMEMAX} 字，请缩短后开始创作，原文已保留。`);
    }
  });
  updateComposerStatus(ctx);
}

function updateComposerStatus(ctx) {
  const max = HOMEMAX;
  const tooLong = prompt.length > max;
  const counter = document.getElementById('home-input-count');
  if (counter) {
    counter.textContent = `${prompt.length} / ${max}`;
    counter.classList.toggle('over-limit', tooLong);
  }
  document.getElementById('home-idea')?.setAttribute('aria-invalid', String(tooLong));
}

function selectedFilesFor(target, ctx) {
  return [...selectedAssetIds].filter(id => ctx.assets.some(asset => asset.id === id && asset.type === ctx.modules[target].type));
}

function validateTransfer(target, value, ctx) {
  const module = ctx.modules[target];
  if (!module) return false;
  if (value.length > module.max) {
    ctx.toast(`${module.title}最多支持 ${module.max} 字，当前文案有 ${value.length} 字。请缩短后再进入，原文已保留。`);
    document.getElementById('home-idea')?.focus();
    return false;
  }
  if (selectedFilesFor(target, ctx).length > module.limit) {
    ctx.toast(`${module.title}最多选择 ${module.limit} 个素材，请先取消多余的素材选择。`);
    return false;
  }
  return true;
}

function validateHomePrompt(ctx) {
  if (prompt.length <= HOMEMAX) return true;
  updateComposerStatus(ctx);
  ctx.toast(`补充想法最多支持 ${HOMEMAX} 字，当前有 ${prompt.length} 字。请缩短后再继续，原文已保留。`);
  document.getElementById('home-idea')?.focus();
  return false;
}

function startCreation(ctx) {
  const input = document.getElementById('home-idea');
  if (input) prompt = input.value;
  if (!validateHomePrompt(ctx) || !validateTransfer(currentMode, prompt, ctx)) return;
  ctx.openBusinessFlow({ industry: selectedIndustry, purpose: selectedPurpose, platform: selectedPlatform, mode: currentMode, prompt, initialFiles: selectedFilesFor(currentMode, ctx), newBrief: true });
}

function industryForPurpose(purpose, preferred = selectedIndustry) {
  if (getPurposes(preferred).some(item => item.id === purpose)) return preferred;
  const fallback = purpose === 'inquiry' ? 'oem' : purpose === 'case' ? 'beauty' : 'dining';
  if (getPurposes(fallback).some(item => item.id === purpose)) return fallback;
  return INDUSTRIES.find(industry => getPurposes(industry.id).some(item => item.id === purpose))?.id || selectedIndustry;
}

function directionForItem(item) {
  const preferredIndustry = category === 'all' ? selectedIndustry : category;
  const industry = item.industries?.includes(preferredIndustry) ? preferredIndustry : industryForMaterial(item);
  const purpose = item.purpose || getPurposes(industry)[0].id;
  return { industry: industryForPurpose(purpose, industry), purpose };
}

function layoutGallery() {
  const gallery = document.getElementById('home-inspiration-grid');
  if (!gallery) return;
  const cards = [...gallery.querySelectorAll('.home-inspiration-card')];
  const heights = cards.map(card => Math.ceil(card.getBoundingClientRect().height));
  cards.forEach((card, index) => { card.style.gridRowEnd = `span ${heights[index] + 23}`; });
}

function updateGallery(ctx) {
  const grid = document.getElementById('home-inspiration-grid');
  if (grid) grid.innerHTML = renderGallery(ctx);
  const pagination = document.getElementById('home-gallery-pagination');
  if (pagination) pagination.innerHTML = renderGalleryPagination(ctx);
  const context = document.getElementById('home-material-context');
  if (context) context.innerHTML = renderMaterialContext(ctx);
  layoutGallery();
  document.querySelectorAll('[data-action="home-category"]').forEach(element => {
    const active = category === element.dataset.category;
    element.classList.toggle('active', active);
    element.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-action="home-gallery-tab"]').forEach(element => {
    const active = (element.dataset.tab === 'favorites') === showFavorites;
    element.classList.toggle('active', active);
    element.setAttribute('aria-selected', String(active));
  });
}

export function handleHomeAction(action, element, ctx) {
  const { esc, icon, button } = ctx;
  if (!action.startsWith('home-')) return false;
  switch (action) {
    case 'home-create': startCreation(ctx); break;
    case 'home-upload': ctx.picker(ctx.modules[currentMode].type, true, {max:ctx.modules[currentMode].limit,selected:selectedFilesFor(currentMode,ctx),onConfirm:ids=>{selectedAssetIds=new Set(ids);}}); break;
    case 'home-tool': {
      const target = element.dataset.mode;
      const input = document.getElementById('home-idea');
      if (input) prompt = input.value;
      if (!validateHomePrompt(ctx) || !validateTransfer(target, prompt, ctx)) break;
      if (element.dataset.skill) ctx.configs[target].skill = element.dataset.skill;
      else if (ctx.configs[target].imagePreset) ctx.configs[target].skill = ctx.modules[target].names[0][0];
      delete ctx.configs[target].imagePreset;
      ctx.configs[target].prompt = prompt;
      ctx.configs[target].files = selectedFilesFor(target, ctx);
      ctx.configs[target].brief = null;
      ctx.configs[target].contentPlan = null;
      ctx.beginCreation(target);
      break;
    }
    case 'home-scene': {
      const target = element.dataset.mode;
      const input = document.getElementById('home-idea');
      if (input) prompt = input.value;
      if (!validateHomePrompt(ctx) || !validateTransfer(target, prompt, ctx)) break;
      ctx.openBusinessFlow({ industry: industryForPurpose(element.dataset.purpose, element.dataset.industry || selectedIndustry), purpose: element.dataset.purpose, platform: selectedPlatform, mode: target, prompt, initialFiles: selectedFilesFor(target, ctx), newBrief: true });
      break;
    }
    case 'home-asset':
      if (selectedAssetIds.has(element.dataset.id)) selectedAssetIds.delete(element.dataset.id);
      else if (selectedFilesFor(currentMode, ctx).length < ctx.modules[currentMode].limit) selectedAssetIds.add(element.dataset.id);
      else ctx.toast(`${ctx.modules[currentMode].title}最多选择 ${ctx.modules[currentMode].limit} 个素材。`);
      document.getElementById('home-selected-assets').innerHTML = renderAssetSelection(ctx);
      break;
    case 'home-category': category = element.dataset.category; visibleMaterialCount = GALLERY_INITIAL_COUNT; updateGallery(ctx); break;
    case 'home-gallery-tab': showFavorites = element.dataset.tab === 'favorites'; visibleMaterialCount = GALLERY_INITIAL_COUNT; updateGallery(ctx); break;
    case 'home-reset-filter': category = 'all'; showFavorites = false; visibleMaterialCount = GALLERY_INITIAL_COUNT; updateGallery(ctx); break;
    case 'home-load-more': {
      visibleMaterialCount += GALLERY_BATCH_SIZE;
      updateGallery(ctx);
      document.querySelector('#home-gallery-pagination button, #home-gallery-pagination .home-gallery-count')?.focus({ preventScroll: true });
      break;
    }
    case 'home-favorite': {
      syncFavorites();
      const id = element.dataset.id;
      if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
      try { localStorage.setItem(accountStorageKey('store-ai-inspiration-favorites'), JSON.stringify([...favorites])); } catch { ctx.toast('收藏未保存，请检查浏览器存储设置。'); }
      updateGallery(ctx);
      document.querySelectorAll('.home-detail-favorite').forEach(btn => {
        btn.innerHTML = icon('star') + (favorites.has(id) ? '已收藏' : '收藏灵感');
        btn.setAttribute('aria-pressed', String(favorites.has(id)));
      });
      break;
    }
    case 'home-case': {
      const item = inspirationItems.find(candidate => candidate.id === element.dataset.id);
      if (!item) break;
      ctx.openModal(item.title, `${materialIndustryLabel(item)} · ${item.kind}创作方向`, `<div class="home-case-detail"><div class="home-detail-image"><img src="${esc(item.image)}" alt="${esc(item.description)}"><span>${esc(item.sourceLabel || '摄影参考')}</span></div><div class="home-detail-content"><div class="home-detail-tags"><span>${esc(materialIndustryLabel(item))}</span><span>${esc(purposeLabel(item))}</span></div><span class="home-detail-type">${mediaIcon(item.kind, ctx)}${esc(item.materialTag || item.skill)}</span><h3>把这个画面方向，用在你的生意</h3><p>${esc(item.description)}</p><label>创作要求</label><div class="home-detail-brief">${esc(item.prompt)}</div><small>图片用于构图与风格参考，不会作为你的门店、工厂或产品素材。接下来上传自己的原图或视频，补充真实经营信息。</small></div></div><footer class="modal-actions home-detail-actions">${button('home-favorite', icon('star') + (favorites.has(item.id) ? '已收藏' : '收藏灵感'), 'home-detail-favorite', `data-id="${esc(item.id)}" aria-pressed="${favorites.has(item.id)}"`)}${button('home-use-case', '用我的素材创作 ' + icon('arrow'), 'primary', `data-id="${esc(item.id)}"`)}</footer>`, true);
      break;
    }
    case 'home-use-case': {
      const item = inspirationItems.find(candidate => candidate.id === element.dataset.id);
      if (!item) break;
      if (item.presetId && ctx.selectImagePreset) {
        const files = selectedFilesFor('image', ctx);
        ctx.selectImagePreset(item.presetId, files.length ? { initialFiles: files } : {});
        break;
      }
      if (!validateTransfer(item.mode, item.prompt, ctx)) break;
      document.getElementById('modal')?.close();
      ctx.openBusinessFlow({ ...directionForItem(item), platform: selectedPlatform, mode: item.mode, prompt: item.prompt, initialFiles: selectedFilesFor(item.mode, ctx), newBrief: true });
      break;
    }
    default: return false;
  }
  return true;
}
