import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { probeVideo, serveMedia, VIDEO_LIMIT } from './media.mjs';
import { VideoError } from './provider.mjs';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const HOSTS = new Set(['douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com']);
const MEDIA_HOSTS = ['douyin.com', 'snssdk.com', 'douyinvod.com', 'zjcdn.com'];
const fail = (message, status = 422) => new VideoError(message, status, 'DOUYIN_EXTRACT_FAILED');
function shareURL(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('请粘贴有效的抖音视频链接或分享文案。', 400); }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.has(url.hostname) || url.port || url.username || url.password) {
    throw fail('仅支持抖音视频链接，请检查后重试。', 400);
  }
  url.protocol = 'https:';
  return url;
}
export function douyinShareURL(text) {
  if (typeof text !== 'string' || text.length > 5000) throw fail('请粘贴有效的抖音视频链接或分享文案。', 400);
  return shareURL(text.match(/https?:\/\/[^\s<>"'，。！；）)]+/i)?.[0]);
}
function videoId(url) {
  const id = url.pathname.match(/\/(?:share\/)?video\/(\d+)/)?.[1] || url.searchParams.get('modal_id');
  return /^\d{15,25}$/.test(id || '') ? id : null;
}
export function parseDouyinVideo(html, id) {
  const raw = html.match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{[\s\S]*?)<\/script>/)?.[1];
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw.trim().replace(/;\s*$/, '')); } catch { return null; }
  const items = Object.values(data.loaderData || {}).flatMap(page => page?.videoInfoRes?.item_list || []);
  const item = items.find(value => String(value.aweme_id) === id);
  if (!item) return null;
  if (item.images?.length || [68, 150].includes(item.aweme_type)) throw fail('该链接是图文作品，请使用抖音视频链接。');
  // Only use playback sources. download_addr is the watermarked export.
  const source = item.video?.play_addr?.url_list?.find(value => /^https?:\/\//.test(value));
  if (!source) throw fail('未找到可下载的视频，请确认作品公开且可以播放。');
  const url = new URL(source);
  url.protocol = 'https:';
  url.pathname = url.pathname.replace('/playwm/', '/play/');
  if (url.pathname.includes('/playwm/')) throw fail('暂时无法提取无水印视频，请稍后重试。');
  const name = String(item.desc || `抖音视频-${id}`).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || `抖音视频-${id}`;
  return { url: url.href, name, id };
}

export async function downloadDouyinVideo(input, path, { signal, fetchImpl = fetch } = {}) {
  let url = new URL(input);
  for (let hops = 0; hops <= 4; hops++) {
    // Only Douyin-owned playback/CDN domains, including every redirect. No arbitrary URL proxy.
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !MEDIA_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw fail('视频下载地址不受支持。');
    const response = await fetchImpl(url.href, { redirect: 'manual', signal,
      headers: { 'User-Agent': UA, Referer: 'https://www.douyin.com/', 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (!response.headers.get('location')) throw fail('视频下载地址已失效，请重新提取。');
      url = new URL(response.headers.get('location'), url); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw fail('抖音视频暂时无法下载，请稍后重试。', 502); }
    const expected = Number(response.headers.get('content-length'));
    if (expected > VIDEO_LIMIT) { await response.body?.cancel(); throw fail('视频超过 300 MB，请换一个较小的视频。', 413); }
    let size = 0;
    const limit = new Transform({ transform(chunk, _encoding, done) {
      size += chunk.length;
      done(size > VIDEO_LIMIT ? fail('视频超过 300 MB，请换一个较小的视频。', 413) : null, chunk);
    } });
    await pipeline(response.body, limit, createWriteStream(path, { mode: 0o600 }), { signal });
    if (!size || expected > 0 && size !== expected) throw fail('视频下载不完整，请重新提取。', 502);
    return;
  }
  throw fail('视频下载跳转过多，请稍后重试。', 502);
}

export async function extractDouyinVideo(text, path, { signal = AbortSignal.timeout(180_000), fetchImpl = fetch, download = downloadDouyinVideo, probe = probeVideo } = {}) {
  const shared = douyinShareURL(text), cookies = new Map();
  async function page(input, hops = 0) {
    const url = shareURL(input);
    if (hops > 4) throw fail('抖音链接跳转过多，请重新复制视频链接。');
    const response = await fetchImpl(url.href, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      headers: { 'User-Agent': UA, Accept: 'text/html', ...(cookies.has(url.hostname) ? { Cookie: cookies.get(url.hostname) } : {}) } });
    const visitor = response.headers.getSetCookie().find(value => value.startsWith('ttwid='));
    if (visitor) cookies.set(url.hostname, visitor.split(';')[0]);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (!response.headers.get('location')) throw fail('抖音链接已失效，请重新复制。');
      return page(new URL(response.headers.get('location'), url), hops + 1);
    }
    if (!response.ok) { await response.body?.cancel(); throw fail('抖音暂时无法访问，请稍后重试。', 502); }
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw fail('抖音页面内容异常，请重新复制视频链接。');
      chunks.push(chunk);
    }
    return { url, html: Buffer.concat(chunks).toString('utf8') };
  }
  try {
    let id = videoId(shared), video;
    if (!id) {
      const resolved = await page(shared);
      id = videoId(resolved.url);
      if (id) video = parseDouyinVideo(resolved.html, id);
    }
    if (!id) throw fail('未找到视频，请使用单条抖音视频的分享链接。', 400);
    // The first visit can return only an app-opening shell and a visitor cookie.
    for (const host of ['www.douyin.com', 'www.douyin.com', 'www.douyin.com', 'www.iesdouyin.com', 'www.iesdouyin.com']) {
      if (video) break;
      const result = await page(`https://${host}/share/video/${id}/`);
      video = parseDouyinVideo(result.html, id);
    }
    if (!video) throw fail('暂时无法提取该视频，作品可能已失效、设为私密或访问受限，请稍后重试或上传本地视频。');
    await download(video.url, path, { signal, fetchImpl });
    const metadata = await probe(path);
    return { ...video, metadata, filename: `${video.name}.mp4` };
  } catch (cause) {
    if (cause instanceof VideoError) throw cause;
    if (signal.aborted || /timeout|timed out/i.test(cause.message)) throw fail('提取超时，请稍后重试。', 504);
    if (/too large/i.test(cause.message)) throw fail('视频超过 300 MB，请换一个较小的视频。', 413);
    throw fail('抖音视频暂时无法下载，请稍后重试或上传本地视频。', 502);
  }
}

export function createDouyinHandler({ extract = extractDouyinVideo } = {}) {
  const pending = new Set();
  return async (req, res, text) => {
    douyinShareURL(text);
    const owner = req.authenticatedUserId;
    if (pending.has(owner)) throw fail('视频正在提取，请等待完成后再试。', 429);
    pending.add(owner);
    const controller = new AbortController(), closed = () => controller.abort();
    res.once('close', closed);
    let directory;
    try {
      directory = await mkdtemp(join(tmpdir(), 'qiya-douyin-'));
      const path = join(directory, 'video.mp4');
      const video = await extract(text, path, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) });
      res.setHeader('X-Video-Name', encodeURIComponent(video.filename));
      res.setHeader('X-Video-Duration', String(video.metadata.duration));
      await serveMedia(req, res, path, 'video/mp4', true, `douyin-${video.id}.mp4`);
    } finally {
      res.removeListener('close', closed);
      pending.delete(owner);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
}
