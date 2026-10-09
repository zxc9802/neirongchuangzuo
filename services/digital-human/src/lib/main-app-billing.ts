import { randomUUID } from "node:crypto";
import { logServerError } from "./server/safe-log";
import { estimateScriptDuration } from "./billing-estimate";
import {
  getWorkspaceCreditsLedger, calculateWorkspacePoints, workspaceCreditsSnapshot,
  WORKSPACE_VIDEO_POINTS, WORKSPACE_VIDEO_SECONDS,
} from "./server/workspace-credits";
export { CHARACTERS_PER_SECOND, estimateScriptDuration } from "./billing-estimate";
import {
  getMainAppSessionCookieName,
  getMainAppUrl,
  readMainAppSessionCookie,
  type MainAppSession,
  type MainAppUser,
} from "./main-app-sso";

export const POINTS_PER_SECOND = 20;
export const CNY_PER_SECOND = 0.2;
export const POINTS_PER_CNY = 100;
export type BillingSource = "workspace" | "main-app" | "internal";

export function billingSource(user?: Partial<MainAppUser> | null): BillingSource {
  if (user?.billingAudience === "standalone") return "workspace";
  return isExternallyBilledUser(user) ? "main-app" : "internal";
}

function workspaceBillingError(error: any): MainAppBillingError {
  const insufficient = error?.status === 402 || error?.statusCode === 402;
  return new MainAppBillingError(insufficient ? "积分余额不足，请缩短文案后重试" : "积分服务暂时不可用，请稍后重试",
    insufficient ? 402 : 503, insufficient ? "INSUFFICIENT_POINTS" : "BILLING_SERVICE_UNAVAILABLE");
}

export class MainAppBillingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status = 400,
    code = "MAIN_APP_BILLING_ERROR",
  ) {
    super(message);
    this.name = "MainAppBillingError";
    this.status = status;
    this.code = code;
  }
}

/**
 * 判断用户是否为需要按 20 积分/秒计费的主站外部注册用户
 */
export function isExternallyBilledUser(
  user?: Partial<MainAppUser> | null,
): boolean {
  if (!user) return false;
  if (user.billingAudience === "standalone") return false;
  if (user.role === "admin") return false;
  if (
    user.billingAudience === "internal" ||
    user.groupName === "内部用户" ||
    user.groupName === "管理员"
  ) {
    return false;
  }
  if (
    user.billingAudience === "external" ||
    user.groupName === "外部用户"
  ) {
    return true;
  }
  // 默认普通注册用户均视为外部计费用户
  return user.role !== "admin";
}

/**
 * 根据视频/音频时长计算所需积分（20 积分/秒 = 0.20 元/秒，向上取整）
 */
export function calculateRequiredPoints(durationSeconds: number, source?: BillingSource): number {
  const seconds = Math.max(0, Number(durationSeconds) || 0);
  if (source === "workspace") return calculateWorkspacePoints(seconds);
  return Math.ceil(seconds * POINTS_PER_SECOND);
}

export function assertTaskCreditCoverage(
  billing: { isExternalUser: boolean; status: string; reservedPoints?: number; source?: BillingSource } | undefined,
  durationSeconds: number,
): void {
  if (!billing?.isExternalUser) return;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
    billing.status !== "reserved" || !Number.isSafeInteger(billing.reservedPoints) ||
    (billing.reservedPoints || 0) < calculateRequiredPoints(durationSeconds, billing.source)) {
    throw new MainAppBillingError(
      "实际配音超出预留额度，请缩短文案后重试",
      402,
      "BILLING_RESERVATION_TOO_SMALL",
    );
  }
}

export async function extendTaskCreditCoverage(input: {
  userId?: string;
  billing: { isExternalUser: boolean; source?: BillingSource; status: string; requestId?: string; reservedPoints?: number } | undefined;
  durationSeconds: number;
}): Promise<number | undefined> {
  const current = input.billing;
  if (current?.source !== "workspace" || !current.isExternalUser) {
    assertTaskCreditCoverage(current, input.durationSeconds);
    return current?.reservedPoints;
  }
  if (!input.userId || !current.requestId || current.status !== "reserved") {
    throw new MainAppBillingError("任务缺少有效积分预留", 500, "BILLING_IDENTITY_MISSING");
  }
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    throw new MainAppBillingError("实际配音时长无效，不能继续生成", 400, "BILLING_DURATION_INVALID");
  }
  try {
    const result = await getWorkspaceCreditsLedger().extendReservation({
      userId: input.userId, taskId: current.requestId, units: input.durationSeconds,
    });
    assertLedgerReservationActive(result);
    // Only the ledger response can exempt this task; the persisted task flag is display metadata.
    if (result.exempt !== true) {
      assertTaskCreditCoverage({ ...current, reservedPoints: result.reservedPoints }, input.durationSeconds);
    }
    return result.reservedPoints;
  } catch (error) {
    if (error instanceof MainAppBillingError) throw error;
    throw workspaceBillingError(error);
  }
}

