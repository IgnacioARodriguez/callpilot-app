import type { GlobalContext } from "./context.ts";
import type { StructuredAnswerPayload } from "./answerPayload.ts";

export interface AnswerGroundingAssessment {
  ok: boolean;
  reason:
    | "grounded"
    | "empty"
    | "unsupported_topic_drift"
    | "topic_anchor_mismatch"
    | "definition_subject_mismatch"
    | "unsupported_behavioral_specifics";
  overlapCount: number;
  unsupportedTerms: string[];
}

const stopWords = new Set([
  "about", "after", "also", "and", "answer", "application", "because", "before", "brief", "but", "can", "como", "con",
  "context", "could", "data", "del", "desde", "designed", "direct", "does", "el", "ella", "ellos", "en", "esa", "ese",
  "eso", "esta", "este", "esto", "for", "from", "hay", "into", "las", "los", "mas", "more", "para", "pero", "por",
  "que", "respuesta", "say", "should", "standard", "the", "this", "un", "una", "use", "used", "user", "using", "what",
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

const canonicalToken = (token: string): string => {
  const canonical: Record<string, string> = {
    apis: "api",
    clientes: "cliente",
    clients: "cliente",
    colas: "queue",
    cola: "queue",
    queues: "queue",
    mensajes: "message",
    mensaje: "message",
    messages: "message",
    procesar: "process",
    procesa: "process",
    processed: "process",
    processing: "process",
    reintento: "retry",
    reintentos: "retry",
    retries: "retry",
    duplicar: "duplicate",
    duplicado: "duplicate",
    duplicados: "duplicate",
    duplicated: "duplicate",
    twice: "duplicate",
    dos: "duplicate",
    versiones: "version",
    versionar: "version",
    versionarias: "version",
    versioning: "version",
    compatibilidad: "compatibility",
    compatible: "compatibility",
    deprecacion: "deprecation",
    deprecation: "deprecation",
    lista: "list",
    listas: "list",
    diccionario: "dictionary",
    diccionarios: "dictionary",
    orden: "order",
    ordered: "order",
    ordering: "order",
    insercion: "insert",
    insertion: "insert",
    optimista: "optimistic",
    optimistic: "optimistic",
    pesimista: "pessimistic",
    pessimistic: "pessimistic",
    bloquea: "lock",
    bloquean: "lock",
    bloqueo: "lock",
    bloquear: "lock",
    locking: "lock",
    cacheas: "cache",
    cachear: "cache",
    cacheando: "cache",
    caching: "cache",
    consistency: "consistency",
    consistencia: "consistency",
  };
  const trimmedPlural = token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
  return canonical[token] ?? canonical[trimmedPlural] ?? trimmedPlural;
};

const tokenize = (text: string): string[] =>
  normalize(text)
    .match(/[a-z0-9+#.-]{3,}/g)
    ?.map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .map(canonicalToken)
    .filter((token) => token.length >= 3 && !stopWords.has(token)) ?? [];

const properTechAnchors = new Set([
  "Kafka", "React", "Python", "Docker", "Kubernetes", "Redis", "PostgreSQL", "MySQL", "MongoDB", "TypeScript",
  "JavaScript", "Node", "Node.js", "Django", "FastAPI", "Pandas", "Spark",
]);

const extractCurrentTurnAnchors = (text: string): string[] =>
  [...new Set([
    ...(text.match(/\b[A-Z][A-Z0-9+#.-]{1,9}\b/g) ?? []),
    ...((text.match(/\b[A-Z][a-z][A-Za-z0-9+#.-]{2,24}\b/g) ?? []).filter((token) => properTechAnchors.has(token))),
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
  return match?.[1]?.split(/\s+y\s+(?:cuando|como|por que|para que|que|donde|cual)\b/i)[0]?.replace(/[.?!]+$/, "").trim() || null;
};

const extractExplicitQuestionSubject = (text: string): string | null => {
  const normalized = normalize(text).replace(/[?]/g, " ").replace(/\s+/g, " ").trim();
  const patterns = [
    /\b(?:what|que)\s+(?:is|are|es|son)\s+(.{2,80})$/i,
    /\b(?:para que)\s+(?:sirve|se usa|usarias|utilizarias)\s+(.{2,80})$/i,
    /\b(?:cuando|when)\s+(?:no\s+)?(?:usarias|utilizarias|would you use)\s+(.{2,80})$/i,
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
  return overlap >= 1;
};

const latestUserText = (userInput: string): string => {
  const roleLines = userInput
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^(interviewer|interviewer_partial|candidate)\s*:/i.test(line));
  const latest = roleLines.at(-1) ?? userInput;
  return latest.replace(/^(interviewer|interviewer_partial|candidate)\s*:\s*/i, "").trim();
};

const asksForCandidateExperience = (text: string): boolean =>
  /\b(experience|background|resume|cv|career|project|worked|used before|have you used|where have you used|how have you used|your work|your background|experiencia|carrera|proyecto|trabajaste|usaste antes|has usado|lo usaste|lo has usado|donde lo usaste|como lo usaste|como lo has usado|en tu caso|que hiciste|qu[eé] hiciste)\b/i.test(text);

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

const allowedBehavioralProperNouns = new Set([
  "Action",
  "Backend Engineer",
  "Production Incident",
  "Response",
  "Situation",
  "STAR",
  "Task",
]);

const unsupportedBehavioralSpecifics = (candidateText: string, grounding: string): string[] => {
  const normalizedGrounding = normalize(grounding).replace(/\s+/g, " ");
  const groundingTokenSet = new Set(tokenize(grounding));
  const unsupported = new Set<string>();
  const addIfUnsupported = (raw: string | undefined) => {
    const value = raw?.replace(/\s+/g, " ").trim();
    if (!value) return;
    const normalizedValue = normalize(value).replace(/\s+/g, " ").trim();
    if (!normalizedValue || normalizedGrounding.includes(normalizedValue)) return;
    if (normalize(grounding).replace(/[^a-z0-9+#.-]+/g, "").includes(normalizedValue.replace(/[^a-z0-9+#.-]+/g, ""))) return;
    const valueTokens = tokenize(value);
    if (valueTokens.length > 0 && valueTokens.every((token) => groundingTokenSet.has(token))) return;
    if (normalizedValue.startsWith("apache ") && valueTokens.some((token) => token !== "apache" && groundingTokenSet.has(token))) return;
    unsupported.add(value);
  };

  const patterns = [
    /\b\d{2,}(?:,\d{3})?(?:\s*%|\s+(?:concurrent\s+)?(?:users|customers|requests|minutes|hours|seconds|days|weeks|errors|revenue|sales))\b/gi,
    /\b20\d{2}\b/g,
    /\b(?:black friday|database outage|e-commerce platform|hotfix|ops team|on-call|revenue loss|rollback|root cause)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of candidateText.matchAll(pattern)) addIfUnsupported(match[0]);
  }

  for (const match of candidateText.matchAll(/\b[A-Z][A-Za-z0-9&.-]{2,}(?:\s+[A-Z][A-Za-z0-9&.-]{2,}){0,3}\b/g)) {
    const value = match[0].replace(/\s+/g, " ").trim();
    if (allowedBehavioralProperNouns.has(value)) continue;
    if (/^(As|Could|Describe|Format|I|If|No|Tell|The|This|Within)$/.test(value)) continue;
    addIfUnsupported(value);
  }

  return [...unsupported].slice(0, 12);
};

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

  if (structured.kind === "interview" && (context.activeMode === "behavioral" || structured.payload.intent === "behavioral" || asksForCandidateExperience(userInput))) {
    const unsupportedSpecifics = unsupportedBehavioralSpecifics(candidateText, groundingText(context, userInput));
    if (unsupportedSpecifics.length > 0) {
      return {
        ok: false,
        reason: "unsupported_behavioral_specifics",
        overlapCount: 0,
        unsupportedTerms: unsupportedSpecifics,
      };
    }
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

  const explicitSubject = extractExplicitQuestionSubject(userInput);
  if (explicitSubject) {
    const subjectTerms = tokenize(explicitSubject);
    const candidateTerms = new Set(answerTerms);
    const matchedSubjectTerms = subjectTerms.filter((term) => candidateTerms.has(term));
    const subjectCoverage = subjectTerms.length === 0 ? 1 : matchedSubjectTerms.length / subjectTerms.length;
    if (subjectTerms.length > 0 && subjectCoverage >= 0.5) {
      return {
        ok: true,
        reason: "grounded",
        overlapCount: matchedSubjectTerms.length,
        unsupportedTerms: [],
      };
    }
  }

  const currentTerms = tokenize(latestUserText(userInput));
  const currentTermOverlap = currentTerms.filter((term) => answerTerms.includes(term)).length;
  const userAnchors = extractCurrentTurnAnchors(userInput);
  const answerAnchors = extractCurrentTurnAnchors(candidateText);
  if (
    currentTerms.length > 0
    && currentTermOverlap >= 1
  ) {
    return {
      ok: true,
      reason: "grounded",
      overlapCount: currentTermOverlap,
      unsupportedTerms: [],
    };
  }

  const missingUserAnchors = userAnchors.filter((term) => !answerAnchors.includes(term));
  const extraAnswerAnchors = answerAnchors.filter((term) => !userAnchors.includes(term));
  if (userAnchors.length > 0 && missingUserAnchors.length > 0 && extraAnswerAnchors.length > 0 && currentTermOverlap === 0) {
    return {
      ok: false,
      reason: "topic_anchor_mismatch",
      overlapCount: 0,
      unsupportedTerms: extraAnswerAnchors.slice(0, 12),
    };
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

export const assessPlainInterviewAnswerGrounding = (
  context: GlobalContext,
  userInput: string,
  candidateText: string,
): AnswerGroundingAssessment => assessAnswerGrounding(context, userInput, {
  kind: "interview",
  payload: {
    version: "1",
    answerNeeded: true,
    intent: context.activeMode === "behavioral" ? "behavioral" : "technical_qa",
    spokenAnswer: candidateText,
    keyPoints: [],
    correction: { needed: false, transition: null, correctedClaim: null },
    assumptions: [],
    evidenceRefs: [],
    followUpHint: null,
  },
});

export const withNoAnswerForUngroundedDrift = (
  structured: StructuredAnswerPayload,
  assessment: AnswerGroundingAssessment,
): StructuredAnswerPayload => {
  if (assessment.ok || structured.kind !== "interview") return structured;
  if (assessment.reason === "unsupported_behavioral_specifics") {
    return {
      kind: "interview",
      payload: {
        version: "1",
        answerNeeded: false,
        intent: "no_answer",
        spokenAnswer: "No responderia todavia: la pregunta pide una experiencia real, pero faltan detalles verificables para contar una historia concreta sin inventar datos.",
        keyPoints: ["Pedir mas contexto o usar una historia real del candidato", "No inventar empresa, metricas, fechas ni incidente"],
        correction: { needed: false, transition: null, correctedClaim: null },
        assumptions: [],
        evidenceRefs: [],
        followUpHint: null,
      },
    };
  }
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
