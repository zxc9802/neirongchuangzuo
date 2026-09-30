export type LibraryKind = "all" | "avatars" | "tasks";

export interface LibraryItemKey {
  kind: "avatar" | "task";
  id: string;
  createdAt: number;
}

interface LibraryCursor extends LibraryItemKey {
  v: 1;
  filter: LibraryKind;
}

export interface LibraryQuery {
  kind: LibraryKind;
  limit: number;
  cursor: LibraryCursor | null;
  avatarId?: string;
  taskId?: string;
}

export class LibraryQueryError extends Error {
  constructor(message = "素材列表参数无效，请刷新后重试") {
    super(message);
    this.name = "LibraryQueryError";
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function decodeCursor(value: string, kind: LibraryKind): LibraryCursor {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error();
    const cursor = JSON.parse(decoded.toString("utf8"));
    if (!cursor || cursor.v !== 1 || cursor.filter !== kind ||
      !["avatar", "task"].includes(cursor.kind) || !validId(cursor.id) ||
      !Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0 ||
      (kind === "avatars" && cursor.kind !== "avatar") ||
      (kind === "tasks" && cursor.kind !== "task")) throw new Error();
    return cursor;
  } catch {
    throw new LibraryQueryError("素材列表翻页凭证无效，请刷新列表");
  }
}

export function parseLibraryQuery(params: URLSearchParams): LibraryQuery {
  for (const key of ["kind", "limit", "cursor", "avatarId", "taskId"]) {
    if (params.getAll(key).length > 1) throw new LibraryQueryError();
  }
  const kind = params.get("kind") ?? "all";
  if (kind !== "all" && kind !== "avatars" && kind !== "tasks") throw new LibraryQueryError();
  const rawLimit = params.get("limit");
  if (rawLimit !== null && !/^\d{1,2}$/u.test(rawLimit)) throw new LibraryQueryError();
  const limit = rawLimit === null ? 12 : Number(rawLimit);
  if (limit < 1 || limit > 48) throw new LibraryQueryError("每次加载数量应为 1–48 条");
  const avatarId = params.get("avatarId");
  const taskId = params.get("taskId");
  if ((avatarId !== null && !validId(avatarId)) || (taskId !== null && !validId(taskId))) {
    throw new LibraryQueryError();
  }
  const rawCursor = params.get("cursor");
  return {
    kind,
    limit,
    cursor: rawCursor === null ? null : decodeCursor(rawCursor, kind),
    ...(avatarId === null ? {} : { avatarId }),
    ...(taskId === null ? {} : { taskId }),
  };
}

// Timestamps are immutable. ID and kind break ties consistently across requests.
export function compareLibraryItems(a: LibraryItemKey, b: LibraryItemKey): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.kind === b.kind ? 0 : a.kind < b.kind ? -1 : 1;
}

export function paginateLibrary<T extends LibraryItemKey>(items: readonly T[], query: LibraryQuery) {
  const avatars = items.filter(item => item.kind === "avatar").length;
  const counts = { all: items.length, avatars, tasks: items.length - avatars };
  const filtered = items.filter(item => query.kind === "all" ||
    (query.kind === "avatars" ? item.kind === "avatar" : item.kind === "task"));
  const remaining = filtered
    .filter(item => !query.cursor || compareLibraryItems(item, query.cursor) > 0)
    .sort(compareLibraryItems);
  const pageItems = remaining.slice(0, query.limit);
  const hasMore = remaining.length > query.limit;
  const last = pageItems.at(-1);
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({
      v: 1, filter: query.kind, kind: last.kind, id: last.id, createdAt: last.createdAt,
    })).toString("base64url")
    : null;
  return { items: pageItems, nextCursor, hasMore, total: filtered.length, counts };
}
