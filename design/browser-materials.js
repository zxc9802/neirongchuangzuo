import { accountStorageKey } from './account-storage.js';

const root = globalThis;

  const PREFIX = '/api/browser-materials';
  const CHUNK_SIZE = 4 * 1024 * 1024;
  // Sources are never uploaded whole: MP4/MOV send their index plus the needed packets,
  // other containers send a stream-copied segment around each request.
  const MAX_SOURCE_SIZE = 512 * 1024 * 1024;
  const MAX_INDEX_BOXES = 4096;
  const CLIP_BODY_LIMIT = 262144;
  const FRAME_WORKERS = 5;
  const ANALYSIS_WORKERS = 8;
  const WASM_WORKERS = 2;
  const PIPELINE_WORKERS = FRAME_WORKERS + ANALYSIS_WORKERS;
  const FINGERPRINT_BYTES = 65536;
  const MAX_ATTEMPTS = 4; // First attempt plus three automatic retries.
  const READ_TIMEOUT = 30000;
  const noop = () => {};
  const isAbort = error => error?.name === 'AbortError';
  const mediaError = message => Object.assign(new Error(message), { code: 'MEDIA_DECODE' });
  const readTimeout = () => Object.assign(new Error('读取视频超时，已排到队尾重试'), { code: 'MEDIA_TIMEOUT' });
  const stopped = () => Object.assign(new Error('操作已停止'), { name: 'AbortError' });
  const wasmModule = () => import('./wasm-media.js');
  const wasmMedia = {
    probe: async (...args) => (await wasmModule()).wasmMedia.probe(...args),
    sampleFrames: async (...args) => (await wasmModule()).wasmMedia.sampleFrames(...args),
    extractSegment: async (...args) => (await wasmModule()).wasmMedia.extractSegment(...args),
  };

  function readLocal(action, signal) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const finish = (settle, value) => { cleanup(); settle(value); };
      const cancel = () => finish(reject, stopped());
      const timer = setTimeout(() => finish(reject, readTimeout()), READ_TIMEOUT);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      Promise.resolve().then(() => { if (!signal?.aborted) return action(); })
        .then(value => finish(resolve, value), error => finish(reject, error));
    });
  }

  async function sha256(value) {
    if (!root.crypto?.subtle) throw new Error('请通过 HTTPS 或本机 localhost 打开网页后连接素材文件夹');
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const result = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function assetId(relativePath, size, lastModified) {
    return sha256(JSON.stringify([relativePath, size, lastModified]));
  }

  // Identifies the same video content across renames and reselected folders, so its paid
  // analysis can be reused. Reads the head, middle and tail instead of hashing gigabytes.
  async function fingerprintFile(file, guard = noop, signal) {
    const size = file.size;
    const parts = [String(size)];
    for (const start of [0, Math.max(0, Math.floor(size / 2) - FINGERPRINT_BYTES / 2), Math.max(0, size - FINGERPRINT_BYTES)]) {
      parts.push(await sha256(await readLocal(() => file.slice(start, Math.min(size, start + FINGERPRINT_BYTES)).arrayBuffer(), signal)));
      guard();
    }
    return sha256(parts.join(':'));
  }

  const contentKey = (fingerprint, start, end) => sha256(fingerprint + ':' + start + ':' + end);

  async function makeClips(id, name, duration, guard = noop, fingerprint = '') {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长，请检查文件或转换为 MP4（H.264）');
    const clips = [];
    for (let start = 0; start < duration; start += 8) {
      guard();
      const end = Math.min(start + 8, duration);
      const clip = { id: await sha256(id + ':' + start + ':' + end), asset_id: id, name, start, end, state: 'pending' };
      guard();
      if (fingerprint) { clip.content_key = await contentKey(fingerprint, start, end); guard(); }
      clips.push(clip);
    }
    return clips;
  }

  async function inspectFile(relativePath, file, previous, readDuration, guard = noop, signal) {
    guard();
    await readLocal(() => file.slice(0, 1).arrayBuffer(), signal);
    guard();
    if (previous && previous.size === file.size && previous.lastModified === file.lastModified) {
      // Earlier versions cached a transcoded copy; the original is now read in place.
      delete previous.repaired;
      if (!previous.fingerprint) {
        const fingerprint = await fingerprintFile(file, guard, signal);
        const keys = [];
        for (const clip of previous.clips || []) { keys.push(await contentKey(fingerprint, clip.start, clip.end)); guard(); }
        previous.fingerprint = fingerprint;
        (previous.clips || []).forEach((clip, index) => { clip.content_key = keys[index]; });
      }
      return previous;
    }
    const id = await assetId(relativePath, file.size, file.lastModified);
    guard();
    const duration = await readDuration(file);
    guard();
    const fingerprint = await fingerprintFile(file, guard, signal);
    const clips = await makeClips(id, relativePath, duration, guard, fingerprint);
    guard();
    return { relativePath, assetId: id, size: file.size, lastModified: file.lastModified, duration, fingerprint, clips };
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

  function validateRanges(ranges, size) {
    if (!Array.isArray(ranges) || ranges.some(range => !Array.isArray(range) || range.length !== 2 ||
      !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 0 || range[0] >= range[1] || range[1] > size)) {
      throw new Error('服务器返回的素材上传区间无效，请重试');
    }
    return ranges;
  }

  const rangeBytes = ranges => ranges.reduce((total, [start, end]) => total + end - start, 0);

  // Top-level MP4/MOV boxes: everything except media payloads, which the server requests
  // packet by packet once it has parsed the index. Returns null when the file is not a
  // plain (non-fragmented) MP4/MOV, so the caller falls back to a segment.
  async function mp4Index(file, guard = noop) {
    const ranges = [];
    let offset = 0, boxes = 0, moov = false, mdat = false;
    while (offset + 8 <= file.size) {
      if (++boxes > MAX_INDEX_BOXES) return null;
      const head = new DataView(await file.slice(offset, Math.min(file.size, offset + 16)).arrayBuffer());
      guard();
      let size = head.getUint32(0), header = 8;
      const kind = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
      if (size === 1) {
        if (head.byteLength < 16) return null;
        size = Number(head.getBigUint64(8));
        header = 16;
      } else if (size === 0) size = file.size - offset;
      if (!/^[\x20-\x7e]{4}$/.test(kind) || size < header || offset + size > file.size) return null;
      if (boxes === 1 && !['ftyp', 'wide', 'free', 'skip', 'mdat', 'moov', 'pnot'].includes(kind)) return null;
      if (kind === 'moof') return null;
      if (kind === 'moov') moov = true;
      if (kind === 'mdat') mdat = true;
      const end = offset + (kind === 'mdat' ? header : size);
      if (ranges.length && ranges.at(-1)[1] === offset) ranges.at(-1)[1] = end;
      else ranges.push([offset, end]);
      offset += size;
    }
    return moov && mdat ? ranges : null;
  }

  async function transferFile({ file, upload, create, head, patch, complete, onUpload = noop, guard = noop }) {
    if (file.size > MAX_SOURCE_SIZE) throw new Error('整文件上传的原视频必须在 512 MiB 以内');
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
        const request = root.indexedDB.open(namespace, 3);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('folder')) db.createObjectStore('folder');
          // Version 2 cached transcoded copies of whole videos; free that space.
          if (db.objectStoreNames.contains('repairs')) db.deleteObjectStore('repairs');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('无法保存素材目录，请检查浏览器的隐私或存储设置'));
        request.onblocked = () => reject(new Error('素材目录存储被其他页面占用，请关闭其他页面后重试'));
      });
      return database;
    }
    async function transaction(mode, action) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('folder', mode);
        const request = action(tx.objectStore('folder'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('素材目录保存失败，请重试'));
      });
    }
    return { get: () => transaction('readonly', store => store.get('current')),
      put: value => transaction('readwrite', store => store.put(value, 'current')),
      clear: () => transaction('readwrite', store => store.delete('current')) };
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
      const failed = () => { cleanup(); reject(mediaError('浏览器无法直接解码视频，已排到队尾用兼容模式读取')); };
      const aborted = () => { cleanup(); reject(stopped()); };
      const timer = setTimeout(() => { cleanup(); reject(readTimeout()); }, READ_TIMEOUT);
      video.addEventListener(event, ready, { once: true });
      video.addEventListener('error', failed, { once: true });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  // Loaded <video> elements are kept per file so the next clip of a long video does not
  // parse its index again.
  const videoPool = [];
  function releaseVideo(item) {
    item.video.pause();
    item.video.removeAttribute('src');
    item.video.load();
    root.URL.revokeObjectURL(item.url);
  }

  async function withVideo(file, signal, action, keep = false) {
    const index = keep ? videoPool.findIndex(item => item.file === file) : -1;
    let item = index >= 0 ? videoPool.splice(index, 1)[0] : null;
    let reusable = false;
    try {
      if (!item) {
        const video = root.document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = keep ? 'auto' : 'metadata';
        item = { file, video, url: root.URL.createObjectURL(file) };
        const metadata = mediaEvent(video, 'loadedmetadata', signal);
        video.src = item.url;
        video.load();
        await metadata;
      }
      if (!Number.isFinite(item.video.duration) || item.video.duration <= 0) throw mediaError('无法读取视频时长，已排到队尾用兼容模式读取');
      const result = await action(item.video);
      reusable = keep;
      return result;
    } finally {
      if (item && reusable) {
        item.video.pause();
        videoPool.push(item);
        while (videoPool.length > FRAME_WORKERS + 1) releaseVideo(videoPool.shift());
      } else if (item) releaseVideo(item);
    }
  }

  function readDuration(file, signal) {
    return withVideo(file, signal, video => video.duration);
  }

  function sampleFrames(file, start, end, signal) {
    return withVideo(file, signal, async video => {
      const canvas = root.document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context || !video.videoWidth || !video.videoHeight) throw mediaError('浏览器无法读取视频画面，已排到队尾用兼容模式读取');
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
      const frames = [];
      for (let i = 0; i < Math.ceil(end - start); i++) {
        if (signal?.aborted) throw stopped();
        const time = Math.min(start + i, Math.max(0, video.duration - 0.001));
        if (Math.abs(video.currentTime - time) > 0.0001) {
          const seeked = mediaEvent(video, 'seeked', signal);
          video.currentTime = time;
          await seeked;
        } else if (video.readyState < 2) await mediaEvent(video, 'loadeddata', signal);
        if (signal?.aborted) throw stopped();
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL('image/jpeg', 0.8));
      }
      return frames;
    }, true);
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
      sampleFrames: frameSampler, wasmMedia: wasmReader, locks, fetch: fetcher, trackProgress = false } = {}) {
      this.api = api;
      this.ownerKey = accountStorageKey('workbench-browser-materials');
      this.onStatus = onStatus;
      this.onConnected = onConnected;
      this.trackProgress = trackProgress;
      this.store = store || createFolderStore();
      this.readDuration = durationReader || readDuration;
      this.sampleFrames = frameSampler || sampleFrames;
      this.wasmMedia = wasmReader || wasmMedia;
      // Only one tab analyzes and serves uploads; other tabs of the same account follow.
      this.locks = locks !== undefined ? locks : root.document ? root.navigator?.locks || null : null;
      this.leading = !this.locks;
      this.lock = null;
      this.fetch = fetcher || root.fetch?.bind(root);
      this.record = null;
      this.files = new Map();
      this.originalFiles = new Map();
      this.selectedFiles = [];
      this.errors = new Map();
      this.retryAfter = new Map();
      this.unreadableFiles = new Set();
      // Files the browser cannot decode, waiting at the tail for ffmpeg.wasm.
      this.repairs = new Map();
      this.attempts = new Map();
      this.workers = new Map();
      this.requestWorker = null;
      this.registered = new Set();
      this.requests = [];
      this.generation = 0;
      this.active = false;
      this.connected = false;
      this.permissionDenied = false;
      this.status = { text: '选择素材文件夹', error: '', scanned: 0, indexed: 0, total: 0,
        needsPermission: false, connected: false };
    }

    get deviceId() { return this.active && this.connected ? this.record?.deviceId || '' : ''; }
    get folderName() { return this.record?.name || ''; }

    _guard(token) {
      if (this.ownerKey !== accountStorageKey('workbench-browser-materials')) this.stop();
      if (!this.active || token !== this.generation) throw stopped();
    }

    _activate() {
      this.active = true;
      this.abort = new AbortController();
      this.workers = new Map();
      this.requestWorker = null;
      this.stages = { frames: { active: 0, waiting: [], limit: FRAME_WORKERS },
        analysis: { active: 0, waiting: [], limit: ANALYSIS_WORKERS },
        transfer: { active: 0, waiting: [], limit: 1 },
        wasm: { active: 0, waiting: [], limit: WASM_WORKERS } };
      this.lastRequests = 0;
      this.lastHeartbeat = 0;
      this.requests = [];
      this.prepared = new Set();
      this.status = { ...this.status, cloud: null, progressError: '' };
      return this.generation;
    }

    _lead() {
      if (!this.locks || this.lock) return;
      const lock = { controller: new AbortController() };
      lock.held = new Promise(resolve => { lock.release = resolve; });
      this.lock = lock;
      Promise.resolve().then(() => this.locks.request(this.ownerKey + ':processing', { signal: lock.controller.signal }, () => {
        if (this.lock !== lock) return undefined;
        this.leading = true;
        if (this.active && this.connected) { this._ready(); this._schedule(0, this.generation); }
        return lock.held;
      })).catch(noop);
    }

    _unlead() {
      const lock = this.lock;
      if (!lock || this.active && this.connected) return;
      this.lock = null;
      this.leading = false;
      lock.controller.abort();
      lock.release();
    }

    _report(value = {}) {
      const entries = Object.values(this.record?.manifest || {});
      const clips = entries.flatMap(entry => entry.clips || []);
      const readable = entry => this.files.has(entry.relativePath) && !this.unreadableFiles.has(entry.assetId);
      const processing = !!this.scanning || !!this.workers.size || [...this.repairs.values()].some(item =>
        !item.attempted || item.failed && this.attempts.get('repair:' + item.relativePath) < MAX_ATTEMPTS) ||
        entries.some(entry => readable(entry) && entry.clips.some(clip => this.registered.has(clip.id) &&
          (clip.state === 'indexing' || ['pending', 'error'].includes(clip.state) &&
            (this.attempts.get(clip.id) || 0) < MAX_ATTEMPTS)));
      this.status = { ...this.status, ...value, connected: this.connected, folderName: this.folderName,
        indexed: clips.filter(clip => clip.state === 'indexed').length, total: clips.length, processing,
        scanning: !!this.scanning, prepared: clips.filter(clip => this.prepared?.has(clip.id) || clip.state === 'indexed').length,
        stages: Object.fromEntries(Object.entries(this.stages || {}).map(([name, pool]) =>
          [name, { active: pool.active, limit: pool.limit, waiting: pool.waiting.length }])),
        follower: !this.leading,
        totalFiles: value.scanned ?? (this.status.scanned || entries.length),
        readyFiles: entries.filter(entry => readable(entry) && entry.clips.length && entry.clips.every(clip => clip.state === 'indexed')).length };
      this.onStatus(this.status);
    }

    async _pollProgress(token) {
      if (!this.trackProgress || !this.record?.deviceId || !this.active || token !== this.generation) return;
      clearTimeout(this.progressTimer);
      try {
        const cloud = await this._api(this._devicePath('/progress'), {}, token);
        this._report({ cloud, progressError: '' });
      } catch (error) {
        if (!this.active || token !== this.generation || isAbort(error)) return;
        this._report({ progressError: '云端进度暂时无法更新，正在重连' });
      } finally {
        if (this.active && token === this.generation) this.progressTimer = setTimeout(() => this._pollProgress(token), 3000);
      }
    }

    _ready() {
      const clips = Object.values(this.record?.manifest || {}).flatMap(entry => entry.clips || []);
      const repairs = [...this.repairs.values()].filter(item => !item.attempted).length;
      this._report({ text: this.folderName + ' · 已扫描 ' + this.status.scanned + ' 个视频 · 已索引 ' +
        clips.filter(clip => clip.state === 'indexed').length + '/' + clips.length + ' 个片段' +
        (this.workers.size ? ' · ' + this.workers.size + ' 项处理中' : '') + (repairs ? ' · ' + repairs + ' 个视频待兼容解码' : '') +
        (this.leading ? '' : ' · 另一个标签页正在处理素材') });
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
      // Keeps the saved folder handle from being evicted with other site data.
      if (this.record.handle) {
        try { root.navigator?.storage?.persist?.()?.catch?.(noop); } catch { /* Optional browser feature. */ }
      }
      // Only a connected tab competes for processing, so a tab waiting for permission never blocks another.
      this._lead();
      this._report({ needsPermission: false, text: '已连接素材文件夹：' + this.folderName });
      void this._pollProgress(token);
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
          this.permissionDenied = false;
          this._report({ text: '重新连接素材文件夹', needsPermission: true, error: '' });
          void this._pollProgress(token);
          this.onConnected('');
          return;
        }
        await this._connect(token);
        this._guard(token);
        await this._scan(token);
      } catch (error) { if (this.active && token === this.generation && !isAbort(error)) this._error('素材文件夹', error); }
    }

    async choose({ reconnectOnly = false } = {}) {
      // A saved folder only needs its permission again: one click, no picker. Chrome then
      // offers "allow on every visit" so later visits reconnect without asking.
      const saved = this.record?.handle;
      if (this.status.needsPermission && !this.permissionDenied && saved?.requestPermission) return this._reconnect(saved);
      if (!root.showDirectoryPicker) return this._chooseFiles({ reconnectOnly });
      // Invoke the picker before any await so the original click activation remains valid.
      const generation = this.generation;
      const picking = root.showDirectoryPicker({ mode: 'read', id: 'mix-materials', ...(saved ? { startIn: saved } : {}) });
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

    async _reconnect(handle) {
      const generation = this.generation;
      let asking;
      try { asking = handle.requestPermission({ mode: 'read' }); } catch { asking = 'denied'; }
      let permission;
      try { permission = await asking; } catch { permission = 'denied'; }
      if (generation !== this.generation || this.record?.handle !== handle) return;
      if (permission !== 'granted') {
        this.permissionDenied = true;
        this._report({ needsPermission: true,
          error: '浏览器未允许读取素材文件夹，请再次点击并选择原素材文件夹' });
        return;
      }
      this.stop();
      const token = this._activate();
      try {
        this.connected = false;
        this._report({ error: '', needsPermission: false });
        await this._connect(token);
        this._guard(token);
        await this._scan(token);
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
      this.permissionDenied = false;
      this.record.handle = handle;
      this.record.name = name;
      this.record.uploads ||= {};
      this.record.manifest ||= {};
      this.record.deferredRevocations ||= [];
      this.files.clear();
      this.errors.clear();
      this.retryAfter.clear();
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
      this.retryAfter.clear();
      this.processingDeferred = false;
      this.errors.clear();
      this._report({ text: '正在扫描素材文件夹：' + this.folderName, error: '', scanned: 0, scanTotal: 0, needsPermission: false });
      const candidates = [];
      const observations = [];
      const files = new Map();
      const originals = new Map();
      const previousManifest = { ...this.record.manifest };
      this.record.manifest = { ...previousManifest };
      this.files = files;
      this.originalFiles = originals;
      let complete = true;
      const ready = [];
      let registering;
      const registerReady = () => {
        if (registering || !ready.length) return;
        const batch = ready.splice(0);
        registering = this._register(batch.flatMap(entry => entry.clips), token)
          .then(() => { this._guard(token); this._ready(); this._schedule(0, token); })
          .catch(error => {
            if (!this.active || token !== this.generation || isAbort(error)) return;
            complete = false;
            for (const entry of batch) {
              if (entry.clips.every(clip => this.registered.has(clip.id))) continue;
              this._queueRepair(entry.relativePath, originals.get(entry.relativePath), { reinspect: true });
              this._error(entry.relativePath, error);
            }
          }).finally(() => {
            registering = null;
            if (this.active && token === this.generation) registerReady();
          });
      };
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
        this._report({ scanTotal: candidates.length });
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(FRAME_WORKERS, candidates.length) }, async () => {
          while (cursor < candidates.length) {
            this._guard(token);
            const index = cursor++, item = candidates[index];
            let file;
            try {
              file = item.file || await readLocal(() => item.handle.getFile(), this.abort.signal);
              this._guard(token);
              originals.set(item.relativePath, file);
              const entry = await inspectFile(item.relativePath, file, previousManifest[item.relativePath],
                current => this.readDuration(current, this.abort.signal), () => this._guard(token), this.abort.signal);
              this._guard(token);
              observations[index] = { relativePath: item.relativePath, entry };
              files.set(item.relativePath, file);
              this.record.manifest[item.relativePath] = entry;
              ready.push(entry);
              registerReady();
            } catch (error) {
              this._guard(token);
              complete = false;
              observations[index] = { relativePath: item.relativePath, error: error.message };
              this._queueRepair(item.relativePath, file, { handle: item.handle, reinspect: !(file && error.code === 'MEDIA_DECODE') });
              this._error(item.relativePath, error);
            }
            this._report({ text: '并行扫描 ' + this.folderName + '：' + (this.status.scanned + 1) + '/' + candidates.length + ' 个视频',
              scanned: this.status.scanned + 1 });
          }
        }));
        while (registering) await registering;
        this._guard(token);
        const result = reconcileManifest(previousManifest, observations, complete, this.record.deferredRevocations || []);
        this.record.manifest = result.manifest;
        this.record.deferredRevocations = [...new Set([...result.deferredRevocations, ...result.revocations])];
        this.files = files;
        this.originalFiles = originals;
        await this._save(token);
        this._guard(token);
        this.lastStateCheck = Date.now();
        if (complete) {
          for (const id of result.revocations) {
            await this._api(this._devicePath('/assets/' + id), { method: 'DELETE' }, token);
            this._guard(token);
            this.record.deferredRevocations = this.record.deferredRevocations.filter(value => value !== id);
            await this._save(token);
          }
        }
        this._ready();
      } catch (error) { if (this.active && token === this.generation && !isAbort(error)) this._error('素材文件夹', error); }
      finally {
        if (this.active && token === this.generation) {
          this.scanning = false;
          this._report();
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
          const { id, asset_id, name, start, end, content_key } = clip;
          const item = content_key ? { id, asset_id, name, start, end, content_key } : { id, asset_id, name, start, end };
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
      clearTimeout(this.progressTimer);
      this.scanning = false;
      // restore/choose/scan restart synchronously; a stop that leaves this tab disconnected hands processing over.
      queueMicrotask(() => this._unlead());
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
      if (!this.active || !this.connected || token !== this.generation || this.cycleToken === token) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._cycle(token), delay);
    }

    _startRequests(token) {
      // Rendering must not hold the indexing scheduler while waiting for local materials.
      if (this.requestWorker || (this.retryAfter.get('connection') || 0) > Date.now() ||
        Date.now() - this.lastRequests < 3000 && Date.now() - this.lastHeartbeat < 15000 &&
        !this.requests.some(item => (this.retryAfter.get('request:' + item.id) || 0) <= Date.now())) return;
      let delay = 3000;
      const work = Promise.resolve().then(async () => {
        this._guard(token);
        if (Date.now() - this.lastRequests >= 3000) {
          const result = await this._api(this._devicePath('/requests'), {}, token);
          this._guard(token);
          this.requests = (result.requests || []).filter(request => request.kind !== 'analysis');
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
        }
      }).catch(error => {
        if (this.active && token === this.generation && !isAbort(error)) {
          this.retryAfter.set('connection', Date.now() + 3000);
          this._error('素材连接', error);
        }
      })
        .finally(() => {
          if (this.active && token === this.generation && this.requestWorker === work) {
            this.requestWorker = null;
            this._schedule(delay, token);
          }
        });
      this.requestWorker = work;
    }

    async _cycle(token) {
      if (!this.active || token !== this.generation || this.cycleToken === token) return;
      this.cycleToken = token;
      try {
        this._guard(token);
        if (this.leading) this._startRequests(token);
        if (Date.now() - this.lastStateCheck >= 30000) {
          // A following tab only mirrors the server state that the processing tab produces.
          const busy = Object.values(this.record.manifest).filter(entry => this.files.has(entry.relativePath))
            .flatMap(entry => entry.clips.filter(clip => this.registered.has(clip.id) && !this.workers.has(clip.id) &&
              (this.leading ? clip.state === 'indexing' || clip.state === 'indexed' && this.status.cloud?.ready < this.status.cloud?.total : clip.state !== 'indexed')));
          await this._register(busy, token);
          this._guard(token);
          this.lastStateCheck = Date.now();
          this._ready();
        }
        if (!this.leading) return;
        const candidates = Object.values(this.record.manifest)
          .filter(item => this.files.has(item.relativePath) && !this.unreadableFiles.has(item.assetId))
          .flatMap(item => item.clips.filter(clip => this.registered.has(clip.id) && !this.workers.has(clip.id) &&
            ['pending', 'error'].includes(clip.state)).map(clip => ({ item, clip })));
        const fresh = candidates.filter(({ clip }) => !this.attempts.has(clip.id));
        if (!this.scanning && !fresh.length && !this.workers.size) this.processingDeferred = true;
        let queued = fresh;
        if (!this.scanning && !fresh.length && this.processingDeferred) {
          const repairs = [...this.repairs.values()];
          const repairing = [...this.workers.keys()].some(key => key.startsWith('repair:'));
          const firstPassBusy = [...this.workers.keys()].some(key => !key.startsWith('repair:') && this.attempts.get(key) === 1) ||
            Object.values(this.record.manifest).some(item => this.files.has(item.relativePath) && !this.unreadableFiles.has(item.assetId) &&
              item.clips.some(clip => this.registered.has(clip.id) && clip.state === 'indexing'));
          const failedRepairs = repairs.filter(item => item.failed && this.attempts.get('repair:' + item.relativePath) < MAX_ATTEMPTS);
          const repair = repairs.find(item => !item.attempted) || (!firstPassBusy && failedRepairs
            .filter(item => (this.retryAfter.get('repair:' + item.relativePath) || 0) <= Date.now())
            .sort((a, b) => this.attempts.get('repair:' + a.relativePath) - this.attempts.get('repair:' + b.relativePath))[0]);
          if (repair && !repairing && this.workers.size < PIPELINE_WORKERS) {
            const key = 'repair:' + repair.relativePath;
            repair.attempted = true;
            this.attempts.set(key, (this.attempts.get(key) || 0) + 1);
            this._startWork(key, () => this._repairFile(repair, token), token);
          }
          queued = !repair && !repairing && !firstPassBusy && !failedRepairs.length ? candidates
            .filter(({ clip }) => this.attempts.get(clip.id) < MAX_ATTEMPTS &&
              (this.retryAfter.get('clip:' + clip.id) || 0) <= Date.now())
            .sort((a, b) => this.attempts.get(a.clip.id) - this.attempts.get(b.clip.id)) : [];
        }
        for (const { item, clip } of queued.slice(0, PIPELINE_WORKERS - this.workers.size)) {
          this.attempts.set(clip.id, (this.attempts.get(clip.id) || 0) + 1);
          this._startWork(clip.id, () => this._analyzeClip(item, clip, token), token);
        }
      } catch (error) { if (this.active && token === this.generation && !isAbort(error)) this._error('素材连接', error); }
      finally {
        if (this.cycleToken === token) this.cycleToken = null;
        this._schedule(3000, token);
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

    _queueRepair(relativePath, file, { handle, reinspect = false } = {}) {
      const repair = this.repairs.get(relativePath);
      if (!repair) {
        this.repairs.set(relativePath, { relativePath, file, handle, reinspect, attempted: reinspect, failed: reinspect });
        if (reinspect) {
          // The failed scan is the initial attempt; only three tail retries remain.
          const key = 'repair:' + relativePath;
          this.attempts.set(key, 1);
          this.retryAfter.set(key, Date.now() + 15000);
        }
      }
      else if (repair.attempted) {
        repair.failed = true;
        if (!reinspect) repair.reinspect = false;
        const key = 'repair:' + relativePath, attempt = this.attempts.get(key);
        if (attempt < MAX_ATTEMPTS) this.retryAfter.set(key, Date.now() + 15000 * 2 ** (attempt - 1));
        else this.retryAfter.delete(key);
      }
    }

    async _runStage(stage, action, token) {
      this._guard(token);
      const pool = this.stages[stage], signal = this.abort.signal;
      if (pool.active >= pool.limit) {
        await new Promise((resolve, reject) => {
          const begin = () => { signal.removeEventListener('abort', cancel); resolve(); };
          const cancel = () => {
            pool.waiting.splice(pool.waiting.indexOf(begin), 1);
            reject(stopped());
          };
          pool.waiting.push(begin);
          signal.addEventListener('abort', cancel, { once: true });
        });
      } else pool.active++;
      try { this._guard(token); this._report(); return await action(); }
      finally {
        const next = pool.waiting.shift();
        if (next) next();
        else pool.active--;
        if (this.active && token === this.generation) this._report();
      }
    }

    _serverDecoder(entry) {
      return entry.decoder === 'server';
    }

    // Original Files and their timelines stay unchanged; only the analysis source changes.
    _sample(entry, start, end, token) {
      const file = this.files.get(entry.relativePath), signal = this.abort.signal;
      if (entry.decoder === 'wasm') return this._runStage('wasm', () => this.wasmMedia.sampleFrames(file, start, end, signal), token);
      return this._runStage('frames', () => this.sampleFrames(file, start, end, signal), token);
    }

    async _analyzeClip(item, clip, token) {
      this._report({ text: '并行读取素材画面：' + item.relativePath });
      try {
        let payload, prepared;
        if (!this._serverDecoder(item)) {
          try { payload = { clip_id: clip.id, frames: await this._sample(item, clip.start, clip.end, token) }; }
          catch (error) {
            this._guard(token);
            if (error.code === 'MEDIA_TIMEOUT') throw error;
            if (item.decoder !== 'wasm') {
              item.decoder = 'wasm';
              try { payload = { clip_id: clip.id, frames: await this._sample(item, clip.start, clip.end, token) }; }
              catch (fallback) { this._guard(token); item.decoder = 'server'; }
            } else item.decoder = 'server';
            await this._save(token);
          }
        }
        if (!payload) {
          prepared = await this._runStage('transfer', async () => {
            const result = await this._post(this._devicePath('/analysis-source'), { clip_id: clip.id }, token);
            if (!result.complete && !result.source_ready) await this._transferSource(result.request, item, token);
            return result;
          }, token);
          if (!prepared.complete) payload = { clip_id: clip.id, source_request_id: prepared.request.id };
        }
        this._guard(token);
        this.prepared.add(clip.id);
        this._report({ text: '并行 AI 分析素材：' + item.relativePath });
        const result = prepared?.complete ? prepared : await this._runStage('analysis',
          () => this._post(this._devicePath('/analyze'), payload, token), token);
        this._guard(token);
        if (!result.complete) throw new Error('素材分析仍在处理中，将在队尾重试');
        clip.state = 'indexed';
        this.retryAfter.delete('clip:' + clip.id);
        if (item.clips.every(value => value.state !== 'error')) this.errors.delete(item.relativePath);
        this._report({ error: [...this.errors].map(([name, message]) => name + '：' + message).join('\n') });
      } catch (error) {
        this._guard(token);
        clip.state = error.status === 409 ? 'indexing' : 'error';
        if (error.status !== 409 && this.attempts.get(clip.id) < MAX_ATTEMPTS) {
          const delay = Math.min(60000, 15000 * 2 ** Math.min(2, (this.attempts.get(clip.id) || 1) - 1));
          this.retryAfter.set('clip:' + clip.id, Date.now() + delay);
        } else this.retryAfter.delete('clip:' + clip.id);
        this._error(item.relativePath, error);
      }
      await this._save(token);
    }

    // Tail recovery: re-read files whose read failed, or probe undecodable files' metadata in
    // compatibility mode before local frame extraction.
    async _repairFile(repair, token) {
      const { relativePath } = repair;
      try {
        const file = repair.reinspect && repair.handle ? await readLocal(() => repair.handle.getFile(), this.abort.signal) : repair.file;
        this._guard(token);
        if (repair.reinspect) {
          await readLocal(() => file.slice(0, 1).arrayBuffer(), this.abort.signal);
          this._guard(token);
          repair.file = file;
          this.originalFiles.set(relativePath, file);
        }
        const previous = this.record.manifest[relativePath];
        const id = await assetId(relativePath, file.size, file.lastModified);
        this._guard(token);
        const unchanged = previous?.assetId === id;
        let duration = unchanged ? previous.duration : 0, decoder = unchanged ? previous.decoder : undefined;
        if (!repair.reinspect) {
          this._report({ text: '正在用兼容模式读取视频：' + relativePath });
          const info = await this._runStage('wasm', () => this.wasmMedia.probe(file, this.abort.signal), token);
          this._guard(token);
          if (!(info?.duration > 0)) throw new Error('兼容模式也无法读取视频时长，请检查文件');
          duration = unchanged ? previous.duration : info.duration;
          decoder = 'wasm';
        } else if (!unchanged) duration = await this.readDuration(file, this.abort.signal);
        this._guard(token);
        const fingerprint = unchanged && previous.fingerprint || await fingerprintFile(file, () => this._guard(token), this.abort.signal);
        const clips = unchanged ? previous.clips : await makeClips(id, relativePath, duration, () => this._guard(token), fingerprint);
        this._guard(token);
        this.record.manifest[relativePath] = { relativePath, assetId: id, size: file.size, lastModified: file.lastModified,
          duration, fingerprint, clips, ...decoder ? { decoder } : {} };
        this.files.set(relativePath, file);
        this.unreadableFiles.delete(id);
        if (previous && !unchanged) this.record.deferredRevocations.push(previous.assetId);
        await this._register(clips, token);
        for (const clip of clips) { this.attempts.delete(clip.id); this.retryAfter.delete('clip:' + clip.id); }
        repair.failed = false;
        this.retryAfter.delete('repair:' + relativePath);
        this.errors.delete(relativePath);
        this._report({ error: [...this.errors].map(([name, message]) => name + '：' + message).join('\n') });
      } catch (error) {
        this._guard(token);
        if (repair.reinspect && error.code === 'MEDIA_DECODE') repair.reinspect = false;
        repair.failed = true;
        const key = 'repair:' + relativePath, attempt = this.attempts.get(key);
        if (attempt < MAX_ATTEMPTS) this.retryAfter.set(key, Date.now() + 15000 * 2 ** (attempt - 1));
        else this.retryAfter.delete(key);
        this._error(relativePath, error);
      }
    }

    async _serve(request, token) {
      const entry = Object.values(this.record.manifest).find(value => value.assetId === request.asset_id);
      const file = entry && this.files.get(entry.relativePath);
      if (!file) throw new Error('请求的原视频不可读取或版本已改变，请重新扫描素材文件夹');
      const path = this._devicePath('/requests/' + request.id);
      this._report({ text: '正在传输素材：' + entry.relativePath });
      if (request.kind === 'proxy' && !this._serverDecoder(entry)) {
        let frames;
        try { frames = await this._sample(entry, request.start, request.end, token); }
        catch (error) {
          this._guard(token);
          // An indexed clip can still fail to seek in <video>; prepare its preview on the server.
          if (error.code !== 'MEDIA_DECODE') throw error;
          entry.decoder = 'server';
          await this._save(token);
        }
        this._guard(token);
        if (frames) {
          const result = await this._post(path + '/frames', { frames }, token);
          if (!result.complete) throw new Error('素材预览传输未完成，请重试');
        } else await this._runStage('transfer', () => this._transferSource(request, entry, token), token);
      } else if (request.kind === 'source' || request.kind === 'proxy') {
        await this._runStage('transfer', () => this._transferSource(request, entry, token), token);
        this._guard(token);
      } else throw new Error('未知的素材请求，请重新连接素材文件夹');
      this._guard(token);
      this.errors.delete('素材传输');
      this._report({ error: [...this.errors].map(([name, message]) => name + '：' + message).join('\n'), uploadBytes: 0, uploadTotal: 0 });
      this._ready();
    }

    async _transferSource(request, entry, token) {
      const file = this.files.get(entry.relativePath);
      if (!file) throw new Error('请求的原视频不可读取，请重新扫描素材文件夹');
      const path = this._devicePath('/requests/' + request.id);
      try { await this._sendLarge(request, entry, file, path, token); }
      finally { if (this.active && token === this.generation) this._report({ uploadBytes: 0, uploadTotal: 0 }); }
    }

    async _patch(id, offset, bytes, checksum, token) {
      await this._heartbeat(token);
      this._guard(token);
      const result = await this._api(this._devicePath('/files/' + id), { method: 'PATCH', body: bytes,
        headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset), 'Upload-Checksum': checksum } }, token);
      return result.offset;
    }

    async _complete(id, token) {
      const result = await this._post(this._devicePath('/files/' + id + '/complete'), {}, token);
      if (!result.complete) throw new Error('原视频传输未完成，请重试');
    }

    async _sendLarge(request, entry, file, path, token) {
      const index = await mp4Index(file, () => this._guard(token));
      this._guard(token);
      if (index) {
        try { return await this._sendSparse(index, entry, file, path, token); }
        catch (error) {
          this._guard(token);
          // 413: the index is too large; 422: the server could not parse or cut it.
          if (error.status !== 413 && error.status !== 422) throw error;
        }
      }
      await this._sendSegment(request, entry, file, path, token);
    }

    // Uploads only the MP4/MOV index and then the packets the server plans for pending requests.
    async _sendSparse(index, entry, file, path, token) {
      const progress = { sent: 0, total: 0 };
      const begin = await this._post(path + '/sparse', { size: file.size, ranges: index }, token);
      if (!/^[a-f0-9]{32}$/.test(begin.id || '')) throw new Error('服务器未返回有效的上传编号，请重试');
      if (begin.cached) return this._complete(begin.id, token);
      progress.total = rangeBytes(validateRanges(begin.ranges, file.size));
      await this._sendRanges(begin.id, file, begin.ranges, entry, progress, token);
      const plan = await this._post(this._devicePath('/files/' + begin.id + '/plan'), {}, token);
      progress.total += rangeBytes(validateRanges(plan.ranges, file.size));
      await this._sendRanges(begin.id, file, plan.ranges, entry, progress, token);
      await this._complete(begin.id, token);
    }

    async _sendRanges(id, file, ranges, entry, progress, token) {
      for (const [start, end] of ranges) {
        for (let offset = start; offset < end;) {
          this._guard(token);
          const bytes = await file.slice(offset, Math.min(end, offset + CHUNK_SIZE)).arrayBuffer();
          this._guard(token);
          const checksum = await sha256(bytes);
          await this._patch(id, offset, bytes, checksum, token);
          offset += bytes.byteLength;
          progress.sent += bytes.byteLength;
          this._report({ text: '正在按需传输原片：' + entry.relativePath + '（' + Math.round(progress.sent / Math.max(1, progress.total) * 100) + '%）',
            uploadBytes: progress.sent, uploadTotal: progress.total });
        }
      }
    }

    // Other containers: ffmpeg.wasm stream-copies the requested range with its original timestamps.
    async _sendSegment(request, entry, file, path, token) {
      this._report({ text: '正在截取原片片段：' + entry.relativePath });
      const segment = await this._runStage('wasm',
        () => this.wasmMedia.extractSegment(file, request.start, request.end, this.abort.signal), token);
      this._guard(token);
      if (!(segment?.file?.size > 0) || !Number.isFinite(segment.origin)) throw new Error('无法截取原片片段，请检查视频文件');
      if (segment.file.size > MAX_SOURCE_SIZE) throw new Error('原片片段超过 512 MiB，请降低视频码率后重试');
      const size = segment.file.size;
      this._report({ uploadBytes: 0, uploadTotal: size });
      await transferFile({ file: segment.file, guard: () => this._guard(token),
        create: value => this._post(path + '/segment', { size: value, origin: segment.origin }, token),
        head: id => this._uploadOffset(id, token),
        patch: async (id, offset, bytes, checksum) => {
          const next = await this._patch(id, offset, bytes, checksum, token);
          this._report({ text: '正在传输原片片段：' + entry.relativePath + '（' + Math.round(next / size * 100) + '%）',
            uploadBytes: next, uploadTotal: size });
          return next;
        }, complete: id => this._complete(id, token) });
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
  BrowserMaterials.helpers = { sha256, assetId, fingerprintFile, makeClips, inspectFile, reconcileManifest, transferFile,
    mp4Index, createFolderStore, readDuration, sampleFrames, CHUNK_SIZE, MAX_SOURCE_SIZE, FRAME_WORKERS, ANALYSIS_WORKERS };
