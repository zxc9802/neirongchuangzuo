import "server-only";

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CosService } from "@/lib/cos";
import { isPathInside } from "@/lib/media-path-policy";

export type UploadFolder = "videos" | "voices" | "thumbnails";

export const MAX_UPLOAD_BYTES: Record<UploadFolder, number> = {
  videos: 500 * 1024 * 1024,
  voices: 50 * 1024 * 1024,
  thumbnails: 10 * 1024 * 1024,
};

const ALLOWED_EXTENSIONS: Record<UploadFolder, Set<string>> = {
  videos: new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]),
  voices: new Set([".mp3", ".wav", ".m4a", ".aac", ".mp4", ".mov"]),
  thumbnails: new Set([".jpg", ".jpeg", ".png", ".webp"]),
};

const ALLOWED_MIME_PREFIXES: Record<UploadFolder, string[]> = {
  videos: ["video/"],
  voices: ["audio/", "video/"],
  thumbnails: ["image/"],
};

const UPLOAD_GRANT_WINDOW_MS = 60 * 60 * 1000;
const MAX_UPLOAD_GRANTS_PER_WINDOW = 30;
const MAX_UPLOAD_GRANT_BYTES_PER_WINDOW = 2 * 1024 * 1024 * 1024;
const uploadGrantWindows = new Map<string, { startedAt: number; count: number; bytes: number }>();
const PENDING_UPLOAD_TTL_MS = 60 * 60_000;
const MAX_PENDING_BYTES_PER_USER = 2 * 1024 * 1024 * 1024;
const MAX_PENDING_BYTES_GLOBAL = 20 * 1024 * 1024 * 1024;
const PENDING_UPLOADS_PATH = path.join(
  process.env.UPLOAD_PENDING_STATE_PATH?.trim() || process.cwd(),
  ...(process.env.UPLOAD_PENDING_STATE_PATH?.trim()
    ? []
    : [".runtime", "state", "pending-uploads.json"]),
);
const PENDING_DELETIONS_PATH =
  process.env.UPLOAD_DELETION_STATE_PATH?.trim() ||
  path.join(process.cwd(), ".runtime", "state", "pending-upload-deletions.json");

type PendingUpload = {
  key: string;
  ownerKey: string;
  folder: UploadFolder;
  bytes: number;
  createdAt: number;
  expiresAt: number;
  stored: boolean;
  multipartUploadId?: string;
};

type PendingDeletion = {
  id: string;
  source: string;
  userId: string | null;
  folder: UploadFolder;
  createdAt: number;
  attempts: number;
};

function withPendingUploadLock<T>(operation: () => T): T {
  const lockPath = `${PENDING_UPLOADS_PATH}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 2_000;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) fs.unlinkSync(lockPath);
      } catch {}
      if (Date.now() >= deadline) throw new Error("Upload ledger is busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function loadPendingUploads(): PendingUpload[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(PENDING_UPLOADS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePendingUploads(records: PendingUpload[]): void {
  fs.mkdirSync(path.dirname(PENDING_UPLOADS_PATH), { recursive: true });
  const temporaryPath = `${PENDING_UPLOADS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(records, null, 2), "utf8");
  fs.renameSync(temporaryPath, PENDING_UPLOADS_PATH);
}

function withDeletionLedgerLock<T>(operation: () => T): T {
  const lockPath = `${PENDING_DELETIONS_PATH}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 2_000;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) fs.unlinkSync(lockPath);
      } catch {}
      if (Date.now() >= deadline) throw new Error("Deletion ledger is busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function loadPendingDeletions(): PendingDeletion[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(PENDING_DELETIONS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePendingDeletions(records: PendingDeletion[]): void {
  fs.mkdirSync(path.dirname(PENDING_DELETIONS_PATH), { recursive: true });
  const temporaryPath = `${PENDING_DELETIONS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(records, null, 2), "utf8");
  fs.renameSync(temporaryPath, PENDING_DELETIONS_PATH);
}

