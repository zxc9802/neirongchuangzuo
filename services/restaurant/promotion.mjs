import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { preparePhotoPixels } from './images.mjs';

const W = 1080, H = 1440;
const PALETTES = [
  { base: '#FFEFCB', accent: '#F04429', light: '#FFC74F', ink: '#612417' },
  { base: '#FFF0DC', accent: '#E64B36', light: '#FFBFA0', ink: '#612C21' },
  { base: '#F3F4CF', accent: '#256845', light: '#C8DC71', ink: '#1B4932' },
];
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const invalid = () => Object.assign(new Error('主体边缘无法完整提取。'), { code: 'SUBJECT_MASK_UNSAFE' });
export const promotionalPalette = seed => PALETTES[createHash('sha256').update(String(seed)).digest()[0] % PALETTES.length];

function normalizedSubjects(subjects, crop) {
  if (!Array.isArray(subjects) || !subjects.length || subjects.length > 12) throw invalid();
  return subjects.map(subject => {
    const b = subject.box;
    if (!(subject.confidence >= .8) || !b || !['left', 'top', 'width', 'height'].every(key => Number.isFinite(b[key]))
      || b.width <= .03 || b.height <= .03 || b.left < 0 || b.top < 0 || b.left + b.width > 1.001 || b.top + b.height > 1.001) throw invalid();
    const c = crop || { left: 0, top: 0, width: 1, height: 1 };
    if (b.left < c.left || b.top < c.top || b.left + b.width > c.left + c.width + .001 || b.top + b.height > c.top + c.height + .001) throw invalid();
    const points = subject.outline;
    if (!Array.isArray(points) || points.length < 8 || points.length > 24 || points.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y)
      || p.x < b.left - .005 || p.y < b.top - .005 || p.x > b.left + b.width + .005 || p.y > b.top + b.height + .005
      || p.x < c.left || p.y < c.top || p.x > c.left + c.width || p.y > c.top + c.height)) throw invalid();
    let twiceArea = 0;
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length]; twiceArea += a.x * b.y - a.y * b.x;
      for (let j = i + 2; j < points.length; j++) {
        if (i === 0 && j === points.length - 1) continue;
        const d = points[j], e = points[(j + 1) % points.length];
        if (cross(a, b, d) * cross(a, b, e) < 0 && cross(d, e, a) * cross(d, e, b) < 0) throw invalid();
      }
    }
    if (Math.abs(twiceArea) / 2 < b.width * b.height * .3) throw invalid();
    return { left: (b.left - c.left) / c.width, top: (b.top - c.top) / c.height, width: b.width / c.width, height: b.height / c.height,
      outline: points.map(p => ({ x: (p.x - c.left) / c.width, y: (p.y - c.top) / c.height })) };
  });
}

