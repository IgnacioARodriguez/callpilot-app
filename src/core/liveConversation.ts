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
    .replace(/Ã‚/g, "")
    .replace(/Â/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[Ã‚Â¿Ã‚Â¡Â¿Â¡¿¡]/g, "")
    .toLowerCase();

const fillerPatterns = [
  /^\s*(ok|okay|vale|bien|perfecto|gracias|thanks|thank you)\s*[.!?]?\s*$/i,
  /^\s*(ok|okay)\s+(thanks|thank you)\s*[.!?]?\s*$/i,
  /^\s*(yes|no|si)\s*[.!?]?\s*$/i,
];

const nonQuestionTurnPatterns = [
  /\b(dame|dame un|dame otro|give me|just give me)\s+(un\s+)?(segundo|momento|minute|second|moment)\b/i,
  /\b(estoy|i'?m)\s+(abriendo|opening|buscando|looking|checking|revisando)\b/i,
  /\b(ahora vemos|despues seguimos|despu[eé]s seguimos|luego seguimos|we'?ll continue|we can continue)\b/i,
  /\b(no hace falta responder|no need to answer|espera|wait)\b/i,
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
const incompleteUsageQuestion = /\b(para que sirve|what is it used for|what is used for)\s*\??$/iu;
const bareUsageQuestion = /^(?:interviewer(?:_partial)?\s*:\s*)?(?:[\p{L}\p{N}]+\.\s*)?(para que sirve|what is it used for|what is used for)\s*\??$/iu;
const casualEntertainmentQuestion = /\b(gta|videojuego|videojuegos|juego|juegos|fisico|digital|reservas?)\b/iu;

const questionStarter = /\b(what|why|how|when|where|which|who|can|could|would|will|do|does|did|are|is|was|were|have|has|had|que|por que|como|cuando|donde|cual|quien|puedes|podrias|para que|explica|explicame|describe|describeme)\b/i;

const roleLinePattern = /^(interviewer|interviewer_partial|candidate|assistant)\s*:\s*(.+)$/i;

const tokenizeContext = (text: string): string[] =>
  normalizeForPatterns(text)
    .match(/[a-z0-9+#.-]{3,}/g)
    ?.map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((token) => !new Set([
      "and", "because", "but", "con", "del", "for", "los", "las", "que", "the", "una", "would", "you",
      "interviewer", "candidate", "assistant", "para", "sirve",
    ]).has(token)) ?? [];

export const resolveEllipticalQuestionFocus = (text: string, focus: string): string => {
  if (!bareUsageQuestion.test(normalize(focus))) return focus;
  const roleLines = normalize(text)
    .replace(/\b(interviewer|candidate|assistant|interviewer_partial):/gi, "\n$1:")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  let focusIndex = -1;
  for (let index = roleLines.length - 1; index >= 0; index -= 1) {
    if (normalizeForPatterns(roleLines[index]).endsWith(normalizeForPatterns(focus))) {
      focusIndex = index;
      break;
    }
  }
  const priorLines = (focusIndex >= 0 ? roleLines.slice(0, focusIndex) : roleLines)
    .reverse()
    .filter((line) => !/^assistant\s*:/i.test(line));
  const prior = priorLines
    .map((line) => line.match(roleLinePattern)?.[2] ?? line)
    .find((line) => tokenizeContext(line).length >= 3);
  if (!prior) return focus;
  const anchor = tokenizeContext(prior)
    .filter((token) => !["think", "mean", "like", "also", "little", "things", "collection", "items"].includes(token))
    .slice(0, 10)
    .join(" ");
  if (!anchor) return focus;
  const subject = anchor.split(/\s+/).slice(0, 4).join(" ");
  if (/para que sirve/i.test(focus)) return `Para que sirve ${subject}? (contexto anterior: ${anchor})`;
  if (/what is (it )?used for/i.test(focus)) return `What is ${subject} used for? (previous context: ${anchor})`;
  return `${focus} (contexto anterior: ${anchor})`;
};

export const extractLatestQuestionFocus = (text: string): string => {
  const normalized = normalize(text);
  if (!normalized) return "";
  const withRoleBreaks = normalized.replace(/\b(interviewer|candidate|interviewer_partial):/gi, "\n$1:");
  const segments = withRoleBreaks
    .split(/(?<=[?¿.!])\s+|(?:\s+[—–-]\s+)|(?:\s{2,})|\n+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const candidates = (segments.length ? segments : [normalized])
    .filter((segment) => questionStarter.test(normalizeForPatterns(segment)) || /[?¿]/.test(segment));
  const latest = candidates.at(-1);
  if (!latest) return normalized;
  const cleanedLatest = latest.replace(/^(interviewer|interviewer_partial):\s*/i, "").trim();
  const index = normalized.toLowerCase().lastIndexOf(cleanedLatest.toLowerCase());
  if (index <= 0) return resolveEllipticalQuestionFocus(normalized, cleanedLatest);
  const prefix = normalized.slice(Math.max(0, index - 90), index).trim();
  const usefulPrefix = /\b(entrevistador|you asked|me pregunt|follow.?up)\b/i.test(prefix) ? prefix : "";
  return resolveEllipticalQuestionFocus(normalized, [usefulPrefix, cleanedLatest].filter(Boolean).join(" ").trim());
};

export const detectQuestionIntent = (
  text: string,
  preferredLanguage: PreferredLanguage = "auto",
): QuestionDetection => {
  const normalizedText = extractLatestQuestionFocus(text);
  const patternText = normalizeForPatterns(normalizedText);
  if (!normalizedText) {
    return { shouldAnswer: false, shouldDispatch: false, confidence: 0, reason: "empty", normalizedText };
  }
  if (incompleteUsageQuestion.test(patternText) && bareUsageQuestion.test(normalizedText)) {
    return { shouldAnswer: false, shouldDispatch: false, confidence: 0.1, reason: "incomplete_question", normalizedText };
  }
  if (casualEntertainmentQuestion.test(patternText)) {
    return { shouldAnswer: false, shouldDispatch: false, confidence: 0.1, reason: "non_interview_casual", normalizedText };
  }
  if (nonQuestionTurnPatterns.some((pattern) => pattern.test(normalizedText))) {
    return { shouldAnswer: false, shouldDispatch: false, confidence: 0.1, reason: "non_question_pause", normalizedText };
  }
  if (normalizedText.length < 5 || fillerPatterns.some((pattern) => pattern.test(patternText))) {
    return { shouldAnswer: false, shouldDispatch: false, confidence: 0.1, reason: "too_short_or_filler", normalizedText };
  }

  const patterns =
    preferredLanguage === "spanish"
      ? [...spanishPatterns, ...englishPatterns]
      : preferredLanguage === "english"
        ? [...englishPatterns, ...spanishPatterns]
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
  if (incompleteUsageQuestion.test(normalizeForPatterns(current))) {
    return { stable: false, reason: "truncated_definition" };
  }
  if (current.length < 12) return { stable: false, reason: "too_short" };
  if (!previous || previous !== current || nowMs - previousUpdatedAtMs < stableMs) {
    return { stable: false, reason: "changed_recently" };
  }
  return { stable: true, reason: "stable_partial" };
};
