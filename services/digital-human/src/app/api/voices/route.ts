import crypto from "crypto";
import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { VoiceStore } from "@/lib/store/voice-store";
import { CosService } from "@/lib/cos";
import { extractAudioFromMedia } from "@/lib/engine/ffmpeg";
import { toPublicVoice } from "@/lib/server/public-data";
import { downloadTrustedMediaToFile } from "@/lib/server/media-response";
import {
  localUploadPath,
  ownerKeyFor,
  resolveOwnedUpload,
  deleteOwnedUploadSource,
  claimPendingUpload,
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

    const voices = await VoiceStore.getAllAsync();
    const visibleVoices = (canViewAllMedia(access)
      ? voices
      : voices.filter((voice) => voice.isDefault || voice.userId === access.userId)
    ).map((voice) =>
      toPublicVoice(voice, !voice.isDefault && canManageMediaItem(access, voice))
    );
    return NextResponse.json({ success: true, voices: visibleVoices });
  } catch {
    return NextResponse.json({ error: "声音库加载失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let derivedAudioSource = "";
  let derivedUserId: string | null = null;
  try {
    const access = await resolveAccessContext(req);
    if (access.isolated && !access.userId) return unauthorizedResponse();

    const body = await req.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) {
      return NextResponse.json({ error: "音色名称无效" }, { status: 400 });
    }

    const uploaded = await resolveOwnedUpload({
      key: body.uploadKey,
      userId: access.userId,
      folder: "voices",
    });
    if (!uploaded) {
      return NextResponse.json({ error: "声音上传凭证无效" }, { status: 400 });
    }

    let audioSource = uploaded.source;
    let audioPath = uploaded.localPath || "";
    let storedRemotely = uploaded.storedRemotely;
    const ext = path.extname(uploaded.key).toLowerCase();

    if (ext === ".mp4" || ext === ".mov") {
      const processingDir = path.join(process.cwd(), ".runtime", "voice-processing");
      fs.mkdirSync(processingDir, { recursive: true });
      const sourcePath = path.join(processingDir, `${crypto.randomUUID()}${ext}`);
      const outputKey = `uploads/users/${ownerKeyFor(access.userId)}/voices/${crypto.randomUUID()}.mp3`;
      const outputPath = localUploadPath(outputKey);
      derivedAudioSource = outputPath;
      derivedUserId = access.userId;
      try {
        await downloadTrustedMediaToFile({
          source: uploaded.localPath || uploaded.source,
          outputPath: sourcePath,
          maxBytes: 50 * 1024 * 1024,
        });
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        await extractAudioFromMedia(sourcePath, outputPath);
      } finally {
        try { fs.unlinkSync(sourcePath); } catch {}
      }

      if (CosService.isConfigured()) {
        await CosService.uploadFile(outputPath, outputKey);
        audioSource = CosService.getPublicUrl(outputKey);
        derivedAudioSource = audioSource;
        audioPath = "";
        storedRemotely = true;
        try { fs.unlinkSync(outputPath); } catch {}
      } else {
        audioSource = outputPath;
        audioPath = outputPath;
        storedRemotely = false;
      }
      await deleteOwnedUploadSource({
        source: uploaded.localPath || uploaded.source,
        userId: access.userId,
        folder: "voices",
      });
    }

    const created = VoiceStore.create({
      userId: access.userId || undefined,
      name,
      description:
        typeof body.description === "string" && body.description.trim()
          ? body.description.trim().slice(0, 200)
          : "用户自定义原声音频",
      audioUrl: audioSource,
      audioPath,
      isDefault: false,
    });
    if (!claimPendingUpload({ key: body.uploadKey, userId: access.userId })) {
      VoiceStore.delete(created.id);
      // A duplicate request can reference audio already owned by the first voice.
      // Only the converted file created by this invocation may be removed.
      if (derivedAudioSource) {
        await deleteOwnedUploadSource({
          source: derivedAudioSource,
          userId: access.userId,
          folder: "voices",
        });
      }
      return NextResponse.json({ error: "上传凭证已过期或已被使用" }, { status: 409 });
    }
    derivedAudioSource = "";

    return NextResponse.json({
      success: true,
      voice: toPublicVoice(created, true),
      storedRemotely,
      extractedFromVideo: ext === ".mp4" || ext === ".mov",
    });
  } catch {
    if (derivedAudioSource) {
      await deleteOwnedUploadSource({
        source: derivedAudioSource,
        userId: derivedUserId,
        folder: "voices",
      }).catch(() => undefined);
    }
    return NextResponse.json({ error: "创建音色失败" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const access = await resolveAccessContext(req);
    if (access.isolated && !access.userId) return unauthorizedResponse();

    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID 必填" }, { status: 400 });
    const voice = VoiceStore.get(id);
    if (!voice || !canManageMediaItem(access, voice)) return mediaNotFoundResponse();

    await deleteOwnedUploadSource({
      source: voice.audioPath || voice.audioUrl,
      userId: voice.userId,
      folder: "voices",
    });
    VoiceStore.delete(id);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "删除音色失败" }, { status: 400 });
  }
}
