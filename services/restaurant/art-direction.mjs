import sharp from 'sharp';
import { RestaurantError } from './rules.mjs';

const fail = message => { throw new RestaurantError(message, 502, 'INVALID_GALLERY_STYLE'); };
export function validateVisualStyle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('套图缺少统一摄影风格。');
  const result = {};
  for (const field of ['name', 'mood', 'lighting', 'tone', 'texture']) {
    const text = value[field];
    if (typeof text !== 'string' || !text.trim() || text.length > 300) fail(`套图摄影风格的${field}字段不完整。`);
    result[field] = text.trim();
  }
  if (value.instructions != null && (typeof value.instructions !== 'string' || value.instructions.length > 1200)) fail('套图摄影风格的instructions字段无效。');
  result.instructions = value.instructions?.trim() || [result.lighting, result.tone, result.texture].join('；');
  if (!Array.isArray(value.palette) || !value.palette.length || value.palette.length > 8
    || value.palette.some(color => typeof color !== 'string' || !color.trim() || color.length > 100)) fail('套图色彩方案不完整。');
  result.palette = value.palette.map(color => color.trim());
  return result;
}

export function validateGalleryImageReview(value) {
  const invalid = () => { throw new RestaurantError('图片审美检查未返回完整结果。', 502, 'MODEL_INVALID_OUTPUT'); };
  if (!value || !['passed', 'blocked'].includes(value.status) || !Number.isFinite(value.styleScore) || value.styleScore < 0 || value.styleScore > 100) invalid();
  const flags = ['identityMatch', 'sceneMatch', 'shotMatch', 'compositionUsable', 'styleMatch', 'marketingUseful'];
  if (flags.some(flag => typeof value[flag] !== 'boolean')) invalid();
  for (const field of ['errors', 'warnings']) if (!Array.isArray(value[field]) || value[field].length > 15
    || value[field].some(text => typeof text !== 'string' || !text.trim() || text.length > 600)) invalid();
  if (value.status === 'passed' && (flags.some(flag => !value[flag]) || value.errors.length)
    || value.status === 'blocked' && !value.errors.length) invalid();
  return { status: value.status, ...Object.fromEntries(flags.map(flag => [flag, value[flag]])), styleScore: value.styleScore,
    errors: [...value.errors], warnings: [...value.warnings] };
}

export function validateGallerySetReview(value, ids) {
  const invalid = () => { throw new RestaurantError('套图风格检查未返回完整结果。', 502, 'MODEL_INVALID_OUTPUT'); };
  if (!value || !['passed', 'blocked'].includes(value.status) || !Array.isArray(value.reviseImageIds)
    || new Set(value.reviseImageIds).size !== value.reviseImageIds.length || value.reviseImageIds.some(id => !ids.includes(id))) invalid();
  for (const field of ['errors', 'warnings']) if (!Array.isArray(value[field]) || value[field].length > 30
    || value[field].some(text => typeof text !== 'string' || !text.trim() || text.length > 600)) invalid();
  if (value.status === 'passed' && (value.errors.length || value.reviseImageIds.length)
    || value.status === 'blocked' && (!value.errors.length || !value.reviseImageIds.length)) invalid();
  return { status: value.status, reviseImageIds: [...value.reviseImageIds], errors: [...value.errors], warnings: [...value.warnings] };
}

export async function galleryContactSheets(photos, prefix = 'source') {
  const output = [], columns = 4, width = 240, height = 340, perPage = 12;
  for (let start = 0; start < photos.length; start += perPage) {
    const batch = photos.slice(start, start + perPage), composite = [];
    for (const [index, photo] of batch.entries()) {
      const image = await sharp(photo.bytes).autoOrient().resize(width, 310, { fit: 'contain', background: '#ededed' }).jpeg({ quality: 85 }).toBuffer();
      const label = String(photo.id).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
      const svg = Buffer.from(`<svg width="240" height="30"><text x="8" y="22" font-size="17" fill="#222">${label}</text></svg>`);
      const left = index % columns * width, top = Math.floor(index / columns) * height;
      composite.push({ input: image, left, top }, { input: svg, left, top: top + 310 });
    }
    const bytes = await sharp({ create: { width: columns * width, height: Math.ceil(batch.length / columns) * height, channels: 3, background: '#ededed' } })
      .composite(composite).jpeg({ quality: 88 }).toBuffer();
    output.push({ id: `${prefix}-sheet-${output.length + 1}`, bytes, mime: 'image/jpeg', imageIds: batch.map(photo => photo.id), dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` });
  }
  return output;
}

export function galleryEditPrompt({ style, shot, appearance, corrections = [], context = [] }) {
  return `Edit the FIRST reference photograph into a finished promotional photograph. Output one full-bleed 3:4 photograph without text overlays, collage, letterboxing or blurred filler borders.
The shared art direction below was selected by the creative director for this entire set. Follow it for this image; do not substitute a default bright/warm filter. Nightlife may remain moody, neon colors may remain vivid, and daylight may remain neutral when the selected direction requires it. Exposure and white balance must follow this direction and the source photograph, never a mandatory brightness increase.
SHARED STYLE: ${JSON.stringify(style)}
Keep the source's local distribution of light: a palette color is not permission to tint every surface or recolor existing light fixtures. White or warm bar lights must not become new purple lamps. Food may receive restrained, appetizing local fill light while retaining the surrounding time-of-day and atmosphere. Preserve factual lighting locations and avoid a global color wash.
THIS FRAME: ${JSON.stringify({ kind: shot.kind, name: shot.name, purpose: shot.purpose, camera: shot.camera, angle: shot.angle, lighting: shot.lighting, editInstructions: shot.editInstructions })}
${shot.kind === 'food' ? `Preserve the visible food and ingredient TYPES, recognizable form, main colors and vessel identity. Improve appetite, texture, presentation and photographic lighting; existing ingredient counts and arrangements may vary. Do not invent new dishes or ingredients. Never turn leftovers or an empty plate into a fictional full meal. Observed food identity: ${JSON.stringify(appearance)}.` : 'Preserve the actual establishment, architectural layout, signage, furniture types, people, faces and actions. Improve the photograph with the specified grading, exposure balance, perspective, framing and modest cleanup of incidental clutter. Do not redesign the shop, replace its decoration, add customers or regenerate a visible face. Keep real signage legible and accurate.'}
Any later photographs are contextual references, not additional subjects to copy into this frame. A reference labeled accepted-style-target-for-this-original is the previously approved finished version of this same photograph: preserve its palette and photographic mood while following the shared direction. Other references are real photographs of this business. Context: ${JSON.stringify(context)}. Keep the first image as the factual source. Reframe naturally while retaining necessary subjects; do not hide an unsuitable crop with blurred padding. No plastic texture, excessive sharpening or indiscriminate saturation.
${corrections.length ? `Required corrections from the aesthetic reviewer: ${JSON.stringify(corrections)}` : ''}`;
}
