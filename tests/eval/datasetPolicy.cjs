const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const VALID_SPLITS = new Set(["development", "validation", "holdout"]);

const argValueFrom = (argv, name, fallback = "") => {
  const prefix = `${name}=`;
  return argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
};

const normalizeSplit = (value = "development") => {
  const split = String(value || "development").trim().toLowerCase();
  if (!VALID_SPLITS.has(split)) {
    throw new Error(`Unsupported eval split "${value}". Use development, validation, or holdout.`);
  }
  return split;
};

const normalizePath = (filePath) => path.resolve(filePath || "");

const isInside = (child, parent) => {
  if (!child || !parent) return false;
  const relative = path.relative(normalizePath(parent), normalizePath(child));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
};

const sourceIdFromPath = (filePath) => {
  const parsed = path.parse(filePath || "");
  return parsed.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "unknown-source";
};

const sha256File = (filePath) => {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
};

const splitEnvName = (split) => `CALLPILOT_EVAL_${split.toUpperCase()}_DIR`;

const explicitSplitRoot = ({ split, datasetDir = "", env = process.env }) => {
  const direct = datasetDir || env[splitEnvName(split)] || "";
  if (direct) return normalizePath(direct);
  const commonRoot = env.CALLPILOT_EVAL_DATASET_DIR || "";
  return commonRoot ? path.join(normalizePath(commonRoot), split) : "";
};

const metadataFromInputs = ({
  root,
  split,
  dataset = "",
  sourceId = "",
  sourceType = "mp4",
  videoPath = "",
  manifestPath = "",
  configPath = "",
  datasetDir = "",
  env = process.env,
}) => {
  const normalizedSplit = normalizeSplit(split);
  const sourcePath = videoPath ? normalizePath(videoPath) : "";
  const resolvedManifestPath = manifestPath ? normalizePath(manifestPath) : "";
  const splitRoot = explicitSplitRoot({ split: normalizedSplit, datasetDir, env });
  const resolvedRoot = normalizePath(root);
  const resolvedSourceId = sourceId || sourceIdFromPath(sourcePath || resolvedManifestPath);
  const externalRequired = normalizedSplit !== "development";

  if (externalRequired) {
    if (!splitRoot) {
      throw new Error(`${normalizedSplit} evaluations require an external dataset directory via --dataset-dir, ${splitEnvName(normalizedSplit)}, or CALLPILOT_EVAL_DATASET_DIR.`);
    }
    if (isInside(splitRoot, resolvedRoot)) {
      throw new Error(`${normalizedSplit} dataset directory must be outside the repository: ${splitRoot}`);
    }
    if (resolvedManifestPath && !isInside(resolvedManifestPath, splitRoot)) {
      throw new Error(`${normalizedSplit} manifest must live inside the external dataset directory: ${resolvedManifestPath}`);
    }
    if (sourcePath && !isInside(sourcePath, splitRoot)) {
      throw new Error(`${normalizedSplit} MP4/source must live inside the external dataset directory: ${sourcePath}`);
    }
  }

  return {
    schema_version: 1,
    dataset: dataset || (externalRequired ? path.basename(splitRoot) : "local-development-fixtures"),
    split: normalizedSplit,
    source_id: resolvedSourceId,
    source_type: sourceType,
    fixture_class: externalRequired ? "external_evaluation_source" : "development_fixture",
    visibility: externalRequired ? "unseen_until_evaluation" : "known_development_material",
    external_dataset_dir: splitRoot || null,
    source_path: sourcePath || null,
    manifest_path: resolvedManifestPath || null,
    config_path: configPath ? normalizePath(configPath) : null,
    policy: {
      existing_mp4_and_manifest_are_development_only: true,
      validation_and_holdout_require_external_dataset: true,
      split_unit: "complete_interview_or_session",
      no_checkpoint_split_across_splits: true,
    },
  };
};

const mergeManifestMetadata = ({ root, manifest, manifestPath, requested = {}, env = process.env }) => {
  const existing = manifest?.evaluation_dataset && typeof manifest.evaluation_dataset === "object"
    ? manifest.evaluation_dataset
    : {};
  const split = normalizeSplit(requested.split || existing.split || "development");
  const metadata = metadataFromInputs({
    root,
    split,
    dataset: requested.dataset || existing.dataset || "",
    sourceId: requested.sourceId || existing.source_id || "",
    sourceType: requested.sourceType || existing.source_type || "mp4",
    videoPath: manifest?.video?.path || "",
    manifestPath,
    configPath: requested.configPath || existing.config_path || "",
    datasetDir: requested.datasetDir || existing.external_dataset_dir || "",
    env,
  });

  if (existing.split && normalizeSplit(existing.split) !== split) {
    throw new Error(`Requested split "${split}" does not match manifest split "${existing.split}".`);
  }
  if (split !== "development" && !existing.schema_version) {
    throw new Error(`${split} manifest is missing evaluation_dataset metadata. Re-ingest it with --split=${split} and an external --dataset-dir.`);
  }
  return { ...existing, ...metadata };
};

