import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("ownerless cloud avatar metadata is assigned to the authenticated recovery admin", async () => {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "avatar-recovery-test-"));
  process.chdir(tempDir);

  const { CosService } = await import("../src/lib/cos.ts");
  const originals = {
    isConfigured: CosService.isConfigured,
    getJsonFromCos: CosService.getJsonFromCos,
    listFiles: CosService.listFiles,
    saveJsonToCos: CosService.saveJsonToCos,
  };
  let savedCloudRecords = null;
  CosService.isConfigured = () => true;
  CosService.getJsonFromCos = async () => [{
    id: "legacy-avatar",
    name: "Legacy avatar",
    videoUrl: "https://media.example.test/legacy.mp4",
    durationSeconds: 10,
    width: 720,
    height: 1280,
    fileSize: 1024,
    createdAt: 1,
    isCos: true,
  }];
  CosService.listFiles = async () => [];
  CosService.saveJsonToCos = async (_key, records) => {
    savedCloudRecords = records;
  };

  try {
    const { AvatarStore } = await import(
      `../src/lib/store/avatar-store.ts?legacy-recovery=${Date.now()}`
    );
    const avatars = await AvatarStore.getAllAsync("admin-user-id");
    assert.equal(avatars.length, 1);
    assert.equal(avatars[0].userId, "admin-user-id");
    assert.equal(savedCloudRecords[0].userId, "admin-user-id");

    const local = JSON.parse(
      await readFile(path.join(tempDir, ".runtime", "state", "avatars.json"), "utf8"),
    );
    assert.equal(local[0].userId, "admin-user-id");
  } finally {
    CosService.isConfigured = originals.isConfigured;
    CosService.getJsonFromCos = originals.getJsonFromCos;
    CosService.listFiles = originals.listFiles;
    CosService.saveJsonToCos = originals.saveJsonToCos;
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("admin recovery merges unindexed legacy videos into a non-empty cloud index without duplicates", async () => {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "avatar-reconcile-test-"));
  process.chdir(tempDir);

  const { CosService } = await import("../src/lib/cos.ts");
  const originals = {
    isConfigured: CosService.isConfigured,
    getJsonFromCos: CosService.getJsonFromCos,
    listFiles: CosService.listFiles,
    objectExists: CosService.objectExists,
    getObjectSize: CosService.getObjectSize,
    copyLegacyAvatarObject: CosService.copyLegacyAvatarObject,
    makeLegacyAvatarObjectPrivate: CosService.makeLegacyAvatarObjectPrivate,
    saveJsonToCos: CosService.saveJsonToCos,
  };
  let listCalls = 0;
  let savedCloudRecords = null;
  const copiedSizes = new Map();
  const sourceSizes = new Map([
    ["uploads/videos/1700000000000_legacy-one.mp4", 1024],
    ["uploads/videos/1700000000001_legacy-two.mov", 2048],
    ["uploads/thumbnails/1700000000001_legacy-two.mov.jpg", 512],
  ]);
  const copyCalls = [];
  const privateCalls = [];
  CosService.isConfigured = () => true;
  CosService.getJsonFromCos = async () => [
    {
      id: "current-avatar",
      userId: "admin-user-id",
      name: "Current avatar",
      videoUrl: "https://media.example.test/uploads/users/admin/videos/current.mp4",
      durationSeconds: 10,
      width: 720,
      height: 1280,
      fileSize: 1024,
      createdAt: 3,
      isCos: true,
    },
    {
      id: "already-indexed-legacy-avatar",
      userId: "admin-user-id",
      name: "Already indexed",
      videoUrl: CosService.getPublicUrl("uploads/videos/1700000000000_legacy-one.mp4"),
      durationSeconds: 10,
      width: 720,
      height: 1280,
      fileSize: 1024,
      createdAt: 2,
      isCos: true,
    },
  ];
  CosService.listFiles = async () => {
    listCalls += 1;
    return [
      {
        key: "uploads/videos/1700000000000_legacy-one.mp4",
        size: 1024,
        lastModified: "2026-08-20T00:00:00.000Z",
      },
      {
        key: "uploads/videos/1700000000001_legacy-two.mov",
        size: 2048,
        lastModified: "2026-08-21T00:00:00.000Z",
      },
      {
        key: "uploads/videos/nested/ignored.mp4",
        size: 4096,
        lastModified: "2026-08-22T00:00:00.000Z",
      },
      {
        key: "uploads/videos/readme.txt",
        size: 32,
        lastModified: "2026-08-22T00:00:00.000Z",
      },
    ];
  };
  CosService.objectExists = async (key) => sourceSizes.has(key);
  CosService.getObjectSize = async (key) => copiedSizes.get(key) ?? sourceSizes.get(key) ?? null;
  CosService.copyLegacyAvatarObject = async (sourceKey, targetKey) => {
    copyCalls.push([sourceKey, targetKey]);
    copiedSizes.set(targetKey, sourceSizes.get(sourceKey));
  };
  CosService.makeLegacyAvatarObjectPrivate = async (sourceKey, folder) => {
    privateCalls.push([sourceKey, folder]);
  };
  CosService.saveJsonToCos = async (_key, records) => {
    savedCloudRecords = records;
  };

  try {
    const { AvatarStore } = await import(
      `../src/lib/store/avatar-store.ts?legacy-reconcile=${Date.now()}`
    );
    const first = await AvatarStore.getAllAsync("admin-user-id");
    const second = await AvatarStore.getAllAsync("admin-user-id");

    assert.equal(first.length, 3);
    assert.equal(second.length, 3);
    assert.equal(listCalls, 1);
    assert.equal(copyCalls.length, 3);
    assert.equal(privateCalls.length, 3);

    const { isOwnedUploadSource, ownerKeyFor } = await import(
      "../src/lib/server/upload-policy.ts"
    );
    const ownerKey = ownerKeyFor("admin-user-id");
    const migratedExisting = first.find(
      (avatar) => avatar.id === "already-indexed-legacy-avatar",
    );
    const recovered = first.find((avatar) => avatar.name === "legacy-two");
    assert.match(
      migratedExisting.videoUrl,
      new RegExp(`/uploads/users/${ownerKey}/videos/legacy-[0-9a-f]{32}\\.mp4$`),
    );
    assert.equal(
      isOwnedUploadSource({
        source: migratedExisting.videoUrl,
        userId: "admin-user-id",
        folder: "videos",
      }),
      true,
    );
    assert.equal(recovered.userId, "admin-user-id");
    assert.equal(
      recovered.legacySourceKey,
      "uploads/videos/1700000000001_legacy-two.mov",
    );
    assert.match(
      recovered.videoUrl,
      new RegExp(`/uploads/users/${ownerKey}/videos/legacy-[0-9a-f]{32}\\.mov$`),
    );
    assert.match(
      recovered.coverUrl,
      new RegExp(`/uploads/users/${ownerKey}/thumbnails/legacy-[0-9a-f]{32}\\.jpg$`),
    );
    assert.equal(
      isOwnedUploadSource({
        source: recovered.coverUrl,
        userId: "admin-user-id",
        folder: "thumbnails",
      }),
      true,
    );
    assert.equal(savedCloudRecords.length, 3);

    const copiesAfterFirstAdmin = copyCalls.length;
    CosService.getJsonFromCos = async () => savedCloudRecords;
    const { AvatarStore: RestartedAvatarStore } = await import(
      `../src/lib/store/avatar-store.ts?legacy-reconcile-second-admin=${Date.now()}`
    );
    const afterSecondAdmin = await RestartedAvatarStore.getAllAsync("second-admin-user-id");
    assert.equal(afterSecondAdmin.length, 3);
    assert.equal(copyCalls.length, copiesAfterFirstAdmin);
    assert.equal(
      afterSecondAdmin.find((avatar) => avatar.id === recovered.id).userId,
      "admin-user-id",
    );
    assert.equal(
      afterSecondAdmin.find((avatar) => avatar.id === recovered.id).videoUrl,
      recovered.videoUrl,
    );
    assert.equal(privateCalls.length, 3);

    assert.equal(RestartedAvatarStore.delete(recovered.id), true);
    CosService.getJsonFromCos = async () => savedCloudRecords;
    const { AvatarStore: AfterDeleteAvatarStore } = await import(
      `../src/lib/store/avatar-store.ts?legacy-reconcile-after-delete=${Date.now()}`
    );
    const afterDeleteRestart = await AfterDeleteAvatarStore.getAllAsync("third-admin-user-id");
    assert.equal(afterDeleteRestart.some((avatar) => avatar.id === recovered.id), false);
    assert.equal(afterDeleteRestart.length, 2);
    assert.equal(copyCalls.length, copiesAfterFirstAdmin);
  } finally {
    CosService.isConfigured = originals.isConfigured;
    CosService.getJsonFromCos = originals.getJsonFromCos;
    CosService.listFiles = originals.listFiles;
    CosService.objectExists = originals.objectExists;
    CosService.getObjectSize = originals.getObjectSize;
    CosService.copyLegacyAvatarObject = originals.copyLegacyAvatarObject;
    CosService.makeLegacyAvatarObjectPrivate = originals.makeLegacyAvatarObjectPrivate;
    CosService.saveJsonToCos = originals.saveJsonToCos;
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("failed legacy copies keep the old record and retry on the next admin request", async () => {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "avatar-retry-test-"));
  process.chdir(tempDir);

  const { CosService } = await import("../src/lib/cos.ts");
  const originals = {
    isConfigured: CosService.isConfigured,
    getJsonFromCos: CosService.getJsonFromCos,
    listFiles: CosService.listFiles,
    getObjectSize: CosService.getObjectSize,
    copyLegacyAvatarObject: CosService.copyLegacyAvatarObject,
    makeLegacyAvatarObjectPrivate: CosService.makeLegacyAvatarObjectPrivate,
    saveJsonToCos: CosService.saveJsonToCos,
  };
  const sourceKey = "uploads/videos/1700000000002_retry.mp4";
  const sourceUrl = CosService.getPublicUrl(sourceKey);
  const copiedSizes = new Map();
  let listCalls = 0;
  let copyAttempts = 0;
  let savedCloudRecords = null;
  CosService.isConfigured = () => true;
  CosService.getJsonFromCos = async () => [{
    id: "retry-avatar",
    userId: "admin-user-id",
    name: "Retry avatar",
    videoUrl: sourceUrl,
    durationSeconds: 10,
    width: 720,
    height: 1280,
    fileSize: 1024,
    createdAt: 1,
    isCos: true,
  }];
  CosService.listFiles = async () => {
    listCalls += 1;
    return [{ key: sourceKey, size: 1024, lastModified: "2026-08-22T00:00:00.000Z" }];
  };
  CosService.getObjectSize = async (key) => copiedSizes.get(key) ?? null;
  CosService.copyLegacyAvatarObject = async (_sourceKey, targetKey) => {
    copyAttempts += 1;
    if (copyAttempts === 1) throw new Error("temporary copy failure");
    copiedSizes.set(targetKey, 1024);
  };
  CosService.makeLegacyAvatarObjectPrivate = async () => {};
  CosService.saveJsonToCos = async (_key, records) => {
    savedCloudRecords = records;
  };

  try {
    const { AvatarStore } = await import(
      `../src/lib/store/avatar-store.ts?legacy-retry=${Date.now()}`
    );
    const first = await AvatarStore.getAllAsync("admin-user-id");
    assert.equal(first[0].videoUrl, sourceUrl);
    assert.equal(savedCloudRecords, null);

    const second = await AvatarStore.getAllAsync("admin-user-id");
    assert.equal(listCalls, 2);
    assert.equal(copyAttempts, 2);
    assert.match(
      CosService.getManagedObjectKey(second[0].videoUrl) || "",
      /^uploads\/users\/[a-zA-Z0-9_-]+\/videos\/legacy-[0-9a-f]{32}\.mp4$/,
    );
    assert.equal(savedCloudRecords[0].videoUrl, second[0].videoUrl);
  } finally {
    CosService.isConfigured = originals.isConfigured;
    CosService.getJsonFromCos = originals.getJsonFromCos;
    CosService.listFiles = originals.listFiles;
    CosService.getObjectSize = originals.getObjectSize;
    CosService.copyLegacyAvatarObject = originals.copyLegacyAvatarObject;
    CosService.makeLegacyAvatarObjectPrivate = originals.makeLegacyAvatarObjectPrivate;
    CosService.saveJsonToCos = originals.saveJsonToCos;
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("legacy migration preserves edits made while an object copy is in flight", async () => {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "avatar-concurrent-edit-test-"));
  process.chdir(tempDir);

  const { CosService } = await import("../src/lib/cos.ts");
  const originals = {
    isConfigured: CosService.isConfigured,
    getJsonFromCos: CosService.getJsonFromCos,
    listFiles: CosService.listFiles,
    getObjectSize: CosService.getObjectSize,
    copyLegacyAvatarObject: CosService.copyLegacyAvatarObject,
    makeLegacyAvatarObjectPrivate: CosService.makeLegacyAvatarObjectPrivate,
    saveJsonToCos: CosService.saveJsonToCos,
  };
  const sourceKey = "uploads/videos/1700000000003_concurrent.mp4";
  const sourceUrl = CosService.getPublicUrl(sourceKey);
  const copiedSizes = new Map();
  let signalCopyStarted;
  const copyStarted = new Promise((resolve) => { signalCopyStarted = resolve; });
  let releaseCopy;
  const copyReleased = new Promise((resolve) => { releaseCopy = resolve; });

  CosService.isConfigured = () => true;
  CosService.getJsonFromCos = async () => [{
    id: "concurrent-avatar",
    userId: "admin-user-id",
    name: "before",
    videoUrl: sourceUrl,
    durationSeconds: 10,
    width: 720,
    height: 1280,
    fileSize: 1024,
    createdAt: 1,
    isCos: true,
  }];
  CosService.listFiles = async () => [{
    key: sourceKey,
    size: 1024,
    lastModified: "2026-08-22T00:00:00.000Z",
  }];
  CosService.getObjectSize = async (key) => copiedSizes.get(key) ?? null;
  CosService.copyLegacyAvatarObject = async (_sourceKey, targetKey) => {
    signalCopyStarted();
    await copyReleased;
    copiedSizes.set(targetKey, 1024);
  };
  CosService.makeLegacyAvatarObjectPrivate = async () => {};
  CosService.saveJsonToCos = async () => {};

  try {
    const { AvatarStore } = await import(
      `../src/lib/store/avatar-store.ts?legacy-concurrent-edit=${Date.now()}`
    );
    const migration = AvatarStore.getAllAsync("admin-user-id");
    await copyStarted;
    assert.equal(
      AvatarStore.update("concurrent-avatar", { name: "renamed-during-copy" })?.name,
      "renamed-during-copy",
    );
    releaseCopy();
    const avatars = await migration;
    assert.equal(avatars[0].name, "renamed-during-copy");
    assert.match(
      CosService.getManagedObjectKey(avatars[0].videoUrl) || "",
      /^uploads\/users\/[a-zA-Z0-9_-]+\/videos\/legacy-[0-9a-f]{32}\.mp4$/,
    );
  } finally {
    CosService.isConfigured = originals.isConfigured;
    CosService.getJsonFromCos = originals.getJsonFromCos;
    CosService.listFiles = originals.listFiles;
    CosService.getObjectSize = originals.getObjectSize;
    CosService.copyLegacyAvatarObject = originals.copyLegacyAvatarObject;
    CosService.makeLegacyAvatarObjectPrivate = originals.makeLegacyAvatarObjectPrivate;
    CosService.saveJsonToCos = originals.saveJsonToCos;
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});
