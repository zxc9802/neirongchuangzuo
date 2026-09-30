import { logServerError } from "./server/safe-log";
import COS from "cos-nodejs-sdk-v5";
import fs from "fs";
import path from "path";
import { getAppConfig } from "./config";

let cosInstance: COS | null = null;
let currentSecretId = "";
let currentSecretKey = "";
let storagePolicyPromise: Promise<void> | null = null;
let storagePolicyIdentity = "";
const DIRECT_PART_BYTES = 8 * 1024 * 1024;

function isManagedMediaKey(key: string): boolean {
  return (
    /^uploads\/users\/[a-zA-Z0-9_-]+\/(?:videos|voices|thumbnails)\/[^/]+$/.test(key) ||
    /^jobs\/[a-zA-Z0-9_-]+\/(?:source-video\.mp4|voice-track\.(?:wav|mp3)|final\.mp4|production-report\.json|exact-final-indextts\.wav|evidence\.json)$/.test(key)
  );
}

function getCosClient(): COS | null {
  const config = getAppConfig();
  if (!config.cosSecretId || !config.cosSecretKey) {
    return null;
  }

  if (
    !cosInstance ||
    currentSecretId !== config.cosSecretId ||
    currentSecretKey !== config.cosSecretKey
  ) {
    cosInstance = new COS({
      SecretId: config.cosSecretId,
      SecretKey: config.cosSecretKey,
    });
    currentSecretId = config.cosSecretId;
    currentSecretKey = config.cosSecretKey;
  }

  return cosInstance;
}

