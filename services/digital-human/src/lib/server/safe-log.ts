const ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "ENOENT", "EACCES", "EPERM", "ENOSPC", "ABORT_ERR",
]);

// Events are fixed call-site labels. Never serialize upstream messages, stacks or objects.
export function logServerError(
  event: string,
  error?: unknown,
  level: "warn" | "error" = "error",
): void {
  const value = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const code = typeof value.code === "string" && ERROR_CODES.has(value.code)
    ? value.code
    : undefined;
  const status = typeof value.status === "number" &&
    Number.isInteger(value.status) && value.status >= 100 && value.status <= 599
    ? value.status
    : undefined;
  console[level](JSON.stringify({ event, code, status }));
}
