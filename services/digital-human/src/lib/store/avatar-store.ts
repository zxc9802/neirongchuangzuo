import { logServerError } from "../server/safe-log";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CosService } from "../cos";
import { MAX_UPLOAD_BYTES, ownerKeyFor } from "../server/upload-policy";

export interface AvatarItem {
  id: string;
  userId?: string;
  name: string;
  videoUrl: string;
  videoPath?: string;
  coverUrl?: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps?: number;
  fileSize: number;
  createdAt: number;
  isCos?: boolean;
  canManage?: boolean;
  legacySourceKey?: string;
  legacyCoverSourceKey?: string;
  legacySourcesPrivatized?: boolean;
  deletedAt?: number;
}

const STATE_DIR = path.join(process.cwd(), ".runtime", "state");
const AVATARS_FILE_PATH = path.join(STATE_DIR, "avatars.json");
const BACKUP_AVATARS_PATH = path.join(STATE_DIR, "avatars.backup.json");
const LEGACY_AVATARS_PATH = path.join(process.cwd(), ".avatars.json");
const LEGACY_ROOT_BACKUP_AVATARS_PATH = path.join(process.cwd(), ".avatars.backup.json");
const LEGACY_BACKUP_AVATARS_PATH = path.join(process.cwd(), "public", "jobs", ".backup", ".avatars.json");
const COS_AVATARS_KEY = "_system/avatars.json";
const LEGACY_AVATAR_PREFIX = "uploads/videos/";

let memoryAvatars: AvatarItem[] = [];
let hasLoadedFromCloud = false;
let hasReconciledLegacyAvatars = false;
let legacyReconciliationPromise: Promise<void> | null = null;

function reloadFromDisk() {
  try {
    let raw = "";
    let migrateLegacy = false;
    if (fs.existsSync(AVATARS_FILE_PATH)) {
      raw = fs.readFileSync(AVATARS_FILE_PATH, "utf-8");
    } else if (fs.existsSync(BACKUP_AVATARS_PATH)) {
      raw = fs.readFileSync(BACKUP_AVATARS_PATH, "utf-8");
      migrateLegacy = true;
    } else if (fs.existsSync(LEGACY_AVATARS_PATH)) {
      raw = fs.readFileSync(LEGACY_AVATARS_PATH, "utf-8");
      migrateLegacy = true;
    } else if (fs.existsSync(LEGACY_ROOT_BACKUP_AVATARS_PATH)) {
      raw = fs.readFileSync(LEGACY_ROOT_BACKUP_AVATARS_PATH, "utf-8");
      migrateLegacy = true;
    } else if (fs.existsSync(LEGACY_BACKUP_AVATARS_PATH)) {
      raw = fs.readFileSync(LEGACY_BACKUP_AVATARS_PATH, "utf-8");
      migrateLegacy = true;
    }

    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        memoryAvatars = parsed;
      }
      if (migrateLegacy) {
        try {
          fs.mkdirSync(STATE_DIR, { recursive: true });
          fs.writeFileSync(AVATARS_FILE_PATH, raw, "utf-8");
          fs.writeFileSync(BACKUP_AVATARS_PATH, raw, "utf-8");
        } catch {}
      }
    }
  } catch (e) {
    // ignore
  }
}

function persistStore(syncCloud = true) {
  try {
    const content = JSON.stringify(memoryAvatars, null, 2);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(AVATARS_FILE_PATH, content, "utf-8");

    // Mirror to persistent mounted volume
    try {
      fs.writeFileSync(BACKUP_AVATARS_PATH, content, "utf-8");
    } catch {}

    // Mirror to cloud object storage for 100% persistent cloud recovery
    if (syncCloud && CosService.isConfigured()) {
      CosService.saveJsonToCos(COS_AVATARS_KEY, memoryAvatars).catch((err) => {
        logServerError("avatars.sync_failed", err, "warn");
      });
    }
  } catch (e) {
    logServerError("avatars.persist_failed", e);
  }
}

