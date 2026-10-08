// Keep the original files untouched; only the upload copies are resized.
export const PHOTO_LIMITS = Object.freeze({ count: 30, originalBytes: 20 * 1024 * 1024, originalTotalBytes: 400 * 1024 * 1024, uploadBytes: 8 * 1024 * 1024, uploadTotalBytes: 60 * 1024 * 1024, batchSize: 3, maxEdge: 2048 });
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function validatePhotoSelection(files = [], { maxCount = PHOTO_LIMITS.count } = {}) {
  if (!Array.isArray(files) || !files.length) return '请至少上传 1 张实拍照片。';
  if (files.length > maxCount) return `一次最多添加 ${maxCount} 张照片。`;
  let total = 0;
  for (const file of files) {
    if (!file || !Number.isFinite(file.size) || file.size <= 0) return '部分照片无法读取，请重新上传。';
    if (!TYPES.has(file.type)) return '仅支持 JPG、PNG、WebP 图片。';
    if (file.size > PHOTO_LIMITS.originalBytes) return '原图单张最多 20MB，上传时会自动压缩。';
    total += file.size;
  }
  return total > PHOTO_LIMITS.originalTotalBytes ? '原图总大小最多 400MB，请减少照片后再上传。' : '';
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new DOMException('已取消照片上传。', 'AbortError');
}
function blobDataURL(blob, signal) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => { reader.abort(); reject(new DOMException('已取消照片上传。', 'AbortError')); };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    reader.onload = () => { cleanup(); resolve(reader.result); };
    reader.onerror = () => { cleanup(); reject(new Error('照片读取失败，请重新选择照片。')); };
    reader.onabort = () => { cleanup(); reject(new DOMException('已取消照片上传。', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    reader.readAsDataURL(blob);
  });
}
function encodeJPEG(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('照片压缩失败，请换一张照片再试。')), 'image/jpeg', quality));
}

async function preparePhoto(file, { signal, maxEdge }) {
  abortIfNeeded(signal);
  let bitmap, canvas;
  try {
    // Decode one photo at a time so thirty phone originals do not occupy memory together.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    abortIfNeeded(signal);
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40 * 1024 * 1024) throw new Error('照片像素过大或无法解码，请使用 4000 万像素以内的图片。');
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('浏览器暂时无法处理照片，请刷新页面后重试。');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close(); bitmap = null;
    let blob = await encodeJPEG(canvas, 0.85);
    if (blob.size > PHOTO_LIMITS.uploadBytes) blob = await encodeJPEG(canvas, 0.65);
    if (blob.size > PHOTO_LIMITS.uploadBytes || !blob.size) throw new Error('照片压缩后仍超过 8MB，请换一张照片。');
    abortIfNeeded(signal);
    const name = String(file.name || '照片').replace(/[\u0000-\u001f]/g, '').replace(/\.(?:jpe?g|png|webp)$/i, '').slice(0, 160) + '.jpg';
    return { image: { name, dataUrl: await blobDataURL(blob, signal) }, bytes: blob.size };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(`${file.name || '照片'}：${error.message || '无法处理，请重新选择照片。'}`);
  } finally {
    bitmap?.close();
    if (canvas) { canvas.width = 1; canvas.height = 1; }
  }
}

export async function* preparePhotoBatches(files, { onProgress, signal, batchSize = PHOTO_LIMITS.batchSize, maxEdge = PHOTO_LIMITS.maxEdge, startIndex = 0 } = {}) {
  const error = validatePhotoSelection(files);
  if (error) throw new Error(error);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > PHOTO_LIMITS.batchSize || !Number.isInteger(maxEdge) || maxEdge < 256 || maxEdge > PHOTO_LIMITS.maxEdge || !Number.isInteger(startIndex) || startIndex < 0 || startIndex > files.length) throw new Error('照片处理设置无效。');
  let images = [], batchStart = startIndex, bytes = 0;
  for (let index = startIndex; index < files.length; index++) {
    abortIfNeeded(signal);
    onProgress?.({ phase: 'preparing', current: index, total: files.length });
    const prepared = await preparePhoto(files[index], { signal, maxEdge });
    bytes += prepared.bytes;
    if (bytes > PHOTO_LIMITS.uploadTotalBytes) throw new Error('压缩后照片总大小超过 60MB，请减少照片后重试。');
    images.push(prepared.image);
    onProgress?.({ phase: 'preparing', current: index + 1, total: files.length });
    if (images.length === batchSize || index === files.length - 1) {
      yield { startIndex: batchStart, images };
      batchStart = index + 1; images = [];
    }
  }
}
