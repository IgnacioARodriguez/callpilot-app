export type AdaptiveFollowUpPolicy =
  | "clarify_scope"
  | "deepen_mechanism"
  | "challenge_tradeoff"
  | "repair_claim"
  | "close_topic";

export interface AdaptiveFollowUpDecision {
  policy: AdaptiveFollowUpPolicy;
  reason: string;
}

/**
 * Chooses the next interviewer move from the completed answer, without naming
 * a technology or assuming a fixed question sequence. The E2E driver can use
 * this decision to select its next corpus branch after generation.completed.
 */
export const selectAdaptiveFollowUp = (answer: string): AdaptiveFollowUpDecision => {
  const text = answer.trim();
  if (!text) return { policy: "clarify_scope", reason: "empty_answer" };
  if (/\b(i\s+correct|correction|actually|not\s+quite|no,|me\s+corrijo|corrijo)\b/i.test(text)) {
    return { policy: "repair_claim", reason: "answer_contains_self_correction" };
  }
  if (/\b(i\s+haven't|have not|not\s+sure|limited experience|partial|no\s+direct|no\s+he\s+usado|no\s+experiencia)\b/i.test(text)) {
    return { policy: "clarify_scope", reason: "answer_signals_limited_experience" };
  }
  if (/\b(trade[- ]?off|latency|failure|scale|reliab|monitor|alert|retry|rollback|incident|compaction|cache|queue|database)\b/i.test(text)) {
    return { policy: "challenge_tradeoff", reason: "answer_contains_operational_claim" };
  }
  if (/\b(because|so that|for example|first|then|we would|I would|uso|porque|por ejemplo|primero|despues)\b/i.test(text)) {
    return { policy: "deepen_mechanism", reason: "answer_contains_explanation" };
  }
  return { policy: "close_topic", reason: "answer_does_not_expose_a_clear_branch" };
};
