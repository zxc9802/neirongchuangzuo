"use client";

import React from "react";
import {
  Mic,
  Film,
  ShieldCheck,
  Cpu,
  Layers,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Activity,
  CircleDashed,
} from "lucide-react";
import type { PublicTaskStep } from "@/lib/public-contract";
import { cn } from "@/lib/utils";

interface PipelineVisualizerProps {
  audioOnly?: boolean;
  step: PublicTaskStep;
  failedStep?: PublicTaskStep;
  progress: number;
  status: "idle" | "pending" | "processing" | "completed" | "failed";
}

const STEPS = [
  { key: "voice", label: "原声配音合成", sub: "专属音色克隆", icon: Mic },
  { key: "prepare", label: "音画智能对齐", sub: "帧率时长优化", icon: Film },
  { key: "check", label: "质量合规校验", sub: "规格与完整性", icon: ShieldCheck },
  { key: "render", label: "高精度对口型", sub: "自然唇形驱动", icon: Cpu },
  { key: "finalize", label: "高清混流封装", sub: "无损音画合成", icon: Layers },
  { key: "done", label: "成片交付就绪", sub: "生成完成可播放", icon: CheckCircle2 },
];

const AUDIO_STEPS = [
  STEPS[0],
  { key: "finalize", label: "导出 MP3", sub: "生成音频文件", icon: Layers },
  { key: "done", label: "配音已就绪", sub: "可试听与下载", icon: CheckCircle2 },
];

export default function PipelineVisualizer({
  audioOnly = false,
  step,
  failedStep,
  progress,
  status,
}: PipelineVisualizerProps) {
  const steps = audioOnly ? AUDIO_STEPS : STEPS;
  const getStepStatus = (index: number) => {
    // If not started yet, everything is upcoming/idle
    if (status === "idle" || step === "idle") {
      return "upcoming";
    }

    if (status === "completed" || step === "done") {
      return "completed";
    }

    const currentIdx = steps.findIndex(item => item.key === (failedStep || step));

    if (status === "failed") {
      if (index === currentIdx) return "error";
      if (index < currentIdx) return "completed";
      return "upcoming";
    }

    if (index < currentIdx) return "completed";
    if (index === currentIdx) return "running";
    return "upcoming";
  };

  const isIdle = status === "idle" || step === "idle";

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#10121a]/80 p-5 backdrop-blur-xl shadow-xl">
      <div className="flex items-center justify-between mb-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-800 border border-white/[0.1] text-zinc-300">
            <Activity className="h-4 w-4 text-blue-400" />
          </div>
          <div>
            <span className="text-xs font-bold text-zinc-100 uppercase tracking-wider">
              流水线执行进展
            </span>
            <div className="flex items-center gap-2 mt-0.5">
              {isIdle && (
                <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400 font-medium">
                  <CircleDashed className="h-3 w-3 text-zinc-500" />
                  待命状态 (请输入文案并选择音色)
                </span>
              )}
              {status === "processing" && (
                <span className="inline-flex items-center gap-1 text-[11px] text-blue-300 font-medium">
                  <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
                  正在运行中
                </span>
              )}
              {status === "completed" && (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300 font-medium">
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  全部步骤顺利交付
                </span>
              )}
              {status === "failed" && (
                <span className="inline-flex items-center gap-1 text-[11px] text-rose-300 font-medium">
                  <AlertCircle className="h-3 w-3 text-rose-400" />
                  步骤中断，需检查提示
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-bold text-zinc-100 tabular-nums">
            {isIdle ? 0 : progress}%
          </span>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-900 border border-white/[0.05] mb-5 p-[1px]">
        <div
          className={cn(
            "h-full transition-all duration-500 rounded-full",
            isIdle
              ? "w-0"
              : status === "failed"
              ? "bg-rose-500 shadow-sm shadow-rose-500/30"
              : status === "completed"
              ? "bg-emerald-500 shadow-sm shadow-emerald-500/30"
              : "bg-gradient-to-r from-blue-600 via-blue-500 to-emerald-500 shadow-sm shadow-blue-500/30"
          )}
          style={{ width: isIdle ? "0%" : `${Math.max(progress, 5)}%` }}
        />
      </div>

      {/* Step Badges Grid */}
      <div className={cn("grid grid-cols-2 sm:grid-cols-3 gap-2.5", !audioOnly && "md:grid-cols-6")}>
        {steps.map((s, idx) => {
          const stepStatus = getStepStatus(idx);
          const Icon = s.icon;
          return (
            <div
              key={s.key}
              className={cn(
                "relative flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all text-center",
                stepStatus === "completed" &&
                  "border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-200",
                stepStatus === "running" &&
                  "border-blue-500/40 bg-blue-500/[0.1] text-blue-100 ring-1 ring-blue-500/20",
                stepStatus === "error" &&
                  "border-rose-500/35 bg-rose-500/[0.08] text-rose-200",
                stepStatus === "upcoming" &&
                  "border-white/[0.05] bg-black/20 text-zinc-500"
              )}
            >
              <div
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-lg border text-xs",
                  stepStatus === "completed" &&
                    "border-emerald-500/30 bg-emerald-500/20 text-emerald-400",
                  stepStatus === "running" &&
                    "border-blue-500/40 bg-blue-500/25 text-blue-300 animate-pulse",
                  stepStatus === "error" &&
                    "border-rose-500/40 bg-rose-500/20 text-rose-400",
                  stepStatus === "upcoming" &&
                    "border-white/[0.06] bg-white/[0.02] text-zinc-600"
                )}
              >
                {stepStatus === "running" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" />
                ) : (
                  <Icon className="h-3.5 w-3.5" />
                )}
              </div>
              <div className="space-y-0.5">
                <span className="text-[11px] font-semibold block leading-tight">
                  {s.label}
                </span>
                <span className="text-[9px] text-zinc-400 block font-normal">
                  {s.sub}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
