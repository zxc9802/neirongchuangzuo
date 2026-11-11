import { VIDEO_DIRECTORS, DEFAULT_VIDEO_DIRECTOR } from '../../design/video-catalog.js';

export function directorSelection(id = DEFAULT_VIDEO_DIRECTOR) {
  const selected = VIDEO_DIRECTORS.find(model => model.id === id);
  if (!selected) throw Object.assign(new Error('请选择 Gemini 或 Kimi 编导。'), { status: 400, code: 'DIRECTOR_MODEL_INVALID' });
  return selected;
}

export function directorRequest(config, selected, system, content, maxTokens) {
  const base = config.baseUrl.replace(/\/$/, '');
  if (selected.id === 'gemini') {
    const parts = content.map(part => part.type === 'text' ? { text: part.text }
      : { inlineData: { mimeType: 'image/jpeg', data: part.image_url.url.split(',')[1] } });
    return { url: base.replace(/\/v1$/, '/v1beta') + `/models/${selected.model}:generateContent`, body: {
      systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 1, topP: 1, maxOutputTokens: maxTokens,
        thinkingConfig: { thinkingLevel: 'high', includeThoughts: true }, responseMimeType: 'application/json' },
    } };
  }
  return { url: base + '/chat/completions', body: { model: selected.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    stream: true, stream_options: { include_usage: true }, response_format: { type: 'json_object' },
    max_tokens: maxTokens, temperature: 1, top_p: .95, reasoning_effort: 'max',
  } };
}

export function geminiCompletion(payload) {
  const candidate = payload?.candidates?.[0], reason = candidate?.finishReason;
  const blocked = payload?.promptFeedback?.blockReason || reason && !['STOP', 'MAX_TOKENS'].includes(reason);
  const usage = payload?.usageMetadata;
  return { id: payload?.responseId, choices: [{ message: {
    content: (candidate?.content?.parts || []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join(''),
  }, finish_reason: blocked ? 'content_filter' : reason === 'MAX_TOKENS' ? 'length' : reason === 'STOP' ? 'stop' : null }],
    usage: usage && { prompt_tokens: usage.promptTokenCount,
      completion_tokens: Number.isSafeInteger(usage.candidatesTokenCount) ? usage.candidatesTokenCount + (usage.thoughtsTokenCount || 0) : undefined,
      prompt_tokens_details: { cached_tokens: usage.cachedContentTokenCount || 0 },
      completion_tokens_details: { reasoning_tokens: usage.thoughtsTokenCount || 0 } },
  };
}
