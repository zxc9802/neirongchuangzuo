import { getAppConfig, saveAppConfig } from "../config";

export interface HeyGenQuotaInfo {
  success: boolean;
  quota?: number;
  remainingQuota?: number;
  planName?: string;
  error?: string;
}

function getAuthHeaders(token: string) {
  const clean = token.trim();
  const rawKey = clean.replace(/^Bearer\s+/i, "");
  const bearer = clean.startsWith("Bearer ") ? clean : `Bearer ${clean}`;
  return {
    "X-Api-Key": rawKey,
    "Authorization": bearer,
    "Accept": "application/json",
  };
}

export class HeyGenDirectMcpProvider {
  public static async getQuota(): Promise<HeyGenQuotaInfo> {
    const config = getAppConfig();
    const apiKey = config.heygenApiKey?.trim();
    const baseUrl = (config.heygenApiBaseUrl || "https://api.heygen.com").replace(/\/$/, "");

    if (!apiKey) {
      return {
        success: false,
        error: "尚未填入 HeyGen 账号套餐 Token",
      };
    }

    const authHeaders = getAuthHeaders(apiKey);

    try {
      // 1. Try remaining quota endpoint
      const resp = await fetch(`${baseUrl}/v1/user/remaining_quota`, {
        method: "GET",
        headers: authHeaders,
        redirect: "error",
      });

      const data = await resp.json().catch(() => ({}));

      if (resp.ok && data.code === 100) {
        return {
          success: true,
          quota: data.data?.quota || 0,
          remainingQuota: data.data?.remaining_quota ?? data.data?.remainingQuota ?? data.data?.quota ?? 0,
          planName: data.data?.plan || "HeyGen 套餐计划",
        };
      }

      // 2. Try user info endpoint as fallback
      const userResp = await fetch(`${baseUrl}/v2/user/info`, {
        method: "GET",
        headers: authHeaders,
        redirect: "error",
      });

      const userData = await userResp.json().catch(() => ({}));
      if (userResp.ok && (userData.code === 100 || userData.data)) {
        return {
          success: true,
          quota: userData.data?.quota || 0,
          remainingQuota: userData.data?.remaining_quota ?? userData.data?.quota ?? 0,
          planName: userData.data?.subscription?.plan || userData.data?.plan || "HeyGen Pro 套餐",
        };
      }

      return {
        success: false,
        error: data.message || userData.message || `HeyGen 鉴权响应码 (${resp.status})`,
      };
    } catch (err: any) {
      return {
        success: false,
        error: `连接 HeyGen 鉴权服务器异常: ${err.message}`,
      };
    }
  }

  public static async createLipsync(params: {
    videoUrl: string;
    audioUrl: string;
    title?: string;
    mode?: "precision";
  }): Promise<{ lipsyncId: string; status: string }> {
    const config = getAppConfig();
    const apiKey = config.heygenApiKey?.trim();
    const baseUrl = (config.heygenApiBaseUrl || "https://api.heygen.com").replace(/\/$/, "");

    if (!apiKey) {
      throw new Error(
        "未配置 HeyGen 套餐 Token！请在【系统配置】或【MCP 控制台】填入您的 HeyGen 授权 Token 以调用套餐额度。"
      );
    }

    const payload = {
      video_url: params.videoUrl,
      audio_url: params.audioUrl,
      title: params.title || `lipsync_${Date.now()}`,
      mode: params.mode || "precision",
      disableMusicTrack: true,
      enableCaption: false,
      enableDynamicDuration: false,
      enableSpeechEnhancement: false,
      enableWatermark: false,
      fpsMode: "cfr",
      keepTheSameFormat: true,
    };

    const resp = await fetch(`${baseUrl}/v1/video/lipsync`, {
      method: "POST",
      headers: {
        ...getAuthHeaders(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      redirect: "error",
    });

    const data = await resp.json();

    if (!resp.ok || (data.code && data.code !== 100)) {
      throw new Error(
        `HeyGen MCP 套餐调度失败 (${resp.status}): ${data.message || data.error || JSON.stringify(data)}`
      );
    }

    const lipsyncId =
      data.data?.video_id ||
      data.data?.lipsync_id ||
      data.data?.id ||
      data.video_id ||
      data.lipsync_id ||
      data.id;

    if (!lipsyncId) {
      throw new Error(`HeyGen 返回成功但未提供有效任务 ID: ${JSON.stringify(data)}`);
    }

    return {
      lipsyncId,
      status: "processing",
    };
  }

  public static async getLipsyncStatus(lipsyncId: string): Promise<{
    status: "processing" | "completed" | "failed";
    videoUrl?: string;
    error?: string;
  }> {
    const config = getAppConfig();
    const apiKey = config.heygenApiKey?.trim();
    const baseUrl = (config.heygenApiBaseUrl || "https://api.heygen.com").replace(/\/$/, "");

    if (!apiKey) {
      throw new Error("缺少 HeyGen 套餐 Token 授权");
    }

    const resp = await fetch(`${baseUrl}/v1/video_status.get?video_id=${lipsyncId}`, {
      method: "GET",
      headers: getAuthHeaders(apiKey),
      redirect: "error",
    });

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(`查询 HeyGen 对口型任务失败 (${resp.status}): ${data.message || JSON.stringify(data)}`);
    }

    const remoteStatus = (data.data?.status || data.status || "processing").toLowerCase();
    const videoUrl = data.data?.video_url || data.data?.url || data.video_url;
    const errorMsg = data.data?.error?.message || data.data?.error || data.error;

    if (remoteStatus === "completed" || remoteStatus === "success") {
      return { status: "completed", videoUrl };
    }
    if (remoteStatus === "failed" || remoteStatus === "error") {
      return { status: "failed", error: errorMsg || "HeyGen 渲染失败" };
    }
    return { status: "processing" };
  }
}
