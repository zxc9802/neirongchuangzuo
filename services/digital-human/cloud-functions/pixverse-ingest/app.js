const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const dns = require("dns");
const net = require("net");
const crypto = require("crypto");
const COS = require("cos-nodejs-sdk-v5");

const PORT = Number(process.env.PORT || 9000);
const ALLOWED_HOST_SUFFIXES = [
  "pixverseai.cn",
  "openlux.ai",
  ...(process.env.PIXVERSE_SOURCE_HOSTS || "").split(","),
].map((value) => value.trim().toLowerCase()).filter(Boolean);
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_STALL_MS = 30_000;
const MAX_REDIRECTS = 4;
const MAX_BODY_BYTES = 16 * 1024;
const COS_KEY_RE = /^jobs\/[A-Za-z0-9_-]{1,128}\/(?:rendered-source\.mp4|lipsync-chunks\/result-\d+\.mp4)$/;
const MAX_ACTIVE_REQUESTS = 2;
let activeRequests = 0;
const activeCosKeys = new Set();

function send(res, statusCode, body) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function isPrivateOrReservedAddress(address) {
  const value = String(address).toLowerCase().split("%")[0];
  if (value.startsWith("::ffff:")) return isPrivateOrReservedAddress(value.slice(7));
  if (net.isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIP(value) !== 6) return true;
  return value === "::" || value === "::1" || value.startsWith("fc") ||
    value.startsWith("fd") || /^fe[89ab]/.test(value) || value.startsWith("2001:db8:");
}

async function assertAllowedUrl(sourceUrl) {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("只允许不含凭据的 HTTPS 地址");
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
  if (!allowed) {
    throw new Error(`不允许中转该域名: ${host}`);
  }
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.promises.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateOrReservedAddress(address))) {
    throw new Error("不允许中转非公网地址");
  }
  return {
    url: parsed,
    address: addresses[0].address,
    family: addresses[0].family || net.isIP(addresses[0].address),
  };
}

function requestPinned(resolved, signal) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      resolved.url,
      {
        method: "GET",
        signal,
        servername: resolved.url.hostname,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PixVerseIngest/1.0)",
          Accept: "*/*",
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, resolved.address, resolved.family);
        },
      },
      resolve,
    );
    request.on("error", reject);
    request.end();
  });
}

async function fetchAllowed(sourceUrl, signal) {
  let current = await assertAllowedUrl(sourceUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const resp = await requestPinned(current, signal);
    const status = Number(resp.statusCode || 0);
    if (![301, 302, 303, 307, 308].includes(status)) return resp;
    if (redirects === MAX_REDIRECTS) throw new Error("下载重定向过多");
    const location = resp.headers.location;
    if (!location) throw new Error("下载重定向缺少 Location");
    resp.resume();
    current = await assertAllowedUrl(new URL(location, current.url).toString());
  }
  throw new Error("下载重定向过多");
}

async function downloadToTemp(sourceUrl, tmp) {
  const controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort("下载总时长超时"), DOWNLOAD_TIMEOUT_MS);
  let stallTimer;
  let bytes = 0;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort("下载停滞超时"), DOWNLOAD_STALL_MS);
  };
  try {
    armStall();
    const resp = await fetchAllowed(sourceUrl, controller.signal);
    const status = Number(resp.statusCode || 0);
    if (status < 200 || status >= 300) throw new Error(`下载源文件失败 (${status})`);
    const declaredLength = Number(resp.headers["content-length"] || 0);
    if (declaredLength > MAX_DOWNLOAD_BYTES) throw new Error("下载源文件超过大小限制");
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOAD_BYTES) return callback(new Error("下载源文件超过大小限制"));
        armStall();
        callback(null, chunk);
      },
    });
    await pipeline(resp, limiter, fs.createWriteStream(tmp));
  } finally {
    clearTimeout(stallTimer);
    clearTimeout(overallTimer);
  }
  if (bytes <= 0) throw new Error("下载源文件为空");
  return { bytes };
}

