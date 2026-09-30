import { NextRequest } from "next/server";
import { TaskStore } from "@/lib/store/task-store";
import { isTrustedTaskOutputSource, servePrivateMedia } from "@/lib/server/media-response";
import { isOwnedUploadSource } from "@/lib/server/upload-policy";
import { AvatarStore } from "@/lib/store/avatar-store";
import { isTaskOutputDeliverable } from "@/lib/server/public-data";
import {
  canAccessTask,
  resolveAccessContext,
  taskNotFoundResponse,
  unauthorizedResponse,
} from "@/lib/access-control";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; kind: string }> }
) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) return unauthorizedResponse();

  const { id, kind } = await params;
  const task = await TaskStore.getAsync(id);
  if (!task || !canAccessTask(access, task)) return taskNotFoundResponse();

  if (kind === "original") {
    const source = task.results.originalVideoUrl || task.inputs.videoPath || task.inputs.videoUrl;
    const avatar = task.inputs.avatarId ? AvatarStore.get(task.inputs.avatarId) : null;
    if (
      !isOwnedUploadSource({
        source,
        userId: avatar?.userId || task.userId,
        folder: "videos",
      })
    ) {
      return taskNotFoundResponse();
    }
    return servePrivateMedia(
      req,
      source,
      { contentType: "video/mp4" }
    );
  }
  if (kind === "final") {
    if (!isTaskOutputDeliverable(task)) return taskNotFoundResponse();
    if (!isTrustedTaskOutputSource(task.results.finalVideoUrl, id, ["final.mp4"])) {
      return taskNotFoundResponse();
    }
    return servePrivateMedia(req, task.results.finalVideoUrl, { contentType: "video/mp4" });
  }
  if (kind === "voice") {
    if (!isTaskOutputDeliverable(task)) return taskNotFoundResponse();
    const isMp3 = task.results.audioFormat === "mp3";
    const filenames = isMp3 ? ["voice-track.mp3"] : ["voice-track.wav", "exact-final-indextts.wav"];
    if (!isTrustedTaskOutputSource(task.results.exactAudioUrl, id, filenames)) {
      return taskNotFoundResponse();
    }
    return servePrivateMedia(req, task.results.exactAudioUrl, { contentType: isMp3 ? "audio/mpeg" : "audio/wav" });
  }
  return new Response("Media not found", { status: 404 });
}
