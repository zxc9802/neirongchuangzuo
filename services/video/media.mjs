import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createWriteStream, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import sharp from 'sharp';
import { isPublicAddress } from '../ai/server.mjs';
import { VideoError } from './provider.mjs';

export const VIDEO_LIMIT = 50 * 1024 * 1024;
export const PHOTO_LIMIT = 10 * 1024 * 1024;
const run = promisify(execFile);
export async function probeVideo(path) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
      'format=duration,format_name:stream=codec_type,codec_name,width,height,duration', '-of', 'json', path], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout), video = data.streams?.find(item => item.codec_type === 'video');
    const duration = Number(data.format?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0 || !data.format?.format_name?.includes('mp4')) throw new Error();
    return { duration, width: video.width, height: video.height, audio: data.streams.some(item => item.codec_type === 'audio') };
  } catch { throw new VideoError('无法读取视频，请上传可播放的 MP4 或 MOV 视频。', 400, 'VIDEO_MEDIA_INVALID'); }
}
export async function normalizePhoto(bytes) {
  try {
    const input = sharp(bytes, { limitInputPixels: 40_000_000, animated: false });
    const metadata = await input.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || metadata.width < 300 || metadata.height < 300 || metadata.pages > 1) throw new Error();
    return await input.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 95 }).toBuffer();
  } catch { throw new VideoError('请上传清晰的 JPG、PNG 或 WebP 人物照片，宽高至少 300 像素。', 400, 'VIDEO_PHOTO_INVALID'); }
}
export async function downloadVideo(url, path, signal = AbortSignal.timeout(120_000), hops = 0) {
  const target = new URL(url);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.port || hops > 3) throw new Error('Invalid video URL');
  const addresses = await lookup(target.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Private video address');
  const address = addresses[0];
  const response = await new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? request : httpRequest)(target, { signal, lookup: (_host, options, callback) => callback(null, options.all ? [address] : address.address, address.family) }, resolve);
    req.on('error', reject); req.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    return downloadVideo(new URL(response.headers.location, target).href, path, signal, hops + 1);
  }
  if (response.statusCode !== 200) { response.resume(); throw new Error('Video download failed'); }
  let bytes = 0;
  const limit = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length; done(bytes > 200 * 1024 * 1024 ? new Error('Video too large') : null, chunk);
  } });
  await pipeline(response, limit, createWriteStream(path, { mode: 0o600 }), { signal });
}
export async function serveMedia(req, res, path, type, download = false) {
  const { size } = await stat(path);
  let start = 0, end = size - 1, partial = false;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
      partial = true;
    }
    if (!partial || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
  }
  res.writeHead(partial ? 206 : 200, { 'Content-Type': type, 'Content-Length': end - start + 1,
    'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    ...(download ? { 'Content-Disposition': 'attachment; filename="person-replica.mp4"' } : {}) });
  if (req.method === 'HEAD') { res.end(); return; }
  try { await pipeline(createReadStream(path, { start, end }), res); } catch { res.destroy(); }
}
