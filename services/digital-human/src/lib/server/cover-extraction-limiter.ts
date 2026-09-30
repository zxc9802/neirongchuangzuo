import "server-only";

const MAX_GLOBAL = 2;
const RATE_WINDOW_MS = 60 * 60_000;
const MAX_PER_WINDOW = 10;
let activeGlobal = 0;
const activeUsers = new Set<string>();
const windows = new Map<string, { startedAt: number; count: number }>();

export function acquireCoverExtractionSlot(
  userId: string,
  now = Date.now(),
): (() => void) | null {
  let window = windows.get(userId);
  if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
    window = { startedAt: now, count: 0 };
  }
  if (window.count >= MAX_PER_WINDOW || activeGlobal >= MAX_GLOBAL || activeUsers.has(userId)) {
    return null;
  }
  window.count += 1;
  windows.set(userId, window);
  activeGlobal += 1;
  activeUsers.add(userId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeGlobal = Math.max(0, activeGlobal - 1);
    activeUsers.delete(userId);
  };
}
