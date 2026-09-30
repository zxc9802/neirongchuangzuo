import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = path.join(ROOT, "cloud-functions", "pixverse-ingest");
const SETTINGS_PATH = path.join(ROOT, ".settings.json");
const FUNCTION_NAME = "pixverse-ingest";
const FUNCTION_REGION = "ap-guangzhou";

function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    throw new Error("找不到 .settings.json，请先在系统设置里保存 COS 密钥");
  }
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
}

function saveSettings(next) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest(encoding);
}

async function scfRequest(secretId, secretKey, action, payload) {
  const service = "scf";
  const host = "scf.tencentcloudapi.com";
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payloadText = JSON.stringify(payload);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payloadText),
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign, "hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(`https://${host}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      Host: host,
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": "2018-04-16",
      "X-TC-Region": FUNCTION_REGION,
    },
    body: payloadText,
  });
  const data = await resp.json();
  if (data?.Response?.Error) {
    const err = data.Response.Error;
    throw new Error(`${action} 失败: ${err.Code} ${err.Message}`);
  }
  return data.Response;
}

function zipFunction() {
  const install = spawnSync("npm", ["install", "--omit=dev"], {
    cwd: FN_DIR,
    stdio: "inherit",
  });
  if (install.status !== 0) {
    throw new Error("云函数依赖安装失败");
  }

  const zipPath = path.join(os.tmpdir(), `pixverse-ingest-${Date.now()}.zip`);
  const zip = spawnSync("zip", ["-r", zipPath, "app.js", "scf_bootstrap", "package.json", "node_modules"], {
    cwd: FN_DIR,
    stdio: "inherit",
  });
  if (zip.status !== 0) {
    throw new Error("打包云函数失败，请确认本机已安装 zip");
  }
  return zipPath;
}

async function ensureHttpTrigger(secretId, secretKey) {
  const listed = await scfRequest(secretId, secretKey, "ListTriggers", {
    FunctionName: FUNCTION_NAME,
  });
  const triggers = listed.Triggers || [];
  const http = triggers.find((item) => String(item.Type).toLowerCase() === "http");
  if (http?.TriggerDesc) {
    try {
      const desc = JSON.parse(http.TriggerDesc);
      if (desc.NetConfig?.Url || desc.url || desc.Url) {
        return desc.NetConfig?.Url || desc.url || desc.Url;
      }
    } catch {
      // ignore
    }
    if (http.TriggerName) {
      // continue to create if URL missing
    }
  }

  const created = await scfRequest(secretId, secretKey, "CreateTrigger", {
    FunctionName: FUNCTION_NAME,
    TriggerName: "url",
    Type: "http",
    TriggerDesc: JSON.stringify({
      AuthType: "NONE",
      NetConfig: {
        EnableExtranet: true,
        EnableIntranet: false,
      },
    }),
  });
  try {
    const desc = JSON.parse(created.TriggerInfo?.TriggerDesc || created.TriggerDesc || "{}");
    return desc.NetConfig?.Url || desc.url || desc.Url || "";
  } catch {
    return "";
  }
}

async function main() {
  const settings = loadSettings();
  const secretId = settings.cosSecretId;
  const secretKey = settings.cosSecretKey;
  if (!secretId || !secretKey) {
    throw new Error("settings 里没有 COS SecretId / SecretKey");
  }

  const token = settings.pixverseIngestToken || crypto.randomBytes(24).toString("hex");
  const zipPath = zipFunction();
  const zipFile = fs.readFileSync(zipPath).toString("base64");

  const envVars = [
    { Key: "COS_SECRET_ID", Value: settings.cosSecretId },
    { Key: "COS_SECRET_KEY", Value: settings.cosSecretKey },
    { Key: "COS_BUCKET", Value: settings.cosBucket || "shuziren-1410143389" },
    { Key: "COS_REGION", Value: settings.cosRegion || "ap-singapore" },
    { Key: "INGEST_TOKEN", Value: token },
  ];

  let exists = false;
  try {
    await scfRequest(secretId, secretKey, "GetFunction", { FunctionName: FUNCTION_NAME });
    exists = true;
  } catch (err) {
    if (!String(err.message).includes("ResourceNotFound")) {
      throw err;
    }
  }

  if (exists) {
    console.log("更新已有函数 pixverse-ingest ...");
    await scfRequest(secretId, secretKey, "UpdateFunctionCode", {
      FunctionName: FUNCTION_NAME,
      ZipFile: zipFile,
      Handler: "index.handler",
    });
    await scfRequest(secretId, secretKey, "UpdateFunctionConfiguration", {
      FunctionName: FUNCTION_NAME,
      MemorySize: 1024,
      Timeout: 300,
      Environment: { Variables: envVars },
    });
  } else {
    console.log("创建函数 pixverse-ingest ...");
    await scfRequest(secretId, secretKey, "CreateFunction", {
      FunctionName: FUNCTION_NAME,
      Runtime: "Nodejs18.15",
      Handler: "index.handler",
      MemorySize: 1024,
      Timeout: 300,
      Type: "HTTP",
      Description: "广州中转：下载 PixVerse 成片并上传到新加坡 COS",
      Code: { ZipFile: zipFile },
      Environment: { Variables: envVars },
    });
    for (let i = 0; i < 20; i++) {
      const info = await scfRequest(secretId, secretKey, "GetFunction", {
        FunctionName: FUNCTION_NAME,
      });
      if (info.Status === "Active") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const url = await ensureHttpTrigger(secretId, secretKey);
  const next = {
    ...settings,
    pixverseIngestToken: token,
    pixverseIngestUrl: url || settings.pixverseIngestUrl || "",
  };
  saveSettings(next);

  console.log("\n部署完成");
  console.log("函数名: pixverse-ingest");
  console.log("地域: 广州");
  if (url) {
    console.log("中转地址:", url);
  } else {
    console.log("未自动拿到函数 URL，请到控制台打开 pixverse-ingest → 触发管理 → 函数 URL");
  }
  console.log("请把上面的地址填进 Zeabur 环境变量 PIXVERSE_INGEST_URL");
  console.log("令牌已写入本地 .settings.json 的 pixverseIngestToken，同步到 Zeabur 的 PIXVERSE_INGEST_TOKEN");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
