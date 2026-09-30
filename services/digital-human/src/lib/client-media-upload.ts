export interface MediaUploadResult {
  uploadKey: string;
  storedRemotely: boolean;
}

class UploadError extends Error {
  status: number;
  constructor(message: string, status = 0) { super(message); this.status = status; }
}

async function retryUpload<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason;
    try { return await operation(); } catch (error) {
      const status = error instanceof UploadError ? error.status : 0;
      if (signal?.aborted || attempt >= 2 || (status > 0 && status < 500 && status !== 408 && status !== 429)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

async function postUploadControl(url: string, body: object) {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new UploadError(data?.error || `上传请求失败 (${response.status})`, response.status);
  if (!data) throw new UploadError("无法读取上传响应", 400);
  return data;
}

export async function uploadMediaFile(
  file: File | Blob,
  fileName: string,
  folder: "videos" | "voices" | "thumbnails" = "videos",
  onProgress?: (percent: number) => void
): Promise<MediaUploadResult> {
  const contentType = file.type || "application/octet-stream";
  const grant = await postUploadControl("/api/upload/direct", { folder, fileName, fileSize: file.size, contentType });
  if (grant.direct) {
    const parts = grant.parts as { url: string; size: number }[];
    const loaded = parts.map(() => 0);
    const cancellation = new AbortController();
    let nextPart = 0;
    let offset = 0;
    let highestProgress = 0;
    const reportProgress = (index: number, bytes: number) => {
      if (cancellation.signal.aborted) return;
      loaded[index] = Math.min(parts[index].size, bytes);
      const total = loaded.reduce((sum, value) => sum + value, 0);
      highestProgress = Math.max(highestProgress, Math.min(99, Math.round(total / file.size * 100)));
      onProgress?.(highestProgress);
    };
    await Promise.all(Array.from({ length: Math.min(3, parts.length) }, async () => {
      try {
        while (!cancellation.signal.aborted && nextPart < parts.length) {
          const index = nextPart++;
          const part = parts[index];
          const slice = file.slice(offset, offset + part.size);
          offset += part.size;
          await retryUpload(() => new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const abort = () => xhr.abort();
            const finish = (error?: unknown) => {
              cancellation.signal.removeEventListener("abort", abort);
              if (error) reject(error);
              else resolve();
            };
            reportProgress(index, 0);
            xhr.open("PUT", part.url, true);
            xhr.setRequestHeader("Content-Type", "application/octet-stream");
            // The browser supplies Content-Length from the Blob; it must match the signed part size.
            xhr.timeout = 180_000;
            xhr.upload.onprogress = event => {
              if (event.lengthComputable) reportProgress(index, event.loaded);
            };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                reportProgress(index, part.size);
                finish();
              } else finish(new UploadError(`上传分段失败 (${xhr.status})`, xhr.status));
            };
            xhr.onerror = () => finish(new UploadError("云端上传连接失败，请检查网络后重试"));
            xhr.ontimeout = () => finish(new UploadError("上传分段超时，请重试", 408));
            xhr.onabort = () => finish(cancellation.signal.reason);
            cancellation.signal.addEventListener("abort", abort, { once: true });
            xhr.send(slice);
          }), cancellation.signal);
        }
      } catch (error) {
        cancellation.abort(error);
        throw error;
      }
    }));
    const done = await retryUpload(() => postUploadControl("/api/upload/complete", { uploadKey: grant.uploadKey }));
    if (!done.success || done.uploadKey !== grant.uploadKey) throw new Error("上传确认失败");
    onProgress?.(100);
    return { uploadKey: done.uploadKey, storedRemotely: true };
  }

  // Local development and installations without COS retain the existing upload route.
  return new Promise<MediaUploadResult>((resolve, reject) => {
    const query = new URLSearchParams({ folder, fileName });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?${query.toString()}`, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let message = `上传失败 (${xhr.status})，请重试`;
        try {
          const data = JSON.parse(xhr.responseText);
          if (typeof data.error === "string" && data.error) message = data.error;
        } catch {}
        reject(new Error(message));
        return;
      }
      try {
        const data = JSON.parse(xhr.responseText);
        if (!data.success || !data.uploadKey) {
          reject(new Error(data.error || "上传失败"));
          return;
        }
        resolve({
          uploadKey: data.uploadKey,
          storedRemotely: Boolean(data.storedRemotely),
        });
      } catch {
        reject(new Error("解析响应失败"));
      }
    };
    xhr.onerror = () => reject(new Error("网络连接失败"));
    xhr.send(file);
  });
}
