import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readDatasetJsonl } = require("../tests/eval/datasetCases.cjs");
const { summarizeEvaluationRecords } = require("../tests/eval/evaluationContract.cjs");
const { scoreEvaluationRecordForCase } = require("../tests/eval/scorers/evaluationScoring.cjs");

const argValue = (name, fallback = "") => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
};

const readJsonOrJsonl = (filePath) => {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  if (text.startsWith("{")) {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value;
    if (Array.isArray(value.evaluationRecords)) return value.evaluationRecords;
    if (Array.isArray(value.evaluation_records)) return value.evaluation_records;
    return [value];
  }
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid records JSONL at ${filePath}:${index + 1}: ${error instanceof Error ? error.message : error}`);
    }
  });
};

const casePath = argValue("--cases");
const recordsPath = argValue("--records");
const outPath = argValue("--out");
if (!casePath) throw new Error("Pass --cases=path/to/dataset.jsonl");
if (!recordsPath) throw new Error("Pass --records=path/to/evaluation-records.jsonl-or-report.json");

const cases = readDatasetJsonl(path.resolve(casePath));
const records = readJsonOrJsonl(path.resolve(recordsPath));
const casesById = new Map(cases.map((item) => [item.case_id, item]));
const casesByCheckpoint = new Map(cases.map((item) => [String(item?.input?.checkpoint_id || ""), item]));

const scoredRecords = records.map((record) => {
  const datasetCase = casesById.get(record.scenario_id)
    || casesById.get(record.case_id)
    || casesByCheckpoint.get(record.scenario_id);
  if (!datasetCase) {
    return {
      record,
      scoring: {
        ok: false,
        missing_case: true,
        deterministic_scores: {},
        execution_scores: null,
        judge_scores: null,
      },
    };
  }
  const scoring = scoreEvaluationRecordForCase(record, datasetCase);
  return {
    record: {
      ...record,
      deterministic_scores: scoring.deterministic_scores,
      execution_scores: scoring.execution_scores,
      judge_scores: scoring.judge_scores,
      recovered_pass: scoring.ok,
      failure_class: scoring.ok ? null : record.failure_class || "offline_eval_scoring_failure",
      severity: scoring.ok ? null : record.severity || "P1",
    },
    scoring,
  };
});

const output = {
  generatedAt: new Date().toISOString(),
  case_file: path.resolve(casePath),
  records_file: path.resolve(recordsPath),
  total_cases: cases.length,
  total_records: records.length,
  missing_case_count: scoredRecords.filter((item) => item.scoring.missing_case).length,
  failed_count: scoredRecords.filter((item) => !item.scoring.ok).length,
  evaluation_summary: summarizeEvaluationRecords(scoredRecords.map((item) => item.record)),
  results: scoredRecords.map((item) => ({
    scenario_id: item.record.scenario_id,
    ok: item.scoring.ok,
    missing_case: Boolean(item.scoring.missing_case),
    deterministic_failed: item.scoring.deterministic_failed || [],
    execution_ok: item.scoring.execution_scores?.ok ?? null,
    execution_skipped: item.scoring.execution_scores?.skipped ?? null,
    judge_ok: item.scoring.judge_scores?.ok ?? null,
    judge_blocked: item.scoring.judge_scores?.blocked ?? false,
    failure_class: item.record.failure_class,
  })),
  evaluation_records: scoredRecords.map((item) => item.record),
};

const json = `${JSON.stringify(output, null, 2)}\n`;
if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), json, "utf8");
} else {
  process.stdout.write(json);
}
if (output.failed_count > 0 || output.missing_case_count > 0) process.exit(1);
