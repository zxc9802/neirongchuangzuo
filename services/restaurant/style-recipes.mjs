import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { RestaurantError, fingerprint } from './rules.mjs';

const assetRoot = new URL('./style-recipes/', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function photoSignature(bytes) {
  const image = sharp(bytes, { limitInputPixels: 40 * 1024 * 1024 }).autoOrient().flatten({ background: '#ffffff' }).toColourspace('srgb');
  const meta = await image.metadata();
  const rotated = [5, 6, 7, 8].includes(meta.orientation);
  const ratio = rotated ? meta.height / meta.width : meta.width / meta.height;
  const pixels = await image.resize(32, 32, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  return { hash: sha(bytes), ratio, pixels: pixels.toString('base64') };
}

function distance(a, b) {
  if (Math.abs(a.ratio - b.ratio) > .005) return Infinity;
  const x = Buffer.from(a.pixels, 'base64'), y = Buffer.from(b.pixels, 'base64');
  if (x.length !== 3072 || y.length !== x.length) return Infinity;
  let squared = 0;
  for (let i = 0; i < x.length; i++) squared += (x[i] - y[i]) ** 2;
  return Math.sqrt(squared / x.length) / 255;
}

export function createStyleRecipes({ manifestUrl = new URL('manifest.json', assetRoot) } = {}) {
  let loaded;
  const manifest = () => loaded ||= readFile(manifestUrl, 'utf8').then(JSON.parse);
  const asset = async (recipe, field) => {
    if (!/^[a-z0-9-]+\.jpg$/.test(recipe[field])) throw new Error('Invalid recipe asset');
    const path = new URL(recipe[field], manifestUrl);
    const bytes = await readFile(path);
    if (sha(bytes) !== recipe[`${field}Hash`]) throw new RestaurantError('图片风格参考文件不完整，请联系管理员。', 503, 'STYLE_REFERENCE_UNAVAILABLE');
    return { bytes, mime: 'image/jpeg', path: fileURLToPath(path) };
  };
  return {
    async match(sources) {
      const data = await manifest();
      if (!sources.length || sources.length > data.recipes.length) return null;
      const entries = [], used = new Set();
      for (const source of sources) {
        const signature = await photoSignature(source.bytes);
        const ranked = data.recipes.map(recipe => ({ recipe, error: signature.hash === recipe.signature.hash ? 0 : distance(signature, recipe.signature) })).sort((a, b) => a.error - b.error);
        const best = ranked[0];
        // Tolerate upload JPEG compression, but never match a different crop, scene or near-duplicate by its filename.
        if (!best || best.error > .018 || ranked[1]?.error - best.error < .012 || used.has(best.recipe.id)) return null;
        used.add(best.recipe.id);
        entries.push({ recipeId: best.recipe.id, sourceImageId: source.id, sourceHash: signature.hash });
      }
      entries.sort((a, b) => data.recipes.find(r => r.id === a.recipeId).order - data.recipes.find(r => r.id === b.recipeId).order);
      return { version: data.version, entries, fingerprint: fingerprint({ version: data.version, entries }) };
    },
    async plan(binding, outputCount) {
      const data = await manifest();
      if (!Number.isInteger(outputCount) || outputCount < 1 || outputCount > 30) throw new RestaurantError('请选择1—30张套图。', 400, 'INVALID_OUTPUT_COUNT');
      if (binding.version !== data.version) throw new RestaurantError('该图片风格方案已更新，请重新上传。', 409, 'STYLE_RECIPE_VERSION');
      if (outputCount > binding.entries.length) throw new RestaurantError(`这组照片对应${binding.entries.length}张成品，请减少张数。`, 422, 'INSUFFICIENT_GALLERY_MATERIAL');
      const selected = binding.entries.slice(0, outputCount);
      const shots = selected.map((entry, index) => {
        const recipe = data.recipes.find(r => r.id === entry.recipeId);
        if (!recipe) throw new RestaurantError('图片风格方案不可用。', 503, 'STYLE_RECIPE_UNAVAILABLE');
        return { imageId: `shot-${String(index + 1).padStart(2, '0')}`, sourceImageId: entry.sourceImageId, kind: recipe.analysis.imageType === 'food' ? 'food' : 'scene',
          shotIndex: index, name: recipe.title, purpose: recipe.purpose, angle: 'oblique', camera: recipe.framing,
          lighting: recipe.style.lighting, referenceImageIds: [], recipeId: recipe.id };
      });
      return { version: data.version, outputCount, theme: '实拍氛围摄影', source: 'approved-style', foodGroups: [], shots };
    },
    async analysis(binding) {
      const data = await manifest();
      return binding.entries.map(entry => ({ ...data.recipes.find(r => r.id === entry.recipeId).analysis, imageId: entry.sourceImageId }));
    },
    async render({ binding, shot, sources, model, taskId, attempt = 0, corrections = [], onBudgetWait }) {
      const data = await manifest();
      const entry = binding.entries.find(item => item.recipeId === shot.recipeId && item.sourceImageId === shot.sourceImageId);
      const recipe = data.recipes.find(item => item.id === shot.recipeId);
      const source = sources.find(item => item.id === shot.sourceImageId);
      if (binding.version !== data.version || !entry || !recipe || !source || sha(source.bytes) !== entry.sourceHash) throw new RestaurantError('原图与已选图片风格不匹配，请重新上传。', 409, 'STYLE_SOURCE_MISMATCH');
      if (recipe.processing === 'photo_enhancement') {
        const bytes = await sharp(source.bytes).autoOrient().modulate(recipe.adjustments.modulate).linear(...recipe.adjustments.linear)
          .resize(1080, 1440, { fit: 'contain', background: recipe.adjustments.background }).jpeg({ quality: 94 }).toBuffer();
        return { bytes, width: 1080, height: 1440, format: 'jpeg', composition: { sourceImageId: source.id, method: 'approved-photo-enhancement', recipeId: recipe.id, recipeVersion: data.version, generatedScene: false } };
      }
      if (!model.renderStylePhoto || !model.reviewStylePhoto) throw new RestaurantError('图片风格生成服务尚未配置。', 503, 'MODEL_NOT_CONFIGURED');
      const reference = await asset(recipe, 'reference');
      const context = [];
      for (const contextId of recipe.contextRecipeIds) {
        const contextEntry = binding.entries.find(item => item.recipeId === contextId);
        const contextSource = sources.find(item => item.id === contextEntry?.sourceImageId);
        if (contextSource) context.push(contextSource);
      }
      const rendered = await model.renderStylePhoto({ photo: source, reference, context, prompt: recipe.prompt, style: recipe.style,
        taskId, imageId: shot.imageId, recipeId: recipe.id, recipeVersion: data.version, attempt, corrections }, { onBudgetWait });
      const preview = async (photo, id) => ({ id, dataUrl: `data:image/jpeg;base64,${(await sharp(photo.bytes).resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()).toString('base64')}` });
      const review = await model.reviewStylePhoto({ style: recipe.style, sourceImageId: source.id, photos: [await preview(source, 'original'), await preview(reference, 'approved-style'), await preview(rendered, 'new-output')] }, { onBudgetWait });
      if (review.status !== 'passed') throw Object.assign(new RestaurantError('图片风格偏离参考，正在重新调整。', 502, 'STYLE_REVIEW_FAILED'), { corrections: review.issues, review });
      return { bytes: rendered.bytes, width: 1080, height: 1440, format: 'jpeg', composition: { sourceImageId: source.id, method: 'approved-style-edit', recipeId: recipe.id,
        recipeVersion: data.version, generatedScene: true, imageRequestId: rendered.requestId, provider: rendered.provider, styleReview: review } };
    },
  };
}
