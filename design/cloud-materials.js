import { accountStorageKey } from './account-storage.js';

const PREFIX = '/api/mix/materials';
const ID = /^[a-f0-9]{32}$/;
const VIDEO = /\.(mp4|mov|mkv|avi|m4v|mts|m2ts|webm)$/i;
const ACCEPT = '.mp4,.mov,.mkv,.avi,.m4v,.mts,.m2ts,.webm';
const readyClips = item => item?.state === 'ready' ? Number(item.indexed_clips) || 0 : 0;
const stopped = () => Object.assign(new Error('素材上传已停止'), { name: 'AbortError' });
const message = error => String(error?.message || '素材操作未完成，请重试').replace(/sk-[\w.-]+/gi, '[已隐藏]').slice(0, 600);

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
  constructor({ api, fetch: send = globalThis.fetch, onStatus = () => {}, pollInterval = 2500 } = {}) {
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
    this.status = { connected: this.connected, needsPermission: false, indexed: this.indexed,
      total: this.items.length, totalFiles: this.items.length, readyFiles: this.items.filter(item => item.state === 'ready').length,
      processing: this.items.some(item => ['queued', 'indexing'].includes(item.state)),
      uploadBytes: this.uploadBytes, uploadTotal: this.uploadTotal,
      error: this.error || this.items.find(item => item.state === 'failed')?.error || '' };
    this.onStatus(this.status);
    this._schedule();
  }

  _schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.active && this.items.some(item => ['queued', 'indexing', 'deleting'].includes(item.state))) {
      this.timer = setTimeout(() => this.refresh().catch(error => {
        if (error.name !== 'AbortError' && this.active) { this.error = message(error); this._report(); }
      }), this.pollInterval);
      this.timer.unref?.();
    }
  }

  _upsert(item) {
    if (!validItem(item)) throw new Error('服务器未返回有效素材，请刷新素材库');
    this.version++;
    const previous = this.items.find(value => value.id === item.id);
    this.indexed = Math.max(0, this.indexed + readyClips(item) - readyClips(previous));
    this.items = [item, ...this.items.filter(value => value.id !== item.id)];
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

  async selectFiles(files) {
    this._guard();
    if (this.scanning) return;
    const videos = Array.from(files || []).filter(file => VIDEO.test(file.name));
    this.error = '';
    if (!videos.length) this.error = '未找到可用的视频素材';
    else if (videos.some(file => !file.size || file.size > 5 * 1024 ** 3)) this.error = '视频不能为空，单个视频最大 5 GiB';
    if (this.error) { this._report(); return; }
    this.scanning = true;
    this.uploadBytes = 0;
    this.uploadTotal = videos.reduce((sum, file) => sum + file.size, 0);
    this._report();
    let next = 0;
    const worker = async () => {
      while (this.active && next < videos.length) {
        const file = videos[next++];
        try { await this._upload(file); }
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

  async _upload(file) {
    const name = file.webkitRelativePath || file.name;
    const result = await this._call(`${PREFIX}/uploads`, { method: 'POST', body: JSON.stringify({ name, bytes: file.size }) });
    if (!ID.test(result.id || '')) throw new Error('服务器未返回有效素材，请刷新素材库');
    const url = uploadUrl(result.upload_url);
    this._upsert({ id: result.id, name, bytes: file.size, duration: null, state: 'uploading', error: null, indexed_clips: 0, url: `${PREFIX}/${result.id}/stream` });
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const response = await this.fetch(url, { method: 'PUT', body: file, headers: result.headers || {},
        credentials: 'omit', redirect: 'error', signal: controller.signal });
      this._guard();
      if (!response.ok) throw new Error('原片上传未完成，请重新上传');
    } finally { this.controllers.delete(controller); }
    const complete = await this._call(`${PREFIX}/${result.id}/complete`, { method: 'POST', body: '{}' });
    this.uploadBytes += file.size;
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
