import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, rm, rename } from 'node:fs/promises';
import { probeVideo } from './media.mjs';
import { VideoError } from './provider.mjs';

const run = promisify(execFile);
// Provider limits are decimal MB; the workspace's 300 MB upload limit is separate.
export const referenceVideoLimit = model => model?.startsWith('doubao-seedance-') ? 200_000_000 : ['wan3.0-video', 'wan3.0-video-prime'].includes(model) ? 100_000_000 : null;

export async function prepareReferenceVideo(input, output, model) {
  const limit = referenceVideoLimit(model), inputBytes = (await stat(input)).size;
  if (!limit || inputBytes <= limit) return { compressed: false, inputBytes, outputBytes: inputBytes };
  const temporary = output + '.tmp.mp4', log = output + '.pass';
  try {
    const original = await probeVideo(input), targetBytes = Math.floor(limit * 0.9);
    const audioRate = original.audio ? 128_000 : 0;
    const bitrate = Math.floor(targetBytes * 8 / original.duration - audioRate);
    // Two-pass encoding keeps the source dimensions and frame timing, with room for mux overhead.
    const common = ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', input,
      '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'fast', '-b:v', String(bitrate),
      '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-passlogfile', log];
    const options = { timeout: 300_000, maxBuffer: 1024 * 1024 };
    await run('ffmpeg', [...common, '-pass', '1', '-an', '-f', 'null', '-'], options);
    await run('ffmpeg', [...common, '-pass', '2', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', temporary], options);
    const result = await probeVideo(temporary), outputBytes = (await stat(temporary)).size;
    if (outputBytes > limit || outputBytes === 0 || result.width !== original.width || result.height !== original.height
      || result.audio !== original.audio || Math.abs(result.duration - original.duration) > 0.1) throw new Error('Invalid compressed reference');
    // Decode the complete output before allowing a paid generation to use it.
    await run('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', temporary,
      '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], options);
    await rename(temporary, output);
    return { compressed: true, inputBytes, outputBytes };
  } catch {
    throw new VideoError('超限参考视频压缩未完成或校验未通过，已停止提交视频生成。请更换视频后重试。', 422, 'VIDEO_REFERENCE_COMPRESSION_FAILED');
  } finally {
    for (const path of [temporary, log + '-0.log', log + '-0.log.mbtree']) await rm(path, { force: true });
  }
}
