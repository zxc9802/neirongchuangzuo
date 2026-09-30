import crypto from "crypto";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccessContext, unauthorizedResponse } from "@/lib/access-control";
import { CosService } from "@/lib/cos";
import { logServerError } from "@/lib/server/safe-log";
import {
  type UploadFolder, validateUploadDescriptor, ownerKeyFor, consumeUploadGrantBudget,
  reservePendingUpload, setPendingMultipartUpload, cancelPendingUpload,
  cleanupExpiredPendingUploads, cleanupPendingOwnedUploadDeletions,
} from "@/lib/server/upload-policy";

export async function POST(req: NextRequest) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) return unauthorizedResponse();
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "上传参数无效" }, { status: 400 }); }
  const { folder, fileName, fileSize, contentType } = body || {};
  if (!["videos", "voices", "thumbnails"].includes(folder) || typeof fileName !== "string" ||
      typeof contentType !== "string" || !Number.isSafeInteger(fileSize)) {
    return NextResponse.json({ error: "上传参数无效" }, { status: 400 });
  }
  const validationError = validateUploadDescriptor({ folder, fileName, fileSize, contentType });
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
  if (!CosService.isConfigured()) return NextResponse.json({ direct: false });
  if (!consumeUploadGrantBudget(access.userId, fileSize)) {
    return NextResponse.json({ error: "上传频率或容量超过当前时间窗限制" }, { status: 429 });
  }
  let uploadKey = "";
  let uploadId = "";
  try {
    await cleanupExpiredPendingUploads();
    await cleanupPendingOwnedUploadDeletions().catch(() => undefined);
    uploadKey = `uploads/users/${ownerKeyFor(access.userId)}/${folder}/${crypto.randomUUID()}${path.extname(fileName).toLowerCase()}`;
    if (!reservePendingUpload({ key: uploadKey, userId: access.userId, folder: folder as UploadFolder, bytes: fileSize })) {
      return NextResponse.json({ error: "待认领上传容量已满" }, { status: 429 });
    }
    const direct = await CosService.createDirectUpload(uploadKey, fileSize, contentType);
    uploadId = direct.uploadId;
    if (!setPendingMultipartUpload(uploadKey, uploadId)) throw new Error("上传凭证未能保存");
    return NextResponse.json({ direct: true, uploadKey, parts: direct.parts }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (uploadId) await CosService.abortDirectUpload(uploadKey, uploadId).catch(() => undefined);
    if (uploadKey) cancelPendingUpload(uploadKey);
    logServerError("upload.prepare_failed", error);
    return NextResponse.json({ error: "暂时无法准备上传，请稍后重试" }, { status: 503 });
  }
}
