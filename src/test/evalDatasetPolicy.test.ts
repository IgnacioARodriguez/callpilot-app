import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assertManifestAllowedForEvaluation,
  metadataFromInputs,
} = require("../../tests/eval/datasetPolicy.cjs");

const root = path.resolve(process.cwd());

test("existing or unmarked video manifests default to development fixtures", () => {
  const manifestPath = path.join(root, ".cache", "local-video-analysis", "known", "manifest.json");
  const metadata = assertManifestAllowedForEvaluation({
    root,
    manifest: { video: { path: path.join(root, ".cache", "local-video-analysis", "known.mp4") } },
    manifestPath,
    requested: { split: "development" },
    env: {},
  });

  assert.equal(metadata.split, "development");
  assert.equal(metadata.fixture_class, "development_fixture");
  assert.equal(metadata.visibility, "known_development_material");
});

test("validation and holdout require an explicit external dataset directory", () => {
  assert.throws(
    () => metadataFromInputs({
      root,
      split: "validation",
      videoPath: path.join(root, ".cache", "local-video-analysis", "known.mp4"),
      manifestPath: path.join(root, ".cache", "local-video-analysis", "known", "manifest.json"),
      env: {},
    }),
    /external dataset directory/,
  );

  assert.throws(
    () => metadataFromInputs({
      root,
      split: "holdout",
      datasetDir: path.join(root, "tests", "local-media", "holdout"),
      videoPath: path.join(root, "tests", "local-media", "holdout", "interview.mp4"),
      manifestPath: path.join(root, "tests", "local-media", "holdout", "manifest.json"),
      env: {},
    }),
    /outside the repository/,
  );
});

test("validation manifests must be tagged and contained in the external split directory", () => {
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "callpilot-validation-"));
  const videoPath = path.join(externalRoot, "interview-a.mp4");
  const manifestPath = path.join(externalRoot, "interview-a", "manifest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(videoPath, "synthetic placeholder", "utf8");

  assert.throws(
    () => assertManifestAllowedForEvaluation({
      root,
      manifest: { video: { path: videoPath } },
      manifestPath,
      requested: { split: "validation", datasetDir: externalRoot },
      env: {},
    }),
    /missing evaluation_dataset metadata/,
  );

  const manifest = {
    evaluation_dataset: {
      schema_version: 1,
      dataset: "external-validation-smoke",
      split: "validation",
      source_id: "interview-a",
      source_type: "mp4",
      external_dataset_dir: externalRoot,
    },
    video: { path: videoPath },
  };
  const metadata = assertManifestAllowedForEvaluation({
    root,
    manifest,
    manifestPath,
    requested: { split: "validation", datasetDir: externalRoot },
    env: {},
  });

  assert.equal(metadata.split, "validation");
  assert.equal(metadata.fixture_class, "external_evaluation_source");
  assert.equal(metadata.visibility, "unseen_until_evaluation");
});
