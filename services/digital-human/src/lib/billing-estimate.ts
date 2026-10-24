export const CHARACTERS_PER_SECOND = 4.4;

export function estimateScriptDuration(scriptText: string, speed = 1): number {
  const text = (scriptText || "").trim();
  if (!text) return 0;
  return Math.max(3, Math.ceil(text.length / (CHARACTERS_PER_SECOND * speed)));
}

// A hold includes speech-rate variation and mux rounding; settlement uses actual seconds.
export function estimateReservationDuration(scriptText: string, speed = 1): number {
  const estimate = estimateScriptDuration(scriptText, speed);
  return estimate ? Math.ceil(estimate * 1.25) + 2 : 0;
}
