import "server-only";

import fs from "fs";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { NextRequest } from "next/server";
import { CosService } from "@/lib/cos";
import { getAppConfig } from "@/lib/config";
import { isPathInside, resolveAllowedLocalMediaPath } from "@/lib/media-path-policy";

export const MAX_REMOTE_MEDIA_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 3;

type AllowedRemote = {
  url: string;
  mode: "managed" | "configured-reference";
  origin: string;
};

function configuredReferenceUrls(): Set<string> {
  const config = getAppConfig();
  return new Set(
    [config.indexttsSpeakerAudioUrl, config.indexttsEmotionAudioUrl]
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(value).toString();
        } catch {
          return "";
        }
      })
      .filter(Boolean)
  );
}

async function resolveAllowedRemote(
  source: string,
  allowConfiguredReference: boolean
): Promise<AllowedRemote | null> {
  const managedKey = CosService.getManagedObjectKey(source);
  if (managedKey) {
    const signed = await CosService.getDownloadUrl(managedKey, undefined, 6 * 60 * 60);
    return { url: signed, mode: "managed", origin: new URL(signed).origin };
  }

  let normalized: string;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:") return null;
    normalized = url.toString();
  } catch {
    return null;
  }

  if (!allowConfiguredReference || !configuredReferenceUrls().has(normalized)) return null;
  return {
    url: normalized,
    mode: "configured-reference",
    origin: new URL(normalized).origin,
  };
}

function redirectAllowed(nextUrl: URL, allowed: AllowedRemote): boolean {
  if (nextUrl.protocol !== "https:") return false;
  if (allowed.mode === "managed") {
    return Boolean(CosService.getManagedObjectKey(nextUrl.toString()));
  }
  return nextUrl.origin === allowed.origin;
}

async function fetchAllowedRemote(
  source: string,
  options: {
    allowConfiguredReference?: boolean;
    range?: string | null;
  } = {}
): Promise<Response | null> {
  const allowed = await resolveAllowedRemote(source, Boolean(options.allowConfiguredReference));
  if (!allowed) return null;

  let currentUrl = allowed.url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      headers: options.range ? { Range: options.range } : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) return null;
      const nextUrl = new URL(location, currentUrl);
      if (!redirectAllowed(nextUrl, allowed)) return null;
      currentUrl = nextUrl.toString();
      continue;
    }
    return response;
  }
  return null;
}

export async function isTrustedStoredMediaSource(
  source: string | undefined,
  allowConfiguredReference = false
): Promise<boolean> {
  if (!source) return false;
  if (resolveAllowedLocalMediaPath(source)) return true;
  if (CosService.getManagedObjectKey(source)) return true;
  if (!allowConfiguredReference) return false;
  return Boolean(await resolveAllowedRemote(source, true));
}

export async function getTrustedExternalMediaUrl(
  source: string,
  allowConfiguredReference = false
): Promise<string> {
  const allowed = await resolveAllowedRemote(source, allowConfiguredReference);
  if (!allowed) throw new Error("Media source is not allowed");
  return allowed.url;
}

export function isTrustedTaskOutputSource(
  source: string | undefined,
  taskId: string,
  allowedFileNames: readonly string[]
): boolean {
  if (!source || !/^[a-zA-Z0-9_-]+$/.test(taskId)) return false;
  const managedKey = CosService.getManagedObjectKey(source);
  if (managedKey) {
    return allowedFileNames.some((fileName) => managedKey === `jobs/${taskId}/${fileName}`);
  }

  const localPath = resolveAllowedLocalMediaPath(source);
  if (!localPath) return false;
  const roots = [
    path.join(getAppConfig().storageDir, taskId),
    path.join(process.cwd(), "public", "jobs", taskId),
  ];
  for (const root of roots) {
    for (const fileName of allowedFileNames) {
      const expectedPath = path.join(root, fileName);
      if (path.resolve(localPath) !== path.resolve(expectedPath)) continue;
      try {
        if (
          isPathInside(
            fs.realpathSync.native(root),
            fs.realpathSync.native(localPath)
          )
        ) return true;
      } catch {}
    }
  }
  return false;
}

