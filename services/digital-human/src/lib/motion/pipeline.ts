import "server-only";
import fs from "node:fs";
import path from "node:path";
import { probeMedia, execMediaCommand } from "@/lib/engine/ffmpeg";
import { downloadTrustedMediaToFile } from "@/lib/server/media-response";
import { isOwnedUploadSource } from "@/lib/server/upload-policy";
import { logServerError } from "@/lib/server/safe-log";
import { CosService } from "@/lib/cos";
import { MAX_MOTION_SECONDS, MotionInputError, validateMotionEdit } from "./contract";
import { MotionStore, motionDirectory, type StoredMotionProject } from "./store";
import { transcribeMotion, summarizeMotion } from "./analyze";
import { renderMotion } from "./render";
import {prepareSemanticScenes} from '../motion-library/semantics';
import type {EffectVersion} from '../motion-library/store';

export async function runMotion(id: string, operation: "analyze" | "render" | "prepare") {
  let project = await MotionStore.get(id);
  if (!project) return;
  const update = async (changes: Partial<StoredMotionProject>) => {project = await MotionStore.save({...project!, ...changes});};
  try {
    if (!isOwnedUploadSource({source: project.source, userId: project.userId, folder: "videos"})) throw new Error("Invalid owned source");
    const source = path.join(motionDirectory(id), "source.mp4");
    if (!fs.existsSync(source)) await downloadTrustedMediaToFile({source: project.source, outputPath: source});
    const probe = await probeMedia(source);
    if (!probe.width || !probe.height || !probe.hasAudio) throw new MotionInputError("请上传同时包含画面和口播声音的视频");
    if (probe.durationSeconds > MAX_MOTION_SECONDS) throw new MotionInputError("单条动效视频最长支持 10 分钟");
    const codec = (await execMediaCommand("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", source])).trim();
    if (!["aac", "mp3", "alac"].includes(codec)) throw new MotionInputError("为保留原声，请将剪辑版导出为含 AAC 或 MP3 音轨的 MP4/MOV 后上传");
    await update({duration: probe.durationSeconds, width: probe.width, height: probe.height, progress: 12, message: operation === "analyze" ? "正在识别口播字幕" : "正在准备成片"});
    let version: EffectVersion | undefined;
    if (project!.effect) {
      const {EffectStore} = await import('../motion-library/store');
      const {getBuiltinEffect} = await import('../motion-library/builtins');
      const builtin = getBuiltinEffect(project!.effect.id);
      const effect = builtin || await EffectStore.get(project!.effect.id);
      version = effect?.versions.find(v => v.revision === project!.effect!.revision);
      if (!effect || (!builtin && effect.userId !== project!.userId) || !effect.saved || !version) throw new MotionInputError('所选动效版本不可用，请重新选择');
    }
    const prepare = async (scenes = project!.scenes) => {
      if (!project!.effect) return scenes.map(({visual: _visual, ...s}) => s);
      if (version?.semantics?.required) await update({progress: operation === 'render' ? 14 : 60, message: '正在按口播内容编排图解'});
      try {
        const result = await prepareSemanticScenes({effect: project!.effect, policy: version?.semantics, scenes, captions: project!.captions, cache: project!.semanticCache});
        await update({scenes: result.scenes, semanticCache: result.cache});
        return result.scenes;
      } catch (error) {
        logServerError('motion.semantics', error);
        const validationErrors = ['图解结构无效', '图解节点无效', '内容分析遗漏片段', '内容分析片段顺序无效', '内容分析使用了模板不支持的结构', '内容分析添加了原话没有的数字'];
        const detail = error instanceof Error && validationErrors.includes(error.message) ? `（${error.message}）` : error instanceof SyntaxError ? '（返回格式不完整）' : '';
        throw new MotionInputError(`图解内容分析失败${detail}，请重试；已校对的字幕和总结会保留`);
      }
    };
    if (operation === "analyze") {
      if (!project!.captions.length) await update({captions: await transcribeMotion(source, probe.durationSeconds)});
      validateMotionEdit(project, probe.durationSeconds);
      await update({progress: 48, message: "正在按口播整理底部总结"});
      const scenes = await summarizeMotion(project!.captions);
      scenes[scenes.length - 1].end = probe.durationSeconds;
      await update({scenes});
      const edit = validateMotionEdit({...project, scenes: await prepare(scenes)}, probe.durationSeconds, true);
      await update({...edit, status: "ready", progress: 100, message: "字幕与总结已整理，可校对后生成成片", error: undefined});
    } else if (operation === 'prepare') {
      await prepare();
      await update({status: 'ready', progress: 100, message: version?.semantics?.required ? '图解已按当前内容编排，可预览后生成成片' : '模板已应用，无需额外内容分析', error: undefined});
    } else {
      const edit = validateMotionEdit({...project, scenes: await prepare()}, probe.durationSeconds, true);
      let effectTemplate: import("../motion-library/contract").EffectTemplate | undefined;
      if (version) {
        const assets = [];
        for (const asset of version.assets) {
          const local = path.join(motionDirectory(id), asset.id + (asset.kind === "image" ? ".jpg" : ".mp4"));
          await downloadTrustedMediaToFile({source: asset.source, outputPath: local});
          const {source: _source, ...publicAsset} = asset;
          assets.push({...publicAsset, url: local});
        }
        effectTemplate = {compiled: version.compiled, assets, backgroundColor: version.backgroundColor};
      }
      let lastProgress = 12;
      const output = await renderMotion(source, edit, probe.durationSeconds, percent => {
        const progress = Math.round(15 + percent * 0.76);
        if (progress < lastProgress + 3) return;
        lastProgress = progress;
        void update({progress, message: `正在渲染动效成片 ${percent}%`}).catch(err => logServerError("motion.progress", err));
      }, effectTemplate);
      await update({progress: 94, message: "正在保存成片"});
      const stored = CosService.isConfigured() ? await CosService.uploadFile(output, `jobs/${id}/final.mp4`) : output;
      if (CosService.isConfigured()) await CosService.uploadFile(path.join(motionDirectory(id), "evidence.json"), `jobs/${id}/evidence.json`);
      await update({status: "completed", progress: 100, message: "动效成片已完成，原声校验通过", output: stored, error: undefined});
    }
  } catch (error) {
    logServerError("motion.pipeline", error);
    const message = error instanceof MotionInputError ? error.message : operation === "analyze"
      ? "自动整理失败，请重试；已识别的字幕会保留，也可手动补充字幕和总结"
      : "成片生成失败，请重试；如持续失败请联系管理员检查渲染服务";
    await update({status: "failed", message, error: message}).catch(err => logServerError("motion.failure_save", err));
  }
}
