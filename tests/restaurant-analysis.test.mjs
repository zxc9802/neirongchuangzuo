import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalysis } from '../services/restaurant/rules.mjs';

function photo(patch = {}) {
  return { imageId: 'photo-1', imageType: 'food', visibleObjects: ['圆碗里的面条'], possibleScene: ['午餐'], qualityScore: 80,
    privacyRisk: 'none', usable: true, rejectionReason: '', visibleTexts: [], textRisk: 'none', riskReasons: [], ...patch };
}
function validate(item) { return validateAnalysis({ images: [item] }, [item.imageId])[0]; }
const safeCrop = { left: 0, top: 0, width: 1, height: 0.8 };
const subjectBox = { left: 0.1, top: 0.1, width: 0.8, height: 0.6 };
const riskyTextBoxes = [{ left: 0, top: 0.85, width: 1, height: 0.1 }];

test('negative and advisory descriptions cannot promote a photo into severe text risk', () => {
  for (const patch of [
    { riskReasons: ['未发现电话、二维码或联系方式'] },
    { visibleTexts: ['没有私人手机号'], riskReasons: ['没有二维码风险'] },
    { textRisk: 'warning', riskReasons: ['气瓶上数字不完整，建议核实并避免提取联系方式'] },
  ]) {
    const original = photo(patch), snapshot = structuredClone(original), result = validate(original);
    assert.equal(result.usable, true); assert.equal(result.textRisk, original.textRisk);
    assert.equal(result.rejectionReason, ''); assert.deepEqual(original, snapshot);
  }
});

test('public store contacts and background codes remain usable with their declared warning', () => {
  for (const patch of [
    { visibleTexts: ['门店订餐电话 010-12345678'], riskReasons: ['公开门店电话，请发布前核对'] },
    { visibleTexts: ['服务热线'], riskReasons: ['公开服务热线，请核对'] },
    { visibleTexts: ['扫码点单'], riskReasons: ['背景有门店点单二维码，发布前请确认'] },
    { visibleTexts: ['微信支付'], riskReasons: ['背景支付二维码，请确认可公开使用'] },
    { riskReasons: ['背景有用途不明的二维码，文案不引用扫码信息'] },
    { visibleTexts: ['供应商品牌'], riskReasons: ['可见品牌文字，不能用作已验证宣传依据'] },
  ]) {
    const result = validate(photo({ ...patch, textRisk: 'warning' }));
    assert.equal(result.usable, true); assert.equal(result.textRisk, 'warning');
    assert.equal(result.rejectionReason, ''); assert.equal(result.crop, undefined);
  }
});

test('explicit severe text and privacy risks remain blocked without a valid safe crop', () => {
  for (const patch of [
    { textRisk: 'high', visibleTexts: ['个人姓名及私人手机号码'], riskReasons: ['主体展示具体私人联系方式，无法安全裁剪'] },
    { textRisk: 'high', visibleTexts: ['治疗疾病'], riskReasons: ['主体中的宣传文字声称治疗疾病，无法安全裁剪'] },
    { privacyRisk: 'high', riskReasons: ['照片中展示身份证和私人资料'] },
  ]) {
    const result = validate(photo(patch));
    assert.equal(result.usable, false); assert.ok(result.rejectionReason);
  }
  const croppedPrivateData = validate(photo({ privacyRisk: 'high', safeCrop, subjectBox, riskyTextBoxes }));
  assert.equal(croppedPrivateData.usable, false, 'a text crop must never approve severe privacy risk');
});

test('severe rejection preserves a specific model cause and its fallback does not blame ordinary codes', () => {
  const severeText = validate(photo({ textRisk: 'high' }));
  assert.equal(severeText.rejectionReason, '图片存在无法安全处理的私人敏感信息或严重宣传风险，请换图。');
  for (const patch of [
    { textRisk: 'high', rejectionReason: '主体广告明确宣传治疗疾病，且无法完整保留主体地裁除。' },
    { privacyRisk: 'high', rejectionReason: '桌上身份证号码清晰可见，请更换不含私人证件的素材。' },
  ]) assert.equal(validate(photo(patch)).rejectionReason, patch.rejectionReason);
});

test('safe cropping must retain at least seventy-five percent and every subject pixel', () => {
  const original = photo({ textRisk: 'high', visibleTexts: ['私人联系电话'], riskReasons: ['边缘纸条显示私人联系方式'], safeCrop, subjectBox, riskyTextBoxes });
  assert.equal(validate(original).usable, true);
  for (const patch of [
    { safeCrop: { ...safeCrop, height: 0.74 } },
    { subjectBox: { ...subjectBox, height: 0.85 } },
    { riskyTextBoxes: [{ left: 0, top: 0.7, width: 1, height: 0.1 }] },
    { subjectBox: null },
  ]) assert.equal(validate({ ...original, ...patch }).usable, false);
});

test('quality, relevance and explicit store conflicts retain their specific rejection reason', () => {
  for (const patch of [
    { qualityScore: 10, rejectionReason: '图片严重模糊，无法识别主要菜品。' },
    { imageType: 'other', rejectionReason: '照片与餐饮门店无关。' },
    { imageType: 'exterior', textRisk: 'warning', visibleTexts: ['广东肠粉', '订餐电话'], riskReasons: ['背景点单二维码需要确认'],
      rejectionReason: '主体门头显示广东肠粉，与门店资料桃园火锅的名称和主营品类明确不一致，请核对资料或更换本店照片。' },
  ]) {
    const original = photo({ ...patch, usable: false }), result = validate(original);
    assert.equal(result.usable, false); assert.equal(result.rejectionReason, original.rejectionReason);
    assert.equal(result.textRisk, original.textRisk);
  }
});

test('validating normalized analysis a second time preserves warnings, blocks and approved crops', () => {
  for (const original of [
    photo({ riskReasons: ['未发现电话和二维码'] }),
    photo({ textRisk: 'warning', visibleTexts: ['公开电话'], riskReasons: ['背景有点单二维码'] }),
    photo({ textRisk: 'high', riskReasons: ['私人敏感联系方式清晰可见'] }),
    photo({ textRisk: 'high', riskReasons: ['边缘私人联系方式需裁除'], safeCrop, subjectBox, riskyTextBoxes }),
    photo({ usable: false, textRisk: 'warning', rejectionReason: '可辨主体门头与资料明确不一致。', visibleTexts: ['电话'] }),
  ]) {
    const once = validate(original);
    assert.deepEqual(validate(once), once);
  }
});