export function reservePendingUpload(params: {
  key: string;
  userId: string | null | undefined;
  folder: UploadFolder;
  bytes: number;
  now?: number;
}): boolean {
  return withPendingUploadLock(() => {
    const now = params.now ?? Date.now();
    const ownerKey = ownerKeyFor(params.userId);
    const records = loadPendingUploads().filter((record) => record.expiresAt > now);
    const ownerBytes = records
      .filter((record) => record.ownerKey === ownerKey)
      .reduce((sum, record) => sum + record.bytes, 0);
    const globalBytes = records.reduce((sum, record) => sum + record.bytes, 0);
    if (
      records.some((record) => record.key === params.key) ||
      ownerBytes + params.bytes > MAX_PENDING_BYTES_PER_USER ||
      globalBytes + params.bytes > MAX_PENDING_BYTES_GLOBAL
    ) return false;
    records.push({
      key: params.key,
      ownerKey,
      folder: params.folder,
      bytes: params.bytes,
      createdAt: now,
      expiresAt: now + PENDING_UPLOAD_TTL_MS,
      stored: false,
    });
    savePendingUploads(records);
    return true;
  });
}

export function markPendingUploadStored(key: string): boolean {
  return withPendingUploadLock(() => {
    const records = loadPendingUploads();
    const record = records.find((item) => item.key === key);
    if (!record || record.expiresAt <= Date.now()) return false;
    record.stored = true;
    savePendingUploads(records);
    return true;
  });
}

export function getPendingUpload(key: string, userId: string | null | undefined): PendingUpload | null {
  return withPendingUploadLock(() => {
    const record = loadPendingUploads().find(item => item.key === key);
    return record && record.ownerKey === ownerKeyFor(userId) && record.expiresAt > Date.now()
      ? { ...record } : null;
  });
}

export function setPendingMultipartUpload(key: string, uploadId: string): boolean {
  return withPendingUploadLock(() => {
    const records = loadPendingUploads();
    const record = records.find(item => item.key === key);
    if (!record || record.expiresAt <= Date.now()) return false;
    record.multipartUploadId = uploadId;
    savePendingUploads(records);
    return true;
  });
}

export function cancelPendingUpload(key: string): void {
  withPendingUploadLock(() => {
    const records = loadPendingUploads();
    const filtered = records.filter((record) => record.key !== key);
    if (filtered.length !== records.length) savePendingUploads(filtered);
  });
}

export function claimPendingUploads(params: {
  keys: string[];
  userId: string | null | undefined;
  now?: number;
}): boolean {
  return withPendingUploadLock(() => {
    const now = params.now ?? Date.now();
    const expectedOwner = ownerKeyFor(params.userId);
    const uniqueKeys = [...new Set(params.keys.filter(Boolean))];
    const records = loadPendingUploads();
    const selected = uniqueKeys.map((key) => records.find((record) => record.key === key));
    if (
      selected.some(
        (record) =>
          !record ||
          !record.stored ||
          record.ownerKey !== expectedOwner ||
          record.expiresAt <= now,
      )
    ) return false;
    savePendingUploads(records.filter((record) => !uniqueKeys.includes(record.key)));
    return true;
  });
}

export function claimPendingUpload(params: {
  key: string;
  userId: string | null | undefined;
  now?: number;
}): boolean {
  return claimPendingUploads({
    keys: [params.key],
    userId: params.userId,
    now: params.now,
  });
}

export async function cleanupExpiredPendingUploads(now = Date.now()): Promise<number> {
  const expired = withPendingUploadLock(() => {
    const records = loadPendingUploads();
    const selected = records.filter((record) => record.expiresAt <= now);
    if (selected.length > 0) {
      savePendingUploads(records.filter((record) => record.expiresAt > now));
    }
    return selected;
  });
  if (expired.length === 0) return 0;
  await Promise.all(expired.map(async (record) => {
    if (record.multipartUploadId) {
      try { await CosService.abortDirectUpload(record.key, record.multipartUploadId); } catch {}
    }
    try { await CosService.deleteObject(record.key); } catch {}
    try {
      const candidate = localUploadPath(record.key);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) fs.unlinkSync(candidate);
    } catch {}
  }));
  return expired.length;
}

