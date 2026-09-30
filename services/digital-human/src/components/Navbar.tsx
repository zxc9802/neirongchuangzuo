"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Video, History, Users, Mic, Coins, LogOut, KeyRound, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface SessionData {
  authMode?: "standalone";
  user: {
    id: string;
    account: string;
    nickname: string;
    role: string;
    groupName?: string;
    billingAudience?: string;
    pointsBalance?: number;
  };
  billing?: {
    ratePerSecond: number;
    cnyPerSecond: number;
    isExternal: boolean;
  };
}

export default function Navbar() {
  const pathname = usePathname();
  const [session, setSession] = useState<SessionData | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const isAuthPage = pathname === "/login" || pathname === "/register";

  const fetchSession = async () => {
    try {
      const resp = await fetch(`/api/session?t=${Date.now()}`);
      if (resp.ok) {
        const json = await resp.json();
        if (json.data) {
          setSession(json.data);
        }
      } else if (resp.status === 401) setSession(null);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (isAuthPage) return;
    fetchSession();
    const interval = setInterval(fetchSession, 15000);
    return () => clearInterval(interval);
  }, [isAuthPage]);

  const logout = async () => {
    setSigningOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error();
      for (const key of ["active_lipsync_task_id", "preselected_avatar_id", "preselected_voice_id"]) localStorage.removeItem(key);
      window.location.replace("/login");
    } catch {
      window.alert("退出失败，请检查网络后重试");
      setSigningOut(false);
    }
  };

  if (isAuthPage) return null;

  const navItems = [
    { name: "制作台", href: "/", icon: Video },
    { name: "数字人动效", href: "/motion", icon: Sparkles },
    { name: "形象库", href: "/avatars", icon: Users },
    { name: "声音库", href: "/voices", icon: Mic },
    { name: "任务历史", href: "/history", icon: History },
  ];

  const isExternal = session?.billing?.isExternal ?? (session?.user?.role !== "admin" && session?.user?.billingAudience !== "internal");
  const points = session?.user?.pointsBalance;

  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/[0.08] bg-[#0a0b0e]/85 backdrop-blur-xl transition-all">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-3 group shrink-0">
          <div className="flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-xl bg-zinc-900 border border-white/[0.15] text-zinc-100 shadow-md group-hover:border-blue-500/50 group-hover:bg-zinc-800 transition-all">
            <Video className="h-4 w-4 sm:h-5 sm:w-5 text-blue-400" />
          </div>
          <div>
            <span className="text-sm sm:text-base font-bold tracking-tight text-zinc-100 group-hover:text-white transition-colors">
              数字人制作
            </span>
            <p className="text-[11px] text-zinc-400 font-normal hidden sm:block">
              AI 智能原声克隆 · 高精唇形驱动
            </p>
          </div>
        </Link>

        {/* Navigation Items */}
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <nav className="flex items-center gap-1 sm:gap-1.5 min-w-0 overflow-x-auto">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "relative flex items-center gap-1.5 rounded-xl px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs font-semibold transition-all whitespace-nowrap",
                    active
                      ? "bg-zinc-800 text-white shadow-sm border border-white/[0.14]"
                      : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5 sm:h-4 sm:w-4", active ? "text-blue-400" : "text-zinc-500")} />
                  <span>{item.name}</span>
                  {active && (
                    <span className="absolute -bottom-[17px] left-1/2 -translate-x-1/2 w-6 h-[2px] bg-blue-500" />
                  )}
                </Link>
              );
            })}
          </nav>

          {/* User & Points Badge */}
          {session?.user && (
            <div className="hidden md:flex items-center gap-2 rounded-xl bg-white/[0.04] border border-white/[0.08] px-3 py-1.5 text-xs">
              {isExternal && (
                <div
                  className="flex items-center gap-1.5 font-medium text-amber-300"
                  title={`主站外部用户费率: ${session?.billing?.ratePerSecond ?? 20}积分/秒 (0.2元/秒)`}
                >
                  <Coins className="h-3.5 w-3.5 text-amber-400" />
                  <span className="font-mono font-bold">
                    {typeof points === "number" ? points.toLocaleString() : "--"}
                  </span>
                  <span className="text-[10px] text-amber-400/80 bg-amber-400/10 px-1.5 py-0.5 rounded">
                    {session?.billing?.ratePerSecond ?? 20}分/秒
                  </span>
                </div>
              )}
              {isExternal && <span className="text-zinc-500">|</span>}
              <span className="text-zinc-300 truncate max-w-[100px] text-[11px]" title={session.user.account}>
                {session.user.nickname || session.user.account}
              </span>
            </div>
          )}
          {session?.authMode === "standalone" && (
            <div className="flex items-center gap-1">
              <Link href="/account" aria-label="账号安全" title="账号安全" className="rounded-lg p-2 text-zinc-400 hover:bg-white/5 hover:text-white"><KeyRound size={16} /></Link>
              <button onClick={logout} disabled={signingOut} aria-label="退出登录" title="退出登录" className="rounded-lg p-2 text-zinc-400 hover:bg-white/5 hover:text-white disabled:opacity-40"><LogOut size={16} /></button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
