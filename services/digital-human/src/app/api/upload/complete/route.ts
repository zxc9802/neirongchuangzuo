import { NextRequest, NextResponse } from "next/server";
import { resolveAccessContext, unauthorizedResponse } from "@/lib/access-control";
import { CosService } from "@/lib/cos";
import { logServerError } from "@/lib/server/safe-log";
import { getPendingUpload, markPendingUploadStored } from "@/lib/server/upload-policy";

export async function POST(req: NextRequest) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) return unauthorizedResponse();
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "上传参数无效" }, { status: 400 }); }
  if (typeof body?.uploadKey !== "string") return NextResponse.json({ error: "上传参数无效" }, { status: 400 });
  const pending = getPendingUpload(body.uploadKey, access.userId);
  if (!pending?.multipartUploadId) return NextResponse.json({ error: "上传凭证无效或已过期" }, { status: 404 });
  try {
    const complete = await CosService.completeDirectUpload(pending.key, pending.multipartUploadId, pending.bytes);
    if (!complete) return NextResponse.json({ error: "视频或音频分段尚未上传完整，请重试" }, { status: 409 });
    if (!markPendingUploadStored(pending.key)) {
      return NextResponse.json({ error: "上传凭证已过期或已使用" }, { status: 409 });
    }
    return NextResponse.json({ success: true, uploadKey: pending.key, storedRemotely: true }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logServerError("upload.complete_failed", error);
    return NextResponse.json({ error: "上传确认暂时失败，请稍后重试" }, { status: 503 });
  }
}
