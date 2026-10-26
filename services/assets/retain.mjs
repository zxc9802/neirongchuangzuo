import { VIDEO_LIMIT } from '../video/media.mjs';
const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'ASSET_STORAGE_ERROR' });
// Clients may identify a known output, never supply an arbitrary fetch destination.
export function generatedSource(input) {
  if (!input || typeof input.key !== 'string' || typeof input.url !== 'string') throw fail('请选择有效的生成作品。');
  const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
  let match, type, url;
  if ((match = new RegExp(`^(creative-video|video):(${uuid})$`, 'i').exec(input.key))) {
    type = 'video'; url = `/api/${match[1] === 'video' ? 'video-replica' : 'video-creator'}/tasks/${match[2]}/result`;
  } else if ((match = /^avatar:([a-zA-Z0-9_-]{1,128}):(video|audio)$/.exec(input.key))) {
    type = match[2]; url = `/api/tasks/${match[1]}/media/${type === 'video' ? 'final' : 'voice'}`;
  } else if ((match = new RegExp(`^restaurant:(${uuid}):((?:0[1-9]|1[0-5])\\.(?:jpg|png|webp))$`, 'i').exec(input.key))) {
    type = 'image'; url = `/api/restaurant/tasks/${match[1]}/files/${match[2]}`;
  } else if ((match = new RegExp(`^image:(${uuid}):(\\d+)$`, 'i').exec(input.key))) {
    if (!new RegExp(`^/api/ai/media/${match[1]}/result-(?:[1-9]|1[0-5])\\.(?:jpg|png|webp)$`, 'i').test(input.url)) throw fail('成品来源无效。');
    type = 'image'; url = input.url;
  } else throw fail('成品来源无效。');
  if (url !== input.url) throw fail('成品来源无效。');
  return { url, type, kind: { image: 'photo', audio: 'voice', video: 'video' }[type] };
}
export async function readGeneratedMedia(req, source) {
  // Loop back into the existing authenticated media routes for ownership, billing and expiry checks.
  const response = await fetch(`http://127.0.0.1:${req.socket.localPort}${source.url}`, {
    headers: req.headers.cookie ? { Cookie: req.headers.cookie } : {}, redirect: 'error', signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) { await response.body?.cancel(); throw fail(response.status === 410 ? '成品已过期，无法转存。' : '成品暂时无法读取，请刷新后重试。', response.status === 404 || response.status === 410 ? response.status : 503); }
  const limit = source.type === 'video' ? VIDEO_LIMIT : 50 * 1024 * 1024;
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().replace('audio/x-wav', 'audio/wav');
  if (Number(response.headers.get('content-length')) > limit || !mime.startsWith(source.type + '/')) { await response.body?.cancel(); throw fail('成品格式或大小不支持转存。'); }
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw fail('成品文件过大。', 413); chunks.push(chunk); }
  if (!size) throw fail('成品文件为空。');
  return { bytes: Buffer.concat(chunks), mime };
}
