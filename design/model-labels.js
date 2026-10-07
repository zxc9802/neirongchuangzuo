export const MODEL_LABELS = Object.freeze({
  basic: 'Plus模型',
  standard: 'Pro模型',
  advanced: 'Max模型',
});

const LEGACY_MODEL_LABELS = Object.freeze({
  '起芽初级模型': MODEL_LABELS.basic,
  '起芽中级模型': MODEL_LABELS.standard,
  '起芽高级模型': MODEL_LABELS.advanced,
});

// Brand labels are presentation only; provider identifiers stay unchanged.
export function displayModelName(value, fallback = MODEL_LABELS.standard) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (Object.values(MODEL_LABELS).includes(name)) return name;
  if (Object.hasOwn(LEGACY_MODEL_LABELS, name)) return LEGACY_MODEL_LABELS[name];
  if (/luna/i.test(name)) return MODEL_LABELS.basic;
  if (/gpt[-_ ]?image|image[-_ ]?2(?:\.5)?|sunburst/i.test(name)) return MODEL_LABELS.advanced;
  return Object.values(MODEL_LABELS).includes(fallback) ? fallback : MODEL_LABELS.standard;
}

// Errors may come from an older saved task or an upstream service.
export function brandModelText(value) {
  return String(value ?? '')
    .replace(/起芽(?:初级|中级|高级)模型/g, name => displayModelName(name))
    .replace(/\b(?:gpt[-_ ]?image[\w.-]*|image\s*2(?:\.5)?[\w.-]*|gpt[-_ ]?\d[\w.-]*|luna[\w.-]*|openlux|openai|deepseek[\w.-]*|claude[\w.-]*|gemini[\w.-]*|qwen[\w.-]*|doubao[\w.-]*|flux[\w.-]*|seedance[\w.-]*|sora[\w.-]*|kling[\w.-]*)\b/gi, name => displayModelName(name));
}
