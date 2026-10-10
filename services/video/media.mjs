import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup, resolveCname } from 'node:dns/promises';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile, writeFile, rm, open } from 'node:fs/promises';
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
const DOWNLOAD_LIMIT = 200 * 1024 * 1024;
const strongEtag = value => typeof value === 'string' && /^"[^\r\n"]*"$/.test(value) ? value : null;
const byteCount = value => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
async function abortable(promise, signal) {
  signal.throwIfAborted();
  let aborted;
  const cancellation = new Promise((_, reject) => { aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true }); });
  try { return await Promise.race([promise, cancellation]); }
  finally { signal.removeEventListener('abort', aborted); }
}
async function videoResponse(url, headers, signal, options, hops = 0) {
  const target = new URL(url);
  if (String(url).length > 8192 || !['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.port || hops > 3) throw new Error('Invalid video URL');
  const addresses = await abortable((options.lookup || lookup)(target.hostname, { all: true }), signal);
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Private video address');
  // Prefer addresses that have not delivered a slow stream, then IPv4.
  const avoided = options.avoidAddresses || [];
  const choices = [...addresses].sort((a, b) => Number(avoided.includes(`${target.hostname}|${a.address}`))
    - Number(avoided.includes(`${target.hostname}|${b.address}`)) || a.family - b.family).slice(0, 4);
  let response, cause;
  for (const address of choices) {
    signal.throwIfAborted();
    try {
      response = await new Promise((resolve, reject) => {
        const transport = options.transport || (target.protocol === 'https:' ? request : httpRequest);
        let timer, incoming;
        const req = transport(target, { signal, headers,
          lookup: (_host, settings, callback) => callback(null, settings.all ? [address] : address.address, address.family) }, value => {
          incoming = value; value.on('error', () => {}); clearTimeout(timer); resolve(value);
        });
        timer = setTimeout(() => req.destroy(new Error('Video connection timed out')), options.connectTimeoutMs ?? 15_000);
        req.setTimeout(options.idleTimeoutMs ?? 30_000, () => {
          const cause = new Error('Video download stalled'); incoming?.destroy(cause); req.destroy(cause);
        });
        req.on('error', error => { clearTimeout(timer); reject(error); });
        req.end();
      });
      response.downloadAddress = `${target.hostname}|${address.address}`;
      response.hasDownloadAlternative = addresses.some(value => value.address !== address.address
        && !avoided.includes(`${target.hostname}|${value.address}`));
      break;
    } catch (error) { cause = error; if (signal.aborted) throw error; }
  }
  if (!response) throw cause;
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    if (!response.headers.location) throw new Error('Missing video redirect');
    return videoResponse(new URL(response.headers.location, target).href, headers, signal, options, hops + 1);
  }
  return response;
}
// The caller retries the same provider task. Interrupted bytes are retained only
// with a strong entity validator, so a changed asset can never be appended to it.
export async function downloadVideo(url, path, signalOrOptions, extraOptions = {}) {
  const options = signalOrOptions?.addEventListener ? { ...extraOptions, signal: signalOrOptions } : { ...(signalOrOptions || {}), ...extraOptions };
  const controller = new AbortController();
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 600_000;
  const deadline = performance.now() + attemptTimeoutMs;
  const timer = setTimeout(() => controller.abort(new Error('Video download timed out')), attemptTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const metadataPath = path + '.download.json';
  const maxBytes = Math.min(options.maxBytes ?? DOWNLOAD_LIMIT, DOWNLOAD_LIMIT);
  const progress = values => { try { Promise.resolve(options.onProgress?.(values)).catch(() => {}); } catch {} };
  let response, output, throughputTimer, downloadState, slowAddress;
  try {
    signal.throwIfAborted();
    let previous, existing = 0, avoidAddresses = [];
    try {
      const file = await stat(path), metadataFile = await stat(metadataPath);
      if (file.isFile() && metadataFile.isFile() && metadataFile.size < 16_384) {
        const stored = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (stored?.version === 1 && stored.url === String(url) && Array.isArray(stored.avoidAddresses)) {
          avoidAddresses = stored.avoidAddresses.filter(value => typeof value === 'string' && value.length < 512).slice(-16);
        }
        if (stored?.version === 1 && stored.url === String(url) && strongEtag(stored.etag)
          && (stored.totalBytes === null || Number.isSafeInteger(stored.totalBytes) && stored.totalBytes >= file.size)) {
          previous = stored; existing = file.size;
        }
      }
    } catch (cause) { if (cause.code !== 'ENOENT' && cause.code !== 'ENOTDIR' && !(cause instanceof SyntaxError)) throw cause; }
    if (existing > maxBytes) throw new Error('Video too large');
    const resumed = existing > 0;
    let preferred = String(url);
    const target = new URL(url);
    // This provider alias can be much slower than the same object's native TOS
    // endpoint. Keep signed/query URLs intact and retain the original fallback.
    if (target.hostname === 'aggregationpic.buerdt.net' && target.protocol === 'https:'
      && !target.username && !target.password && !target.port && !target.search && preferred.length <= 8192) {
      try {
        const discovery = AbortSignal.any([signal, AbortSignal.timeout(options.connectTimeoutMs ?? 15_000)]);
        const aliases = await abortable((options.resolveCname || resolveCname)(target.hostname), discovery);
        const origin = aliases.find(name => /^[a-z0-9-]+\.tos-[a-z0-9-]+\.volces\.com$/i.test(name));
        if (origin) { target.hostname = origin; preferred = target.href; }
      } catch (cause) { if (signal.aborted) throw cause; }
    }
    const candidates = preferred === String(url) ? [String(url)] : [preferred, String(url)];
    const headers = { Accept: 'video/mp4,application/octet-stream', 'Accept-Encoding': 'identity',
      ...(resumed ? { Range: `bytes=${existing}-`, 'If-Range': previous.etag } : {}) };
    for (let index = 0; index < candidates.length; index++) {
      try {
        response = await videoResponse(candidates[index], headers, signal, { ...options, avoidAddresses });
        if (index === candidates.length - 1 || [200, 206, 416].includes(response.statusCode)) break;
        response.destroy();
      } catch (cause) { if (index === candidates.length - 1 || signal.aborted) throw cause; }
    }
    const etag = strongEtag(response.headers.etag);
    if (response.statusCode === 416) {
      const match = /^bytes \*\/(\d+)$/.exec(response.headers['content-range'] || '');
      const total = match && byteCount(match[1]);
      response.destroy();
      if (resumed && total === existing && total > 0 && etag === previous.etag
        && (previous.totalBytes === null || previous.totalBytes === total)) {
        await rm(metadataPath, { force: true });
        progress({ bytes: existing, totalBytes: total, resumed: true, complete: true });
        return { bytes: existing, totalBytes: total, resumed: true };
      }
      await rm(metadataPath, { force: true });
      throw new Error('Video range does not match the saved download');
    }
    if (![200, 206].includes(response.statusCode)) throw new Error('Video download failed');
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Encoded video download is unsupported');
    const contentLength = response.headers['content-length'] === undefined ? null : byteCount(response.headers['content-length']);
    if (response.headers['content-length'] !== undefined && contentLength === null) throw new Error('Invalid video content length');
    let start = 0, totalBytes = contentLength;
    if (response.statusCode === 206) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
      const range = match?.slice(1).map(byteCount);
      if (!resumed || !range || range.some(value => value === null) || range[0] !== existing
        || range[1] < range[0] || range[1] >= range[2] || etag !== previous.etag
        || previous.totalBytes !== null && range[2] !== previous.totalBytes
        || contentLength !== null && contentLength !== range[1] - range[0] + 1) {
        await rm(metadataPath, { force: true });
        throw new Error('Invalid video content range');
      }
      start = existing; totalBytes = range[2];
    } else if (response.headers['content-range']) throw new Error('Unexpected video content range');
    if (totalBytes !== null && totalBytes > maxBytes) throw new Error('Video too large');
    output = await open(path, start > 0 ? 'a' : 'w', 0o600);
    downloadState = { version: 1, url: String(url), etag, totalBytes, avoidAddresses };
    await writeFile(metadataPath, JSON.stringify(downloadState), { mode: 0o600 });
    let bytes = start;
    progress({ bytes, totalBytes, resumed: start > 0, complete: false });
    if (totalBytes !== null) {
      // Avoid a slow address even if its stream could fit the ten-minute limit.
      // Measure this response only, not a retained partial download.
      // Unknown lengths and small final tails retain the existing timeout rules.
      let observedAt = performance.now(), observedBytes = bytes;
      throughputTimer = setInterval(() => {
        const now = performance.now(), elapsed = now - observedAt;
        const received = bytes - observedBytes, remaining = totalBytes - bytes;
        const timeLeft = deadline - now;
        const estimatedMs = received > 0 ? remaining * elapsed / received : Infinity;
        if (remaining > 64 * 1024 && timeLeft > 0 && elapsed > 0
          && (estimatedMs > timeLeft || response.hasDownloadAlternative
            && received * 1000 / elapsed < 128 * 1024 && estimatedMs > 30_000)) {
          slowAddress = response.downloadAddress;
          response.destroy(new Error('Video download too slow to finish promptly'));
        }
        observedAt = now; observedBytes = bytes;
      }, options.throughputWindowMs ?? 10_000);
    }
    const limit = new Transform({ transform(chunk, _encoding, done) {
      if (bytes + chunk.length > maxBytes || totalBytes !== null && bytes + chunk.length > totalBytes) return done(new Error('Video too large or longer than declared'));
      bytes += chunk.length;
      progress({ bytes, totalBytes, resumed: start > 0, complete: false });
      done(null, chunk);
    } });
    await pipeline(response, limit, output.createWriteStream(), { signal });
    if (totalBytes !== null && bytes !== totalBytes) throw new Error('Video download incomplete');
    await rm(metadataPath, { force: true });
    progress({ bytes, totalBytes: totalBytes ?? bytes, resumed: start > 0, complete: true });
    return { bytes, totalBytes: totalBytes ?? bytes, resumed: start > 0 };
  } finally {
    clearTimeout(timer); clearInterval(throughputTimer); response?.destroy(); await output?.close();
    if (slowAddress && downloadState) {
      downloadState.avoidAddresses = [...downloadState.avoidAddresses.filter(value => value !== slowAddress), slowAddress].slice(-16);
      await writeFile(metadataPath, JSON.stringify(downloadState), { mode: 0o600 });
    }
  }
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
