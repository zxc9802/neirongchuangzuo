/** Reconcile interrupted workspace jobs once per Node server startup; reads retry any ledger outage. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ TaskStore }, { reconcileWorkspaceTask }, { logServerError }] = await Promise.all([
    import("./lib/store/task-store"), import("./lib/server/workspace-task-recovery"), import("./lib/server/safe-log"),
  ]);
  try {
    const tasks = await TaskStore.getAllAsync();
    for (const task of tasks) {
      try { await reconcileWorkspaceTask(task); }
      catch (error) { logServerError("tasks.startup_billing_recovery_failed", error, "warn"); }
    }
  } catch (error) { logServerError("tasks.startup_recovery_failed", error, "warn"); }
}
