"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Film } from "lucide-react";
import type { PublicAvatarItem } from "@/lib/public-contract";
import { ensureAvatarCover } from "@/lib/client-video-preview";

export default function AvatarCover({ avatar, className, fallback }: {
  avatar: PublicAvatarItem;
  className?: string;
  fallback?: ReactNode;
}) {
  const [coverUrl, setCoverUrl] = useState(avatar.coverUrl || "");
  const [failed, setFailed] = useState(false);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    let active = true;
    setCoverUrl(avatar.coverUrl || "");
    setFailed(false);
    setRecovering(false);
    if (!avatar.coverUrl && avatar.canManage !== false) {
      setRecovering(true);
      ensureAvatarCover(avatar.id).then(url => {
        if (!active) return;
        if (url) setCoverUrl(url);
        setRecovering(false);
      });
    }
    return () => { active = false; };
  }, [avatar.id, avatar.coverUrl, avatar.canManage]);

  return (
    <div className={className}>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-zinc-900 text-zinc-500">
        <Film className="h-5 w-5" />
        {(!coverUrl || failed) && <span className="text-[9px]">{recovering ? "正在生成封面" : "暂无封面"}</span>}
      </div>
      {(!coverUrl || failed) && !recovering && fallback}
      {coverUrl && !failed && (
        <img
          src={coverUrl}
          alt={avatar.name}
          decoding="async"
          onError={() => setFailed(true)}
          className="relative h-full w-full object-cover"
        />
      )}
    </div>
  );
}
