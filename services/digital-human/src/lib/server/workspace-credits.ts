import "server-only";
import path from "node:path";
import { createCreditsLedger, calculateCredits } from "../../../../credits/store.mjs";

let ledger: ReturnType<typeof createCreditsLedger> | undefined;

/** Both the workspace server and Next workers use the same PostgreSQL ledger. */
export function getWorkspaceCreditsLedger() {
  if (!ledger) ledger = createCreditsLedger({
    databaseUrl: process.env.AUTH_DATABASE_URL,
    storageDir: process.env.WORKSPACE_DATA_DIR || path.resolve(process.cwd(), "../../.data"),
  });
  return ledger;
}

export async function workspaceCreditsSnapshot(userId: string) {
  const current = getWorkspaceCreditsLedger();
  await current.ready;
  return current.snapshot(userId);
}

export function calculateWorkspacePoints(seconds: number): number {
  return calculateCredits("digital-human", seconds);
}

export const WORKSPACE_VIDEO_POINTS = 333;
export const WORKSPACE_VIDEO_SECONDS = 30;
