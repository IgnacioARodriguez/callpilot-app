import type { CodingAnswerPayload } from "./answerPayload.ts";
import type { AssistantModeId } from "./modes.ts";

const countWords = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;

export const compactLiveSpokenAnswer = (
  value: string,
  options: { mode: AssistantModeId; userInput: string },
): { text: string; compacted: boolean; originalWords: number; finalWords: number } => {
  const originalWords = countWords(value);
  const maxWords = options.mode === "live_coding" ? 120 : 100;
  let text = value
    .replace(/\*{0,2}to say:\*{0,2}\s*/gi, "")
    .replace(/\*{0,2}respuesta:\*{0,2}\s*/gi, "")
    .replace(/^to say:\s*/i, "")
    .replace(/^respuesta:\s*/i, "")
    .trim();

  if (!text) text = value.trim();

  if (options.mode !== "live_coding" && countWords(text) > maxWords) {
    const sentences = text.match(/[^.!?]+[.!?]?/g) ?? [text];
    const selected: string[] = [];
    for (const sentence of sentences) {
      const candidate = [...selected, sentence.trim()].filter(Boolean).join(" ");
      if (countWords(candidate) > maxWords) break;
      selected.push(sentence.trim());
    }
    text = selected.join(" ").trim();
    if (!text) text = value.trim().split(/\s+/).slice(0, maxWords).join(" ");
  }

  text = text.replace(/\n{3,}/g, "\n\n").trim();
  const finalWords = countWords(text);
  return {
    text,
    compacted: text !== value.trim(),
    originalWords,
    finalWords,
  };
};

export const buildLiveCodingFollowUpPrompt = (input: {
  changeRequest: string;
  currentSolution: CodingAnswerPayload;
  problemContext?: string;
}): string => {
  const solution = input.currentSolution;
  return [
    "user_request: Modify the current live-coding solution.",
    "task: Treat this as a follow-up on the same exercise. Return responseType follow_up_change, an updated commented solution.code, a non-null patch describing the diff, and a short narration.spokenAnswer explaining the change.",
    "patch_rule: Prefer patch.kind diff with only the changed lines plus minimal context. Keep patch.code compact, usually under 25 lines. Do not duplicate the entire solution in patch.code when solution.code already contains the full updated code.",
    `requested_change: ${input.changeRequest.trim()}`,
    input.problemContext?.trim() ? `problem_context:\n${input.problemContext.trim()}` : "",
    "current_problem:",
    `title: ${solution.problem.title}`,
    `summary: ${solution.problem.summary}`,
    `language: ${solution.problem.language}`,
    solution.problem.functionSignature ? `function_signature: ${solution.problem.functionSignature}` : "",
    solution.problem.constraints.length ? `constraints:\n${solution.problem.constraints.map((item) => `- ${item}`).join("\n")}` : "",
    solution.solution.approachSteps.length ? `previous_approach:\n${solution.solution.approachSteps.map((item) => `- ${item}`).join("\n")}` : "",
    "previous_solution_code:",
    solution.solution.code,
    solution.solution.complexity.time || solution.solution.complexity.space
      ? `previous_complexity: time ${solution.solution.complexity.time || "N/A"}, space ${solution.solution.complexity.space || "N/A"}`
      : "",
    solution.solution.edgeCases.length ? `previous_edge_cases:\n${solution.solution.edgeCases.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
};
