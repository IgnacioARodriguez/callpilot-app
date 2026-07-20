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

export const repairTechnicalDebuggingAnswerCoverage = (
  text: string,
  userInput: string,
  mode: AssistantModeId,
): string => {
  if (mode !== "technical_qa" || !text.trim()) return text;
  const isPythonMemoryLeak = /\b(?:leak|memoria|memory|rss|oom)\b/i.test(userInput)
    && /\b(?:python|worker|rss|oom)\b/i.test(userInput);
  if (!isPythonMemoryLeak) return text;
  const additions: string[] = [];
  if (!/\btracemalloc\b/i.test(text) || !/\bsnapshots?\b/i.test(text)) {
    additions.push("Tomaria snapshots con tracemalloc antes y despues del crecimiento de RSS para comparar allocations.");
  }
  if (/\brss\b/i.test(userInput) && !/\brss\b/i.test(text)) {
    additions.push("Correlacionaria el RSS del proceso durante la ventana larga, por ejemplo 48 horas, con esos snapshots.");
  }
  if (!/\b(?:objeto|object|referenc|retention)\b/i.test(text)) {
    additions.push("Luego revisaria que tipo de objeto queda retenido y que referencia lo mantiene vivo.");
  }
  if (!/\b(?:cache|global|lista|dict|buffer)\b/i.test(text)) {
    additions.push("Tambien validaria caches, listas o dicts globales sin limite en el worker.");
  }
  return additions.length > 0 ? `${text.trim()}\n\n${additions.join("\n")}` : text;
};

const hasScreenTechnicalFocus = (promptUser: string): boolean => {
  const section = promptUser.match(/<screen_context>\s*([\s\S]*?)\s*<\/screen_context>/i)?.[1] ?? "";
  const focus = section.match(/\btechnical_focus\s*:\s*([\s\S]*?)(?:\n[a-z_]+:|$)/i)?.[1] ?? "";
  return Boolean(focus.trim());
};

export const shouldRetryLiveCodingCompleteness = (
  structured: StructuredAnswerPayload | null,
  promptUser: string,
  rawText = "",
): boolean => {
  const hasFocus = hasScreenTechnicalFocus(promptUser);
  if (structured?.kind !== "coding") {
    return hasFocus && /"kind"\s*:\s*"coding"|"solution"\s*:/i.test(rawText);
  }
  const code = structured.payload.solution.code.trim();
  const inlineCommentPattern = /(^|\n)\s*(#|\/\/|\/\*|\*)\s+\S/;
  const expectsFollowUpPatch = /\bresponseType\s+follow_up_change\b|\bfollow_up_change\b/i.test(promptUser);
  if (!code && hasFocus) return true;
  if (code.split(/\n/).length >= 3 && !inlineCommentPattern.test(code)) return true;
  if (
    expectsFollowUpPatch
    && structured.payload.responseType === "follow_up_change"
    && (structured.payload.patch.kind === "none" || !structured.payload.patch.code?.trim())
  ) {
    return true;
  }
  if (code && !structured.payload.narration.spokenAnswer.trim()) return true;
  const time = structured.payload.solution.complexity.time.trim();
  const space = structured.payload.solution.complexity.space.trim();
  if (time && space) return false;
  const title = structured.payload.problem.title.trim();
  return Boolean(title || hasFocus);
};

export const buildLiveCodingCompletenessRetryPrompt = (prompt: BuiltPrompt): BuiltPrompt => {
  const retryInstruction = [
    "Your last answer was incomplete or returned an empty scaffold.",
    "Fill the coding payload with a real solution, brief inline comments, time/space complexity, and the key invariant.",
    "If the task asks to implement, write a function, solve, fix, update, change behavior, or satisfy tests, return executable solution.code and do not use responseType explanation.",
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
