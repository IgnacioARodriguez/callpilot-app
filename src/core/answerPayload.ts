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

export interface RenderAnswerOptions {
  mode?: "interview" | "coding";
  maxInterviewWords?: number;
}

export const STRUCTURED_ANSWER_PAYLOAD_JSON_SCHEMA = {
  name: "callpilot_structured_answer",
  schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["interview", "coding"] },
      payload: {
        type: "object",
        properties: {
          version: { type: "string", enum: ["1"] },
          answerNeeded: { type: "boolean" },
          intent: { type: ["string", "null"], enum: ["technical_qa", "behavioral", "system_design", "clarification", "no_answer", null] },
          responseType: { type: ["string", "null"], enum: ["initial_solution", "explanation", "follow_up_change", "debug_fix", "clarification", null] },
          spokenAnswer: { type: "string" },
          keyPoints: { type: "array", items: { type: "string" } },
          correction: {
            type: "object",
            properties: {
              needed: { type: "boolean" },
              transition: { type: ["string", "null"] },
              correctedClaim: { type: ["string", "null"] },
            },
            required: ["needed", "transition", "correctedClaim"],
            additionalProperties: false,
          },
          assumptions: { type: "array", items: { type: "string" } },
          evidenceRefs: { type: "array", items: { type: "string" } },
          followUpHint: { type: ["string", "null"] },
          problem: {
            type: "object",
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              language: { type: "string" },
              functionSignature: { type: ["string", "null"] },
              constraints: { type: "array", items: { type: "string" } },
            },
            required: ["title", "summary", "language", "functionSignature", "constraints"],
            additionalProperties: false,
          },
          solution: {
            type: "object",
            properties: {
              approachSteps: { type: "array", items: { type: "string" } },
              code: { type: "string" },
              complexity: {
                type: "object",
                properties: {
                  time: { type: "string" },
                  space: { type: "string" },
                  rationale: { type: "string" },
                },
                required: ["time", "space", "rationale"],
                additionalProperties: false,
              },
              edgeCases: { type: "array", items: { type: "string" } },
              invariants: { type: "array", items: { type: "string" } },
            },
            required: ["approachSteps", "code", "complexity", "edgeCases", "invariants"],
            additionalProperties: false,
          },
          narration: {
            type: "object",
            properties: {
              spokenAnswer: { type: "string" },
              currentStep: { type: "string" },
            },
            required: ["spokenAnswer", "currentStep"],
            additionalProperties: false,
          },
          tests: {
            type: "array",
            items: {
              type: "object",
              properties: {
                input: { type: "string" },
                expected: { type: "string" },
                rationale: { type: "string" },
              },
              required: ["input", "expected", "rationale"],
              additionalProperties: false,
            },
          },
          patch: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["replace", "diff", "none"] },
              code: { type: ["string", "null"] },
            },
            required: ["kind", "code"],
            additionalProperties: false,
          },
        },
        required: [
          "version",
          "answerNeeded",
          "intent",
          "responseType",
          "spokenAnswer",
          "keyPoints",
          "correction",
          "assumptions",
          "evidenceRefs",
          "followUpHint",
          "problem",
          "solution",
          "narration",
          "tests",
          "patch",
        ],
        additionalProperties: false,
      },
    },
    required: ["kind", "payload"],
    additionalProperties: false,
  },
} as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const stripLeadingLabel = (value: string): string =>
  value.replace(/^\s*(?:\*\*)?(respuesta|answer|para\s+d[\p{L}]+|correccion|corrección|enfoque|approach)(?:\*\*)?\s*:\s*/iu, "").trim();
const asNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = asString(value);
  return text || null;
};
const asBoolean = (value: unknown, fallback = true): boolean => typeof value === "boolean" ? value : fallback;
const asStringArray = (value: unknown, max = 6): string[] =>
  Array.isArray(value) ? value.map(asString).filter(Boolean).slice(0, max) : [];

const splitSentences = (value: string): string[] =>
  value
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

const stripMarkdownDecoration = (value: string): string =>
  value
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "");

const stripInterviewMeta = (value: string): string =>
  value
    .replace(/^\s*(?:ahi|ah[ií]|sure|of course|claro|por supuesto)[^.\n:]*[:.-]?\s*/i, "")
    .replace(/^\s*(?:respuesta estructurada|segun tus requisitos|según tus requisitos)[^.\n:]*[:.-]?\s*/i, "")
    .replace(/^\s*---+\s*/gm, "")
    .replace(/^\s*(?:para recuerdos previos|recuerdos previos)\s*:\s*.*(?:\n|$)/gim, "")
    .replace(/\b(?:opcional|si el entrevistador profundiza|para profundizar si se le pregunta)\b.*$/gim, "")
    .trim();

