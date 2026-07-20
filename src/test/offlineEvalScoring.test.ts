import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEvaluationRecord } = require("../../tests/eval/evaluationContract.cjs");
const { scoreEvaluationRecordForCase } = require("../../tests/eval/scorers/evaluationScoring.cjs");

const datasetCase = {
  case_version: "callpilot-eval-case-v1",
  case_id: "case-001",
  dataset: "development-fixtures",
  split: "development",
  source_id: "source-001",
  source_type: "synthetic",
  content_hash: "abc123abc123abc123",
  input: { checkpoint_id: "cp-001", timestamp_ms: 1000, available_until_ms: 1000 },
  expectations: {
    deterministic: { function_name: "two_sum", max_words: 80 },
    execution: { language: "python", function_name: "two_sum", public_tests: ["assert two_sum([2, 7], 9) == [0, 1]"] },
    judge: null,
  },
};

const record = createEvaluationRecord({
  run_id: "offline-1",
  dataset: "development-fixtures",
  split: "development",
  scenario_id: "case-001",
  source_id: "source-001",
  source_type: "synthetic",
  raw_model_output: "def two_sum(nums, target):\n    return [0, 1]",
  parsed_output: {
    kind: "coding",
    payload: {
      responseType: "initial_solution",
      solution: { code: "def two_sum(nums, target):\n    return [0, 1]" },
      patch: { kind: "none", code: null },
    },
  },
  final_rendered_output: "def two_sum(nums, target):\n    return [0, 1]",
  raw_model_pass: true,
  parsed_pass: true,
  recovered_pass: true,
});

test("evaluation scoring propagates required judge contracts", () => {
  const result = scoreEvaluationRecordForCase(record, {
    ...datasetCase,
    expectations: {
      ...datasetCase.expectations,
      judge: { required: true, rubric: ["answered_current_question"] },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.judge_scores.blocked, true);
});

test("offline scorer CLI scores records against dataset cases", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-offline-score-"));
  const casesPath = path.join(tmp, "dataset.jsonl");
  const recordsPath = path.join(tmp, "records.jsonl");
  const outPath = path.join(tmp, "scored.json");
  fs.writeFileSync(casesPath, `${JSON.stringify(datasetCase)}\n`, "utf8");
  fs.writeFileSync(recordsPath, `${JSON.stringify(record)}\n`, "utf8");

  const result = spawnSync(process.execPath, [
    "scripts/score-eval-records.mjs",
    `--cases=${casesPath}`,
    `--records=${recordsPath}`,
    `--out=${outPath}`,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const scored = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(scored.failed_count, 0);
  assert.equal(scored.results[0].ok, true);
  assert.equal(scored.evaluation_records[0].execution_scores.ok, true);
});

test("offline scorer CLI fails records without matching cases", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-offline-score-"));
  const casesPath = path.join(tmp, "dataset.jsonl");
  const recordsPath = path.join(tmp, "records.jsonl");
  fs.writeFileSync(casesPath, `${JSON.stringify(datasetCase)}\n`, "utf8");
  fs.writeFileSync(recordsPath, `${JSON.stringify({ ...record, scenario_id: "missing-case" })}\n`, "utf8");

  const result = spawnSync(process.execPath, [
    "scripts/score-eval-records.mjs",
    `--cases=${casesPath}`,
    `--records=${recordsPath}`,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"missing_case_count": 1/);
});
