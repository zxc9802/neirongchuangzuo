"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Mic,
  Plus,
  Play,
  Pause,
  Trash2,
  CheckCircle2,
  Cloud,
  HardDrive,
  RefreshCw,
  Search,
  Volume2,
  ArrowRight,
  UploadCloud,
  X,
  AlertCircle,
  Film,
} from "lucide-react";
import type { PublicVoiceItem } from "@/lib/public-contract";
import { cn, formatBytes } from "@/lib/utils";
import { uploadMediaFile } from "@/lib/client-media-upload";

export default function VoicesPage() {
  const router = useRouter();
  const [voices, setVoices] = useState<PublicVoiceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [modalDragOver, setModalDragOver] = useState(false);

  // Upload modal state
  const [voiceName, setVoiceName] = useState("");
  const [voiceDesc, setVoiceDesc] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchVoices = async () => {
    try {
      const resp = await fetch("/api/voices");
      const data = await resp.json();
      if (data.voices) {
        setVoices(data.voices);
      }
    } catch (err) {
      console.error("Failed to fetch voices", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVoices();
  }, []);

  const handleSelectFile = (file: File) => {
    if (!file) return;
    setAudioFile(file);
    setUploadError(null);
    if (!voiceName) {
      setVoiceName(file.name.replace(/\.[^/.]+$/, ""));
    }
  };

  const handlePlayVoice = (voice: PublicVoiceItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (playingAudioId === voice.id) {
      audioPlayerRef.current?.pause();
      setPlayingAudioId(null);
    } else {
      if (!audioPlayerRef.current) {
        audioPlayerRef.current = new Audio();
      }
      audioPlayerRef.current.src = voice.audioUrl;
      audioPlayerRef.current.play().catch((err) => console.warn("Audio playback error", err));
      setPlayingAudioId(voice.id);
      audioPlayerRef.current.onended = () => setPlayingAudioId(null);
    }
  };

  const handleCreateVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voiceName.trim()) {
      setUploadError("请输入音色名称");
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      if (!audioFile) throw new Error("请上传音频文件 (MP3/WAV) 或视频文件 (MP4/MOV)");

      const uploadResult = await uploadMediaFile(
        audioFile,
        audioFile.name,
        "voices"
      );

      const resp = await fetch("/api/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: voiceName.trim(),
          description: voiceDesc.trim() || "用户自定义录制原声",
          uploadKey: uploadResult.uploadKey,
        }),
      });

      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "上传失败");
      setVoices((prev) => [data.voice, ...prev]);

      setIsUploadModalOpen(false);
      setVoiceName("");
      setVoiceDesc("");
      setAudioFile(null);
    } catch (err: any) {
      setUploadError(err.message || "创建音色失败");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("确定要从声音库中删除此音色吗？")) return;
    try {
      const resp = await fetch(`/api/voices?id=${id}`, { method: "DELETE" });
      const data = await resp.json();
      if (data.success) {
        setVoices((prev) => prev.filter((v) => v.id !== id));
      }
    } catch (err) {
      console.error("Delete voice error", err);
    }
  };

  const handleUseVoice = (voice: PublicVoiceItem) => {
    localStorage.setItem("preselected_voice_id", voice.id);
    router.push("/");
  };

  const filteredVoices = voices.filter((v) =>
    v.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (v.description && v.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
            <Mic className="h-7 w-7 text-blue-400" />
            <span>发音人声音库 (Voice Library)</span>
          </h1>
          <p className="mt-1.5 text-xs sm:text-sm text-zinc-400 max-w-2xl">
            支持拖拽上传录音或口播视频（系统自动提取高清人声），克隆专属发音人音色，并自动存入云端存储。
          </p>
        </div>

        <button
          type="button"
          onClick={() => setIsUploadModalOpen(true)}
          className="flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-blue-600/20 transition-all active:scale-[0.98] cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>+ 拖拽/上传音频或视频提取声音</span>
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索音色名称或风格..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-white/[0.08] bg-[#10121a]/90 text-xs text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div className="text-xs font-medium text-zinc-400">
          共收录 <span className="font-mono text-blue-400 font-bold">{voices.length}</span> 个声音音色
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-zinc-400 text-xs gap-2">
          <RefreshCw className="h-5 w-5 animate-spin text-blue-400" />
          <span>正在加载声音库...</span>
        </div>
      ) : filteredVoices.length === 0 ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
              handleSelectFile(e.dataTransfer.files[0]);
              setIsUploadModalOpen(true);
            }
          }}
          className={cn(
            "flex flex-col items-center justify-center p-12 rounded-2xl border border-dashed text-center space-y-3 transition-all",
            dragOver
              ? "border-blue-500 bg-blue-500/15 shadow-xl ring-2 ring-blue-500/30"
              : "border-white/[0.1] bg-[#10121a]/50"
          )}
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-900 border border-white/[0.1] text-zinc-400">
            <UploadCloud className="h-7 w-7 text-blue-400" />
          </div>
          <h3 className="text-sm font-bold text-zinc-200">
            {dragOver ? "释放音频或视频文件即可添加声音" : "声音库暂无素材"}
          </h3>
          <p className="text-xs text-zinc-500 max-w-sm">
            支持拖拽 MP3 / WAV 录音，或直接拖入 MP4 / MOV 视频文件，系统将自动抽离音频存入云端存储。
          </p>
          <button
            type="button"
            onClick={() => setIsUploadModalOpen(true)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-2 text-xs font-bold text-white shadow-md cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>立即上传声音</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredVoices.map((voice) => {
            const isPlaying = playingAudioId === voice.id;

            return (
              <div
                key={voice.id}
                className="group flex flex-col rounded-2xl border border-white/[0.08] bg-[#10121a]/90 hover:border-blue-500/40 hover:bg-[#121522] transition-all p-5 shadow-lg justify-between space-y-4"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400">
                        <Volume2 className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <h3 className="font-bold text-sm text-zinc-100 truncate max-w-[160px]">
                            {voice.name}
                          </h3>
                          {voice.isDefault && (
                            <span className="rounded-md bg-white/[0.08] border border-white/[0.1] px-1.5 py-0.2 text-[9px] font-mono text-zinc-400">
                              预设
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-zinc-400 mt-0.5 line-clamp-2">
                          {voice.description || "用户专属克隆音色"}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        title={isPlaying ? "暂停试听" : "播放试听"}
                        onClick={(e) => handlePlayVoice(voice, e)}
                        className={cn(
                          "h-8 w-8 flex items-center justify-center rounded-lg border transition-all",
                          isPlaying
                            ? "bg-blue-600 text-white border-blue-500 animate-pulse"
                            : "bg-white/[0.06] hover:bg-white/[0.12] text-zinc-300 border-white/[0.08]"
                        )}
                      >
                        {isPlaying ? <Pause className="h-3.5 w-3.5 fill-white" /> : <Play className="h-3.5 w-3.5 fill-zinc-300 ml-0.5" />}
                      </button>

                      {!voice.isDefault && voice.canManage !== false && (
                        <button
                          type="button"
                          title="删除此音色"
                          onClick={(e) => handleDelete(voice.id, e)}
                          className="h-8 w-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-all"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-3.5 flex items-center justify-between text-[10px] text-zinc-500 pt-2.5 border-t border-white/[0.04]">
                    <span>收录于 {new Date(voice.createdAt).toLocaleDateString("zh-CN")}</span>
                    <span className="text-blue-400/80">专属原声克隆</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleUseVoice(voice)}
                  className="w-full flex items-center justify-center gap-1.5 rounded-xl bg-blue-600/20 hover:bg-blue-600 text-blue-300 hover:text-white border border-blue-500/30 hover:border-blue-500 p-2.5 text-xs font-bold transition-all active:scale-[0.98] cursor-pointer"
                >
                  <Mic className="h-3.5 w-3.5" />
                  <span>选用此声音去制作</span>
                  <ArrowRight className="h-3.5 w-3.5 ml-0.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Upload Voice Modal with Drag & Drop */}
      {isUploadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-in fade-in duration-150">
          <div className="relative w-full max-w-md rounded-2xl border border-white/[0.12] bg-[#10121a] p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3.5">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/15 text-blue-400 border border-blue-500/25">
                  <Mic className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-zinc-100">
                    上传录音或口播视频提取声音
                  </h3>
                  <p className="text-[11px] text-zinc-400">
                    支持拖拽文件，音频将自动抽离并存入云端存储
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsUploadModalOpen(false)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleCreateVoice} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-300">
                  音色名称 (例如: 我的原声音色 / 科技解说男声) <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value)}
                  placeholder="请输入音色名称"
                  className="w-full rounded-xl border border-white/[0.08] bg-black/40 p-3 text-xs text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                  required
                />
              </div>

              <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*,video/*,.mp4,.mov,.m4a,.mp3,.wav,.webm,.mkv"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        handleSelectFile(e.target.files[0]);
                      }
                    }}
                  />
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setModalDragOver(true);
                    }}
                    onDragLeave={() => setModalDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setModalDragOver(false);
                      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                        handleSelectFile(e.dataTransfer.files[0]);
                      }
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      "flex flex-col items-center justify-center p-5 rounded-xl border border-dashed transition-all cursor-pointer",
                      modalDragOver
                        ? "border-blue-500 bg-blue-500/15 ring-1 ring-blue-500/30"
                        : audioFile
                        ? "border-emerald-500/50 bg-emerald-500/[0.06] text-emerald-300"
                        : "border-white/[0.12] bg-black/30 hover:border-blue-500/50 text-zinc-400"
                    )}
                  >
                    <UploadCloud className="h-7 w-7 text-blue-400 mb-2" />
                    {audioFile ? (
                      <div className="text-center">
                        <span className="text-xs font-semibold text-emerald-300 block truncate max-w-[240px]">
                          已选: {audioFile.name} ({formatBytes(audioFile.size)})
                        </span>
                        <span className="text-[10px] text-zinc-400">
                          {audioFile.type.startsWith("video/") || audioFile.name.match(/\.(mp4|mov|mkv)$/i)
                            ? "✨ 检测到视频文件，将自动提取人声音频"
                            : "点击或拖拽可更换其他文件"}
                        </span>
                      </div>
                    ) : (
                      <div className="text-center">
                        <span className="text-xs font-semibold text-zinc-200 block">
                          {modalDragOver ? "释放文件即可上传" : "点击或拖拽录音/视频文件至此处"}
                        </span>
                        <span className="text-[10px] text-zinc-400 block mt-0.5">
                          支持 MP3 / WAV 录音，或直接拖入 MP4 / MOV 视频
                        </span>
                      </div>
                    )}
                  </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-300">
                  音色风格说明 (可选)
                </label>
                <input
                  type="text"
                  value={voiceDesc}
                  onChange={(e) => setVoiceDesc(e.target.value)}
                  placeholder="例如: 沉稳专业男声，适合财经解说"
                  className="w-full rounded-xl border border-white/[0.08] bg-black/40 p-3 text-xs text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              {uploadError && (
                <div className="flex items-center gap-2 rounded-xl bg-rose-500/10 border border-rose-500/20 p-3 text-xs text-rose-300">
                  <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                  <span>{uploadError}</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setIsUploadModalOpen(false)}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-xs font-semibold text-zinc-400 hover:text-white"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={uploading || !audioFile}
                  className="flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 px-5 py-2.5 text-xs font-bold text-white shadow-md transition-all active:scale-[0.98] disabled:opacity-50 cursor-pointer"
                >
                  {uploading ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  <span>{uploading ? "正在提取音频并上传..." : "确认添加至声音库"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
