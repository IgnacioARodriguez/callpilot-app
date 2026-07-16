import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const reportsDir = path.join(root, "tests", "e2e", "reports");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = Math.max(1, Number(limitArg?.slice("--limit=".length) || "10"));

if (!fs.existsSync(reportsDir)) {
  console.log("No e2e reports directory found.");
  process.exit(0);
}

const files = fs.readdirSync(reportsDir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const fullPath = path.join(reportsDir, file);
    return { file, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
  })
  .sort((a, b) => b.mtimeMs - a.mtimeMs)
  .slice(0, limit);

if (files.length === 0) {
  console.log("No e2e report JSON files found.");
  process.exit(0);
}

const reports = files.map(({ file, fullPath }) => {
  const report = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  const results = Array.isArray(report.results) ? report.results : [];
  const failedScenarioIds = results
    .filter((result) => Object.values(result.deterministicChecks ?? {}).some((value) => value === false))
    .map((result) => result.scenarioId);
  const latencies = results
    .map((result) => Number(result.latency_ms?.total ?? 0))
    .filter((value) => value > 0);
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    : 0;
  return {
    file,
    generatedAt: report.generatedAt,
    track: report.track,
    scenarios: report.totals?.scenarios ?? results.length,
    passed: report.totals?.passed ?? 0,
    failed: report.totals?.failed ?? failedScenarioIds.length,
    realCalls: report.costGuard?.realCalls ?? 0,
    maxRealCalls: report.costGuard?.maxRealCalls ?? 0,
    avgLatency,
    failedScenarioIds,
  };
});

const totals = reports.reduce((acc, report) => {
  acc.scenarios += report.scenarios;
  acc.passed += report.passed;
  acc.failed += report.failed;
  acc.realCalls += report.realCalls;
  return acc;
}, { scenarios: 0, passed: 0, failed: 0, realCalls: 0 });

console.log(JSON.stringify({
  reportsDir,
  inspectedReports: reports.length,
  totals,
  reports,
}, null, 2));
