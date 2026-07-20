import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readDatasetJsonl } = require("../../tests/eval/datasetCases.cjs");
const {
  generateDatasetMutations,
  mutateDatasetCase,
} = require("../../tests/eval/mutations/datasetMutations.cjs");

const baseCase = {
  case_version: "callpilot-eval-case-v1",
  case_id: "dev-case-001",
  dataset: "development-fixtures",
  split: "development",
  source_id: "dev-interview-001",
  source_type: "synthetic",
  content_hash: "abc123abc123abc123",
  fixture_class: "development_fixture",
  input: {
    checkpoint_id: "cp-001",
    timestamp_ms: 1000,
    available_until_ms: 1000,
    available_screen_context: "Two Sum\nReturn indices for target.\nConstraints: n > 1",
    available_transcript: "interviewer: implement two_sum(nums, target)",
  },
  expectations: {
    deterministic: { function_name: "two_sum" },
    execution: { language: "python", public_tests: ["assert True"] },
    judge: null,
  },
};

test("dataset mutations change inputs but preserve expectations and source identity", () => {
  const mutated = mutateDatasetCase(baseCase, "screen_ocr_confusions");

  assert.equal(mutated.case_id, "dev-case-001#screen_ocr_confusions");
  assert.equal(mutated.parent_case_id, "dev-case-001");
  assert.equal(mutated.source_id, baseCase.source_id);
  assert.deepEqual(mutated.expectations, baseCase.expectations);
  assert.notEqual(mutated.input.available_screen_context, baseCase.input.available_screen_context);
  assert.equal(mutated.input.available_until_ms, 1000);
});

test("dataset mutations are development-only by default", () => {
  assert.throws(
    () => mutateDatasetCase({ ...baseCase, split: "holdout" }, "transcript_fillers"),
    /development-only/,
  );
});

test("dataset mutation generator emits every requested variant", () => {
  const mutated = generateDatasetMutations([baseCase], {
    mutations: ["browser_chrome_noise", "partial_statement_crop", "transcript_fillers"],
  });

  assert.equal(mutated.length, 3);
  assert.deepEqual(mutated.map((item: any) => item.mutation.id), [
    "browser_chrome_noise",
    "partial_statement_crop",
    "transcript_fillers",
  ]);
});

test("mutation CLI writes mutated JSONL", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-mutations-"));
  const input = path.join(tmp, "dataset.jsonl");
  const output = path.join(tmp, "mutated.jsonl");
  fs.writeFileSync(input, `${JSON.stringify(baseCase)}\n`, "utf8");

  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [
    "scripts/generate-eval-mutations.mjs",
    `--input=${input}`,
    `--out=${output}`,
    "--mutations=browser_chrome_noise",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const cases = readDatasetJsonl(output);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].mutation.id, "browser_chrome_noise");
});
