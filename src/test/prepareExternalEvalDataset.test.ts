import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const runPrepare = (args: string[]) => spawnSync(process.execPath, [
  "scripts/prepare-external-eval-dataset.mjs",
  ...args,
], {
  cwd: process.cwd(),
  encoding: "utf8",
});

test("prepare external validation dataset creates the expected external structure", () => {
  const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-prepare-validation-"));
  const result = runPrepare([
    "--split=validation",
    `--dir=${datasetRoot}`,
    "--dataset=backend-validation-v1",
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "ok");
  assert.equal(output.split, "validation");
  assert.equal(output.dataset, "backend-validation-v1");
  assert.equal(output.dataset_dir, datasetRoot);
  assert.ok(fs.existsSync(path.join(datasetRoot, "_incoming")));
  assert.ok(fs.existsSync(path.join(datasetRoot, "reports")));
  assert.ok(fs.existsSync(path.join(datasetRoot, "README.md")));
  assert.ok(fs.existsSync(path.join(datasetRoot, "WORKFLOW.md")));

  const policy = JSON.parse(fs.readFileSync(path.join(datasetRoot, "dataset-policy.json"), "utf8"));
  assert.equal(policy.split, "validation");
  assert.equal(policy.policy.external_to_repository, true);
  assert.equal(policy.policy.raw_media_not_committed_to_git, true);
});

test("prepare external dataset rejects repository paths", () => {
  const result = runPrepare([
    "--split=validation",
    `--dir=${path.join(process.cwd(), ".cache", "invalid-validation")}`,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the repository/);
});

test("prepare external dataset rejects development split", () => {
  const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-prepare-development-"));
  const result = runPrepare([
    "--split=development",
    `--dir=${datasetRoot}`,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /only for external validation or holdout/);
});
