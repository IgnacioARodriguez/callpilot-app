import type { TranscriptSpeaker } from "./transcriptBuffer.ts";

export interface RecentSpeech {
  text: string;
  speaker: TranscriptSpeaker;
  timestamp: number;
}

const normalizeForCompare = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);

export const speechSimilarity = (left: string, right: string): number => {
  const leftWords = normalizeForCompare(left);
  const rightWords = normalizeForCompare(right);
  if (leftWords.length === 0 || rightWords.length === 0) return 0;

  const leftSet = new Set(leftWords);
  const rightSet = new Set(rightWords);
  let overlap = 0;
  for (const word of leftSet) {
    if (rightSet.has(word)) overlap += 1;
  }

  return overlap / Math.min(leftSet.size, rightSet.size);
};

export const shouldDropCandidateEcho = (
  text: string,
  recentSpeech: RecentSpeech[],
  now = Date.now(),
  windowMs = 18000,
): boolean => {
  const normalizedLength = normalizeForCompare(text).length;
  if (normalizedLength < 3) return false;

  return recentSpeech.some((entry) =>
    entry.speaker === "interviewer"
    && now - entry.timestamp <= windowMs
    && speechSimilarity(text, entry.text) >= 0.72,
  );
};

export const pruneRecentSpeech = (recentSpeech: RecentSpeech[], now = Date.now(), windowMs = 30000): RecentSpeech[] =>
  recentSpeech.filter((entry) => now - entry.timestamp <= windowMs);
