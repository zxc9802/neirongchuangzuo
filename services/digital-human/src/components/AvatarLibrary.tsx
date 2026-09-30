"use client";

import React, { useState, useEffect } from "react";
import {
  Users,
  Film,
  Clock,
  Layers,
  Trash2,
  CheckCircle2,
  Cloud,
  HardDrive,
  RefreshCw,
  Search,
  Plus,
} from "lucide-react";
import type { PublicAvatarItem } from "@/lib/public-contract";
import { formatBytes, formatDuration, cn } from "@/lib/utils";
import AvatarCover from "./AvatarCover";

interface AvatarLibraryProps {
  selectedAvatarId?: string;
  onSelectAvatar: (avatar: PublicAvatarItem) => void;
  onUploadNew: () => void;
  disabled?: boolean;
}

export default function AvatarLibrary({
  selectedAvatarId,
  onSelectAvatar,
  onUploadNew,
  disabled = false,
}: AvatarLibraryProps) {
  const [avatars, setAvatars] = useState<PublicAvatarItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const fetchAvatars = async () => {
    try {
      const resp = await fetch("/api/avatars");
      const data = await resp.json();
      if (data.avatars) {
        setAvatars(data.avatars);
      }
    } catch (err) {
      console.error("Failed to fetch avatars", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAvatars();
  }, []);

  const handleDeleteAvatar = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("确定要从形象库中删除此口播形象吗？")) return;
    try {
      const resp = await fetch(`/api/avatars?id=${id}`, { method: "DELETE" });
      const data = await resp.json();
      if (data.success) {
        setAvatars((prev) => prev.filter((a) => a.id !== id));
      }
    } catch (err) {
      console.error("Delete avatar error", err);
    }
  };

  const filteredAvatars = avatars.filter((a) =>
    a.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索形象库名称..."
            className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-white/[0.08] bg-black/40 text-xs text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <button
          type="button"
          onClick={onUploadNew}
          disabled={disabled}
          className="flex items-center gap-1 text-[11px] font-semibold text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>上传新口播视频</span>
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10 text-zinc-400 text-xs gap-2">
          <RefreshCw className="h-4 w-4 animate-spin text-blue-400" />
          <span>正在加载形象库...</span>
        </div>
      ) : filteredAvatars.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-8 rounded-xl border border-dashed border-white/[0.08] bg-black/20 text-center">
          <Users className="h-8 w-8 text-zinc-500 mb-2" />
          <p className="text-xs font-semibold text-zinc-300">形象库暂无已保存素材</p>
          <p className="text-[11px] text-zinc-500 mt-1 max-w-xs">
            您上传过的口播视频会自动归档到形象库并存入云端存储，可随时快速复用
          </p>
          <button
            type="button"
            onClick={onUploadNew}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600/20 border border-blue-500/30 px-3 py-1.5 text-xs font-semibold text-blue-300 hover:bg-blue-600/30"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>立即上传第一个口播视频</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[320px] overflow-y-auto pr-1">
          {filteredAvatars.map((avatar) => {
            const isSelected = selectedAvatarId === avatar.id;

            return (
              <div
                key={avatar.id}
                onClick={() => !disabled && onSelectAvatar(avatar)}
                className={cn(
                  "group relative flex flex-col p-3 rounded-xl border transition-all cursor-pointer overflow-hidden",
                  isSelected
                    ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/40 shadow-sm"
                    : "border-white/[0.06] bg-black/40 hover:border-white/[0.14] hover:bg-black/60"
                )}
              >
                <div className="flex gap-3 items-center">
                  <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-black border border-white/[0.08]">
                    <AvatarCover
                      avatar={avatar}
                      className="h-full w-full transition-transform group-hover:scale-105"
                    />
                    <div className="absolute top-1 right-1 z-10">
                      {avatar.storedRemotely ? (
                        <span className="flex items-center gap-0.5 rounded bg-blue-500/80 px-1 py-0.2 text-[8px] font-bold text-white shadow-sm">
                          <Cloud className="h-2 w-2" /> COS
                        </span>
                      ) : (
                        <span className="flex items-center gap-0.5 rounded bg-zinc-700/80 px-1 py-0.2 text-[8px] font-mono text-zinc-300">
                          <HardDrive className="h-2 w-2" /> 本地
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-bold text-zinc-100 truncate block">
                        {avatar.name}
                      </span>
                      {isSelected && (
                        <CheckCircle2 className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                      )}
                    </div>

                    <div className="flex items-center gap-2 mt-1.5 text-[10px] text-zinc-400 flex-wrap">
                      <span className="flex items-center gap-1 font-mono">
                        <Clock className="h-2.5 w-2.5 text-zinc-500" />
                        {formatDuration(avatar.durationSeconds)}
                      </span>
                      <span className="font-mono">
                        {avatar.width}×{avatar.height}
                      </span>
                      <span className="font-mono text-zinc-500">
                        {formatBytes(avatar.fileSize)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between mt-2 pt-1 border-t border-white/[0.04]">
                      <span className="text-[9px] text-zinc-500">
                        {new Date(avatar.createdAt).toLocaleDateString("zh-CN")}
                      </span>
                      {avatar.canManage !== false && (
                        <button
                          type="button"
                          title="从形象库删除"
                          onClick={(e) => handleDeleteAvatar(avatar.id, e)}
                          className="opacity-0 group-hover:opacity-100 p-1 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded transition-all"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
