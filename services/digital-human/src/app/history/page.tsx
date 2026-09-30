"use client";

import React, { useEffect, useState } from "react";
import { History, Film, Download, CheckCircle2, AlertCircle, Clock, Trash2, ArrowRight, Play, Coins } from "lucide-react";
import type { PublicTaskItem } from "@/lib/public-contract";
import { formatDuration } from "@/lib/utils";
import Link from "next/link";

export default function HistoryPage() {
  const [tasks, setTasks] = useState<PublicTaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchTasks = async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const resp = await fetch(`/api/tasks?t=${Date.now()}`);
      const data = await resp.json();
      if (data.tasks) setTasks(data.tasks);
    } catch (e) {
      console.error("Failed to load tasks", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  const handleDeleteTask = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("确定要从历史记录中删除该任务吗？")) return;
    try {
      const resp = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      const data = await resp.json();
      if (!resp.ok) {
        alert(data.error || "删除失败，请稍后重试");
        return;
      }
      if (data.success) {
        setTasks((prev) => prev.filter((t) => t.id !== id));
      }
    } catch (err) {
      console.error("Delete task error", err);
    }
  };

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
            <History className="h-8 w-8 text-indigo-400" />
            <span>制作任务历史与交付归档</span>
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            查看所有已生成的数字人对口型成片、音轨校验与凭证哈希，数据已自动同步至云端永久存储。
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => fetchTasks(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] px-3.5 py-2 text-xs font-semibold text-zinc-300 transition-all hover:text-white cursor-pointer"
          >
            <History className={`h-3.5 w-3.5 ${refreshing ? "animate-spin text-blue-400" : "text-zinc-400"}`} />
            <span>{refreshing ? "正在刷新..." : "刷新历史记录"}</span>
          </button>

          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-2 text-xs font-bold text-white transition-all shadow-md shadow-blue-600/25"
          >
            <span>+ 新建制作任务</span>
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-zinc-500 text-sm">
          正在加载历史任务...
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.08] bg-[#0f111a]/80 p-12 text-center backdrop-blur-xl">
          <Film className="h-10 w-10 text-zinc-600 mx-auto mb-3" />
          <h3 className="text-sm font-semibold text-zinc-200">暂无制作记录</h3>
          <p className="text-xs text-zinc-400 mt-1 max-w-sm mx-auto">
            前往制作台上传口播视频并提交文案，即可开始第一次对口型制作。
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 mt-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-bold text-white transition-all shadow-md shadow-indigo-600/25"
          >
            <span>立即制作第一条视频</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {tasks.map((task) => {
            const isDone = task.status === "completed";
            const isFailed = task.status === "failed";
            return (
              <div
                key={task.id}
                className="rounded-2xl border border-white/[0.08] bg-[#0f111a]/80 p-5 backdrop-blur-xl transition-all hover:border-white/[0.14] hover:bg-[#121522]/90 shadow-xl"
              >
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="font-bold text-sm text-zinc-100 truncate">
                        {task.inputs?.videoName || "未命名任务"}
                      </span>
                      {isDone && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                          制作成功
                        </span>
                      )}
                      {isFailed && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 border border-rose-500/25 px-2.5 py-0.5 text-[11px] font-semibold text-rose-300">
                          <AlertCircle className="h-3 w-3 text-rose-400" />
                          制作中断
                        </span>
                      )}
                      {task.billing?.isExternalUser && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/25 px-2.5 py-0.5 text-[11px] font-mono font-semibold text-amber-300">
                          <Coins className="h-3 w-3 text-amber-400" />
                          <span>
                            {isDone && typeof (task.results?.chargedPoints ?? task.billing.chargedPoints) === "number"
                              ? `已扣 ${(task.results?.chargedPoints ?? task.billing.chargedPoints ?? 0).toLocaleString()} 积分 (¥${(task.results?.costCny ?? task.billing.costCny ?? 0).toFixed(2)})`
                              : `预留 ${(task.billing.estimatedPoints ?? 0).toLocaleString()} 积分`}
                          </span>
                        </span>
                      )}
                      {task.billing && !task.billing.isExternalUser && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/25 px-2.5 py-0.5 text-[11px] font-semibold text-blue-300">
                          内部免扣费
                        </span>
                      )}
                      <span className="text-[11px] text-zinc-500 font-mono">
                        {new Date(task.createdAt).toLocaleString()}
                      </span>
                    </div>

                    <p className="text-xs text-zinc-400 line-clamp-1">
                      {task.inputs?.scriptText}
                    </p>

                    {task.results && (
                      <div className="flex items-center gap-3 text-[11px] text-zinc-400 font-mono pt-1">
                        {(task.results.videoDuration || task.results.audioDuration) && (
                          <span>时长: {formatDuration(task.results.videoDuration || task.results.audioDuration || 0)}</span>
                        )}
                        {task.results.resolution && (
                          <span>分辨率: {task.results.resolution}</span>
                        )}
                        {task.results.fps && <span>{task.results.fps} FPS</span>}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 self-stretch sm:self-auto shrink-0">
                    {task.results?.exactAudioUrl && task.results.audioFormat === "mp3" && (
                      <a
                        href={`/api/tasks/${task.id}/download/voice-track.mp3`}
                        download="voice-track.mp3"
                        className="flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-3.5 py-2 text-xs font-bold text-white transition-all"
                      >
                        <Download className="h-3.5 w-3.5" />
                        下载配音 (MP3)
                      </a>
                    )}
                    {task.results?.finalVideoUrl && (
                      <a
                        href={`/api/tasks/${task.id}/download/final.mp4`}
                        download="final.mp4"
                        className="flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-3.5 py-2 text-xs font-bold text-white transition-all shadow-md shadow-emerald-600/20 active:scale-[0.98]"
                      >
                        <Download className="h-3.5 w-3.5" />
                        下载成片
                      </a>
                    )}
                    <Link
                      href="/"
                      onClick={() => {
                        localStorage.setItem("active_lipsync_task_id", task.id);
                      }}
                      className="flex items-center gap-1 rounded-xl border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] px-3 py-2 text-xs font-semibold text-zinc-300 transition-all hover:text-white"
                    >
                      <span>在制作台查看</span>
                      <ArrowRight className="h-3 w-3 text-zinc-400" />
                    </Link>
                    <button
                      type="button"
                      title="删除此任务记录"
                      onClick={(e) => handleDeleteTask(task.id, e)}
                      className="p-2 rounded-xl border border-white/[0.08] bg-white/[0.04] hover:bg-rose-500/10 text-zinc-500 hover:text-rose-400 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
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
