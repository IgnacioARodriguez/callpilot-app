import type { GlobalContext } from "./context.ts";
import type { StructuredAnswerPayload } from "./answerPayload.ts";

export interface AnswerGroundingAssessment {
  ok: boolean;
  reason: "grounded" | "empty" | "unsupported_topic_drift" | "topic_anchor_mismatch" | "definition_subject_mismatch";
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
    .replace(/Ã‚/g, "")
    .replace(/Â/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[Ã‚Â¿Ã‚Â¡Â¿Â¡¿¡]/g, "")
    .toLowerCase();

const tokenize = (text: string): string[] =>
  normalize(text)
    .match(/[a-z0-9+#.-]{3,}/g)
    ?.map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((token) => token.length >= 3 && !stopWords.has(token)) ?? [];

const extractCurrentTurnAnchors = (text: string): string[] =>
  [...new Set([
    ...(text.match(/\b[A-Z][A-Z0-9+#.-]{1,9}\b/g) ?? []),
    ...(text.match(/\b[A-Z][a-z][A-Za-z0-9+#.-]{2,24}\b/g) ?? []),
  ])].filter((token) => !["OK"].includes(token));

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

const extractDefinitionSubject = (text: string): string | null => {
  const normalized = normalize(text).replace(/[?]/g, " ").replace(/\s+/g, " ").trim();
  const match = normalized.match(/\b(?:what|que)\s+(?:is|are|es|son)\s+(.{2,80})$/i);
  return match?.[1]?.replace(/[.?!]+$/, "").trim() || null;
};

const extractExplicitQuestionSubject = (text: string): string | null => {
  const normalized = normalize(text).replace(/[?]/g, " ").replace(/\s+/g, " ").trim();
  const patterns = [
    /\b(?:what|que)\s+(?:is|are|es|son)\s+(.{2,80})$/i,
    /\b(?:para que)\s+(?:sirve|se usa|usarias|utilizarias)\s+(.{2,80})$/i,
    /\b(?:what)\s+(?:is|are)\s+(.{2,80})\s+(?:used for|for)$/i,
    /\b(?:explain|describe|explica|explicame|describe|describeme)\s+(.{2,80})$/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const subject = match?.[1]?.replace(/[.?!]+$/, "").trim();
    if (subject) return subject;
  }
  return null;
};

const extractAnswerDefinitionLead = (text: string): string | null => {
  const normalized = text.replace(/\*\*/g, "").replace(/^(respuesta|answer)\s*:\s*/i, "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(.{2,60}?)\s+(?:is|are|es|son)\b/i);
  return match?.[1]?.replace(/[,:;]+$/, "").trim() || null;
};

const subjectMatches = (expected: string, actual: string): boolean => {
  const expectedTerms = new Set(tokenize(expected));
  const actualTerms = new Set(tokenize(actual));
  if (expectedTerms.size === 0 || actualTerms.size === 0) return true;
  const overlap = [...expectedTerms].filter((term) => actualTerms.has(term)).length;
  return overlap / expectedTerms.size >= 0.6;
};

const groundingText = (context: GlobalContext, userInput: string): string =>
  [
    userInput,
    context.resumeText,
    context.starStories,
    context.jobDescription,
    context.userNotes,
    context.screenContext.visibleText,
    context.transcript.messages
      .filter((message) => message.speaker !== "assistant")
      .slice(-8)
      .map((message) => `${message.speaker}: ${message.text}`)
      .join("\n"),
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

  const definitionSubject = extractDefinitionSubject(userInput);
  const answerLead = extractAnswerDefinitionLead(candidateText);
  if (definitionSubject && answerLead && !subjectMatches(definitionSubject, answerLead)) {
    return {
      ok: false,
      reason: "definition_subject_mismatch",
      overlapCount: 0,
      unsupportedTerms: [answerLead],
    };
  }

  const userAnchors = extractCurrentTurnAnchors(userInput);
  const answerAnchors = extractCurrentTurnAnchors(candidateText);
  const missingUserAnchors = userAnchors.filter((term) => !answerAnchors.includes(term));
  const extraAnswerAnchors = answerAnchors.filter((term) => !userAnchors.includes(term));
  if (userAnchors.length > 0 && missingUserAnchors.length > 0 && extraAnswerAnchors.length > 0) {
    return {
      ok: false,
      reason: "topic_anchor_mismatch",
      overlapCount: 0,
      unsupportedTerms: extraAnswerAnchors.slice(0, 12),
    };
  }

  const explicitSubject = extractExplicitQuestionSubject(userInput);
  if (explicitSubject) {
    const subjectTerms = tokenize(explicitSubject);
    const candidateTerms = new Set(answerTerms);
    const matchedSubjectTerms = subjectTerms.filter((term) => candidateTerms.has(term));
    const subjectCoverage = subjectTerms.length === 0 ? 1 : matchedSubjectTerms.length / subjectTerms.length;
    if (subjectTerms.length > 0 && subjectCoverage < 0.5) {
      return {
        ok: false,
        reason: "topic_anchor_mismatch",
        overlapCount: matchedSubjectTerms.length,
        unsupportedTerms: subjectTerms.filter((term) => !candidateTerms.has(term)).slice(0, 12),
      };
    }
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
