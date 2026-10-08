import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendationQualityIssues } from '../services/restaurant/recommendation-quality.mjs';

const photo = (index, imageType, extra = {}) => ({ imageId: `photo-${index}`, imageType, usable: true, privacyRisk: 'none', textRisk: 'none', ...extra });
const direction = (supportingImageIds, extra = {}) => ({
  id: 'D01', label: '附近上班族的午餐选择', contentGoal: '围绕真实面食品类介绍午餐选择',
  consumptionScene: '附近上班族安排午餐', supportingImageIds, ...extra,
});
const richPool = () => [
  ...Array.from({ length: 5 }, (_, index) => photo(index + 1, 'food', { visibleObjects: ['圆碗里的面条', '菜品近景'] })),
  ...Array.from({ length: 4 }, (_, index) => photo(index + 6, 'preparation', { visibleObjects: ['厨房操作台', '备料器具'] })),
  ...Array.from({ length: 3 }, (_, index) => photo(index + 10, 'interior', { visibleObjects: ['门内桌椅', '店内灯光'] })),
  photo(13, 'customers', { usable: false, privacyRisk: 'high' }),
  photo(14, 'exterior', { usable: false }),
];
const ids = (start, count) => Array.from({ length: count }, (_, index) => `photo-${start + index}`);
const check = (analysis, directions, unusedImages) => recommendationQualityIssues({ analysis, directions, unusedImages });

test('a fourteen-photo fixture with twelve usable layers flags a one-photo one-direction regression', () => {
  const issues = check(richPool(), [direction(['photo-1'])]);
  assert.equal(issues.length, 2);
  assert.ok(issues.some(issue => /12张/.test(issue) && /不同视觉内容/.test(issue)));
  assert.ok(issues.some(issue => /11张/.test(issue) && /核心、细节和场景候选/.test(issue)));
  assert.ok(issues.every(issue => !issue.includes('photo-13') && !issue.includes('photo-14')));
});

test('different evidence-backed consumption purposes with complete candidates need no extra directions', () => {
  const analysis = richPool();
  const directions = [
    direction(ids(1, 5)),
    direction(ids(6, 4), { id: 'D02', label: '老板分享门店备餐日常', contentGoal: '展示可见厨房工作场景', consumptionScene: '关注门店工作日常的附近顾客' }),
    direction(ids(10, 3), { id: 'D03', label: '约朋友来店里吃一顿面', contentGoal: '围绕真实店内布置发出约饭邀请', consumptionScene: '朋友碰面安排一顿饭' }),
  ];
  assert.deepEqual(check(analysis, directions), []);
});

test('the current five-usable-photo case still flags a single-photo result from three visual layers', () => {
  const analysis = [photo(1, 'food'), photo(2, 'food'), photo(3, 'preparation'), photo(4, 'interior'), photo(5, 'interior')];
  const issues = check(analysis, [direction(['photo-1'])]);
  assert.equal(issues.length, 2);
  assert.ok(issues.some(issue => /5张/.test(issue) && /只推荐1个方向/.test(issue)));
  assert.ok(issues.some(issue => /4张/.test(issue) && /没有具体原因/.test(issue)));
});

test('one photo and a single visual group do not mechanically require themes or more candidates', () => {
  assert.deepEqual(check([photo(1, 'food')], [direction(['photo-1'])]), []);
  assert.deepEqual(check(Array.from({ length: 14 }, (_, index) => photo(index + 1, 'food')), [direction(['photo-1'])]), []);
  assert.deepEqual(check([photo(1, 'preparation'), photo(2, 'staff'), photo(3, 'owner'), photo(4, 'staff'), photo(5, 'owner'), photo(6, 'preparation')], [direction(['photo-1'])]), []);
});

test('a rich six-photo pool can warrant a review of purposes even when its one direction covers all photos', () => {
  const analysis = [photo(1, 'food'), photo(2, 'food'), photo(3, 'food'), photo(4, 'interior'), photo(5, 'exterior'), photo(6, 'interior')];
  const issues = check(analysis, [direction(ids(1, 6))]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /复核是否支持不同目标顾客或消费场景/);
  assert.match(issues[0], /不必凑满方向数量/);
});

test('the same candidate pictures can serve genuinely different purposes without being treated as duplicates', () => {
  const candidates = ids(1, 12);
  const directions = [direction(candidates), direction(candidates, {
    id: 'D02', label: '老板给想碰面的朋友发个邀请', contentGoal: '邀请朋友围绕真实门店场景安排碰面', consumptionScene: '朋友见面约饭',
  })];
  assert.deepEqual(check(richPool(), directions), []);
});