// Each dish gets its own inference so a salient first plate cannot erase other food.
export async function extractFoodSubject(source, subjects, { mask, crop } = {}) {
  const boxes = normalizedSubjects(subjects, crop);
  if (typeof mask !== 'function') throw invalid();
  const alpha = new Uint8Array(source.width * source.height);
  for (const box of boxes) {
    const x = Math.floor(box.left * source.width), y = Math.floor(box.top * source.height);
    const right = Math.min(source.width, Math.ceil((box.left + box.width) * source.width));
    const bottom = Math.min(source.height, Math.ceil((box.top + box.height) * source.height));
    // Vision coordinates are approximate; include space around the plate before segmentation.
    const pad = Math.ceil(Math.max(right - x, bottom - y) * .32);
    const left = Math.max(0, x - pad), top = Math.max(0, y - pad);
    const width = Math.min(source.width, right + pad) - left, height = Math.min(source.height, bottom + pad) - top;
    const roi = await sharp(source.bytes).extract({ left, top, width, height }).png().toBuffer();
    const prediction = await mask(roi);
    const metadata = await sharp(prediction, { limitInputPixels: 1024 * 1024 }).metadata();
    if (!['png', 'webp'].includes(metadata.format) || metadata.width < 16 || metadata.height < 16 || metadata.width > 1024 || metadata.height > 1024 || metadata.pages > 1) throw invalid();
    const low = await sharp(prediction).resize(320, 320, { fit: 'fill' }).greyscale().raw().toBuffer();
    // Remove outside noise and fill enclosed plate/food holes without altering RGB.
    const exterior = new Uint8Array(low.length), queue = new Int32Array(low.length); let read = 0, write = 0;
    function push(i) { if (!exterior[i] && low[i] < 110) { exterior[i] = 1; queue[write++] = i; } }
    for (let i = 0; i < 320; i++) { push(i); push(319 * 320 + i); push(i * 320); push(i * 320 + 319); }
    while (read < write) {
      const i = queue[read++], col = i % 320;
      if (col) push(i - 1); if (col < 319) push(i + 1); if (i >= 320) push(i - 320); if (i < 319 * 320) push(i + 320);
    }
    for (let i = 0; i < low.length; i++) low[i] = !exterior[i] || low[i] >= 145 ? 255 : low[i] < 95 ? 0 : Math.round((low[i] - 95) / 50 * 255);
    const labels = new Int32Array(low.length), sizes = [0]; let component = 0, largest = 0;
    for (let start = 0; start < low.length; start++) {
      if (labels[start] || low[start] < 145) continue;
      component++; read = 0; write = 0; labels[start] = component; queue[write++] = start;
      const visit = i => { if (!labels[i] && low[i] >= 145) { labels[i] = component; queue[write++] = i; } };
      while (read < write) {
        const i = queue[read++], col = i % 320;
        if (col) visit(i - 1); if (col < 319) visit(i + 1); if (i >= 320) visit(i - 320); if (i < 319 * 320) visit(i + 320);
      }
      sizes[component] = write; if (write > sizes[largest]) largest = component;
    }
    if (!largest || sizes.some((size, id) => id !== largest && size > sizes[largest] * .05)) throw invalid();
    const nearMain = i => labels[i] === largest || i % 320 && labels[i - 1] === largest || i % 320 < 319 && labels[i + 1] === largest
      || i >= 320 && labels[i - 320] === largest || i < 319 * 320 && labels[i + 320] === largest;
    for (let i = 0; i < low.length; i++) if (!nearMain(i)) low[i] = 0;
    let mass = 0, minX = 320, minY = 320, maxX = 0, maxY = 0;
    for (let i = 0; i < low.length; i++) if (low[i] >= 240) { mass++; minX = Math.min(minX, i % 320); maxX = Math.max(maxX, i % 320); minY = Math.min(minY, Math.floor(i / 320)); maxY = Math.max(maxY, Math.floor(i / 320)); }
    const expected = { left: (x - left) / width * 320, top: (y - top) / height * 320, width: (right - x) / width * 320, height: (bottom - y) / height * 320 };
    // An empty/tiny/whole-background mask or missing dish extremity keeps the full photo instead.
    if (mass < low.length * .12 || mass > low.length * .95 || maxX - minX < expected.width * .72 || maxY - minY < expected.height * .72
      || minX > expected.left + expected.width * .2 || minY > expected.top + expected.height * .2
      || maxX < expected.left + expected.width * .8 || maxY < expected.top + expected.height * .8) throw invalid();
    const pixels = metadata.width === 320 && metadata.height === 320
      ? await sharp(low, { raw: { width: 320, height: 320, channels: 1 } }).resize(width, height).greyscale().raw().toBuffer()
      : await sharp(prediction).resize(width, height, { fit: 'fill' }).greyscale().raw().toBuffer();
    for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
      const dest = (top + row) * source.width + left + col;
      const i = row * width + col;
      const lowIndex = Math.min(319, Math.floor(row / height * 320)) * 320 + Math.min(319, Math.floor(col / width * 320));
      if (nearMain(lowIndex)) alpha[dest] = Math.max(alpha[dest], pixels[i]);
    }
  }
  let left = source.width, top = source.height, right = 0, bottom = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] > 12) { const x = i % source.width, y = Math.floor(i / source.width); left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  if (right <= left || bottom <= top) throw invalid();
  const rgb = await sharp(source.bytes).removeAlpha().raw().toBuffer();
  const rgba = Buffer.alloc(alpha.length * 4);
  for (let i = 0; i < alpha.length; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = alpha[i]; }
  const bounds = { left, top, width: right - left + 1, height: bottom - top + 1 };
  const bytes = await sharp(rgba, { raw: { width: source.width, height: source.height, channels: 4 } }).extract(bounds).png().toBuffer();
  return { bytes, ...bounds, method: 'source-cutout' };
}

