import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { VideoError } from './provider.mjs';

const run = promisify(execFile);
export const NARRATION_ATTEMPTS = 3;
export const narrationWait = (message, action = 'resume') =>
  Object.assign(new VideoError(message, 502, 'VIDEO_NARRATION_WAITING'), { recoveryAction: action });

export function groupNarrationSegments(segments) {
  const groups = [];
  for (const part of segments) {
    if (!(part.end > part.start && part.start >= 0) || !part.text?.trim()) throw narrationWait('请补充可识别台词的原视频。', 'input');
    const previous = groups.at(-1);
    if (previous && previous.end - previous.start < 6 && previous.speaker === part.speaker) {
      previous.end = part.end;
      previous.text += part.text.trim();
    } else groups.push({ start: part.start, end: part.end, text: part.text.trim(), ...(part.speaker === undefined ? {} : { speaker: part.speaker }) });
  }
  const tail = groups.at(-1), previous = groups.at(-2);
  if (previous && tail.end - tail.start < 5 && previous.speaker === tail.speaker) {
    previous.end = tail.end; previous.text += tail.text; groups.pop();
  }
  if (!groups.length) throw narrationWait('请补充包含人声的原视频。', 'input');
  return groups;
}

async function audioDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', file],
  { timeout: 20_000, maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout), audio = data.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(audio?.duration || data.format?.duration);
  if (!audio || !Number.isFinite(duration) || duration <= 0) throw narrationWait('请补充包含清晰原声的视频。', 'input');
  return duration;
}

export async function prepareEmotion(task, folder, segment, index, detect, repair = 0) {
  if (!task.video?.audio) throw narrationWait('请补充包含原声的视频，情绪将继续参考原视频。', 'input');
  const source = join(folder, 'source.mp4'), duration = await audioDuration(source);
  if (duration < 5) throw narrationWait('请补充至少 5 秒、包含原声的视频。', 'input');
  for (let attempt = 0; attempt < 3; attempt++) {
    // Expand around this group's original location; never stretch or loop the source.
    const length = Math.min(duration, Math.max(6 + (attempt + repair) * 2, Math.min(10, segment.end - segment.start)));
    const start = Math.max(0, Math.min(duration - length, (segment.start + segment.end - length) / 2));
    const output = join(folder, 'narration', `emotion-${index}.wav`);
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', source,
      '-ss', String(start), '-t', String(length), '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', output],
    { timeout: 60_000, maxBuffer: 1024 * 1024 });
    if (await audioDuration(output) < 5) continue;
    const intervals = await detect(output);
    if (!intervals.some(interval => interval.end > interval.start)) continue;
    segment.emotionReference = { start, end: start + length, duration: await audioDuration(output) };
    return;
  }
  throw narrationWait('请补充原声更清晰的视频，当前进度已保存。', 'input');
}

// Keep structured diagnostics, without storing signed URLs, credentials or raw provider bodies.
export function narrationDiagnostic(cause, at) {
  return { at, code: cause.code || 'VIDEO_NARRATION_PENDING', httpStatus: cause.httpStatus,
    reason: cause.reason, requestId: cause.requestId };
}
