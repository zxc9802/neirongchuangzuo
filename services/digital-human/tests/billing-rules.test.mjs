// 计费规则的运行时行为：谁该扣费、扣多少、时长如何预估。这里直接调用函数，
// 补充现有基于源码正则的 main-app-billing.test.mjs。
import assert from "node:assert/strict";
import test from "node:test";

const billing = await import("../src/lib/main-app-billing.ts");
const { estimateReservationDuration } = await import("../src/lib/billing-estimate.ts");

test("reservation estimates include a margin without charging for the full avatar source length", () => {
  assert.equal(estimateReservationDuration("你好"), 6);
  assert.equal(estimateReservationDuration("一".repeat(44)), 15);
  assert.equal(estimateReservationDuration(""), 0);
});

test("rate constants are mutually consistent (20 points/s == 0.20 CNY/s at 100 points per CNY)", () => {
  assert.equal(billing.POINTS_PER_SECOND, 20);
  assert.equal(billing.CNY_PER_SECOND, 0.2);
  assert.equal(billing.POINTS_PER_CNY, 100);
  assert.equal(billing.POINTS_PER_SECOND / billing.POINTS_PER_CNY, billing.CNY_PER_SECOND);
  assert.ok(billing.CHARACTERS_PER_SECOND > 0);
});

test("isExternallyBilledUser: admins and internal groups are free, everyone else pays by default", () => {
  const external = (user) => billing.isExternallyBilledUser(user);

  assert.equal(external(undefined), false, "无用户信息时不能凭空扣费");
  assert.equal(external(null), false);

  assert.equal(external({ role: "admin" }), false);
  assert.equal(external({ role: "admin", billingAudience: "external" }), false, "管理员即使被标为 external 也不扣费");
  assert.equal(external({ role: "member", billingAudience: "internal" }), false);
  assert.equal(external({ role: "member", groupName: "内部用户" }), false);
  assert.equal(external({ role: "member", groupName: "管理员" }), false);

  assert.equal(external({ role: "member", billingAudience: "external" }), true);
  assert.equal(external({ role: "member", groupName: "外部用户" }), true);
  assert.equal(external({ role: "member" }), true, "普通注册用户默认按外部计费");
  assert.equal(external({ role: "user", groupName: "VIP" }), true);
  assert.equal(external({ role: "member", billingAudience: "unknown-value" }), true);
  assert.equal(external({}), true, "缺少角色信息时保守按外部计费");
});

test("calculateRequiredPoints rounds up to whole points and never goes negative", () => {
  assert.equal(billing.calculateRequiredPoints(0), 0);
  assert.equal(billing.calculateRequiredPoints(1), 20);
  assert.equal(billing.calculateRequiredPoints(10), 200);
  assert.equal(billing.calculateRequiredPoints(12.04), 241, "12.04s × 20 = 240.8 → 向上取整 241");
  assert.equal(billing.calculateRequiredPoints(0.01), 1, "任意非零时长至少 1 积分");
  assert.equal(billing.calculateRequiredPoints(-5), 0);
  assert.equal(billing.calculateRequiredPoints(Number.NaN), 0);
  assert.equal(billing.calculateRequiredPoints("7"), 140, "字符串数字应被容忍");
  assert.equal(billing.calculateRequiredPoints("abc"), 0);
});

test("calculateCostCny keeps two decimals and matches the points rate", () => {
  assert.equal(billing.calculateCostCny(0), 0);
  assert.equal(billing.calculateCostCny(1), 0.2);
  assert.equal(billing.calculateCostCny(7.5), 1.5);
  assert.equal(billing.calculateCostCny(12.04), 2.41);
  assert.equal(billing.calculateCostCny(-1), 0);
  assert.equal(billing.calculateCostCny(Number.NaN), 0);

  for (const seconds of [3, 15, 42.7, 120]) {
    const points = billing.calculateRequiredPoints(seconds);
    const cny = billing.calculateCostCny(seconds);
    assert.ok(
      Math.abs(points / billing.POINTS_PER_CNY - cny) < 0.011,
      `${seconds}s: ${points} 积分 vs ${cny} 元 应在取整误差内一致`
    );
  }
});

test("estimateScriptDuration is derived from character count with a 3 second floor", () => {
  assert.equal(billing.estimateScriptDuration(""), 0);
  assert.equal(billing.estimateScriptDuration("   "), 0);
  assert.equal(billing.estimateScriptDuration(undefined), 0);
  assert.equal(billing.estimateScriptDuration("你好"), 3, "极短文案也至少按 3 秒预留");
  assert.equal(billing.estimateScriptDuration("一".repeat(44)), 10);
  assert.equal(billing.estimateScriptDuration("一".repeat(45)), 11);
  assert.equal(billing.estimateScriptDuration(`  ${"一".repeat(44)}  `), 10, "首尾空白不计入");

  const short = billing.estimateScriptDuration("一".repeat(100));
  const long = billing.estimateScriptDuration("一".repeat(1000));
  assert.ok(long > short, "更长的文案必须预估更长时长");
});

