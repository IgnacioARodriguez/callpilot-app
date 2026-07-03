import type { PreferredLanguage } from "./context.ts";

export interface QuestionDetection {
  shouldAnswer: boolean;
  confidence: number;
  reason: string;
  normalizedText: string;
}

const englishQuestionPatterns = [
  /\?$/,
  /\b(can|could|would|will|do|does|did|are|is|was|were|have|has|had)\s+you\b/i,
  /\b(what|why|how|when|where|which)\b/i,
  /\b(tell me|walk me through|explain|describe)\b/i,
];

const spanishQuestionPatterns = [
  /\?$/,
  /[¿?]/,
  /\b(que|qué|por que|por qué|como|cómo|cuando|cuándo|donde|dónde|cual|cuál)\b/i,
  /\b(puedes|podrias|podrías|explica|contame|cuentame|cuéntame)\b/i,
];

const fillerPatterns = [
  /^\s*(ok|okay|vale|bien|perfecto|gracias|thanks|thank you)\s*[.!?]?\s*$/i,
  /^\s*(yes|no|si|sí)\s*[.!?]?\s*$/i,
];

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export const detectQuestionIntent = (
  text: string,
  preferredLanguage: PreferredLanguage = "auto",
): QuestionDetection => {
  const normalizedText = normalize(text);
  if (!normalizedText) {
    return { shouldAnswer: false, confidence: 0, reason: "empty", normalizedText };
  }
  if (normalizedText.length < 8 || fillerPatterns.some((pattern) => pattern.test(normalizedText))) {
    return { shouldAnswer: false, confidence: 0.1, reason: "too_short_or_filler", normalizedText };
  }

  const patterns =
    preferredLanguage === "spanish"
      ? spanishQuestionPatterns
      : preferredLanguage === "english"
        ? englishQuestionPatterns
        : [...englishQuestionPatterns, ...spanishQuestionPatterns];
  const matches = patterns.filter((pattern) => pattern.test(normalizedText)).length;
  const confidence = Math.min(0.95, matches * 0.34 + (normalizedText.endsWith("?") ? 0.22 : 0));

  return {
    shouldAnswer: confidence >= 0.45,
    confidence,
    reason: matches > 0 ? "question_pattern" : "no_question_pattern",
    normalizedText,
  };
};

export const shouldAutoAnswer = (
  detection: QuestionDetection,
  nowMs: number,
  lastAnsweredAtMs: number,
  cooldownMs = 12000,
  minConfidence = 0.45,
): boolean =>
  detection.shouldAnswer
  && detection.confidence >= minConfidence
  && nowMs - lastAnsweredAtMs >= cooldownMs;
