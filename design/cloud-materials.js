import { accountStorageKey } from './account-storage.js';

const PREFIX = '/api/mix/materials';
const ID = /^[a-f0-9]{32}$/;
const VIDEO = /\.(mp4|mov|mkv|avi|m4v|mts|m2ts|webm)$/i;
const ACCEPT = '.mp4,.mov,.mkv,.avi,.m4v,.mts,.m2ts,.webm';
const readyClips = item => item?.state === 'ready' ? Number(item.indexed_clips) || 0 : 0;
const stopped = () => Object.assign(new Error('素材上传已停止'), { name: 'AbortError' });
const message = error => String(error?.message || '素材操作未完成，请重试').replace(/sk-[\w.-]+/gi, '[已隐藏]').slice(0, 600);

function sendUpload(url, { body, headers, signal, onProgress }) {
  if (typeof XMLHttpRequest === 'undefined') return globalThis.fetch(url, {
    method: 'PUT', body, headers, signal, credentials: 'omit', redirect: 'error',
  });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (fn, value) => { signal.removeEventListener('abort', abort); fn(value); };
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded); };
    xhr.onload = () => finish(resolve, { ok: xhr.status >= 200 && xhr.status < 300 });
    xhr.onerror = xhr.ontimeout = () => finish(reject, new Error('原片上传连接中断，请重新上传'));
    xhr.onabort = () => finish(reject, stopped());
    try {
      xhr.open('PUT', url);
      xhr.withCredentials = false;
      xhr.timeout = 3600000;
      for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
      if (signal.aborted) { finish(reject, stopped()); return; }
      signal.addEventListener('abort', abort, { once: true });
      xhr.send(body);
    } catch (error) { finish(reject, error); }
  });
}

function uploadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /^[a-z0-9][a-z0-9-]*-\d+\.cos\.[a-z0-9-]+\.myqcloud\.com$/.test(url.hostname)) return url.href;
  } catch { /* Reject any destination other than a direct private COS upload. */ }
  throw new Error('服务器返回的素材上传地址无效，请刷新后重试');
}

function validItem(item) {
  return ID.test(item?.id || '') && typeof item.name === 'string' &&
    item.url === `${PREFIX}/${item.id}/stream` &&
    ['uploading', 'queued', 'indexing', 'ready', 'failed', 'deleting'].includes(item.state);
}

export default class CloudMaterials {
  constructor({ api, fetch: send = sendUpload, onStatus = () => {}, pollInterval = 2500 } = {}) {
    this.mode = 'cloud';
    this.api = api;
    this.fetch = send;
    this.onStatus = onStatus;
    this.pollInterval = pollInterval;
    this.owner = accountStorageKey('mix-cloud-materials');
    this.active = true;
    this.controllers = new Set();
    this.version = 0;
    this.items = [];
    this.indexed = 0;
    this.connected = false;
    this.scanning = false;
    this.error = '';
    this.uploadBytes = 0;
    this.uploadTotal = 0;
    this.uploadStarted = 0;
    this.progressAt = -Infinity;
    this.transferredBytes = 0;
    this.batchKey = accountStorageKey('mix-cloud-upload-batch');
    this.batch = null;
    try {
      const saved = JSON.parse(globalThis.localStorage?.getItem(this.batchKey) || 'null');
      if (Number.isInteger(saved?.totalFiles) && Number.isInteger(saved?.remainingFiles)
          && saved.totalFiles > 0 && saved.remainingFiles >= 0 && saved.remainingFiles <= saved.totalFiles) this.batch = saved;
    } catch { /* A folder can still be selected again if browser storage is unavailable. */ }
    this.status = {};
  }

  get media() {
    return this.items.filter(item => !['uploading', 'deleting'].includes(item.state)).map(item => ({ ...item, type: 'video' }));
  }

  _guard() {
    if (this.owner !== accountStorageKey('mix-cloud-materials')) this.stop();
    if (!this.active) throw stopped();
  }

