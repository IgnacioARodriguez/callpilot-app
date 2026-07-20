import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEvaluationRecord } = require("../../tests/eval/evaluationContract.cjs");
const {
  expectationsFromDatasetCase,
  scoreEvaluationRecordForCase,
} = require("../../tests/eval/scorers/evaluationScoring.cjs");

const record = (code: string, output = code) => createEvaluationRecord({
  run_id: "run-score-1",
  dataset: "backend-validation-v1",
  split: "validation",
  scenario_id: "interview-001:cp-001",
  source_id: "interview-001",
  source_type: "mp4",
  raw_model_output: output,
  parsed_output: {
    kind: "coding",
    payload: {
      responseType: "initial_solution",
      solution: { code },
      patch: { kind: "none", code: null },
    },
  },
  final_rendered_output: output,
  latency: { complete_ms: 900 },
  raw_model_pass: true,
  parsed_pass: true,
  recovered_pass: true,
});

const datasetCase = {
  case_version: "callpilot-eval-case-v1",
  case_id: "interview-001:cp-001",
  dataset: "backend-validation-v1",
  split: "validation",
  source_id: "interview-001",
  source_type: "mp4",
  content_hash: "abc123abc123abc123",
  input: {
    timestamp_ms: 1000,
    available_until_ms: 1000,
  },
  expectations: {
    deterministic: {
      language: "english",
      max_words: 80,
      function_name: "two_sum",
      expected_response_type: "initial_solution",
      forbidden_claims: ["future transcript"],
      max_complete_ms: 1500,
    },
    execution: {
      language: "python",
      function_name: "two_sum",
      public_tests: ["assert two_sum([2, 7], 9) == [0, 1]"],
      hidden_tests: ["assert two_sum([3, 3], 6) == [0, 1]"],
    },
  },
};

test("evaluation scoring maps dataset-case expectations into shared scorers", () => {
  const expectations = expectationsFromDatasetCase(datasetCase);

  assert.equal(expectations.deterministic.function_name, "two_sum");
  assert.deepEqual(expectations.deterministic.forbidden_facts, ["future transcript"]);
  assert.equal(expectations.execution.function_name, "two_sum");
});

test("evaluation scoring passes deterministic and executable checks for a valid record", () => {
  const result = scoreEvaluationRecordForCase(record(`
def two_sum(nums, target):
    seen = {}
    for index, value in enumerate(nums):
        complement = target - value
        if complement in seen:
            return [seen[complement], index]
        seen[value] = index
    return []
`, "The answer is concise.\n```python\ndef two_sum(nums, target):\n    return [0, 1]\n```"), datasetCase);

  assert.equal(result.ok, true);
  assert.deepEqual(result.deterministic_failed, []);
  assert.equal(result.execution_scores.ok, true);
});

test("evaluation scoring reports deterministic and executable failures separately", () => {
  const result = scoreEvaluationRecordForCase(record(`
def wrong(nums, target):
    return [0, 1]
`, "future transcript " + "word ".repeat(90)), datasetCase);

  assert.equal(result.ok, false);
  assert.equal(result.deterministic_scores.forbidden_facts, false);
  assert.equal(result.deterministic_scores.length, false);
  assert.equal(result.deterministic_scores.function_name, false);
  assert.equal(result.execution_scores.ok, false);
});