const stripInterviewCode = (value: string): string =>
  value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*(?:import\s+\w+|def\s+\w+\(|class\s+\w+|const\s+\w+|let\s+\w+|var\s+\w+|SELECT\s+|WITH\s+).*(?:\n|$)/gim, "")
    .trim();

const stripJsonScaffold = (value: string): string =>
  value
    .replace(/^\s*\{\s*$/gm, "")
    .replace(/^\s*"\w+"\s*:\s*[\[{]?.*$/gm, "")
    .replace(/^\s*[}\]],?\s*$/gm, "")
    .replace(/^\s*"?(?:kind|payload|version|answerNeeded|intent|responseType|keyPoints|correction|assumptions|evidenceRefs|followUpHint|problem|solution|tests|patch)"?\s*:.*$/gim, "")
    .trim();

const extractLooseSpokenAnswer = (text: string): string => {
  const normalized = text.replace(/\r\n/g, "\n");
  const keyIndex = normalized.search(/"spokenAnswer"\s*:/i);
  if (keyIndex < 0) return "";
  const afterKey = normalized.slice(keyIndex).replace(/^"spokenAnswer"\s*:\s*/i, "").trim();
  const quoted = afterKey.match(/^"([\s\S]*?)(?<!\\)"\s*(?:,|\n\s*"\w+"\s*:|\n\s*[}\]])/);
  if (quoted?.[1]) return quoted[1].replace(/\\"/g, "\"").trim();
  const untilNextKey = afterKey.split(/\n\s*"(?:keyPoints|correction|assumptions|evidenceRefs|followUpHint|problem|solution|tests|patch|narration)"\s*:/i)[0] ?? afterKey;
  return untilNextKey
    .replace(/^["']?/, "")
    .replace(/[,}\]]+\s*$/, "")
    .trim();
};

const removeBadArtifactLines = (value: string): string =>
  value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/(?:\.(?:get|set|raise)\b|para dici\b|latiencia\b|deshilaceraoin\b|responseivo\b|conoptimistic\b|bifrost\b|sadece\b|conipo\b|despeici\b|来源)/i.test(line))
    .join("\n");

const limitWords = (value: string, maxWords: number): string => {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return value;
  return `${words.slice(0, maxWords).join(" ").replace(/[,:;]$/, "")}.`;
};

export const normalizeInterviewAnswerText = (text: string, options: RenderAnswerOptions = {}): string => {
  const maxWords = options.maxInterviewWords ?? 130;
  const looseSpokenAnswer = extractLooseSpokenAnswer(text);
  const source = looseSpokenAnswer || text;
  const withoutCode = stripInterviewCode(source);
  const cleaned = stripLeadingLabel(stripMarkdownDecoration(stripJsonScaffold(stripInterviewMeta(withoutCode))))
    .replace(/\b(?:interviewer|entrevistador)\s*:\s*/gi, "")
    .replace(/\s+\)/g, ")")
    .replace(/\(\s+/g, "(")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const withoutArtifacts = removeBadArtifactLines(cleaned);
  const withoutNestedLabel = stripLeadingLabel(withoutArtifacts);
  const sentences = splitSentences(withoutNestedLabel);
  const compact = sentences.length > 4 ? sentences.slice(0, 4).join(" ") : withoutNestedLabel;
  return limitWords(compact, maxWords).trim();
};

export const formatAnswerForDisplay = (
  rawText: string,
  structured: StructuredAnswerPayload | null = parseStructuredAnswerPayload(rawText),
  options: RenderAnswerOptions = {},
): string => {
  if (structured) return formatStructuredAnswerPayload(structured, options);
  if (options.mode === "coding") return rawText.trim();
  const normalized = normalizeInterviewAnswerText(rawText, options);
  return normalized ? `**Respuesta:** ${normalized}` : rawText.trim();
};

