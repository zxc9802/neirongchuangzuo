export const CHARACTERS_PER_SECOND = 4.4;

export function estimateScriptDuration(scriptText: string): number {
  const text = (scriptText || "").trim();
  if (!text) return 0;
  return Math.max(3, Math.ceil(text.length / CHARACTERS_PER_SECOND));
}

// A hold includes speech-rate variation and mux rounding; settlement uses actual seconds.
export function estimateReservationDuration(scriptText: string): number {
  const estimate = estimateScriptDuration(scriptText);
  return estimate ? Math.ceil(estimate * 1.25) + 2 : 0;
}
