import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("shuziren site keeps the main-site SSO callback and encrypted session contract", async () => {
  const [sso, callback, session, middleware, env] = await Promise.all([
    read("src/lib/main-app-sso.ts"),
    read("src/app/api/sso/callback/route.ts"),
    read("src/app/api/sso/session/route.ts"),
    read("src/middleware.ts"),
    read(".env.example"),
  ]);

  assert.match(sso, /const PRODUCT = ["']shuziren["']/);
  assert.match(sso, /const COOKIE_NAME = ["']qycm_shuziren_sso_v2["']/);
  assert.match(sso, /https:\/\/shuziren\.qycm\.top/);
  assert.match(sso, /externalSso/);
  assert.match(sso, /AES-GCM/);
  assert.match(sso, /expiresAt > Date\.now\(\)/);
  assert.match(sso, /\/api\/sso\/session/);
  assert.match(callback, /exchangeMainAppSsoTicket/);
  assert.match(callback, /createMainAppSessionCookie/);
  assert.match(session, /validateMainAppSession/);
  assert.match(middleware, /api\/sso\/callback/);
  assert.match(middleware, /export const runtime = ["']nodejs["']/);
  assert.match(middleware, /request\.nextUrl\.pathname\.startsWith\(["']\/api\/["']\)/);
  assert.match(middleware, /getMainAppSsoLaunchUrl/);
  assert.match(env, /MAIN_APP_SSO_EXCHANGE_URL=https:\/\/www\.qycm\.top\/api\/external-sso\/shuziren\/exchange/);
  assert.match(env, /MAIN_APP_SSO_CLIENT_SECRET=/);
  assert.match(env, /APP_SESSION_SECRET=/);
});

test("shuziren SSO tolerates main-site cold starts without creating a login loop", async () => {
  const [sso, callback, sessionRoute, middleware] = await Promise.all([
    read("src/lib/main-app-sso.ts"),
    read("src/app/api/sso/callback/route.ts"),
    read("src/app/api/sso/session/route.ts"),
    read("src/middleware.ts"),
  ]);

  assert.match(sso, /const SSO_EXCHANGE_TIMEOUT_MS = 30_000/);
  assert.match(sso, /const SSO_SESSION_VALIDATION_TIMEOUT_MS = 20_000/);
  assert.match(sso, /validatedAt: number/);
  assert.match(sso, /isMainAppSessionWithinValidationGrace/);
  assert.match(sso, /\|\s*"valid"\s*\|\s*"invalid"\s*\|\s*"unavailable"/);
  assert.match(sso, /status: "unavailable"/);

  assert.match(callback, /Cache-Control["']?,\s*["']private, no-store["']/);

  const outageStart = middleware.indexOf("// 4. Main site temporarily unavailable");
  const invalidSessionStart = middleware.indexOf("// 5. Session invalid or missing");
  assert.ok(outageStart >= 0, "middleware must handle upstream outages separately");
  assert.ok(invalidSessionStart > outageStart, "outage handling must precede invalid-session handling");
  const middlewareOutageSection = middleware.slice(outageStart, invalidSessionStart);
  assert.match(middlewareOutageSection, /isMainAppSessionWithinValidationGrace/);
  assert.match(middlewareOutageSection, /status:\s*503/);
  assert.doesNotMatch(middlewareOutageSection, /cookies\.set/);

  assert.match(sessionRoute, /sessionValidation === "unavailable"/);
  assert.match(sessionRoute, /isMainAppSessionWithinValidationGrace/);
  assert.match(sessionRoute, /status:\s*503/);
});

test("fresh encrypted SSO sessions can use the bounded validation grace", async () => {
  const sso = await import("../src/lib/main-app-sso.ts");
  const previousSecret = process.env.APP_SESSION_SECRET;
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  process.env.APP_SESSION_SECRET = "test-only-session-secret";
  console.error = () => {};

  try {
    const now = Date.now();
    const freshSession = {
      token: "fresh-test-token",
      user: {
        id: "user-1",
        account: "user@example.com",
        nickname: "Tester",
        role: "member",
      },
      expiresAt: now + 60_000,
      validatedAt: now,
    };
    const encrypted = await sso.createMainAppSessionCookie(freshSession);
    assert.match(encrypted, /^v2\./);
    const decrypted = await sso.readMainAppSessionCookie(encrypted);
    assert.deepEqual(decrypted, freshSession);
    assert.equal(
      await sso.readMainAppSessionCookie(encrypted.replace(/^v2\./, "v1.")),
      null,
    );
    assert.equal(sso.isMainAppSessionWithinValidationGrace(freshSession), true);

    globalThis.fetch = async () => {
      throw new Error("simulated upstream timeout");
    };
    assert.equal(await sso.validateMainAppSession(freshSession), "unavailable");

    const staleSession = {
      ...freshSession,
      token: "stale-test-token",
      validatedAt: now - 5 * 60_000 - 1,
    };
    assert.equal(sso.isMainAppSessionWithinValidationGrace(staleSession), false);

    globalThis.fetch = async () => new Response("{}", { status: 401 });
    assert.equal(await sso.validateMainAppSession(staleSession), "invalid");

    globalThis.fetch = async () => new Response("{}", { status: 503 });
    assert.equal(
      await sso.validateMainAppSession({
        ...staleSession,
        token: "unavailable-http-test-token",
      }),
      "unavailable",
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (previousSecret === undefined) delete process.env.APP_SESSION_SECRET;
    else process.env.APP_SESSION_SECRET = previousSecret;
  }
});
