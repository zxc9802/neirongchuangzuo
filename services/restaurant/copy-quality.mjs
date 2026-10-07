// These checks reject observable repetition and process language. They do not score virality,
// invent missing facts, or replace the separate factual and privacy review.
const HAN = /\p{Script=Han}/gu;
const INTERNAL_LANGUAGE = /视觉线索|根据(?:这[些组张]?|所上传的)?(?:照片|图片)(?:识别|判断|分析|推断)|(?:AI|模型)(?:分析|识别|判断|生成)|无法确认|无法验证|仅供视觉参考|不猜菜名|不替(?:它|您|你)猜(?:菜名|口味)|(?:未提供|缺少|缺乏)(?:相关|具体|足够|门店|真实)?(?:信息|资料|菜名|价格|营业时间|证据)|(?:资料|信息)不足|避免(?:单凭图片)?猜测|为了避免编造|审核结果|风控(?:提示|审核|规则)|(?:照片|图片|画面)[^。！？!?\n]{0,50}(?:不能证明|不代表|不等于)|(?:这|这些)[^。！？!?\n]{0,50}(?:不能证明|不代表|不等于)[^。！？!?\n]{0,30}(?:座位|坐位|餐位|视野|观景|江景)|不代表店内(?:设有|有)?(?:观景|江景)(?:座位|餐位|位置|视野)/;
const PICTURE_REMINDER = /(?:看(?:看|一眼|一看)?(?!到|见)|翻看|浏览|对照).{0,12}(?:照片|图片|画面|实拍|外观|门头|门口|入口)|(?:收藏|保存).{0,10}(?:照片|图片|外观|门口|入口|门头)|(?:辨认|认准|认清|记住|确认).{0,10}(?:门口|入口|门头|外观)|(?:照片|图片|外观|门口|入口|门头).{0,12}(?:辨认|认准|认清|记住|收藏|保存|确认入口|找到门店)/;

const characters = value => [...value];
const hanCount = value => (value.match(HAN) ?? []).length;
const compact = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function withoutName(value, name) {
  const normalizedName = compact(name);
  if (!normalizedName) return value;
  // The same confirmed name can legitimately omit a middle dot or change Latin case.
  // Only formatting separators are allowed between its known characters.
  const pattern = characters(normalizedName).join('[\\p{P}\\p{S}\\s]*');
  return value.normalize('NFKC').toLowerCase().replace(new RegExp(pattern, 'gu'), '\0');
}
function grams(value, size) {
  const chars = characters(value), result = new Set();
  for (let index = 0; index <= chars.length - size; index++) result.add(chars.slice(index, index + size).join(''));
  return result;
}
function overlap(first, second, size = 3) {
  const left = grams(first, size), right = grams(second, size);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return 2 * shared / (left.size + right.size);
}
function duplicatedLongPhrase(body, name) {
  // Removing only the supplied store name keeps repeated branding from becoming an error.
  // The separator prevents separate fragments on either side of a name from forming a fake duplicate.
  const chunks = withoutName(body, name).split('\0').map(compact);
  const seen = new Map();
  let offset = 0;
  for (const chunk of chunks) {
    const chars = characters(chunk);
    for (let index = 0; index <= chars.length - 16; index++) {
      const phrase = chars.slice(index, index + 16).join('');
      if (hanCount(phrase) < 16) continue;
      const previous = seen.get(phrase), position = offset + index;
      if (previous !== undefined && position - previous >= 16) return true;
      if (previous === undefined) seen.set(phrase, position);
    }
    offset += chars.length + 1;
  }
  // Mixed Chinese/Latin text still has a meaningful whole-sentence comparison.
  const sentences = body.split(/[。！？!?；;\n]+/).map(sentence => compact(withoutName(sentence, name)));
  const sentenceSet = new Set();
  for (const sentence of sentences) {
    if (hanCount(sentence) < 16) continue;
    if (sentenceSet.has(sentence)) return true;
    sentenceSet.add(sentence);
  }
  return false;
}
function overlappingParagraphs(body, name) {
  const paragraphs = body.split(/\n+/).map(paragraph => compact(withoutName(paragraph, name)))
    .filter(paragraph => hanCount(paragraph) >= 40);
  for (let first = 0; first < paragraphs.length; first++) for (let second = first + 1; second < paragraphs.length; second++) {
    const lengths = [characters(paragraphs[first]).length, characters(paragraphs[second]).length];
    if (Math.max(...lengths) / Math.min(...lengths) <= 1.5 && overlap(paragraphs[first], paragraphs[second]) >= 0.78) return true;
  }
  return false;
}
function similarTitles(titles, name) {
  // Store names are shared context, not an angle. Other words are kept, rather than stripping
  // a keyword list which could collapse three different customer or dining scenarios.
  const normalized = titles.map(title => compact(withoutName(title, name)));
  for (let first = 0; first < normalized.length; first++) for (let second = first + 1; second < normalized.length; second++) {
    if (normalized[first] && normalized[first] === normalized[second]) return true;
    if (Math.min(characters(normalized[first]).length, characters(normalized[second]).length) < 8) continue;
    if (overlap(normalized[first], normalized[second], 2) >= 0.8) return true;
  }
  return false;
}