function assertLedgerReservationActive(reservation: { status: string; reservedPoints: number; exempt?: boolean } | null): void {
  if (reservation?.status !== "reserved" || !Number.isSafeInteger(reservation.reservedPoints) ||
    reservation.reservedPoints < 0 || (reservation.reservedPoints === 0 && reservation.exempt !== true)) {
    throw new MainAppBillingError("积分预留已结束，请重新创建任务", 409, "BILLING_RESERVATION_CLOSED");
  }
}

export async function assertWorkspaceReservationActive(userId: string, requestId: string): Promise<void> {
  const reservation = await getWorkspaceCreditsLedger().reservation(userId, requestId);
  assertLedgerReservationActive(reservation);
}

/**
 * 根据视频/音频时长计算人民币金额（0.20 元/秒）
 */
export function calculateCostCny(durationSeconds: number, source?: BillingSource): number {
  if (source === "workspace") return 0;
  const seconds = Math.max(0, Number(durationSeconds) || 0);
  return Number((seconds * CNY_PER_SECOND).toFixed(2));
}

/**
 * 综合输入预估任务时长（优先使用已知视频时长或文案预估）
 */
export function estimateTaskDuration(inputs: {
  scriptText?: string;
  videoDuration?: number;
}): number {
  if (inputs.videoDuration && inputs.videoDuration > 0) {
    return Number(inputs.videoDuration.toFixed(1));
  }
  if (inputs.scriptText) {
    return estimateScriptDuration(inputs.scriptText);
  }
  return 5;
}

/**
 * 获取当前请求中的 SSO 用户及会话
 */
export async function getCurrentSsoSession(
  cookieValue?: string,
): Promise<MainAppSession | null> {
  if (cookieValue) {
    return readMainAppSessionCookie(cookieValue);
  }
  try {
    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    const val = cookieStore.get(getMainAppSessionCookieName())?.value;
    return readMainAppSessionCookie(val);
  } catch {
    return null;
  }
}

interface BillingRequestOptions {
  action: "reserve" | "settle" | "release";
  userId: string;
  requestId: string;
  operation?: string;
  durationSeconds?: number;
  points?: number;
  token?: string;
}

