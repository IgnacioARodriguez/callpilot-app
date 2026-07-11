export interface StructuredAnswer {
  headline: string;
  keywords: string[];
  detail: string;
}

export const STRUCTURED_ANSWER_JSON_SCHEMA = {
  name: "structured_interview_answer",
  schema: {
    type: "object",
    properties: {
      headline: { type: "string" },
      keywords: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 5 },
      detail: { type: "string" },
    },
    required: ["headline", "keywords", "detail"],
    additionalProperties: false,
  },
} as const;
