const MiB = 1024 * 1024;
const INPUT = '/input/source';
const OUTPUT = '/repaired.mp4';
const abortError = () => new DOMException('本地修复已取消', 'AbortError');

async function loadFFmpeg() {
  const { FFmpeg } = await import('/vendor/ffmpeg/index.js');
  return new FFmpeg();
}

function mediaInfo(data) {
  const video = data.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = data.streams?.filter(stream => stream.codec_type === 'audio') || [];
  const duration = Math.max(Number(data.format?.duration) || 0, ...[video, ...audio].map(stream => Number(stream?.duration) || 0));
  if (!video || !(video.width > 0 && video.height > 0) || !(duration > 0) || !Number.isFinite(duration)) {
    throw new Error('无法读取完整的视频时长和画面信息');
  }
  return { video, audio, duration, size: Number(data.format?.size) || 0 };
}

function outputDimensions(video) {
  const [numerator, denominator] = String(video.sample_aspect_ratio || '1:1').split(':').map(Number);
  const aspect = numerator > 0 && denominator > 0 ? numerator / denominator : 1;
  let width = video.width * aspect;
  let height = video.height;
  const rotation = Number(video.side_data_list?.find(data => data.rotation != null)?.rotation ?? video.tags?.rotate ?? 0);
  if (Math.abs(rotation % 180) === 90) [width, height] = [height, width];
  const landscape = width >= height;
  const scale = Math.min(1, (landscape ? 1920 : 1080) / width, (landscape ? 1080 : 1920) / height);
  return [Math.max(2, Math.floor(width * scale / 2) * 2), Math.max(2, Math.floor(height * scale / 2) * 2)];
}

function verifyMedia(source, output) {
  if (Math.abs(source.duration - output.duration) > 0.25 ||
      (Number(source.video.duration) > 0 && !(Math.abs(Number(source.video.duration) - Number(output.video.duration)) <= 0.25))) {
    throw new Error('修复后视频时长不完整，已保留原素材');
  }
  if (output.video.codec_name !== 'h264' || output.video.pix_fmt !== 'yuv420p') {
    throw new Error('修复后的视频编码不兼容');
  }
  if (source.audio.length !== output.audio.length || output.audio.some((stream, index) =>
    stream.codec_name !== 'aac' || (Number(source.audio[index].duration) > 0 &&
      !(Math.abs(Number(source.audio[index].duration) - Number(stream.duration)) <= 0.25)))) {
    throw new Error('修复后的音频不完整，已保留原素材');
  }
}

