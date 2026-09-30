"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Mic,
  Plus,
  Play,
  Pause,
  UploadCloud,
  Check,
  Sparkles,
  Trash2,
  Volume2,
  X,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import type { PublicVoiceItem } from "@/lib/public-contract";
import { cn } from "@/lib/utils";
import { uploadMediaFile } from "@/lib/client-media-upload";

interface VoiceSelectorProps {
  selectedVoiceId?: string;
  onSelectVoice: (voice: PublicVoiceItem | null) => void;
  disabled?: boolean;
}

export default function VoiceSelector({
  selectedVoiceId,
  onSelectVoice,
  disabled = false,
}: VoiceSelectorProps) {
  const [voices, setVoices] = useState<PublicVoiceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // New Voice Modal State
  const [voiceName, setVoiceName] = useState("");
  const [voiceDesc, setVoiceDesc] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSelectFile = (file: File) => {
    if (!file) return;
    setAudioFile(file);
    setModalError(null);
    if (!voiceName) {
      setVoiceName(file.name.replace(/\.[^/.]+$/, ""));
    }
  };

  const fetchVoices = async () => {
    try {
      const resp = await fetch("/api/voices");
      const data = await resp.json();
      if (data.voices) {
        setVoices(data.voices);
        if (!selectedVoiceId && data.voices.length > 0) {
          const defaultVoice = data.voices.find((v: PublicVoiceItem) => v.isDefault) || data.voices[0];
          onSelectVoice(defaultVoice);
        }
      }
    } catch (e) {
      console.error("Failed to fetch voices", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVoices();
  }, []);

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
      audioPlayerRef.current.play().catch((err) => console.warn("Audio play error", err));
      setPlayingAudioId(voice.id);
      audioPlayerRef.current.onended = () => setPlayingAudioId(null);
    }
  };

  const handleCreateVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voiceName.trim()) {
      setModalError("请输入音色名称 (如: 我的原声)");
      return;
    }

    setUploading(true);
    setModalError(null);

    try {
      if (!audioFile) {
        throw new Error("请上传 5~15 秒干净人声音频文件 (MP3/WAV/M4A/MP4)");
      }

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
      onSelectVoice(data.voice);

      // Reset modal
      setIsModalOpen(false);
      setVoiceName("");
      setVoiceDesc("");
      setAudioFile(null);
    } catch (err: any) {
      setModalError(err.message || "创建音色失败");
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteVoice = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("确定要从声音库中删除此音色吗？")) return;
    try {
      const resp = await fetch(`/api/voices?id=${id}`, { method: "DELETE" });
      const data = await resp.json();
      if (data.success) {
        const remaining = voices.filter(voice => voice.id !== id);
        setVoices(prev => prev.filter(voice => voice.id !== id));
        if (selectedVoiceId === id) {
          onSelectVoice(remaining.find(voice => voice.isDefault) || remaining[0] || null);
        }
      }
    } catch (err) {
      console.error("Failed to delete voice", err);
    }
  };

  const activeVoice = voices.find((v) => v.id === selectedVoiceId) || voices[0];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
          <Mic className="h-4 w-4 text-blue-400" />
          <span>克隆发音人音色 (Speaker Voice)</span>
        </label>
        <button
          type="button"
          onClick={() => setIsModalOpen(true)}
          disabled={disabled}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
        >
          <Plus className="h-3 w-3" />
          <span>+ 上传克隆我的声音</span>
        </button>
      </div>

      {/* Voice Selection Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {voices.map((voice) => {
          const isSelected = selectedVoiceId ? voice.id === selectedVoiceId : voice.isDefault;
          const isPlaying = playingAudioId === voice.id;

          return (
            <div
              key={voice.id}
              onClick={() => !disabled && onSelectVoice(voice)}
              className={cn(
                "group relative flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer",
                isSelected
                  ? "border-blue-500/80 bg-blue-500/15 text-white shadow-sm ring-1 ring-blue-500/30"
                  : "border-white/[0.06] bg-black/30 text-zinc-400 hover:border-white/[0.14] hover:text-zinc-200"
              )}
            >
              <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                <div
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-xs transition-colors",
                    isSelected
                      ? "border-blue-500/40 bg-blue-500/30 text-blue-200"
                      : "border-white/[0.08] bg-white/[0.04] text-zinc-400"
                  )}
                >
                  <Volume2 className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-zinc-100 truncate">
                      {voice.name}
                    </span>
                    {voice.isDefault && (
                      <span className="rounded-md bg-white/[0.08] border border-white/[0.1] px-1.5 py-0.2 text-[9px] font-mono text-zinc-400 shrink-0">
                        官方
                      </span>
                    )}
                  </div>
                  {voice.description && (
                    <p className="text-[10px] text-zinc-400 truncate mt-0.5 font-normal">
                      {voice.description}
                    </p>
                  )}
                </div>
              </div>

              {/* Sample Play button */}
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  title="试听音色参考音频"
                  onClick={(e) => handlePlayVoice(voice, e)}
                  className={cn(
                    "h-6 w-6 flex items-center justify-center rounded-md border text-xs transition-all",
                    isPlaying
                      ? "bg-blue-600 text-white border-blue-500 animate-pulse"
                      : "bg-white/[0.06] hover:bg-white/[0.12] text-zinc-300 border-white/[0.08]"
                  )}
                >
                  {isPlaying ? <Pause className="h-3 w-3 fill-white" /> : <Play className="h-3 w-3 fill-zinc-300 ml-0.5" />}
                </button>

                {!voice.isDefault && voice.canManage !== false && (
                  <button
                    type="button"
                    title="删除此音色"
                    onClick={(e) => handleDeleteVoice(voice.id, e)}
                    className="opacity-0 group-hover:opacity-100 h-6 w-6 flex items-center justify-center rounded-md text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-all"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Upload Voice Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-in fade-in duration-150">
          <div className="relative w-full max-w-md rounded-2xl border border-white/[0.12] bg-[#10121a] p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3.5">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/15 text-blue-400 border border-blue-500/25">
                  <Mic className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-zinc-100">
                    录制 / 上传克隆声音
                  </h3>
                  <p className="text-[11px] text-zinc-400">
                    上传 5~15 秒干净清晰口播原声，即可克隆属于你的专属音色
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleCreateVoice} className="space-y-4">
              {/* Voice Name */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-300">
                  音色名称 (自定义标识) <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value)}
                  placeholder="例如: 我的原声音色 / 科技解说男声 / 清晰女播音"
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
                        setAudioFile(e.target.files[0]);
                        if (!voiceName) {
                          setVoiceName(e.target.files[0].name.replace(/\.[^/.]+$/, ""));
                        }
                      }
                    }}
                  />
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
                      }
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      "flex flex-col items-center justify-center p-5 rounded-xl border border-dashed transition-all cursor-pointer",
                      dragOver
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
                          已选: {audioFile.name}
                        </span>
                        <span className="text-[10px] text-zinc-400">
                          {audioFile.type.startsWith("video/") || audioFile.name.match(/\.(mp4|mov|mkv)$/i)
                            ? "✨ 检测到视频文件，将自动提取音频存入声音库"
                            : "点击或拖拽可更换其他文件"}
                        </span>
                      </div>
                    ) : (
                      <div className="text-center">
                        <span className="text-xs font-semibold text-zinc-200 block">
                          {dragOver ? "释放文件即可上传" : "点击或拖拽录音/视频文件至此处"}
                        </span>
                        <span className="text-[10px] text-zinc-400 block mt-0.5">
                          支持 MP3/WAV 录音，或直接拖入 MP4/MOV 视频（自动提取人声）
                        </span>
                      </div>
                    )}
                  </div>
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-300">
                  音色风格说明 (可选)
                </label>
                <input
                  type="text"
                  value={voiceDesc}
                  onChange={(e) => setVoiceDesc(e.target.value)}
                  placeholder="例如: 语速适中，富有感染力"
                  className="w-full rounded-xl border border-white/[0.08] bg-black/40 p-3 text-xs text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              {modalError && (
                <div className="flex items-center gap-2 rounded-xl bg-rose-500/10 border border-rose-500/20 p-3 text-xs text-rose-300">
                  <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                  <span>{modalError}</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-xs font-semibold text-zinc-400 hover:text-white"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={uploading}
                  className="flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 px-5 py-2.5 text-xs font-bold text-white shadow-md transition-all active:scale-[0.98] cursor-pointer"
                >
                  {uploading ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  <span>{uploading ? "正在保存音色..." : "确认添加至声音库"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
