"use client";

import React, { useEffect, useRef, useState } from "react";
import { Terminal, Copy, Check, Trash2, ArrowDown, Activity } from "lucide-react";
import type { PublicLogEntry } from "@/lib/public-contract";
import { cn } from "@/lib/utils";

interface TaskTerminalProps {
  logs: PublicLogEntry[];
  onClear?: () => void;
}

export default function TaskTerminal({ logs, onClear }: TaskTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleCopy = () => {
    const text = logs
      .map(
        (l) =>
          `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level.toUpperCase()}] ${l.message}`
      )
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col rounded-2xl border border-white/[0.08] bg-[#0c0e14] font-mono text-xs shadow-2xl overflow-hidden">
      {/* Terminal Header */}
      <div className="flex items-center justify-between border-b border-white/[0.08] bg-[#121520]/80 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div className="h-2.5 w-2.5 rounded-full bg-rose-500/80 border border-rose-400/30" />
            <div className="h-2.5 w-2.5 rounded-full bg-amber-500/80 border border-amber-400/30" />
            <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/80 border border-emerald-400/30" />
          </div>
          <span className="ml-2 flex items-center gap-1.5 text-xs font-medium text-zinc-300 font-sans">
            <Activity className="h-3.5 w-3.5 text-indigo-400" />
            实时任务调度日志
          </span>
        </div>

        <div className="flex items-center gap-1.5 font-sans">
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            title={autoScroll ? "已启用自动滚动" : "已暂停自动滚动"}
            className={cn(
              "flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors",
              autoScroll
                ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                : "bg-white/[0.05] text-zinc-400 hover:text-zinc-200 border border-white/[0.05]"
            )}
          >
            <ArrowDown className="h-3 w-3" />
            <span>自动滚动</span>
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3 text-zinc-400" />}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
          {onClear && (
            <button
              onClick={onClear}
              className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300 transition-colors"
              title="清空日志"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Terminal Content */}
      <div
        ref={containerRef}
        className="h-64 overflow-y-auto p-4 space-y-1.5 selection:bg-indigo-500/30 font-mono text-[11px]"
      >
        {logs.length === 0 ? (
          <div className="text-zinc-600 italic">等待任务指令启动...</div>
        ) : (
          logs.map((log, index) => {
            const timeStr = new Date(log.timestamp).toLocaleTimeString();
            return (
              <div
                key={index}
                className={cn(
                  "flex items-start gap-2.5 leading-relaxed break-all transition-colors",
                  log.level === "info" && "text-zinc-300",
                  log.level === "success" && "text-emerald-400 font-semibold bg-emerald-500/[0.04] p-1 rounded-md",
                  log.level === "warn" && "text-amber-300 font-medium",
                  log.level === "error" && "text-rose-400 font-semibold bg-rose-500/[0.08] p-1 rounded-md"
                )}
              >
                <span className="text-zinc-600 select-none shrink-0 font-normal">
                  [{timeStr}]
                </span>
                <span>{log.message}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
