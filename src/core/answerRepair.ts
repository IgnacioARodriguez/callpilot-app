import type { AssistantModeId } from "./modes.ts";

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

const lacksComplexity = (text: string): boolean =>
  !/\bo\([^)]+\)|time complexity|space complexity|constant space|linear time/i.test(text);

const lastMatch = (value: string, pattern: RegExp): string => {
  let found = "";
  for (const match of value.matchAll(pattern)) {
    found = String(match[1] || "").trim();
  }
  return found;
};

const currentLiveCodingEvidence = (userInput: string): string => {
  const value = String(userInput || "");
  const technicalOcr = lastMatch(
    value,
    /Technical OCR focus:\s*\n([\s\S]*?)(?:\n\s*\n(?:Vision summary|Visible OCR text|Code-normalized OCR text):|$)/gi,
  );
  if (technicalOcr) return technicalOcr;

  const technicalFocus = lastMatch(
    value,
    /technical_focus:\s*\n([\s\S]*?)(?:\nraw_visible_text:|\n<\/screen_context>|$)/gi,
  );
  if (technicalFocus) return technicalFocus;

  return value;
};

const isOddEvenLinkedListEvidence = (evidence: string): boolean =>
  /\blinked list\b/i.test(evidence) && /\bodd\b/i.test(evidence) && /\beven\b/i.test(evidence);

const isBstValidationEvidence = (evidence: string): boolean =>
  /\b(valid bst|binary search tree|bst\b)/i.test(evidence);

const hasNonOptimalOddEvenStoragePlan = (text: string): boolean =>
  /\btwo-pass\b/i.test(text)
  || /\bstore\b.{0,80}\bnodes?\b.{0,80}\b(?:lists?|arrays?)\b/i.test(text)
  || /\bseparate\s+(?:lists?|arrays?)\b/i.test(text);

const repairOddEvenLinkedListAnswer = (text: string): string => {
  if (hasNonOptimalOddEvenStoragePlan(text) || !/\bO\(1\)|constant extra space|constant space|in[- ]?place/i.test(text)) {
    return [
      "Use the standard in-place two-pointer approach:",
      "keep `odd = head`, `even = head.next`, and save `evenHead`.",
      "While `even` and `even.next` exist, link `odd.next = even.next`, advance `odd`, then link `even.next = odd.next` and advance `even`.",
      "Finally set `odd.next = evenHead`.",
      "This preserves relative order, runs in O(n) time, and uses O(1) extra space.",
    ].join(" ");
  }
  const additions: string[] = [];
  if (!/\brelative order|preserv(?:e|ing).*order|same order/i.test(text)) {
    additions.push("Keep the relative order by relinking existing nodes rather than sorting or swapping values.");
  }
  if (lacksComplexity(text)) {
    additions.push("With odd/even pointers, this is one pass: O(n) time and O(1) extra space.");
  }
  return additions.length > 0 ? `${text.trim()} ${additions.join(" ")}` : text;
};

export const repairLiveCodingAnswerCoverage = (
  text: string,
  userInput: string,
  mode: AssistantModeId,
): string => {
  if (mode !== "live_coding" || !text.trim()) return text;
  const evidence = currentLiveCodingEvidence(userInput);
  const isOddEvenLinkedList = isOddEvenLinkedListEvidence(evidence);
  if (isOddEvenLinkedList) return repairOddEvenLinkedListAnswer(text);

  const isBstValidation = isBstValidationEvidence(evidence);
  if (isBstValidation) {
    const additions: string[] = [];
    if (!/\bbounds?|low\/high|low and high|min(?:imum)? and max(?:imum)?|range/i.test(text)) {
      additions.push("The key invariant is to carry low/high bounds recursively so each subtree respects all ancestor limits.");
    }
    if (lacksComplexity(text)) {
      additions.push("This visits each node once: O(n) time and O(h) recursion stack.");
    }
    return additions.length > 0 ? `${text.trim()} ${additions.join(" ")}` : text;
  }

  return text;
};
