import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { foodPhotoPlan } from './scenes.mjs';
import { RestaurantError } from './rules.mjs';
import { preparePhotoPixels, inspectPhoto } from './images.mjs';

export const GALLERY_WORKFLOW = 'store-gallery-v1';
const sceneTypes = new Set(['interior', 'exterior', 'preparation', 'staff', 'owner', 'people', 'customers']);
function usableGalleryPool(task) {
  const hashes = new Set();
  return task.analysis.filter(item => {
    const source = task.sourceImages.find(photo => photo.id === item.imageId);
    if (!item.usable || item.privacyRisk === 'high' || item.textRisk === 'high' || !source || hashes.has(source.hash)) return false;
    hashes.add(source.hash);
    return item.imageType === 'food' || sceneTypes.has(item.imageType);
  }).sort((a, b) => b.qualityScore - a.qualityScore);
}
export function validateGalleryStoryboard(value, task, outputCount) {
  const fail = message => { throw new RestaurantError(message, 502, 'INVALID_GALLERY_STORYBOARD'); };
  const short = (text, max) => typeof text === 'string' && text.trim().length > 0 && text.length <= max;
  if (!value || !short(value.theme, 120) || !Array.isArray(value.foodGroups) || value.foodGroups.length > 60
    || !Array.isArray(value.shots) || value.shots.length !== outputCount) fail('套图编排的主题或张数不完整。');
  const pool = usableGalleryPool(task), excluded = new Set(task.foodReferenceExclusions || []);
  const foods = pool.filter(item => item.imageType === 'food' && !excluded.has(item.imageId));
  const scenes = pool.filter(item => sceneTypes.has(item.imageType));
  const groupIds = new Set();
  const foodGroups = value.foodGroups.map(group => {
    if (!short(group?.id, 60) || groupIds.has(group.id) || !short(group.label, 100) || !Array.isArray(group.imageIds)
      || !group.imageIds.length || group.imageIds.length > 60 || new Set(group.imageIds).size !== group.imageIds.length
      || group.imageIds.some(id => !foods.some(item => item.imageId === id))) fail('食品分组引用了不可用素材。');
    groupIds.add(group.id); return { id: group.id, label: group.label, imageIds: [...group.imageIds] };
  });
  const usedScenes = new Set(), counts = new Map();
  const environmentIds = pool.filter(item => item.imageType === 'interior' || ['customers','people'].includes(item.imageType)
    && /桌|餐位|座位|墙|室内|店内|餐厅|柜台|椅|凳/.test(item.visibleObjects.join(' '))).map(item => item.imageId);
  environmentIds.push(...pool.filter(item => item.imageType === 'exterior').map(item => item.imageId));
  const shots = value.shots.map((shot, index) => {
    if (!shot || !['food','scene'].includes(shot.kind) || !short(shot.name, 40) || !short(shot.purpose, 200)
      || !short(shot.camera, 400) || !short(shot.lighting, 200) || !['oblique','overhead','detail','table'].includes(shot.angle)) fail('套图分镜信息不完整。');
    const source = pool.find(item => item.imageId === shot.sourceImageId);
    if (!source || shot.kind === 'food' && (source.imageType !== 'food' || excluded.has(source.imageId))
      || shot.kind === 'scene' && (!sceneTypes.has(source.imageType) || usedScenes.has(source.imageId))) fail('套图分镜使用了无关、重复或不可用素材。');
    const group = foodGroups.find(item => item.id === shot.foodGroupId);
    if (shot.kind === 'food') {
      if (!group?.imageIds.includes(source.imageId) || !short(shot.focus, 160)) fail('食品分镜缺少对应的真实食品主体。');
      counts.set(group.id, (counts.get(group.id) || 0) + 1);
    } else usedScenes.add(source.imageId);
    return { imageId: `shot-${String(index + 1).padStart(2,'0')}`, sourceImageId: source.imageId, kind: shot.kind,
      shotIndex: index, name: shot.name, purpose: shot.purpose, ...(shot.kind === 'food' ? { foodGroupId: group.id, subjectFocus: shot.focus } : {}),
      angle: shot.angle, camera: shot.camera, lighting: shot.lighting, referenceImageIds: shot.kind === 'food' ? environmentIds.slice(0,2) : [] };
  });
  if (foods.length && shots[0]?.kind !== 'food') fail('首张应优先展示食品主视觉。');
  if (scenes.length + foodGroups.length * 3 >= outputCount && [...counts.values()].some(count => count > 3)) fail('同一食品主题重复过多，应使用其他实拍丰富套图。');
  for (const [id, count] of counts) {
    const frames = shots.filter(shot => shot.foodGroupId === id);
    if (count >= 3 && new Set(frames.map(shot => shot.angle)).size < 2) fail('同一食品主题的景别和机位过于重复。');
  }
  return { version: 1, outputCount, theme: value.theme, foodGroups, shots };
}
export function galleryDirection(analysis, profile) {
  const images = analysis.filter(item => item.usable && (item.imageType === 'food' || sceneTypes.has(item.imageType)));
  return { id: 'store-gallery', label: '菜品与门店的日常烟火气', targetCustomer: `想吃${profile.category || '餐饮'}的附近顾客`, consumptionScene: '日常用餐与朋友约饭',
    contentGoal: '以真实菜品、门店环境和服务场景组成一套有食欲的宣传图片', recommendationReason: '结合整组实拍展示菜品与门店氛围', expectedAction: '搜索门店或到店用餐',
    supportingImageIds: images.map(item => item.imageId), coreImageIds: [], missingFacts: [] };
}

