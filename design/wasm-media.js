// Read-only ffmpeg.wasm helpers for videos the browser's <video> element cannot decode, and for
// stream-copying the requested range of a large non-MP4 source. The original file is mounted with
// WORKERFS, so nothing is copied into memory except the small outputs.
const CORE_URL = '/vendor/ffmpeg/ffmpeg-core.js';
const WASM_URL = '/vendor/ffmpeg/ffmpeg-core.wasm';
const PROBE_TIMEOUT = 60000;
const FRAME_TIMEOUT = 180000;
const SEGMENT_TIMEOUT = 300000;
const FRAME_SCALE = "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease";
const noop = () => {};
const abortError = () => Object.assign(new Error('操作已停止'), { name: 'AbortError' });
const failure = message => Object.assign(new Error(message), { code: 'WASM_MEDIA' });

async function loadFFmpeg() {
  const { FFmpeg } = await import('/vendor/ffmpeg/index.js');
  return new FFmpeg();
}

export function mediaInfo(data) {
  const video = data?.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = data?.streams?.filter(stream => stream.codec_type === 'audio') || [];
  const duration = Math.max(Number(data?.format?.duration) || 0, ...[video, ...audio].map(stream => Number(stream?.duration) || 0));
  if (!video || !(video.width > 0 && video.height > 0) || !(duration > 0) || !Number.isFinite(duration)) {
    throw failure('无法读取完整的视频时长和画面信息');
  }
  const start = Number(data.format?.start_time);
  return { duration, start: Number.isFinite(start) ? start : 0, width: video.width, height: video.height,
    codec: video.codec_name || '', audio: audio.length };
}

const extension = name => /\.[a-z0-9]{1,5}$/i.exec(name || '')?.[0].toLowerCase() || '';

function jpegUrl(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return 'data:image/jpeg;base64,' + btoa(binary);
}