async function postBillingApi(
  options: BillingRequestOptions,
): Promise<{ success: boolean; data?: any; error?: string; code?: string }> {
  const clientSecret = process.env.MAIN_APP_SSO_CLIENT_SECRET?.trim();
  const mainAppUrl = getMainAppUrl();

  const body = {
    product: "shuziren",
    userId: options.userId,
    action: options.action,
    requestId: options.requestId,
    operation: options.operation || "lipsync_digital_human",
    duration: options.durationSeconds,
    billableUnits: options.durationSeconds,
    ratePerSecond: POINTS_PER_SECOND,
    points: options.points,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (clientSecret) {
    headers["x-qycm-sso-client-secret"] = clientSecret;
  }
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  try {
    const response = await fetch(`${mainAppUrl}/api/sso/billing`, {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      data?: any;
      error?: string;
      message?: string;
      code?: string;
    };

    if (!response.ok || payload.success !== true) {
      logServerError(`billing.${options.action}_rejected`, { status: response.status });
      const insufficient = response.status === 402 ||
        payload.code === "INSUFFICIENT_CREDITS" || payload.code === "INSUFFICIENT_POINTS";
      return {
        success: false,
        error: insufficient ? "积分余额不足" : "积分服务暂时不可用，请稍后重试",
        code: insufficient ? "INSUFFICIENT_POINTS" : "BILLING_SERVICE_UNAVAILABLE",
      };
    }

    return {
      success: true,
      data: payload.data,
    };
  } catch (err: any) {
    logServerError(`billing.${options.action}_request_failed`, err);
    return {
      success: false,
      error: "积分服务连接失败，请稍后重试",
      code: "NETWORK_ERROR",
    };
  }
}

/**
 * 任务启动前预留/冻结积分
 */
export async function reserveMainAppCredits(input: {
  user: Partial<MainAppUser>;
  sessionToken?: string;
  taskId?: string;
  estimatedDuration: number;
  minimumDuration?: number;
  beforeReserve?: (reservation: { source: "workspace"; requestId: string; chargeRequired: true;
    requiredPoints: number; reservedPoints: number; estimatedDuration: number; costCny: number; exempt?: boolean }) => void | Promise<void>;
}): Promise<{
  source: BillingSource;
  requestId: string;
  chargeRequired: boolean;
  requiredPoints: number;
  reservedPoints: number;
  estimatedDuration: number;
  costCny: number;
  pointsBalance?: number;
  exempt?: boolean;
}> {
  const source = billingSource(input.user);
  const chargeRequired = source !== "internal";
  const requiredPoints = chargeRequired
    ? calculateRequiredPoints(input.estimatedDuration, source)
    : 0;
  const costCny = chargeRequired
    ? calculateCostCny(input.estimatedDuration, source)
    : 0;
  const requestId = input.taskId || randomUUID();

  if (!chargeRequired) {
    return {
      source,
      requestId,
      chargeRequired: false,
      requiredPoints: 0,
      reservedPoints: 0,
      estimatedDuration: input.estimatedDuration,
      costCny: 0,
    };
  }

  if (source === "workspace") {
    if (!input.user.id || !Number.isFinite(input.estimatedDuration) || input.estimatedDuration <= 0) {
      throw new MainAppBillingError("任务缺少有效计费信息", 400, "BILLING_IDENTITY_MISSING");
    }
    // Persist the request identity before the ledger can commit, including lost-response failures.
    await input.beforeReserve?.({ source: "workspace", requestId, chargeRequired: true,
      requiredPoints, reservedPoints: 0, estimatedDuration: input.estimatedDuration, costCny: 0 });
    try {
      const wallet = await workspaceCreditsSnapshot(input.user.id);
      const minimumPoints = calculateRequiredPoints(input.minimumDuration ?? input.estimatedDuration, source);
      if (wallet.unlimited !== true && wallet.available < minimumPoints) {
        throw new MainAppBillingError(`积分余额不足：本次预计至少需要 ${minimumPoints} 积分`, 402, "INSUFFICIENT_POINTS");
      }
      // Only the conservative duration margin may be truncated; real audio is checked again before lip-sync.
      const units = wallet.unlimited === true || requiredPoints <= wallet.available ? input.estimatedDuration
        : Math.max(0, wallet.available * WORKSPACE_VIDEO_SECONDS / WORKSPACE_VIDEO_POINTS - 1e-8);
      const reserved = await getWorkspaceCreditsLedger().reserve({
        userId: input.user.id, taskId: requestId, kind: "digital-human", units,
      });
      assertLedgerReservationActive(reserved);
      return { source, requestId, chargeRequired: true, requiredPoints: reserved.exempt === true ? 0 : requiredPoints,
        reservedPoints: reserved.reservedPoints, estimatedDuration: input.estimatedDuration,
        costCny: 0, pointsBalance: reserved.wallet.available, exempt: reserved.exempt === true };
    } catch (error) {
      if (error instanceof MainAppBillingError) throw error;
      throw workspaceBillingError(error);
    }
  }

  if (!input.user.id || !input.sessionToken || !Number.isFinite(input.estimatedDuration) || input.estimatedDuration <= 0) {
    throw new MainAppBillingError("任务缺少有效计费信息", 400, "BILLING_IDENTITY_MISSING");
  }

  // 调用主站进行积分预留
  const result = await postBillingApi({
    action: "reserve",
    userId: input.user.id,
    requestId,
    durationSeconds: input.estimatedDuration,
    points: requiredPoints,
    token: input.sessionToken,
  });

  if (!result.success) {
    if (
      result.code === "INSUFFICIENT_CREDITS" ||
      result.code === "INSUFFICIENT_POINTS" ||
      (result.error && result.error.includes("余额不足"))
    ) {
      throw new MainAppBillingError(
        `积分余额不足：本次生成预计约 ${input.estimatedDuration} 秒，需消耗 ${requiredPoints} 积分（0.20元/秒），请充值后再试。`,
        402,
        "INSUFFICIENT_POINTS",
      );
    }
    throw new MainAppBillingError(
      "积分预留失败，请稍后重试",
      503,
      "BILLING_RESERVE_FAILED",
    );
  }

  const reservedPoints = Number(result.data?.reservedCredits);
  if (!Number.isSafeInteger(reservedPoints) || reservedPoints < requiredPoints ||
    result.data?.requestId !== requestId || result.data?.chargeRequired !== true) {
    // No paid work has started. Release this same reservation, never create another one.
    await releaseMainAppCredits({ userId: input.user.id, requestId, sessionToken: input.sessionToken });
    throw new MainAppBillingError("积分预留未得到确认，请稍后重试", 503, "BILLING_RESERVATION_UNCONFIRMED");
  }

  return {
    source,
    requestId,
    chargeRequired: true,
    requiredPoints,
    reservedPoints,
    estimatedDuration: input.estimatedDuration,
    costCny,
    pointsBalance: result.data?.pointsBalance,
  };
}

/**
 * 任务完成后按最终视频实际时长实扣结算积分
 */
export async function settleMainAppCredits(input: {
  userId: string;
  requestId: string;
  actualDuration: number;
  chargedPoints?: number;
  sessionToken?: string;
  source?: BillingSource;
}): Promise<{
  chargedPoints: number;
  costCny: number;
  actualDuration: number;
  pointsBalance?: number;
}> {
  const actualDuration = Number(input.actualDuration);
  if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
    throw new MainAppBillingError("成片时长无效，暂时不能结算", 400, "BILLING_DURATION_INVALID");
  }
  const chargedPoints =
    input.source === "workspace" ? calculateRequiredPoints(actualDuration, input.source)
      : input.chargedPoints ?? calculateRequiredPoints(actualDuration);
  const costCny = calculateCostCny(actualDuration, input.source);

  if (!input.userId || !input.requestId) {
    throw new MainAppBillingError(
      "任务缺少主站积分结算标识",
      500,
      "BILLING_IDENTITY_MISSING",
    );
  }

  if (input.source === "workspace") {
    try {
      const result = await getWorkspaceCreditsLedger().settle({
        userId: input.userId, taskId: input.requestId, units: actualDuration,
      });
      return { chargedPoints: result.chargedPoints, costCny: 0, actualDuration, pointsBalance: result.wallet.available };
    } catch {
      throw new MainAppBillingError("积分结算暂未完成，请稍后恢复任务", 503, "BILLING_SETTLEMENT_FAILED");
    }
  }

  const result = await postBillingApi({
    action: "settle",
    userId: input.userId,
    requestId: input.requestId,
    durationSeconds: actualDuration,
    points: chargedPoints,
    token: input.sessionToken,
  });

  if (!result.success) {
    throw new MainAppBillingError(
      "积分结算暂未完成，请稍后恢复任务",
      503,
      "BILLING_SETTLEMENT_FAILED",
    );
  }

  return {
    chargedPoints,
    costCny,
    actualDuration,
    pointsBalance: result.data?.pointsBalance,
  };
}

/**
 * 任务失败时全额解冻释放预留积分
 */
export async function releaseMainAppCredits(input: {
  userId: string;
  requestId: string;
  sessionToken?: string;
  source?: BillingSource;
}): Promise<void> {
  if (!input.userId || !input.requestId) {
    throw new MainAppBillingError(
      "任务缺少主站积分释放标识",
      500,
      "BILLING_IDENTITY_MISSING",
    );
  }

  if (input.source === "workspace") {
    try {
      await getWorkspaceCreditsLedger().release({ userId: input.userId, taskId: input.requestId });
      return;
    } catch {
      throw new MainAppBillingError("积分释放暂未完成，请稍后重试", 503, "BILLING_RELEASE_FAILED");
    }
  }

  const result = await postBillingApi({
    action: "release",
    userId: input.userId,
    requestId: input.requestId,
    token: input.sessionToken,
  });
  if (!result.success) {
    throw new MainAppBillingError(
      "积分释放暂未完成，请稍后重试",
      503,
      "BILLING_RELEASE_FAILED",
    );
  }
}
