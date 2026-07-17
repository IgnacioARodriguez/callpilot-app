const normalizeTranscriptText = (text = ""): string =>
  text.toLowerCase().replace(/\s+/g, " ").trim();

export const isDuplicateTranscript = (left: string, right: string): boolean => {
  const a = normalizeTranscriptText(left);
  const b = normalizeTranscriptText(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
};

export const hasTranscriptProgress = (baseline: string, next: string): boolean => {
  const cleanBaseline = normalizeTranscriptText(baseline);
  const cleanNext = normalizeTranscriptText(next);
  if (!cleanBaseline || !cleanNext) return Boolean(cleanNext);
  if (cleanBaseline === cleanNext || cleanBaseline.includes(cleanNext)) return false;
  if (cleanNext.startsWith(cleanBaseline)) {
    return normalizeTranscriptText(next.slice(baseline.length)).length > 0;
  }
  return !isDuplicateTranscript(baseline, next);
};

export const transcriptDelta = (baseline = "", next = ""): string => {
  const cleanBaseline = baseline.trim();
  const cleanNext = next.trim();
  if (!cleanBaseline || !cleanNext) return cleanNext;
  if (normalizeTranscriptText(cleanNext).startsWith(normalizeTranscriptText(cleanBaseline))) {
    return cleanNext.slice(cleanBaseline.length).replace(/^[\s.,;:!?\u00bf\u00a1"'`-]+/, "").trim() || cleanNext;
  }
  const index = normalizeTranscriptText(cleanNext).lastIndexOf(normalizeTranscriptText(cleanBaseline));
  if (index < 0) return cleanNext;
  return cleanNext.slice(index + cleanBaseline.length).replace(/^[\s.,;:!?\u00bf\u00a1"'`-]+/, "").trim() || cleanNext;
};
