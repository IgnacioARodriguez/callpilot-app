import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isInside,
  normalizeSplit,
  writeDatasetReadme,
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
  "  npm run prepare:eval-dataset -- --split=validation --dir=D:\\callpilot-eval\\validation --dataset=backend-validation-v1",
  "  npm run prepare:eval-dataset -- --split=holdout --dir=D:\\callpilot-eval\\holdout --dataset=backend-holdout-v1",
  "",
  "External validation and holdout directories must live outside this repository.",
].join("\n");

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(usage());
  process.exit(0);
}

const split = normalizeSplit(argValue("--split", process.env.CALLPILOT_EVAL_SPLIT || "validation"));
const datasetDir = path.resolve(argValue("--dir", argValue("--dataset-dir", process.env[splitEnvName(split)] || "")));
const dataset = argValue("--dataset", process.env.CALLPILOT_EVAL_DATASET || path.basename(datasetDir));

if (split === "development") {
  throw new Error("prepare:eval-dataset is only for external validation or holdout datasets.");
}

if (!datasetDir || datasetDir === root) {
  throw new Error(`Missing external dataset directory. Pass --dir or set ${splitEnvName(split)}.`);
}

if (isInside(datasetDir, root)) {
  throw new Error(`${split} dataset directory must be outside the repository: ${datasetDir}`);
}

fs.mkdirSync(datasetDir, { recursive: true });
fs.mkdirSync(path.join(datasetDir, "_incoming"), { recursive: true });
fs.mkdirSync(path.join(datasetDir, "reports"), { recursive: true });

const readmePath = writeDatasetReadme(datasetDir);
const workflowPath = path.join(datasetDir, "WORKFLOW.md");
const policyPath = path.join(datasetDir, "dataset-policy.json");

const envLine = `$env:${splitEnvName(split)}="${datasetDir}"`;
const exampleSourceId = split === "holdout" ? "holdout-001" : "interview-001";
const exampleVideoPath = path.join(datasetDir, "_incoming", exampleSourceId, "interview.mp4");

if (!fs.existsSync(workflowPath)) {
  fs.writeFileSync(workflowPath, [
    `# CallPilot ${split} Dataset Workflow`,
    "",
    "This directory is outside the repository by design. Keep MP4s, extracted frames, transcripts, manifests, provider outputs, and reports here.",
    "",
    "## 1. Put MP4s Under _incoming",
    "",
    "Use one complete interview/session per source directory:",
    "",
    "```text",
    path.join(datasetDir, "_incoming", exampleSourceId, "interview.mp4"),
    "```",
    "",
    "## 2. Ingest One MP4",
    "",
    "```powershell",
    envLine,
    `node tests/local-video-analysis/analyzeLocalVideo.cjs --split=${split} --dataset=${dataset} --dataset-dir="${datasetDir}" --source-id=${exampleSourceId} --video="${exampleVideoPath}"`,
    "```",
    "",
    "Review the generated `review.html` only for validation. For holdout, do not inspect raw recordings, extracted frames, transcripts, expected answers, or executable tests while implementing fixes.",
    "",
    "## 3. Check Dataset Integrity",
    "",
    "```powershell",
    envLine,
    "npm run test:eval-datasets",
    "```",
    "",
    "## 4. Run Evaluation",
    "",
    "```powershell",
    envLine,
    "$env:E2E_MAX_REAL_CALLS=\"6\"",
    `node tests/e2e/video-interview/localVideoInterviewRunner.cjs --split=${split} --dataset-dir="${datasetDir}" --manifest="<path-to-generated-manifest.json>" --out="${path.join(datasetDir, "reports", "run-001")}"`,
    "```",
    "",
    "## Rules",
    "",
    "- Do not copy this directory into Git.",
    "- Do not split checkpoints from the same interview across splits.",
    "- Do not tune prompts, parsers, or scorers to holdout content.",
    "- Do not count blocked provider or judge calls as successful evaluations.",
    "",
  ].join("\n"), "utf8");
}

const policy = {
  schema_version: 1,
  split,
  dataset,
  dataset_dir: datasetDir,
  repository_root: root,
  created_at: new Date().toISOString(),
  env: {
    [splitEnvName(split)]: datasetDir,
  },
  directories: {
    incoming: path.join(datasetDir, "_incoming"),
    reports: path.join(datasetDir, "reports"),
  },
  policy: {
    external_to_repository: true,
    complete_session_split_unit: true,
    raw_media_not_committed_to_git: true,
    holdout_not_inspected_while_improving_application: split === "holdout",
  },
};
fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  status: "ok",
  split,
  dataset,
  dataset_dir: datasetDir,
  env: policy.env,
  readme_path: readmePath,
  workflow_path: workflowPath,
  policy_path: policyPath,
  next_commands: [
    envLine,
    `node tests/local-video-analysis/analyzeLocalVideo.cjs --split=${split} --dataset=${dataset} --dataset-dir="${datasetDir}" --source-id=${exampleSourceId} --video="${exampleVideoPath}"`,
    "npm run test:eval-datasets",
  ],
}, null, 2));
