import type { PreferredLanguage } from "./context.ts";

export interface QuestionDetection {
  shouldAnswer: boolean;
  shouldDispatch: boolean;
  confidence: number;
  reason: string;
  normalizedText: string;
}

export interface PartialTurnStability {
  stable: boolean;
  reason: "stable_partial" | "changed_recently" | "too_short" | "truncated_definition";
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

const normalizeForPatterns = (text: string): string =>
  normalize(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿¡]/g, "")
    .toLowerCase();

const fillerPatterns = [
  /^\s*(ok|okay|vale|bien|perfecto|gracias|thanks|thank you)\s*[.!?]?\s*$/i,
  /^\s*(ok|okay)\s+(thanks|thank you)\s*[.!?]?\s*$/i,
  /^\s*(yes|no|si)\s*[.!?]?\s*$/i,
];

const englishPatterns = [
  /\?$/,
  /\b(can|could|would|will|do|does|did|are|is|was|were|have|has|had)\s+(you|we|i|it|this|that|they)\b/i,
  /\b(what|why|how|when|where|which|who)\b/i,
  /\b(tell me|walk me through|explain|describe|elaborate|clarify)\b/i,
];

const spanishPatterns = [
  /\?$/,
  /\b(que|por que|como|cuando|donde|cual|quien)\b/i,
  /\b(puedes|podrias|podriamos|deberias|deberiamos)\b/i,
  /\b(explica|explicame|describe|describeme|contame|cuentame|aclara|aclarame)\b/i,
  /\b(me interesa|me interesaria|quisiera|quiero)\s+que\s+me\s+(cuentes|expliques|describas)\b/i,
];

const shortDefinitionQuestion = /\b(que|what)\s+(es|son|is|are)\s+[\p{L}\p{N}][\p{L}\p{N} .+#/-]{0,40}\??$/iu;
const truncatedDefinitionQuestion = /\b(que|what)\s+(es|son|is|are)\s+[\p{L}\p{N}]$/iu;

export const detectQuestionIntent = (
  text: string,
  preferredLanguage: PreferredLanguage = "auto",
): QuestionDetection => {
  const normalizedText = normalize(text);
  const patternText = normalizeForPatterns(normalizedText);
  if (!normalizedText) {
    return { shouldAnswer: false, shouldDispatch: false, confidence: 0, reason: "empty", normalizedText };
  }
  if (normalizedText.length < 5 || fillerPatterns.some((pattern) => pattern.test(patternText))) {
    return { shouldAnswer: false, shouldDispatch: false, confidence: 0.1, reason: "too_short_or_filler", normalizedText };
  }

  const patterns =
    preferredLanguage === "spanish"
      ? spanishPatterns
      : preferredLanguage === "english"
        ? englishPatterns
        : [...englishPatterns, ...spanishPatterns];
  const matches = patterns.filter((pattern) => pattern.test(patternText)).length;
  const hasQuestionMark = /[?¿]/.test(normalizedText);
  const isDefinition = shortDefinitionQuestion.test(patternText);
  const confidence = Math.min(0.95, matches * 0.5 + (hasQuestionMark ? 0.28 : 0) + (isDefinition ? 0.35 : 0));

  return {
    shouldAnswer: confidence >= 0.35,
    shouldDispatch: confidence >= 0.35,
    confidence,
    reason: isDefinition ? "definition_question" : matches > 0 ? "question_pattern" : "no_question_pattern",
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
  detection.shouldDispatch
  && detection.confidence >= minConfidence
  && nowMs - lastAnsweredAtMs >= cooldownMs;

export const assessPartialTurnStability = (
  currentText: string,
  previousText: string,
  previousUpdatedAtMs: number,
  nowMs: number,
  stableMs = 900,
): PartialTurnStability => {
  const current = normalize(currentText);
  const previous = normalize(previousText);
  if (truncatedDefinitionQuestion.test(normalizeForPatterns(current))) {
    return { stable: false, reason: "truncated_definition" };
  }
  if (current.length < 12) return { stable: false, reason: "too_short" };
  if (!previous || previous !== current || nowMs - previousUpdatedAtMs < stableMs) {
    return { stable: false, reason: "changed_recently" };
  }
  return { stable: true, reason: "stable_partial" };
};
