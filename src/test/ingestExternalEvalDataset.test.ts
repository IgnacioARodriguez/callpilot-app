import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const runIngest = (args: string[]) => spawnSync(process.execPath, [
  "scripts/ingest-external-eval-dataset.mjs",
  ...args,
], {
  cwd: process.cwd(),
  encoding: "utf8",
});

const makeExternalDataset = () => {
  const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-ingest-validation-"));
  const incoming = path.join(datasetRoot, "_incoming");
  fs.mkdirSync(path.join(incoming, "interview-001"), { recursive: true });
  const videoPath = path.join(incoming, "interview-001", "interview.mp4");
  fs.writeFileSync(videoPath, "not a real mp4; dry-run only", "utf8");
  return { datasetRoot, incoming, videoPath };
};

test("ingest external dataset dry-runs MP4s under incoming source directories", () => {
  const { datasetRoot, videoPath } = makeExternalDataset();
  const result = runIngest([
    "--split=validation",
    `--dir=${datasetRoot}`,
    "--dataset=backend-validation-v1",
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "dry_run");
  assert.equal(output.discovered_mp4s, 1);
  assert.equal(output.planned_ingestions.length, 1);
  assert.equal(output.planned_ingestions[0].source_id, "interview-001");
  assert.equal(output.planned_ingestions[0].video_path, videoPath);
  assert.match(output.next_command, /--run/);
});

test("ingest external dataset includes sibling video config when present", () => {
  const { datasetRoot, incoming } = makeExternalDataset();
  const configPath = path.join(incoming, "interview-001", "video-config.json");
  fs.writeFileSync(configPath, "{}\n", "utf8");

  const result = runIngest([
    "--split=validation",
    `--dir=${datasetRoot}`,
    "--dataset=backend-validation-v1",
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.planned_ingestions[0].config_path, configPath);
  assert.ok(output.planned_ingestions[0].command.some((arg: string) => arg === `--config=${configPath}`));
});

test("ingest external dataset rejects repository paths", () => {
  const result = runIngest([
    "--split=validation",
    `--dir=${path.join(process.cwd(), ".cache", "invalid-validation")}`,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the repository/);
});

test("ingest external dataset rejects duplicate source ids", () => {
  const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-ingest-duplicates-"));
  const incoming = path.join(datasetRoot, "_incoming");
  fs.mkdirSync(path.join(incoming, "interview-001", "a"), { recursive: true });
  fs.mkdirSync(path.join(incoming, "interview-001", "b"), { recursive: true });
  fs.writeFileSync(path.join(incoming, "interview-001", "a", "first.mp4"), "a", "utf8");
  fs.writeFileSync(path.join(incoming, "interview-001", "b", "second.mp4"), "b", "utf8");

  const result = runIngest([
    "--split=validation",
    `--dir=${datasetRoot}`,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Duplicate source id/);
});
