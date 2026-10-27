import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createWuhenProvider, createWuhenStorage } from './wuhen.mjs';
import { downloadVideo, probeVideo, restoreSourceAudio } from './media.mjs';
import { VideoError } from './provider.mjs';

export const SUBTITLE_REMOVAL_FILES = ['subtitle-input.mp4', 'subtitle-clean.mp4', 'subtitle-clean.mp4.download.json', 'subtitle-result.tmp'];
const error = (message, code) => new VideoError(message, 502, 'VIDEO_CLEANUP_' + code);

export function createSubtitleRemoval({ env = process.env, fetchImpl = fetch, now = Date.now,
  provider = createWuhenProvider({ env, fetchImpl, now }), storage = createWuhenStorage({ env }),
  download = downloadVideo, probe = probeVideo, restoreAudio = restoreSourceAudio } = {}) {
  function assertConfigured() { provider.assertConfigured(); storage.assertConfigured(); }
  async function cleanup(task, save) {
    if (!task.subtitleRemoval || task.subtitleRemoval.storageCleaned) return;
    await storage.remove(task.id); task.subtitleRemoval.storageCleaned = true; await save();
  }
  return {
    assertConfigured, cleanup,
    async advance(task, folder, save) {
      assertConfigured();
      const state = task.subtitleRemoval ||= { stage: 'uploading', startedAt: now() };
      if (state.ready) return true;
      if (state.failed) throw error('全屏字幕清理任务失败，原成片已保留；请核对无痕AI任务记录。', 'FAILED');
      if (state.submitting) throw error('全屏清理提交未获确认，未重复提交；请核对无痕AI任务记录。', 'UNCERTAIN');
      const input = join(folder, 'subtitle-input.mp4'), clean = join(folder, 'subtitle-clean.mp4');
      if (!state.providerId) {
        if (!state.uploaded) {
          await save(); await storage.upload(task.id, input); state.uploaded = true; await save();
        }
        const urls = await storage.submissionUrls(task.id);
        await provider.authorize();
        // Persist BEFORE sending the paid request. Unknown outcomes never get another POST.
        state.submitting = true; state.stage = 'submitting'; await save();
        try { state.providerId = await provider.submit(urls); }
        catch (cause) {
          if (cause.providerNotDispatched) { delete state.submitting; state.stage = 'uploading'; await save(); }
          throw cause;
        }
        delete state.submitting; state.submittedAt = now(); state.stage = 'queued'; await save(); return false;
      }
      if (!state.downloaded) {
        const result = await provider.query(state.providerId);
        state.stage = result.status; state.progress = result.progress;
        if (['failed', 'paused'].includes(result.status)) {
          state.failed = true; await save(); throw error('全屏字幕清理任务未成功，原成片已保留；请核对无痕AI任务记录。', 'FAILED');
        }
        if (result.status !== 'success') { await save(); return false; }
        state.processedAt ||= now(); state.stage = 'downloading';
        if (Number.isFinite(result.metering)) state.meteringSeconds = result.metering;
        if (Number.isFinite(result.credits)) state.providerCredits = result.credits;
        await save();
        const url = result.upload_fallback ? result.download_url : await storage.outputUrl(task.id);
        if (!url) throw error('清理已完成，结果地址暂不可用，正在重新查询原任务。', 'PENDING');
        await download(url, clean);
        const before = await probe(input), after = await probe(clean);
        if (before.width !== after.width || before.height !== after.height || Math.abs(before.duration - after.duration) > .2) {
          throw error('清理结果的尺寸或时长不符，原成片已保留，请核对原清理任务。', 'INVALID');
        }
        state.downloaded = true; state.stage = 'restoring-audio'; await save();
      }
      // Keep the already-converted voice/background mix instead of the eraser's reencoded audio.
      const output = join(folder, 'subtitle-result.tmp');
      await restoreAudio(input, clean, output);
      const metadata = await probe(output);
      await rename(output, join(folder, 'result.mp4'));
      task.actualDuration = Math.round(metadata.duration * 1000) / 1000;
      task.captionCheck = { removed: true, engine: 'wuhen-std', method: 'all_area',
        warning: '已完成全屏字幕与水印清理，请预览核对是否有残留文字。' };
      state.ready = true; state.stage = 'completed'; state.completedAt = now(); state.elapsedMs = now() - state.startedAt;
      await save();
      // A storage cleanup outage must not hide a verified local result; completed-task cleanup retries it.
      await cleanup(task, save).catch(() => {});
      return true;
    },
  };
}
