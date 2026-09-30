import path from "path";
import { getAppConfig } from "../config";
import { CosService } from "../cos";
import { downloadFileToDisk } from "./download-file";
import {
  exactHostUrlPolicy,
  providerUrlPolicy,
} from "../server/outbound-url-policy";

const RELAY_HOSTS = ["pixverseai.cn", "openlux.ai"];

export function shouldRelayPixverseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return RELAY_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export function cosKeyFromJobOutput(outputPath: string): string {
  const normalized = outputPath.replace(/\\/g, "/");
  const marker = "/jobs/";
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) {
    return normalized.slice(index + 1);
  }
  return `jobs/relay-${Date.now()}/rendered-source.mp4`;
}

export async function ingestViaGuangzhouRelay(params: {
  sourceUrl: string;
  cosKey: string;
}): Promise<{ cosUrl: string; bytes?: number }> {
  const config = getAppConfig();
  const ingestUrl = (config.pixverseIngestUrl || "").replace(/\/$/, "");
  const token = config.pixverseIngestToken || "";
  if (!ingestUrl || !token) {
    throw new Error("未配置广州云函数中转");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("中转超时"), 5 * 60_000);
  try {
    const resp = await fetch(`${ingestUrl}/`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": token,
      },
      body: JSON.stringify({
        sourceUrl: params.sourceUrl,
        cosKey: params.cosKey,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.ok || !data?.cosUrl) {
      throw new Error(data?.error || `中转失败 (${resp.status})`);
    }
    return { cosUrl: data.cosUrl, bytes: data.bytes };
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadPixverseResult(params: {
  url: string;
  outputPath: string;
  onLog?: (msg: string) => void;
}): Promise<{ bytes: number; viaRelay: boolean }> {
  const { url, outputPath, onLog = () => {} } = params;
  const config = getAppConfig();
  const canRelay =
    Boolean(config.pixverseIngestUrl && config.pixverseIngestToken) &&
    shouldRelayPixverseUrl(url);

  if (canRelay) {
    const cosKey = cosKeyFromJobOutput(outputPath);
    try {
      onLog("[PixVerse] 经广州云函数中转至新加坡 COS...");
      const ingested = await ingestViaGuangzhouRelay({ sourceUrl: url, cosKey });
      const pullUrl = CosService.isConfigured()
        ? await CosService.getDownloadUrl(cosKey, path.basename(cosKey))
        : ingested.cosUrl;
      onLog("[PixVerse] 中转完成，正在从新加坡 COS 拉取成片...");
      const downloaded = await downloadFileToDisk({
        url: pullUrl,
        outputPath,
        onProgress: (msg) => onLog(`[PixVerse] 正在从 COS 拉取 ${msg}`),
        urlPolicy: CosService.isConfigured()
          ? exactHostUrlPolicy(pullUrl, "cos")
          : providerUrlPolicy("pixverse"),
      });
      return { bytes: downloaded.bytes, viaRelay: true };
    } catch (err: any) {
      onLog(`[PixVerse] 广州中转失败，回退直连: ${err.message}`);
    }
  }

  const downloaded = await downloadFileToDisk({
    url,
    outputPath,
    onProgress: (msg) => onLog(`[PixVerse] 正在拉取成片 ${msg}`),
    urlPolicy: providerUrlPolicy("pixverse"),
  });
  return { bytes: downloaded.bytes, viaRelay: false };
}
