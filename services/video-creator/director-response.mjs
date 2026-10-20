import { readCompletionStream } from '../restaurant/model-stream.mjs';

export const DIRECTOR_OUTPUT_TOKENS = 16384;
export const DIRECTOR_RESPONSE_BYTES = 16 * 1024 * 1024;

export function redactDirectorValue(value, secrets = []) {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'string') return item;
    for (const secret of secrets.filter(Boolean)) item = item.split(secret).join('[REDACTED]');
    return item.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/gi, '[IMAGE_DATA_REDACTED]');
  });
  return serialized === undefined ? undefined : JSON.parse(serialized);
}

export function directorAttemptSummary(attempt) {
  const { rawResponse, parsedResponse, responseContent, error, ...summary } = attempt;
  return { ...summary, ...(error ? { error: { code: error.code, issue: error.issue, phase: error.phase, message: error.message } } : {}) };
}

export async function readDirectorResponse(response, maximumBytes = DIRECTOR_RESPONSE_BYTES) {
  const decoder = new TextDecoder(); let raw = '', bytes = 0;
  const reader = response.body?.getReader();
  try {
    if (reader) while (true) {
      const { value, done } = await reader.read(); if (done) break;
      const remaining = maximumBytes - bytes; bytes += value.byteLength;
      raw += decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: true });
      if (bytes > maximumBytes) {
        void reader.cancel().catch(() => {});
        throw Object.assign(new Error('编导响应超过接收上限。'), { code: 'DIRECTOR_RESPONSE_TOO_LARGE', outputIssue: 'response_too_large' });
      }
      // Some compatible gateways keep HTTP open after the terminal SSE event.
      if (response.ok && /(?:^|\n)data: *\[DONE\](?:\r?\n|$)/.test(raw)) {
        void reader.cancel().catch(() => {}); break;
      }
    }
    raw += decoder.decode();
    if (!response.ok) return { rawResponse: raw, rawBytes: bytes, streamComplete: true };
    const streaming = response.headers.get('content-type')?.includes('text/event-stream') || /^(?:\s|:[^\n]*\n)*data:/.test(raw);
    let payload;
    if (streaming) payload = await readCompletionStream(new Response(raw).body, maximumBytes);
    else {
      try { payload = JSON.parse(raw.replace(/^\uFEFF/, '')); }
      catch { throw Object.assign(new Error('编导接口返回的响应不是合法JSON。'), { code: 'DIRECTOR_INVALID_JSON', outputIssue: 'transport_json', streamComplete: true }); }
    }
    return { rawResponse: raw, rawBytes: bytes, payload, streamComplete: true };
  } catch (error) {
    Object.assign(error, { rawResponse: raw + decoder.decode(), rawBytes: bytes, rawTruncated: bytes > maximumBytes });
    throw error;
  } finally { reader?.releaseLock(); }
}

const ISSUES = {
  truncated: ['DIRECTOR_OUTPUT_TRUNCATED', '编导输出达到长度上限，未返回完整脚本。'],
  empty: ['DIRECTOR_EMPTY_OUTPUT', '编导没有返回脚本内容，请重试。'],
  invalid_json: ['DIRECTOR_INVALID_JSON', '编导返回的脚本JSON格式不完整，请重试。'],
  transport_json: ['DIRECTOR_INVALID_JSON', '编导接口返回的响应格式错误，请重试。'],
  invalid_schema: ['DIRECTOR_INVALID_SCHEMA', '编导返回的数据结构不符合脚本要求，请重试。'],
  invalid_sse_json: ['DIRECTOR_STREAM_INVALID', '编导响应中有无法解析的数据片段，请重试。'],
};

export function directorFailure(cause, phase, signal) {
  const issue = cause.streamIssue || cause.outputIssue;
  let pair = ISSUES[issue];
  if (!pair && cause.code === 'MODEL_STREAM_INCOMPLETE') pair = ['DIRECTOR_STREAM_INCOMPLETE', '编导响应提前断开，未取得完整脚本，请稍后重试。'];
  if (!pair && (cause.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError')) pair = ['DIRECTOR_TIMEOUT', '编导等待超过时限，未取得完整脚本，请稍后重试。'];
  if (!pair && (cause.name === 'AbortError' || signal?.aborted)) pair = ['DIRECTOR_INTERRUPTED', '编导请求已中断，请重新发起。'];
  if (!pair && phase === 'request' && !cause.status) pair = ['DIRECTOR_NETWORK_ERROR', '编导接口连接中断，未取得完整脚本，请稍后重试。'];
  const code = pair?.[0] || cause.code || 'DIRECTOR_INVALID_OUTPUT';
  const message = pair?.[1] || (/[\u3400-\u9fff]/.test(cause.message || '') ? cause.message : '编导未返回可用脚本，请重试。');
  return { code, issue: issue || cause.code || 'unknown', phase, message, type: cause.name || 'Error',
    detail: String(cause.parseError || cause.validationIssue || cause.message || '').slice(0, 1500), stack: String(cause.stack || '').slice(0, 6000) };
}
