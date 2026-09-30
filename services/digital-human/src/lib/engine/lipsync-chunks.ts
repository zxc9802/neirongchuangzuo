export const LIPSYNC_CHUNK_SECONDS = 90;

export interface LipsyncChunk {
  index: number;
  startSeconds: number;
  durationSeconds: number;
}

export function planLipsyncChunks(
  totalSeconds: number,
  maxChunkSeconds = LIPSYNC_CHUNK_SECONDS
): LipsyncChunk[] {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    throw new Error("无法按无效时长切分对口型分段");
  }

  if (totalSeconds <= maxChunkSeconds + 8) {
    return [{ index: 0, startSeconds: 0, durationSeconds: totalSeconds }];
  }

  const count = Math.ceil(totalSeconds / maxChunkSeconds);
  const chunks: LipsyncChunk[] = [];
  for (let i = 0; i < count; i++) {
    const startSeconds = i * maxChunkSeconds;
    const durationSeconds = Math.min(maxChunkSeconds, totalSeconds - startSeconds);
    if (durationSeconds < 0.4) break;
    chunks.push({ index: i, startSeconds, durationSeconds });
  }
  return chunks;
}

export function estimateSpeechSeconds(charCount: number): number {
  return Math.max(1, charCount / 4.4);
}

export function pollTimeoutMs(durationSeconds: number): number {
  const scaled = Math.ceil(durationSeconds) * 25 * 1000;
  return Math.min(Math.max(scaled, 60 * 60 * 1000), 120 * 60 * 1000);
}
