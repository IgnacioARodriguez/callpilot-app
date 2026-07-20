export type AssistantModeId = "live_coding" | "system_design" | "behavioral" | "technical_qa" | "meeting_notes";

export interface ModeDefinition {
  id: AssistantModeId;
  label: string;
  description: string;
  systemPromptFragment: string;
  defaultOutputFormat: string[];
  responseLengthPreference: "short" | "medium" | "detailed";
}

export const MODES: ModeDefinition[] = [
  {
    id: "live_coding",
    label: "Live Coding",
    description: "Step-by-step coding interview support.",
    systemPromptFragment: "Prefer Python unless context clearly indicates another language. First answer with the optimal interview approach, invariant, data structure or pointer strategy, and time/space complexity. Always populate solution.code for coding answers when a concrete solution or change is possible. solution.code must include brief inline comments explaining each meaningful block or line; for Python include at least two # comments in non-trivial solutions. Keep narration.spokenAnswer short, sayable, and distinct from the commented code panel.",
    defaultOutputFormat: ["Approach", "Code or change", "Complexity", "Edge cases if relevant"],
    responseLengthPreference: "medium",
  },
  {
    id: "system_design",
    label: "System Design",
    description: "Structured system design answers.",
    systemPromptFragment: "Clarify requirements, define scope, propose architecture, explain data flow, and call out tradeoffs. Preserve late interviewer constraints and do not present unprovided numeric SLAs, region counts, traffic ratios, or business facts as facts. If a summary request lists named items, cover each named item explicitly and do not revert to earlier partial questions. For executive summaries after requirement changes, cover three compact clauses in order: final architecture/tradeoff, consistency choice for counters, and Redis-alone limitation. When asked why a simple component like Redis alone is not enough, state durability, source-of-truth, and cross-region consistency limits before proposing alternatives.",
    defaultOutputFormat: ["Requirements", "Architecture", "Data flow", "Tradeoffs", "Scaling risks", "What to say out loud"],
    responseLengthPreference: "detailed",
  },
  {
    id: "behavioral",
    label: "Behavioral",
    description: "Concrete STAR interview answers.",
    systemPromptFragment: "Use the provided background. Avoid generic filler. Provide short and expanded versions.",
    defaultOutputFormat: ["Short answer", "STAR version", "Stronger phrasing", "Follow-up questions"],
    responseLengthPreference: "medium",
  },
  {
    id: "technical_qa",
    label: "Technical Q&A",
    description: "Concise direct technical explanations.",
    systemPromptFragment: "Answer directly, give an example when useful, and mention tradeoffs.",
    defaultOutputFormat: ["Respuesta", "Ejemplo or tradeoff only if useful", "Para decir"],
    responseLengthPreference: "short",
  },
  {
    id: "meeting_notes",
    label: "Meeting Notes",
    description: "Technical conversation recap.",
    systemPromptFragment: "Extract summary, decisions, action items, risks, requirements, and assumptions.",
    defaultOutputFormat: ["Summary", "Decisions", "Action items", "Risks", "Requirements", "Assumptions"],
    responseLengthPreference: "medium",
  },
];

export const modeById = (id: AssistantModeId) => MODES.find((mode) => mode.id === id) ?? MODES[0];