  async _call(path, options = {}) {
    this._guard();
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const result = await this.api(path, { ...options, signal: controller.signal });
      this._guard();
      return result;
    } catch (error) {
      this._guard();
      throw error;
    } finally { this.controllers.delete(controller); }
  }

  _report() {
    this._guard();
    const remainingFiles = this.batch?.remainingFiles ?? this.items.filter(item => item.state === 'uploading').length;
    this.status = { connected: this.connected, needsPermission: false, indexed: this.indexed,
      total: this.items.length, totalFiles: this.items.length, readyFiles: this.items.filter(item => item.state === 'ready').length,
      processing: this.items.some(item => ['queued', 'indexing'].includes(item.state)),
      uploadBytes: this.uploadBytes, uploadTotal: this.uploadTotal,
      uploadSpeed: this.scanning && this.uploadStarted ? this.transferredBytes / Math.max(1, (performance.now() - this.uploadStarted) / 1000) : 0,
      uploadPending: !this.scanning && remainingFiles > 0,
      batchFiles: this.batch?.totalFiles || 0, remainingFiles,
      error: this.error || this.items.find(item => item.state === 'failed')?.error || '' };
    this.onStatus(this.status);
    this._schedule();
  }

  _schedule() {
    if (!this.active || !this.items.some(item => ['queued', 'indexing', 'deleting'].includes(item.state))) {
      clearTimeout(this.timer); this.timer = null; return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.refresh().catch(error => {
          if (error.name !== 'AbortError' && this.active) { this.error = message(error); this._report(); }
        });
      }, this.pollInterval);
      this.timer.unref?.();
    }
  }

  _upsert(item) {
    if (!validItem(item)) throw new Error('服务器未返回有效素材，请刷新素材库');
    this.version++;
    const previous = this.items.find(value => value.id === item.id);
    this.indexed = Math.max(0, this.indexed + readyClips(item) - readyClips(previous));
    if (previous) this.items = this.items.map(value => value.id === item.id ? item : value);
    else this.items.push(item);
    this.connected = true;
    this._report();
  }

  async restore() { return this.refresh(); }

  async refresh() {
    const version = ++this.version;
    const result = await this._call(PREFIX);
    this._guard();
    if (version !== this.version) { this._schedule(); return; }
    if (result.configured !== true) throw new Error('云端素材库尚未配置完成');
    this.items = (result.items || []).filter(validItem);
    this.indexed = Math.max(0, Number(result.indexed_clips) || 0);
    this.connected = true;
    this.error = '';
    this._report();
  }

  choose({ directory = true } = {}) {
    this._guard();
    const input = document.createElement('input');
    input.type = 'file'; input.accept = ACCEPT; input.multiple = true;
    if (directory) input.webkitdirectory = true;
    input.addEventListener('change', () => this.selectFiles(input.files).catch(error => {
      if (error.name !== 'AbortError' && this.active) { this.error = message(error); this._report(); }
    }), { once: true });
    input.click();
  }

  _saveBatch() {
    try {
      if (this.batch) globalThis.localStorage?.setItem(this.batchKey, JSON.stringify(this.batch));
      else globalThis.localStorage?.removeItem(this.batchKey);
    } catch { /* Uploads remain usable without browser persistence. */ }
  }

  async selectFiles(files) {
    this._guard();
    if (this.scanning) return;
    const videos = Array.from(files || []).filter(file => VIDEO.test(file.name));
    this.error = '';
    if (!videos.length) this.error = '未找到可用的视频素材';
    else if (videos.some(file => !file.size || file.size > 5 * 1024 ** 3)) this.error = '视频不能为空，单个视频最大 5 GiB';
    if (this.error) { this._report(); return; }
    const legacy = this.items.filter(item => item.fingerprint === null && item.state !== 'deleting');
    const hasLegacy = videos.some(file => legacy.some(item => item.name === (file.webkitRelativePath || file.name) && item.bytes === file.size));
    const reuseLegacy = hasLegacy && globalThis.confirm?.('检测到同名、同大小的旧版云端素材。请确认这些本地视频从未修改或替换。\n\n确定：复用已上传的原片，继续未完成上传。\n取消：按当前本地文件重新上传。') === true;
    this._guard();
    this.scanning = true;
    this.uploadBytes = 0;
    this.transferredBytes = 0;
    this.uploadTotal = videos.reduce((sum, file) => sum + file.size, 0);
    this.uploadStarted = performance.now();
    this.progressAt = -Infinity;
    this.batch = { totalFiles: videos.length, remainingFiles: videos.length };
    this._saveBatch();
    this._report();
    let next = 0;
    const worker = async () => {
      while (this.active && next < videos.length) {
        const file = videos[next++];
        try {
          await this._upload(file, reuseLegacy);
          this._guard();
          this.batch.remainingFiles--;
          this._saveBatch();
          this._report();
        }
        catch (error) {
          if (error.name === 'AbortError' || !this.active) return;
          this.error = `${file.name}：${message(error)}`;
          this._report();
        }
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(3, videos.length) }, worker)); }
    finally {
      if (this.active) { this.scanning = false; this._report(); }
    }
  }

  async _upload(file, reuseLegacy = false) {
    const name = file.webkitRelativePath || file.name;
    const identity = new TextEncoder().encode(JSON.stringify([name, file.size, file.lastModified || 0]));
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', identity)), value => value.toString(16).padStart(2, '0')).join('');
    const result = await this._call(`${PREFIX}/uploads`, { method: 'POST', body: JSON.stringify({ name, bytes: file.size, fingerprint, ...(reuseLegacy ? { reuse_legacy: true } : {}) }) });
    if (!ID.test(result.id || '')) throw new Error('服务器未返回有效素材，请刷新素材库');
    if (result.item) {
      if (!validItem(result.item) || result.item.id !== result.id || ['uploading', 'deleting'].includes(result.item.state)) throw new Error('服务器未确认原片上传，请重试');
      this.uploadBytes += file.size;
      this._upsert(result.item);
      return;
    }
    const url = uploadUrl(result.upload_url);
    this._upsert({ id: result.id, name, bytes: file.size, duration: null, state: 'uploading', error: null, indexed_clips: 0, url: `${PREFIX}/${result.id}/stream` });
    const controller = new AbortController();
    this.controllers.add(controller);
    let loaded = 0;
    const progress = bytes => {
      if (!this.active || controller.signal.aborted) return;
      try { this._guard(); } catch { return; }
      const current = Math.min(file.size, Math.max(loaded, Number(bytes) || 0));
      this.uploadBytes += current - loaded;
      this.transferredBytes += current - loaded;
      loaded = current;
      if (performance.now() - this.progressAt >= 1000 || current === file.size) {
        this.progressAt = performance.now();
        this._report();
      }
    };
    try {
      const response = await this.fetch(url, { method: 'PUT', body: file, headers: result.headers || {},
        credentials: 'omit', redirect: 'error', signal: controller.signal, onProgress: progress });
      this._guard();
      if (!response.ok) throw new Error('原片上传未完成，请重新上传');
      progress(file.size);
    } finally { this.controllers.delete(controller); }
    const complete = await this._call(`${PREFIX}/${result.id}/complete`, { method: 'POST', body: '{}' });
    this._upsert(complete.item);
  }

  async retry(id) {
    if (!ID.test(id) || !this.items.some(item => item.id === id)) return;
    const result = await this._call(`${PREFIX}/${id}/retry`, { method: 'POST', body: '{}' });
    this._upsert(result.item);
  }

  async scan() {
    await this.refresh();
    for (const item of this.items.filter(item => item.state === 'failed')) await this.retry(item.id);
  }

  async delete(id) {
    if (!ID.test(id) || !this.items.some(item => item.id === id)) return;
    await this._call(`${PREFIX}/${id}`, { method: 'DELETE' });
    this.version++;
    this.indexed = Math.max(0, this.indexed - readyClips(this.items.find(item => item.id === id)));
    this.items = this.items.filter(item => item.id !== id);
    this._report();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.items = [];
    this.indexed = 0;
    this.connected = false;
    this.scanning = false;
  }
}
