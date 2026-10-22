import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, rename } from 'node:fs/promises';
import { probeVideo } from './media.mjs';
import { VideoError } from './provider.mjs';

const run = promisify(execFile);
// Each part is still a full Seedance reference video.
export const SEGMENT_MIN = 4;
const PAUSE_MIN = 0.25, BOUNDARY_LIMIT = 200;
const round = value => Math.round(value * 1000) / 1000;
export const segmentTier = (seconds, durations) => durations.find(value => value >= Math.ceil(seconds - 0.05));

export function speechPauses(intervals = []) {
  const spoken = intervals.filter(item => Number.isFinite(item?.start) && Number.isFinite(item?.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start), pauses = [];
  for (let index = 1; index < spoken.length; index++) {
    const start = spoken[index - 1].end, end = spoken[index].start;
    if (end - start >= PAUSE_MIN) pauses.push({ start: round(start), end: round(end) });
  }
  return pauses.slice(0, BOUNDARY_LIMIT);
}

// Two independent generations always differ slightly. Put the seam on a hard
// cut, else in a speech pause, else where the provider duration tiers waste least.
export function planSegments(duration, { maxSegment, durations, fps, cuts = [], pauses = [] }) {
  // Same tolerance as a single generation's duration tier.
  if (!(Math.ceil(duration - 0.05) > maxSegment)) return null;
  const low = Math.max(SEGMENT_MIN, duration - maxSegment), high = Math.min(maxSegment, duration - SEGMENT_MIN);
  if (low > high) throw new VideoError(`参考视频时长无法拆成两段 ${SEGMENT_MIN}–${maxSegment} 秒的片段。`, 400, 'VIDEO_DURATION_INVALID');
  const inside = at => at >= low && at <= high;
  // Keep the seam on a source frame when that frame is still inside the window.
  const snap = at => { const frame = fps > 0 ? Math.round(at * fps) / fps : at; return inside(frame) ? frame : at; };
  const waste = at => segmentTier(at, durations) + segmentTier(duration - at, durations) - duration;
  const middle = duration / 2;
  const best = (options, ...tieBreaks) => options.sort((a, b) => waste(a.at) - waste(b.at)
    || tieBreaks.reduce((order, compare) => order || compare(a, b), 0) || Math.abs(a.at - middle) - Math.abs(b.at - middle))[0];
  const scene = best(cuts.filter(inside).map(at => ({ at: snap(at), boundary: 'scene' })));
  const pause = !scene && best(pauses.filter(item => item.end > low && item.start < high).map(item => ({
    at: snap(Math.min(high, Math.max(low, (item.start + item.end) / 2))), boundary: 'pause', length: item.end - item.start })),
  (a, b) => b.length - a.length);
  const fixed = !scene && !pause && best([high, ...durations.flatMap(tier => [tier, duration - tier])].filter(inside)
    .map(at => ({ at: snap(at), boundary: 'duration' })));
  const { at, boundary } = scene || pause || fixed;
  const end = round(duration), seam = round(at);
  return { boundary, segments: [{ start: 0, end: seam }, { start: seam, end }].map((segment, index) => ({ index, ...segment,
    duration: segmentTier(segment.end - segment.start, durations) })) };
}

async function frameStream(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate', '-of', 'json', path], { timeout: 20_000, maxBuffer: 1024 * 1024 });
  const stream = JSON.parse(stdout).streams?.[0];
  for (const rate of [stream?.avg_frame_rate, stream?.r_frame_rate]) {
    const [numerator, denominator = 1] = String(rate).split('/').map(Number);
    if (numerator > 0 && denominator > 0 && numerator / denominator <= 120) return { ...stream, rate, fps: numerator / denominator };
  }
  throw new Error('Invalid frame rate');
}

// Only the opening `limit` seconds can hold a seam; longer sources are clipped before generation.
export async function detectSceneCuts(path, limit) {
  const { fps } = await frameStream(path);
  // A conservative threshold: fast motion inside one shot must not count as a cut.
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file,pipe', ...(limit ? ['-t', String(limit)] : []), '-i', path,
    '-an', '-vf', "scale=320:-2,select='gt(scene,0.4)',showinfo", '-f', 'null', '-'], { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  const cuts = [...stderr.matchAll(/pts_time:\s*([\d.]+)/g)].map(match => round(Number(match[1]))).filter(Number.isFinite);
  return { fps, cuts: cuts.slice(0, BOUNDARY_LIMIT) };
}

export async function cutVideoSegment(input, output, start, end) {
  const temporary = output + '.tmp.mp4';
  try {
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', input,
      '-t', String(round(end - start)), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', temporary],
    { timeout: 300_000, maxBuffer: 1024 * 1024 });
    const metadata = await probeVideo(temporary);
    if (Math.abs(metadata.duration - (end - start)) > 0.15) throw new Error('Segment duration mismatch');
    await rename(temporary, output);
    return metadata;
  } catch { throw new VideoError('参考视频分段未完成，尚未提交生成，将自动重试。', 502, 'VIDEO_SEGMENT_PENDING'); }
  finally { await rm(temporary, { force: true }); }
}

// Trim every generation to its source span on the frame grid, so the seam and
// the whole-track converted voice keep the original timeline.
export async function joinVideoSegments(inputs, segments, output) {
  const temporary = output + '.join.mp4';
  try {
    const { width, height, rate, fps } = await frameStream(inputs[0]);
    const parts = segments.map((segment, index) => {
      const frames = Math.round(segment.end * fps) - Math.round(segment.start * fps);
      return `[${index}:v:0]fps=${rate},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,`
        + `tpad=stop_mode=clone:stop_duration=${Math.ceil(segment.end - segment.start)},trim=end_frame=${frames},setpts=N/FRAME_RATE/TB[v${index}]`;
    });
    const filter = `${parts.join(';')};${segments.map((_, index) => `[v${index}]`).join('')}concat=n=${segments.length}:v=1:a=0[video]`;
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', ...inputs.flatMap(input => ['-i', input]),
      '-filter_complex', filter, '-map', '[video]', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', temporary], { timeout: 600_000, maxBuffer: 1024 * 1024 });
    const metadata = await probeVideo(temporary);
    if (Math.abs(metadata.duration - (segments.at(-1).end - segments[0].start)) > 0.15) throw new Error('Joined duration mismatch');
    await rename(temporary, output);
    return metadata;
  } catch { throw new VideoError('分段成片拼接未完成，将重试拼接，不会重新生成。', 502, 'VIDEO_SEGMENT_JOIN_PENDING'); }
  finally { await rm(temporary, { force: true }); }
}
