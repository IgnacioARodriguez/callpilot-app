import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  explicitSplitRoot,
  validateManifestSet,
} = require("../tests/eval/datasetPolicy.cjs");
const {
  readDatasetJsonl,
  validateDatasetCase,
} = require("../tests/eval/datasetCases.cjs");

const root = path.resolve(import.meta.dirname, "..");
const splits = ["validation", "holdout"];

const argValue = (name, fallback = "") => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
};

const findManifestFiles = (dir) => {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === "manifest.json") {
        out.push(fullPath);
      }
    }
  }
  return out.sort();
};

const entries = [];
const skipped = [];

for (const split of splits) {
  const cliDir = argValue(`--${split}-dir`);
  const datasetDir = explicitSplitRoot({ split, datasetDir: cliDir });
  if (!datasetDir) {
    skipped.push({ split, reason: `missing ${split === "validation" ? "CALLPILOT_EVAL_VALIDATION_DIR" : "CALLPILOT_EVAL_HOLDOUT_DIR"}` });
    continue;
  }
  if (!fs.existsSync(datasetDir)) {
    throw new Error(`${split} dataset directory does not exist: ${datasetDir}`);
  }
  const manifests = findManifestFiles(datasetDir);
  if (manifests.length === 0) {
    skipped.push({ split, datasetDir, reason: "no manifest.json files found" });
    continue;
  }
  for (const manifestPath of manifests) {
    entries.push({
      split,
      datasetDir,
      manifestPath,
      manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")),
    });
  }
}

const checked = validateManifestSet({ root, entries });
const checkedCases = [];
for (const item of checked) {
  const jsonlPath = path.join(path.dirname(item.manifestPath), "dataset.jsonl");
  if (!fs.existsSync(jsonlPath)) continue;
  const cases = readDatasetJsonl(jsonlPath);
  for (const [index, datasetCase] of cases.entries()) {
    const validation = validateDatasetCase(datasetCase);
    if (!validation.ok) {
      throw new Error(`Invalid dataset case in ${jsonlPath}:${index + 1}: ${validation.errors.join(", ")}`);
    }
    if (datasetCase.split !== item.metadata.split) {
      throw new Error(`Dataset case split mismatch in ${jsonlPath}:${index + 1}.`);
    }
    if (datasetCase.source_id !== item.metadata.source_id) {
      throw new Error(`Dataset case source_id mismatch in ${jsonlPath}:${index + 1}.`);
    }
    checkedCases.push({ jsonlPath, caseId: datasetCase.case_id });
  }
}

console.log(JSON.stringify({
  status: checked.length > 0 ? "ok" : "skipped",
  checked_manifests: checked.length,
  checked_cases: checkedCases.length,
  skipped,
  manifests: checked.map((item) => ({
    split: item.metadata.split,
    dataset: item.metadata.dataset,
    source_id: item.metadata.source_id,
    source_type: item.metadata.source_type,
    fixture_class: item.metadata.fixture_class,
    manifest_path: item.manifestPath,
  })),
  dataset_cases: checkedCases,
}, null, 2));
