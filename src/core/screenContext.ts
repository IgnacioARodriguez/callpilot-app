export type ScreenKind =
  | "coding_problem"
  | "code_editor"
  | "system_design_diagram"
  | "documentation"
  | "meeting_transcript"
  | "unknown";

export interface ScreenContext {
  kind: ScreenKind;
  visibleText: string;
  summary: string;
  problemTitle?: string;
  detectedLanguage?: string;
  examples?: string[];
  constraints?: string[];
  screenshotPath?: string;
  confidence: number;
  capturedAt?: number;
}

export const createEmptyScreenContext = (capturedAt = Date.now()): ScreenContext => ({
  kind: "unknown",
  visibleText: "",
  summary: "",
  confidence: 0,
  capturedAt,
});

const score = (text: string, patterns: RegExp[]) =>
  patterns.reduce((total, pattern) => total + (pattern.test(text) ? 1 : 0), 0);

const detectedLanguage = (text: string): string | undefined => {
  if (/\bdef\s+\w+\s*\(|\bfrom\s+\w+\s+import\b/i.test(text)) return "Python";
  if (/\bfunction\s+\w+\s*\(|=>|console\.log\b/.test(text)) return "JavaScript";
  if (/\binterface\s+\w+|:\s*(string|number|boolean)\b/.test(text)) return "TypeScript";
  if (/\bpublic\s+class\b|\bSystem\.out\.println\b/.test(text)) return "Java";
  if (/#include\s*<|std::|cout\s*<</.test(text)) return "C++";
  return undefined;
};

export const classifyScreenText = (visibleText: string): ScreenContext => {
  const text = visibleText.trim();
  if (!text) return createEmptyScreenContext();
  const lower = text.toLowerCase();
  const scores: Record<ScreenKind, number> = {
    coding_problem: score(lower, [/\bleetcode\b/, /\bexamples?\s*\d*\s*:/, /\bconstraints?\s*:/, /\binput\s*:.*\boutput\s*:/s]),
    code_editor: score(text, [/\b(def|class|import|from|function|const|let|var|public|private)\b/, /\.(ts|tsx|js|jsx|py|java|cpp)\b/i, /[{};]\s*$/]),
    system_design_diagram: score(lower, [/\barchitecture\b|\bsystem design\b/, /\bqueue\b|\bkafka\b/, /\bcache\b|\bredis\b/, /\bdatabase\b|\bshard\b/, /->|-->|=>/]),
    documentation: score(lower, [/\bapi reference\b|\bdocumentation\b|\bdocs\b/, /\bparameters\b|\breturns\b/, /\binstallation\b|\bquickstart\b/, /\bendpoint\b|\bhttp\b/]),
    meeting_transcript: score(text, [/^\s*\d{1,2}:\d{2}(?::\d{2})?\s+/m, /^\s*(?!Input|Output|Example|Constraints)[A-Z][A-Za-z ]{1,30}:\s+.+/m, /\baction items?\b|\bdecisions?\b|\bfollow[- ]?ups?\b/i]),
    unknown: 0,
  };
  const [kind, best] = (Object.entries(scores) as Array<[ScreenKind, number]>)
    .filter(([candidate]) => candidate !== "unknown")
    .sort((a, b) => b[1] - a[1])[0];
  const resolved = best > 0 ? kind : "unknown";
  const title = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0 && line.length < 100);

  return {
    kind: resolved,
    visibleText: text,
    summary: text.slice(0, 240),
    problemTitle: resolved === "coding_problem" ? title : undefined,
    detectedLanguage: detectedLanguage(text),
    examples: resolved === "coding_problem" ? text.match(/Example\s+\d*:?[^\n]*(?:\n\s{0,4}.+){0,3}/gi)?.slice(0, 3) ?? [] : undefined,
    constraints: resolved === "coding_problem" ? (text.match(/constraints?:([\s\S]{0,700})/i)?.[1] ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 6) : undefined,
    confidence: best > 0 ? Math.min(0.95, 0.35 + best * 0.15) : 0.1,
    capturedAt: Date.now(),
  };
};
