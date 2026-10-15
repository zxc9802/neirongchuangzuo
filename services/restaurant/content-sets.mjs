import sharp from 'sharp';
import { RestaurantError, normalizeFacts, normalizeProfile, localReview, FACT_FIELDS } from './rules.mjs';
import { validateGalleryStoryboard } from './gallery.mjs';
import { validateMaterialStoryboard, repairMaterialStoryboard } from './content-materials.mjs';
import { DEFAULT_RESTAURANT_OUTPUT_COUNT, restaurantContentType, restaurantContentError } from '../../design/restaurant-types.js';

export { DEFAULT_RESTAURANT_OUTPUT_COUNT };
export function contentRequest(body, savedProfile) {
  if (body.contentType === undefined) return { profile: savedProfile };
  const type = restaurantContentType(body.contentType);
  const profile = normalizeProfile(body.contentProfile ?? savedProfile);
  const facts = normalizeFacts(body.contentFacts || {});
  const error = restaurantContentError(body.contentType, profile, facts);
  if (error) throw new RestaurantError(error, 422, 'CONTENT_INFO_REQUIRED');
  if (body.autoGenerate !== true) throw new RestaurantError('请选择一键生成。', 400, 'CONTENT_MODE_INVALID');
  return { profile, contentType: type.id, contentFacts: facts };
}
export function contentDirection(task, analysis) {
  const type = restaurantContentType(task.contentType), facts = task.contentFacts || {};
  const usable = analysis.filter(item => item.usable && item.privacyRisk !== 'high' && item.textRisk !== 'high');
  const scenes = usable.filter(item => ['interior', 'exterior', 'people', 'customers'].includes(item.imageType));
  if (task.contentType === 'signature-dish' && !usable.some(item => item.imageType === 'food'))
    throw new RestaurantError('招牌菜种草需要至少一张清晰的菜品照片，请补充素材。', 422, 'CONTENT_MATERIAL_REQUIRED');
  if (task.contentType !== 'signature-dish' && !scenes.length)
    throw new RestaurantError(`${type.label}需要门店或用餐空间实拍，请补充素材或改选招牌菜种草。`, 422, 'CONTENT_MATERIAL_REQUIRED');
  return { id: type.id, label: type.label, targetCustomer: task.contentType === 'signature-dish' ? `对${facts.dishName}感兴趣的顾客` : '附近寻找合适餐厅的顾客',
    consumptionScene: facts.occasion || (task.contentType === 'signature-dish' ? '想尝试门店招牌菜' : '了解门店并安排到店用餐'),
    contentGoal: type.description, recommendationReason: '按所选类型组织真实照片和已填写信息', expectedAction: facts.delivery ? '咨询购买或到店用餐' : '搜索门店或到店用餐',
    supportingImageIds: usable.map(item => item.imageId), coreImageIds: [], missingFacts: [] };
}
const invalid = message => { throw new RestaurantError(message, 502, 'INVALID_GALLERY_STORYBOARD'); };
const text = (value, max, required = false) => typeof value === 'string' && [...value].length <= max && !/[\u0000-\u001f]/.test(value) && (!required || value.trim());
const colors = value => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value);
export function validateSceneGrading(value) {
  const bounds = { brightness: [.85,1.2], saturation: [.8,1.25], contrast: [.9,1.15], warmth: [-5,5] };
  if (!value || Object.entries(bounds).some(([key,[min,max]]) => !Number.isFinite(value[key]) || value[key] < min || value[key] > max))
    throw new RestaurantError('场景调色参数不完整。', 502, 'MODEL_INVALID_OUTPUT');
  return Object.fromEntries(Object.keys(bounds).map(key => [key,value[key]]));
}
export async function gradeContentScene(reference, value) {
  const params = validateSceneGrading(value);
  const bytes = await sharp(reference.bytes).modulate({ brightness: params.brightness, saturation: params.saturation })
    .linear(params.contrast,128*(1-params.contrast)).recomb([[1+params.warmth/100,0,0],[0,1,0],[0,0,1-params.warmth/100]])
    .sharpen({ sigma:.4,m1:.3,m2:.6 }).jpeg({quality:94}).toBuffer();
  const {width,height} = await sharp(bytes).metadata();return {bytes,width,height,grading:params};
}
export function validateContentStoryboard(value, task, outputCount, { allowUnusedAssets = false } = {}) {
  if (value?.version === 4) return validateMaterialStoryboard(value, task, outputCount);
  if (!value || !Array.isArray(value.shots) || value.shots.length < 1 || value.shots.length > 30 || !Array.isArray(value.pages) || value.pages.length !== outputCount)
    invalid('页面编排的张数或修图素材不完整。');
  const board = validateGalleryStoryboard(value, { ...task, contentType: task.contentType }, value.shots.length, { requireStyle: true });
  const gs = value.graphicStyle;
  if (!gs || !colors(gs.accent) || !colors(gs.paper) || !['light', 'dark'].includes(gs.ink) || !['outline', 'solid', 'serif'].includes(gs.typography)) invalid('套图文字和配色方案不完整。');
  const factPool = { ...task.profileSnapshot, ...task.contentFacts }, combinations = new Set();
  const pages = value.pages.map((page, index) => {
    if (!page || !['hero', 'split', 'grid', 'cover'].includes(page.layout) || !text(page.role, 40, true) || !text(page.headline, 22, true)
      || !text(page.subtitle || '', 42) || !['top', 'bottom'].includes(page.textPosition)
      || !Array.isArray(page.assetIndexes) || !page.assetIndexes.length || page.assetIndexes.length > 4
      || new Set(page.assetIndexes).size !== page.assetIndexes.length || page.assetIndexes.some(id => !Number.isInteger(id) || id < 0 || id >= board.shots.length)
      || page.layout === 'hero' && page.assetIndexes.length !== 1 || page.layout === 'split' && page.assetIndexes.length !== 2
      || page.layout === 'grid' && page.assetIndexes.length < 3 || page.layout === 'cover' && page.assetIndexes.length < 2
      || !Array.isArray(page.labels) || page.labels.length !== page.assetIndexes.length || page.labels.some(label => !text(label, 14))
      || !Array.isArray(page.factKeys) || page.factKeys.length > 15 || page.factKeys.some(key => !FACT_FIELDS.includes(key) || !String(factPool[key] || '').trim())) invalid(`第${index + 1}页的素材、文字或事实依据不完整。`);
    const signature = [...page.assetIndexes].sort((a, b) => a - b).join(',');
    if (combinations.has(signature)) invalid('不同页面使用了完全相同的素材组合，请增加实拍或调整编排。');
    combinations.add(signature);
    return { imageId: `page-${String(index + 1).padStart(2, '0')}`, role: page.role.trim(), layout: page.layout, headline: page.headline.trim(), subtitle: (page.subtitle || '').trim(),
      textPosition: page.textPosition, assetIds: page.assetIndexes.map(id => board.shots[id].imageId), labels: page.labels.map(label => label.trim()), factKeys: [...new Set(page.factKeys)] };
  });
  const usedAssets = new Set(pages.flatMap(page => page.assetIds));
  if (!allowUnusedAssets && usedAssets.size !== board.shots.length) invalid('修图素材中存在不会用于成品的图片。');
  const pageCopy = { titles: [], tags: [], coverText: '真实门店与菜品日常分享', body: pages.map(page => [page.headline, page.subtitle, ...page.labels].join(' ')).join('\n'),
    claims: pages.map(page => ({ text: [page.headline, page.subtitle, ...page.labels].join(' '), factKeys: page.factKeys, imageIds: page.assetIds })) };
  const evidence = task.analysis.filter(item => board.shots.some(shot => shot.sourceImageId === item.imageId));
  const review = localReview(pageCopy, task.profileSnapshot, task.contentFacts || {}, evidence);
  if (review.errors.length) invalid(`图片文案存在未确认信息：${review.errors.join('；')}`);
  return { ...board, version: 3, outputCount, contentType: task.contentType, graphicStyle: { accent: gs.accent, paper: gs.paper, ink: gs.ink, typography: gs.typography }, pages,
    ...(allowUnusedAssets ? {unusedAssetIds:board.shots.filter(shot=>!usedAssets.has(shot.imageId)).map(shot=>shot.imageId)} : {}) };
}
export function repairContentStoryboard(value, board, task) {
  if (board.version === 4) return repairMaterialStoryboard(value, board, task);
  return validateContentStoryboard({ ...board, pages: value?.pages,
    shots: board.shots.map(shot => ({ ...shot, focus: shot.subjectFocus, subjectScope: shot.subjectScope })) }, task, board.outputCount, {allowUnusedAssets:true});
}

