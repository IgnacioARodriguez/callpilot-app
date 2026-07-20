const fs = require("node:fs");
const path = require("node:path");
const { assertManifestAllowedForEvaluation, validateCheckpointSet } = require("./datasetPolicy.cjs");

const DATASET_CASE_VERSION = "callpilot-eval-case-v1";

const normalizePathForJson = (value) => value ? path.resolve(value) : null;

const evaluationFromCheckpoint = (checkpoint = {}) => {
  const evaluation = checkpoint.evaluation && typeof checkpoint.evaluation === "object" ? checkpoint.evaluation : {};
  return {
    deterministic: {
      expected_topics: Array.isArray(evaluation.expected_topics) ? evaluation.expected_topics : [],
      desirable_topics: Array.isArray(evaluation.desirable_topics) ? evaluation.desirable_topics : [],
      forbidden_claims: Array.isArray(evaluation.forbidden_claims) ? evaluation.forbidden_claims : [],
      critical_failures: Array.isArray(evaluation.critical_failures) ? evaluation.critical_failures : [],
      max_words: Number.isFinite(Number(evaluation.max_words)) ? Number(evaluation.max_words) : null,
    },
    execution: evaluation.execution && typeof evaluation.execution === "object" ? evaluation.execution : null,
    judge: evaluation.judge && typeof evaluation.judge === "object" ? evaluation.judge : null,
  };
};

const manifestToDatasetCases = ({ root, manifest, manifestPath, requested = {}, env = process.env }) => {
  const metadata = assertManifestAllowedForEvaluation({ root, manifest, manifestPath, requested, env });
  validateCheckpointSet(manifest);
  const checkpoints = Array.isArray(manifest?.checkpoints) ? manifest.checkpoints : [];
  return checkpoints.map((checkpoint) => {
    const checkpointId = String(checkpoint.id || "").trim();
    const timestampMs = Number(checkpoint.timestamp_ms);
    const availableUntilMs = Number(checkpoint.available_until_ms ?? checkpoint.timestamp_ms);
    return {
      case_version: DATASET_CASE_VERSION,
      case_id: `${metadata.source_id}:${checkpointId}`,
      dataset: metadata.dataset,
      split: metadata.split,
      source_id: metadata.source_id,
      source_type: metadata.source_type,
      content_hash: metadata.content_hash || manifest?.video?.sha256 || null,
      fixture_class: metadata.fixture_class,
      input: {
        action: checkpoint.action || "pause_and_answer",
        checkpoint_id: checkpointId,
        timestamp_ms: timestampMs,
        available_until_ms: Number.isFinite(availableUntilMs) ? availableUntilMs : timestampMs,
        video_path: normalizePathForJson(metadata.source_path || manifest?.video?.path),
        manifest_path: normalizePathForJson(manifestPath),
        config_path: normalizePathForJson(metadata.config_path),
        source_frame_path: normalizePathForJson(checkpoint.source_frame_path),
        visual_context_expected: Array.isArray(checkpoint.visual_context_expected) ? checkpoint.visual_context_expected : [],
      },
      expectations: evaluationFromCheckpoint(checkpoint),
      artifacts: {
        manifest_path: normalizePathForJson(manifestPath),
        review_html_path: normalizePathForJson(manifest?.artifacts?.review_html_path),
        summary_path: normalizePathForJson(manifest?.artifacts?.summary_path),
      },
    };
  });
};

const validateDatasetCase = (item) => {
  const errors = [];
  if (item?.case_version !== DATASET_CASE_VERSION) errors.push("invalid:case_version");
  if (!String(item?.case_id || "").trim()) errors.push("missing:case_id");
  if (!["development", "validation", "holdout"].includes(String(item?.split || ""))) errors.push("invalid:split");
  if (!String(item?.dataset || "").trim()) errors.push("missing:dataset");
  if (!String(item?.source_id || "").trim()) errors.push("missing:source_id");
  if (!String(item?.content_hash || "").trim()) errors.push("missing:content_hash");
  const timestamp = Number(item?.input?.timestamp_ms);
  if (!Number.isFinite(timestamp) || timestamp < 0) errors.push("invalid:timestamp_ms");
  const availableUntil = Number(item?.input?.available_until_ms ?? timestamp);
  if (Number.isFinite(timestamp) && Number.isFinite(availableUntil) && availableUntil > timestamp) {
    errors.push("invalid:future_evidence");
  }
  if (!item?.expectations || typeof item.expectations !== "object") errors.push("missing:expectations");
  return { ok: errors.length === 0, errors };
};

const readDatasetJsonl = (filePath) => {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error instanceof Error ? error.message : error}`);
      }
    });
};

const writeDatasetJsonl = (filePath, cases) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return filePath;
};

const writeManifestDatasetJsonl = ({ root, manifest, manifestPath, requested = {}, outPath = "", env = process.env }) => {
  const cases = manifestToDatasetCases({ root, manifest, manifestPath, requested, env });
  const filePath = path.resolve(outPath || path.join(path.dirname(manifestPath), "dataset.jsonl"));
  writeDatasetJsonl(filePath, cases);
  return { filePath, cases };
};

module.exports = {
  DATASET_CASE_VERSION,
  manifestToDatasetCases,
  readDatasetJsonl,
  validateDatasetCase,
  writeDatasetJsonl,
  writeManifestDatasetJsonl,
};
