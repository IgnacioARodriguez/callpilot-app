const DEFAULT_RUBRIC = [
  "answered_current_question",
  "used_available_screen_context",
  "ignored_stale_context",
  "did_not_invent_constraints",
  "sayable_explanation",
  "complexity_supported",
];

const normalizeJudgeContract = (contract = {}) => {
  if (!contract || typeof contract !== "object") return null;
  const rubric = Array.isArray(contract.rubric) && contract.rubric.length > 0
    ? contract.rubric.map((item) => String(item).trim()).filter(Boolean)
    : DEFAULT_RUBRIC;
  return {
    required: contract.required === true,
    provider: String(contract.provider || process.env.CALLPILOT_EVAL_JUDGE_PROVIDER || "").trim(),
    model: String(contract.model || process.env.CALLPILOT_EVAL_JUDGE_MODEL || "").trim(),
    rubric,
    min_score: Number.isFinite(Number(contract.min_score)) ? Number(contract.min_score) : 0.8,
  };
};

const buildJudgeRequest = (record, contract = {}) => {
  const normalized = normalizeJudgeContract(contract);
  if (!normalized) return null;
  return {
    version: "callpilot-judge-request-v1",
    provider: normalized.provider || null,
    model: normalized.model || null,
    rubric: normalized.rubric,
    min_score: normalized.min_score,
    input: {
      scenario_id: record?.scenario_id || "",
      split: record?.split || "",
      input_snapshot: record?.input_snapshot || {},
      available_transcript: record?.available_transcript || "",
      available_screen_context: record?.available_screen_context || "",
    },
    output: {
      raw_model_output: record?.raw_model_output || "",
      final_rendered_output: record?.final_rendered_output || "",
      parsed_output: record?.parsed_output ?? null,
    },
  };
};

const scoreJudgeRecord = (record, contract = {}) => {
  const normalized = normalizeJudgeContract(contract);
  if (!normalized) {
    return { ok: true, skipped: true, blocked: false, reason: "no_judge_contract" };
  }
  const request = buildJudgeRequest(record, normalized);
  if (!normalized.provider || !normalized.model) {
    return {
      ok: !normalized.required,
      skipped: true,
      blocked: normalized.required,
      reason: "judge_provider_not_configured",
      request,
    };
  }
  return {
    ok: false,
    skipped: true,
    blocked: true,
    reason: "judge_execution_not_implemented",
    request,
  };
};

module.exports = {
  DEFAULT_RUBRIC,
  buildJudgeRequest,
  normalizeJudgeContract,
  scoreJudgeRecord,
};
