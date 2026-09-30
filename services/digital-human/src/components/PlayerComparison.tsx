"use client";

import React, { useRef, useState } from "react";
import Link from "next/link";
import {
  Play,
  Pause,
  Download,
  FileCheck,
  FileAudio,
  Film,
  Layers,
  CheckCircle2,
  Share2,
  Sparkles,
} from "lucide-react";
import { formatDuration } from "@/lib/utils";

interface PlayerComparisonProps {
  taskId: string;
  originalVideoUrl?: string;
  finalVideoUrl?: string;
  exactAudioUrl?: string;
  audioFormat?: "wav" | "mp3";
  evidenceJsonUrl?: string;
  metadata?: any;
}

export default function PlayerComparison({
  taskId,
  originalVideoUrl,
  finalVideoUrl,
  exactAudioUrl,
  audioFormat,
  evidenceJsonUrl,
  metadata,
}: PlayerComparisonProps) {
  const originalRef = useRef<HTMLVideoElement>(null);
  const finalRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setActiveTab] = useState<"side-by-side" | "result-only">(
    "side-by-side"
  );

  const togglePlay = () => {
    if (isPlaying) {
      originalRef.current?.pause();
      finalRef.current?.pause();
      setIsPlaying(false);
    } else {
      originalRef.current?.play();
      finalRef.current?.play();
      setIsPlaying(true);
    }
  };

  if (audioFormat === "mp3" && exactAudioUrl && !finalVideoUrl) {
    return (
      <div className="space-y-5 rounded-2xl border border-white/[0.1] bg-[#10121a]/95 p-6 backdrop-blur-xl shadow-2xl">
        <h3 className="flex items-center gap-2 text-base font-bold text-zinc-100">
          <CheckCircle2 className="h-5 w-5 text-emerald-400" />
          MP3 配音已生成
        </h3>
        <audio controls src={exactAudioUrl} preload="metadata" className="w-full" />
        {metadata?.audioDuration && (
          <p className="text-xs text-zinc-400">时长：{formatDuration(metadata.audioDuration)}</p>
        )}
        <a
          href={`/api/tasks/${taskId}/download/voice-track.mp3`}
          download="voice-track.mp3"
          className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs font-bold text-white transition-all"
        >
          <Download className="h-3.5 w-3.5" />
          下载配音 (MP3)
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-5 rounded-2xl border border-white/[0.1] bg-[#10121a]/95 p-6 backdrop-blur-xl shadow-2xl">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800 border border-white/[0.1] text-emerald-400">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-zinc-100">
                对口型成片交付与核验
              </h3>
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                高精度唇形对齐 完成
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              已将高保真对口型画面与专属原声音轨无损混流封装
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 self-stretch sm:self-auto">
          <button
            onClick={() =>
              setActiveTab(
                activeTab === "side-by-side" ? "result-only" : "side-by-side"
              )
            }
            className="flex-1 sm:flex-none rounded-xl border border-white/[0.08] bg-zinc-800/80 px-3.5 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-700 hover:text-white transition-all shadow-sm cursor-pointer"
          >
            {activeTab === "side-by-side" ? "单画面专注视图" : "左右对比视图"}
          </button>

          <button
            onClick={togglePlay}
            className="flex items-center gap-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 px-4 py-2 text-xs font-bold shadow-md transition-all active:scale-[0.98] cursor-pointer"
          >
            {isPlaying ? (
              <>
                <Pause className="h-4 w-4 fill-zinc-950" /> 暂停播放
              </>
            ) : (
              <>
                <Play className="h-4 w-4 fill-zinc-950" /> 同步播放
              </>
            )}
          </button>
        </div>
      </div>

      {/* Videos Layout */}
      <div
        className={`grid gap-5 ${
          activeTab === "side-by-side"
            ? "grid-cols-1 md:grid-cols-2"
            : "grid-cols-1 max-w-2xl mx-auto"
        }`}
      >
        {/* Left: Original Video */}
        {activeTab === "side-by-side" && (
          <div className="flex flex-col space-y-2">
            <div className="flex items-center justify-between text-xs text-zinc-400 font-medium px-1">
              <span className="flex items-center gap-1.5 text-zinc-300 font-semibold">
                <Film className="h-3.5 w-3.5 text-zinc-400" />
                原始口播画面
              </span>
              <span className="rounded-md bg-white/[0.06] border border-white/[0.08] px-2 py-0.5 text-[10px] text-zinc-400 font-mono">
                原片源
              </span>
            </div>
            <div className="relative aspect-[9/16] md:aspect-video w-full overflow-hidden rounded-2xl bg-black border border-white/[0.08] shadow-inner flex items-center justify-center">
              {originalVideoUrl ? (
                <video
                  ref={originalRef}
                  src={originalVideoUrl}
                  className="h-full w-full object-contain"
                  playsInline
                  onTimeUpdate={(e) => {
                    if (
                      Math.abs(
                        (finalRef.current?.currentTime || 0) -
                          e.currentTarget.currentTime
                      ) > 0.3
                    ) {
                      if (finalRef.current)
                        finalRef.current.currentTime =
                          e.currentTarget.currentTime;
                    }
                  }}
                  onEnded={() => setIsPlaying(false)}
                />
              ) : (
                <div className="text-xs text-zinc-600">原视频预览</div>
              )}
            </div>
          </div>
        )}

        {/* Right: Final Lip-synced Video */}
        <div className="flex flex-col space-y-2">
          <div className="flex items-center justify-between text-xs font-medium px-1">
            <span className="flex items-center gap-1.5 text-emerald-300 font-semibold">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              数字人对口型成片 (Final Delivery)
            </span>
            <span className="rounded-md bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[10px] text-emerald-300 font-semibold">
              高保真原声音轨绑定
            </span>
          </div>
          <div className="relative aspect-[9/16] md:aspect-video w-full overflow-hidden rounded-2xl bg-black border border-emerald-500/40 shadow-xl flex items-center justify-center">
            {finalVideoUrl ? (
              <video
                ref={finalRef}
                src={finalVideoUrl}
                className="h-full w-full object-contain"
                controls
                playsInline
                onPlay={() => {
                  originalRef.current?.play();
                  setIsPlaying(true);
                }}
                onPause={() => {
                  originalRef.current?.pause();
                  setIsPlaying(false);
                }}
                onEnded={() => setIsPlaying(false)}
              />
            ) : (
              <div className="text-xs text-zinc-600">成片正在生成中...</div>
            )}
          </div>
        </div>
      </div>

      {/* Metadata & Downloads Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-black/40 p-4 border border-white/[0.08]">
        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400 font-mono">
          {metadata?.resolution && (
            <div className="bg-white/[0.04] px-2.5 py-1 rounded-lg border border-white/[0.06]">
              分辨率: <span className="text-zinc-200 font-semibold">{metadata.resolution}</span>
            </div>
          )}
          {metadata?.videoDuration && (
            <div className="bg-white/[0.04] px-2.5 py-1 rounded-lg border border-white/[0.06]">
              时长:{" "}
              <span className="text-zinc-200 font-semibold">
                {formatDuration(metadata.videoDuration)}
              </span>
            </div>
          )}
          {metadata?.fps && (
            <div className="bg-white/[0.04] px-2.5 py-1 rounded-lg border border-white/[0.06]">
              帧率: <span className="text-zinc-200 font-semibold">{metadata.fps} FPS</span>
            </div>
          )}
          {metadata?.sha256Audio && (
            <div
              title={metadata.sha256Audio}
              className="bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20 text-emerald-300"
            >
              音频指纹: {metadata.sha256Audio.slice(0, 10)}...
            </div>
          )}
        </div>

        {/* Download Buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {finalVideoUrl && (
            <Link
              href={`/motion?fromTask=${encodeURIComponent(taskId)}`}
              className="flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-2 text-xs font-bold text-white transition-all shadow-sm active:scale-[0.98]"
            >
              <Sparkles className="h-3.5 w-3.5" />
              添加动效
            </Link>
          )}
          {finalVideoUrl && (
            <a
              href={`/api/tasks/${taskId}/download/final.mp4`}
              download="final.mp4"
              className="flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs font-bold text-white transition-all shadow-sm active:scale-[0.98]"
            >
              <Download className="h-3.5 w-3.5" />
              下载成片 (MP4)
            </a>
          )}
          {exactAudioUrl && (
            <a
              href={`/api/tasks/${taskId}/download/voice-track.wav`}
              download="voice-track.wav"
              className="flex items-center gap-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 px-3.5 py-2 text-xs font-semibold text-zinc-200 transition-all border border-white/[0.08]"
            >
              <FileAudio className="h-3.5 w-3.5 text-blue-400" />
              下载配音 (WAV)
            </a>
          )}
          {evidenceJsonUrl && (
            <a
              href={`/api/tasks/${taskId}/download/production-report.json`}
              download="production-report.json"
              className="flex items-center gap-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 px-3.5 py-2 text-xs font-semibold text-zinc-200 transition-all border border-white/[0.08]"
            >
              <FileCheck className="h-3.5 w-3.5 text-zinc-400" />
              下载凭证 (JSON)
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
