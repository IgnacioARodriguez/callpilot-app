const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const electronBin = require("electron");
const {
  cliDatasetOptions,
  explicitSplitRoot,
  metadataFromInputs,
  normalizeSplit,
  sourceIdFromPath,
  writeDatasetReadme,
} = require("../eval/datasetPolicy.cjs");

const root = path.resolve(__dirname, "..", "..");
const defaultVideo = process.env.CALLPILOT_E2E_VIDEO || "";
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const argValue = (name, fallback = "") => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
};
const readJsonIfPresent = (filePath) => {
  if (!filePath) return {};
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`Video config not found: ${absolute}`);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
};
const numberSetting = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : fallback;
};

const configPath = argValue("--config", process.env.CALLPILOT_E2E_VIDEO_CONFIG || "");
const videoConfig = readJsonIfPresent(configPath);
const analysisConfig = videoConfig.analysis && typeof videoConfig.analysis === "object" ? videoConfig.analysis : {};
const configVideoPath = typeof videoConfig.video_path === "string" ? videoConfig.video_path : "";
const selectedVideoPath = argValue("--video", defaultVideo || configVideoPath);
const videoPath = selectedVideoPath ? path.resolve(selectedVideoPath) : "";
const runId = argValue("--run-id", `analysis-${stamp()}`);
const datasetOptions = cliDatasetOptions(process.argv);
const evalSplit = normalizeSplit(datasetOptions.split);
const evalSourceId = datasetOptions.sourceId || sourceIdFromPath(selectedVideoPath || configVideoPath);
const evalSplitRoot = evalSplit === "development"
  ? ""
  : explicitSplitRoot({ split: evalSplit, datasetDir: datasetOptions.datasetDir });
if (evalSplit !== "development") writeDatasetReadme(evalSplitRoot);
const defaultOutDir = evalSplit === "development"
  ? path.join(root, ".cache", "local-video-analysis", runId)
  : path.join(evalSplitRoot, evalSourceId, runId);
const outDir = path.resolve(argValue("--out", defaultOutDir));
const frameStepMs = numberSetting(argValue("--frame-step-ms", process.env.E2E_LOCAL_VIDEO_FRAME_STEP_MS || analysisConfig.frame_step_ms), 30000);
const maxFrames = numberSetting(argValue("--max-frames", process.env.E2E_LOCAL_VIDEO_MAX_FRAMES || analysisConfig.max_frames), 24);
const maxCheckpoints = numberSetting(argValue("--max-checkpoints", process.env.E2E_LOCAL_VIDEO_MAX_CHECKPOINTS || analysisConfig.max_checkpoints), 5);
const minCheckpointGapMs = numberSetting(analysisConfig.min_checkpoint_gap_ms, 45000);
const disableOcr = argValue("--no-ocr", process.env.E2E_LOCAL_VIDEO_NO_OCR || "") === "1" || analysisConfig.disable_ocr === true;
const fallbackRatios = Array.isArray(analysisConfig.fallback_ratios) && analysisConfig.fallback_ratios.length > 0
  ? analysisConfig.fallback_ratios.map(Number).filter((item) => Number.isFinite(item) && item > 0 && item < 1)
  : [0.25, 0.5, 0.75];
const ignoreRanges = Array.isArray(analysisConfig.ignore_ranges_ms) ? analysisConfig.ignore_ranges_ms : [];
const forceCheckpoints = Array.isArray(analysisConfig.force_checkpoints) ? analysisConfig.force_checkpoints : [];

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");
const relativeArtifactPath = (filePath) => path.relative(outDir, filePath).replace(/\\/g, "/");
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};

