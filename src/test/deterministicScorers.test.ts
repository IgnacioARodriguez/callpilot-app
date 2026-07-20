import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEvaluationRecord } = require("../../tests/eval/evaluationContract.cjs");
const { scoreDeterministicRecord } = require("../../tests/eval/scorers/deterministicScorers.cjs");

const codingRecord = (overrides = {}) => createEvaluationRecord({
  run_id: "run-1",
  scenario_id: "coding-a",
  raw_model_output: "{\"kind\":\"coding\"}",
  parsed_output: {
    kind: "coding",
    payload: {
      responseType: "initial_solution",
      solution: { code: "def two_sum(nums, target):\n    return [0, 1]" },
      patch: { kind: "none", code: null },
    },
  },
  final_rendered_output: "def two_sum(nums, target):\n    return [0, 1]",
  latency: { complete_ms: 500 },
  raw_model_pass: true,
  parsed_pass: true,
  recovered_pass: true,
  ...overrides,
});

test("deterministic scorer passes a valid coding record", () => {
  const result = scoreDeterministicRecord(codingRecord(), {
    expected_response_type: "initial_solution",
    function_name: "two_sum",
    max_complete_ms: 1000,
    max_words: 20,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.failed, []);
});

test("deterministic scorer catches forbidden and stale facts without exact answer matching", () => {
  const result = scoreDeterministicRecord(codingRecord({
    final_rendered_output: "Use Redis and mention an old GTA gaming topic.",
  }), {
    forbidden_facts: ["redis"],
    stale_topics: ["gaming topic"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.forbidden_facts, false);
  assert.equal(result.checks.no_stale_topic, false);
});

test("deterministic scorer fails future leakage by timestamp and forbidden future facts", () => {
  const result = scoreDeterministicRecord(codingRecord({
    input_snapshot: { video_timestamp_ms: 1000, available_until_ms: 1200 },
    final_rendered_output: "The later follow-up says return a tuple.",
  }), {
    future_forbidden_facts: ["later follow-up", "return a tuple"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.no_future_leakage, false);
});

test("deterministic scorer requires function names and patches when configured", () => {
  const result = scoreDeterministicRecord(codingRecord({
    parsed_output: {
      kind: "coding",
      payload: {
        responseType: "follow_up_change",
        solution: { code: "def wrong_name(nums, target):\n    return None" },
        patch: { kind: "none", code: null },
      },
    },
  }), {
    expected_response_type: "follow_up_change",
    function_name: "two_sum",
    patch_required: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.function_name, false);
  assert.equal(result.checks.patch_presence, false);
});

test("deterministic scorer blocks semantic repairs and excessive retries", () => {
  const result = scoreDeterministicRecord(codingRecord({
    retry_count: 2,
    repair_events: [{ type: "semantic_insert", stage: "final", result: "changed", semantic: true }],
  }), {
    max_retries: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.retries, false);
  assert.equal(result.checks.repairs, false);
});

test("deterministic scorer applies language, length, and latency checks", () => {
  const result = scoreDeterministicRecord(codingRecord({
    final_rendered_output: "Respuesta: I would use the cache because it is fast and then keep talking too much.",
    latency: { complete_ms: 2000 },
  }), {
    language: "spanish",
    max_words: 5,
    max_complete_ms: 1000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.language, false);
  assert.equal(result.checks.length, false);
  assert.equal(result.checks.latency, false);
});