const extractJsonObject = (text: string): unknown | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  const parseLenient = (value: string): unknown | null => {
    const quoteBareIntent = (input: string) =>
      input.replace(/("intent"\s*:\s*)([^"',{}\]\s][^,}\n\r]*)/g, (_match, prefix: string, raw: string) => {
        const cleaned = String(raw).trim();
        if (!cleaned || cleaned === "null" || cleaned === "true" || cleaned === "false") return `${prefix}${cleaned}`;
        return `${prefix}"${cleaned.replace(/"/g, "\\\"")}"`;
      });
    const stripTrailingNumericFields = (input: string) => {
      const index = input.search(/,\s*\d+\s*:\s*\{/);
      if (index < 0) return input;
      const prefix = input.slice(0, index);
      const openBraces = (prefix.match(/{/g) ?? []).length;
      const closeBraces = (prefix.match(/}/g) ?? []).length;
      return `${prefix}${"}".repeat(Math.max(0, openBraces - closeBraces))}`;
    };
    const repairs = [
      value,
      quoteBareIntent(value),
      quoteBareIntent(value.replace(/`,\s*"/g, "\", \"")),
      stripTrailingNumericFields(quoteBareIntent(value)),
      stripTrailingNumericFields(quoteBareIntent(value.replace(/`,\s*"/g, "\", \""))),
    ];
    for (const repaired of repairs) {
      try {
        return JSON.parse(repaired);
      } catch {}
    }
    return null;
  };
  try {
    return JSON.parse(candidate);
  } catch {
    const openBraces = (candidate.match(/{/g) ?? []).length;
    const closeBraces = (candidate.match(/}/g) ?? []).length;
    if (openBraces > closeBraces && openBraces - closeBraces <= 3) {
      const parsed = parseLenient(`${candidate}${"}".repeat(openBraces - closeBraces)}`);
      if (parsed) return parsed;
    }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const sliced = candidate.slice(start, end + 1);
    const parsed = parseLenient(sliced);
    if (parsed) return parsed;
    try {
      return JSON.parse(sliced);
    } catch {
      const slicedOpenBraces = (sliced.match(/{/g) ?? []).length;
      const slicedCloseBraces = (sliced.match(/}/g) ?? []).length;
      if (slicedOpenBraces > slicedCloseBraces && slicedOpenBraces - slicedCloseBraces <= 3) {
        const repaired = parseLenient(`${sliced}${"}".repeat(slicedOpenBraces - slicedCloseBraces)}`);
        if (repaired) return repaired;
      }
      return null;
    }
  }
};

export const parseInterviewAnswerPayload = (value: unknown): InterviewAnswerPayload | null => {
  const record = asRecord(value);
  if (!record) return null;
  const narration = asRecord(record.narration) ?? {};
  const spokenAnswer = asString(record.spokenAnswer) || asString(narration.spokenAnswer);
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
  const narration = asRecord(record.narration) ?? {};
  if (!solution) return null;
  const spokenAnswer = asString(narration.spokenAnswer) || asString(record.spokenAnswer);
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

export const formatStructuredAnswerPayload = (structured: StructuredAnswerPayload, options: RenderAnswerOptions = {}): string => {
  if (structured.kind === "interview") {
    const payload = structured.payload;
    const spokenAnswer = normalizeInterviewAnswerText(payload.spokenAnswer, options);
    const lines = [
      payload.correction.needed && payload.correction.transition ? `**Correccion:** ${normalizeInterviewAnswerText(payload.correction.transition, { ...options, maxInterviewWords: 40 })}` : "",
      `**Respuesta:** ${spokenAnswer}`,
      payload.keyPoints.length ? `**Puntos:** ${payload.keyPoints.map((item) => normalizeInterviewAnswerText(item, { ...options, maxInterviewWords: 24 })).filter(Boolean).join(" | ")}` : "",
      payload.assumptions.length ? `**Supuestos:** ${payload.assumptions.map((item) => normalizeInterviewAnswerText(item, { ...options, maxInterviewWords: 24 })).filter(Boolean).join(" | ")}` : "",
      payload.intent !== "no_answer" && payload.followUpHint ? `**Follow-up:** ${payload.followUpHint}` : "",
    ];
    return lines.filter(Boolean).join("\n\n");
  }

  const payload = structured.payload;
  const lines = [
    payload.narration.spokenAnswer ? `**Respuesta:** ${stripLeadingLabel(payload.narration.spokenAnswer)}` : "",
    payload.solution.approachSteps.length ? `**Enfoque:** ${payload.solution.approachSteps.join(" ")}` : "",
    payload.solution.code ? `**Codigo:**\n\`\`\`${payload.problem.language.toLowerCase() || "python"}\n${payload.solution.code}\n\`\`\`` : "",
    payload.solution.complexity.time || payload.solution.complexity.space
      ? `**Complejidad:** Tiempo ${payload.solution.complexity.time || "N/A"}, espacio ${payload.solution.complexity.space || "N/A"}. ${payload.solution.complexity.rationale}`
      : "",
    payload.solution.edgeCases.length ? `**Casos borde:** ${payload.solution.edgeCases.join(" | ")}` : "",
  ];
  return lines.filter(Boolean).join("\n\n");
};
