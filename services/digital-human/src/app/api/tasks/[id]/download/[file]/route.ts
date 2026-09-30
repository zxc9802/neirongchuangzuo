import { NextRequest, NextResponse } from "next/server";
import { TaskStore } from "@/lib/store/task-store";
import { isTrustedTaskOutputSource, servePrivateMedia } from "@/lib/server/media-response";
import { isTaskOutputDeliverable, toPublicTask } from "@/lib/server/public-data";
import {
  canAccessTask,
  resolveAccessContext,
  taskNotFoundResponse,
  unauthorizedResponse,
} from "@/lib/access-control";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; file: string }> }
) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) {
    return unauthorizedResponse();
  }

  const { id, file } = await params;
  const task = await TaskStore.getAsync(id);
  if (!task || !canAccessTask(access, task)) {
    return taskNotFoundResponse();
  }
  if (file !== "production-report.json" && !isTaskOutputDeliverable(task)) {
    return taskNotFoundResponse();
  }

  if (file === "final.mp4") {
    if (!isTrustedTaskOutputSource(task.results.finalVideoUrl, id, ["final.mp4"])) {
      return taskNotFoundResponse();
    }
    return servePrivateMedia(req, task.results.finalVideoUrl, {
      contentType: "video/mp4",
      downloadName: "digital-human-video.mp4",
    });
  }
  if (file === "voice-track.wav") {
    if (!isTrustedTaskOutputSource(task.results.exactAudioUrl, id, ["voice-track.wav", "exact-final-indextts.wav"])) {
      return taskNotFoundResponse();
    }
    return servePrivateMedia(req, task.results.exactAudioUrl, {
      contentType: "audio/wav",
      downloadName: "voice-track.wav",
    });
  }
  if (file === "voice-track.mp3") {
    if (!isTrustedTaskOutputSource(task.results.exactAudioUrl, id, ["voice-track.mp3"])) {
      return taskNotFoundResponse();
    }
    return servePrivateMedia(req, task.results.exactAudioUrl, {
      contentType: "audio/mpeg",
      downloadName: "voice-track.mp3",
    });
  }
  if (file === "production-report.json") {
    if (!isTaskOutputDeliverable(task)) return taskNotFoundResponse();
    const publicTask = toPublicTask(task);
    return NextResponse.json(
      {
        taskId: publicTask.id,
        createdAt: new Date(publicTask.createdAt).toISOString(),
        completedAt:
          publicTask.status === "completed"
            ? new Date(publicTask.completedAt ?? publicTask.updatedAt).toISOString()
            : undefined,
        status: publicTask.status,
        media: {
          videoDuration: publicTask.results.videoDuration,
          audioDuration: publicTask.results.audioDuration,
          resolution: publicTask.results.resolution,
          fps: publicTask.results.fps,
          videoSha256: publicTask.results.sha256Video,
          audioSha256: publicTask.results.sha256Audio,
        },
      },
      {
        headers: {
          "Content-Disposition": 'attachment; filename="production-report.json"',
          "Cache-Control": "private, no-store",
        },
      }
    );
  }
  return new NextResponse("File not found", { status: 404 });
}
