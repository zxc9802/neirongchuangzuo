// Keep diagnostic text useful without exposing credentials or signed media links.
export function safeVideoError(value, secrets = []) {
  let text = typeof value === 'string' ? value : '';
  for (const secret of secrets) if (secret) text = text.split(secret).join('[已隐藏]');
  return text.replace(/(?:https?:\/\/|oss:\/\/)[^\s"<>]+/gi, '[素材链接已隐藏]')
    .replace(/\bBearer\s+[^\s,;"<>]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:[\w-]*(?:api[_-]?key|access[_-]?key|secret[_-]?key|token|signature)|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,;"'<>]+/gi, '$1[已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1600);
}

export function providerFailure(body, secrets = []) {
  const layers = [body?.data?.result, body?.result, body?.output, body?.data, body].filter(value => value && typeof value === 'object');
  const first = keys => layers.flatMap(layer => keys.map(key => layer[key])).find(value =>
    (typeof value === 'string' || typeof value === 'number') && String(value).trim() && !/^(?:0|200|ok|success|操作成功[！!]?)$/i.test(String(value).trim()));
  const message = layers.map(layer => layer.error?.message || layer.errorMsg || layer.message || layer.msg || (typeof layer.error === 'string' ? layer.error : ''))
    .find(value => typeof value === 'string' && value.trim() && !/^(?:ok|success|操作成功[！!]?)$/i.test(value.trim()));
  const code = first(['errorCode', 'error_code', 'code']), requestId = first(['request_id', 'requestId', 'RequestId']);
  let explanation = '';
  if (/output may be related to copyright restrictions/i.test(message || '')) explanation = '生成结果可能涉及版权限制，上游拒绝返回成片。';
  else if (/input video may contain sensitive information/i.test(message || '')) explanation = '参考视频可能包含敏感内容，未通过上游审核。';
  const details = [message, code && `上游错误码：${code}`, requestId && `请求编号：${requestId}`].filter(Boolean).join('；');
  return safeVideoError(explanation + (explanation && details ? '原始原因：' : '') + details, secrets);
}

export async function readProviderResponse(response) {
  try {
    const chunks = []; let length = 0;
    for await (const chunk of response.body || []) {
      length += chunk.length;
      if (length > 1024 * 1024) throw new Error('Provider response exceeds limit');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) || {};
  }
  catch (cause) { if (response.ok) throw cause; return {}; }
}
