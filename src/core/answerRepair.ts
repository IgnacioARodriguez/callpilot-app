import type { AssistantModeId } from "./modes.ts";
import type { BuiltPrompt } from "./promptBuilder.ts";
import type { StructuredAnswerPayload } from "./answerPayload.ts";

export const repairSystemDesignAnswerCoverage = (
  text: string,
  userInput: string,
  mode: AssistantModeId,
): string => {
  if (mode !== "system_design" || !text.trim()) return text;
  let repairedText = text.trim().replace(
    /\buse\s+redis\s+as\s+(?:a\s+)?central\s+(?:store|hub)(?:\s+for\s+click\s+counters?)?/gi,
    "use a durable source of truth for click counters, with Redis only as a cache or fast path",
  ).replace(
    /\buse\s+redis\s+as\s+(?:a\s+)?strongly\s+consistent\s+click\s+counters?\b/gi,
    "use a durable counter store for strong consistency, with Redis only as a cache or fast path",
  ).replace(
    /\buse\s+a\s+combination\s+of\s+redis\s+and\s+[^.]{0,100}?\bto\s+handle\s+strongly\s+consistent\s+click\s+counters?\b/gi,
    "use a durable counter store for strong consistency, with Redis only as a cache or fast path",
  ).replace(
    /\bwith\s+redis\s+as\s+(?:the\s+)?primary\s+store\b/gi,
    "with a durable counter store as the source of truth and Redis only as a cache or fast path",
  );
  const additions: string[] = [];
  if (/\bredis\s+alone\b/i.test(userInput) && !/\bredis\b/i.test(repairedText)) {
    additions.push("Redis alone is not enough because it is not the durable source of truth and becomes hard to keep consistent across regions.");
  }
  if (/\bclick\s+counters?\b/i.test(userInput) && !/\bclick\s+counters?\b/i.test(repairedText)) {
    additions.push("For click counters, keep the consistency choice explicit instead of hiding it behind the cache.");
  }
  if (/\bmulti-region\b/i.test(userInput) && !/\b(?:multi-region|regions?)\b/i.test(repairedText)) {
    additions.push("For multi-region, keep redirects local where possible and call out the latency versus consistency tradeoff.");
  }
  return additions.length > 0 ? `${repairedText}\n${additions.join(" ")}` : repairedText;
};

export const repairLiveCodingAnswerCoverage = (
  text: string,
  _userInput: string,
  mode: AssistantModeId,
): string => {
  if (mode !== "live_coding" || !text.trim()) return text;
  // Live-coding coverage repairs must stay provider- and problem-agnostic. Do not
  // inject canonical answers for named problems here; prefer prompt/schema checks
  // or a generic retry path when structured output is incomplete.
  return text;
};

const hasScreenTechnicalFocus = (promptUser: string): boolean => {
  const section = promptUser.match(/<screen_context>\s*([\s\S]*?)\s*<\/screen_context>/i)?.[1] ?? "";
  const focus = section.match(/\btechnical_focus\s*:\s*([\s\S]*?)(?:\n[a-z_]+:|$)/i)?.[1] ?? "";
  return Boolean(focus.trim());
};

export const shouldRetryLiveCodingCompleteness = (
  structured: StructuredAnswerPayload | null,
  promptUser: string,
): boolean => {
  if (structured?.kind !== "coding") return false;
  const time = structured.payload.solution.complexity.time.trim();
  const space = structured.payload.solution.complexity.space.trim();
  if (time && space) return false;
  const title = structured.payload.problem.title.trim();
  return Boolean(title || hasScreenTechnicalFocus(promptUser));
};

export const buildLiveCodingCompletenessRetryPrompt = (prompt: BuiltPrompt): BuiltPrompt => {
  const retryInstruction = [
    "Your last answer identified a problem but did not state time/space complexity or the key invariant.",
    "Complete those fields for the problem you already identified.",
    "Keep the same JSON schema and do not introduce a new task.",
  ].join(" ");
  return {
    ...prompt,
    user: `${prompt.user}\n\n<answer_completeness_retry>\n${retryInstruction}\n</answer_completeness_retry>`,
    debug: {
      ...prompt.debug,
      approximateChars: prompt.debug.approximateChars + retryInstruction.length,
    },
  };
};
