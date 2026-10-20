export const LIPSYNC_PROVIDERS = ["heygen", "pixverse", "veed", "latentsync", "veed-v2"] as const;

export type LipsyncProvider = (typeof LIPSYNC_PROVIDERS)[number];

export function isLipsyncProvider(value: unknown): value is LipsyncProvider {
  return typeof value === "string" && (LIPSYNC_PROVIDERS as readonly string[]).includes(value);
}

export function resolveLipsyncProvider(
  value: unknown,
  fallback: LipsyncProvider = "heygen"
): LipsyncProvider {
  return isLipsyncProvider(value) ? value : fallback;
}

export function lipsyncModelName(provider: LipsyncProvider): string {
  if (provider === "veed-v2") return "veed-lipsync-v2";
  if (provider === "latentsync") return "latentsync";
  if (provider === "pixverse") return "pixverse-lipsync";
  if (provider === "veed") return "veed-lipsync";
  return "heygen-precision";
}

export function lipsyncModeName(provider: LipsyncProvider): string {
  if (provider === "veed-v2") return "veed-lipsync-v2";
  if (provider === "latentsync") return "latentsync";
  if (provider === "pixverse") return "pixverse-lipsync";
  if (provider === "veed") return "veed-lipsync";
  return "precision";
}
