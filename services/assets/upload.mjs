import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const invalid = message => Object.assign(new Error(message), { status: 400 });

export async function inspectAssetUpload(kind, bytes, path, probeVideo) {
  if (kind === 'photo') {
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000 });
      const info = await image.metadata();
      if (!['jpeg', 'png', 'webp'].includes(info.format) || info.pages > 1) throw new Error();
      await image.stats();
      return { mime: `image/${info.format}`, metadata: { width: info.width, height: info.height } };
    } catch { throw invalid('请上传有效的 JPG、PNG 或 WebP 图片（不超过4000万像素）。'); }
  }
  if (kind === 'video') {
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw invalid('请上传 MP4 或 MOV 视频。');
    return { mime: bytes.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4', metadata: await probeVideo(path) };
  }
  const wav = ['RIFF', 'RF64'].includes(bytes.toString('ascii', 0, 4)) && bytes.toString('ascii', 8, 12) === 'WAVE';
  const mp3 = bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (!wav && !mp3) throw invalid('请上传有效的 MP3 或 WAV 音频。');
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', wav ? 'wav' : 'mp3', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const info = JSON.parse(stdout), duration = Number(info.format?.duration);
    if (!info.streams?.some(stream => stream.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0) throw new Error();
    return { mime: wav ? 'audio/wav' : 'audio/mpeg', metadata: { duration } };
  } catch { throw invalid('请上传有效的 MP3 或 WAV 音频。'); }
}
