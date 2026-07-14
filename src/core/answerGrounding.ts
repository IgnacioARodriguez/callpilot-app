import type { GlobalContext } from "./context.ts";
import type { StructuredAnswerPayload } from "./answerPayload.ts";

export interface AnswerGroundingAssessment {
  ok: boolean;
  reason: "grounded" | "empty" | "unsupported_topic_drift";
  overlapCount: number;
  unsupportedTerms: string[];
}

const stopWords = new Set([
  "about", "after", "also", "and", "answer", "application", "because", "before", "brief", "but", "can", "como", "con",
  "context", "could", "data", "del", "desde", "designed", "direct", "does", "el", "ella", "ellos", "en", "esa", "ese",
  "eso", "esta", "este", "esto", "for", "from", "hay", "into", "las", "los", "mas", "more", "para", "pero", "por",
  "que", "respuesta", "say", "should", "standard", "the", "this", "una", "use", "used", "user", "using", "what",
  "when", "where", "which", "with", "would",
]);

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const tokenize = (text: string): string[] =>
  normalize(text)
    .match(/[a-z0-9+#.-]{3,}/g)
    ?.map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((token) => token.length >= 3 && !stopWords.has(token)) ?? [];

const answerText = (structured: StructuredAnswerPayload): string => {
  if (structured.kind === "coding") {
    return [
      structured.payload.problem.title,
      structured.payload.problem.summary,
      structured.payload.narration.spokenAnswer,
      structured.payload.solution.approachSteps.join(" "),
      structured.payload.solution.code,
    ].join(" ");
  }
  return [
    structured.payload.spokenAnswer,
    structured.payload.keyPoints.join(" "),
    structured.payload.correction.correctedClaim ?? "",
    structured.payload.followUpHint ?? "",
  ].join(" ");
};

const groundingText = (context: GlobalContext, userInput: string): string =>
  [
    userInput,
    context.resumeText,
    context.starStories,
    context.jobDescription,
    context.userNotes,
    context.screenContext.visibleText,
    context.transcript.messages.slice(-8).map((message) => `${message.speaker}: ${message.text}`).join("\n"),
  ].join("\n");

export const assessAnswerGrounding = (
  context: GlobalContext,
  userInput: string,
  structured: StructuredAnswerPayload,
): AnswerGroundingAssessment => {
  const candidateText = answerText(structured);
  const answerTerms = [...new Set(tokenize(candidateText))];
  if (answerTerms.length === 0) return { ok: true, reason: "empty", overlapCount: 0, unsupportedTerms: [] };
  if (structured.kind === "interview" && structured.payload.intent === "no_answer") {
    return { ok: true, reason: "grounded", overlapCount: 0, unsupportedTerms: [] };
  }

  const groundingTerms = new Set(tokenize(groundingText(context, userInput)));
  const unsupportedTerms = answerTerms.filter((term) => !groundingTerms.has(term));
  const overlapCount = answerTerms.length - unsupportedTerms.length;
  const unsupportedRatio = unsupportedTerms.length / answerTerms.length;
  const ok = overlapCount >= 2 || (overlapCount >= 1 && groundingTerms.size <= 6) || unsupportedRatio < 0.65;

  return {
    ok,
    reason: ok ? "grounded" : "unsupported_topic_drift",
    overlapCount,
    unsupportedTerms: unsupportedTerms.slice(0, 12),
  };
};

export const withNoAnswerForUngroundedDrift = (
  structured: StructuredAnswerPayload,
  assessment: AnswerGroundingAssessment,
): StructuredAnswerPayload => {
  if (assessment.ok || structured.kind !== "interview") return structured;
  return {
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: false,
      intent: "no_answer",
      spokenAnswer: "No responderia todavia: el ultimo audio no da suficiente base para introducir un tema tecnico especifico.",
      keyPoints: ["Esperar una pregunta mas clara", "No inventar un tema no mencionado"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
    },
  };
};
