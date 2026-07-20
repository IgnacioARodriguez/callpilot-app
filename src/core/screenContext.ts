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

const exactUiNoisePatterns = [
  /^\s*(?:coderpad|run code|submit|reset code|invite|instructions|interview pad|execution output|console|stdin|stdout|timer|settings|participants?|chat)\s*$/i,
  /^\s*(?:file|edit|view|history|bookmarks|profiles?|window|help)\s*$/i,
];

const uiNoisePatterns = [
  /\b(video player|viewing replay|facebook logo|yellow button|sign up|signup|interviewing\.io|callpilot e2e video player)\b/i,
  /\b(location|purpose|key features|top-left corner|bottom of the screen|top-right corner)\b/i,
  /\bthe image shows|screenshot of|the purpose of this image|features of the image\b/i,
  /\bvision summary|secondary; ignore if it conflicts with ocr|ignoredui\b/i,
  /\bplayback|controls|button reads|title:\s*viewing replay\b/i,
  /\b(address bar|browser chrome|google chrome|new tab|reload|bookmark|extensions?|zoom\s*\d+%|https?:\/\/)\b/i,
  /^\s*(?:earlier|previous|old|stale)\s+(?:transcript|conversation|question|answer)\s*:/i,
];

const technicalSignalPatterns = [
  /\b(given|return|determine|valid|invalid|constraints?|examples?|input|output|expected|edge cases?)\b/i,
  /\b(linked list|binary tree|bst|binary search tree|tree|node|root|left|right|subtree|odd|even|indices)\b/i,
  /\b(hash ?map|set|stack|queue|heap|graph|array|string|matrix|pointer|recursion|bounds?|invariant)\b/i,
  /\b(o\([^)]+\)|complexity|time|space|constant|linear|logarithmic)\b/i,
  /\b(error|exception|traceback|failed|failing|assert|test|expected|actual)\b/i,
  /\b(def|class|return|import|from|function|const|let|var|public|private|while|for|if|else)\b/,
  /[{};=<>]|\w+\.\w+|\w+\([^)]*\)/,
];

const hasTechnicalSignal = (line: string): boolean =>
  technicalSignalPatterns.some((pattern) => pattern.test(line));

const isUiNoise = (line: string): boolean => {
  if (exactUiNoisePatterns.some((pattern) => pattern.test(line))) return true;
  const looksLikeUiNoise = uiNoisePatterns.some((pattern) => pattern.test(line));
  if (!looksLikeUiNoise) return false;
  const hasCriticalCoderPadSignal = /\b(failing|failed|assert|expected|actual|traceback|error|exception|def|class|return|input|output|constraints?|examples?)\b/i.test(line);
  return !hasCriticalCoderPadSignal;
};

export const extractTechnicalScreenFocus = (visibleText: string, maxLines = 32): string => {
  const lines = visibleText
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  const focused = lines
    .filter((line) => hasTechnicalSignal(line) && !isUiNoise(line))
    .slice(0, maxLines);
  if (focused.length > 0) {
    const title = lines.find((line) =>
      !isUiNoise(line)
      && !focused.includes(line)
      && /^[A-Z0-9][A-Za-z0-9 +#.'_-]{1,80}$/.test(line)
    );
    return [title, ...focused].filter(Boolean).slice(0, maxLines).join("\n");
  }

  return lines
    .filter((line) => !isUiNoise(line))
    .slice(0, Math.min(maxLines, 12))
    .join("\n");
};

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
  const text = extractTechnicalScreenFocus(visibleText).trim() || visibleText.trim();
  if (!text) return createEmptyScreenContext();
  const lower = text.toLowerCase();
  const scores: Record<ScreenKind, number> = {
    coding_problem: score(lower, [/\bleetcode\b|\bcoderpad\b/, /\bexamples?\s*\d*\s*:/, /\bconstraints?\s*:/, /\binput\s*:.*\boutput\s*:/s, /\bwrite\s+a\s+(?:function|method)\b/]),
    code_editor: score(text, [/\b(def|class|import|from|function|const|let|var|public|private)\b/, /\.(ts|tsx|js|jsx|py|java|cpp)\b/i, /[{};]\s*$/, /\bRun Code\b|\bCoderPad\b/i]),
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
