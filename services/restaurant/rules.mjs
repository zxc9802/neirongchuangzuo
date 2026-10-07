import { createHash } from 'node:crypto';

export class RestaurantError extends Error {
  constructor(message, statusCode = 400, code = 'INVALID_REQUEST') { super(message); this.statusCode = statusCode; this.code = code; }
}
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const PROFILE_FIELDS = ['name', 'city', 'address', 'category', 'hours', 'signatureDishes', 'averagePrice', 'parking', 'groupBuy', 'features', 'history', 'craft', 'ingredients'];
export const FACT_FIELDS = [...PROFILE_FIELDS, 'dishName', 'price', 'ingredients', 'portion', 'taste', 'setMeal', 'conditions', 'verifiedHistory'];
const bad = message => { throw new RestaurantError(message, 502, 'MODEL_INVALID_OUTPUT'); };
const text = (value, maximum = 3000) => typeof value === 'string' && value.length <= maximum;
const strings = (value, maximum = 20) => Array.isArray(value) && value.length <= maximum && value.every(item => text(item, 500));
function rectangle(value) {
  return value && typeof value === 'object' && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(value[key]))
    && value.left >= 0 && value.top >= 0 && value.width > 0 && value.height > 0 && value.left + value.width <= 1.001 && value.top + value.height <= 1.001;
}
function checkedSafeCrop(item) {
  if (!rectangle(item.safeCrop) || !rectangle(item.subjectBox) || !Array.isArray(item.riskyTextBoxes) || !item.riskyTextBoxes.length || !item.riskyTextBoxes.every(rectangle)) return null;
  const crop = item.safeCrop, subject = item.subjectBox;
  if (crop.width * crop.height < 0.75 || subject.left < crop.left || subject.top < crop.top || subject.left + subject.width > crop.left + crop.width || subject.top + subject.height > crop.top + crop.height) return null;
  const overlaps = box => box.left < crop.left + crop.width && box.left + box.width > crop.left && box.top < crop.top + crop.height && box.top + box.height > crop.top;
  if (item.riskyTextBoxes.some(overlaps)) return null;
  return Object.fromEntries(['left', 'top', 'width', 'height'].map(key => [key, crop[key]]));
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function normalizeProfile(body) {
  const source = body?.profile ?? body;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new RestaurantError('请填写门店资料。');
  const profile = {};
  for (const field of PROFILE_FIELDS) {
    const value = source[field] ?? '';
    if (!text(value, ['features', 'groupBuy', 'signatureDishes'].includes(field) ? 2000 : 500)) throw new RestaurantError('门店资料过长或格式不正确。');
    profile[field] = value.trim();
  }
  return profile;
}
export function requireProfile(profile) {
  const missing = ['name', 'city', 'address', 'category'].filter(key => !profile?.[key]?.trim());
  if (missing.length) throw Object.assign(new RestaurantError('请先补齐门店名称、城市或商圈、地址和主营品类。', 422, 'PROFILE_INCOMPLETE'), { missingFields: missing });
}
export function normalizeFacts(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RestaurantError('补充资料格式不正确。');
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!FACT_FIELDS.includes(key) || !text(entry, 2000)) throw new RestaurantError('补充资料字段不支持或过长。');
    if (entry.trim()) output[key] = entry.trim();
  }
  return output;
}
const groupBuyDirection = direction => /团购|套餐优惠|优惠套餐|折扣/.test(`${direction.label}${direction.contentGoal}`);
export function resolveDirectionFacts(direction, profile, supplied = {}) {
  if (!groupBuyDirection(direction)) return supplied;
  const description = profile.groupBuy ?? '';
  const extracted = {
    setMeal: /(?:套餐(?:内容)?|包含)\s*[:：]\s*([^;；\n]+)/.exec(description)?.[1]?.trim(),
    price: /(?:价格|团购价)\s*[:：]?\s*(\d+(?:\.\d+)?)(?:\s*元)?/.exec(description)?.[1],
    conditions: /(?:使用条件|使用规则)\s*[:：]\s*([^;；\n]+)/.exec(description)?.[1]?.trim(),
  };
  return { ...Object.fromEntries(Object.entries(extracted).filter(([, value]) => value)), ...supplied };
}
function missing(value) {
  if (!Array.isArray(value) || value.length > 12) bad('模型缺失事实格式不正确。');
  return value.map(item => {
    if (!item || !FACT_FIELDS.includes(item.field) || typeof item.requiredForGeneration !== 'boolean' || !text(item.reason, 400) || !text(item.supportedAlternative ?? '', 200)) bad('模型缺失事实字段不正确。');
    return { field: item.field, requiredForGeneration: item.requiredForGeneration, reason: item.reason, supportedAlternative: item.supportedAlternative ?? '' };
  });
}
export function validateAnalysis(value, imageIds) {
  if (!Array.isArray(value?.images) || value.images.length !== imageIds.length) bad('模型未返回全部照片的分析。');
  const seen = new Set();
  const output = value.images.map(item => {
    if (!item || !imageIds.includes(item.imageId) || seen.has(item.imageId)
      || !['food', 'interior', 'exterior', 'people', 'customers', 'staff', 'owner', 'preparation', 'menu', 'other'].includes(item.imageType)
      || !strings(item.visibleObjects) || !strings(item.possibleScene, 8)
      || !Number.isFinite(item.qualityScore) || item.qualityScore < 0 || item.qualityScore > 100
      || !['none', 'low', 'high'].includes(item.privacyRisk) || typeof item.usable !== 'boolean'
      || !text(item.rejectionReason, 400) || !strings(item.visibleTexts ?? [], 15)
      || !['none', 'warning', 'high'].includes(item.textRisk) || !strings(item.riskReasons ?? [], 12)) bad('模型照片分析数据不符合格式。');
    seen.add(item.imageId);
    const crop = checkedSafeCrop(item);
    const contactRisk = /二维码|电话|手机号|联系方式/.test(`${(item.visibleTexts ?? []).join(' ')} ${(item.riskReasons ?? []).join(' ')}`);
    const unsafeText = (item.textRisk === 'high' || contactRisk) && !crop;
    return { imageId: item.imageId, imageType: item.imageType, visibleObjects: item.visibleObjects, possibleScene: item.possibleScene, qualityScore: item.qualityScore,
      privacyRisk: item.privacyRisk, usable: item.usable && item.privacyRisk !== 'high' && !unsafeText,
      rejectionReason: item.privacyRisk === 'high' ? '照片存在严重隐私风险，请换用已获授权且风险可控的素材。' : unsafeText ? '图片存在无法安全裁剪的联系方式、二维码或严重宣传风险，请换图。' : item.rejectionReason,
      visibleTexts: item.visibleTexts ?? [], textRisk: crop ? 'none' : unsafeText ? 'high' : item.textRisk, riskReasons: item.riskReasons ?? [],
      ...(crop ? { crop, safeCrop: item.safeCrop, subjectBox: item.subjectBox, riskyTextBoxes: item.riskyTextBoxes, cropReason: '保留至少75%画面及完整主体，裁除画面边缘风险文字。' } : {}) };
  });
  return output;
}
export function validateDirections(value, analysis, profile) {
  if (!Array.isArray(value?.directions) || value.directions.length > 4) bad('模型推荐方向数量不正确。');
  const usable = new Set(analysis.filter(item => item.usable).map(item => item.imageId));
  const ids = new Set();
  return value.directions.map((item, index) => {
    if (!item || !['id', 'label', 'targetCustomer', 'consumptionScene', 'contentGoal', 'recommendationReason', 'expectedAction'].every(key => text(item[key], 600) && item[key].trim())
      || !/^[A-Za-z0-9_-]{1,40}$/.test(item.id) || ids.has(item.id)
      || !strings(item.supportingImageIds, 9) || !item.supportingImageIds.length || item.supportingImageIds.some(id => !usable.has(id))
      || new Set(item.supportingImageIds).size !== item.supportingImageIds.length) bad('模型推荐引用了不可用照片或缺少必要字段。');
    ids.add(item.id);
    const facts = missing(item.missingFacts);
    // Historical lettering is not a required fact for an ordinary dish or store scene.
    const historyDirection = /历史|老店|年头|传承|老字号/.test(`${item.label}${item.contentGoal}`);
    for (const entry of facts) if (['history', 'verifiedHistory'].includes(entry.field) && !historyDirection) entry.requiredForGeneration = false;
    if (groupBuyDirection(item)) {
      const known = resolveDirectionFacts(item, profile);
      for (const [field, label] of [['setMeal', '套餐内容'], ['price', '真实团购价格'], ['conditions', '使用条件']]) {
        const existing = facts.find(entry => entry.field === field);
        if (!known[field]) {
          if (existing) existing.requiredForGeneration = true;
          else facts.push({ field, requiredForGeneration: true, reason: `团购方向需要确认${label}，仅写“有团购”不足以生成。`, supportedAlternative: '门店环境或真实菜品分享' });
        }
      }
    }
    const alreadyKnown = { ...profile, ...resolveDirectionFacts(item, profile) };
    return { ...Object.fromEntries(['id', 'label', 'targetCustomer', 'consumptionScene', 'contentGoal', 'recommendationReason', 'expectedAction'].map(key => [key, item[key].trim()])), supportingImageIds: item.supportingImageIds,
      missingFacts: facts.filter(entry => !alreadyKnown[entry.field]?.trim()), index };
  });
}
export function pendingFacts(direction, profile, supplied) {
  const facts = { ...profile, ...resolveDirectionFacts(direction, profile, supplied) };
  return direction.missingFacts.filter(item => item.requiredForGeneration && !facts[item.field]?.trim()
    && !(item.field === 'groupBuy' && ['setMeal', 'price', 'conditions'].every(field => facts[field]?.trim())));
}
export function validateCopy(value, imageIds) {
  const titles = Array.isArray(value?.titles) ? value.titles.map(item => typeof item === 'string' ? item.trim() : item) : null;
  const tags = Array.isArray(value?.tags) ? value.tags.map(item => typeof item === 'string' ? item.trim().replace(/^#/, '').trim() : item) : null;
  if (!value || !strings(value.titles, 3) || value.titles.length !== 3 || new Set(value.titles).size !== 3
    || !text(value.body, 3000) || !value.body.trim() || !strings(value.tags, 8) || value.tags.length < 5
    || titles.some(item => !item) || new Set(titles).size !== 3 || tags.some(item => !item || /\s|#/.test(item)) || new Set(tags).size !== tags.length
    || !text(value.coverText, 40) || !value.coverText.trim() || !strings(value.imageOrder, 9) || !value.imageOrder.length
    || value.imageOrder.some(id => !imageIds.includes(id)) || new Set(value.imageOrder).size !== value.imageOrder.length
    || !Array.isArray(value.claims) || value.claims.length > 30) bad('模型发布文案不符合约定格式。');
  for (const claim of value.claims) if (!text(claim?.text, 500) || !claim.text.trim() || !strings(claim.factKeys, 15) || claim.factKeys.some(key => !FACT_FIELDS.includes(key)) || !strings(claim.imageIds, 9) || claim.imageIds.some(id => !imageIds.includes(id)) || (!claim.factKeys.length && !claim.imageIds.length)) bad('文案事实缺少可追踪依据。');
  return { titles, body: value.body.trim(), tags, coverText: value.coverText.trim(), imageOrder: value.imageOrder, claims: value.claims };
}
const ABSOLUTE = /全网第一|当地第一|最好吃|必吃|百分百|100[%％]|保证|一定|绝对|天天排队|场场爆满|明星来过|销量第一|回头客最多|顾客一致好评|减肥|养生|治疗|改善疾病|治愈|零添加|有机|非遗|独家配方|网红店|今天来探店|亲测|我来探店/;
const CONDITIONAL = ['纯手工', '现杀', '现做', '当天采购', '进口', '手工', '新鲜', '预制', '冷冻'];
export function localReview(copy, profile, facts, selectedAnalysis) {
  const errors = [], warnings = [];
  const all = `${copy.titles.join('\n')}\n${copy.coverText}\n${copy.body}\n${copy.tags.join(' ')}`;
  const confirmed = { ...profile, ...facts };
  if (ABSOLUTE.test(all)) errors.push('文案含夸张、绝对化、健康功效或顾客探店表述。');
  for (const word of CONDITIONAL) if (all.includes(word) && !JSON.stringify({ profile, facts }).includes(word)) errors.push(`“${word}”缺少已确认的门店资料依据。`);
  const unitFields = { 元: ['price', 'averagePrice', 'groupBuy', 'setMeal', 'conditions'], 块: ['price', 'averagePrice', 'groupBuy', 'setMeal'], 折: ['groupBuy', 'conditions'], 年: ['verifiedHistory'], 份: ['portion', 'setMeal'], 位: ['portion', 'setMeal', 'features'], 点: ['hours', 'conditions'], ':': ['hours', 'conditions'] };
  for (const match of all.matchAll(/(\d+(?:\.\d+)?)\s*(元|块|折|年|份|位|点|:)/g)) {
    const supported = unitFields[match[2]].some(key => {
      const numeric = String(confirmed[key] ?? '').match(/\d+(?:\.\d+)?/g) ?? [];
      return numeric.includes(match[1]) && copy.claims.some(claim => claim.factKeys.includes(key) && claim.text.includes(match[1]));
    });
    if (!supported) errors.push(`“${match[0]}”缺少对应的已确认事实依据。`);
  }
  for (const claim of copy.claims) for (const key of claim.factKeys) if (!({ ...profile, ...facts })[key]?.trim()) errors.push(`文案引用了尚未确认的${key}信息。`);
  if (selectedAnalysis.some(item => !item.usable || item.privacyRisk === 'high' || item.textRisk === 'high')) errors.push('存在不可用图片或未处理的严重隐私风险。');
  if (selectedAnalysis.some(item => item.privacyRisk === 'low' || item.textRisk === 'warning')) warnings.push('部分图片含人物或宣传文字，请确认授权与文字真实性后发布。');
  if (/进口|认证|资质|排名|经营\d+年|\d{4}年/.test(all)) warnings.push('文案涉及来源、资质或经营历史，请核对证明资料与真实性。');
  if (copy.titles.some(title => [...title].length < 12 || [...title].length > 22)) warnings.push('部分标题超出建议的12—22字，请发布前核对。');
  if ([...copy.body].length < 250 || [...copy.body].length > 500) warnings.push('正文长度超出建议的250—500字，请发布前核对。');
  const coverHan = [...copy.coverText].filter(char => /\p{Script=Han}/u.test(char)).length;
  if (coverHan < 8 || coverHan > 16 || [...copy.coverText].length > 24) errors.push('封面文字需要控制在8—16个汉字，不超过24个字符。');
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
export function validateAudit(value) {
  if (!value || !['passed', 'passed_with_warning', 'blocked'].includes(value.status) || !strings(value.warnings, 20) || !strings(value.errors, 20)) bad('模型发布前检查结果不符合格式。');
  if (value.status === 'blocked' && !value.errors.length) bad('模型阻断原因缺失。');
  if (value.status === 'passed_with_warning' && !value.warnings.length) bad('模型人工确认项缺失。');
  return { status: value.status, warnings: value.warnings, errors: value.errors };
}