export function inspectCopyQuality(copy, { profile, analysis, direction } = {}) {
  const issues = [];
  if (!copy || typeof copy.body !== 'string' || !Array.isArray(copy.titles) || !copy.titles.every(title => typeof title === 'string')) {
    return { passed: false, issues: ['正文或标题格式无效，请先返回完整文案。'] };
  }
  const body = copy.body.trim(), name = typeof profile?.name === 'string' ? profile.name.trim() : '';
  const length = characters(body.replace(/\s/gu, '')).length;
  if (length < 250 || length > 500) issues.push(`正文目前${length}个非空白字符，请改写至250—500字符（含标点），不要重复句子凑字数。`);
  if (name && !compact(body).includes(compact(name))) issues.push('正文没有落到已确认的门店名称，请自然写明店名，方便顾客搜索和到店。');
  if (duplicatedLongPhrase(body, name)) issues.push('正文重复了至少16个汉字的长句或连续表述，请删除重复信息并用不同的真实内容展开。');
  else if (overlappingParagraphs(body, name)) issues.push('正文段落高度重叠，请让各段分别表达顾客场景、真实细节和到店行动。');
  const outwardText = [body, ...copy.titles, typeof copy.coverText === 'string' ? copy.coverText : '', ...(Array.isArray(copy.tags) ? copy.tags.filter(tag => typeof tag === 'string') : [])].join('\n');
  if (INTERNAL_LANGUAGE.test(outwardText)) issues.push('文案出现照片识别、信息缺失或审核分析口吻；这些内容应留在内部提示，改为老板自然分享。');
  const sentences = body.split(/[。！？!?；;\n]+/).map(sentence => sentence.trim()).filter(Boolean);
  const reminderSentences = sentences.filter(sentence => PICTURE_REMINDER.test(sentence));
  const reminderLength = reminderSentences.reduce((sum, sentence) => sum + characters(sentence.replace(/\s/gu, '')).length, 0);
  if (reminderSentences.length >= 3 && reminderLength / Math.max(1, length) >= 0.45) {
    // Do not require specific dishes, taste or prices from a sparse exterior-only photo set.
    const usable = Array.isArray(analysis) ? analysis.filter(item => item?.usable !== false) : [];
    const exteriorOnly = usable.length > 0 && usable.every(item => item.imageType === 'exterior');
    const subject = exteriorOnly ? '已有依据的外观细节与适合顾客的到店场景' : '已有依据的门店细节和具体消费场景';
    const audience = typeof direction?.targetCustomer === 'string' && direction.targetCustomer.trim() ? '所选目标顾客' : '顾客';
    issues.push(`正文大部分在反复提醒看照片、认入口或收藏外观；保留一次到店提示，围绕${audience}展开${subject}。`);
  }
  if (similarTitles(copy.titles, name)) issues.push('标题高度相似，主要是同一句话换词；请分别采用不同顾客、消费场景或真实细节的角度。');
  return { passed: issues.length === 0, issues };
}
