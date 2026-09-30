export function isStandaloneAuth(): boolean {
  return process.env.AUTH_MODE === "standalone";
}

export function supportsStandaloneAuth(): boolean {
  return isStandaloneAuth() || process.env.AUTH_MODE === "hybrid";
}

export function usesStandaloneAuth(hasCookie: boolean): boolean {
  return isStandaloneAuth() || (process.env.AUTH_MODE === "hybrid" && hasCookie);
}