const assertManifestAllowedForEvaluation = ({ root, manifest, manifestPath, requested = {}, env = process.env }) => {
  const metadata = mergeManifestMetadata({ root, manifest, manifestPath, requested, env });
  if (metadata.split !== "development" && metadata.fixture_class !== "external_evaluation_source") {
    throw new Error(`${metadata.split} evaluation source is not marked as external.`);
  }
  if (metadata.split !== "development" && !metadata.content_hash && !manifest?.video?.sha256) {
    throw new Error(`${metadata.split} manifest must include a stable content hash.`);
  }
  const expectedHash = metadata.content_hash || manifest?.video?.sha256 || "";
  if (metadata.split !== "development" && metadata.content_hash && manifest?.video?.sha256 && metadata.content_hash !== manifest.video.sha256) {
    throw new Error(`${metadata.split} manifest content_hash does not match video.sha256.`);
  }
  const sourcePath = metadata.source_path || manifest?.video?.path || "";
  if (metadata.split !== "development" && sourcePath && fs.existsSync(sourcePath) && expectedHash) {
    const actualHash = sha256File(sourcePath);
    if (actualHash !== expectedHash) {
      throw new Error(`${metadata.split} source hash mismatch for ${sourcePath}.`);
    }
  }
  validateCheckpointSet(manifest);
  return metadata;
};

const validateCheckpointSet = (manifest) => {
  const checkpoints = Array.isArray(manifest?.checkpoints) ? manifest.checkpoints : [];
  const ids = new Set();
  for (const checkpoint of checkpoints) {
    const id = String(checkpoint?.id || "").trim();
    if (!id) throw new Error("Manifest checkpoint is missing id.");
    if (ids.has(id)) throw new Error(`Manifest has duplicate checkpoint id: ${id}`);
    ids.add(id);
    const timestamp = Number(checkpoint?.timestamp_ms);
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new Error(`Checkpoint ${id} has invalid timestamp_ms.`);
    }
    const availableUntil = Number(checkpoint?.available_until_ms ?? checkpoint?.timestamp_ms);
    if (Number.isFinite(availableUntil) && availableUntil > timestamp) {
      throw new Error(`Checkpoint ${id} uses evidence after its timestamp.`);
    }
  }
  return true;
};

const validateManifestSet = ({ root, entries, env = process.env }) => {
  const checked = [];
  const splitKeys = new Map();
  const rememberSplitKey = (key, split) => {
    if (!key) return;
    const existing = splitKeys.get(key);
    if (existing && existing !== split) {
      throw new Error(`Source "${key}" is assigned to multiple splits: ${existing}, ${split}. Split by complete interview/session.`);
    }
    splitKeys.set(key, split);
  };
  for (const entry of entries) {
    const manifest = entry.manifest;
    const manifestPath = entry.manifestPath;
    const requested = {
      split: entry.split,
      datasetDir: entry.datasetDir,
      dataset: entry.dataset,
      sourceId: entry.sourceId,
    };
    const metadata = assertManifestAllowedForEvaluation({ root, manifest, manifestPath, requested, env });
    rememberSplitKey(`source_id:${metadata.source_id}`, metadata.split);
    rememberSplitKey(`content_hash:${metadata.content_hash || manifest?.video?.sha256 || ""}`, metadata.split);
    checked.push({ manifestPath, metadata });
  }
  return checked;
};

const cliDatasetOptions = (argv = process.argv, env = process.env) => ({
  split: argValueFrom(argv, "--split", env.CALLPILOT_EVAL_SPLIT || "development"),
  dataset: argValueFrom(argv, "--dataset", env.CALLPILOT_EVAL_DATASET || ""),
  datasetDir: argValueFrom(argv, "--dataset-dir", env.CALLPILOT_EVAL_DATASET_DIR || ""),
  sourceId: argValueFrom(argv, "--source-id", env.CALLPILOT_EVAL_SOURCE_ID || ""),
});

const writeDatasetReadme = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const readmePath = path.join(dir, "README.md");
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, [
      "# External CallPilot Evaluation Dataset",
      "",
      "This directory is intentionally outside the repository.",
      "Use it for validation or holdout MP4s/manifests that were not used during development.",
      "Do not copy raw recordings, transcripts, screenshots, or expected answers into Git.",
      "",
    ].join("\n"), "utf8");
  }
  return readmePath;
};

module.exports = {
  VALID_SPLITS,
  argValueFrom,
  assertManifestAllowedForEvaluation,
  cliDatasetOptions,
  explicitSplitRoot,
  isInside,
  metadataFromInputs,
  mergeManifestMetadata,
  normalizeSplit,
  sha256File,
  sourceIdFromPath,
  validateCheckpointSet,
  validateManifestSet,
  writeDatasetReadme,
};
