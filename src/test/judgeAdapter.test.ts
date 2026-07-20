import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEvaluationRecord } = require("../../tests/eval/evaluationContract.cjs");
const {
  buildJudgeRequest,
  normalizeJudgeContract,
  scoreJudgeRecord,
} = require("../../tests/eval/scorers/judgeAdapter.cjs");

const record = createEvaluationRecord({
  run_id: "judge-run-1",
  scenario_id: "case-1",
  available_transcript: "interviewer: explain the current code",
  available_screen_context: "def solve(): pass",
  raw_model_output: "Use the visible function.",
  final_rendered_output: "Use the visible function.",
  raw_model_pass: true,
  parsed_pass: false,
  recovered_pass: true,
});

test("judge adapter normalizes rubric contracts without invoking a model", () => {
  const contract = normalizeJudgeContract({
    rubric: ["answered_current_question", "did_not_invent_constraints"],
    min_score: 0.9,
  });

  assert.equal(contract.min_score, 0.9);
  assert.deepEqual(contract.rubric, ["answered_current_question", "did_not_invent_constraints"]);
});

test("judge adapter builds a redacted request shape from an evaluation record", () => {
  const request = buildJudgeRequest(record, {
    provider: "external-judge",
    model: "strong-model",
    rubric: ["sayable_explanation"],
  });

  assert.equal(request.version, "callpilot-judge-request-v1");
  assert.equal(request.input.scenario_id, "case-1");
  assert.equal(request.output.final_rendered_output, "Use the visible function.");
  assert.deepEqual(request.rubric, ["sayable_explanation"]);
});

test("judge adapter reports required judges as blocked when no provider is configured", () => {
  const result = scoreJudgeRecord(record, {
    required: true,
    rubric: ["answered_current_question"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "judge_provider_not_configured");
});

test("judge adapter skips optional judges without claiming a semantic pass", () => {
  const result = scoreJudgeRecord(record, null);

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.blocked, false);
  assert.equal(result.reason, "no_judge_contract");
});