function background(p, index, label, storeName) {
  const shifted = index % 2 === 1;
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="1080" height="1440" fill="${p.base}"/>
    <circle cx="${shifted ? 80 : 1040}" cy="680" r="475" fill="${p.light}"/>
    <path d="M0 1190 Q520 1050 1080 1260 V1440 H0Z" fill="${p.accent}"/>
    <g fill="none" stroke="${p.accent}" stroke-width="4" opacity=".16"><path d="M55 365L110 335M65 394L125 394M925 375L970 335M933 400L990 398"/><circle cx="965" cy="1030" r="14"/><circle cx="115" cy="1080" r="9"/></g>
    <rect x="64" y="66" width="${Math.min(760, Math.max(120, Array.from(label || '门店日常').length * 32 + 52))}" height="54" rx="27" fill="${p.accent}"/>
    <text x="90" y="104" fill="white" font-size="30" font-weight="600" font-family="Noto Sans CJK SC,Microsoft YaHei,SimHei,sans-serif">${xml(Array.from(label || '门店日常').slice(0, 20).join(''))}</text>
    <text x="72" y="1367" fill="white" font-size="38" font-weight="700" font-family="Noto Sans CJK SC,Microsoft YaHei,SimHei,sans-serif">${xml(Array.from(storeName || '').slice(0, 22).join(''))}</text>
  </svg>`);
}

export async function processPromotionalPhoto(bytes, { analysis, crop, mask, seed = '', index = 0, label = '', storeName = '' } = {}) {
  const source = await preparePhotoPixels(bytes, { crop });
  let subject = { ...source, method: 'original-frame' };
  if (analysis?.imageType === 'food' && analysis.foodSubjects?.length) {
    try { subject = await extractFoodSubject(source, analysis.foodSubjects, { mask, crop }); }
    catch (cause) { subject = { ...source, method: 'original-frame', fallbackReason: cause.code || 'SUBJECT_MASK_FAILED' }; }
  }
  const p = promotionalPalette(seed);
  const isCutout = subject.method === 'source-cutout';
  const resized = await sharp(subject.bytes).resize(isCutout ? 950 : 912, isCutout ? 920 : 880, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
  const left = Math.round((W - resized.info.width) / 2), top = Math.round(390 + (920 - resized.info.height) / 2);
  const shadow = Buffer.from(`<svg width="1080" height="1440" xmlns="http://www.w3.org/2000/svg"><defs><filter id="blur"><feGaussianBlur stdDeviation="20"/></filter></defs>${isCutout
    ? `<ellipse cx="540" cy="${Math.min(1230, top + resized.info.height - 15)}" rx="${resized.info.width * .36}" ry="24" fill="${p.ink}" opacity=".18" filter="url(#blur)"/>`
    : `<rect x="${left - 15}" y="${top - 15}" width="${resized.info.width + 30}" height="${resized.info.height + 30}" rx="16" fill="white"/>`}</svg>`);
  const output = await sharp(background(p, index, label, storeName)).composite([{ input: shadow }, { input: resized.data, left, top }]).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
  return { bytes: output, width: W, height: H, format: 'jpeg', composition: { version: 'food-promotion-v1', method: subject.method, sourceHash: createHash('sha256').update(bytes).digest('hex'), palette: p.accent, ...(subject.fallbackReason ? { fallbackReason: subject.fallbackReason } : {}) } };
}

export async function addPromotionalHeadline(result, title, seed = '', { index = 0 } = {}) {
  if (typeof title !== 'string' || /[\r\n\u0000-\u001f]/.test(title) || title.length > 24 || (title.match(/\p{Script=Han}/gu)?.length ?? 0) < 8 || (title.match(/\p{Script=Han}/gu)?.length ?? 0) > 16) throw invalid();
  const chars = Array.from(title), first = chars.length > 10 ? chars.slice(0, Math.ceil(chars.length / 2)).join('') : title, second = chars.length > 10 ? chars.slice(Math.ceil(chars.length / 2)).join('') : '';
  const p = promotionalPalette(seed), size = second ? 82 : Math.min(94, Math.floor(920 / chars.length));
  const overlay = Buffer.from(`<svg width="1080" height="1440" xmlns="http://www.w3.org/2000/svg"><g fill="${p.ink}" font-size="${size}" font-weight="900" font-family="Noto Sans CJK SC,Microsoft YaHei,SimHei,sans-serif"><text x="68" y="${second ? 235 : 290}">${xml(first)}</text>${second ? `<text x="68" y="337">${xml(second)}</text>` : ''}</g><text x="1002" y="1367" fill="white" text-anchor="end" font-size="27" font-family="sans-serif">${String(index + 1).padStart(2, '0')}</text></svg>`);
  return { ...result, bytes: await sharp(result.bytes).composite([{ input: overlay }]).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer() };
}