function uploadToCos(localPath, key) {
  const SecretId = process.env.COS_SECRET_ID;
  const SecretKey = process.env.COS_SECRET_KEY;
  const Bucket = process.env.COS_BUCKET;
  const Region = process.env.COS_REGION || "ap-singapore";
  if (!SecretId || !SecretKey || !Bucket) {
    return Promise.reject(new Error("云函数未配置 COS 密钥"));
  }
  const cos = new COS({ SecretId, SecretKey, FileParallelLimit: 1, ChunkParallelLimit: 2 });
  const objectKey = key.replace(/^\/+/, "");
  return new Promise((resolve, reject) => {
    cos.headObject({ Bucket, Region, Key: objectKey }, (headError) => {
      if (!headError) {
        reject(new Error("目标对象已存在，拒绝覆盖"));
        return;
      }
      if (Number(headError.statusCode || 0) !== 404) {
        reject(headError);
        return;
      }
      let settled = false;
      let taskId;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (taskId) cos.cancelTask(taskId);
        reject(new Error("COS 上传超时"));
      }, DOWNLOAD_TIMEOUT_MS);
      cos.sliceUploadFile(
        {
          Bucket,
          Region,
          Key: objectKey,
          FilePath: localPath,
          Headers: { "x-cos-forbid-overwrite": "true" },
          onTaskReady: (id) => { taskId = id; },
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(`https://${Bucket}.cos.${Region}.myqcloud.com/${objectKey}`);
        }
      );
    });
  });
}

const server = http.createServer(async (req, res) => {
  let acquiredRequestSlot = false;
  let acquiredCosKey = "";
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      send(res, 200, { ok: true, service: "pixverse-ingest" });
      return;
    }

    if (req.method !== "POST") {
      send(res, 405, { ok: false, error: "只接受 POST" });
      return;
    }

    const token = process.env.INGEST_TOKEN || "";
    const provided = String(req.headers["x-ingest-token"] || "");
    const tokenBytes = Buffer.from(token);
    const providedBytes = Buffer.from(provided);
    if (
      !token ||
      tokenBytes.length !== providedBytes.length ||
      !crypto.timingSafeEqual(tokenBytes, providedBytes)
    ) {
      send(res, 401, { ok: false, error: "中转令牌无效" });
      return;
    }
    if (activeRequests >= MAX_ACTIVE_REQUESTS) {
      send(res, 429, { ok: false, error: "中转任务繁忙，请稍后重试" });
      return;
    }
    activeRequests += 1;
    acquiredRequestSlot = true;

    const body = await readBody(req);
    const sourceUrl = String(body.sourceUrl || "");
    await assertAllowedUrl(sourceUrl);
    const cosKey = String(body.cosKey || "").replace(/^\/+/, "");
    if (!COS_KEY_RE.test(cosKey)) {
      send(res, 400, { ok: false, error: "缺少合法 cosKey" });
      return;
    }
    if (activeCosKeys.has(cosKey)) {
      send(res, 409, { ok: false, error: "相同目标正在写入" });
      return;
    }
    activeCosKeys.add(cosKey);
    acquiredCosKey = cosKey;

    const tmp = path.join(
      os.tmpdir(),
      `pixverse-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.bin`,
    );
    try {
      const { bytes } = await downloadToTemp(sourceUrl, tmp);
      const cosUrl = await uploadToCos(tmp, cosKey);
      send(res, 200, { ok: true, cosUrl, bytes, cosKey });
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
  } catch (err) {
    send(res, 500, { ok: false, error: err.message || "中转失败" });
  } finally {
    if (acquiredCosKey) activeCosKeys.delete(acquiredCosKey);
    if (acquiredRequestSlot) activeRequests = Math.max(0, activeRequests - 1);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pixverse-ingest listening on 0.0.0.0:${PORT}`);
});
