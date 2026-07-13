export interface InterviewAnswerPayload {
  version: "1";
  answerNeeded: boolean;
  intent: "technical_qa" | "behavioral" | "system_design" | "clarification" | "no_answer";
  spokenAnswer: string;
  keyPoints: string[];
  correction: {
    needed: boolean;
    transition: string | null;
    correctedClaim: string | null;
  };
  assumptions: string[];
  evidenceRefs: string[];
  followUpHint: string | null;
}

export interface CodingAnswerPayload {
  version: "1";
  answerNeeded: boolean;
  responseType: "initial_solution" | "explanation" | "follow_up_change" | "debug_fix" | "clarification";
  problem: {
    title: string;
    summary: string;
    language: string;
    functionSignature: string | null;
    constraints: string[];
  };
  solution: {
    approachSteps: string[];
    code: string;
    complexity: {
      time: string;
      space: string;
      rationale: string;
    };
    edgeCases: string[];
    invariants: string[];
  };
  narration: {
    spokenAnswer: string;
    currentStep: string;
  };
  tests: Array<{
    input: string;
    expected: string;
    rationale: string;
  }>;
  patch: {
    kind: "replace" | "diff" | "none";
    code: string | null;
  };
}

export type StructuredAnswerPayload =
  | { kind: "interview"; payload: InterviewAnswerPayload }
  | { kind: "coding"; payload: CodingAnswerPayload };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const asNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = asString(value);
  return text || null;
};
const asBoolean = (value: unknown, fallback = true): boolean => typeof value === "boolean" ? value : fallback;
const asStringArray = (value: unknown, max = 6): string[] =>
  Array.isArray(value) ? value.map(asString).filter(Boolean).slice(0, max) : [];

const extractJsonObject = (text: string): unknown | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const openBraces = (candidate.match(/{/g) ?? []).length;
    const closeBraces = (candidate.match(/}/g) ?? []).length;
    if (openBraces > closeBraces && openBraces - closeBraces <= 3) {
      try {
        return JSON.parse(`${candidate}${"}".repeat(openBraces - closeBraces)}`);
      } catch {}
    }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const sliced = candidate.slice(start, end + 1);
    try {
      return JSON.parse(sliced);
    } catch {
      const slicedOpenBraces = (sliced.match(/{/g) ?? []).length;
      const slicedCloseBraces = (sliced.match(/}/g) ?? []).length;
      if (slicedOpenBraces > slicedCloseBraces && slicedOpenBraces - slicedCloseBraces <= 3) {
        try {
          return JSON.parse(`${sliced}${"}".repeat(slicedOpenBraces - slicedCloseBraces)}`);
        } catch {}
      }
      return null;
    }
  }
};

export const parseInterviewAnswerPayload = (value: unknown): InterviewAnswerPayload | null => {
  const record = asRecord(value);
  if (!record) return null;
  const spokenAnswer = asString(record.spokenAnswer);
  if (!spokenAnswer) return null;
  const correction = asRecord(record.correction) ?? {};
  const intent = asString(record.intent);
  const normalizedIntent = ["technical_qa", "behavioral", "system_design", "clarification", "no_answer"].includes(intent)
    ? intent as InterviewAnswerPayload["intent"]
    : "technical_qa";
  return {
    version: "1",
    answerNeeded: asBoolean(record.answerNeeded, normalizedIntent !== "no_answer"),
    intent: normalizedIntent,
    spokenAnswer,
    keyPoints: asStringArray(record.keyPoints, 3),
    correction: {
      needed: asBoolean(correction.needed, false),
      transition: asNullableString(correction.transition),
      correctedClaim: asNullableString(correction.correctedClaim),
    },
    assumptions: asStringArray(record.assumptions, 3),
    evidenceRefs: asStringArray(record.evidenceRefs, 6),
    followUpHint: asNullableString(record.followUpHint),
  };
};

