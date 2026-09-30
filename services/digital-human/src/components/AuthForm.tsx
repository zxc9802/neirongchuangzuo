"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, AudioLines, Eye, EyeOff, Film, LoaderCircle, Video } from "lucide-react";

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const register = mode === "register";
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    if (register && form.get("password") !== form.get("confirm")) { setError("两次输入的密码不一致"); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password"), nickname: form.get("nickname") }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "暂时无法登录，请稍后重试");
      for (const key of ["active_lipsync_task_id", "preselected_avatar_id", "preselected_voice_id"]) localStorage.removeItem(key);
      const next = new URLSearchParams(window.location.search).get("next");
      const destination = next && /^\/(?!\/)/.test(next) && !/[\\\r\n]/.test(next) ? next : "/";
      window.location.replace(destination);
    } catch (error) {
      setError(error instanceof Error ? error.message : "连接失败，请检查网络");
      setBusy(false);
    }
  }

  const inputClass = "w-full rounded-xl border border-white/10 bg-zinc-950/60 px-4 py-3.5 text-sm text-white outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15 placeholder:text-zinc-600";
  return (
    <div className="grid min-h-[calc(100vh-150px)] items-center gap-16 py-6 lg:grid-cols-[1.1fr_1fr] lg:gap-24">
      <section className="relative hidden self-stretch overflow-hidden rounded-[32px] border border-white/10 bg-[#10151e] p-12 lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3 text-sm font-medium text-zinc-300"><Video className="text-blue-400" size={22} /> 数字人制作 <span className="ml-auto font-mono text-[10px] tracking-[0.22em] text-zinc-500">STUDIO / 01</span></div>
        <div className="py-16">
          <p className="mb-6 text-xs tracking-[0.3em] text-blue-300">你的专属数字人工作室</p>
          <h1 className="text-5xl font-semibold leading-[1.35] tracking-tight">让你的声音，<br />拥有更多<span className="text-blue-300">可能。</span></h1>
          <p className="mt-6 max-w-sm text-sm leading-7 text-zinc-400">从一段文案到一支作品。让形象、声音与创意，<br />在同一个工作台相遇。</p>
          <div aria-hidden="true" className="relative mt-12 flex h-28 items-center justify-center gap-[5px] rounded-2xl border border-white/[0.06] bg-black/20 px-8">
            {Array.from({ length: 39 }, (_, i) => <span key={i} className="w-[5px] rounded-full bg-blue-300/70" style={{ height: `${12 + Math.sin(i * .67) ** 2 * (52 - Math.abs(i - 19) * 1.8)}px` }} />)}
            <span className="absolute bottom-3 right-4 font-mono text-[9px] tracking-widest text-zinc-600">YOUR VOICE, REIMAGINED</span>
          </div>
        </div>
        <div className="flex gap-7 border-t border-white/10 pt-6 text-xs text-zinc-400"><span className="flex items-center gap-2"><AudioLines size={15} />专属音色</span><span className="flex items-center gap-2"><Video size={15} />唇形同步</span><span className="flex items-center gap-2"><Film size={15} />创意动效</span></div>
      </section>
      <section className="mx-auto w-full max-w-[390px]">
        <div className="mb-12 flex items-center gap-2 text-sm text-zinc-300 lg:hidden"><Video size={20} className="text-blue-400" />数字人制作</div>
        <p className="mb-4 font-mono text-[11px] tracking-[0.22em] text-blue-300">DIGITAL HUMAN STUDIO</p>
        <h2 className="text-3xl font-semibold tracking-tight">{register ? "创建你的创作账号" : "欢迎回到工作室"}</h2>
        <p className="mb-8 mt-3 text-sm leading-6 text-zinc-400">{register ? "用一个账号，保存你的形象、声音和作品。" : "登录后，继续你的下一支作品。"}</p>
        <form onSubmit={submit} className="space-y-5">
          {register && <label className="block text-xs text-zinc-300">怎么称呼你<input name="nickname" autoComplete="nickname" required maxLength={30} placeholder="输入昵称" className={`${inputClass} mt-2`} disabled={busy} /></label>}
          <label className="block text-xs text-zinc-300">邮箱地址<input name="email" type="email" autoComplete="username" required maxLength={254} placeholder="you@example.com" className={`${inputClass} mt-2`} disabled={busy} /></label>
          <label className="block text-xs text-zinc-300">密码<span className="relative mt-2 block"><input name="password" type={visible ? "text" : "password"} autoComplete={register ? "new-password" : "current-password"} required minLength={10} maxLength={128} placeholder={register ? "至少 10 个字符" : "输入你的密码"} className={`${inputClass} pr-12`} disabled={busy} /><button type="button" aria-label={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)} className="absolute right-4 top-4 text-zinc-500 hover:text-zinc-200">{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>
          {register && <label className="block text-xs text-zinc-300">确认密码<input name="confirm" type={visible ? "text" : "password"} autoComplete="new-password" required minLength={10} maxLength={128} placeholder="再次输入密码" className={`${inputClass} mt-2`} disabled={busy} /></label>}
          {error && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-300">{error}</p>}
          <button type="submit" disabled={busy} className="flex w-full items-center justify-center gap-3 rounded-xl bg-blue-500 px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-blue-400 disabled:cursor-wait disabled:opacity-60">{busy ? <><LoaderCircle size={17} className="animate-spin" />正在处理</> : <>{register ? "创建账号并进入工作室" : "登录工作室"}<ArrowRight size={17} /></>}</button>
        </form>
        <p className="mt-7 text-center text-sm text-zinc-500">{register ? "已经有账号？" : "还没有账号？"}<Link href={register ? "/login" : "/register"} className="ml-2 text-blue-300 hover:text-blue-200">{register ? "前往登录" : "免费注册"}</Link></p>
        <p className="mt-10 border-t border-white/[0.07] pt-5 text-center text-xs leading-6 text-zinc-600">{register ? "请妥善保存密码。当前版本暂不提供邮件找回。" : "在这台电脑上保持登录。共用电脑使用后请退出。"}</p>
      </section>
    </div>
  );
}