export const CosService = {
  async createDirectUpload(key: string, bytes: number, contentType: string) {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos || !config.cosBucket || !config.cosRegion) throw new Error("云端存储未配置");
    await this.ensureBucketPrivateAndCors();
    const target = { Bucket: config.cosBucket, Region: config.cosRegion, Key: key };
    const { UploadId } = await cos.multipartInit({ ...target, ContentType: contentType, ACL: "private" });
    try {
      const parts = await Promise.all(Array.from({ length: Math.ceil(bytes / DIRECT_PART_BYTES) }, async (_, index) => {
        const size = Math.min(DIRECT_PART_BYTES, bytes - index * DIRECT_PART_BYTES);
        const url = await new Promise<string>((resolve, reject) => {
          cos.getObjectUrl({
            ...target, Method: "PUT", Sign: true, Protocol: "https:", Expires: 3600,
            Query: { uploadId: UploadId, partNumber: String(index + 1) },
            Headers: { "Content-Length": String(size), "Content-Type": "application/octet-stream" },
          }, (err, data) => err || !data?.Url ? reject(new Error("无法生成上传授权")) : resolve(data.Url));
        });
        return { url, size };
      }));
      return { uploadId: UploadId, parts };
    } catch (error) {
      await this.abortDirectUpload(key, UploadId).catch(() => undefined);
      throw error;
    }
  },

  async abortDirectUpload(key: string, uploadId: string): Promise<void> {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos) return;
    await cos.multipartAbort({ Bucket: config.cosBucket, Region: config.cosRegion, Key: key, UploadId: uploadId });
  },

  async completeDirectUpload(key: string, uploadId: string, bytes: number): Promise<boolean> {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos) throw new Error("云端存储未配置");
    // Completion may have succeeded even when its response was lost.
    if (await this.getObjectSize(key) === bytes) return true;
    const target = { Bucket: config.cosBucket, Region: config.cosRegion, Key: key, UploadId: uploadId };
    try {
      const listed = await cos.multipartListPart({ ...target, MaxParts: 100 });
      const parts = [...(listed.Part || [])].sort((a, b) => Number(a.PartNumber) - Number(b.PartNumber));
      if (String(listed.IsTruncated) === "true" || parts.length !== Math.ceil(bytes / DIRECT_PART_BYTES) ||
          parts.some((part, index) => Number(part.PartNumber) !== index + 1 || !part.ETag ||
            Number(part.Size) !== Math.min(DIRECT_PART_BYTES, bytes - index * DIRECT_PART_BYTES))) return false;
      await cos.multipartComplete({ ...target, Parts: parts.map(part => ({ PartNumber: part.PartNumber, ETag: part.ETag })) });
    } catch (error) {
      if (await this.getObjectSize(key) === bytes) return true;
      throw error;
    }
    return await this.getObjectSize(key) === bytes;
  },

  isConfigured(): boolean {
    const config = getAppConfig();
    return Boolean(
      config.cosSecretId &&
      config.cosSecretKey &&
      config.cosBucket &&
      config.cosRegion
    );
  },

  async getDownloadUrl(key: string, filename?: string, expires = 3600): Promise<string> {
    const config = getAppConfig();
    const cos = getCosClient();
    const cleanKey = key.replace(/^\/+/, "");
    const downloadName = filename || path.basename(cleanKey);

    if (!cos || !config.cosBucket || !config.cosRegion) throw new Error("云端存储未配置");

    return new Promise((resolve, reject) => {
      cos.getObjectUrl(
        {
          Bucket: config.cosBucket,
          Region: config.cosRegion,
          Key: cleanKey,
          Method: "GET",
          Sign: true,
          Expires: expires,
          Query: {
            "response-content-disposition": `attachment; filename="${downloadName}"`,
          },
        },
        (err, data) => {
          if (err || !data?.Url) return reject(new Error("无法生成私有下载地址"));
          resolve(data.Url);
        }
      );
    });
  },

  getPublicUrl(key: string): string {
    const config = getAppConfig();
    const cleanKey = key.replace(/^\/+/, "");
    if (config.cosCustomDomain) {
      const domain = config.cosCustomDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
      return `https://${domain}/${cleanKey}`;
    }
    return `https://${config.cosBucket}.cos.${config.cosRegion}.myqcloud.com/${cleanKey}`;
  },

  getManagedObjectKey(source: string): string | null {
    const config = getAppConfig();
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return null;
    }

    const hosts = new Set<string>();
    if (config.cosBucket && config.cosRegion) {
      hosts.add(`${config.cosBucket}.cos.${config.cosRegion}.myqcloud.com`.toLowerCase());
    }
    if (config.cosCustomDomain) {
      try {
        const custom = new URL(
          config.cosCustomDomain.startsWith("http")
            ? config.cosCustomDomain
            : `https://${config.cosCustomDomain}`
        );
        hosts.add(custom.hostname.toLowerCase());
      } catch {}
    }
    if (!hosts.has(url.hostname.toLowerCase())) return null;

    let key: string;
    try {
      key = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch {
      return null;
    }
    if (!key || key.includes("..") || key.includes("\\")) return null;
    return isManagedMediaKey(key) ? key : null;
  },

  getLegacyAvatarObjectKey(
    source: string,
    folder: "videos" | "thumbnails",
  ): string | null {
    const config = getAppConfig();
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) return null;

    const hosts = new Set<string>();
    if (config.cosBucket && config.cosRegion) {
      hosts.add(`${config.cosBucket}.cos.${config.cosRegion}.myqcloud.com`.toLowerCase());
    }
    if (config.cosCustomDomain) {
      try {
        const custom = new URL(
          config.cosCustomDomain.startsWith("http")
            ? config.cosCustomDomain
            : `https://${config.cosCustomDomain}`
        );
        hosts.add(custom.hostname.toLowerCase());
      } catch {}
    }
    if (!hosts.has(url.hostname.toLowerCase())) return null;

    let key: string;
    try {
      key = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch {
      return null;
    }
    const prefix = `uploads/${folder}/`;
    if (!key.startsWith(prefix)) return null;
    const fileName = key.slice(prefix.length);
    if (
      !fileName ||
      fileName.includes("/") ||
      fileName.includes("\\") ||
      fileName.includes("..") ||
      fileName.includes("%") ||
      /[\u0000-\u001f\u007f]/.test(fileName)
    ) return null;
    const allowed = folder === "videos"
      ? new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"])
      : new Set([".jpg", ".jpeg", ".png", ".webp"]);
    return allowed.has(path.extname(fileName).toLowerCase()) ? key : null;
  },

  async getPresignedPutUrl(
    targetKey: string,
    options: { expires?: number; contentLength: number; contentType: string }
  ): Promise<{ presignedUrl: string; key: string }> {
    const config = getAppConfig();
    const cos = getCosClient();

    if (!cos || !config.cosBucket || !config.cosRegion) {
      throw new Error("云端存储未配置");
    }

    const cleanKey = targetKey.replace(/^\/+/, "");
    await this.ensureBucketPrivateAndCors();

    return new Promise((resolve, reject) => {
      cos.getObjectUrl(
        {
          Bucket: config.cosBucket,
          Region: config.cosRegion,
          Key: cleanKey,
          Method: "PUT",
          Sign: true,
          Expires: options.expires || 900,
          Headers: {
            "Content-Length": String(options.contentLength),
            "Content-Type": options.contentType,
          },
        },
        (err, data) => {
          if (err || !data?.Url) {
            reject(new Error(`获取预签名上传地址失败: ${err?.message || "未知异常"}`));
          } else {
            resolve({
              presignedUrl: data.Url,
              key: cleanKey,
            });
          }
        }
      );
    });
  },

  async uploadFile(
    localFilePath: string,
    targetKey: string,
    onProgress?: (percent: number) => void
  ): Promise<string> {
    const config = getAppConfig();
    const cos = getCosClient();

    if (!cos || !config.cosBucket || !config.cosRegion) {
      throw new Error("云端存储未配置，请先在系统设置中配置 SecretId / SecretKey / Bucket / Region");
    }

    if (!fs.existsSync(localFilePath)) {
      throw new Error(`本地文件不存在: ${localFilePath}`);
    }

    const cleanKey = targetKey.replace(/^\/+/, "");
    await this.ensureBucketPrivateAndCors();

    return new Promise((resolve, reject) => {
      cos.sliceUploadFile(
        {
          Bucket: config.cosBucket,
          Region: config.cosRegion,
          Key: cleanKey,
          FilePath: localFilePath,
          ACL: "private",
          onProgress: (progressData) => {
            if (onProgress && progressData.percent) {
              onProgress(Math.round(progressData.percent * 100));
            }
          },
        },
        (err, data) => {
          if (err) {
            logServerError("storage.upload_failed", err);
            reject(new Error(`云端存储上传失败: ${err.message || JSON.stringify(err)}`));
            return;
          }

          resolve(this.getPublicUrl(cleanKey));
        }
      );
    });
  },

  async copyLegacyAvatarObject(sourceKey: string, targetKey: string): Promise<void> {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos || !config.cosBucket || !config.cosRegion) {
      throw new Error("云端存储未配置");
    }

    const cleanSource = sourceKey.replace(/^\/+/, "");
    const cleanTarget = targetKey.replace(/^\/+/, "");
    for (const key of [cleanSource, cleanTarget]) {
      if (
        !key ||
        key.includes("\\") ||
        key.includes("..") ||
        /[\u0000-\u001f\u007f]/.test(key)
      ) throw new Error("云端对象路径无效");
    }
    const folder = cleanSource.startsWith("uploads/videos/")
      ? "videos"
      : cleanSource.startsWith("uploads/thumbnails/")
        ? "thumbnails"
        : null;
    if (
      !folder ||
      this.getLegacyAvatarObjectKey(this.getPublicUrl(cleanSource), folder) !== cleanSource ||
      !isManagedMediaKey(cleanTarget) ||
      !cleanTarget.includes(`/${folder}/`) ||
      path.extname(cleanTarget).toLowerCase() !== path.extname(cleanSource).toLowerCase()
    ) throw new Error("云端对象迁移路径无效");
    const encodedSource = cleanSource
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    return new Promise((resolve, reject) => {
      cos.sliceCopyFile(
        {
          Bucket: config.cosBucket,
          Region: config.cosRegion,
          Key: cleanTarget,
          CopySource: `${config.cosBucket}.cos.${config.cosRegion}.myqcloud.com/${encodedSource}`,
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  },

  async makeLegacyAvatarObjectPrivate(
    sourceKey: string,
    folder: "videos" | "thumbnails",
  ): Promise<void> {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos || !config.cosBucket || !config.cosRegion) {
      throw new Error("云端存储未配置");
    }
    const cleanKey = sourceKey.replace(/^\/+/, "");
    if (
      this.getLegacyAvatarObjectKey(this.getPublicUrl(cleanKey), folder) !== cleanKey
    ) throw new Error("旧版形象对象路径无效");

    return new Promise((resolve, reject) => {
      cos.putObjectAcl(
        {
          Bucket: config.cosBucket,
          Region: config.cosRegion,
          Key: cleanKey,
          ACL: "private",
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  },

  async saveJsonToCos(key: string, data: any): Promise<void> {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos || !config.cosBucket || !config.cosRegion) return;

    const cleanKey = key.replace(/^\/+/, "");
    const jsonStr = JSON.stringify(data, null, 2);

    return new Promise((resolve, reject) => {
      cos.putObject(
        {
          Bucket: config.cosBucket,
          Region: config.cosRegion,
          Key: cleanKey,
          Body: Buffer.from(jsonStr, "utf-8"),
          ContentType: "application/json",
          ACL: "private",
        },
        (err) => {
          if (err) {
            logServerError("storage.json_sync_failed", err, "warn");
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  },

  async getJsonFromCos<T>(key: string): Promise<T | null> {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos || !config.cosBucket || !config.cosRegion) return null;

    const cleanKey = key.replace(/^\/+/, "");

    return new Promise((resolve) => {
      cos.getObject(
        {
          Bucket: config.cosBucket,
          Region: config.cosRegion,
          Key: cleanKey,
        },
        (err, data) => {
          if (err || !data?.Body) {
            resolve(null);
          } else {
            try {
              const bodyStr = data.Body.toString("utf-8");
              const parsed = JSON.parse(bodyStr);
              resolve(parsed as T);
            } catch {
              resolve(null);
            }
          }
        }
      );
    });
  },

  async objectExists(key: string): Promise<boolean> {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos || !config.cosBucket || !config.cosRegion) return false;

    const cleanKey = key.replace(/^\/+/, "");
    return new Promise((resolve) => {
      cos.headObject(
        {
          Bucket: config.cosBucket,
          Region: config.cosRegion,
          Key: cleanKey,
        },
        (err) => resolve(!err)
      );
    });
  },

  async getObjectSize(key: string): Promise<number | null> {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos || !config.cosBucket || !config.cosRegion) return null;

    const cleanKey = key.replace(/^\/+/, "");
    return new Promise((resolve) => {
      cos.headObject(
        {
          Bucket: config.cosBucket,
          Region: config.cosRegion,
          Key: cleanKey,
        },
        (err, data) => {
          if (err) return resolve(null);
          const value = Number(
            (data as any)?.headers?.["content-length"] ||
            (data as any)?.headers?.["Content-Length"] ||
            0
          );
          resolve(Number.isFinite(value) && value >= 0 ? value : null);
        }
      );
    });
  },

  async deleteObject(key: string): Promise<void> {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos || !config.cosBucket || !config.cosRegion) return;
    const cleanKey = key.replace(/^\/+/, "");
    return new Promise((resolve, reject) => {
      cos.deleteObject(
        {
          Bucket: config.cosBucket,
          Region: config.cosRegion,
          Key: cleanKey,
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  },

  async listFiles(prefix: string): Promise<{ key: string; size: number; lastModified: string }[]> {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos || !config.cosBucket || !config.cosRegion) return [];

    return new Promise((resolve) => {
      cos.getBucket(
        {
          Bucket: config.cosBucket,
          Region: config.cosRegion,
          Prefix: prefix,
        },
        (err, data) => {
          if (err || !data?.Contents) {
            resolve([]);
          } else {
            resolve(
              data.Contents.map((c: any) => ({
                key: c.Key,
                size: Number(c.Size || 0),
                lastModified: c.LastModified || "",
              }))
            );
          }
        }
      );
    });
  },

  async cleanupExpiredObjects(prefix: string, olderThanMs: number): Promise<number> {
    const files = await this.listFiles(prefix);
    const cutoff = Date.now() - olderThanMs;
    const expired = files.filter((file) => {
      const timestamp = Date.parse(file.lastModified);
      return Number.isFinite(timestamp) && timestamp < cutoff;
    });
    await Promise.all(expired.map((file) => this.deleteObject(file.key)));
    return expired.length;
  },

  async testConnection(): Promise<{ success: boolean; message: string; buckets?: any[] }> {
    const cos = getCosClient();
    if (!cos) {
      return { success: false, message: "缺少 SecretId 或 SecretKey" };
    }

    return new Promise((resolve) => {
      cos.getService((err, data) => {
        if (err) {
          resolve({
            success: false,
            message: `连接失败: ${err.message || "密钥校验未通过"}`,
          });
        } else {
          resolve({
            success: true,
            message: "云端存储凭据校验成功！",
            buckets: data?.Buckets || [],
          });
        }
      });
    });
  },

  async ensureBucketPrivateAndCors(): Promise<void> {
    const config = getAppConfig();
    const cos = getCosClient();
    if (!cos || !config.cosBucket || !config.cosRegion) return;

    const policyIdentity = `${config.cosBucket}:${config.cosRegion}:${config.publicBaseUrl}`;
    if (storagePolicyIdentity !== policyIdentity) {
      storagePolicyIdentity = policyIdentity;
      storagePolicyPromise = null;
    }

    if (!storagePolicyPromise) {
      const allowedOrigins = new Set<string>();
      for (const value of [process.env.PUBLIC_APP_URL, config.publicBaseUrl, process.env.AUTH_DESKTOP_URL]) {
        if (!value) continue;
        try {
          allowedOrigins.add(new URL(value).origin);
        } catch {}
      }
      if (process.env.NODE_ENV !== "production") {
        allowedOrigins.add("http://localhost:3000");
      }

      storagePolicyPromise = Promise.all([
        new Promise<void>((resolve, reject) => {
          cos.putBucketAcl(
            {
              Bucket: config.cosBucket,
              Region: config.cosRegion,
              ACL: "private",
            } as any,
            (err) => (err ? reject(err) : resolve())
          );
        }),
        new Promise<void>((resolve, reject) => {
          cos.putBucketCors(
            {
              Bucket: config.cosBucket,
              Region: config.cosRegion,
              CORSRules: [
                {
                  AllowedOrigin: Array.from(allowedOrigins),
                  AllowedMethod: ["GET", "PUT", "HEAD"],
                  AllowedHeader: ["content-type", "content-length"],
                  ExposeHeader: ["etag"],
                  MaxAgeSeconds: 600,
                },
              ] as any,
            },
            (err) => (err ? reject(err) : resolve())
          );
        }),
      ]).then(() => undefined).catch((error) => {
        storagePolicyPromise = null;
        throw error;
      });
    }

    return storagePolicyPromise;
  },
};
