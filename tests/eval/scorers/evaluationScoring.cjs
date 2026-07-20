const { scoreDeterministicRecord } = require("./deterministicScorers.cjs");
const { scoreExecutableRecord } = require("./executableScorers.cjs");
const { scoreJudgeRecord } = require("./judgeAdapter.cjs");

const expectationsFromDatasetCase = (datasetCase = {}) => {
  const deterministic = datasetCase?.expectations?.deterministic || {};
  const execution = datasetCase?.expectations?.execution || null;
  const input = datasetCase?.input || {};
  return {
    deterministic: {
      forbidden_facts: [
        ...(Array.isArray(deterministic.forbidden_claims) ? deterministic.forbidden_claims : []),
        ...(Array.isArray(deterministic.critical_failures) ? deterministic.critical_failures : []),
      ],
      future_forbidden_facts: Array.isArray(deterministic.future_forbidden_facts)
        ? deterministic.future_forbidden_facts
        : [],
      max_words: deterministic.max_words,
      language: deterministic.language,
      expected_response_type: deterministic.expected_response_type,
      function_name: deterministic.function_name,
      patch_required: deterministic.patch_required,
      max_retries: deterministic.max_retries,
      max_complete_ms: deterministic.max_complete_ms,
      allow_parser_repairs: deterministic.allow_parser_repairs,
      allow_semantic_repairs: deterministic.allow_semantic_repairs,
      input_timestamp_ms: input.timestamp_ms,
      available_until_ms: input.available_until_ms,
    },
    execution,
    judge: datasetCase?.expectations?.judge || null,
  };
};

const scoreEvaluationRecordForCase = (record, datasetCase = {}) => {
  const expectations = expectationsFromDatasetCase(datasetCase);
  const deterministicResult = scoreDeterministicRecord(record, expectations.deterministic);
  const executionResult = expectations.execution
    ? scoreExecutableRecord(record, expectations.execution)
    : { ok: true, skipped: true, error: "no_execution_contract" };
  const judgeResult = scoreJudgeRecord(record, expectations.judge);
  return {
    ok: deterministicResult.ok
      && (executionResult.skipped || executionResult.ok)
      && (judgeResult.skipped ? !judgeResult.blocked : judgeResult.ok),
    deterministic_scores: deterministicResult.checks,
    deterministic_failed: deterministicResult.failed,
    execution_scores: executionResult,
    judge_scores: judgeResult,
  };
};

module.exports = {
  expectationsFromDatasetCase,
  scoreEvaluationRecordForCase,
};