test("estimateTaskDuration prefers a known video duration, then the script, then a fixed fallback", () => {
  assert.equal(billing.estimateTaskDuration({ videoDuration: 12.34, scriptText: "一".repeat(1000) }), 12.3);
  assert.equal(billing.estimateTaskDuration({ videoDuration: 0, scriptText: "一".repeat(44) }), 10);
  assert.equal(billing.estimateTaskDuration({ videoDuration: -3, scriptText: "一".repeat(44) }), 10);
  assert.equal(billing.estimateTaskDuration({ scriptText: "你好" }), 3);
  assert.equal(billing.estimateTaskDuration({}), 5);
  assert.equal(billing.estimateTaskDuration({ scriptText: "" }), 5);
});

test("MainAppBillingError carries an HTTP status and machine-readable code for the API layer", () => {
  const defaults = new billing.MainAppBillingError("余额不足");
  assert.ok(defaults instanceof Error);
  assert.equal(defaults.name, "MainAppBillingError");
  assert.equal(defaults.message, "余额不足");
  assert.equal(defaults.status, 400);
  assert.equal(defaults.code, "MAIN_APP_BILLING_ERROR");

  const custom = new billing.MainAppBillingError("积分不足", 402, "INSUFFICIENT_BALANCE");
  assert.equal(custom.status, 402);
  assert.equal(custom.code, "INSUFFICIENT_BALANCE");
});

test("external reservations require the main ledger to confirm sufficient held credits", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const data of [{}, { reservedCredits: 59 }, { reservedCredits: 60, chargeRequired: false }]) {
      globalThis.fetch = async () => Response.json({ success: true, data });
      await assert.rejects(billing.reserveMainAppCredits({
        user: { id: "owner", role: "member" }, sessionToken: "fake", estimatedDuration: 3,
      }), error => error.code === "BILLING_RESERVATION_UNCONFIRMED");
    }
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json({ success: true, data: { reservedCredits: 60, requestId: body.requestId, chargeRequired: true } });
    };
    const reserved = await billing.reserveMainAppCredits({
      user: { id: "owner", role: "member" }, sessionToken: "fake", estimatedDuration: 3,
    });
    assert.equal(reserved.reservedPoints, 60);
  } finally { globalThis.fetch = originalFetch; }
});

test("settle and release fail closed unless the main ledger returns success=true", async () => {
  const originalFetch = globalThis.fetch;
  const previousMainAppUrl = process.env.MAIN_APP_URL;
  process.env.MAIN_APP_URL = "https://main.example.test";
  try {
    for (const response of [
      new Response("{}", { status: 200 }),
      Response.json({ success: false, code: "LEDGER_DOWN", error: "down" }, { status: 503 }),
    ]) {
      globalThis.fetch = async () => response.clone();
      await assert.rejects(
        billing.settleMainAppCredits({
          userId: "user-1",
          requestId: "request-1",
          actualDuration: 3,
          sessionToken: "token",
        }),
        billing.MainAppBillingError,
      );
      await assert.rejects(
        billing.releaseMainAppCredits({
          userId: "user-1",
          requestId: "request-1",
          sessionToken: "token",
        }),
        billing.MainAppBillingError,
      );
    }

    globalThis.fetch = async () => Response.json({
      success: true,
      data: { pointsBalance: 940 },
    });
    const settled = await billing.settleMainAppCredits({
      userId: "user-1",
      requestId: "request-1",
      actualDuration: 3,
      sessionToken: "token",
    });
    assert.equal(settled.chargedPoints, 60);
    assert.equal(settled.pointsBalance, 940);
    await billing.releaseMainAppCredits({
      userId: "user-1",
      requestId: "request-2",
      sessionToken: "token",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousMainAppUrl === undefined) delete process.env.MAIN_APP_URL;
    else process.env.MAIN_APP_URL = previousMainAppUrl;
  }
});

test("settle and release refuse missing ledger identity before making a request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ success: true });
  };
  try {
    await assert.rejects(
      billing.settleMainAppCredits({
        userId: "",
        requestId: "request-1",
        actualDuration: 3,
        sessionToken: "token",
      }),
      (error) => error?.code === "BILLING_IDENTITY_MISSING",
    );
    await assert.rejects(
      billing.releaseMainAppCredits({
        userId: "user-1",
        requestId: "",
        sessionToken: "token",
      }),
      (error) => error?.code === "BILLING_IDENTITY_MISSING",
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