export const parseCodingAnswerPayload = (value: unknown): CodingAnswerPayload | null => {
  const record = asRecord(value);
  if (!record) return null;
  const solution = asRecord(record.solution);
  const narration = asRecord(record.narration);
  if (!solution || !narration) return null;
  const spokenAnswer = asString(narration.spokenAnswer);
  const code = asString(solution.code);
  if (!spokenAnswer && !code) return null;
  const problem = asRecord(record.problem) ?? {};
  const complexity = asRecord(solution.complexity) ?? {};
  const patch = asRecord(record.patch) ?? {};
  const responseType = asString(record.responseType);
  const normalizedResponseType = ["initial_solution", "explanation", "follow_up_change", "debug_fix", "clarification"].includes(responseType)
    ? responseType as CodingAnswerPayload["responseType"]
    : "explanation";
  const patchKind = asString(patch.kind);
  return {
    version: "1",
    answerNeeded: asBoolean(record.answerNeeded, true),
    responseType: normalizedResponseType,
    problem: {
      title: asString(problem.title),
      summary: asString(problem.summary),
      language: asString(problem.language) || "Python",
      functionSignature: asNullableString(problem.functionSignature),
      constraints: asStringArray(problem.constraints, 8),
    },
    solution: {
      approachSteps: asStringArray(solution.approachSteps, 5),
      code,
      complexity: {
        time: asString(complexity.time),
        space: asString(complexity.space),
        rationale: asString(complexity.rationale),
      },
      edgeCases: asStringArray(solution.edgeCases, 6),
      invariants: asStringArray(solution.invariants, 5),
    },
    narration: {
      spokenAnswer,
      currentStep: asString(narration.currentStep),
    },
    tests: Array.isArray(record.tests)
      ? record.tests.map((test) => {
        const item = asRecord(test) ?? {};
        return {
          input: asString(item.input),
          expected: asString(item.expected),
          rationale: asString(item.rationale),
        };
      }).filter((test) => test.input || test.expected).slice(0, 5)
      : [],
    patch: {
      kind: patchKind === "replace" || patchKind === "diff" ? patchKind : "none",
      code: asNullableString(patch.code),
    },
  };
};

export const parseStructuredAnswerPayload = (text: string): StructuredAnswerPayload | null => {
  const value = extractJsonObject(text);
  if (!value) return null;
  const record = asRecord(value);
  const explicitKind = asString(record?.kind);
  if (explicitKind === "coding") {
    const coding = parseCodingAnswerPayload(record?.payload ?? record);
    return coding ? { kind: "coding", payload: coding } : null;
  }
  if (explicitKind === "interview") {
    const interview = parseInterviewAnswerPayload(record?.payload ?? record);
    return interview ? { kind: "interview", payload: interview } : null;
  }
  const coding = parseCodingAnswerPayload(value);
  if (coding) return { kind: "coding", payload: coding };
  const interview = parseInterviewAnswerPayload(value);
  return interview ? { kind: "interview", payload: interview } : null;
};

export const formatStructuredAnswerPayload = (structured: StructuredAnswerPayload): string => {
  if (structured.kind === "interview") {
    const payload = structured.payload;
    const lines = [
      payload.correction.needed && payload.correction.transition ? `**Correccion:** ${payload.correction.transition}` : "",
      `**Respuesta:** ${payload.spokenAnswer}`,
      payload.keyPoints.length ? `**Puntos:** ${payload.keyPoints.join(" | ")}` : "",
      payload.assumptions.length ? `**Supuestos:** ${payload.assumptions.join(" | ")}` : "",
      payload.followUpHint ? `**Follow-up:** ${payload.followUpHint}` : "",
    ];
    return lines.filter(Boolean).join("\n\n");
  }

  const payload = structured.payload;
  const lines = [
    payload.narration.spokenAnswer ? `**Respuesta:** ${payload.narration.spokenAnswer}` : "",
    payload.solution.approachSteps.length ? `**Enfoque:** ${payload.solution.approachSteps.join(" ")}` : "",
    payload.solution.code ? `**Codigo:**\n\`\`\`${payload.problem.language.toLowerCase() || "python"}\n${payload.solution.code}\n\`\`\`` : "",
    payload.solution.complexity.time || payload.solution.complexity.space
      ? `**Complejidad:** Tiempo ${payload.solution.complexity.time || "N/A"}, espacio ${payload.solution.complexity.space || "N/A"}. ${payload.solution.complexity.rationale}`
      : "",
    payload.solution.edgeCases.length ? `**Casos borde:** ${payload.solution.edgeCases.join(" | ")}` : "",
  ];
  return lines.filter(Boolean).join("\n\n");
};
