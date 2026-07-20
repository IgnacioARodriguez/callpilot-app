import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  EVALUATION_VERSION,
  createEvaluationRecord,
  stableStringify,
  validateEvaluationRecord,
} = require("../../tests/eval/evaluationContract.cjs");

test("evaluation contract creates a complete versioned record", () => {
  const record = createEvaluationRecord({
    run_id: "run-1",
    scenario_id: "scenario-a",
    provider: "mock",
    model: "mock-local",
    raw_model_output: "{\"kind\":\"interview\"}",
    parsed_output: { kind: "interview" },
    final_rendered_output: "**Respuesta:** ok",
    raw_model_scores: { providerOk: true, noRawJsonScaffold: true },
    deterministic_scores: { nonEmpty: true, forbiddenTermsAbsent: true },
    latency: { complete_ms: 12 },
  });

  assert.equal(record.evaluation_version, EVALUATION_VERSION);
  assert.equal(record.raw_model_pass, true);
  assert.equal(record.parsed_pass, true);
  assert.equal(record.recovered_pass, true);
  assert.deepEqual(validateEvaluationRecord(record), { ok: true, errors: [] });
});

test("evaluation contract serialization is stable", () => {
  const left = createEvaluationRecord({
    run_id: "run-1",
    scenario_id: "scenario-a",
    model_parameters: { temperature: 0, max_tokens: 100 },
    deterministic_scores: { b: true, a: false },
  });
  const right = createEvaluationRecord({
    scenario_id: "scenario-a",
    run_id: "run-1",
    deterministic_scores: { a: false, b: true },
    model_parameters: { max_tokens: 100, temperature: 0 },
  });

  assert.equal(stableStringify(left), stableStringify(right));
});

test("evaluation contract keeps raw separate from recovered repairs", () => {
  const record = createEvaluationRecord({
    run_id: "run-1",
    scenario_id: "scenario-a",
    raw_model_output: "bad raw",
    recovered_output: "bad raw",
    repair_events: [{ type: "json_repair", stage: "parse", result: "changed" }],
  });

  const validation = validateEvaluationRecord(record);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(","), /raw_overwritten_by_recovered/);
});
