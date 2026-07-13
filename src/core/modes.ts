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
    systemPromptFragment: "Prefer Python unless context clearly indicates another language. Include approach, solution, complexity, edge cases, and what to say out loud.",
    defaultOutputFormat: ["Approach", "Code or change", "Complexity", "Edge cases if relevant"],
    responseLengthPreference: "medium",
  },
  {
    id: "system_design",
    label: "System Design",
    description: "Structured system design answers.",
    systemPromptFragment: "Clarify requirements, define scope, propose architecture, explain data flow, and call out tradeoffs.",
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