export function ownerKeyFor(userId: string | null | undefined): string {
  if (!userId) return "anonymous-local";
  return `u_${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;
}

export function consumeUploadGrantBudget(
  userId: string | null | undefined,
  requestedBytes: number,
  now = Date.now()
): boolean {
  const key = ownerKeyFor(userId);
  let window = uploadGrantWindows.get(key);
  if (!window || now - window.startedAt >= UPLOAD_GRANT_WINDOW_MS) {
    window = { startedAt: now, count: 0, bytes: 0 };
  }
  if (
    window.count >= MAX_UPLOAD_GRANTS_PER_WINDOW ||
    window.bytes + requestedBytes > MAX_UPLOAD_GRANT_BYTES_PER_WINDOW
  ) return false;
  window.count += 1;
  window.bytes += requestedBytes;
  uploadGrantWindows.set(key, window);
  return true;
}

function legacyOwnerKeyFor(userId: string | null | undefined): string {
  return (userId || "local").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function validateUploadDescriptor(params: {
  folder: UploadFolder;
  fileName: string;
  contentType?: string;
  fileSize: number;
}): string | null {
  const { folder, fileName, contentType = "", fileSize } = params;
  const ext = path.extname(fileName).toLowerCase();
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_UPLOAD_BYTES[folder]) {
    return `文件大小不符合要求（最大 ${Math.floor(MAX_UPLOAD_BYTES[folder] / 1024 / 1024)}MB）`;
  }
  if (!ALLOWED_EXTENSIONS[folder].has(ext)) return "不支持的文件格式";
  if (
    contentType &&
    !ALLOWED_MIME_PREFIXES[folder].some((prefix) => contentType.toLowerCase().startsWith(prefix))
  ) {
    return "文件类型与上传目录不匹配";
  }
  return null;
}

export function validateOwnedUploadKey(
  key: unknown,
  userId: string | null | undefined,
  folder: UploadFolder
): string | null {
  if (typeof key !== "string" || !key || key.includes("\\") || key.includes("..")) return null;
  const normalized = key.replace(/^\/+/, "");
  const prefix = `uploads/users/${ownerKeyFor(userId)}/${folder}/`;
  if (!normalized.startsWith(prefix) || normalized === prefix) return null;
  const remainder = normalized.slice(prefix.length);
  if (remainder.includes("/")) return null;
  return ALLOWED_EXTENSIONS[folder].has(path.extname(remainder).toLowerCase())
    ? normalized
    : null;
}

export function localUploadPath(key: string): string {
  const root = path.resolve(process.cwd(), ".runtime", "uploads");
  const relative = key.replace(/^uploads\//, "");
  const candidate = path.resolve(root, relative);
  if (!isPathInside(root, candidate)) throw new Error("Invalid upload path");
  return candidate;
}

export async function resolveOwnedUpload(params: {
  key: unknown;
  userId: string | null | undefined;
  folder: UploadFolder;
}): Promise<{ key: string; source: string; localPath?: string; storedRemotely: boolean; size: number } | null> {
  const key = validateOwnedUploadKey(params.key, params.userId, params.folder);
  if (!key) return null;

  if (CosService.isConfigured()) {
    const size = await CosService.getObjectSize(key);
    if (size !== null && size > 0 && size <= MAX_UPLOAD_BYTES[params.folder]) {
      return { key, source: CosService.getPublicUrl(key), storedRemotely: true, size };
    }
  }

  const candidate = localUploadPath(key);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  const size = fs.statSync(candidate).size;
  if (size <= 0 || size > MAX_UPLOAD_BYTES[params.folder]) return null;
  return { key, source: candidate, localPath: candidate, storedRemotely: false, size };
}

export function isOwnedUploadSource(params: {
  source: string | undefined;
  userId: string | null | undefined;
  folder: UploadFolder;
}): boolean {
  if (!params.source) return false;
  const managedKey = CosService.getManagedObjectKey(params.source);
  if (managedKey) {
    if (validateOwnedUploadKey(managedKey, params.userId, params.folder)) return true;
    const legacyPrefix = `uploads/users/${legacyOwnerKeyFor(params.userId)}/${params.folder}/`;
    const remainder = managedKey.startsWith(legacyPrefix)
      ? managedKey.slice(legacyPrefix.length)
      : "";
    return Boolean(
      remainder &&
      !remainder.includes("/") &&
      !remainder.includes("..") &&
      ALLOWED_EXTENSIONS[params.folder].has(path.extname(remainder).toLowerCase())
    );
  }

  const candidate = path.resolve(params.source);
  if (!ALLOWED_EXTENSIONS[params.folder].has(path.extname(candidate).toLowerCase())) {
    return false;
  }
  for (const ownerKey of [ownerKeyFor(params.userId), legacyOwnerKeyFor(params.userId)]) {
    const ownerPrefix = `uploads/users/${ownerKey}/${params.folder}/`;
    const expectedRoot = path.dirname(localUploadPath(`${ownerPrefix}placeholder.tmp`));
    if (!isPathInside(expectedRoot, candidate) || !fs.existsSync(candidate)) continue;
    try {
      if (
        isPathInside(
          fs.realpathSync.native(expectedRoot),
          fs.realpathSync.native(candidate)
        )
      ) return true;
    } catch {}
  }
  return false;
}

export async function deleteOwnedUploadSource(params: {
  source: string | undefined;
  userId: string | null | undefined;
  folder: UploadFolder;
}): Promise<void> {
  if (!isOwnedUploadSource(params) || !params.source) return;
  const managedKey = CosService.getManagedObjectKey(params.source);
  if (managedKey) {
    await CosService.deleteObject(managedKey);
    return;
  }
  const localPath = path.resolve(params.source);
  if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
    fs.unlinkSync(localPath);
  }
}

export function queueOwnedUploadDeletion(params: {
  source: string | undefined;
  userId: string | null | undefined;
  folder: UploadFolder;
}): void {
  if (!params.source || !isOwnedUploadSource(params)) return;
  withDeletionLedgerLock(() => {
    const records = loadPendingDeletions();
    if (
      records.some(
        (record) =>
          record.source === params.source &&
          record.userId === (params.userId || null) &&
          record.folder === params.folder,
      )
    ) return;
    records.push({
      id: crypto.randomUUID(),
      source: params.source!,
      userId: params.userId || null,
      folder: params.folder,
      createdAt: Date.now(),
      attempts: 0,
    });
    savePendingDeletions(records);
  });
}

export async function deleteOwnedUploadSourceEventually(params: {
  source: string | undefined;
  userId: string | null | undefined;
  folder: UploadFolder;
}): Promise<void> {
  if (!params.source || !isOwnedUploadSource(params)) return;
  try {
    await deleteOwnedUploadSource(params);
  } catch {
    queueOwnedUploadDeletion(params);
  }
}

export async function cleanupPendingOwnedUploadDeletions(limit = 20): Promise<number> {
  const selected = withDeletionLedgerLock(() => loadPendingDeletions().slice(0, limit));
  if (selected.length === 0) return 0;

  const completed = new Set<string>();
  for (const record of selected) {
    try {
      await deleteOwnedUploadSource(record);
      completed.add(record.id);
    } catch {}
  }

  withDeletionLedgerLock(() => {
    const records = loadPendingDeletions();
    const updated = records
      .filter((record) => !completed.has(record.id))
      .map((record) =>
        selected.some((candidate) => candidate.id === record.id)
          ? { ...record, attempts: record.attempts + 1 }
          : record,
      );
    savePendingDeletions(updated);
  });
  return completed.size;
}
