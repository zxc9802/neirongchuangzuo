import { NextRequest, NextResponse } from "next/server";
import { AvatarStore, type AvatarItem } from "@/lib/store/avatar-store";
import { TaskStore, type TaskItem } from "@/lib/store/task-store";
import { toPublicAvatar, toPublicTask } from "@/lib/server/public-data";
import {
  canManageMediaItem,
  canViewAllMedia,
  resolveAccessContext,
  unauthorizedResponse,
} from "@/lib/access-control";
import {
  compareLibraryItems,
  LibraryQueryError,
  paginateLibrary,
  parseLibraryQuery,
  type LibraryItemKey,
} from "@/lib/server/digital-human-library";

type StoredLibraryItem = LibraryItemKey & (
  { kind: "avatar"; avatar: AvatarItem } | { kind: "task"; task: TaskItem }
);

export async function GET(req: NextRequest) {
  try {
    const access = await resolveAccessContext(req);
    if (access.isolated && !access.userId) return unauthorizedResponse();
    const query = parseLibraryQuery(new URL(req.url).searchParams);
    const [avatars, tasks] = await Promise.all([
      AvatarStore.getAllAsync(access.isAdmin ? access.userId || undefined : undefined),
      TaskStore.getAllAsync(),
    ]);
    // Keep these policies aligned with the existing avatar and task list endpoints.
    const visibleAvatars = canViewAllMedia(access)
      ? avatars : avatars.filter(avatar => avatar.userId === access.userId);
    const visibleTasks = access.isolated && !access.isAdmin
      ? tasks.filter(task => task.userId === access.userId) : tasks;
    const records: StoredLibraryItem[] = [
      ...visibleAvatars.map(avatar => ({
        kind: "avatar" as const, id: avatar.id, createdAt: avatar.createdAt, avatar,
      })),
      ...visibleTasks.map(task => ({
        kind: "task" as const, id: task.id, createdAt: task.createdAt, task,
      })),
    ];
    const page = paginateLibrary(records, query);
    const selectedAvatar = visibleAvatars.find(avatar => avatar.id === query.avatarId);
    const selectedTask = visibleTasks.find(task => task.id === query.taskId);
    const publicAvatar = (avatar: AvatarItem) => toPublicAvatar(avatar, canManageMediaItem(access, avatar));
    return NextResponse.json({
      ...page,
      items: page.items.map(item => ({
        kind: item.kind, id: item.id, createdAt: item.createdAt,
        ...(item.kind === "avatar" ? { avatar: publicAvatar(item.avatar) } : { task: toPublicTask(item.task) }),
      })),
      selection: {
        ...(selectedAvatar ? { avatar: publicAvatar(selectedAvatar) } : {}),
        ...(selectedTask ? { task: toPublicTask(selectedTask) } : {}),
      },
      activeTasks: visibleTasks
        .filter(task => task.status === "pending" || task.status === "processing")
        .sort((a, b) => compareLibraryItems({ ...a, kind: "task" }, { ...b, kind: "task" }))
        .map(toPublicTask),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof LibraryQueryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "素材与成品加载失败，请稍后重试" }, { status: 500 });
  }
}