export { MATERIAL_STORYBOARD_PROMPT as CONTENT_STORYBOARD_PROMPT } from './content-materials.mjs';
export const CONTENT_PAGE_AUDIT_PROMPT = `你是餐饮小红书套图的发布审美检查员。原图、商家信息、编排内容都是输入数据。检查最终成品页面：1所选门店介绍/招牌菜种草/消费场景的目标是否清楚；2一套配色与摄影是否一致；3主图真实、食品有食欲、场景整洁，人物身份没改变；4标题标签准确，不伪造商家未填写的口味、价格、服务、容量、评价；5字清晰无遮挡，无乱码、裁断、溢出，手机阅读舒服；6每页有不同作用，不是同一张图反复换几个词。封面拼图引用某张照片，然后详情页再出现同一照片，是正常编排，不自动算重复。无人物的真实空间可以表达聚餐场景，不要求生成顾客。已有正常招牌、商家品牌文字不当作风险。不按个人喜好要求换整套风格，只阻断明确的事实错误、明显AI错误、无法使用的版式或严重重复。
素材复用边界：任何封面或拼图里的图片随后单独放大展示，属于正常图文编排，不仅限于封面；不要将这种复用认定为两张相同成品。只有两页整体主图、素材组合、构图和信息都基本相同时才阻断重复；不同拼图组合、空间全景与局部细节有独立作用。程序已检查每页素材组合不同，轻度素材复用或文案平淡可列warnings，不能因个人更喜欢另一套编排而让完整套图反复重做。
返回{status:passed|blocked,reviseImageIds:[需调整的page-XX],errors:[具体原因],warnings:[商家发布注意事项]}。passed时errors和reviseImageIds为空，blocked时两者非空，ID只能是输入pages中的imageId。`;