function legacyAvatarKeyFromUrl(source: string): string | null {
  return CosService.getLegacyAvatarObjectKey(source, "videos");
}

function legacyAvatarSourceKey(avatar: AvatarItem): string | null {
  if (
    avatar.legacySourceKey &&
    CosService.getLegacyAvatarObjectKey(
      CosService.getPublicUrl(avatar.legacySourceKey),
      "videos",
    ) === avatar.legacySourceKey
  ) {
    return avatar.legacySourceKey;
  }
  return legacyAvatarKeyFromUrl(avatar.videoUrl);
}

function migratedObjectKey(
  ownerUserId: string,
  folder: "videos" | "thumbnails",
  sourceKey: string,
): string {
  const digest = crypto.createHash("sha256").update(sourceKey).digest("hex").slice(0, 32);
  return `uploads/users/${ownerKeyFor(ownerUserId)}/${folder}/legacy-${digest}${path.extname(sourceKey).toLowerCase()}`;
}

async function ensureCopiedObject(
  sourceKey: string,
  targetKey: string,
  expectedSize: number,
): Promise<void> {
  const existingSize = await CosService.getObjectSize(targetKey);
  if (existingSize === expectedSize) return;
  await CosService.copyLegacyAvatarObject(sourceKey, targetKey);
  const copiedSize = await CosService.getObjectSize(targetKey);
  if (copiedSize !== expectedSize) {
    throw new Error("Legacy avatar copy verification failed");
  }
}

async function findLegacyCover(
  fileName: string,
  existingCoverUrl?: string,
): Promise<{ key: string; size: number } | null> {
  const existingKey = existingCoverUrl
    ? CosService.getLegacyAvatarObjectKey(existingCoverUrl, "thumbnails")
    : null;
  const candidates = Array.from(new Set([
    ...(existingKey ? [existingKey] : []),
    `uploads/thumbnails/${fileName}.jpg`,
    `uploads/thumbnails/${fileName.replace(/\.[^/.]+$/, "")}.jpg`,
  ]));
  for (const key of candidates) {
    if (CosService.getLegacyAvatarObjectKey(CosService.getPublicUrl(key), "thumbnails") !== key) {
      continue;
    }
    const size = await CosService.getObjectSize(key);
    if (size && size <= MAX_UPLOAD_BYTES.thumbnails) return { key, size };
  }
  return null;
}

async function migrateLegacyAvatar(
  file: { key: string; size: number; lastModified: string },
  index: number,
  ownerUserId: string,
  existing?: AvatarItem,
): Promise<AvatarItem> {
  const fileName = path.basename(file.key);
  const cleanName = fileName
    .replace(/^\d+_/, "")
    .replace(/\.[^/.]+$/, "")
    .replace(/_/g, " ") || `形象素材 ${index + 1}`;
  const videoKey = migratedObjectKey(ownerUserId, "videos", file.key);
  await ensureCopiedObject(file.key, videoKey, file.size);

  const legacyCover = await findLegacyCover(fileName, existing?.coverUrl);
  const existingLegacyCover = existing?.coverUrl
    ? CosService.getLegacyAvatarObjectKey(existing.coverUrl, "thumbnails")
    : null;
  let coverUrl = existingLegacyCover ? undefined : existing?.coverUrl;
  if (legacyCover) {
    const coverKey = migratedObjectKey(ownerUserId, "thumbnails", legacyCover.key);
    await ensureCopiedObject(legacyCover.key, coverKey, legacyCover.size);
    coverUrl = CosService.getPublicUrl(coverKey);
  }

  if (!existing?.legacySourcesPrivatized) {
    await Promise.all([
      CosService.makeLegacyAvatarObjectPrivate(file.key, "videos"),
      ...(legacyCover
        ? [CosService.makeLegacyAvatarObjectPrivate(legacyCover.key, "thumbnails")]
        : []),
    ]);
  }

  return {
    ...existing,
    id: existing?.id || `cos_recovered_${crypto.createHash("sha256").update(file.key).digest("hex").slice(0, 24)}`,
    userId: ownerUserId,
    name: existing?.name || cleanName,
    videoUrl: CosService.getPublicUrl(videoKey),
    videoPath: undefined,
    coverUrl,
    durationSeconds: existing?.durationSeconds || 86,
    width: existing?.width || 1080,
    height: existing?.height || 1920,
    fps: existing?.fps || 30,
    fileSize: file.size,
    createdAt: existing?.createdAt || (file.lastModified ? new Date(file.lastModified).getTime() : Date.now()),
    isCos: true,
    legacySourceKey: file.key,
    legacyCoverSourceKey: legacyCover?.key || existing?.legacyCoverSourceKey,
    legacySourcesPrivatized: true,
  };
}

