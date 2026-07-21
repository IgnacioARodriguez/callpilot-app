import type { AssistantModeId } from "./modes.ts";
import type { BuiltPrompt } from "./promptBuilder.ts";
import type { StructuredAnswerPayload } from "./answerPayload.ts";

export const repairSystemDesignAnswerCoverage = (
  text: string,
  _userInput: string,
  mode: AssistantModeId,
): string => {
  if (mode !== "system_design" || !text.trim()) return text;
  // Semantic answer repairs are intentionally disabled. Missing architecture
  // facts must remain observable model failures or be addressed by a retry.
  return text;
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
  _userInput: string,
  mode: AssistantModeId,
): string => {
  if (mode !== "technical_qa" || !text.trim()) return text;
  // Semantic answer repairs are intentionally disabled. Missing debugging
  // diagnostics must remain observable model failures or be addressed by retry.
  return text;
};

const hasScreenTechnicalFocus = (promptUser: string): boolean => {
  const section = promptUser.match(/<screen_context>\s*([\s\S]*?)\s*<\/screen_context>/i)?.[1] ?? "";
  const focus = section.match(/\btechnical_focus\s*:\s*([\s\S]*?)(?:\n[a-z_]+:|$)/i)?.[1] ?? "";
  return Boolean(focus.trim());
};

const screenContextText = (promptUser: string): string =>
  promptUser.match(/<screen_context>\s*([\s\S]*?)\s*<\/screen_context>/i)?.[1] ?? "";

const promptSection = (promptUser: string, name: string): string =>
  promptUser.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*<\\/${name}>`, "i"))?.[1] ?? "";

const explicitRenameRequest = (promptUser: string): boolean =>
  /\b(rename|renaming|change\s+the\s+(?:function|method|class)\s+name|different\s+(?:function|method|class)\s+name|renombr|cambia(?:r)?\s+el\s+nombre|otro\s+nombre)\b/i.test([
    promptSection(promptUser, "latest_actionable_input"),
    promptSection(promptUser, "current_question"),
    promptSection(promptUser, "user_input"),
  ].join("\n"));

export const extractVisibleCodeSymbols = (promptUser: string): string[] => {
  const text = screenContextText(promptUser);
  const symbols = new Set<string>();
  const patterns = [
    /\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    /\basync\s+def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g,
    /\b(?:public|private|protected)?\s*(?:static\s+)?[\w<>\[\], ?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*\{/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1]?.trim();
      if (name && !/^(if|for|while|switch|catch|return)$/.test(name)) symbols.add(name);
    }
  }
  return [...symbols];
};

export const violatesVisibleCodeContinuity = (
  structured: StructuredAnswerPayload | null,
  promptUser: string,
): boolean => {
  if (structured?.kind !== "coding" || explicitRenameRequest(promptUser)) return false;
  const visibleSymbols = extractVisibleCodeSymbols(promptUser);
  if (visibleSymbols.length === 0) return false;
  const code = structured.payload.solution.code;
  if (!code.trim()) return false;
  return visibleSymbols.some((symbol) => !new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(code));
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
  if (violatesVisibleCodeContinuity(structured, promptUser)) return true;
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
    "If screen_context contains visible functions, methods, classes, parameters, variables, or starter code, preserve those names and edit that code unless the latest request explicitly asks to rename them.",
    "Do not create a parallel replacement function when the editor already shows a function or stub for the same task.",
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
