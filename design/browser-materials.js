import { accountStorageKey } from './account-storage.js';

const root = globalThis;

  const PREFIX = '/api/browser-materials';
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const MAX_SOURCE_SIZE = 512 * 1024 * 1024;
  const CLIP_BODY_LIMIT = 262144;
  const WORKERS = 3;
  const noop = () => {};
  const isAbort = error => error?.name === 'AbortError';
  const mediaError = message => Object.assign(new Error(message), { code: 'MEDIA_DECODE' });
  const repairVideo = async (...args) => (await import('./material-repair.js')).repairVideo(...args);

  async function sha256(value) {
    if (!root.crypto?.subtle) throw new Error('请通过 HTTPS 或本机 localhost 打开网页后连接素材文件夹');
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const result = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function assetId(relativePath, size, lastModified) {
    return sha256(JSON.stringify([relativePath, size, lastModified]));
  }

  async function makeClips(id, name, duration, guard = noop) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长，请检查文件或转换为 MP4（H.264）');
    const clips = [];
    for (let start = 0; start < duration; start += 8) {
      guard();
      const end = Math.min(start + 8, duration);
      const clipId = await sha256(id + ':' + start + ':' + end);
      guard();
      clips.push({ id: clipId, asset_id: id, name, start, end, state: 'pending' });
    }
    return clips;
  }

  async function inspectFile(relativePath, file, previous, readDuration, guard = noop) {
    guard();
    if (file.size > MAX_SOURCE_SIZE) throw Object.assign(new Error('原视频超过 512 MiB，已排到队尾自动压缩'), { code: 'MEDIA_SIZE' });
    await file.slice(0, 1).arrayBuffer();
    guard();
    if (previous && previous.size === file.size && previous.lastModified === file.lastModified) return previous;
    const id = await assetId(relativePath, file.size, file.lastModified);
    guard();
    const duration = await readDuration(file);
    guard();
    const clips = await makeClips(id, relativePath, duration, guard);
    guard();
    return { relativePath, assetId: id, size: file.size, lastModified: file.lastModified, duration, clips };
  }

  function reconcileManifest(previous, observations, complete, deferred = []) {
    complete = complete && observations.every(observation => observation.entry && !observation.error);
    const manifest = { ...previous };
    const seen = new Set();
    const revocations = new Set(deferred);
    for (const observation of observations) {
      const path = observation.relativePath;
      seen.add(path);
      if (!observation.entry) continue;
      if (previous[path] && previous[path].assetId !== observation.entry.assetId) revocations.add(previous[path].assetId);
      manifest[path] = observation.entry;
    }
    if (complete) {
      for (const [path, value] of Object.entries(previous)) {
        if (seen.has(path)) continue;
        revocations.add(value.assetId);
        delete manifest[path];
      }
    }
    for (const value of Object.values(manifest)) revocations.delete(value.assetId);
    return { manifest, revocations: complete ? [...revocations] : [],
      deferredRevocations: complete ? [] : [...revocations] };
  }

  function validateOffset(offset, size) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new Error('服务器返回的素材上传偏移无效，请重试');
    return offset;
  }

  async function transferFile({ file, upload, create, head, patch, complete, onUpload = noop, guard = noop }) {
    if (file.size > MAX_SOURCE_SIZE) throw new Error('原视频超过 512 MiB，请先拆分或压缩后重新扫描');
    guard();
    let offset;
    if (upload) {
      try {
        offset = await head(upload.id);
        guard();
      } catch (error) {
        guard();
        if (error.status !== 404 && error.status !== 410) throw error;
        upload = null;
      }
    }
    if (!upload) {
      upload = await create(file.size);
      guard();
      offset = upload.offset;
      await onUpload(upload);
      guard();
    }
    offset = validateOffset(offset, file.size);
    while (offset < file.size) {
      guard();
      const bytes = await file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size)).arrayBuffer();
      guard();
      const checksum = await sha256(bytes);
      guard();
      let next;
      try {
        next = await patch(upload.id, offset, bytes, checksum);
        guard();
      } catch (error) {
        guard();
        next = await head(upload.id);
        guard();
        if (next === offset) throw error;
      }
      next = validateOffset(next, file.size);
      if (next <= offset) throw new Error('素材上传未前进，请重新连接后重试');
      offset = next;
    }
    guard();
    await complete(upload.id);
    guard();
    return upload;
  }

  function createFolderStore(namespace = accountStorageKey('workbench-browser-materials')) {
    let database;
    function open() {
      if (!database) database = new Promise((resolve, reject) => {
        if (!root.indexedDB) return reject(new Error('此浏览器无法保存素材目录，请使用支持 IndexedDB 的浏览器'));
        const request = root.indexedDB.open(namespace, 2);
        request.onupgradeneeded = () => {
          for (const name of ['folder', 'repairs']) {
            if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('无法保存素材目录，请检查浏览器的隐私或存储设置'));
        request.onblocked = () => reject(new Error('素材目录存储被其他页面占用，请关闭其他页面后重试'));
      });
      return database;
    }
    async function transaction(mode, action, name = 'folder') {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(name, mode);
        const request = action(tx.objectStore(name));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('素材目录保存失败，请重试'));
      });
    }
    return { get: () => transaction('readonly', store => store.get('current')),
      put: value => transaction('readwrite', store => store.put(value, 'current')),
      clear: () => transaction('readwrite', store => store.delete('current')),
      getRepair: id => transaction('readonly', store => store.get(id), 'repairs'),
      putRepair: (id, file) => transaction('readwrite', store => store.put(file, id), 'repairs'),
      deleteRepair: id => transaction('readwrite', store => store.delete(id), 'repairs'),
      clearRepairs: () => transaction('readwrite', store => store.clear(), 'repairs') };
  }

  function mediaEvent(video, event, signal) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener(event, ready);
        video.removeEventListener('error', failed);
        signal?.removeEventListener('abort', aborted);
      };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(mediaError('浏览器无法解码视频，已排到队尾转换为 MP4')); };
      const aborted = () => { cleanup(); reject(Object.assign(new Error('操作已停止'), { name: 'AbortError' })); };
      const timer = setTimeout(() => { cleanup(); reject(mediaError('读取视频超时，已排到队尾检查并转换为 MP4')); }, 5000);
      video.addEventListener(event, ready, { once: true });
      video.addEventListener('error', failed, { once: true });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  async function withVideo(file, signal, action) {
    const video = root.document.createElement('video');
    const url = root.URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    try {
      const metadata = mediaEvent(video, 'loadedmetadata', signal);
      video.src = url;
      video.load();
      await metadata;
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw mediaError('无法读取视频时长，已排到队尾转换为 MP4');
      return await action(video);
    } finally {
      video.pause();
      video.removeAttribute('src');
      video.load();
      root.URL.revokeObjectURL(url);
    }
  }

  function readDuration(file, signal) {
    return withVideo(file, signal, video => video.duration);
  }

  function sampleFrames(file, start, end, signal) {
    return withVideo(file, signal, async video => {
      const canvas = root.document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context || !video.videoWidth || !video.videoHeight) throw mediaError('浏览器无法读取视频画面，已排到队尾转换为 MP4');
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
      const frames = [];
      for (let i = 0; i < Math.ceil(end - start); i++) {
        if (signal?.aborted) throw Object.assign(new Error('操作已停止'), { name: 'AbortError' });
        const time = Math.min(start + i, Math.max(0, video.duration - 0.001));
        if (Math.abs(video.currentTime - time) > 0.0001) {
          const seeked = mediaEvent(video, 'seeked', signal);
          video.currentTime = time;
          await seeked;
        } else if (video.readyState < 2) await mediaEvent(video, 'loadeddata', signal);
        if (signal?.aborted) throw Object.assign(new Error('操作已停止'), { name: 'AbortError' });
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL('image/jpeg', 0.8));
      }
      return frames;
    });
  }

  const isVideo = name => /\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpeg|mpg|mts|m2ts|3gp|flv|ts)$/i.test(name);
  async function* directoryFiles(handle, guard, prefix = '') {
    for await (const child of handle.values()) {
      guard();
      const relativePath = prefix + child.name;
      if (child.kind === 'directory') yield* directoryFiles(child, guard, relativePath + '/');
      else if (child.kind === 'file' && isVideo(child.name)) yield { relativePath, handle: child };
    }
  }

  export default class BrowserMaterials {
    constructor({ api, onStatus = noop, onConnected = noop, store, readDuration: durationReader,
      sampleFrames: frameSampler, repairVideo: videoRepairer, fetch: fetcher } = {}) {
      this.api = api;
      this.ownerKey = accountStorageKey('workbench-browser-materials');
      this.onStatus = onStatus;
      this.onConnected = onConnected;
      this.store = store || createFolderStore();
      this.readDuration = durationReader || readDuration;
      this.sampleFrames = frameSampler || sampleFrames;
      this.repairVideo = videoRepairer || repairVideo;
      this.fetch = fetcher || root.fetch?.bind(root);
      this.record = null;
      this.files = new Map();
      this.originalFiles = new Map();
      this.selectedFiles = [];
      this.errors = new Map();
      this.retryAfter = new Map();
      this.unreadableFiles = new Set();
      this.repairs = new Map();
      this.attempts = new Map();
      this.workers = new Map();
      this.registered = new Set();
      this.requests = [];
      this.generation = 0;
      this.active = false;
      this.connected = false;
      this.status = { text: '选择素材文件夹', error: '', scanned: 0, indexed: 0, total: 0,
        needsPermission: false, connected: false };
    }

    get deviceId() { return this.active && this.connected ? this.record?.deviceId || '' : ''; }
    get folderName() { return this.record?.name || ''; }

    _guard(token) {
      if (this.ownerKey !== accountStorageKey('workbench-browser-materials')) this.stop();
      if (!this.active || token !== this.generation) throw Object.assign(new Error('操作已停止'), { name: 'AbortError' });
    }

    _activate() {
      this.active = true;
      this.abort = new AbortController();
      this.workers = new Map();
      this.lastRequests = 0;
      this.lastHeartbeat = 0;
      this.requests = [];
      return this.generation;
    }

    _report(value = {}) {
      const clips = Object.values(this.record?.manifest || {}).flatMap(entry => entry.clips || []);
      this.status = { ...this.status, ...value, connected: this.connected, folderName: this.folderName,
        indexed: clips.filter(clip => clip.state === 'indexed').length, total: clips.length };
      this.onStatus(this.status);
    }

    _ready() {
      const clips = Object.values(this.record?.manifest || {}).flatMap(entry => entry.clips || []);
      const repairs = [...this.repairs.values()].filter(item => !item.attempted).length;
      this._report({ text: this.folderName + ' · 已扫描 ' + this.status.scanned + ' 个视频 · 已索引 ' +
        clips.filter(clip => clip.state === 'indexed').length + '/' + clips.length + ' 个片段' +
        (this.workers.size ? ' · ' + this.workers.size + ' 项处理中' : '') + (repairs ? ' · ' + repairs + ' 个视频待修复' : '') });
    }

    _error(path, error) {
      this.errors.set(path, error.message || String(error));
      this._report({ error: [...this.errors].map(([name, message]) => name + '：' + message).join('\n'),
        needsPermission: this.status.needsPermission || ['NotAllowedError', 'SecurityError'].includes(error.name) });
    }

    async _save(token) {
      this._guard(token);
      await this.store.put(this.record);
      this._guard(token);
    }

    async _api(path, options, token) {
      this._guard(token);
      let result;
      try { result = await this.api(PREFIX + path, { ...options, signal: this.abort.signal }); }
      catch (error) { this._guard(token); throw error; }
      this._guard(token);
      return result;
    }

    _post(path, value, token) { return this._api(path, { method: 'POST', body: JSON.stringify(value) }, token); }
    _devicePath(path) { return '/devices/' + this.record.deviceId + path; }

    async _connect(token) {
      await this._releaseRetired(token);
      const result = await this._post('/connect', { folder_key: this.record.folderKey, name: this.record.name }, token);
      if (this.record.deviceId !== result.device_id) {
        this.record.uploads = {};
        this.record.deferredRevocations = [];
      }
      this.record.deviceId = result.device_id;
      this.connected = true;
      await this._save(token);
      this._report({ needsPermission: false, text: '已连接素材文件夹：' + this.folderName });
      this.onConnected(this.deviceId);
    }

    async _revokeDevice(id, token) {
      try { await this._api('/devices/' + id, { method: 'DELETE' }, token); }
      catch (error) {
        this._guard(token);
        if (error.status !== 404 && error.status !== 410) throw error;
      }
    }

    async _releaseRetired(token) {
      for (const id of [...this.record.retiredDeviceIds || []]) {
        await this._revokeDevice(id, token);
        this._guard(token);
        this.record.retiredDeviceIds = this.record.retiredDeviceIds.filter(value => value !== id);
        await this._save(token);
      }
    }

    async restore() {
      this.stop();
      const token = this._activate();
      this.connected = false;
      try {
        this.record = await this.store.get() || null;
        this._guard(token);
        if (!this.record) { this.connected = false; this._report({ text: '选择素材文件夹', needsPermission: false }); return; }
        this.record.manifest ||= {};
        this.record.uploads ||= {};
        this.record.deferredRevocations ||= [];
        const permission = this.record.handle?.queryPermission ? await this.record.handle.queryPermission({ mode: 'read' }) : 'prompt';
        this._guard(token);
        if (permission !== 'granted') {
          this.connected = false;
          this._report({ text: '重新连接素材文件夹', needsPermission: true, error: '' });
          this.onConnected('');
          return;
        }
        await this._connect(token);
        this._guard(token);
        await this._scan(token);
      } catch (error) { if (this.active && token === this.generation && !isAbort(error)) this._error('素材文件夹', error); }
    }

    async choose({ reconnectOnly = false } = {}) {
      if (!root.showDirectoryPicker) return this._chooseFiles({ reconnectOnly });
      // Invoke the picker before any await so the original click activation remains valid.
      const generation = this.generation;
      const picking = root.showDirectoryPicker({ mode: 'read' });
      const handle = await picking;
      if (generation !== this.generation) return;
      this.stop();
      const token = this._activate();
      try {
        const previous = await this.store.get();
        this._guard(token);
        const same = previous?.handle?.isSameEntry ? await previous.handle.isSameEntry(handle) : false;
        this._guard(token);
        if (reconnectOnly && !same) throw new Error('正在制作，请重新选择原素材文件夹');
        await this._select(handle.name, handle, same ? previous : null, token, previous);
      } catch (error) { if (this.active && token === this.generation && !isAbort(error)) this._error('素材文件夹', error); }
    }

    _chooseFiles(options) {
      const generation = this.generation;
      const input = root.document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.setAttribute('webkitdirectory', '');
      input.hidden = true;
      root.document.body.appendChild(input);
      return new Promise((resolve, reject) => {
        input.addEventListener('change', () => {
          const files = Array.from(input.files || []);
          input.remove();
          if (!files.length || generation !== this.generation) resolve();
          else this.selectFiles(files, options).then(resolve, reject);
        }, { once: true });
        input.addEventListener('cancel', () => { input.remove(); resolve(); }, { once: true });
        input.click();
      });
    }

    async selectFiles(fileList, { reconnectOnly = false } = {}) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      this.stop();
      const token = this._activate();
      try {
        const name = (files[0].webkitRelativePath || '').split('/')[0] || '本地素材';
        const previous = await this.store.get();
        this._guard(token);
        const same = previous && !previous.handle && previous.name === name;
        if (reconnectOnly && !same) throw new Error('正在制作，请重新选择原素材文件夹');
        this.selectedFiles = files.filter(file => isVideo(file.name));
        await this._select(name, null, same ? previous : null, token, previous);
      } catch (error) { if (this.active && token === this.generation && !isAbort(error)) this._error('素材文件夹', error); }
    }

    async _select(name, handle, previous, token, replaced) {
      const key = previous?.folderKey || await sha256(root.crypto.randomUUID());
      this._guard(token);
      this.record = previous || { folderKey: key, name, deviceId: '', manifest: {}, deferredRevocations: [], uploads: {} };
      if (!previous && replaced) this.record.retiredDeviceIds = [...new Set([...(replaced.retiredDeviceIds || []), replaced.deviceId].filter(Boolean))];
      this.connected = false;
      this.record.handle = handle;
      this.record.name = name;
      this.record.uploads ||= {};
      this.record.manifest ||= {};
      this.record.deferredRevocations ||= [];
      this.files.clear();
      this.errors.clear();
      this.retryAfter.clear();
      if (!previous) {
        await this.store.clearRepairs?.();
        this._guard(token);
      }
      this._report({ error: '', scanned: 0, needsPermission: false, uploadBytes: 0, uploadTotal: 0 });
      await this._save(token);
      await this._connect(token);
      this._guard(token);
      await this._scan(token);
    }

    async scan() {
      if (!this.record?.handle) return this._chooseFiles();
      this.stop();
      const token = this._activate();
      await this._releaseRetired(token);
      await this._scan(token);
    }

    async _scan(token) {
      this._guard(token);
      clearTimeout(this.timer);
      this.scanning = true;
      this.registered.clear();
      this.unreadableFiles.clear();
      this.repairs.clear();
      this.attempts.clear();
      this.processingDeferred = false;
      this.errors.clear();
      this._report({ text: '正在扫描素材文件夹：' + this.folderName, error: '', scanned: 0, needsPermission: false });
      const candidates = [];
      const observations = [];
      const files = new Map();
      const originals = new Map();
      let complete = true;
      try {
        try {
          if (this.record.handle) {
            for await (const item of directoryFiles(this.record.handle, () => this._guard(token))) candidates.push(item);
          } else {
            for (const file of this.selectedFiles) {
              const path = file.webkitRelativePath || file.name;
              candidates.push({ relativePath: path.includes('/') ? path.slice(path.indexOf('/') + 1) : path, file });
            }
          }
        } catch (error) {
          this._guard(token);
          complete = false;
          this._error('素材文件夹', error);
        }
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(WORKERS, candidates.length) }, async () => {
          while (cursor < candidates.length) {
            this._guard(token);
            const index = cursor++, item = candidates[index];
            let file;
            try {
              file = item.file || await item.handle.getFile();
              this._guard(token);
              originals.set(item.relativePath, file);
              const previous = this.record.manifest[item.relativePath];
              let entry, readable = file;
              if (previous?.repaired && previous.size === file.size && previous.lastModified === file.lastModified) {
                readable = await this.store.getRepair?.(previous.assetId);
                this._guard(token);
                if (!readable) throw mediaError('压缩副本缓存已失效，已排到队尾重新生成');
                // Check that the selected original still exists before reusing its cached copy.
                await file.slice(0, 1).arrayBuffer();
                this._guard(token);
                entry = previous;
              } else {
                entry = await inspectFile(item.relativePath, file, previous,
                  current => this.readDuration(current, this.abort.signal), () => this._guard(token));
              }
              this._guard(token);
              observations[index] = { relativePath: item.relativePath, entry };
              files.set(item.relativePath, readable);
            } catch (error) {
              this._guard(token);
              complete = false;
              observations[index] = { relativePath: item.relativePath, error: error.message };
              if (file && (file.size > MAX_SOURCE_SIZE || error.code === 'MEDIA_DECODE')) this._queueRepair(item.relativePath, file);
              this._error(item.relativePath, error);
            }
            this._report({ text: '并行扫描 ' + this.folderName + '：' + (this.status.scanned + 1) + '/' + candidates.length + ' 个视频',
              scanned: this.status.scanned + 1 });
          }
        }));
        this._guard(token);
        const result = reconcileManifest(this.record.manifest, observations, complete, this.record.deferredRevocations || []);
        this.record.manifest = result.manifest;
        this.record.deferredRevocations = [...new Set([...result.deferredRevocations, ...result.revocations])];
        this.files = files;
        this.originalFiles = originals;
        await this._save(token);
        const clips = observations.flatMap(item => item.entry?.clips || []);
        await this._register(clips, token);
        this._guard(token);
        this.lastStateCheck = Date.now();
        if (complete) {
          for (const id of result.revocations) {
            await this._api(this._devicePath('/assets/' + id), { method: 'DELETE' }, token);
            this._guard(token);
            this.record.deferredRevocations = this.record.deferredRevocations.filter(value => value !== id);
            await this.store.deleteRepair?.(id);
            this._guard(token);
            await this._save(token);
          }
        }
        this._ready();
      } catch (error) { if (this.active && token === this.generation && !isAbort(error)) this._error('素材文件夹', error); }
      finally {
        if (this.active && token === this.generation) {
          this.scanning = false;
          this._schedule(0, token);
        }
      }
    }

    start() {
      if (!this.active) this._activate();
      if (this.connected && !this.scanning) this._schedule(0, this.generation);
    }

    async _register(clips, token) {
      const encoder = new TextEncoder();
      const emptyBytes = encoder.encode(JSON.stringify({ clips: [] })).byteLength;
      for (let offset = 0; offset < clips.length;) {
        const batch = [];
        const payload = [];
        let bodyBytes = emptyBytes;
        while (offset + batch.length < clips.length && batch.length < 500) {
          const clip = clips[offset + batch.length];
          const { id, asset_id, name, start, end } = clip;
          const item = { id, asset_id, name, start, end };
          const itemBytes = encoder.encode(JSON.stringify(item)).byteLength;
          if (emptyBytes + itemBytes > CLIP_BODY_LIMIT) throw new Error('素材片段名称过长，请缩短文件名或目录名后重试');
          const nextBytes = bodyBytes + itemBytes + (batch.length ? 1 : 0);
          if (nextBytes > CLIP_BODY_LIMIT) break;
          batch.push(clip);
          payload.push(item);
          bodyBytes = nextBytes;
        }
        const response = await this._post(this._devicePath('/clips'), { clips: payload }, token);
        this._guard(token);
        const states = new Map((response.clips || []).map(clip => [clip.id, clip.state]));
        for (const clip of batch) {
          if (!states.has(clip.id)) throw new Error('服务器未确认素材片段，请重新扫描素材文件夹');
          clip.state = states.get(clip.id);
          this.registered.add(clip.id);
        }
        await this._save(token);
        offset += batch.length;
      }
    }

    async _heartbeat(token) {
      if (Date.now() - this.lastHeartbeat < 15000) return;
      await this._post(this._devicePath('/heartbeat'), { status: 'ready', error: this.status.error.slice(0, 1000) }, token);
      this._guard(token);
      this.lastHeartbeat = Date.now();
    }

    stop() {
      this.active = false;
      this.generation++;
      this.abort?.abort();
      clearTimeout(this.timer);
      this.scanning = false;
    }

    async disconnect() {
      this.stop();
      const token = this._activate();
      this.connected = false;
      if (this.record) {
        await this._releaseRetired(token);
        if (this.record.deviceId) await this._revokeDevice(this.record.deviceId, token);
      }
      this._guard(token);
      await this.store.clear();
      this._guard(token);
      await this.store.clearRepairs?.();
      this._guard(token);
      this.stop();
      this.record = null;
      this.files.clear();
      this.selectedFiles = [];
      this.originalFiles.clear();
      this.errors.clear();
      this._report({ text: '选择素材文件夹', error: '', scanned: 0, needsPermission: false, uploadBytes: 0, uploadTotal: 0 });
      this.onConnected('');
    }

    _schedule(delay, token) {
      if (!this.active || !this.connected || this.scanning || token !== this.generation || this.cycleToken === token) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._cycle(token), delay);
    }

    async _cycle(token) {
      if (!this.active || token !== this.generation || this.cycleToken === token) return;
      this.cycleToken = token;
      let delay = 3000;
      try {
        this._guard(token);
        const now = Date.now();
        if (now - this.lastRequests >= 3000) {
          const result = await this._api(this._devicePath('/requests'), {}, token);
          this._guard(token);
          this.requests = result.requests || [];
          this.lastRequests = Date.now();
        }
        await this._heartbeat(token);
        this._guard(token);
        const request = this.requests.find(item => (this.retryAfter.get('request:' + item.id) || 0) <= Date.now());
        if (request) {
          try {
            await this._serve(request, token);
            this._guard(token);
            this.requests = this.requests.filter(item => item.id !== request.id);
            this.retryAfter.delete('request:' + request.id);
          } catch (error) {
            this._guard(token);
            this.retryAfter.set('request:' + request.id, Date.now() + 15000);
            this._error('素材传输', error);
          }
          delay = 0;
        } else {
          if (Date.now() - this.lastStateCheck >= 30000) {
            const busy = Object.values(this.record.manifest).filter(entry => this.files.has(entry.relativePath))
              .flatMap(entry => entry.clips.filter(clip => this.registered.has(clip.id) && clip.state === 'indexing' && !this.workers.has(clip.id)));
            await this._register(busy, token);
            this._guard(token);
            this.lastStateCheck = Date.now();
            this._ready();
          }
          const candidates = Object.values(this.record.manifest)
            .filter(item => this.files.has(item.relativePath) && !this.unreadableFiles.has(item.assetId))
            .flatMap(item => item.clips.filter(clip => this.registered.has(clip.id) && !this.workers.has(clip.id) &&
              ['pending', 'error'].includes(clip.state)).map(clip => ({ item, clip })));
          const fresh = candidates.filter(({ clip }) => !this.attempts.has(clip.id));
          if (!fresh.length && !this.workers.size) this.processingDeferred = true;
          let queued = fresh;
          if (!fresh.length && this.processingDeferred) {
            const repair = [...this.repairs.values()].find(item => !item.attempted);
            if (repair && ![...this.workers.keys()].some(key => key.startsWith('repair:')) && this.workers.size < WORKERS) {
              repair.attempted = true;
              this._startWork('repair:' + repair.relativePath, () => this._repairFile(repair, token), token);
            }
            queued = candidates.filter(({ clip }) => this.attempts.get(clip.id) < 2);
          }
          for (const { item, clip } of queued.slice(0, WORKERS - this.workers.size)) {
            this.attempts.set(clip.id, (this.attempts.get(clip.id) || 0) + 1);
            this._startWork(clip.id, () => this._analyzeClip(item, clip, token), token);
          }
        }
      } catch (error) { if (this.active && token === this.generation && !isAbort(error)) this._error('素材连接', error); }
      finally {
        if (this.cycleToken === token) this.cycleToken = null;
        this._schedule(delay, token);
      }
    }

    _startWork(key, action, token) {
      const workers = this.workers;
      const work = Promise.resolve().then(() => { this._guard(token); return action(); })
        .catch(error => { if (this.active && token === this.generation && !isAbort(error)) this._error('素材连接', error); })
        .finally(() => {
          workers.delete(key);
          if (this.active && token === this.generation) { this._ready(); this._schedule(0, token); }
        });
      workers.set(key, work);
    }

    _queueRepair(relativePath, file) {
      if (!this.repairs.has(relativePath)) this.repairs.set(relativePath, { relativePath, file, attempted: false });
    }

    async _analyzeClip(item, clip, token) {
      let sampling = true;
      this._report({ text: '并行读取素材画面：' + item.relativePath });
      try {
        const frames = await this.sampleFrames(this.files.get(item.relativePath), clip.start, clip.end, this.abort.signal);
        this._guard(token);
        sampling = false;
        this._report({ text: '并行 AI 分析素材：' + item.relativePath });
        const result = await this._post(this._devicePath('/analyze'), { clip_id: clip.id, frames }, token);
        this._guard(token);
        if (!result.complete) throw new Error('素材分析仍在处理中，将在队尾重试');
        clip.state = 'indexed';
        if (item.clips.every(value => value.state !== 'error')) this.errors.delete(item.relativePath);
        this._report({ error: [...this.errors].map(([name, message]) => name + '：' + message).join('\n') });
      } catch (error) {
        this._guard(token);
        clip.state = error.status === 409 ? 'indexing' : 'error';
        if (sampling) {
          this.unreadableFiles.add(item.assetId);
          this._queueRepair(item.relativePath, this.originalFiles.get(item.relativePath) || this.files.get(item.relativePath));
        }
        this._error(item.relativePath, error);
      }
      await this._save(token);
    }

    async _repairFile(repair, token) {
      const { relativePath, file } = repair;
      try {
        const previous = this.record.manifest[relativePath];
        const id = await assetId(relativePath, file.size, file.lastModified);
        this._guard(token);
        const copy = await this.repairVideo(file, { signal: this.abort.signal, maxSize: MAX_SOURCE_SIZE,
          onProgress: ({ progress = 0 } = {}) => {
            if (this.active && token === this.generation) this._report({ text: '正在压缩 / 转换 MP4：' + relativePath +
              (progress > 0 ? ' · ' + Math.min(100, Math.round(progress * 100)) + '%' : '') });
          } });
        this._guard(token);
        if (!copy || copy.size > MAX_SOURCE_SIZE) throw new Error('压缩后的文件仍超过 512 MiB，请缩短视频后重新扫描');
        const duration = await this.readDuration(copy, this.abort.signal);
        this._guard(token);
        const unchanged = previous?.assetId === id;
        const clips = unchanged ? previous.clips : await makeClips(id, relativePath, duration, () => this._guard(token));
        this._guard(token);
        // Cache separately from the small manifest so every clip save does not copy video data.
        await this.store.putRepair?.(id, copy);
        this._guard(token);
        this.record.manifest[relativePath] = { relativePath, assetId: id, size: file.size,
          lastModified: file.lastModified, duration: unchanged ? previous.duration : duration, clips, repaired: true };
        this.files.set(relativePath, copy);
        this.unreadableFiles.delete(id);
        if (previous && !unchanged) this.record.deferredRevocations.push(previous.assetId);
        await this._register(clips, token);
        for (const clip of clips) this.attempts.delete(clip.id);
        this.errors.delete(relativePath);
        this._report({ error: [...this.errors].map(([name, message]) => name + '：' + message).join('\n') });
      } catch (error) {
        this._guard(token);
        this._error(relativePath, error);
      }
    }

    async _serve(request, token) {
      const entry = Object.values(this.record.manifest).find(value => value.assetId === request.asset_id);
      const file = entry && this.files.get(entry.relativePath);
      if (!file) throw new Error('请求的原视频不可读取或版本已改变，请重新扫描素材文件夹');
      const path = this._devicePath('/requests/' + request.id);
      this._report({ text: '正在传输素材：' + entry.relativePath });
      if (request.kind === 'proxy') {
        const frames = await this.sampleFrames(file, request.start, request.end, this.abort.signal);
        this._guard(token);
        const result = await this._post(path + '/frames', { frames }, token);
        if (!result.complete) throw new Error('素材预览传输未完成，请重试');
      } else if (request.kind === 'source') {
        this._report({ uploadBytes: 0, uploadTotal: file.size });
        const saved = this.record.uploads[request.id];
        await transferFile({ file, upload: saved?.assetId === entry.assetId ? saved : null,
          guard: () => this._guard(token), create: size => this._post(path + '/file', { size }, token),
          onUpload: async upload => {
            this._guard(token);
            this.record.uploads[request.id] = { id: upload.id, assetId: entry.assetId, size: file.size };
            await this._save(token);
          }, head: id => this._uploadOffset(id, token),
          patch: async (id, offset, bytes, checksum) => {
            await this._heartbeat(token);
            this._guard(token);
            const result = await this._api(this._devicePath('/files/' + id), { method: 'PATCH', body: bytes,
              headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset), 'Upload-Checksum': checksum } }, token);
            this._report({ text: '正在临时传输素材：' + entry.relativePath + '（' + Math.round(result.offset / file.size * 100) + '%）',
              uploadBytes: result.offset, uploadTotal: file.size });
            return result.offset;
          }, complete: async id => {
            const result = await this._post(this._devicePath('/files/' + id + '/complete'), {}, token);
            if (!result.complete) throw new Error('原视频传输未完成，请重试');
          } });
        this._guard(token);
        delete this.record.uploads[request.id];
        await this._save(token);
      } else throw new Error('未知的素材请求，请重新连接素材文件夹');
      this._guard(token);
      this.errors.delete('素材传输');
      this._report({ error: [...this.errors].map(([name, message]) => name + '：' + message).join('\n'), uploadBytes: 0, uploadTotal: 0 });
      this._ready();
    }

    async _uploadOffset(id, token) {
      this._guard(token);
      const response = await this.fetch(PREFIX + this._devicePath('/files/' + id), { method: 'HEAD',
        credentials: 'same-origin', headers: { 'X-Workbench-Request': '1' }, signal: this.abort.signal });
      this._guard(token);
      if (!response.ok) throw Object.assign(new Error('无法恢复原视频上传，请重新连接后重试'), { status: response.status });
      const value = response.headers.get('Upload-Offset');
      if (value === null || !/^\d+$/.test(value)) throw new Error('服务器未返回素材上传进度，请重试');
      return Number(value);
    }
  }
  BrowserMaterials.helpers = { sha256, assetId, makeClips, inspectFile, reconcileManifest, transferFile,
    createFolderStore, readDuration, sampleFrames, CHUNK_SIZE, MAX_SOURCE_SIZE };
