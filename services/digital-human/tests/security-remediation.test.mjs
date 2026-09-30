import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("SSO authorization uses authoritative current claims and a browser-bound login intent", async () => {
  const [sso, access, middleware, callback] = await Promise.all([
    read("src/lib/main-app-sso.ts"),
    read("src/lib/access-control.ts"),
    read("src/middleware.ts"),
    read("src/app/api/sso/callback/route.ts"),
  ]);

  assert.match(sso, /validateMainAppSessionDetails/);
  assert.match(access, /validateMainAppSessionDetails/);
  assert.match(access, /createRestrictedGraceSession/);
  assert.match(sso, /createMainAppSsoIntent/);
  assert.match(sso, /validateMainAppSsoIntent/);
  assert.match(middleware, /getMainAppSsoIntentCookieName/);
  assert.match(callback, /validateMainAppSsoIntent/);
  assert.match(callback, /getMainAppSsoIntentCookieName/);
});

test("billing requires an explicit success acknowledgement and gates unsettled outputs", async () => {
  const [billing, store, pipeline, recovery, publicData, mediaRoute] = await Promise.all([
    read("src/lib/main-app-billing.ts"),
    read("src/lib/store/task-store.ts"),
    read("src/lib/engine/pipeline.ts"),
    read("src/lib/engine/recover-lipsync.ts"),
    read("src/lib/server/public-data.ts"),
    read("src/app/api/tasks/[id]/media/[kind]/route.ts"),
  ]);

  assert.match(billing, /payload\.success !== true/);
  assert.match(billing, /BILLING_IDENTITY_MISSING/);
  assert.match(billing, /throw new MainAppBillingError/);
  assert.match(store, /"provider_committed"/);
  assert.match(store, /"settle_pending"/);
  assert.match(pipeline, /status: "provider_committed"/);
  assert.match(pipeline, /status: "settle_pending"/);
  assert.doesNotMatch(pipeline, /积分结算通知警告/);
  assert.match(recovery, /settleMainAppCredits/);
  assert.match(publicData, /isTaskOutputDeliverable/);
  assert.match(mediaRoute, /isTaskOutputDeliverable/);
});

test("resource-heavy routes have bounded execution, connection quotas and durable upload claims", async () => {
  const [ffmpeg, coverRoute, streamRoute, taskStore, uploads, uploadRoute, avatars, voices] = await Promise.all([
    read("src/lib/engine/ffmpeg.ts"),
    read("src/app/api/avatars/extract-cover/route.ts"),
    read("src/app/api/tasks/[id]/stream/route.ts"),
    read("src/lib/store/task-store.ts"),
    read("src/lib/server/upload-policy.ts"),
    read("src/app/api/upload/route.ts"),
    read("src/app/api/avatars/route.ts"),
    read("src/app/api/voices/route.ts"),
  ]);

  assert.match(ffmpeg, /timeoutMs/);
  assert.match(ffmpeg, /maxOutputBytes/);
  assert.match(ffmpeg, /SIGKILL/);
  assert.match(ffmpeg, /-max_alloc/);
  assert.match(ffmpeg, /-filter_threads/);
  assert.match(coverRoute, /acquireCoverExtractionSlot/);
  assert.match(coverRoute, /deleteOwnedUploadSourceEventually/);
  assert.match(streamRoute, /acquireTaskStreamSlot/);
  assert.match(streamRoute, /controller\.close\(\)/);
  assert.match(taskStore, /subscribers\.delete\(id\)/);
  assert.match(uploads, /reservePendingUpload/);
  assert.match(uploads, /claimPendingUpload/);
  assert.match(uploads, /cleanupExpiredPendingUploads/);
  assert.match(uploads, /withPendingUploadLock/);
  assert.match(uploads, /queueOwnedUploadDeletion/);
  assert.match(uploadRoute, /reservePendingUpload/);
  assert.match(avatars, /claimPendingUpload/);
  assert.match(voices, /claimPendingUpload/);
});

test("diagnostics, standalone MCP and browser cache no longer expose bearer material or task DTOs", async () => {
  const [diagnose, mcp, mcpClient, page, avatarsPage, voicesPage] = await Promise.all([
    read("src/app/api/sso/diagnose/route.ts"),
    read("scripts/heygen_mcp_sse_server.mjs"),
    read("src/lib/mcp/client.ts"),
    read("src/app/page.tsx"),
    read("src/app/avatars/page.tsx"),
    read("src/app/voices/page.tsx"),
  ]);

  assert.doesNotMatch(diagnose, /searchParams\.get\("token"\)/);
  assert.match(diagnose, /Authorization/);
  assert.match(mcp, /MCP_SSE_AUTH_TOKEN/);
  assert.match(mcp, /MCP_SSE_HOST/);
  assert.match(mcp, /timingSafeEqual/);
  assert.match(mcp, /MAX_PAID_CALLS_PER_HOUR/);
  assert.match(mcp, /consumePaidCallBudget/);
  assert.doesNotMatch(mcp, /args\.api_key/);
  assert.doesNotMatch(mcp, /Access-Control-Allow-Origin["']\s*,\s*["']\*["']/);
  assert.match(mcpClient, /Authorization/);
  assert.match(mcpClient, /authToken/);
  assert.doesNotMatch(page, /setItem\(["']cached_active_task_v2/);
  assert.match(page, /preselected_avatar_id/);
  assert.match(page, /preselected_voice_id/);
  assert.doesNotMatch(avatarsPage, /preselected_avatar["']\s*,\s*JSON\.stringify/);
  assert.doesNotMatch(voicesPage, /preselected_voice["']\s*,\s*JSON\.stringify/);
});

test("every provider-selected URL and relay redirect is policy checked before network access", async () => {
  const [policy, downloader, fal, relay] = await Promise.all([
    read("src/lib/server/outbound-url-policy.ts"),
    read("src/lib/engine/download-file.ts"),
    read("src/lib/engine/fal-veed-lipsync.ts"),
    read("cloud-functions/pixverse-ingest/app.js"),
  ]);

  assert.match(policy, /lookup/);
  assert.match(policy, /redirect:\s*["']manual["']/);
  assert.match(policy, /isPrivateOrReservedAddress/);
  assert.match(downloader, /urlPolicy/);
  assert.match(downloader, /fetchWithOutboundUrlPolicy/);
  assert.match(fal, /validateOutboundUrl/);
  assert.match(fal, /assertSameOrigin/);
  assert.match(relay, /dns\.promises\.lookup/);
  assert.match(relay, /requestPinned/);
  assert.match(relay, /lookup:/);
  assert.match(relay, /new URL\(location, current\.url\)/);
  assert.match(relay, /MAX_DOWNLOAD_BYTES/);
  assert.match(relay, /COS_KEY_RE/);
});
