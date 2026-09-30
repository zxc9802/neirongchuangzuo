import { NextRequest } from "next/server";
import { TaskStore, TaskItem } from "@/lib/store/task-store";
import { toPublicTask } from "@/lib/server/public-data";
import {
  canAccessTask,
  resolveAccessContext,
  taskNotFoundResponse,
  unauthorizedResponse,
} from "@/lib/access-control";
import { acquireTaskStreamSlot } from "@/lib/server/task-stream-limiter";

const STREAM_MAX_LIFETIME_MS = 5 * 60_000;
const HEARTBEAT_MS = 15_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) {
    return unauthorizedResponse();
  }

  const { id } = await params;
  const task = TaskStore.get(id);

  if (!task || !canAccessTask(access, task)) {
    return taskNotFoundResponse();
  }

  const releaseSlot = acquireTaskStreamSlot(access.userId || "local", id);
  if (!releaseSlot) {
    return new Response("Too many event streams", {
      status: 429,
      headers: { "Retry-After": "5", "Cache-Control": "no-store" },
    });
  }

  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (lifetimeTimer) clearTimeout(lifetimeTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        releaseSlot();
        try { controller.close(); } catch {}
      };

      // Send initial state
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(toPublicTask(task))}\n\n`)
      );
      if (task.status === "completed" || task.status === "failed") {
        cleanup();
        return;
      }

      unsubscribe = TaskStore.subscribe(id, (updatedTask: TaskItem) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(toPublicTask(updatedTask))}\n\n`)
          );
        } catch {
          cleanup?.();
          return;
        }
        if (updatedTask.status === "completed" || updatedTask.status === "failed") {
          cleanup?.();
        }
      });

      heartbeatTimer = setInterval(() => {
        if (!closed) {
          try { controller.enqueue(encoder.encode(": heartbeat\n\n")); }
          catch { cleanup?.(); }
        }
      }, HEARTBEAT_MS);
      lifetimeTimer = setTimeout(() => cleanup?.(), STREAM_MAX_LIFETIME_MS);

      req.signal.addEventListener("abort", () => cleanup?.(), { once: true });
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