// A small pool of loaded ffmpeg instances; each runs one job at a time on its own worker.
export function createWasmMedia({ createFFmpeg = loadFFmpeg, instances = 2, idleTime = 30000 } = {}) {
  const idle = [], waiting = [];
  let created = 0, sequence = 0;
  const wake = () => waiting.shift()?.();

  function retire(slot) {
    created--;
    clearTimeout(slot.timer);
    try { slot.ffmpeg?.terminate(); } catch { /* The worker is already gone. */ }
    wake();
  }

  function release(slot, broken) {
    if (broken) return retire(slot);
    idle.push(slot);
    // Loaded cores hold a lot of memory; free them once the queue has been quiet for a while.
    slot.timer = setTimeout(() => {
      const index = idle.indexOf(slot);
      if (index >= 0) { idle.splice(index, 1); retire(slot); }
    }, idleTime);
    slot.timer.unref?.();
    wake();
  }

  async function acquire(signal) {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const ready = idle.pop();
      if (ready) { clearTimeout(ready.timer); return ready; }
      if (created < instances) {
        created++;
        const slot = {};
        let stop;
        try {
          const aborted = new Promise((_, reject) => {
            stop = () => { try { slot.ffmpeg?.terminate(); } catch { /* not started */ } reject(abortError()); };
          });
          aborted.catch(noop);
          signal?.addEventListener('abort', stop, { once: true });
          slot.ffmpeg = await Promise.race([createFFmpeg(), aborted]);
          const base = globalThis.location.href;
          await Promise.race([slot.ffmpeg.load({ coreURL: new URL(CORE_URL, base).href,
            wasmURL: new URL(WASM_URL, base).href }), aborted]);
          return slot;
        } catch (error) {
          retire(slot);
          if (signal?.aborted) throw abortError();
          throw error instanceof Error ? error : failure('无法加载浏览器兼容解码组件，请刷新页面后重试');
        } finally { signal?.removeEventListener('abort', stop); }
      }
      await new Promise((resolve, reject) => {
        const ready = () => { signal?.removeEventListener('abort', cancel); resolve(); };
        const cancel = () => {
          const index = waiting.indexOf(ready);
          if (index >= 0) waiting.splice(index, 1);
          reject(abortError());
        };
        waiting.push(ready);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    }
  }

  async function run(file, signal, task) {
    if (!file) throw failure('素材文件不可读取');
    const slot = await acquire(signal);
    const id = ++sequence, dir = `/m${id}`, name = 'source' + extension(file.name), outputs = [];
    let broken = false, mounted = false, rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    aborted.catch(noop);
    const stop = () => { broken = true; try { slot.ffmpeg.terminate(); } catch { /* gone */ } rejectAbort(abortError()); };
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    const wait = promise => Promise.race([promise, aborted]);
    const scratch = suffix => { const path = `/o${id}-${suffix}`; outputs.push(path); return path; };
    try {
      await wait(slot.ffmpeg.createDir(dir));
      mounted = await wait(slot.ffmpeg.mount('WORKERFS', { blobs: [{ name, data: file }] }, dir));
      if (!mounted) throw failure('无法只读挂载素材，请重新打开浏览器后重试');
      return await task({ ffmpeg: slot.ffmpeg, input: `${dir}/${name}`, wait, scratch });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error instanceof Error) throw error;
      broken = true;
      throw failure('浏览器兼容解码失败：' + String(error).slice(0, 200));
    } finally {
      signal?.removeEventListener('abort', stop);
      if (!broken) {
        try {
          for (const path of outputs) await slot.ffmpeg.deleteFile(path).catch(noop);
          if (mounted) await slot.ffmpeg.unmount(dir);
          await slot.ffmpeg.deleteDir(dir);
        } catch { broken = true; }
      }
      release(slot, broken);
    }
  }

  async function probeInput({ ffmpeg, input, wait, scratch }) {
    const path = scratch('probe.json');
    const code = await wait(ffmpeg.ffprobe(['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input, '-o', path], PROBE_TIMEOUT));
    // Core 0.12.10 can leave ret=-1 after a successful probe; require fresh, valid JSON.
    if (code !== 0 && code !== -1) throw failure('无法读取素材信息，文件可能已损坏');
    let data;
    try { data = JSON.parse(await wait(ffmpeg.readFile(path, 'utf8'))); }
    catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw failure('无法读取素材信息，文件可能已损坏');
    }
    return mediaInfo(data);
  }

  return {
    probe: (file, signal) => run(file, signal, probeInput),

    // One JPEG per second, at most 640 pixels, matching the <video> sampler's contract.
    sampleFrames: (file, start, end, signal) => run(file, signal, async ({ ffmpeg, input, wait, scratch }) => {
      const count = Math.ceil(end - start);
      if (!(count > 0) || !(start >= 0)) throw failure('素材片段时间无效');
      const pattern = scratch('frame-%02d.jpg');
      const code = await wait(ffmpeg.exec(['-v', 'error', '-ss', String(start), '-i', input, '-t', String(end - start),
        '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', 'fps=1,' + FRAME_SCALE, '-frames:v', String(count),
        '-q:v', '4', '-f', 'image2', pattern], FRAME_TIMEOUT));
      if (code !== 0) throw failure('浏览器兼容解码失败，无法读取视频画面');
      const frames = [];
      for (let index = 1; index <= count; index++) {
        let bytes;
        try { bytes = await wait(ffmpeg.readFile(scratch(`frame-${String(index).padStart(2, '0')}.jpg`))); }
        catch (error) { if (error?.name === 'AbortError') throw error; break; }
        frames.push(jpegUrl(bytes));
      }
      if (!frames.length) throw failure('浏览器兼容解码未读到视频画面');
      // The last second of a file can end before its final frame; repeat the closest one.
      while (frames.length < count) frames.push(frames.at(-1));
      return frames;
    }),

    // Stream copy with the original timestamps; the server finds the request inside it.
    extractSegment: (file, start, end, signal) => run(file, signal, async context => {
      const { ffmpeg, input, wait, scratch } = context;
      const info = await probeInput(context);
      const from = Math.max(0, start - 1), length = end - from + 1;
      const path = scratch('segment.mkv');
      const code = await wait(ffmpeg.exec(['-v', 'error', '-ss', from.toFixed(3), '-t', length.toFixed(3), '-i', input,
        '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-copyts', '-f', 'matroska', path], SEGMENT_TIMEOUT));
      if (code !== 0) throw failure('浏览器无法截取原片片段');
      const data = await wait(ffmpeg.readFile(path));
      if (!(data?.byteLength > 0)) throw failure('浏览器截取的原片片段为空');
      return { file: new Blob([data], { type: 'video/x-matroska' }), origin: info.start };
    }),
  };
}

let shared;
// Loaded on first use so pages that never need ffmpeg.wasm never download it.
export const wasmMedia = {
  probe: (...args) => (shared ||= createWasmMedia()).probe(...args),
  sampleFrames: (...args) => (shared ||= createWasmMedia()).sampleFrames(...args),
  extractSegment: (...args) => (shared ||= createWasmMedia()).extractSegment(...args),
};
