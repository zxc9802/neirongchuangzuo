import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';
import { createHash } from 'node:crypto';

const MAX_PIXELS = 32 * 1024 * 1024;
const ALLOWED = new Set(['jpeg', 'png', 'webp']);
const problem = message => Object.assign(new Error(message), { code: 'invalid_image', statusCode: 400, status: 400 });
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const input = bytes => sharp(bytes, { failOn: 'error', limitInputPixels: MAX_PIXELS });
const escapeXml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

export async function inspectPhoto(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8 * 1024 * 1024) throw problem('每张照片应为不超过8MB的PNG、JPEG或WebP。');
    const metadata = await input(bytes).metadata();
    if (!ALLOWED.has(metadata.format) || !metadata.width || !metadata.height || (metadata.pages || 1) !== 1
      || metadata.width * metadata.height > MAX_PIXELS || metadata.width < 120 || metadata.height < 120) throw problem('请选择尺寸至少120像素的静态PNG、JPEG或WebP照片。');
    const { data, info } = await input(bytes).autoOrient().resize(96, 96, { fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    let sum = 0, square = 0, gradient = 0, pairs = 0;
    for (let i = 0; i < data.length; i++) { sum += data[i]; square += data[i] ** 2; }
    for (let y = 1; y < info.height; y++) for (let x = 1; x < info.width; x++) {
      const at = (y * info.width + x) * info.channels;
      gradient += Math.abs(data[at] - data[at - info.channels]) + Math.abs(data[at] - data[at - info.width * info.channels]); pairs += 2;
    }
    const brightness = sum / data.length;
    const rotate = [5, 6, 7, 8].includes(metadata.orientation);
    return { format: metadata.format, width: rotate ? metadata.height : metadata.width, height: rotate ? metadata.width : metadata.height,
      hash: createHash('sha256').update(bytes).digest('hex'), quality: { brightness: Math.round(brightness),
        contrast: Math.round(Math.sqrt(Math.max(0, square / data.length - brightness ** 2))), sharpness: Math.round(gradient / Math.max(1, pairs) * 10) / 10 } };
  } catch (error) { if (error.code === 'invalid_image') throw error; throw problem('照片无法解码，请重新上传有效图片。'); }
}

/** Normalize orientation and strip EXIF/GPS before sending the same visible photo to vision. */
export async function prepareAnalysisPhoto(bytes) {
  await inspectPhoto(bytes);
  const result = await input(bytes).autoOrient().flatten({ background: '#faf8f3' })
    .resize({ width: 1600, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  return { bytes: result, mime: 'image/jpeg' };
}

function checkedCrop(crop, width, height) {
  if (crop == null) return null;
  if (typeof crop !== 'object' || !['left', 'top', 'width', 'height'].every(key => Number.isFinite(crop[key]))) throw problem('裁剪参数无效。');
  if (crop.left < 0 || crop.top < 0 || crop.width <= 0 || crop.height <= 0 || crop.left + crop.width > 1.001 || crop.top + crop.height > 1.001
    || crop.width * crop.height < 0.75) throw problem('裁剪范围过大或超出照片边界，已停止处理。');
  const left = Math.round(crop.left * width), top = Math.round(crop.top * height);
  return { left, top, width: Math.min(width - left, Math.round(crop.width * width)), height: Math.min(height - top, Math.round(crop.height * height)) };
}

/** No image generation or object removal. Crop coordinates require a trusted, reviewed subject box. */
export async function processPhoto(bytes, { coverText, crop } = {}) {
  const metadata = await inspectPhoto(bytes);
  let pipeline = input(bytes).autoOrient().flatten({ background: '#faf8f3' });
  const extract = checkedCrop(crop, metadata.width, metadata.height);
  if (extract) pipeline = pipeline.extract(extract);
  pipeline = pipeline.resize({ width: 1600, height: 2000, fit: 'inside', withoutEnlargement: true })
    .modulate({ brightness: clamp(120 / Math.max(1, metadata.quality.brightness), 0.96, 1.08), saturation: 1.025 })
    .sharpen({ sigma: 0.35, m1: 0.5, m2: 1 });
  let result = await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  if (coverText) {
    const text = String(coverText).trim();
    const han = [...text].filter(char => /\p{Script=Han}/u.test(char)).length;
    if (han < 8 || han > 16 || [...text].length > 24 || /[\r\n\x00-\x1f]/.test(text)) throw problem('封面文字请控制在8—16个汉字，不超过24个字符。');
    const lines = [...text].length > 16 ? [[...text].slice(0, 12).join(''), [...text].slice(12).join('')] : [text];
    const fontSize = Math.max(12, Math.floor(result.info.width / Math.max(...lines.map(line => [...line].length), 10) * 0.84));
    const banner = Math.ceil(fontSize * (lines.length * 1.4 + 1.1));
    const width = result.info.width;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${banner}"><rect width="100%" height="100%" fill="#fff9ef"/>${lines.map((line, index) => `<text x="${width / 2}" y="${Math.round(fontSize * (1.3 + index * 1.4))}" font-family="Noto Sans CJK SC, Microsoft YaHei, SimHei, sans-serif" font-weight="700" font-size="${fontSize}" text-anchor="middle" fill="#27251f">${escapeXml(line)}</text>`).join('')}</svg>`;
    // A separate strip preserves every pixel of the source subject and avoids text over dishes or signs.
    result = await sharp(result.data).extend({ bottom: banner, background: '#fff9ef' })
      .composite([{ input: Buffer.from(svg), left: 0, top: result.info.height }]).jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  }
  return { bytes: result.data, format: 'jpeg', width: result.info.width, height: result.info.height };
}

function renderCopy(copy) {
  if (typeof copy === 'string') return copy;
  if (!copy || typeof copy !== 'object') return '';
  const titles = Array.isArray(copy.titles) ? copy.titles : [];
  const topics = Array.isArray(copy.topics) ? copy.topics : Array.isArray(copy.hashtags) ? copy.hashtags : [];
  return ['标题备选', ...titles.map((title, index) => `${index + 1}. ${title}`), '', '正文', copy.body || copy.content || '', '', '话题',
    topics.join(' '), '', '待确认信息', JSON.stringify(copy.missingFacts || [], null, 2), '', '风险提示', JSON.stringify(copy.risks || copy.riskWarnings || [], null, 2)].join('\n');
}

export function createPackageZip(results, copy) {
  if (!Array.isArray(results) || results.length < 1 || results.length > 9) throw problem('发布包应包含1—9张图片。');
  const entries = {};
  let total = 0;
  results.forEach((result, index) => {
    if (!Buffer.isBuffer(result.bytes) || !result.bytes.length || !ALLOWED.has(result.format || 'jpeg')) throw problem('发布包图片无效。');
    total += result.bytes.length;
    if (total > 80 * 1024 * 1024) throw problem('发布包体积过大。');
    const extension = (result.format || 'jpeg') === 'jpeg' ? 'jpg' : result.format;
    entries[`${String(index + 1).padStart(2, '0')}.${extension}`] = [result.bytes, { level: 0 }];
  });
  entries['发布文案.txt'] = strToU8(renderCopy(copy));
  return Buffer.from(zipSync(entries, { level: 1 }));
}
