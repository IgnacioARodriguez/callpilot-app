import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const writeReport = (dir: string, report: unknown) => {
  const filePath = path.join(dir, "continuous-eval-test.json");
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return filePath;
};

test("eval release gate fails blocked required judges", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-release-gate-"));
  writeReport(dir, {
    generatedAt: "2026-07-20T00:00:00.000Z",
    track: "validation",
    totals: { scenarios: 1, failed: 0, passed: 1 },
    evaluationRecords: [
      {
        scenario_id: "case-1",
        repair_events: [],
        execution_scores: { ok: true, skipped: true },
        judge_scores: { ok: false, skipped: true, blocked: true, reason: "judge_provider_not_configured" },
        latency: { complete_ms: 1000 },
      },
    ],
  });

  const result = spawnSync(process.execPath, [
    "scripts/check-eval-release-gate.mjs",
    `--reports-dir=${dir}`,
    "--track=validation",
    "--latest-only",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /judge_blocked=case-1/);
});

test("eval release gate passes clean reports", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-release-gate-"));
  writeReport(dir, {
    generatedAt: "2026-07-20T00:00:00.000Z",
    track: "development",
    totals: { scenarios: 1, failed: 0, passed: 1 },
    evaluationRecords: [
      {
        scenario_id: "case-1",
        repair_events: [],
        execution_scores: { ok: true, skipped: false },
        judge_scores: { ok: true, skipped: true, blocked: false },
        latency: { complete_ms: 1000 },
      },
    ],
  });

  const result = spawnSync(process.execPath, [
    "scripts/check-eval-release-gate.mjs",
    `--reports-dir=${dir}`,
    "--track=development",
    "--latest-only",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"status": "ok"/);
});
