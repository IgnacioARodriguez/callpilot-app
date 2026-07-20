import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEvaluationRecord } = require("../../tests/eval/evaluationContract.cjs");
const { codeFromRecord, scoreExecutableRecord } = require("../../tests/eval/scorers/executableScorers.cjs");

const codingRecord = (code: string, overrides = {}) => createEvaluationRecord({
  run_id: "run-exec-1",
  scenario_id: "coding-exec",
  raw_model_output: "{\"kind\":\"coding\"}",
  parsed_output: {
    kind: "coding",
    payload: {
      responseType: "initial_solution",
      solution: { code },
      patch: { kind: "none", code: null },
    },
  },
  final_rendered_output: code,
  latency: { complete_ms: 500 },
  raw_model_pass: true,
  parsed_pass: true,
  recovered_pass: true,
  ...overrides,
});

test("executable scorer passes public, hidden, and function-shape Python checks", () => {
  const result = scoreExecutableRecord(codingRecord(`
def two_sum(nums, target):
    seen = {}
    for index, value in enumerate(nums):
        want = target - value
        if want in seen:
            return [seen[want], index]
        seen[value] = index
    return []
`), {
    language: "python",
    function_name: "two_sum",
    public_tests: [
      "assert two_sum([2, 7, 11, 15], 9) == [0, 1]",
    ],
    hidden_tests: [
      { python: "assert two_sum([3, 3], 6) == [0, 1]" },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.syntax_ok, true);
  assert.equal(result.execution_ok, true);
  assert.equal(result.public_tests_ok, true);
  assert.equal(result.hidden_tests_ok, true);
  assert.equal(result.return_shape_ok, true);
});

test("executable scorer fails incorrect code without exact output matching", () => {
  const result = scoreExecutableRecord(codingRecord(`
def two_sum(nums, target):
    return [0, 1]
`), {
    language: "python",
    public_tests: [
      "assert two_sum([1, 4, 6], 10) == [1, 2]",
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.public_tests_ok, false);
  assert.equal(result.public_tests.failures.length, 1);
});

test("executable scorer separates syntax and execution failures", () => {
  const syntax = scoreExecutableRecord(codingRecord("def broken(:\n    pass"), {
    language: "python",
    public_tests: ["assert True"],
  });
  assert.equal(syntax.ok, false);
  assert.equal(syntax.syntax_ok, false);
  assert.equal(syntax.execution_ok, false);

  const execution = scoreExecutableRecord(codingRecord("raise RuntimeError('boom')"), {
    language: "python",
    public_tests: ["assert True"],
  });
  assert.equal(execution.ok, false);
  assert.equal(execution.syntax_ok, true);
  assert.equal(execution.execution_ok, false);
});

test("executable scorer enforces previous-turn regression tests", () => {
  const result = scoreExecutableRecord(codingRecord(`
def normalize_name(value):
    return value.strip()
`), {
    language: "python",
    previous_tests: [
      "assert normalize_name(' Ada ') == 'Ada'",
    ],
    public_tests: [
      "assert normalize_name('ADA') == 'ada'",
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.previous_turn_regression_ok, true);
  assert.equal(result.public_tests_ok, false);
});

test("executable scorer times out non-terminating candidate code", () => {
  const result = scoreExecutableRecord(codingRecord(`
while True:
    pass
`), {
    language: "python",
    timeout_ms: 100,
    public_tests: ["assert True"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.timeout, true);
});

test("executable scorer skips unsupported languages and extracts fenced code fallback", () => {
  const unsupported = scoreExecutableRecord(codingRecord("function f() { return 1 }"), {
    language: "javascript",
    public_tests: ["assert True"],
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.skipped, true);

  const record = createEvaluationRecord({
    run_id: "run-exec-2",
    scenario_id: "coding-fence",
    raw_model_output: "```python\ndef solve():\n    return 1\n```",
    parsed_output: null,
    final_rendered_output: "```python\ndef solve():\n    return 1\n```",
    latency: { complete_ms: 500 },
    raw_model_pass: true,
    parsed_pass: false,
    recovered_pass: false,
  });
  assert.equal(codeFromRecord(record), "def solve():\n    return 1");
});
