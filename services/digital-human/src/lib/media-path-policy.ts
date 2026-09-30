import path from "path";
import fs from "fs";

export function mediaRoots(cwd = process.cwd()): string[] {
  return [
    path.resolve(cwd, ".runtime", "uploads"),
    path.resolve(cwd, ".runtime", "jobs"),
    path.resolve(cwd, ".runtime", "provider-input"),
    // Read-only compatibility for media created before private runtime storage.
    path.resolve(cwd, "public", "uploads"),
    path.resolve(cwd, "public", "jobs"),
  ];
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveAllowedLocalMediaPath(
  source: string,
  cwd = process.cwd()
): string | null {
  let candidate: string;
  if (source.startsWith("/jobs/") || source.startsWith("/uploads/")) {
    candidate = path.resolve(cwd, "public", `.${source}`);
  } else if (path.isAbsolute(source)) {
    candidate = path.resolve(source);
  } else {
    return null;
  }

  for (const root of mediaRoots(cwd)) {
    if (fs.existsSync(candidate) && fs.existsSync(root)) {
      try {
        const realCandidate = fs.realpathSync.native(candidate);
        const realRoot = fs.realpathSync.native(root);
        if (isPathInside(realRoot, realCandidate)) return candidate;
      } catch {
        continue;
      }
    } else if (isPathInside(root, candidate)) {
      return candidate;
    }
  }

  return null;
}
