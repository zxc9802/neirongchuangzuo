import { NextRequest } from "next/server";
import { canAccessTask, resolveAccessContext, unauthorizedResponse, taskNotFoundResponse } from "@/lib/access-control";
import { MotionStore } from "@/lib/motion/store";
import { isOwnedUploadSource } from "@/lib/server/upload-policy";
import { isTrustedTaskOutputSource, servePrivateMedia } from "@/lib/server/media-response";
export const runtime = "nodejs";
export async function GET(req: NextRequest, {params}: {params: Promise<{id: string; kind: string}>}) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) return unauthorizedResponse();
  const {id, kind} = await params, project = await MotionStore.get(id);
  if (!project || !canAccessTask(access, project)) return taskNotFoundResponse();
  if (kind === "source" && isOwnedUploadSource({source: project.source, userId: project.userId, folder: "videos"})) return servePrivateMedia(req, project.source, {contentType: "video/mp4"});
  if (kind === "final" && project.status === "completed" && isTrustedTaskOutputSource(project.output, id, ["final.mp4"])) {
    return servePrivateMedia(req, project.output, {contentType: "video/mp4", downloadName: req.nextUrl.searchParams.has("download") ? "digital-human-motion.mp4" : undefined});
  }
  return taskNotFoundResponse();
}