export async function downloadTrustedMediaToFile(params: {
  source: string;
  outputPath: string;
  allowConfiguredReference?: boolean;
  maxBytes?: number;
}): Promise<number> {
  const maxBytes = params.maxBytes || MAX_REMOTE_MEDIA_BYTES;
  const localPath = resolveAllowedLocalMediaPath(params.source);
  fs.mkdirSync(path.dirname(params.outputPath), { recursive: true });

  if (localPath) {
    const stat = fs.statSync(localPath);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Media exceeds size limit");
    if (path.resolve(localPath) !== path.resolve(params.outputPath)) {
      fs.copyFileSync(localPath, params.outputPath);
    }
    return stat.size;
  }

  const response = await fetchAllowedRemote(params.source, {
    allowConfiguredReference: params.allowConfiguredReference,
  });
  if (!response || !response.ok || !response.body) throw new Error("Media download failed");

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error("Media exceeds size limit");

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new Error("Media exceeds size limit") : null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      limiter,
      fs.createWriteStream(params.outputPath)
    );
  } catch (error) {
    try {
      fs.unlinkSync(params.outputPath);
    } catch {}
    throw error;
  }
  return bytes;
}

export async function servePrivateMedia(
  req: NextRequest,
  source: string | undefined,
  options: {
    contentType?: string;
    downloadName?: string;
    allowConfiguredReference?: boolean;
  } = {}
): Promise<Response> {
  if (!source) return new Response("Media not found", { status: 404 });

  const localPath = resolveAllowedLocalMediaPath(source);
  if (localPath) {
    if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
      return new Response("Media not found", { status: 404 });
    }
    const stat = fs.statSync(localPath);
    if (stat.size > MAX_REMOTE_MEDIA_BYTES) {
      return new Response("Media too large", { status: 413 });
    }
    const headers = new Headers({
      "Content-Type": options.contentType || "application/octet-stream",
      "Content-Length": String(stat.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (options.downloadName) {
      headers.set("Content-Disposition", `attachment; filename="${options.downloadName}"`);
    }
    let status = 200, rangeOptions: {start: number; end: number} | undefined;
    const range = req.headers.get("range");
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      const first = match?.[1] ? Number(match[1]) : undefined;
      const last = match?.[2] ? Number(match[2]) : undefined;
      const start = first ?? Math.max(0, stat.size - (last ?? 0));
      const end = first === undefined ? stat.size - 1 : Math.min(last ?? stat.size - 1, stat.size - 1);
      if (!match || (first === undefined && !last) ||
        (first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last)) ||
        start >= stat.size || end < start) {
        headers.set("Content-Range", `bytes */${stat.size}`); headers.set("Content-Length", "0");
        return new Response(null, {status: 416, headers});
      }
      status = 206; rangeOptions = {start, end};
      headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      headers.set("Content-Length", String(end - start + 1));
    }
    return new Response(req.method === "HEAD" ? null : Readable.toWeb(fs.createReadStream(localPath, rangeOptions)) as ReadableStream, {status, headers});
  }

  const upstream = await fetchAllowedRemote(source, {
    allowConfiguredReference: options.allowConfiguredReference,
    range: req.headers.get("range"),
  });
  if (!upstream || (!upstream.ok && upstream.status !== 206) || !upstream.body) {
    return new Response("Media not found", { status: 404 });
  }

  const declaredLength = Number(upstream.headers.get("content-length") || 0);
  if (declaredLength > MAX_REMOTE_MEDIA_BYTES) {
    return new Response("Media too large", { status: 413 });
  }

  let streamedBytes = 0;
  // Keep errors and cancellation connected to the upstream body during playback.
  const body = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      streamedBytes += chunk.byteLength;
      if (streamedBytes > MAX_REMOTE_MEDIA_BYTES) throw new Error("Media exceeds size limit");
      controller.enqueue(chunk);
    },
  }));

  const headers = new Headers({
    "Content-Type": options.contentType || upstream.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (options.downloadName) {
    headers.set("Content-Disposition", `attachment; filename="${options.downloadName}"`);
  }
  return new Response(body, { status: upstream.status, headers });
}
