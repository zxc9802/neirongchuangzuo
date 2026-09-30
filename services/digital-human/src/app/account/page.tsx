"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound } from "lucide-react";

export default function AccountPage() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSuccess(false);
    if (data.get("password") !== data.get("confirm")) { setMessage("两次输入的新密码不一致"); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: data.get("currentPassword"), password: data.get("password") }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "修改失败，请重试");
      setSuccess(true); setMessage("密码已更新，其他设备已退出登录。"); form.reset();
    } catch (error) { setMessage(error instanceof Error ? error.message : "连接失败，请重试"); }
    finally { setBusy(false); }
  }
  return <section className="mx-auto max-w-md py-8">
    <Link href="/" className="mb-8 inline-flex items-center gap-2 text-sm text-zinc-400"><ArrowLeft size={16} />返回工作室</Link>
    <KeyRound className="mb-5 text-blue-400" size={28} /><h1 className="text-2xl font-semibold">账号安全</h1><p className="mb-8 mt-3 text-sm text-zinc-400">修改密码后，其他设备需要重新登录。</p>
    <form onSubmit={submit} className="space-y-5">
      {[["currentPassword", "当前密码"], ["password", "新密码"], ["confirm", "确认新密码"]].map(([name, label]) => <label key={name} className="block text-sm text-zinc-300">{label}<input name={name} type="password" autoComplete={name === "currentPassword" ? "current-password" : "new-password"} minLength={10} maxLength={128} required disabled={busy} placeholder="10–128 个字符" className="mt-2 w-full rounded-xl border border-white/10 bg-zinc-900 px-4 py-3 outline-none focus:border-blue-400" /></label>)}
      {message && <p role={success ? "status" : "alert"} className={`text-sm ${success ? "text-emerald-300" : "text-red-300"}`}>{message}</p>}
      <button disabled={busy} className="w-full rounded-xl bg-blue-500 py-3 text-sm font-semibold disabled:opacity-50">{busy ? "正在更新…" : "更新密码"}</button>
    </form>
  </section>;
}
