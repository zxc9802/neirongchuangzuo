"use client";

import React, { useState, useRef } from "react";
import {
  UploadCloud,
  Film,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Layers,
  Clock,
  Activity,
  Users,
  HardDrive,
  Cloud,
} from "lucide-react";
import { formatBytes, formatDuration } from "@/lib/utils";
import AvatarLibrary from "./AvatarLibrary";
import type { PublicAvatarItem, PublicVideoSelection } from "@/lib/public-contract";
import { uploadMediaFile } from "@/lib/client-media-upload";
import { inspectVideoFile, recoverAvatarCover } from "@/lib/client-video-preview";

interface VideoUploaderProps {
  onVideoUploaded: (videoData: PublicVideoSelection) => void;
  disabled?: boolean;
}

export default function VideoUploader({
  onVideoUploaded,
  disabled = false,
}: VideoUploaderProps) {
  const [mode, setMode] = useState<"upload" | "library">("upload");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadSpeedText, setUploadSpeedText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploadedInfo, setUploadedInfo] = useState<any>(null);
  const [customAvatarName, setCustomAvatarName] = useState("");
  const [selectedAvatarId, setSelectedAvatarId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (file: File) => {
    if (!file) return;
    if (!file.type.startsWith("video/") && !file.name.match(/\.(mp4|mov|mkv|webm)$/i)) {
      setError("请上传 MP4 或 MOV 格式的口播视频素材");
      return;
    }

    setError(null);
    setUploading(true);
    setUploadProgress(0);
    setUploadSpeedText("准备上传...");

    // Keep immediate playback local; upload and persisted playback use separate URLs.
    const localBlobUrl = URL.createObjectURL(file);

    try {
      const { thumbnail: capturedThumbBlob, ...localProbe } = await inspectVideoFile(file);
      // 1. Upload to storage using bounded, authorized parts.
      const videoResult = await uploadMediaFile(
        file,
        file.name,
        "videos",
        (percent) => {
          setUploadProgress(percent);
          setUploadSpeedText(
            `${percent}% (${formatBytes((file.size * percent) / 100)} / ${formatBytes(file.size)})`
          );
        }
      );

      // 2. Direct upload client-captured thumbnail if available
      let coverKey = "";
      if (capturedThumbBlob) {
        try {
          const thumbResult = await uploadMediaFile(
            capturedThumbBlob,
            `${file.name.replace(/\.[^/.]+$/, "")}_thumb.jpg`,
            "thumbnails"
          );
          coverKey = thumbResult.uploadKey;
        } catch {}
      }

      // 3. Register into AvatarStore
      const displayName =
        customAvatarName.trim() ||
        file.name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_\u4e00-\u9fa5 -]/g, "") ||
        "我的口播形象";

      const createResp = await fetch("/api/avatars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: displayName,
          uploadKey: videoResult.uploadKey,
          coverKey,
          durationSeconds: localProbe?.durationSeconds || 0,
          width: localProbe?.width || 1080,
          height: localProbe?.height || 1920,
          fps: 30,
          fileSize: file.size,
        }),
      });

      const res = await createResp.json();
      if (!res.success) throw new Error(res.error || "添加形象失败");
      if (!res.avatar.coverUrl) {
        setUploadSpeedText("视频已上传，正在生成封面...");
        res.avatar.coverUrl = await recoverAvatarCover(res.avatar.id);
        if (!res.avatar.coverUrl) setError("视频已保存，封面暂未生成，可在形象库点击重新提取封面");
      }

      const finalData = {
        fileName: displayName,
        fileUrl: res.avatar.videoUrl,
        size: file.size,
        isCos: videoResult.storedRemotely,
        avatar: res.avatar,
        previewBlobUrl: localBlobUrl,
        probe: {
          ...localProbe,
          fps: 30,
          hasAudio: true,
        },
      };

      setUploadedInfo(finalData);
      if (res.avatar?.id) setSelectedAvatarId(res.avatar.id);

      onVideoUploaded({
        avatarId: res.avatar.id,
        name: displayName,
        previewUrl: localBlobUrl,
        probe: finalData.probe,
      });
    } catch (err: any) {
      URL.revokeObjectURL(localBlobUrl);
      setError(err.message || "上传异常");
    } finally {
      setUploading(false);
    }
  };

  const handleSelectFromLibrary = (avatar: PublicAvatarItem) => {
    setSelectedAvatarId(avatar.id);
    const data = {
      fileName: avatar.name,
      fileUrl: avatar.videoUrl,
      size: avatar.fileSize,
      isCos: avatar.storedRemotely,
      probe: {
        width: avatar.width,
        height: avatar.height,
        durationSeconds: avatar.durationSeconds,
        fps: avatar.fps || 30,
        hasAudio: true,
      },
    };
    setUploadedInfo(data);
    onVideoUploaded({
      avatarId: avatar.id,
      name: avatar.name,
      previewUrl: avatar.videoUrl,
      probe: data.probe,
    });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled || uploading) return;
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleUpload(e.dataTransfer.files[0]);
    }
  };

  return (
    <div className="space-y-3">
      {/* Mode Switch Tabs */}
      <div className="flex items-center gap-2 border-b border-white/[0.08] pb-2">
        <button
          type="button"
          onClick={() => setMode("upload")}
          disabled={disabled || uploading}
          className={`flex items-center gap-1.5 text-xs font-bold pb-1 border-b-2 transition-all cursor-pointer ${
            mode === "upload"
              ? "border-blue-500 text-blue-300"
              : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <UploadCloud className="h-3.5 w-3.5" />
          <span>上传新口播视频</span>
        </button>

        <button
          type="button"
          onClick={() => setMode("library")}
          disabled={disabled || uploading}
          className={`flex items-center gap-1.5 text-xs font-bold pb-1 border-b-2 transition-all cursor-pointer ${
            mode === "library"
              ? "border-blue-500 text-blue-300"
              : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Users className="h-3.5 w-3.5" />
          <span>从形象库选择</span>
        </button>
      </div>

      {mode === "library" ? (
        <AvatarLibrary
          selectedAvatarId={selectedAvatarId}
          onSelectAvatar={handleSelectFromLibrary}
          onUploadNew={() => setMode("upload")}
          disabled={disabled}
        />
      ) : (
        <>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => !disabled && !uploading && fileInputRef.current?.click()}
            className={`group relative flex flex-col items-center justify-center rounded-2xl border transition-all duration-200 cursor-pointer overflow-hidden ${
              dragOver
                ? "border-blue-500 bg-blue-500/[0.08] shadow-lg shadow-blue-500/10"
                : uploadedInfo
                ? "border-white/[0.1] bg-[#12141f]/70 hover:border-blue-500/40"
                : "border-white/[0.08] bg-[#0f111a]/60 hover:border-white/[0.16] hover:bg-[#131622]/80"
            } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/*"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  handleUpload(e.target.files[0]);
                  e.target.value = "";
                }
              }}
              disabled={disabled || uploading}
            />

            {uploading ? (
              <div className="flex flex-col items-center py-7 text-center px-6 w-full max-w-md">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-400 mb-3">
                  <RefreshCw className="h-5 w-5 animate-spin" />
                </div>
                <div className="flex items-center justify-between w-full text-xs font-semibold text-zinc-200 mb-1.5">
                  <span>{uploadProgress < 100 ? "正在上传素材并同步至云端存储..." : "正在完成音画轨道核验与形象库归档..."}</span>
                  <span className="font-mono text-blue-400">{uploadProgress}%</span>
                </div>

                {/* Live Progress Bar */}
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-900 border border-white/[0.05] mb-2 p-[1px]">
                  <div
                    className="h-full bg-blue-500 transition-all duration-200 rounded-full"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>

                <p className="text-[11px] font-mono text-zinc-400">
                  {uploadSpeedText || "传输中..."}
                </p>
              </div>
            ) : uploadedInfo ? (
              <div className="w-full flex flex-col sm:flex-row items-center gap-4 p-4">
                <div className="relative h-28 w-44 shrink-0 overflow-hidden rounded-xl bg-black border border-white/[0.1] shadow-md group/video">
                  <video
                    src={uploadedInfo.previewBlobUrl || `${uploadedInfo.fileUrl}#t=0.001`}
                    className="h-full w-full object-cover"
                    muted
                    playsInline
                    preload="auto"
                    onMouseOver={(e) => (e.currentTarget as HTMLVideoElement).play()}
                    onMouseOut={(e) => (e.currentTarget as HTMLVideoElement).pause()}
                  />
                  <div className="absolute top-1.5 right-1.5">
                    {uploadedInfo.isCos ? (
                      <span className="flex items-center gap-1 rounded-md bg-blue-600/90 backdrop-blur-sm px-1.5 py-0.5 text-[9px] font-bold text-white shadow-sm">
                        <Cloud className="h-2.5 w-2.5" /> 云端存储
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 rounded-md bg-zinc-800/90 backdrop-blur-sm px-1.5 py-0.5 text-[9px] font-mono text-zinc-300">
                        <HardDrive className="h-2.5 w-2.5" /> 本地存储
                      </span>
                    )}
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover/video:opacity-100 transition-opacity flex items-end p-2">
                    <span className="text-[10px] text-zinc-300 font-medium">悬停预览画面</span>
                  </div>
                </div>

                <div className="flex-1 space-y-2 text-left w-full">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    <span className="font-semibold text-sm text-zinc-100 truncate max-w-[240px]">
                      {uploadedInfo.fileName}
                    </span>
                    <span className="rounded-md bg-white/[0.06] border border-white/[0.08] px-2 py-0.5 text-[11px] font-mono text-zinc-400">
                      {formatBytes(uploadedInfo.size)}
                    </span>
                  </div>

                  {uploadedInfo.probe && (
                    <div className="grid grid-cols-2 gap-2 text-xs bg-black/40 p-2.5 rounded-xl border border-white/[0.06]">
                      <div className="flex items-center gap-1.5 text-zinc-400">
                        <Layers className="h-3.5 w-3.5 text-blue-400" />
                        <span>分辨率:</span>
                        <span className="text-zinc-200 font-mono font-medium">
                          {uploadedInfo.probe.width}×{uploadedInfo.probe.height}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-zinc-400">
                        <Clock className="h-3.5 w-3.5 text-zinc-400" />
                        <span>时长:</span>
                        <span className="text-zinc-200 font-mono font-medium">
                          {formatDuration(uploadedInfo.probe.durationSeconds)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-zinc-400">
                        <Activity className="h-3.5 w-3.5 text-blue-400" />
                        <span>帧率:</span>
                        <span className="text-zinc-200 font-mono font-medium">
                          {uploadedInfo.probe.fps || 30} FPS
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-zinc-400">
                        <span>音轨:</span>
                        <span
                          className={`font-medium ${
                            uploadedInfo.probe.hasAudio
                              ? "text-emerald-400 font-medium"
                              : "text-amber-400"
                          }`}
                        >
                          {uploadedInfo.probe.hasAudio ? "已包含有效音轨" : "无音轨(将自适应补全)"}
                        </span>
                      </div>
                    </div>
                  )}
                  <p className="text-[11px] font-medium text-blue-400 hover:text-blue-300 transition-colors">
                    点击更换其他视频素材 →
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center py-8 text-center px-4">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-800 border border-white/[0.1] text-blue-400 group-hover:scale-105 group-hover:bg-zinc-700 transition-all shadow-sm">
                  <UploadCloud className="h-6 w-6" />
                </div>
                <p className="text-sm font-semibold text-zinc-100">
                  点击或拖拽上传口播视频
                </p>
                <p className="mt-1 text-xs text-zinc-400 max-w-sm">
                  支持 MP4 / MOV 格式，上传后自动归档至形象库并存入云端存储
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-rose-500/10 border border-rose-500/20 p-3 text-xs text-rose-300">
          <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
