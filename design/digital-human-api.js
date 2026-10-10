const API = '/api';
const MIB = 1024 * 1024;
const FORMATS = {
  videos: { limit: 500 * MIB, extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v'], prefixes: ['video/'] },
  voices: { limit: 50 * MIB, extensions: ['mp3', 'wav', 'm4a', 'aac', 'mp4', 'mov'], prefixes: ['audio/', 'video/'] },
  thumbnails: { limit: 10 * MIB, extensions: ['jpg', 'jpeg', 'png', 'webp'], prefixes: ['image/'] },
};
const MIME_TYPES = {
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

export class DigitalHumanApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'DigitalHumanApiError';
    this.status = status;
  }
}

function responseError(status, data) {
  const fallback = status === 401 ? '请先登录后再操作'
    : status === 403 ? '当前账号没有执行此操作的权限'
    : status === 413 ? '文件过大，请选择较小的文件'
    : status === 429 ? '操作过于频繁，请稍后再试'
    : status === 502 || status === 503 ? '数字人服务暂时不可用，请稍后重试'
    : `请求未完成（${status}），请稍后重试`;
  const message = typeof data?.error === 'string' && data.error.trim() && /[\u3400-\u9fff]/u.test(data.error)
    ? data.error : fallback;
  return new DigitalHumanApiError(message, status);
}

function parseResponse(text, status) {
  let data;
  try { data = JSON.parse(text); } catch { /* A proxy error or HTML document is not an API response. */ }
  if (status < 200 || status >= 300) throw responseError(status, data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new DigitalHumanApiError('数字人服务返回了无法识别的内容，请刷新后重试', 502);
  }
  if (data.success === false || typeof data.error === 'string') throw responseError(status, data);
  return data;
}

// Mutations deliberately have no automatic retries: a lost response must never create a second paid task.
async function request(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return parseResponse(await response.text(), response.status);
  } catch (error) {
    if (error instanceof DigitalHumanApiError) throw error;
    if (controller.signal.aborted) {
      throw new DigitalHumanApiError(method === 'GET' ? '服务响应超时，请稍后重试' : '操作响应超时，请先刷新查看是否已完成，再决定是否重试', 408);
    }
    throw new DigitalHumanApiError(method === 'GET' ? '无法连接数字人服务，请检查服务是否已启动' : '连接中断，请先刷新查看操作结果，避免重复提交');
  } finally { clearTimeout(timer); }
}

function entity(data, key) {
  const value = data[key];
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) {
    throw new DigitalHumanApiError('服务返回的数据不完整，请刷新后查看结果', 502);
  }
  return value;
}

function collection(data, key) {
  if (!Array.isArray(data[key]) || data[key].some(value => !value || typeof value.id !== 'string')) {
    throw new DigitalHumanApiError('素材或任务列表暂时无法读取，请刷新后重试', 502);
  }
  return data[key];
}

function success(data) {
  if (data.success !== true) throw new DigitalHumanApiError('服务未确认操作成功，请刷新后查看结果', 502);
  return data;
}

function identifier(value) {
  if (typeof value !== 'string' || !value.trim()) throw new DigitalHumanApiError('请选择要操作的素材或任务', 400);
  return encodeURIComponent(value);
}

/** Safe for media src values; callers must still escape values when constructing HTML. */
export function safeMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f\\]/u.test(value)) return '';
  const text = value.trim();
  if (text.startsWith('//')) return '';
  try {
    const base = globalThis.location?.href || 'http://localhost/';
    const url = new URL(text, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    const absolute = /^https?:\/\//iu.test(text);
    if (!absolute && (/^[a-z][a-z\d+.-]*:/iu.test(text) || url.origin !== new URL(base).origin)) return '';
    return absolute ? url.href : `${url.pathname}${url.search}${url.hash}`;
  } catch { return ''; }
}

function uploadDescriptor(file, fileName, folder) {
  const format = FORMATS[folder];
  const extension = fileName.split('.').pop().toLowerCase();
  if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new DigitalHumanApiError('请选择包含内容的文件', 400);
  }
  if (file.size > format.limit) throw new DigitalHumanApiError(`文件过大，最大支持 ${format.limit / MIB} MB`, 400);
  if (!format.extensions.includes(extension)) throw new DigitalHumanApiError(`文件格式不支持，请选择 ${format.extensions.map(value => value.toUpperCase()).join('、')} 文件`, 400);
  const contentType = !file.type || file.type === 'application/octet-stream' ? MIME_TYPES[extension] : file.type;
  if (!format.prefixes.some(prefix => contentType.toLowerCase().startsWith(prefix))) {
    throw new DigitalHumanApiError('文件类型与所选素材不匹配，请重新选择', 400);
  }
  return { folder, fileName, fileSize: file.size, contentType };
}