const technicalScore = (text) => {
  const source = String(text || "");
  const lower = source.toLowerCase();
  const patterns = [
    /\bleetcode\b|\bhackerrank\b|\bcoderpad\b|\blive coding\b|\bcoding\b|\bproblem solving\b/,
    /\bexamples?\b|\bconstraints?\b|\binput\b.*\boutput\b/s,
    /\bcomplexit(?:y|ies)\b|\bo\([^)]+\)/,
    /\bhash ?map\b|\bdictionary\b|\barray\b|\blinked list\b|\btree\b|\bgraph\b|\bqueue\b|\bstack\b|\bnode\b|\blow\b|\bhigh\b/,
    /\bdef\s+\w+\s*\(|\bfunction\s+\w+\s*\(|\bclass\s+\w+\b|\bconst\s+\w+\b/,
    /\bassert\b|\btest(?:s|ing)?\b|\berror\b|\bexception\b|\btraceback\b|\bterminal\b/,
    /\bapi\b|\bsql\b|\bredis\b|\bkafka\b|\bhttp\b|\bjson\b/,
  ];
  return patterns.reduce((sum, pattern) => sum + (pattern.test(source) || pattern.test(lower) ? 1 : 0), 0);
};

const isClosingOrPlatformNoise = (text) =>
  /\b(?:thanks for watching|subscribe|recommended video|like - comment - share)\b/i.test(String(text || ""));

const inIgnoredRange = (timestampMs) => ignoreRanges.some((range) => {
  const start = Number(range?.start_ms);
  const end = Number(range?.end_ms);
  return Number.isFinite(start) && Number.isFinite(end) && timestampMs >= start && timestampMs <= end;
});

const runProbe = () => {
  fs.mkdirSync(outDir, { recursive: true });
  const probeScript = path.join(__dirname, "electronVideoProbe.cjs");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const forcedFrameTimes = forceCheckpoints
    .map((checkpoint) => Number(checkpoint?.timestamp_ms))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= 0);
  const result = spawnSync(electronBin, [
    probeScript,
    `--video=${videoPath}`,
    `--out=${outDir}`,
    `--frame-step-ms=${Number.isFinite(frameStepMs) ? frameStepMs : 30000}`,
    `--max-frames=${Number.isFinite(maxFrames) ? maxFrames : 24}`,
    ...(forcedFrameTimes.length > 0 ? [`--frame-times-ms=${forcedFrameTimes.join(",")}`] : []),
  ], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });
  if (result.status !== 0) {
    throw new Error(`Video probe failed (${result.status}).\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return JSON.parse(fs.readFileSync(path.join(outDir, "probe-result.json"), "utf8"));
};

const recognizeFrames = async (frames) => {
  if (disableOcr) return frames.map((frame) => ({ ...frame, ocr: { ok: false, skipped: true, text: "", confidence: null } }));
  let Tesseract;
  try {
    const module = await import("tesseract.js");
    Tesseract = module.default || module;
  } catch (error) {
    return frames.map((frame) => ({
      ...frame,
      ocr: { ok: false, skipped: true, text: "", confidence: null, error: error instanceof Error ? error.message : "tesseract_unavailable" },
    }));
  }

  const output = [];
  for (const frame of frames) {
    try {
      const result = await Tesseract.recognize(frame.path, "eng", {
        cachePath: path.join(outDir, "tessdata"),
      });
      const data = result?.data ?? {};
      output.push({
        ...frame,
        ocr: {
          ok: Boolean(String(data.text || "").trim()),
          text: String(data.text || "").trim(),
          confidence: typeof data.confidence === "number" ? Number(data.confidence.toFixed(1)) : null,
        },
      });
    } catch (error) {
      output.push({
        ...frame,
        ocr: { ok: false, text: "", confidence: null, error: error instanceof Error ? error.message : "ocr_failed" },
      });
    }
  }
  return output;
};

const candidateForFrame = (frame) => {
  const text = frame.ocr?.text || "";
  const closingNoise = isClosingOrPlatformNoise(text);
  const ignored = inIgnoredRange(frame.timestamp_ms);
  const score = closingNoise || ignored ? 0 : technicalScore(text);
  const visualChange = !closingNoise && !ignored && frame.timestamp_ms > 0 ? Number(frame.diff_from_previous || 0) : 0;
  const terms = [
    "hash map", "dictionary", "array", "linked list", "tree", "graph", "queue", "stack",
    "O(", "complexity", "SQL", "Redis", "Kafka", "API", "test", "error", "traceback",
    "def ", "function ", "class ", "node", "low", "high",
  ].filter((term) => text.toLowerCase().includes(term.toLowerCase()));
  return {
    frame,
    score,
    visualChange,
    combined: score * 2 + (visualChange >= 0.18 ? 2 : visualChange >= 0.08 ? 1 : 0),
    terms,
    ignored,
    closingNoise,
  };
};

const checkpointFromCandidate = (item, index, options = {}) => {
  const reason = options.reason || (item.score > 0
    ? "Video-specific analysis found visible coding/problem/test/terminal context at this timestamp."
    : "Video-specific fallback checkpoint; review before running if this video needs more precise Answer timing.");
  return {
    id: options.id || `checkpoint-${String(index + 1).padStart(2, "0")}`,
    timestamp_ms: Math.round(options.timestamp_ms ?? item.frame.timestamp_ms),
    action: "pause_and_answer",
    reason,
    source: options.source || "auto_video_analysis",
    source_frame_path: item.frame.path,
    visual_context_expected: options.visual_context_expected || (item.terms.length > 0 ? item.terms : ["technical context visible or needs manual review"]),
    evaluation: {
      expected_topics: options.expected_topics || item.terms,
      desirable_topics: options.desirable_topics || [],
      forbidden_claims: [
        "Do not claim interviewer/candidate diarization is measured.",
        "Do not use future video content for this answer.",
        "Do not invent code or constraints not visible or transcribed before this timestamp.",
        ...(options.forbidden_claims || []),
      ],
      critical_failures: [
        "Answers a different earlier question.",
        "Invents visible code/problem details not present in transcript or screen context.",
        "Gives unsupported complexity for the visible/current problem.",
        "Produces an answer too long for a live interview.",
        ...(options.critical_failures || []),
      ],
    },
  };
};

const buildCheckpointCandidates = (frames) =>
  frames.map(candidateForFrame)
    .sort((a, b) => b.combined - a.combined)
    .map((item, index) => ({
      timestamp_ms: item.frame.timestamp_ms,
      frame_path: item.frame.path,
      score: item.score,
      visual_change: Number(item.visualChange.toFixed(4)),
      combined_score: Number(item.combined.toFixed(2)),
      technical_terms: item.terms,
      ignored: item.ignored,
      closing_noise: item.closingNoise,
      ocr_confidence: item.frame.ocr?.confidence ?? null,
      ocr_excerpt: String(item.frame.ocr?.text || "").replace(/\s+/g, " ").trim().slice(0, 220),
      suggested_force_checkpoint: {
        id: `video-specific-${String(index + 1).padStart(2, "0")}`,
        timestamp_ms: item.frame.timestamp_ms,
        reason: item.score > 0
          ? "Review: visible technical/code context at this video-specific timestamp."
          : "Review: possible checkpoint candidate for this video.",
        visual_context_expected: item.terms.length > 0 ? item.terms : ["technical context visible or needs manual review"],
        expected_topics: item.terms,
      },
    }));

const buildCheckpoints = (probe, frames) => {
  const candidates = frames.map(candidateForFrame);

  const selected = [];
  for (const forced of forceCheckpoints) {
    const timestamp = Number(forced?.timestamp_ms);
    if (!Number.isFinite(timestamp)) continue;
    const nearest = frames.reduce((best, frame) =>
      Math.abs(frame.timestamp_ms - timestamp) < Math.abs(best.timestamp_ms - timestamp) ? frame : best, frames[0]);
    selected.push({
      ...candidateForFrame(nearest),
      forced,
      forcedTimestampMs: timestamp,
    });
  }
  for (const candidate of candidates.filter((item) => item.combined > 0 && !item.ignored).sort((a, b) => b.combined - a.combined)) {
    if (selected.some((item) => Math.abs((item.forcedTimestampMs ?? item.frame.timestamp_ms) - candidate.frame.timestamp_ms) < minCheckpointGapMs)) continue;
    selected.push(candidate);
    if (selected.length >= maxCheckpoints) break;
  }
  const targetFallbackCount = Math.min(Math.max(1, maxCheckpoints), 3);
  if (selected.length < targetFallbackCount && probe.video.duration_ms > 0) {
    fallbackRatios.slice(0, maxCheckpoints).forEach((ratio) => {
      const timestamp = Math.round(probe.video.duration_ms * ratio);
      const nearest = frames.reduce((best, frame) =>
        Math.abs(frame.timestamp_ms - timestamp) < Math.abs(best.timestamp_ms - timestamp) ? frame : best, frames[0]);
      if (isClosingOrPlatformNoise(nearest.ocr?.text || "")) return;
      if (inIgnoredRange(nearest.timestamp_ms)) return;
      if (selected.some((item) => Math.abs((item.forcedTimestampMs ?? item.frame.timestamp_ms) - nearest.timestamp_ms) < minCheckpointGapMs)) return;
      selected.push({ ...candidateForFrame(nearest), score: 0, combined: 0 });
    });
  }

  return selected
    .sort((a, b) => (a.forcedTimestampMs ?? a.frame.timestamp_ms) - (b.forcedTimestampMs ?? b.frame.timestamp_ms))
    .slice(0, maxCheckpoints)
    .map((item, index) => checkpointFromCandidate(item, index, item.forced ? {
      id: item.forced.id,
      timestamp_ms: item.forcedTimestampMs,
      reason: item.forced.reason || "Forced by this video's config.",
      source: "video_config",
      visual_context_expected: item.forced.visual_context_expected,
      expected_topics: item.forced.expected_topics,
      desirable_topics: item.forced.desirable_topics,
      forbidden_claims: item.forced.forbidden_claims,
      critical_failures: item.forced.critical_failures,
    } : {}));
};

const writeVideoConfigTemplate = (manifest) => {
  const template = {
    video_path: manifest.video.path,
    notes: "Copy this file, edit it for this specific video, then pass --config=path or set CALLPILOT_E2E_VIDEO_CONFIG.",
    analysis: {
      frame_step_ms: frameStepMs,
      max_frames: maxFrames,
      max_checkpoints: maxCheckpoints,
      min_checkpoint_gap_ms: minCheckpointGapMs,
      fallback_ratios: fallbackRatios,
      ignore_ranges_ms: [
        { start_ms: Math.max(0, manifest.video.duration_ms - 120000), end_ms: manifest.video.duration_ms, reason: "closing/end screen" }
      ],
      force_checkpoints: manifest.checkpoints.map((checkpoint) => ({
        id: checkpoint.id,
        timestamp_ms: checkpoint.timestamp_ms,
        reason: checkpoint.reason,
        expected_topics: checkpoint.evaluation.expected_topics,
      })),
    },
    execution: {
      default_audio_lookback_ms: 60000,
      recommended_max_real_calls_per_checkpoint: 3,
    },
  };
  const configPath = path.join(outDir, "video-config.template.json");
  fs.writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  return configPath;
};

const writeReviewHtml = (manifestPath, manifest) => {
  const cards = manifest.checkpoint_candidates.map((candidate) => {
    const frameSrc = relativeArtifactPath(candidate.frame_path);
    const snippet = JSON.stringify(candidate.suggested_force_checkpoint, null, 2);
    return `
      <article class="card ${candidate.ignored || candidate.closing_noise ? "muted" : ""}">
        <img src="${escapeHtml(frameSrc)}" alt="Frame at ${candidate.timestamp_ms} ms" />
        <div class="body">
          <h2>${candidate.timestamp_ms} ms</h2>
          <p><strong>score:</strong> ${candidate.combined_score} <strong>visual:</strong> ${candidate.visual_change} <strong>ocr:</strong> ${candidate.ocr_confidence ?? "n/a"}</p>
          <p><strong>terms:</strong> ${escapeHtml(candidate.technical_terms.join(", ") || "none")}</p>
          <p><strong>ignored:</strong> ${candidate.ignored ? "yes" : "no"} <strong>closing noise:</strong> ${candidate.closing_noise ? "yes" : "no"}</p>
          <p class="ocr">${escapeHtml(candidate.ocr_excerpt || "(no OCR text)")}</p>
          <pre>${escapeHtml(snippet)}</pre>
        </div>
      </article>`;
  }).join("\n");
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>CallPilot Local Video Review</title>
<style>
  body { margin: 0; font: 14px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; background: #f6f7f9; color: #1d2430; }
  header { position: sticky; top: 0; z-index: 1; padding: 16px 20px; background: #ffffff; border-bottom: 1px solid #d9dee7; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; padding: 16px; }
  .card { background: #fff; border: 1px solid #d9dee7; border-radius: 8px; overflow: hidden; }
  .card.muted { opacity: 0.62; }
  img { display: block; width: 100%; background: #111; aspect-ratio: 16 / 9; object-fit: contain; }
  .body { padding: 12px; }
  h2 { margin: 0 0 8px; font-size: 16px; }
  p { margin: 6px 0; }
  .ocr { min-height: 38px; color: #4a5568; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #111827; color: #e5e7eb; padding: 10px; border-radius: 6px; font-size: 12px; }
</style>
<header>
  <h1>CallPilot Local Video Review</h1>
  <div>Video: ${escapeHtml(manifest.video.fileName)} | Duration: ${manifest.video.duration_ms} ms | Manifest: ${escapeHtml(manifestPath)}</div>
  <div>Copy a JSON block into <code>analysis.force_checkpoints</code> in this video's config when that timestamp is a good Answer moment.</div>
</header>
<main>
${cards}
</main>
</html>`;
  const reviewPath = path.join(outDir, "review.html");
  fs.writeFileSync(reviewPath, html, "utf8");
  return reviewPath;
};

const writeMarkdownSummary = (manifestPath, manifest) => {
  const md = [
    "# Local Video Interview Manifest",
    "",
    `Video: ${manifest.video.fileName}`,
    `Duration: ${Math.round(manifest.video.duration_ms / 1000)}s`,
    `Resolution: ${manifest.video.width}x${manifest.video.height}`,
    `Manifest: ${manifestPath}`,
    "",
    "## Methodology",
    "",
    "- This manifest is generated before CallPilot answers.",
    "- It may use OCR and visual change detection to select moments where a human would plausibly press Answer.",
    "- It does not provide CallPilot with ground-truth transcript, candidate answers, or future video context.",
    "- Diarization is explicitly out of scope: both voices are treated as mixed interview audio.",
    "- Checkpoints are video-specific. Review and edit video-config.template.json for each new MP4.",
    `- Visual review page: ${manifest.artifacts.review_html_path}`,
    "",
    "## Checkpoints",
    "",
    ...manifest.checkpoints.map((checkpoint) => [
      `### ${checkpoint.id}`,
      "",
      `- Timestamp: ${checkpoint.timestamp_ms} ms`,
      `- Reason: ${checkpoint.reason}`,
      `- Frame: ${checkpoint.source_frame_path}`,
      `- Expected visual topics: ${checkpoint.visual_context_expected.join(", ")}`,
      "",
    ].join("\n")),
    "## Top Checkpoint Candidates",
    "",
    ...manifest.checkpoint_candidates.slice(0, 12).map((candidate) => [
      `- ${candidate.timestamp_ms} ms | score ${candidate.combined_score} | terms: ${candidate.technical_terms.join(", ") || "none"} | ignored: ${candidate.ignored}`,
      `  ${candidate.ocr_excerpt || "(no OCR text)"}`,
    ].join("\n")),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "manifest-summary.md"), md, "utf8");
};

