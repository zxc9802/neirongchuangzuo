import assert from "node:assert/strict";
import test from "node:test";
import { validateMainAppSessionDetails } from "../src/lib/main-app-sso.ts";
import { reserveMainAppCredits } from "../src/lib/main-app-billing.ts";
import { sanitizePublicText, toPublicTask } from "../src/lib/server/public-data.ts";

test("SSO failure logs retain a diagnostic event without upstream text or credentials", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const entries = [];
  try {
    console.error = (...args) => entries.push(args);
    globalThis.fetch = async () => {
      throw Object.assign(new Error("UnknownVendor Bearer FAKE_SECRET https://private.example.test"), {
        code: "ECONNRESET",
        response: { secret: "FAKE_SECRET" },
      });
    };
    assert.equal((await validateMainAppSessionDetails({ token: "fake" })).status, "unavailable");
    const output = JSON.stringify(entries);
    assert.doesNotMatch(output, /UnknownVendor|FAKE_SECRET|https?:/);
    assert.match(output, /ECONNRESET/);
    assert.match(output, /sso/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("public task errors and legacy provider logs never depend on a vendor word list", () => {
  const raw = "UnknownVendor secret FAKE_SECRET at /app/private/file";
  const task = { id: "test", status: "failed", logs: [{ level: "error", message: raw }],
    inputs: {}, results: {}, error: raw };
  const output = toPublicTask(task);
  assert.doesNotMatch(JSON.stringify(output), /UnknownVendor|FAKE_SECRET|\/app/);
  assert.equal(task.logs[0].message, raw, "internal recovery data must be preserved");
  task.logs = [{ level: "info", message: raw, publicMessage: "正在合成配音" }];
  assert.equal(toPublicTask(task).logs[0].message, "正在合成配音");
});

test("public text strips bare credentials in headers and JSON", () => {
  for (const input of ['Authorization: Bearer FAKE_SECRET', '{"api_key":"FAKE_SECRET"}',
    'token=FAKE_SECRET', 'APP_SESSION_SECRET=FAKE_SECRET', 'sk-FAKE_SECRET_LONG_VALUE']) {
    assert.doesNotMatch(sanitizePublicText(input), /FAKE_SECRET/);
  }
});

test("billing errors expose a stable public code instead of upstream text", async () => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.MAIN_APP_SSO_CLIENT_SECRET;
  try {
    process.env.MAIN_APP_SSO_CLIENT_SECRET = "fake-client";
    globalThis.fetch = async () => Response.json({success: false,
      error: "UnknownVendor Bearer FAKE_SECRET", code: "SECRET_FAKE_SECRET"}, {status: 503});
    await assert.rejects(reserveMainAppCredits({user: {id: "u", role: "member"},
      sessionToken: "fake", estimatedDuration: 3}), error => {
        assert.doesNotMatch(`${error.message} ${error.code}`, /UnknownVendor|FAKE_SECRET/);
        assert.equal(error.code, "BILLING_RESERVE_FAILED");
        return true;
      });
    globalThis.fetch = async () => Response.json({success: false,
      error: "UnknownVendor FAKE_SECRET", code: "INSUFFICIENT_CREDITS"}, {status: 402});
    await assert.rejects(reserveMainAppCredits({user: {id: "u", role: "member"},
      sessionToken: "fake", estimatedDuration: 3}), error =>
        error.status === 402 && error.code === "INSUFFICIENT_POINTS" && /充值/.test(error.message));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.MAIN_APP_SSO_CLIENT_SECRET;
    else process.env.MAIN_APP_SSO_CLIENT_SECRET = originalSecret;
  }
});