// The factory also lets tests exercise the complete workflow without browser workers.
export function createVideoRepair(createFFmpeg = loadFFmpeg) {
  return async function repairVideo(file, { signal, onProgress = () => {}, maxSize = 512 * MiB } = {}) {
    if (signal?.aborted) throw abortError();
    if (file.size >= 2 * 1024 * MiB) throw new Error('浏览器本地修复暂不支持 2 GiB 及以上的素材');
    if (!(file.size > 0) || !(maxSize > 0)) throw new Error('素材大小或输出大小限制无效');
    let ffmpeg;
    let mounted = false;
    let terminated = false;
    let stage = 'loading';
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const stop = () => {
      terminated = true;
      ffmpeg?.terminate();
      rejectAbort(abortError());
    };
    const wait = promise => Promise.race([promise, aborted]);
    const report = (nextStage, progress = 0) => { stage = nextStage; onProgress({ stage, progress }); };
    const progress = ({ progress: value }) => onProgress({ stage, progress: Math.max(0, Math.min(0.99, Number(value) || 0)) });
    signal?.addEventListener('abort', stop, { once: true });
    try {
      report('loading');
      ffmpeg = await wait(createFFmpeg());
      ffmpeg.on('progress', progress);
      const base = globalThis.location.href;
      await wait(ffmpeg.load({
        coreURL: new URL('/vendor/ffmpeg/ffmpeg-core.js', base).href,
        wasmURL: new URL('/vendor/ffmpeg/ffmpeg-core.wasm', base).href,
      }));
      await wait(ffmpeg.createDir('/input'));
      mounted = await wait(ffmpeg.mount('WORKERFS', { blobs: [{ name: 'source', data: file }] }, '/input'));
      if (!mounted) throw new Error('无法只读挂载素材，请重新打开浏览器后重试');
      let probeIndex = 0;
      const probe = async path => {
        const destination = `/probe-${probeIndex++}.json`;
        const code = await wait(ffmpeg.ffprobe(['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path, '-o', destination]));
        // Core 0.12.10 can leave ret=-1 after a successful probe; require fresh, valid JSON.
        if (code !== 0 && code !== -1) throw new Error('无法读取素材信息，文件可能已损坏');
        return mediaInfo(JSON.parse(await wait(ffmpeg.readFile(destination, 'utf8'))));
      };
      const inspectOutput = async () => {
        report('verifying');
        const output = await probe(OUTPUT);
        verifyMedia(input, output);
        if (!(output.size > 0)) throw new Error('修复后的素材大小无效');
        return output;
      };
      const readOutput = async () => {
        const data = await wait(ffmpeg.readFile(OUTPUT));
        if (!(data.byteLength > 0) || data.byteLength > maxSize) throw new Error('修复后的素材体积仍超出大小限制');
        const result = new File([data], `${file.name.replace(/\.[^.]+$/, '') || '素材'}.mp4`, { type: 'video/mp4', lastModified: file.lastModified });
        report('done', 1);
        return result;
      };
      report('probing');
      const input = await probe(INPUT);
      const common = ['-i', INPUT, '-map', `0:${input.video.index}`, '-map', '0:a?', '-map_metadata', '0'];
      const finish = ['-movflags', '+faststart', OUTPUT];
      if (file.size <= maxSize && input.video.codec_name === 'h264' && input.video.pix_fmt === 'yuv420p' && input.audio.every(stream => stream.codec_name === 'aac')) {
        report('remuxing');
        let remuxed;
        try {
          if (await wait(ffmpeg.exec([...common, '-c:v', 'copy', '-c:a', 'copy', ...finish])) === 0) remuxed = await inspectOutput();
        } catch (error) {
          if (signal?.aborted) throw abortError();
          // Some MOV timestamp/codec combinations need decoding even with H264.
        }
        if (remuxed?.size <= maxSize) return await readOutput();
        await wait(ffmpeg.deleteFile(OUTPUT).catch(() => {}));
      }
      const targetBytes = Math.min(480 * MiB, maxSize * 0.9375);
      let bitrate = Math.floor(Math.min(8_000_000, targetBytes * 8 * 0.97 / input.duration - input.audio.length * 128_000));
      if (bitrate < 1000) throw new Error('素材时长过长，无法在大小限制内保留完整视频');
      const [width, height] = outputDimensions(input.video);
      for (let attempt = 0; attempt < 2; attempt++) {
        report('transcoding');
        const args = [...common, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
          '-vf', `scale=${width}:${height},setsar=1`, '-metadata:s:v:0', 'rotate=0',
          '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2),
          '-c:a', 'aac', '-b:a', '128k', ...finish];
        if (await wait(ffmpeg.exec(args)) !== 0) throw new Error('浏览器无法修复此视频编码，原素材已保留');
        const output = await inspectOutput();
        if (output.video.width !== width || output.video.height !== height) throw new Error('修复后的视频尺寸不正确');
        if (output.size <= maxSize) return await readOutput();
        await wait(ffmpeg.deleteFile(OUTPUT));
        bitrate = Math.max(1, Math.floor(bitrate * Math.min(0.8, targetBytes / output.size * 0.9)));
      }
      throw new Error('修复后的素材体积仍超出大小限制，原素材已保留');
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error instanceof Error) throw error;
      throw new Error(`浏览器本地修复失败：${String(error).slice(0, 200)}`);
    } finally {
      signal?.removeEventListener('abort', stop);
      if (ffmpeg) {
        if (mounted && !terminated) await ffmpeg.unmount('/input').catch(() => {});
        ffmpeg.off('progress', progress);
        if (!terminated) ffmpeg.terminate();
      }
    }
  };
}

export const repairVideo = createVideoRepair();