const main = async () => {
  ensure(selectedVideoPath, "Set CALLPILOT_E2E_VIDEO, pass --video=C:\\path\\interview.mp4, or provide video_path in --config.");
  ensure(fs.existsSync(videoPath), `Video not found: ${videoPath}`);

  const probe = runProbe();
  const frames = await recognizeFrames(probe.frames || []);
  const checkpoints = buildCheckpoints(probe, frames);
  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    methodology: {
      role: "Codex simulates a human user deciding when to press Answer.",
      diarization: "Out of scope for this phase; mixed interviewer/candidate audio is expected.",
      config_path: configPath ? path.resolve(configPath) : null,
      video_specific_configuration: "Every MP4 should get its own generated manifest and optional config override.",
      forbidden_inputs_to_callpilot: [
        "ground truth transcript",
        "candidate answer from future video content",
        "manual problem description not produced by CallPilot pipelines",
        "future video information beyond the checkpoint timestamp"
      ],
      limitations: [
        "Without ffmpeg/ffprobe, metadata and frames are extracted through Electron/Chromium video APIs.",
        "Question detection from audio requires a later STT pass; this manifest is primarily visual unless transcripts are added as evaluation-only artifacts.",
      ],
    },
    video: {
      ...probe.video,
      sha256: sha256(fs.readFileSync(videoPath)),
    },
    artifacts: {
      root: outDir,
      frames_dir: path.join(outDir, "frames"),
      probe_result_path: path.join(outDir, "probe-result.json"),
    },
    analysis_settings: {
      frame_step_ms: frameStepMs,
      max_frames: maxFrames,
      max_checkpoints: maxCheckpoints,
      min_checkpoint_gap_ms: minCheckpointGapMs,
      fallback_ratios: fallbackRatios,
      ignore_ranges_ms: ignoreRanges,
      forced_checkpoint_count: forceCheckpoints.length,
    },
    frames,
    checkpoint_candidates: buildCheckpointCandidates(frames),
    checkpoints,
  };
  manifest.artifacts.video_config_template_path = writeVideoConfigTemplate(manifest);
  const manifestPath = path.join(outDir, "manifest.json");
  manifest.evaluation_dataset = metadataFromInputs({
    root,
    split: evalSplit,
    dataset: datasetOptions.dataset,
    sourceId: evalSourceId,
    sourceType: "mp4",
    videoPath,
    manifestPath,
    configPath,
    datasetDir: datasetOptions.datasetDir,
  });
  manifest.evaluation_dataset.content_hash = manifest.video.sha256;
  manifest.artifacts.review_html_path = writeReviewHtml(manifestPath, manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeMarkdownSummary(manifestPath, manifest);
  process.stdout.write(`${JSON.stringify({
    manifestPath,
    summaryPath: path.join(outDir, "manifest-summary.md"),
    configTemplatePath: manifest.artifacts.video_config_template_path,
    reviewHtmlPath: manifest.artifacts.review_html_path,
    duration_ms: manifest.video.duration_ms,
    frames: frames.length,
    checkpointCandidates: manifest.checkpoint_candidates.length,
    checkpoints: manifest.checkpoints.length,
    dataset: manifest.evaluation_dataset.dataset,
    split: manifest.evaluation_dataset.split,
    sourceId: manifest.evaluation_dataset.source_id,
    fixtureClass: manifest.evaluation_dataset.fixture_class,
    outDir,
  }, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : error}\n`);
  process.exit(1);
});