export function createGalleryPlan(task, outputCount = 9) {
  if (!Number.isInteger(outputCount) || outputCount < 1 || outputCount > 30) throw new RestaurantError('请选择1—30张套图。', 400, 'INVALID_OUTPUT_COUNT');
  if (task.galleryStoryboard?.outputCount === outputCount) return task.galleryStoryboard.shots.map(shot => ({ ...shot, referenceImageIds: [...shot.referenceImageIds] }));
  const pool = usableGalleryPool(task);
  const excludedFoods = new Set(task.foodReferenceExclusions || []);
  const foods = pool.filter(item => item.imageType === 'food' && !excludedFoods.has(item.imageId));
  if (outputCount < 6) {
    const candidates = [...foods, ...pool.filter(item => sceneTypes.has(item.imageType))];
    if (candidates.length < outputCount) throw new RestaurantError(`当前只有${candidates.length}张不同的可用实拍，请减少成品张数。`, 422, 'INSUFFICIENT_GALLERY_MATERIAL');
    return candidates.slice(0, outputCount).map((item, index) => ({ imageId: `shot-${String(index + 1).padStart(2, '0')}`, sourceImageId: item.imageId,
      kind: item.imageType === 'food' ? 'food' : 'scene', shotIndex: index, referenceImageIds: [] }));
  }
  const interiors = pool.filter(item => item.imageType === 'interior');
  const exteriors = pool.filter(item => item.imageType === 'exterior');
  const service = pool.filter(item => ['preparation', 'staff', 'people', 'customers'].includes(item.imageType));
  // A dining-room photo with diners is still a genuine environment reference.
  const diningScenes = pool.filter(item => ['customers', 'people'].includes(item.imageType)
    && /桌|餐位|座位|墙|室内|店内|餐厅|柜台|椅|凳/.test((item.visibleObjects || []).join(' ')));
  const environments = [...interiors, ...diningScenes, ...exteriors];
  const foodLedNine = outputCount === 9 && foods.length > 0;
  const environment = interiors[0] || diningScenes[0];
  const context = foodLedNine
    ? [...exteriors.slice(0, 1), ...(environment ? [environment] : [])]
    : [...interiors.slice(0, 1), ...exteriors.slice(0, 1), ...service.slice(0, 1), ...interiors.slice(1, 2)];
  if (foodLedNine) {
    const varied = [...pool.filter(item=>item.imageType==='staff'), ...pool.filter(item=>item.imageType==='preparation'),
      ...service.filter(item=>!['people','customers'].includes(item.imageType) || /餐桌|用餐|菜品|制作|厨师|柜台|服务|接待/.test(item.visibleObjects.join(' ')))];
    for (const item of varied) if (!context.includes(item)) context.push(item);
  }
  const maxContext = foodLedNine ? Math.min(context.length, outputCount - 3) : foods.length ? Math.min(context.length, 3, outputCount - 3) : outputCount;
  const selectedContext = context.slice(0, maxContext);
  if (!foods.length) {
    const more = [...environments, ...service].filter(item => !selectedContext.includes(item));
    selectedContext.push(...more.slice(0, outputCount - selectedContext.length));
    if (selectedContext.length < outputCount) throw new RestaurantError('当前没有可重拍的菜品，门店实拍也不足以组成6张不同画面，请补充素材。', 422, 'INSUFFICIENT_GALLERY_MATERIAL');
  }
  const foodCount = outputCount - selectedContext.length;
  const shots = Array.from({ length: foodCount }, (_, index) => {
    const item = foods[index % foods.length];
    return { sourceImageId: item.imageId, kind: 'food', shotIndex: index, variation: Math.floor(index / foods.length),
      referenceImageIds: environments.slice(0, 2).map(image => image.imageId) };
  });
  // Food leads the set; real atmosphere and service break up consecutive dish views.
  selectedContext.forEach((item, index) => shots.splice(Math.min(shots.length, 2 + index * 2), 0,
    { sourceImageId: item.imageId, kind: 'scene', shotIndex: index, referenceImageIds: [] }));
  return shots.map((shot, index) => ({ ...shot, imageId: `shot-${String(index + 1).padStart(2, '0')}` }));
}

