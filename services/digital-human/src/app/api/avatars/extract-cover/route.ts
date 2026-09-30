import { logServerError } from "@/lib/server/safe-log";
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { extractVideoThumbnail } from "@/lib/engine/ffmpeg";
import { CosService } from "@/lib/cos";
import { AvatarStore } from "@/lib/store/avatar-store";
import { getTrustedExternalMediaUrl, isTrustedStoredMediaSource } from "@/lib/server/media-response";
import {
  cleanupPendingOwnedUploadDeletions,
  deleteOwnedUploadSourceEventually,
  isOwnedUploadSource,
  localUploadPath,
  ownerKeyFor,
} from "@/lib/server/upload-policy";
import { acquireCoverExtractionSlot } from "@/lib/server/cover-extraction-limiter";
import { toPublicAvatar } from "@/lib/server/public-data";
import {
  canManageMediaItem,
  mediaNotFoundResponse,
  resolveAccessContext,
  unauthorizedResponse,
} from "@/lib/access-control";

export async function POST(req: NextRequest) {
  let releaseSlot: (() => void) | null = null;
  let newCoverSource = "";
  let thumbPath = "";
  let cleanupUserId: string | undefined;
  try {
    await cleanupPendingOwnedUploadDeletions().catch(() => undefined);
    const access = await resolveAccessContext(req);
    if (access.isolated && !access.userId) return unauthorizedResponse();

    const body = await req.json();
    const { id, timestamp = 1.0, onlyIfMissing = false } = body;

    if (!id) {
      return NextResponse.json({ error: "缺少形象素材 ID" }, { status: 400 });
    }

    const avatar = AvatarStore.get(id);
    if (!avatar || !canManageMediaItem(access, avatar)) return mediaNotFoundResponse();
    if (onlyIfMissing && avatar.coverUrl) {
      return NextResponse.json({ success: true, coverUrl: toPublicAvatar(avatar, true).coverUrl });
    }
    cleanupUserId = avatar.userId;
    releaseSlot = acquireCoverExtractionSlot(avatar.userId || access.userId || "local");
    if (!releaseSlot) {
      return NextResponse.json(
        { error: "封面截取请求过于频繁，请稍后重试" },
        { status: 429, headers: { "Retry-After": "10" } },
      );
    }

    const storedVideoSrc = (avatar.videoPath && fs.existsSync(avatar.videoPath))
      ? avatar.videoPath
      : avatar.videoUrl;

    if (
      !storedVideoSrc ||
      !isOwnedUploadSource({ source: storedVideoSrc, userId: avatar.userId, folder: "videos" }) ||
      !(await isTrustedStoredMediaSource(storedVideoSrc))
    ) {
      return NextResponse.json({ error: "该形象素材无有效视频路径或链接" }, { status: 400 });
    }
    const videoSrc = avatar.videoPath && fs.existsSync(avatar.videoPath)
      ? avatar.videoPath
      : await getTrustedExternalMediaUrl(storedVideoSrc);

    const ownerKey = ownerKeyFor(avatar.userId);
    const thumbFileName = `${crypto.randomUUID()}.jpg`;
    const cosThumbKey = `uploads/users/${ownerKey}/thumbnails/${thumbFileName}`;
    thumbPath = localUploadPath(cosThumbKey);
    fs.mkdirSync(path.dirname(thumbPath), { recursive: true });

    // Extract frame with FFmpeg
    await extractVideoThumbnail(
      videoSrc,
      thumbPath,
      Math.max(0, Math.min(Number(timestamp) || 1, 6 * 60 * 60))
    );

    if (!fs.existsSync(thumbPath) || fs.statSync(thumbPath).size < 500) {
      throw new Error("封面截取失败，未生成有效画面");
    }

    let coverUrl = thumbPath;

    // Upload to cloud object storage if configured
    if (CosService.isConfigured()) {
      try {
        await CosService.uploadFile(thumbPath, cosThumbKey);
        coverUrl = CosService.getPublicUrl(cosThumbKey);
        try { fs.unlinkSync(thumbPath); } catch {}
      } catch (cosErr: any) {
        await CosService.deleteObject(cosThumbKey).catch(() => undefined);
        logServerError("cover.upload_failed", cosErr, "warn");
      }
    }

    // Update avatar store
    newCoverSource = coverUrl;
    const updated = AvatarStore.update(id, { coverUrl });
    if (!updated) throw new Error("形象已不存在，无法更新封面");
    if (avatar.coverUrl && avatar.coverUrl !== coverUrl) {
      await deleteOwnedUploadSourceEventually({
        source: avatar.coverUrl,
        userId: avatar.userId,
        folder: "thumbnails",
      });
    }

    return NextResponse.json({
      success: true,
      coverUrl: toPublicAvatar(updated, true).coverUrl,
      avatar: toPublicAvatar(updated, true),
    });
  } catch (err: any) {
    if (newCoverSource) {
      await deleteOwnedUploadSourceEventually({
        source: newCoverSource,
        userId: cleanupUserId,
        folder: "thumbnails",
      });
    } else if (thumbPath) {
      try { fs.unlinkSync(thumbPath); } catch {}
    }
    logServerError("cover.extract_failed", err);
    return NextResponse.json(
      { error: "截取封面异常" },
      { status: 500 }
    );
  } finally {
    releaseSlot?.();
  }
}
