export async function readGeminiCompletionStream(body, maximumBytes = 16 * 1024 * 1024) {
  const decoder = new TextDecoder();
  let pending = '', data = [], bytes = 0, text = '', finishReason, usageMetadata, responseId, promptFeedback, ended = false;
  const event = () => {
    const raw = data.join('\n').trim(); data = [];
    if (!raw) return;
    if (raw === '[DONE]') { ended = true; return; }
    let value;
    try { value = JSON.parse(raw); }
    catch { throw Object.assign(new Error('Invalid Gemini stream event'), { streamIssue: 'invalid_sse_json', streamComplete: true }); }
    if (value.error) throw Object.assign(new Error('编导接口返回错误，请稍后重试。'), { code: 'DIRECTOR_PROVIDER_ERROR', validationIssue: JSON.stringify(value.error) });
    responseId = value.responseId || responseId;
    usageMetadata = value.usageMetadata || usageMetadata;
    promptFeedback = value.promptFeedback || promptFeedback;
    const candidate = value.candidates?.find(item => item.index === 0) || value.candidates?.[0];
    for (const part of candidate?.content?.parts || []) if (!part.thought && typeof part.text === 'string') text += part.text;
    finishReason = candidate?.finishReason || finishReason;
  };
  const line = value => {
    if (!value) event();
    else if (value.startsWith('data:')) data.push(value.slice(5).trimStart());
  };
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (!ended) {
      const { value: chunk, done } = await iterator.next(); if (done) break;
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) throw Object.assign(new Error('编导响应超过接收上限。'), { code: 'DIRECTOR_RESPONSE_TOO_LARGE', outputIssue: 'response_too_large' });
      pending += decoder.decode(chunk, { stream: true });
      let split;
      while (!ended && (split = pending.indexOf('\n')) >= 0) { line(pending.slice(0, split).replace(/\r$/, '')); pending = pending.slice(split + 1); }
    }
  } finally {
    // Do not wait for a cloned response's other reader to cancel.
    try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch {}
  }
  if (!ended) {
    pending += decoder.decode();
    if (pending) line(pending.replace(/\r$/, ''));
    event();
  }
  if (!finishReason && !promptFeedback?.blockReason) throw Object.assign(new Error('Incomplete Gemini stream'), { code: 'MODEL_STREAM_INCOMPLETE' });
  return { responseId, candidates: [{ finishReason, content: { parts: [{ text }] } }], usageMetadata, promptFeedback };
}
