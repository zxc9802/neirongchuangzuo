import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { NextRequest, NextResponse } from "next/server";
import { CosService } from "@/lib/cos";
import {
  localUploadPath,
  ownerKeyFor,
  consumeUploadGrantBudget,
  reservePendingUpload,
  markPendingUploadStored,
  cancelPendingUpload,
  cleanupExpiredPendingUploads,
  cleanupPendingOwnedUploadDeletions,
  type UploadFolder,
  validateUploadDescriptor,
} from "@/lib/server/upload-policy";
import { resolveAccessContext, unauthorizedResponse } from "@/lib/access-control";
import { logServerError } from "@/lib/server/safe-log";

const ALLOWED_FOLDERS = new Set<UploadFolder>(["videos", "voices", "thumbnails"]);
class UploadContentError extends Error {}

export async function POST(req: NextRequest) {
  let outputPath = "";
  let uploadKey = "";
  try {
    const access = await resolveAccessContext(req);
    if (access.isolated && !access.userId) return unauthorizedResponse();

    const folderValue = req.nextUrl.searchParams.get("folder") || "videos";
    const fileName = req.nextUrl.searchParams.get("fileName") || "";
    const contentType = req.headers.get("content-type") || "application/octet-stream";
    const fileSize = Number(req.headers.get("content-length") || 0);
    if (!ALLOWED_FOLDERS.has(folderValue as UploadFolder)) {
      return NextResponse.json({ error: "上传参数无效" }, { status: 400 });
    }
    if (!fileSize) {
      return NextResponse.json({ error: "Content-Length 必填" }, { status: 411 });
    }
    const folder = folderValue as UploadFolder;
    const validationError = validateUploadDescriptor({
      folder,
      fileName,
      contentType,
      fileSize,
    });
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
    if (!consumeUploadGrantBudget(access.userId, fileSize)) {
      return NextResponse.json({ error: "上传频率或容量超过当前时间窗限制" }, { status: 429 });
    }
    await cleanupExpiredPendingUploads();
    await cleanupPendingOwnedUploadDeletions().catch(() => undefined);
    if (!req.body) {
      return NextResponse.json({ error: "上传内容为空" }, { status: 400 });
    }

    const safeName = `${crypto.randomUUID()}${path.extname(fileName).toLowerCase()}`;
    uploadKey = `uploads/users/${ownerKeyFor(access.userId)}/${folder}/${safeName}`;
    if (!reservePendingUpload({
      key: uploadKey,
      userId: access.userId,
      folder,
      bytes: fileSize,
    })) {
      return NextResponse.json({ error: "待认领上传容量已满" }, { status: 429 });
    }
    outputPath = localUploadPath(uploadKey);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received > fileSize ? new UploadContentError("上传文件大小不一致，请重新上传") : null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(req.body as never),
      limiter,
      fs.createWriteStream(outputPath)
    );
    if (received !== fileSize) {
      throw new UploadContentError("上传未完成，文件内容不完整，请重新上传");
    }

    let storedRemotely = false;
    if (CosService.isConfigured()) {
      await CosService.uploadFile(outputPath, uploadKey);
      storedRemotely = true;
      try { fs.unlinkSync(outputPath); } catch {}
    }

    if (!markPendingUploadStored(uploadKey)) {
      throw new Error("上传记录未能持久化");
    }

    return NextResponse.json({ success: true, uploadKey, storedRemotely });
  } catch (error) {
    if (uploadKey) {
      cancelPendingUpload(uploadKey);
      try { await CosService.deleteObject(uploadKey); } catch {}
    }
    if (outputPath) {
      try { fs.unlinkSync(outputPath); } catch {}
    }
    if (error instanceof UploadContentError) {
      return NextResponse.json({ error: error.message, code: "UPLOAD_CONTENT_MISMATCH" }, { status: 400 });
    }
    logServerError("upload.receive", error);
    return NextResponse.json({ error: "服务器未能保存上传文件，请稍后重试" }, { status: 500 });
  }
}
