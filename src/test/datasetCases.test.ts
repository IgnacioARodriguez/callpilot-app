import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  manifestToDatasetCases,
  readDatasetJsonl,
  validateDatasetCase,
  writeManifestDatasetJsonl,
} = require("../../tests/eval/datasetCases.cjs");
const { sha256File } = require("../../tests/eval/datasetPolicy.cjs");

const root = path.resolve(process.cwd());

const externalManifest = () => {
  const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-validation-cases-"));
  const sourceRoot = path.join(datasetRoot, "interview-001");
  fs.mkdirSync(sourceRoot, { recursive: true });
  const videoPath = path.join(sourceRoot, "interview.mp4");
  const manifestPath = path.join(sourceRoot, "analysis-001", "manifest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(videoPath, "synthetic external media", "utf8");
  const hash = sha256File(videoPath);
  const manifest = {
    schema_version: 1,
    evaluation_dataset: {
      schema_version: 1,
      dataset: "backend-validation-v1",
      split: "validation",
      source_id: "interview-001",
      source_type: "mp4",
      external_dataset_dir: datasetRoot,
      source_path: videoPath,
      content_hash: hash,
    },
    video: { path: videoPath, sha256: hash },
    artifacts: { review_html_path: path.join(path.dirname(manifestPath), "review.html") },
    checkpoints: [
      {
        id: "cp-001",
        timestamp_ms: 120000,
        source_frame_path: path.join(path.dirname(manifestPath), "frames", "frame-001.png"),
        visual_context_expected: ["hash map"],
        evaluation: {
          expected_topics: ["hash map"],
          forbidden_claims: ["future content"],
          execution: { language: "python", public_tests: ["assert True"] },
        },
      },
    ],
  };
  return { datasetRoot, manifest, manifestPath };
};

test("video manifests export one versioned dataset case per checkpoint", () => {
  const { datasetRoot, manifest, manifestPath } = externalManifest();
  const cases = manifestToDatasetCases({
    root,
    manifest,
    manifestPath,
    requested: { split: "validation", datasetDir: datasetRoot },
    env: {},
  });

  assert.equal(cases.length, 1);
  assert.equal(cases[0].case_version, "callpilot-eval-case-v1");
  assert.equal(cases[0].case_id, "interview-001:cp-001");
  assert.equal(cases[0].split, "validation");
  assert.equal(cases[0].fixture_class, "external_evaluation_source");
  assert.equal(cases[0].input.available_until_ms, 120000);
  assert.deepEqual(cases[0].expectations.execution.public_tests, ["assert True"]);
  assert.equal(validateDatasetCase(cases[0]).ok, true);
});

test("dataset JSONL writer round trips manifest cases", () => {
  const { datasetRoot, manifest, manifestPath } = externalManifest();
  const { filePath, cases } = writeManifestDatasetJsonl({
    root,
    manifest,
    manifestPath,
    requested: { split: "validation", datasetDir: datasetRoot },
    env: {},
  });

  assert.equal(path.basename(filePath), "dataset.jsonl");
  assert.deepEqual(readDatasetJsonl(filePath), cases);
});

test("dataset case validation rejects future evidence and missing hashes", () => {
  const invalid = {
    case_version: "callpilot-eval-case-v1",
    case_id: "bad:cp",
    dataset: "bad",
    split: "validation",
    source_id: "bad",
    source_type: "mp4",
    content_hash: "",
    input: { timestamp_ms: 1000, available_until_ms: 1001 },
    expectations: {},
  };

  const result = validateDatasetCase(invalid);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(","), /missing:content_hash/);
  assert.match(result.errors.join(","), /invalid:future_evidence/);
});
