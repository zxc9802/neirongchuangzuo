import crypto from "crypto";
import fs from "fs";

export interface PreflightResult {
  valid: boolean;
  videoUrlOk: boolean;
  audioUrlOk: boolean;
  videoSha256Match: boolean;
  audioSha256Match: boolean;
  details: string[];
}

export async function preflightHeyGenMedia(
  videoUrl: string,
  localVideoPath: string,
  audioUrl: string,
  localAudioPath: string
): Promise<PreflightResult> {
  const details: string[] = [];
  let videoUrlOk = false;
  let audioUrlOk = false;
  let videoSha256Match = false;
  let audioSha256Match = false;

  async function checkUrl(url: string, localPath: string, expectedTypePrefix: string) {
    // 1. Fetch headers without following redirects
    const resp = await fetch(url, {
      method: "GET",
      redirect: "manual",
    });

    if (resp.status !== 200) {
      details.push(
        `URL 门禁失败: 响应状态码为 ${resp.status} (要求 200，不得重定向): ${url}`
      );
      return { ok: false, match: false };
    }

    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith(expectedTypePrefix)) {
      details.push(
        `URL 门禁失败: Content-Type 为 "${contentType}"，非 "${expectedTypePrefix}*"`
      );
      return { ok: false, match: false };
    }

    // 2. Stream bytes with a hard limit and verify sha256 with local file.
    if (!resp.body) return { ok: false, match: false };
    const localSize = fs.statSync(localPath).size;
    const declaredLength = Number(resp.headers.get("content-length") || 0);
    if (declaredLength > localSize) return { ok: false, match: false };
    const remoteHasher = crypto.createHash("sha256");
    const reader = resp.body.getReader();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > localSize) return { ok: false, match: false };
      remoteHasher.update(value);
    }
    const remoteHash = remoteHasher.digest("hex");

    const localBuffer = fs.readFileSync(localPath);
    const localHash = crypto.createHash("sha256").update(localBuffer).digest("hex");

    if (remoteHash !== localHash) {
      details.push(`SHA-256 不一致: 远程 (${remoteHash}) vs 本地 (${localHash})`);
      return { ok: true, match: false };
    }

    return { ok: true, match: true };
  }

  try {
    const videoRes = await checkUrl(videoUrl, localVideoPath, "video/");
    videoUrlOk = videoRes.ok;
    videoSha256Match = videoRes.match;
  } catch (err: any) {
    details.push(`视频 URL 检查异常: ${err.message}`);
  }

  try {
    const audioRes = await checkUrl(audioUrl, localAudioPath, "audio/");
    audioUrlOk = audioRes.ok;
    audioSha256Match = audioRes.match;
  } catch (err: any) {
    details.push(`音频 URL 检查异常: ${err.message}`);
  }

  const valid = videoUrlOk && audioUrlOk && videoSha256Match && audioSha256Match;
  return {
    valid,
    videoUrlOk,
    audioUrlOk,
    videoSha256Match,
    audioSha256Match,
    details,
  };
}