async function reconcileLegacyAvatars(ownerUserId: string): Promise<void> {
  const files = await CosService.listFiles(LEGACY_AVATAR_PREFIX);
  const legacyFiles = files.filter(
    (file) =>
      file.size > 0 &&
      file.size <= MAX_UPLOAD_BYTES.videos &&
      CosService.getLegacyAvatarObjectKey(CosService.getPublicUrl(file.key), "videos") === file.key,
  );
  if (legacyFiles.length === 0) return;

  const recordsByLegacyKey = new Map<string, AvatarItem>();
  const recordsByManagedKey = new Map<string, AvatarItem>();
  for (const avatar of memoryAvatars) {
    const legacyKey = legacyAvatarSourceKey(avatar);
    if (legacyKey) recordsByLegacyKey.set(legacyKey, avatar);
    const managedKey = CosService.getManagedObjectKey(avatar.videoUrl);
    if (managedKey) recordsByManagedKey.set(managedKey, avatar);
  }

  const migrationResults = await Promise.all(
    legacyFiles.map(async (file, index) => {
      const legacyRecord = recordsByLegacyKey.get(file.key);
      if (legacyRecord?.deletedAt) return null;
      const migrationOwnerUserId = legacyRecord?.userId || ownerUserId;
      const targetKey = migratedObjectKey(migrationOwnerUserId, "videos", file.key);
      const targetRecord = recordsByManagedKey.get(targetKey);
      const baseRecord = targetRecord || legacyRecord;
      return {
        record: await migrateLegacyAvatar(file, index, migrationOwnerUserId, baseRecord),
        replaceId: baseRecord?.id,
        baseCoverUrl: baseRecord?.coverUrl,
        removeId: targetRecord && legacyRecord && targetRecord.id !== legacyRecord.id
          ? legacyRecord.id
          : undefined,
      };
    }),
  );
  const migrations = migrationResults.filter(
    (migration): migration is NonNullable<typeof migration> => Boolean(migration),
  );

  const replacements = new Map(
    migrations
      .filter((migration) => migration.replaceId)
      .map((migration) => [migration.replaceId as string, migration]),
  );
  const removals = new Set(
    migrations.map((migration) => migration.removeId).filter((id): id is string => Boolean(id)),
  );
  const additions = migrations
    .filter((migration) => !migration.replaceId)
    .map((migration) => migration.record);
  const nextAvatars = memoryAvatars
    .filter((avatar) => !removals.has(avatar.id))
    .map((avatar) => {
      const migration = replacements.get(avatar.id);
      if (!migration || avatar.deletedAt) return avatar;
      const migrated = migration.record;
      return {
        ...migrated,
        ...avatar,
        userId: avatar.userId || migrated.userId,
        videoUrl: migrated.videoUrl,
        videoPath: undefined,
        coverUrl: avatar.coverUrl !== migration.baseCoverUrl
          ? avatar.coverUrl
          : migrated.coverUrl,
        fileSize: migrated.fileSize,
        isCos: true,
        legacySourceKey: migrated.legacySourceKey,
        legacyCoverSourceKey: migrated.legacyCoverSourceKey,
        legacySourcesPrivatized: true,
      };
    })
    .concat(additions);
  if (JSON.stringify(nextAvatars) !== JSON.stringify(memoryAvatars)) {
    memoryAvatars = nextAvatars;
    persistStore();
  }
}

