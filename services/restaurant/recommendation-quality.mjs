const GROUPS = Object.freeze({
  food: '菜品',
  preparation: '制作与门店工作', staff: '制作与门店工作', owner: '制作与门店工作',
  interior: '店内外环境', exterior: '店内外环境',
  customers: '顾客消费场景',
});
const compact = value => typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '') : '';
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const genericReason = /(?:这张|该张|本张|当前|本次|这组|这个|暂时|照片|图片|图像|画面|素材|主题|方向|内容|餐饮|图文|成品|要求|相关性|直接|关系|关联|建议|考虑|选中|采用|推荐|保留|使用|匹配|适合|无关|不相关|相关|必要|不符合|不一致|符合|因为|因此|所以|不|与|没有|无需|不足|其它|其他)/gu;
const exclusion = /缺少|缺乏|无法|不能|未经|未确认|未获|未提供|不一致|不相符|不符合|不适合|不支持|不相关|无关|冲突|重复|重叠|模糊|仅|只|不同|不依赖|没有/;
const context = /菜|餐|食|厨房|备料|制作|切菜|揉面|出餐|员工|老板|操作|工作|门头|门店|店内|店外|室内|室外|桌|椅|灯|夜|顾客|客人|儿童|人脸|授权|隐私|工艺|价格|套餐|店名|名称|营业|地址|时间|资料|商圈|来源|水印|二维码/;

function explained(reason, image) {
  if (typeof reason !== 'string') return false;
  const text = reason.trim();
  if ([...text].length < 12) return false;
  const detail = compact(text).replace(genericReason, '');
  if ([...detail].length < 8) return false;
  const visible = Array.isArray(image.visibleObjects) ? image.visibleObjects : [];
  const refersToObject = visible.some(object => typeof object === 'string' && compact(object).length >= 3 && compact(text).includes(compact(object)));
  return exclusion.test(text) && (context.test(text) || refersToObject);
}

function usableImages(analysis) {
  const images = new Map();
  for (const item of Array.isArray(analysis) ? analysis : []) {
    // Unknown people, other and menu records do not establish an independent
    // consumption theme. Roles and usable status must already be confirmed.
    if (!item || item.usable !== true || !identifier(item.imageId) || !Object.hasOwn(GROUPS, item.imageType)
      || item.privacyRisk === 'high' || item.textRisk === 'high' || images.has(item.imageId)) continue;
    images.set(item.imageId, item);
  }
  return images;
}

/** Soft review hints only: the model must decide which real themes and photos fit. */
export function recommendationQualityIssues({ directions, analysis, unusedImages = [] } = {}) {
  const images = usableImages(analysis);
  const choices = (Array.isArray(directions) ? directions : []).filter(item => item && typeof item === 'object'
    && ['label', 'contentGoal', 'consumptionScene'].every(field => compact(item[field]))
    && Array.isArray(item.supportingImageIds) && item.supportingImageIds.some(id => images.has(id)));
  if (!images.size || !choices.length) return [];

  const candidateIds = choices.map(item => new Set(item.supportingImageIds.filter(id => images.has(id))));
  const covered = new Set(candidateIds.flatMap(ids => [...ids]));
  const omitted = [...images.values()].filter(image => !covered.has(image.imageId));
  const reasons = new Map();
  for (const item of Array.isArray(unusedImages) ? unusedImages : []) {
    if (!item || !images.has(item.imageId) || covered.has(item.imageId) || reasons.has(item.imageId)) continue;
    if (explained(item.reason, images.get(item.imageId))) reasons.set(item.imageId, item.reason);
  }
  const unexplained = omitted.filter(image => !reasons.has(image.imageId));
  const relevant = [...images.values()].filter(image => !reasons.has(image.imageId));
  const groups = [...new Set(relevant.map(image => GROUPS[image.imageType]))];
  const issues = [];

  if (choices.length === 1 && (relevant.length >= 6 && groups.length >= 2 || relevant.length >= 5 && groups.length >= 3)) {
    issues.push(`当前有${relevant.length}张可用且未说明排除理由的照片，包含${groups.join('、')}等不同视觉内容，却只推荐1个方向。请复核是否支持不同目标顾客或消费场景的主题；依据不足时保留1个方向，并具体说明其他素材的相关性或资料冲突，不必凑满方向数量。`);
  }
  if (groups.length >= 2 && unexplained.length >= 4 && candidateIds.every(ids => ids.size <= 2)) {
    issues.push(`全部方向各只有1—2张候选，还有${unexplained.length}张可用照片（${unexplained.slice(0, 6).map(image => image.imageId).join('、')}${unexplained.length > 6 ? '等' : ''}）未被采用且没有具体原因。请为有依据的主题补充核心、细节和场景候选，或逐张说明为何与该主题无关、存在资料冲突；候选素材应由真实内容支持。`);
  }

  const purposes = new Map();
  choices.forEach((item, index) => {
    const key = JSON.stringify(['label', 'contentGoal', 'consumptionScene'].map(field => compact(item[field])));
    purposes.set(key, [...(purposes.get(key) || []), index + 1]);
  });
  const duplicates = [...purposes.values()].filter(indices => indices.length > 1);
  if (duplicates.length) issues.push(`第${duplicates.map(indices => indices.join('、')).join('组和第')}组方向的名称、内容目的和消费场景完全相同。请合并重复方向，或依据真实信息明确不同消费目的；相同照片可以支持不同方向，不需要为了区分方向更换图片。`);
  return issues.slice(0, 4);
}
