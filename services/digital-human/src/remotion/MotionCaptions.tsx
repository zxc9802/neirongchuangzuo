import React, {useMemo} from "react";
import type {MotionCaption} from "../lib/motion/contract";

const targetCharacters = 10;
const words = new Intl.Segmenter("zh-CN", {granularity: "word"});
const length = (text: string) => [...text].length;
const phraseStarts = new Set(["但是", "所以", "因为", "然后", "如果", "那么", "而且", "不过", "同时", "接着", "让", "通过", "帮助", "怎么", "如何", "提高"]);

function shortPhrases(text: string): string[] {
  // Speak numeric symbols instead of silently turning 20% into 20 or 3.5 into 35.
  const spoken = text.replace(/(\d+(?:[.．]\d+)?)\s*[%％]/g, "百分之$1").replace(/(\d)[.．](?=\d)/g, "$1点");
  const phrases: string[] = [];
  for (const clause of spoken.split(/[\p{P}\p{S}\r\n]+/u)) {
    const clean = clause.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    // Length is a reading target, not a cap: keep short clauses and whole words.
    if (length(clean) <= targetCharacters + 4) {phrases.push(clean); continue;}
    let current = "";
    const tokens = [...words.segment(clean)];
    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i].segment;
      const remaining = clean.slice(tokens[i].index).trim();
      const naturalBreak = phraseStarts.has(word) || length(word) > targetCharacters;
      if (length(current.trim()) >= 4 && length(remaining) >= 4 &&
        (naturalBreak || (length(current.trim()) >= targetCharacters && length(remaining) > 4))) {
        phrases.push(current.trim());
        current = "";
      }
      current = (current + word).trimStart();
    }
    if (current.trim()) phrases.push(current.trim());
  }
  return phrases;
}

export function MotionCaptions({captions, time}: {captions: MotionCaption[]; time: number}) {
  const pages = useMemo(() => captions.flatMap(caption => {
    const phrases = shortPhrases(caption.text);
    const total = phrases.reduce((sum, phrase) => sum + length(phrase), 0);
    let consumed = 0;
    // Existing ASR/SRT cues have sentence timing: divide within that interval,
    // retaining its start/end and the gaps between cues. Keep source text for summaries.
    return phrases.map((text, index) => {
      const start = caption.start + (caption.end - caption.start) * consumed / total;
      consumed += length(text);
      const end = index === phrases.length - 1 ? caption.end : caption.start + (caption.end - caption.start) * consumed / total;
      return {start, end, text};
    });
  }), [captions]);
  const caption = pages.find(page => time >= page.start && time < page.end);
  if (!caption) return null;
  const units = [...caption.text].reduce((sum, character) => sum + (/[\x00-\xff]/.test(character) ? 0.61 : 1), 0);
  return <div aria-label="口播字幕" style={{position: "absolute", bottom: 16, left: 50, right: 50, textAlign: "center"}}><span style={{display: "inline-block", maxWidth: "100%", padding: "2px 12px 5px", borderRadius: 5, background: "rgba(9, 54, 31, 0.94)", color: "white", fontWeight: 800, fontSize: Math.min(48, 948 / units), lineHeight: 1.3, whiteSpace: "nowrap"}}>{caption.text}</span></div>;
}
