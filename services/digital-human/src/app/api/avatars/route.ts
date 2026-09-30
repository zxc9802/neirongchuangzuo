import { NextRequest, NextResponse } from "next/server";
import { AvatarStore } from "@/lib/store/avatar-store";
import { toPublicAvatar } from "@/lib/server/public-data";
import {
  claimPendingUploads,
  deleteOwnedUploadSource,
  resolveOwnedUpload,
} from "@/lib/server/upload-policy";
import {
  canManageMediaItem,
  canViewAllMedia,
  mediaNotFoundResponse,
  resolveAccessContext,
  unauthorizedResponse,
} from "@/lib/access-control";

export async function GET(req: NextRequest) {
  try {
    const access = await resolveAccessContext(req);
    if (access.isolated && !access.userId) return unauthorizedResponse();

    const avatars = await AvatarStore.getAllAsync(
      access.isAdmin ? access.userId || undefined : undefined,
    );
    const visibleAvatars = (canViewAllMedia(access)
      ? avatars
      : avatars.filter((avatar) => avatar.userId === access.userId)
    ).map((avatar) =>
      toPublicAvatar(avatar, canManageMediaItem(access, avatar))
    );

    return NextResponse.json({ success: true, avatars: visibleAvatars });
  } catch (err: any) {
    return NextResponse.json({ error: "形象库加载失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const access = await resolveAccessContext(req);
    if (access.isolated && !access.userId) return unauthorizedResponse();

    const body = await req.json();
    const { name, uploadKey, coverKey, durationSeconds, width, height, fps, fileSize } = body;

    const video = await resolveOwnedUpload({
      key: uploadKey,
      userId: access.userId,
      folder: "videos",
    });
    if (!video) {
      return NextResponse.json({ error: "视频上传凭证无效" }, { status: 400 });
    }
    const cover = coverKey
      ? await resolveOwnedUpload({
          key: coverKey,
          userId: access.userId,
          folder: "thumbnails",
        })
      : null;
    if (coverKey && !cover) {
      return NextResponse.json({ error: "封面上传凭证无效" }, { status: 400 });
    }

    const created = AvatarStore.create({
      userId: access.userId || undefined,
      name: name?.trim() || "未命名口播形象",
      videoUrl: video.source,
      videoPath: video.localPath || "",
      coverUrl: cover?.source || "",
      durationSeconds: Math.max(0, Math.min(Number(durationSeconds) || 0, 6 * 60 * 60)),
      width: Math.max(1, Math.min(Number(width) || 1080, 8192)),
      height: Math.max(1, Math.min(Number(height) || 1920, 8192)),
      fps: Math.max(1, Math.min(Number(fps) || 30, 240)),
      fileSize: video.size,
      isCos: video.storedRemotely,
    });
    if (!claimPendingUploads({
      keys: [uploadKey, ...(coverKey ? [coverKey] : [])],
      userId: access.userId,
    })) {
      AvatarStore.delete(created.id);
      return NextResponse.json({ error: "上传凭证已过期或已被使用" }, { status: 409 });
    }

    return NextResponse.json({
      success: true,
      avatar: toPublicAvatar(created, true),
    });
  } catch (err: any) {
    return NextResponse.json({ error: "创建形象失败" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const access = await resolveAccessContext(req);
    if (access.isolated && !access.userId) return unauthorizedResponse();

    const body = await req.json();
    const { id, name } = body;
    if (!id) {
      return NextResponse.json({ error: "ID 必填" }, { status: 400 });
    }

    const avatar = AvatarStore.get(id);
    if (!avatar || !canManageMediaItem(access, avatar)) return mediaNotFoundResponse();

    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) {
      return NextResponse.json({ error: "形象名称无效" }, { status: 400 });
    }

    const updated = AvatarStore.update(id, { name: name.trim() });
    if (!updated) return mediaNotFoundResponse();

    return NextResponse.json({
      success: true,
      avatar: toPublicAvatar(updated, true),
    });
  } catch (err: any) {
    return NextResponse.json({ error: "更新形象失败" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const access = await resolveAccessContext(req);
    if (access.isolated && !access.userId) return unauthorizedResponse();

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "ID 必填" }, { status: 400 });
    }
    const avatar = AvatarStore.get(id);
    if (!avatar || !canManageMediaItem(access, avatar)) return mediaNotFoundResponse();

    await Promise.all([
      deleteOwnedUploadSource({ source: avatar.videoPath || avatar.videoUrl, userId: avatar.userId, folder: "videos" }),
      deleteOwnedUploadSource({ source: avatar.coverUrl, userId: avatar.userId, folder: "thumbnails" }),
    ]);
    AvatarStore.delete(id);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: "删除形象失败" }, { status: 400 });
  }
}
