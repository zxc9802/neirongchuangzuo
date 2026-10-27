import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Callers scope keys to an owner and check access/expiry before serving cached previews.
export function createThumbnailCache() {
  const entries = new Map();
  return (key, load) => {
    let pending = entries.get(key);
    if (pending) entries.delete(key);
    else pending = Promise.resolve().then(load).then(bytes => sharp(bytes, { limitInputPixels: 40_000_000, animated: false })
      .rotate().resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer())
      .catch(error => { if (entries.get(key) === pending) entries.delete(key); throw error; });
    entries.set(key, pending);
    while (entries.size > 128) entries.delete(entries.keys().next().value);
    return pending;
  };
}

export function sendThumbnail(req, res, bytes) {
  const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
  const headers = { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-cache', Vary: 'Cookie', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
  const matches = String(req.headers['if-none-match'] || '').split(',').some(value => [etag, `W/${etag}`, '*'].includes(value.trim()));
  if (matches) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, { ...headers, 'Content-Length': bytes.length });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}
