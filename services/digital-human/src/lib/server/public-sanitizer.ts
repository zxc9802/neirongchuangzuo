const IMPLEMENTATION_TERMS = [
  /\bindex\s*tts(?:-?2)?\b/gi,
  /\b302\.ai\b/gi,
  /\bfal\.ai\b/gi,
  /\bveed(?:\s+lipsync)?\b/gi,
  /\bpixverse(?:-lipsync)?\b/gi,
  /\bopenlux(?:\.ai)?\b/gi,
  /\bheygen\b/gi,
  /\bmodel\s+context\s+protocol\b/gi,
  /\bmcp\b/gi,
];

export function sanitizePublicText(value: unknown, fallback = "处理失败，请稍后重试"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;

  let text = value
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"'}]+/gi, "[凭据已隐藏]")
    .replace(/\b(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY)|api[_-]?key|token|secret|password)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "[凭据已隐藏]")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[凭据已隐藏]")
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, "[内部资源]")
    .replace(/\b(?:task|job|request|video|media|lipsync)[_-]?id\s*[:=]\s*[\w-]+/gi, "内部编号已隐藏")
    .replace(/\(\s*id\s*:\s*[a-z0-9_-]+\s*\)/gi, "([内部编号])")
    .replace(/\b(?:req|task|job|media|video)_[a-z0-9_-]{6,}\b/gi, "[内部编号]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[内部编号]")
    .replace(/\b(?:INDEXTTS|HEYGEN|OPENLUX|PIXVERSE|FAL|COS|MAIN_APP_SSO|APP_SESSION|SSO)_[A-Z0-9_]+\b/g, "内部配置");

  for (const pattern of IMPLEMENTATION_TERMS) {
    text = text.replace(pattern, "处理服务");
  }

  return text.replace(/\s{2,}/g, " ").trim() || fallback;
}