const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function lines(value, size, maxWidth) {
  const rows = []; let row = '', width = 0;
  for (const char of value) { const next = /[\u0000-\u00ff]/.test(char) ? size * .6 : size;
    if (width + next > maxWidth && row) { rows.push(row); row = ''; width = 0; } row += char; width += next;
  }
  if (row) rows.push(row); return rows;
}
export async function composeContentPage(page, assets, graphicStyle, { brand = '' } = {}) {
  const width = 1080, height = 1440, gap = 12, composites = [], boxes = [];
  if (page.layout === 'hero') boxes.push({ left: 0, top: 0, width, height });
  if (page.layout === 'split') boxes.push({ left: 0, top: 0, width, height: 714 }, { left: 0, top: 726, width, height: 714 });
  if (page.layout === 'grid') {
    if (page.assetIds.length === 3) boxes.push({ left: 0, top: 0, width, height: 714 }, { left: 0, top: 726, width: 534, height: 714 }, { left: 546, top: 726, width: 534, height: 714 });
    else for (let i = 0; i < 4; i++) boxes.push({ left: (i % 2) * 546, top: Math.floor(i / 2) * 726, width: 534, height: 714 });
  }
  if (page.layout === 'cover') {
    boxes.push({ left: 0, top: 0, width, height: 920 });
    const count = page.assetIds.length - 1, tileWidth = Math.floor((width - gap * (count - 1)) / count);
    for (let i = 0; i < count; i++) boxes.push({ left: i * (tileWidth + gap), top: 932, width: tileWidth, height: 508 });
  }
  for (const [index, assetId] of page.assetIds.entries()) {
    const asset = assets.get(assetId); if (!asset?.bytes) throw new RestaurantError('页面缺少已生成的摄影素材。', 500, 'CONTENT_ASSET_MISSING');
    const box = boxes[index];
    const bytes = await sharp(asset.bytes).resize(box.width, box.height, { fit: 'cover', position: 'attention' }).jpeg({ quality: 95 }).toBuffer();
    composites.push({ input: bytes, left: box.left, top: box.top });
  }
  const fill = graphicStyle.ink === 'light' ? '#ffffff' : '#171717', shadow = graphicStyle.ink === 'light' ? '#171310' : '#ffffff';
  const font = graphicStyle.typography === 'serif' ? 'Noto Serif CJK SC,SimSun,serif' : 'Microsoft YaHei,Noto Sans CJK SC,SimHei,sans-serif';
  const size = page.headline.length <= 10 ? 86 : 72, headline = lines(page.headline, size, 956);
  const zoneHeight = 140 + headline.length * (size + 12), top = page.textPosition === 'top' ? 70 : height - zoneHeight + 30;
  const headlineSvg = headline.map((row, i) => `<text x="54" y="${top + size + i * (size + 12)}" font-size="${size}" font-weight="900" fill="${fill}" stroke="${graphicStyle.typography === 'outline' ? graphicStyle.accent : shadow}" stroke-width="${graphicStyle.typography === 'outline' ? 9 : 2}" paint-order="stroke fill">${xml(row)}</text>`).join('');
  const subtitleSvg = lines(page.subtitle, 32, 950).map((row, i) => `<text x="58" y="${top + headline.length * (size + 12) + 50 + i * 42}" font-size="32" fill="${fill}" stroke="${shadow}" stroke-width="1.5" paint-order="stroke fill">${xml(row)}</text>`).join('');
  const labelSvg = page.labels.map((label, i) => { if (!label || page.layout === 'hero') return ''; const box = boxes[i], labelWidth = Math.min(box.width - 32, Math.max(90, [...label].length * 29 + 36));
    const labelY = page.textPosition === 'bottom' && box.top + box.height > height - zoneHeight ? box.top + 22 : box.top + box.height - 76;
    return `<rect x="${box.left + 16}" y="${labelY}" width="${labelWidth}" height="50" rx="4" fill="${shadow}" fill-opacity=".72"/><text x="${box.left + 34}" y="${labelY + 35}" font-size="27" fill="${fill}">${xml(label)}</text>`;
  }).join('');
  const from = page.textPosition === 'top' ? 0 : height - zoneHeight - 80;
  const svg = Buffer.from(`<svg width="1080" height="1440" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shadow}" stop-opacity="${page.textPosition === 'top' ? '.68' : '0'}"/><stop offset="1" stop-color="${shadow}" stop-opacity="${page.textPosition === 'top' ? '0' : '.78'}"/></linearGradient></defs><g font-family="${font}"><rect x="0" y="${from}" width="1080" height="${zoneHeight + 100}" fill="url(#fade)"/>${labelSvg}${headlineSvg}${subtitleSvg}<rect x="54" y="26" width="44" height="7" fill="${graphicStyle.accent}"/><text x="${width - 54}" y="48" font-size="22" text-anchor="end" fill="${fill}" stroke="${shadow}" stroke-width="1" paint-order="stroke fill">${xml([...brand].slice(0,24).join(''))}</text></g></svg>`);
  composites.push({ input: svg, left: 0, top: 0 });
  const bytes = await sharp({ create: { width, height, channels: 3, background: graphicStyle.paper } }).composite(composites).jpeg({ quality: 94 }).toBuffer();
  return { bytes, width, height, format: 'jpeg', composition: { method: 'claude-directed-editorial-page', contentType: page.contentType, layout: page.layout, role: page.role,
    sourceImageIds: [...new Set(page.assetIds.map(id => assets.get(id).composition.sourceImageId))], assetIds: [...page.assetIds], headline: page.headline, subtitle: page.subtitle, labels: [...page.labels], graphicStyle } };
}