test('only identical names, goals and consumption scenes flag duplicated purposes', () => {
  const analysis = richPool(), candidates = ids(1, 12);
  const issues = check(analysis, [direction(candidates), direction(candidates, { id: 'D02', label: '附近上班族的午餐选择！' })]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /名称、内容目的和消费场景完全相同/);
  assert.deepEqual(check(analysis, [direction(candidates), direction(candidates, { id: 'D02', consumptionScene: '下班后安排晚餐' })]), []);
  assert.deepEqual(check(analysis, [direction(candidates), direction(candidates, { id: 'D02', contentGoal: '介绍真实门店工作日常' })]), []);
});

test('specific duplicate-view, relevance and factual-conflict explanations avoid forced inclusion or extra themes', () => {
  const analysis = richPool();
  const unusedImages = analysis.filter(item => item.usable && item.imageId !== 'photo-1').map(item => ({ imageId: item.imageId,
    reason: item.imageType === 'food' ? '菜品近景和第一张是相同摆放角度，重复呈现同一碗面，缺少新的主题细节。'
      : item.imageType === 'preparation' ? '厨房备料只有操作台与器具，缺少工艺资料，不能独立支持本次午餐宣传事实。'
        : '门内桌椅显示另一家店的标识，与提供的门店名称不一致，无法确认照片来源。',
  }));
  assert.deepEqual(check(analysis, [direction(['photo-1'])], unusedImages), []);
});

test('vague, partial and irrelevant unused-image explanations do not waive obvious omissions', () => {
  const analysis = richPool(), chosen = [direction(['photo-1'])];
  const vague = analysis.filter(item => item.usable && item.imageId !== 'photo-1').map(item => ({ imageId: item.imageId, reason: '该照片与当前主题无关，因此本次不推荐使用。' }));
  assert.equal(check(analysis, chosen, vague).length, 2);
  const partial = ids(2, 4).map(imageId => ({ imageId, reason: '菜品近景和第一张是相同摆放角度，重复呈现同一碗面，缺少新的主题细节。' }));
  assert.ok(check(analysis, chosen, partial).some(issue => /7张/.test(issue) && /没有具体原因/.test(issue)));
  const wrong = [{ imageId: 'photo-999', reason: '厨房操作台与门店资料中的工艺说明冲突，不能采用。' }];
  assert.equal(check(analysis, chosen, wrong).length, 2);
});

test('multiple directions that all omit many usable photos still request complete relevant candidates', () => {
  const directions = [direction(['photo-1', 'photo-2']), direction(['photo-3'], { id: 'D02', label: '给朋友的晚饭邀约', contentGoal: '围绕可见菜品邀请朋友吃饭', consumptionScene: '朋友晚饭见面' })];
  const issues = check(richPool(), directions);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /全部方向各只有1—2张候选/);
  assert.match(issues[0], /9张/);
});

test('unusable, high-risk, invalid and unknown analysis cannot inflate the coverage or theme requirements', () => {
  const unknown = [photo(1, 'other'), photo(2, 'people'), photo(3, 'menu'), photo(4, 'unknown')];
  assert.deepEqual(check(unknown, [direction(ids(1, 4))]), []);
  assert.deepEqual(check([...unknown, ...Array.from({ length: 6 }, (_, index) => photo(index + 5, 'food'))], [direction(['photo-5'])]), []);
  assert.deepEqual(check([photo(1, 'food'), photo(2, 'preparation', { usable: false }), photo(3, 'interior', { privacyRisk: 'high' }), photo(4, 'customers', { textRisk: 'high' })], [direction(['photo-1'])]), []);
  assert.deepEqual(check([null, {}, 'bad', { usable: true, imageType: 'food' }, photo(1, 'food', { imageId: 'unsafe id' })], [direction(['photo-1'])]), []);
  assert.deepEqual(recommendationQualityIssues(), []);
  assert.deepEqual(check(null, null, null), []);
  assert.deepEqual(check(richPool(), [null, {}, 'bad']), []);
});

test('the helper is read-only and returns at most four actionable strings', () => {
  const input = { analysis: richPool(), directions: Array.from({ length: 12 }, (_, index) => direction(['photo-1'], { id: `D${index}` })), unusedImages: [] };
  const original = structuredClone(input);
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } }
  freeze(input);
  const issues = recommendationQualityIssues(input);
  assert.deepEqual(input, original);
  assert.ok(issues.length > 0 && issues.length <= 4);
  assert.ok(issues.every(issue => typeof issue === 'string' && issue.length > 0));
});
