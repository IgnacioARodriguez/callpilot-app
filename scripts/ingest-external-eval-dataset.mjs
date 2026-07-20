import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  explicitSplitRoot,
  isInside,
  normalizeSplit,
  sourceIdFromPath,
} = require("../tests/eval/datasetPolicy.cjs");

const root = path.resolve(import.meta.dirname, "..");

const argValue = (name, fallback = "") => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
};

const hasFlag = (name) => process.argv.includes(name);

const splitEnvName = (split) => `CALLPILOT_EVAL_${split.toUpperCase()}_DIR`;

const usage = () => [
  "Usage:",
  "  npm run ingest:eval-dataset -- --split=validation --dir=D:\\callpilot-eval\\validation --dataset=backend-validation-v1",
  "  npm run ingest:eval-dataset -- --split=validation --dir=D:\\callpilot-eval\\validation --dataset=backend-validation-v1 --run",
  "",
  "By default this command is a dry run. Pass --run to invoke analyzeLocalVideo for every MP4 under _incoming.",
].join("\n");

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(usage());
  process.exit(0);
}

const split = normalizeSplit(argValue("--split", process.env.CALLPILOT_EVAL_SPLIT || "validation"));
const datasetDir = explicitSplitRoot({
  split,
  datasetDir: argValue("--dir", argValue("--dataset-dir", "")),
});
const resolvedDatasetDir = datasetDir ? path.resolve(datasetDir) : "";
const dataset = argValue("--dataset", process.env.CALLPILOT_EVAL_DATASET || path.basename(resolvedDatasetDir));
const incomingDir = path.resolve(argValue("--incoming", resolvedDatasetDir ? path.join(resolvedDatasetDir, "_incoming") : ""));
const limit = Math.max(0, Number(argValue("--limit", "0")));
const run = hasFlag("--run");
const runId = argValue("--run-id", "");

if (split === "development") {
  throw new Error("ingest:eval-dataset is only for external validation or holdout datasets.");
}

if (!resolvedDatasetDir) {
  throw new Error(`Missing external dataset directory. Pass --dir or set ${splitEnvName(split)}.`);
}

if (isInside(resolvedDatasetDir, root)) {
  throw new Error(`${split} dataset directory must be outside the repository: ${resolvedDatasetDir}`);
}

if (!fs.existsSync(incomingDir)) {
  throw new Error(`Incoming directory does not exist: ${incomingDir}. Run prepare:eval-dataset first.`);
}

if (!isInside(incomingDir, resolvedDatasetDir)) {
  throw new Error(`Incoming directory must live inside the external dataset directory: ${incomingDir}`);
}

const findMp4s = (dir) => {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) out.push(fullPath);
    }
  }
  return out.sort();
};

const sourceIdForVideo = (videoPath) => {
  const relative = path.relative(incomingDir, videoPath);
  const [sourceDir] = relative.split(path.sep).filter(Boolean);
  if (sourceDir && sourceDir !== path.basename(videoPath)) {
    return sourceDir.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || sourceIdFromPath(videoPath);
  }
  return sourceIdFromPath(videoPath);
};

const mp4s = findMp4s(incomingDir);
const selected = limit > 0 ? mp4s.slice(0, limit) : mp4s;
const seenSourceIds = new Map();
const planned = selected.map((videoPath) => {
  const sourceId = sourceIdForVideo(videoPath);
  const existing = seenSourceIds.get(sourceId);
  if (existing) {
    throw new Error(`Duplicate source id "${sourceId}" for ${existing} and ${videoPath}. Use one source directory per complete interview.`);
  }
  seenSourceIds.set(sourceId, videoPath);
  const localConfigPath = path.join(path.dirname(videoPath), "video-config.json");
  const command = [
    process.execPath,
    path.join(root, "tests", "local-video-analysis", "analyzeLocalVideo.cjs"),
    `--split=${split}`,
    `--dataset=${dataset}`,
    `--dataset-dir=${resolvedDatasetDir}`,
    `--source-id=${sourceId}`,
    `--video=${videoPath}`,
    ...(runId ? [`--run-id=${runId}`] : []),
    ...(fs.existsSync(localConfigPath) ? [`--config=${localConfigPath}`] : []),
  ];
  return {
    source_id: sourceId,
    video_path: videoPath,
    config_path: fs.existsSync(localConfigPath) ? localConfigPath : null,
    command,
  };
});

const results = [];
if (run) {
  for (const item of planned) {
    const [command, ...args] = item.command;
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 20 * 60 * 1000,
    });
    results.push({
      source_id: item.source_id,
      status: result.status,
      stdout: result.stdout ? JSON.parse(result.stdout) : null,
      stderr: result.stderr,
    });
    if (result.status !== 0) {
      throw new Error(`Ingestion failed for ${item.source_id} (${result.status}).\n${result.stderr}`);
    }
  }
}

console.log(JSON.stringify({
  status: run ? "ok" : "dry_run",
  split,
  dataset,
  dataset_dir: resolvedDatasetDir,
  incoming_dir: incomingDir,
  discovered_mp4s: mp4s.length,
  planned_ingestions: planned.map((item) => ({
    source_id: item.source_id,
    video_path: item.video_path,
    config_path: item.config_path,
    command: item.command.slice(1),
  })),
  results,
  next_command: run ? "npm run test:eval-datasets" : "Repeat with --run to ingest these MP4s.",
}, null, 2));
