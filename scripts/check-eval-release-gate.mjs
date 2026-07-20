import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const argValue = (name, fallback = "") => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
};

const percentile = (values, p) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
};

const reportsDir = path.resolve(argValue("--reports-dir", path.join(root, "tests", "e2e", "reports")));
const trackFilter = argValue("--track");
const latestOnly = process.argv.includes("--latest-only");
const allowEmpty = process.argv.includes("--allow-empty");
const maxP95CompleteMs = Number(argValue("--max-p95-complete-ms", "12000"));
const maxSemanticRepairs = Number(argValue("--max-semantic-repairs", "0"));

if (!fs.existsSync(reportsDir)) {
  if (allowEmpty) {
    console.log(JSON.stringify({ status: "skipped", reason: "missing_reports_dir", reportsDir }, null, 2));
    process.exit(0);
  }
  throw new Error(`Reports directory does not exist: ${reportsDir}`);
}

let files = fs.readdirSync(reportsDir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const fullPath = path.join(reportsDir, file);
    try {
      const report = JSON.parse(fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, ""));
      return {
        file,
        fullPath,
        report,
        sortMs: Date.parse(report.generatedAt || "") || fs.statSync(fullPath).mtimeMs,
      };
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => b.sortMs - a.sortMs);

if (trackFilter) {
  files = files.filter(({ report }) => report.track === trackFilter);
}
if (latestOnly) files = files.slice(0, 1);

if (files.length === 0) {
  if (allowEmpty) {
    console.log(JSON.stringify({ status: "skipped", reason: "no_reports", reportsDir, track: trackFilter || null }, null, 2));
    process.exit(0);
  }
  throw new Error(`No eval reports found in ${reportsDir}${trackFilter ? ` for track ${trackFilter}` : ""}.`);
}

const reports = files.map(({ file, report }) => {
  const results = Array.isArray(report.results) ? report.results : [];
  const records = Array.isArray(report.evaluationRecords)
    ? report.evaluationRecords
    : Array.isArray(report.evaluation_records)
      ? report.evaluation_records
      : [];
  const failed = Number(report.totals?.failed ?? results.filter((result) =>
    Object.values(result.deterministicChecks || {}).some((value) => value === false)).length);
  const completeLatencies = [
    ...results.map((result) => Number(result.latency_ms?.total)).filter((value) => value > 0),
    ...records.map((record) => Number(record.latency?.complete_ms)).filter((value) => value > 0),
  ];
  const semanticRepairs = records.reduce((sum, record) =>
    sum + (Array.isArray(record.repair_events) ? record.repair_events.filter((event) => event?.semantic).length : 0), 0);
  const executionFailures = records.filter((record) => {
    const scores = record.execution_scores;
    return scores && typeof scores === "object" && scores.skipped !== true && scores.ok === false;
  }).map((record) => record.scenario_id);
  const blockedJudges = records.filter((record) => record.judge_scores?.blocked === true)
    .map((record) => record.scenario_id);
  return {
    file,
    track: report.track || null,
    scenarios: Number(report.totals?.scenarios ?? results.length ?? records.length),
    failed,
    semanticRepairs,
    executionFailures,
    blockedJudges,
    p95CompleteMs: percentile(completeLatencies, 95),
  };
});

const failures = [];
for (const report of reports) {
  if (report.failed > 0) failures.push(`${report.file}: failed=${report.failed}`);
  if (report.semanticRepairs > maxSemanticRepairs) failures.push(`${report.file}: semantic_repairs=${report.semanticRepairs}`);
  if (report.executionFailures.length > 0) failures.push(`${report.file}: execution_failed=${report.executionFailures.join(",")}`);
  if (report.blockedJudges.length > 0) failures.push(`${report.file}: judge_blocked=${report.blockedJudges.join(",")}`);
  if (report.p95CompleteMs !== null && report.p95CompleteMs > maxP95CompleteMs) {
    failures.push(`${report.file}: p95_complete_ms=${report.p95CompleteMs} > ${maxP95CompleteMs}`);
  }
}

const summary = {
  status: failures.length === 0 ? "ok" : "failed",
  reportsDir,
  inspectedReports: reports.length,
  track: trackFilter || null,
  latestOnly,
  maxP95CompleteMs,
  maxSemanticRepairs,
  reports,
  failures,
};

console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) process.exit(1);