export function storeSceneContext(task, shot) {
  const images = shot.referenceImageIds.map(id => task.analysis.find(item => item.imageId === id)).filter(Boolean);
  return { sourceImageIds: images.map(item => item.imageId), evidence: images.map(item => ({ imageType: item.imageType, visibleObjects: item.visibleObjects })),
    look: '明亮、干净、整洁、暖白自然光、鲜明但不过饱和的食品摄影，同一门店的统一色调' };
}

export function galleryShot(scene, shot) {
  const fallback = foodPhotoPlan(scene, shot.shotIndex);
  return shot.camera ? { ...fallback, name: shot.name, camera: shot.camera, lighting: shot.lighting, angle: shot.angle,
    subjectFocus: shot.subjectFocus || '', purpose: shot.purpose } : fallback;
}

export async function prepareGalleryReference(bytes, analysis = {}) {
  const pixels = await preparePhotoPixels(bytes, { crop: analysis.crop });
  let pipeline = sharp(pixels.bytes);
  if ([90, 180, 270].includes(analysis.rotation)) pipeline = pipeline.rotate(analysis.rotation);
  const output = await pipeline.resize(1600, 2000, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer();
  return { bytes: output, mime: 'image/jpeg' };
}

export async function isolateDishReference(reference, appearance) {
  if (appearance.identityScope !== 'dish' || !appearance.subjectBox) return reference;
  const { width, height } = await sharp(reference.bytes).metadata();
  const box = appearance.subjectBox, pad = .025;
  const left = Math.max(0, Math.floor((box.left - pad) * width)), top = Math.max(0, Math.floor((box.top - pad) * height));
  const right = Math.min(width, Math.ceil((box.left + box.width + pad) * width)), bottom = Math.min(height, Math.ceil((box.top + box.height + pad) * height));
  const bytes = await sharp(reference.bytes).extract({ left, top, width: right - left, height: bottom - top }).jpeg({ quality: 94 }).toBuffer();
  return { ...reference, bytes, mime: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` };
}

export async function enhanceStorePhoto(bytes, analysis = {}) {
  const prepared = await preparePhotoPixels(bytes, { crop: analysis.crop });
  const metadata = await inspectPhoto(prepared.bytes);
  const brightness = Math.max(1.06, Math.min(1.38, 146 / Math.max(1, metadata.quality.brightness)));
  let pipeline = sharp(prepared.bytes);
  if ([90, 180, 270].includes(analysis.rotation)) pipeline = pipeline.rotate(analysis.rotation);
  const enhanced = await pipeline.modulate({ brightness, saturation: 1.14 }).linear(1.035, -3)
    .sharpen({ sigma: .5, m1: .4, m2: 1.1 }).resize(1080, 1440, { fit: 'inside' }).jpeg({ quality: 94 }).toBuffer();
  const info = await sharp(enhanced).metadata();
  const canvas = await sharp(enhanced).resize(1080, 1440, { fit: 'cover' }).blur(25).modulate({ brightness: 1.025 }).toBuffer();
  const result = await sharp(canvas).composite([{ input: enhanced, left: Math.floor((1080 - info.width) / 2), top: Math.floor((1440 - info.height) / 2) }])
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toBuffer();
  return { bytes: result, width: 1080, height: 1440, format: 'jpeg', composition: { version: GALLERY_WORKFLOW, method: 'store-photo-enhancement',
    sourceImageId: analysis.imageId, sourceHash: createHash('sha256').update(bytes).digest('hex'), generatedScene: false,
    enhancement: { brightness, saturation: 1.14 }, rotation: analysis.rotation || 0 } };
}
