const crypto = require("node:crypto");

const EVALUATION_VERSION = "callpilot-eval-result-v1";

const REQUIRED_FIELDS = [
  "evaluation_version",
  "run_id",
  "dataset",
  "split",
  "scenario_id",
  "source_id",
  "source_type",
  "provider",
  "model",
  "model_parameters",
  "input_snapshot",
  "available_transcript",
  "available_screen_context",
  "raw_model_output",
  "parsed_output",
  "recovered_output",
  "final_rendered_output",
  "raw_model_pass",
  "parsed_pass",
  "recovered_pass",
  "retry_count",
  "repair_events",
  "deterministic_scores",
  "execution_scores",
  "judge_scores",
  "latency",
  "failure_class",
  "severity",
  "artifacts",
];

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
};

const stableStringify = (value) => `${JSON.stringify(stableValue(value), null, 2)}\n`;

const sha256Json = (value) => crypto.createHash("sha256").update(stableStringify(value)).digest("hex");

const passFromScores = (scores) => {
  if (!scores || typeof scores !== "object") return null;
  const values = Object.values(scores).filter((value) => typeof value === "boolean");
  return values.length > 0 ? values.every(Boolean) : null;
};

const normalizeRepairEvents = (events = []) => events.map((event) => ({
  type: String(event?.type || "unknown_repair"),
  cause: String(event?.cause || "unknown"),
  stage: String(event?.stage || "unknown"),
  input_hash: event?.input_hash || null,
  output_hash: event?.output_hash || null,
  duration_ms: typeof event?.duration_ms === "number" ? event.duration_ms : null,
  result: String(event?.result || "unknown"),
  semantic: Boolean(event?.semantic),
}));

const createEvaluationRecord = (input = {}) => {
  const deterministicScores = input.deterministic_scores || {};
  const executionScores = input.execution_scores || {};
  const rawModelPass = typeof input.raw_model_pass === "boolean"
    ? input.raw_model_pass
    : passFromScores(input.raw_model_scores || {}) ?? null;
  const parsedPass = typeof input.parsed_pass === "boolean"
    ? input.parsed_pass
    : input.parsed_output !== null && input.parsed_output !== undefined;
  const recoveredPass = typeof input.recovered_pass === "boolean"
    ? input.recovered_pass
    : passFromScores(deterministicScores) ?? parsedPass;

  return {
    evaluation_version: EVALUATION_VERSION,
    run_id: String(input.run_id || "unknown-run"),
    dataset: String(input.dataset || "local-development-fixtures"),
    split: String(input.split || "development"),
    scenario_id: String(input.scenario_id || "unknown-scenario"),
    source_id: String(input.source_id || input.scenario_id || "unknown-source"),
    source_type: String(input.source_type || "scenario"),
    provider: String(input.provider || "unknown"),
    model: String(input.model || "unknown"),
    model_parameters: input.model_parameters || {},
    input_snapshot: input.input_snapshot || {},
    available_transcript: input.available_transcript || "",
    available_screen_context: input.available_screen_context || "",
    raw_model_output: input.raw_model_output || "",
    parsed_output: input.parsed_output ?? null,
    recovered_output: input.recovered_output ?? null,
    final_rendered_output: input.final_rendered_output || "",
    raw_model_pass: rawModelPass,
    parsed_pass: parsedPass,
    recovered_pass: recoveredPass,
    retry_count: Math.max(0, Number(input.retry_count || 0)),
    repair_events: normalizeRepairEvents(input.repair_events),
    deterministic_scores: deterministicScores,
    execution_scores: executionScores,
    judge_scores: input.judge_scores || null,
    latency: input.latency || {},
    failure_class: input.failure_class || null,
    severity: input.severity || null,
    artifacts: input.artifacts || {},
  };
};

const validateEvaluationRecord = (record) => {
  const missing = REQUIRED_FIELDS.filter((field) => !(field in (record || {})));
  const errors = missing.map((field) => `missing:${field}`);
  if (record?.evaluation_version !== EVALUATION_VERSION) errors.push("invalid:evaluation_version");
  if (!["development", "validation", "holdout"].includes(String(record?.split || ""))) errors.push("invalid:split");
  if (!Array.isArray(record?.repair_events)) errors.push("invalid:repair_events");
  if (record?.raw_model_output === record?.recovered_output && record?.repair_events?.length > 0) {
    errors.push("invalid:raw_overwritten_by_recovered");
  }
  return { ok: errors.length === 0, errors };
};

const summarizeEvaluationRecords = (records = []) => {
  const safeRecords = Array.isArray(records) ? records : [];
  const semanticRepairCount = safeRecords.reduce(
    (sum, record) => sum + (record?.repair_events || []).filter((event) => event?.semantic).length,
    0,
  );
  const parserRepairCount = safeRecords.reduce(
    (sum, record) => sum + (record?.repair_events || []).filter((event) => /json|parse|parser|structured/i.test(event?.type || event?.stage || "")).length,
    0,
  );
  const retryCount = safeRecords.reduce((sum, record) => sum + Number(record?.retry_count || 0), 0);
  const rawPassCount = safeRecords.filter((record) => record?.raw_model_pass === true).length;
  const recoveredPassCount = safeRecords.filter((record) => record?.recovered_pass === true).length;
  return {
    total: safeRecords.length,
    raw_pass_count: rawPassCount,
    recovered_pass_count: recoveredPassCount,
    raw_pass_rate: safeRecords.length ? rawPassCount / safeRecords.length : null,
    recovered_pass_rate: safeRecords.length ? recoveredPassCount / safeRecords.length : null,
    retry_count: retryCount,
    semantic_repair_count: semanticRepairCount,
    parser_repair_count: parserRepairCount,
  };
};

module.exports = {
  EVALUATION_VERSION,
  REQUIRED_FIELDS,
  createEvaluationRecord,
  sha256Json,
  stableStringify,
  summarizeEvaluationRecords,
  validateEvaluationRecord,
};