function sendBlob(url, blob, { method, contentType, onProgress, signal, json = false }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const abort = () => xhr.abort();
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
    };
    xhr.open(method, url, true);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.timeout = 180_000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded); };
    xhr.onload = () => {
      try {
        if (json) finish(null, parseResponse(xhr.responseText, xhr.status));
        else if (xhr.status >= 200 && xhr.status < 300) finish(null);
        else finish(responseError(xhr.status));
      } catch (error) { finish(error); }
    };
    xhr.onerror = () => finish(new DigitalHumanApiError('素材上传连接中断，请检查网络后重新上传'));
    xhr.ontimeout = () => finish(new DigitalHumanApiError('素材上传超时，请检查网络后重新上传', 408));
    xhr.onabort = () => finish(signal?.reason || new DigitalHumanApiError('素材上传已取消'));
    if (signal?.aborted) return finish(signal.reason || new DigitalHumanApiError('素材上传已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(blob);
  });
}

async function uploadMedia(file, fileName, folder, onProgress) {
  const descriptor = uploadDescriptor(file, fileName, folder);
  const grant = await request(`${API}/upload/direct`, { method: 'POST', body: descriptor });
  onProgress?.(0);
  if (grant.direct === false) {
    const query = new URLSearchParams({ folder, fileName });
    const result = await sendBlob(`${API}/upload?${query}`, file, {
      method: 'POST', contentType: descriptor.contentType, json: true,
      onProgress: bytes => onProgress?.(Math.min(99, Math.round(bytes / file.size * 100))),
    });
    if (result.success !== true || typeof result.uploadKey !== 'string' || !result.uploadKey) {
      throw new DigitalHumanApiError('素材上传未能确认，请重新上传', 502);
    }
    onProgress?.(100);
    return result;
  }
  const parts = grant.parts;
  if (grant.direct !== true || typeof grant.uploadKey !== 'string' || !grant.uploadKey ||
      !Array.isArray(parts) || !parts.length || parts.some(part =>
        !part || !Number.isSafeInteger(part.size) || part.size <= 0 || !safeMediaUrl(part.url)) ||
      parts.reduce((total, part) => total + part.size, 0) !== file.size) {
    throw new DigitalHumanApiError('服务返回的上传凭证不完整，请稍后重试', 502);
  }
  // Cross-origin bytes are sent only to URLs issued by the configured backend upload grant.
  const controller = new AbortController();
  const loaded = parts.map(() => 0);
  let offset = 0;
  const slices = parts.map(part => {
    const slice = file.slice(offset, offset + part.size);
    offset += part.size;
    return slice;
  });
  let nextPart = 0;
  let highestProgress = 0;
  const reportProgress = (index, bytes) => {
    if (controller.signal.aborted) return;
    loaded[index] = Math.min(parts[index].size, bytes);
    highestProgress = Math.max(highestProgress, Math.min(99, Math.round(loaded.reduce((a, b) => a + b, 0) / file.size * 100)));
    onProgress?.(highestProgress);
  };
  await Promise.all(Array.from({ length: Math.min(3, parts.length) }, async () => {
    try {
      while (!controller.signal.aborted && nextPart < parts.length) {
        const index = nextPart++;
        await sendBlob(safeMediaUrl(parts[index].url), slices[index], {
          method: 'PUT', contentType: 'application/octet-stream', signal: controller.signal,
          onProgress: bytes => reportProgress(index, bytes),
        });
        reportProgress(index, parts[index].size);
      }
    } catch (error) { controller.abort(error); throw error; }
  }));
  const result = await request(`${API}/upload/complete`, { method: 'POST', body: { uploadKey: grant.uploadKey } });
  if (result.success !== true || result.uploadKey !== grant.uploadKey) throw new DigitalHumanApiError('素材上传未能确认，请稍后重试', 502);
  onProgress?.(100);
  return result;
}

// Browser codecs may not support every server-supported format, so missing metadata/cover never blocks an upload.
function inspectVideo(file) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);
    const metadata = {};
    let settled = false;
    let capturing = false;
    const finish = thumbnail => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
      resolve({ ...metadata, thumbnail });
    };
    const timer = setTimeout(() => finish(null), 10_000);
    const capture = () => {
      if (capturing || settled) return;
      capturing = true;
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const context = canvas.getContext('2d');
        if (!context || !canvas.width || !canvas.height) return finish(null);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(finish, 'image/jpeg', 0.8);
      } catch { finish(null); }
    };
    video.onloadedmetadata = () => {
      if (video.videoWidth > 0) metadata.width = video.videoWidth;
      if (video.videoHeight > 0) metadata.height = video.videoHeight;
      if (Number.isFinite(video.duration) && video.duration > 0) metadata.durationSeconds = video.duration;
    };
    video.onloadeddata = () => {
      const timestamp = Number.isFinite(video.duration) ? Math.min(1, video.duration * 0.2) : 0;
      try { if (timestamp > 0) video.currentTime = timestamp; else capture(); } catch { capture(); }
    };
    video.onseeked = capture;
    video.onerror = () => finish(null);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = objectUrl;
  });
}

function mediaName(value, file) {
  const name = typeof value === 'string' ? value.trim() : (file.name || '').replace(/\.[^.]+$/u, '').trim();
  if (!name || name.length > 80) throw new DigitalHumanApiError('请填写 1–80 字的素材名称', 400);
  return name;
}