reloadFromDisk();

export const AvatarStore = {
  async getAllAsync(legacyOwnerUserId?: string): Promise<AvatarItem[]> {
    reloadFromDisk();

    // If local memory is empty or not yet synced with cloud, fetch from cloud object storage
    if ((memoryAvatars.length === 0 || !hasLoadedFromCloud) && CosService.isConfigured()) {
      try {
        const cloudAvatars = await CosService.getJsonFromCos<AvatarItem[]>(COS_AVATARS_KEY);
        if (cloudAvatars && Array.isArray(cloudAvatars) && cloudAvatars.length > 0) {
          memoryAvatars = cloudAvatars;
          persistStore(false);
        }
        hasLoadedFromCloud = true;
      } catch (err: any) {
        logServerError("avatars.load_failed", err, "warn");
      }
    }

    if (legacyOwnerUserId && CosService.isConfigured() && !hasReconciledLegacyAvatars) {
      legacyReconciliationPromise ||= reconcileLegacyAvatars(legacyOwnerUserId)
        .then(() => {
          hasReconciledLegacyAvatars = true;
        })
        .catch((err: any) => {
          logServerError("avatars.reconcile_failed", err, "warn");
        })
        .finally(() => {
          legacyReconciliationPromise = null;
        });
      await legacyReconciliationPromise;
    }

    let assignedLegacyOwner = false;
    memoryAvatars = memoryAvatars.map((avatar) => {
      if (avatar.userId || avatar.deletedAt || !legacyOwnerUserId) return avatar;
      assignedLegacyOwner = true;
      return { ...avatar, userId: legacyOwnerUserId };
    });
    if (assignedLegacyOwner) persistStore();

    return memoryAvatars
      .filter((avatar) => !avatar.deletedAt)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  getAll(): AvatarItem[] {
    reloadFromDisk();
    return memoryAvatars
      .filter((avatar) => !avatar.deletedAt)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  get(id: string): AvatarItem | undefined {
    reloadFromDisk();
    return memoryAvatars.find((a) => a.id === id && !a.deletedAt);
  },

  create(avatar: Omit<AvatarItem, "id" | "createdAt">): AvatarItem {
    reloadFromDisk();
    const id = "avatar_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6);
    const newAvatar: AvatarItem = {
      ...avatar,
      id,
      createdAt: Date.now(),
    };

    memoryAvatars.unshift(newAvatar);
    persistStore();
    return newAvatar;
  },

  update(id: string, updates: Partial<AvatarItem>): AvatarItem | null {
    reloadFromDisk();
    const index = memoryAvatars.findIndex((a) => a.id === id && !a.deletedAt);
    if (index !== -1) {
      memoryAvatars[index] = {
        ...memoryAvatars[index],
        ...updates,
      };
      persistStore();
      return memoryAvatars[index];
    }
    return null;
  },

  delete(id: string): boolean {
    reloadFromDisk();
    const index = memoryAvatars.findIndex((a) => a.id === id && !a.deletedAt);
    if (index !== -1) {
      const avatar = memoryAvatars[index];
      const legacySourceKey = legacyAvatarSourceKey(avatar);
      if (legacySourceKey) {
        memoryAvatars[index] = {
          ...avatar,
          legacySourceKey,
          coverUrl: undefined,
          videoPath: undefined,
          deletedAt: Date.now(),
        };
      } else {
        memoryAvatars.splice(index, 1);
      }
      persistStore();
      return true;
    }
    return false;
  },
};