export const digitalHumanApi = {
  getStatus: () => request(`${API}/digital-human/status`),
  getSession: () => request(`${API}/session`),
  listAvatars: async () => collection(await request(`${API}/avatars`), 'avatars'),
  listVoices: async () => collection(await request(`${API}/voices`), 'voices'),
  listTasks: async () => collection(await request(`${API}/tasks`), 'tasks'),
  async listLibrary({ kind = 'all', cursor, limit = 12, avatarId, taskId } = {}) {
    const query = new URLSearchParams({ kind, limit: String(limit) });
    if (cursor != null) query.set('cursor', cursor);
    if (avatarId) query.set('avatarId', avatarId);
    if (taskId) query.set('taskId', taskId);
    const data = await request(`${API}/digital-human/library?${query}`);
    const validEntity = value => value && typeof value === 'object' && typeof value.id === 'string' && value.id;
    if (!Array.isArray(data.items) || data.items.some(item =>
      !item || !['avatar', 'task'].includes(item.kind) || !validEntity(item[item.kind]) ||
      item.id !== item[item.kind].id || !Number.isFinite(item.createdAt)) ||
      !Number.isSafeInteger(data.total) || data.total < 0 || typeof data.hasMore !== 'boolean' ||
      !(data.nextCursor === null || (typeof data.nextCursor === 'string' && data.nextCursor.length > 0)) ||
      data.hasMore !== (data.nextCursor !== null) || !data.counts ||
      ['all', 'avatars', 'tasks'].some(key => !Number.isSafeInteger(data.counts[key]) || data.counts[key] < 0) ||
      !data.selection || typeof data.selection !== 'object' || Array.isArray(data.selection) ||
      (data.selection.avatar != null && !validEntity(data.selection.avatar)) ||
      (data.selection.task != null && !validEntity(data.selection.task)) ||
      !Array.isArray(data.activeTasks) || data.activeTasks.some(task =>
        !validEntity(task) || !['pending', 'processing'].includes(task.status))) {
      throw new DigitalHumanApiError('素材与成品列表暂时无法读取，请刷新后重试', 502);
    }
    return data;
  },
  getTask: async id => entity(await request(`${API}/tasks/${identifier(id)}`), 'task'),

  async createAvatar(file, { name, onProgress } = {}) {
    uploadDescriptor(file, file?.name || '', 'videos');
    const displayName = mediaName(name, file);
    const { thumbnail, ...metadata } = await inspectVideo(file);
    const video = await uploadMedia(file, file.name, 'videos', percent => onProgress?.(Math.min(99, percent)));
    let coverKey;
    if (thumbnail) {
      try { coverKey = (await uploadMedia(thumbnail, 'cover.jpg', 'thumbnails')).uploadKey; }
      catch { /* A valid avatar video can still be saved without an optional cover. */ }
    }
    const avatar = entity(await request(`${API}/avatars`, {
      method: 'POST', body: { name: displayName, uploadKey: video.uploadKey, ...(coverKey ? { coverKey } : {}), ...metadata, fileSize: file.size },
    }), 'avatar');
    onProgress?.(100);
    return avatar;
  },
  renameAvatar: async (id, name) => {
    identifier(id);
    return entity(await request(`${API}/avatars`, { method: 'PATCH', body: { id, name: mediaName(name, {}) } }), 'avatar');
  },
  deleteAvatar: async id => success(await request(`${API}/avatars?id=${identifier(id)}`, { method: 'DELETE' })),
  async createVoice(file, { name, description = '', onProgress } = {}) {
    uploadDescriptor(file, file?.name || '', 'voices');
    const displayName = mediaName(name, file);
    const uploaded = await uploadMedia(file, file.name, 'voices', percent => onProgress?.(Math.min(99, percent)));
    const voice = entity(await request(`${API}/voices`, {
      method: 'POST', body: { name: displayName, description, uploadKey: uploaded.uploadKey },
    }), 'voice');
    onProgress?.(100);
    return voice;
  },
  deleteVoice: async id => success(await request(`${API}/voices?id=${identifier(id)}`, { method: 'DELETE' })),
  createTask: async inputs => entity(await request(`${API}/tasks`, { method: 'POST', body: inputs }), 'task'),
  recoverTask: async id => entity(await request(`${API}/tasks/${identifier(id)}/recover`, { method: 'POST' }), 'task'),
  deleteTask: async id => success(await request(`${API}/tasks/${identifier(id)}`, { method: 'DELETE' })),
  downloadUrl(task, kind = 'video') {
    if (!task?.id || task.status !== 'completed') return '';
    let file;
    if (kind === 'video' && task.results?.finalVideoUrl) file = 'final.mp4';
    if (kind === 'preview' && task.results?.finalVideoUrl) file = 'preview.mp4';
    if (kind === 'audio' && task.results?.exactAudioUrl) file = task.results.audioFormat === 'mp3' ? 'voice-track.mp3' : 'voice-track.wav';
    if (kind === 'report') file = 'production-report.json';
    return file ? `${API}/tasks/${identifier(task.id)}/download/${file}` : '';
  },
  safeMediaUrl,
};
