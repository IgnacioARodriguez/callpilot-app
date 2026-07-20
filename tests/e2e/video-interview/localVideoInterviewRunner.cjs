const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const electronBin = require("electron");
const { loadDotEnv } = require("../../../electron/env.cjs");
const {
  assertManifestAllowedForEvaluation,
  cliDatasetOptions,
} = require("../../eval/datasetPolicy.cjs");
const { readDatasetJsonl } = require("../../eval/datasetCases.cjs");
const { createEvaluationRecord, summarizeEvaluationRecords } = require("../../eval/evaluationContract.cjs");
const { scoreEvaluationRecordForCase } = require("../../eval/scorers/evaluationScoring.cjs");

const root = path.resolve(__dirname, "..", "..", "..");
loadDotEnv(root);

const tmpRoot = path.join(root, ".cache", "local-video-interview");
const analysisRoot = path.join(root, ".cache", "local-video-analysis");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const argValue = (name, fallback = "") => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
};
const readJsonIfPresent = (filePath) => {
  if (!filePath) return {};
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`Video config not found: ${absolute}`);
  return JSON.parse(fs.readFileSync(absolute, "utf8").replace(/^\uFEFF/, ""));
};
const selectedIds = () => (argValue("--checkpoints", process.env.E2E_LOCAL_VIDEO_CHECKPOINTS || ""))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const videoConfigPath = argValue("--config", process.env.CALLPILOT_E2E_VIDEO_CONFIG || "");
const videoConfig = readJsonIfPresent(videoConfigPath);
const executionConfig = videoConfig.execution && typeof videoConfig.execution === "object" ? videoConfig.execution : {};
const datasetOptions = cliDatasetOptions(process.argv);
const runId = argValue("--run-id", `run-${stamp()}`);
const runDir = path.resolve(argValue("--out", path.join(tmpRoot, runId)));
const videoPath = path.resolve(argValue("--video", process.env.CALLPILOT_E2E_VIDEO || videoConfig.video_path || ""));
const manifestArg = argValue("--manifest", process.env.CALLPILOT_E2E_VIDEO_MANIFEST || "");
const debugPort = Number(process.env.CALLPILOT_E2E_DEBUG_PORT || "9369");
const maxRealCalls = Number(process.env.E2E_MAX_REAL_CALLS || "0");
const maxAnswers = Math.max(0, Number(argValue("--max-answers", process.env.E2E_LOCAL_VIDEO_MAX_ANSWERS || "3")));
const audioLookbackMs = Math.max(5000, Number(argValue("--audio-lookback-ms", process.env.E2E_LOCAL_VIDEO_AUDIO_LOOKBACK_MS || executionConfig.default_audio_lookback_ms || "60000")));
const repeatCount = Math.max(1, Number(argValue("--repeat", process.env.E2E_LOCAL_VIDEO_REPEAT || "1")));
const resumeFrom = argValue("--resume-from", process.env.E2E_LOCAL_VIDEO_RESUME_FROM || "");
const analysisOnly = argValue("--analysis-only", process.env.E2E_LOCAL_VIDEO_ANALYSIS_ONLY || "") === "1";
const skipVision = argValue("--skip-vision", process.env.E2E_LOCAL_VIDEO_SKIP_VISION || "") === "1";
const skipStt = argValue("--skip-stt", process.env.E2E_LOCAL_VIDEO_SKIP_STT || "") === "1";
const skipAnswer = argValue("--skip-answer", process.env.E2E_LOCAL_VIDEO_SKIP_ANSWER || "") === "1";
const sttConfig = executionConfig.stt && typeof executionConfig.stt === "object" ? executionConfig.stt : {};
const parseLegacySttRoute = (value) => {
  const normalized = String(value || "").trim();
  if (normalized === "openai-file") return { adapter: "openai", mode: "file-segment" };
  if (normalized === "natively-persistent") return { adapter: "natively", mode: "persistent-stream" };
  if (normalized === "natively-stream") return { adapter: "natively", mode: "stream-per-checkpoint" };
  return { adapter: normalized, mode: "" };
};
const legacySttRoute = parseLegacySttRoute(argValue("--stt-provider", process.env.E2E_LOCAL_VIDEO_STT_PROVIDER || executionConfig.stt_provider || ""));
const sttAdapterValue = argValue("--stt-adapter", process.env.E2E_LOCAL_VIDEO_STT_ADAPTER || sttConfig.adapter || sttConfig.provider || legacySttRoute.adapter || "natively");
const sttModeValue = argValue("--stt-mode", process.env.E2E_LOCAL_VIDEO_STT_MODE || sttConfig.mode || legacySttRoute.mode || "stream-per-checkpoint");
const sttAdapter = ["natively", "openai", "none"].includes(sttAdapterValue) ? sttAdapterValue : sttAdapterValue;
const sttMode = ["stream-per-checkpoint", "persistent-stream", "file-segment", "none"].includes(sttModeValue) ? sttModeValue : sttModeValue;
const transcriptionModelName = argValue("--transcription-model", process.env.CALLPILOT_TRANSCRIPTION_MODEL || process.env.OPENAI_TRANSCRIPTION_MODEL || "");
const sttFrameDelayMs = Math.max(0, Number(argValue(
  "--stt-frame-delay-ms",
  process.env.E2E_LOCAL_VIDEO_STT_FRAME_DELAY_MS || process.env.E2E_LOCAL_VIDEO_NATIVELY_FRAME_DELAY_MS || sttConfig.frame_delay_ms || executionConfig.natively_frame_delay_ms || "100",
)));
const sttDrainMs = Math.max(0, Number(argValue(
  "--stt-drain-ms",
  process.env.E2E_LOCAL_VIDEO_STT_DRAIN_MS || process.env.E2E_LOCAL_VIDEO_NATIVELY_DRAIN_MS || sttConfig.drain_ms || executionConfig.natively_drain_ms || "3000",
)));
const provider = argValue("--provider", process.env.E2E_LOCAL_VIDEO_PROVIDER || "nvidia");
const answerModelName = argValue("--model", process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.1-8b-instruct");
const visionModelName = argValue("--vision-model", process.env.CALLPILOT_NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct");
const preferredLanguageValue = argValue("--preferred-language", process.env.E2E_LOCAL_VIDEO_PREFERRED_LANGUAGE || executionConfig.preferred_language || "auto");
const answerVerbosityValue = argValue("--answer-verbosity", process.env.E2E_LOCAL_VIDEO_ANSWER_VERBOSITY || executionConfig.answer_verbosity || "medium");
const sessionPreferredLanguage = ["english", "spanish", "auto"].includes(preferredLanguageValue) ? preferredLanguageValue : "auto";
const sessionAnswerVerbosity = ["short", "medium", "detailed"].includes(answerVerbosityValue) ? answerVerbosityValue : "medium";

let realCalls = 0;
const canSpend = (calls = 1) => realCalls + calls <= maxRealCalls;
const recordRealCall = () => {
  if (!canSpend(1)) throw new Error(`E2E real call budget exceeded: ${realCalls + 1}/${maxRealCalls}`);
  realCalls += 1;
};
const isExpectedSkip = (error) => /^(stt|vision|answer)_skipped$/.test(String(error || ""));

const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
};

const waitForHttp = async (url, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await fetchJson(url);
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const connectCdp = (webSocketDebuggerUrl) => new Promise((resolve, reject) => {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  socket.onopen = () => resolve({
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((ok, fail) => pending.set(id, { ok, fail }));
    },
    close() {
      socket.close();
    },
  });
  socket.onerror = () => reject(new Error("CDP websocket connection failed"));
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { ok, fail } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) fail(new Error(message.error.message));
    else ok(message.result);
  };
});

const evaluate = async (client, expression, timeoutMs = 300000) => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime evaluation failed";
    throw new Error(detail);
  }
  return result.result.value;
};

const getPageTarget = async (predicate, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    const target = targets.find((item) => item.type === "page" && predicate(item));
    if (target) return target;
    await sleep(250);
  }
  return null;
};

const waitForBridgeExpression = `new Promise((resolve) => {
  const started = performance.now();
  const tick = () => {
    if (window.callpilotDesktop?.startSession && window.callpilotDesktop?.requestAnswer && window.callpilotDesktop?.analyzeScreenshot) {
      resolve(true);
      return;
    }
    if (performance.now() - started > 15000) {
      resolve(false);
      return;
    }
    setTimeout(tick, 100);
  };
  tick();
})`;

const installNativelyEventCapture = async (client, { resetEvents = false } = {}) => evaluate(client, `(() => {
  window.__callpilotLocalVideoNativelyEvents = ${resetEvents ? "[]" : "(window.__callpilotLocalVideoNativelyEvents || [])"};
  window.__callpilotLocalVideoNativelyDisposers?.forEach?.((dispose) => dispose());
  window.__callpilotLocalVideoNativelyDisposers = [
    window.callpilotDesktop.onNativelyStatus((payload) => window.__callpilotLocalVideoNativelyEvents.push({ type: "status", at: Date.now(), payload })),
    window.callpilotDesktop.onNativelyTranscript((payload) => window.__callpilotLocalVideoNativelyEvents.push({ type: "transcript", at: Date.now(), payload }))
  ];
  return true;
})()`);

const loadOrCreateManifest = () => {
  if (manifestArg) {
    const manifestPath = path.resolve(manifestArg);
    ensure(fs.existsSync(manifestPath), `Manifest not found: ${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const datasetMetadata = assertManifestAllowedForEvaluation({
      root,
      manifest,
      manifestPath,
      requested: { ...datasetOptions, configPath: videoConfigPath },
    });
    return { manifestPath, manifest, datasetMetadata };
  }
  ensure(videoPath && fs.existsSync(videoPath), "Set CALLPILOT_E2E_VIDEO or pass --video=C:\\path\\interview.mp4");
  fs.mkdirSync(analysisRoot, { recursive: true });
  const result = spawnSync(process.execPath, [
    path.join(root, "tests", "local-video-analysis", "analyzeLocalVideo.cjs"),
    `--video=${videoPath}`,
    ...(datasetOptions.split === "development" ? [`--out=${path.join(analysisRoot, runId)}`] : []),
    `--split=${datasetOptions.split}`,
    ...(datasetOptions.dataset ? [`--dataset=${datasetOptions.dataset}`] : []),
    ...(datasetOptions.datasetDir ? [`--dataset-dir=${path.resolve(datasetOptions.datasetDir)}`] : []),
    ...(datasetOptions.sourceId ? [`--source-id=${datasetOptions.sourceId}`] : []),
    ...(videoConfigPath ? [`--config=${path.resolve(videoConfigPath)}`] : []),
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
  });
  if (result.status !== 0) {
    throw new Error(`Manifest analysis failed (${result.status}).\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  const manifestPath = parsed.manifestPath;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const datasetMetadata = assertManifestAllowedForEvaluation({
    root,
    manifest,
    manifestPath,
    requested: { ...datasetOptions, configPath: videoConfigPath },
  });
  return { manifestPath, manifest, datasetMetadata };
};

const datasetCasesByCheckpoint = (manifestPath) => {
  const jsonlPath = path.join(path.dirname(manifestPath), "dataset.jsonl");
  if (!fs.existsSync(jsonlPath)) return { jsonlPath: null, casesByCheckpoint: new Map() };
  const cases = readDatasetJsonl(jsonlPath);
  return {
    jsonlPath,
    casesByCheckpoint: new Map(cases.map((item) => [String(item?.input?.checkpoint_id || ""), item])),
  };
};

const selectCheckpoints = (manifest) => {
  let checkpoints = manifest.checkpoints || [];
  const ids = selectedIds();
  if (ids.length > 0) {
    checkpoints = ids.map((id) => {
      const checkpoint = manifest.checkpoints.find((item) => item.id === id);
      if (!checkpoint) throw new Error(`Unknown checkpoint id: ${id}`);
      return checkpoint;
    });
  } else if (Array.isArray(videoConfig.analysis?.force_checkpoints) && videoConfig.analysis.force_checkpoints.length > 0) {
    const forcedIds = videoConfig.analysis.force_checkpoints
      .map((checkpoint) => String(checkpoint?.id || "").trim())
      .filter(Boolean);
    checkpoints = forcedIds.map((id) => {
      const checkpoint = manifest.checkpoints.find((item) => item.id === id);
      if (!checkpoint) throw new Error(`Configured checkpoint id is missing from manifest: ${id}`);
      return checkpoint;
    });
  }
  if (resumeFrom) {
    const index = checkpoints.findIndex((checkpoint) => checkpoint.id === resumeFrom);
    if (index < 0) throw new Error(`Cannot resume; checkpoint not found: ${resumeFrom}`);
    checkpoints = checkpoints.slice(index);
  }
  return checkpoints.slice(0, maxAnswers);
};

const prepareAudioSegments = (manifest, checkpoints) => {
  if (skipStt || checkpoints.length === 0) return [];
  if (maxRealCalls <= 0) {
    return checkpoints.map((checkpoint, index) => ({
      checkpoint_id: checkpoint.id,
      index: index + 1,
      error: `real_call_budget_exhausted:${realCalls}/${maxRealCalls}`,
    }));
  }
  const out = path.join(runDir, "media");
  fs.mkdirSync(out, { recursive: true });
  const probeScript = path.join(root, "tests", "local-video-analysis", "electronVideoProbe.cjs");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronBin, [
    probeScript,
    `--video=${manifest.video.path}`,
    `--out=${out}`,
    "--frame-step-ms=60000",
    "--max-frames=1",
    `--audio-segments-ms=${checkpoints.map((checkpoint) => checkpoint.timestamp_ms).join(",")}`,
    "--audio-prefix=checkpoint-audio",
    `--audio-lookback-ms=${audioLookbackMs}`,
  ], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
  });
  if (result.status !== 0) {
    return checkpoints.map((checkpoint, index) => ({
      checkpoint_id: checkpoint.id,
      index: index + 1,
      error: `audio_extraction_failed: ${result.stderr || result.stdout}`,
    }));
  }
  const parsed = JSON.parse(fs.readFileSync(path.join(out, "probe-result.json"), "utf8"));
  return (parsed.audio || []).map((segment, index) => ({
    ...segment,
    checkpoint_id: checkpoints[index]?.id,
  }));
};

const readPcmWavAsMono16k = (audioPath) => {
  const buffer = fs.readFileSync(audioPath);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Unsupported WAV file: ${audioPath}`);
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    }
    if (id === "data") data = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`Invalid WAV file: ${audioPath}`);
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.sampleRate !== 16000 || fmt.bitsPerSample !== 16) {
    throw new Error(`Expected mono 16 kHz PCM WAV, got ${JSON.stringify(fmt)} in ${audioPath}`);
  }
  return data;
};

const assembleNativelyTranscriptText = (payloads) => {
  const finals = payloads.filter((payload) => payload?.isFinal && String(payload.text || "").trim());
  const source = finals.length > 0 ? finals : payloads.filter((payload) => String(payload?.text || "").trim());
  const seen = new Set();
  const lines = [];
  for (const payload of source) {
    const text = String(payload.text || "").replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    lines.push(text);
  }
  return lines.join(" ").trim();
};

const waitForNativelyConnected = async (client, streamId, timeoutMs = 10000) => evaluate(client, `new Promise((resolve) => {
  const started = Date.now();
  const tick = () => {
    const events = (window.__callpilotLocalVideoNativelyEvents || []).filter((event) => event.payload?.streamId === ${JSON.stringify(streamId)});
    if (events.some((event) => event.type === "status" && event.payload?.status === "connected")) {
      resolve(true);
      return;
    }
    if (events.some((event) => event.type === "status" && event.payload?.status === "error")) {
      resolve(false);
      return;
    }
    if (Date.now() - started > ${JSON.stringify(timeoutMs)}) {
      resolve(false);
      return;
    }
    setTimeout(tick, 100);
  };
  tick();
})`);

const transcribeAudioFileSegment = async (client, segment) => {
  if (!segment?.path || segment.error) return { ok: false, text: "", events: [], error: segment?.error || "missing_audio_segment", adapter: "openai", mode: "file-segment" };
  if (!canSpend(1)) return { ok: false, text: "", events: [], error: `real_call_budget_exhausted:${realCalls}/${maxRealCalls}`, adapter: "openai", mode: "file-segment" };
  recordRealCall();
  const wav = fs.readFileSync(segment.path).toString("base64");
  const startedAt = Date.now();
  const result = await evaluate(client, `window.callpilotDesktop.transcribeAudio({
    arrayBuffer: Uint8Array.from(atob(${JSON.stringify(wav)}), (char) => char.charCodeAt(0)).buffer,
    fileName: ${JSON.stringify(path.basename(segment.path))},
    mimeType: "audio/wav",
    provider: "openai",
    modelName: ${JSON.stringify(transcriptionModelName)},
    apiKey: ${JSON.stringify(process.env.OPENAI_API_KEY || "")}
  })`, 180000);
  const finishedAt = Date.now();
  return {
    ok: Boolean(result?.ok && result?.text),
    text: String(result?.text || "").trim(),
    events: [{
      type: "file_transcription",
      at: finishedAt,
      payload: {
        provider: "openai",
        modelName: result?.modelName || transcriptionModelName || undefined,
        ok: Boolean(result?.ok),
        text: String(result?.text || ""),
        error: result?.error,
        durationMs: finishedAt - startedAt,
      },
    }],
    error: result?.ok ? undefined : result?.error || "file_transcription_failed",
    adapter: "openai",
    mode: "file-segment",
  };
};

let persistentNativelyStreamId = "";

const ensurePersistentNativelyStream = async (client) => {
  if (persistentNativelyStreamId) return persistentNativelyStreamId;
  persistentNativelyStreamId = `local-video-persistent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await evaluate(client, `window.__callpilotLocalVideoNativelyEvents = []`);
  const startResult = await evaluate(client, `window.callpilotDesktop.startNativelyTranscription({
    streamId: ${JSON.stringify(persistentNativelyStreamId)},
    channel: "system",
    sampleRate: 16000,
    language: "auto",
    apiKey: ${JSON.stringify(process.env.NATIVELY_API_KEY || "")}
  })`);
  if (!startResult.ok) throw new Error(startResult.error || "natively_start_failed");
  await waitForNativelyConnected(client, persistentNativelyStreamId);
  return persistentNativelyStreamId;
};

const sendPcmToNatively = async (client, streamId, pcm) => {
  const frameBytes = 3200;
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const frame = pcm.subarray(offset, Math.min(pcm.length, offset + frameBytes)).toString("base64");
    const audioResult = await evaluate(client, `window.callpilotDesktop.sendNativelyAudio({
      streamId: ${JSON.stringify(streamId)},
      arrayBuffer: Uint8Array.from(atob(${JSON.stringify(frame)}), (char) => char.charCodeAt(0)).buffer
    })`);
    if (!audioResult.ok) throw new Error(`natively:audio failed: ${audioResult.error || "unknown"}`);
    if (sttFrameDelayMs > 0) await sleep(sttFrameDelayMs);
  }
};

const transcribeNativelyPersistentSegment = async (client, segment) => {
  if (!segment?.path || segment.error) return { ok: false, text: "", events: [], error: segment?.error || "missing_audio_segment", adapter: "natively", mode: "persistent-stream" };
  if (!canSpend(1)) return { ok: false, text: "", events: [], error: `real_call_budget_exhausted:${realCalls}/${maxRealCalls}`, adapter: "natively", mode: "persistent-stream" };
  recordRealCall();
  const streamId = await ensurePersistentNativelyStream(client);
  const baseline = Date.now();
  const pcm = readPcmWavAsMono16k(segment.path);
  await sendPcmToNatively(client, streamId, pcm);
  if (sttDrainMs > 0) await sleep(sttDrainMs);
  const events = await evaluate(client, `new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const events = (window.__callpilotLocalVideoNativelyEvents || [])
        .filter((event) => event.payload?.streamId === ${JSON.stringify(streamId)} && event.at >= ${JSON.stringify(baseline)});
      const hasTranscript = events.some((event) => event.type === "transcript" && String(event.payload?.text || "").trim());
      if ((hasTranscript && Date.now() - started > 1200) || Date.now() - started > 15000) {
        resolve(events);
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  })`);
  const payloads = events.filter((event) => event.type === "transcript").map((event) => event.payload);
  return { ok: payloads.length > 0, text: assembleNativelyTranscriptText(payloads), events, streamId, adapter: "natively", mode: "persistent-stream" };
};

const streamNativelySegment = async (client, segment) => {
  if (!segment?.path || segment.error) return { ok: false, text: "", events: [], error: segment?.error || "missing_audio_segment" };
  if (!canSpend(1)) return { ok: false, text: "", events: [], error: `real_call_budget_exhausted:${realCalls}/${maxRealCalls}` };
  recordRealCall();
  const streamId = `local-video-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await evaluate(client, `window.__callpilotLocalVideoNativelyEvents = []`);
  const startResult = await evaluate(client, `window.callpilotDesktop.startNativelyTranscription({
    streamId: ${JSON.stringify(streamId)},
    channel: "system",
    sampleRate: 16000,
    language: "auto",
    apiKey: ${JSON.stringify(process.env.NATIVELY_API_KEY || "")}
  })`);
  if (!startResult.ok) return { ok: false, text: "", events: [], error: startResult.error || "natively_start_failed" };
  await waitForNativelyConnected(client, streamId);

  const pcm = readPcmWavAsMono16k(segment.path);
  await sendPcmToNatively(client, streamId, pcm);
  if (sttDrainMs > 0) await sleep(sttDrainMs);
  await evaluate(client, `window.callpilotDesktop.stopNativelyTranscription({ streamId: ${JSON.stringify(streamId)} })`).catch(() => undefined);
  const events = await evaluate(client, `new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const events = (window.__callpilotLocalVideoNativelyEvents || []).filter((event) => event.payload?.streamId === ${JSON.stringify(streamId)});
      const closed = events.some((event) => event.type === "status" && /closed/i.test(event.payload?.status || event.payload?.detail || ""));
      const hasFinal = events.some((event) => event.type === "transcript" && event.payload?.isFinal);
      if ((closed && Date.now() - started > 900) || hasFinal || Date.now() - started > 15000) {
        resolve(events);
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  })`);
  const payloads = events.filter((event) => event.type === "transcript").map((event) => event.payload);
  return { ok: payloads.length > 0, text: assembleNativelyTranscriptText(payloads), events, streamId, adapter: "natively", mode: "stream-per-checkpoint" };
};

const transcribeSegment = async (client, segment) => {
  if (skipStt || sttAdapter === "none" || sttMode === "none") return { ok: false, text: "", events: [], error: "stt_skipped", adapter: "none", mode: "none" };
  if (sttAdapter === "natively") {
    await installNativelyEventCapture(client, { resetEvents: false });
  }
  if (sttAdapter === "openai" && sttMode === "file-segment") return transcribeAudioFileSegment(client, segment);
  if (sttAdapter === "natively" && sttMode === "persistent-stream") return transcribeNativelyPersistentSegment(client, segment);
  if (sttAdapter === "natively" && sttMode === "stream-per-checkpoint") return streamNativelySegment(client, segment);
  return { ok: false, text: "", events: [], error: `unsupported_stt_route:${sttAdapter}:${sttMode}`, adapter: sttAdapter, mode: sttMode };
};

const summarizeSttEvents = (events = []) => events.map((event) => ({
  type: event.type,
  status: event.payload?.status,
  isFinal: event.payload?.isFinal,
  text_preview: String(event.payload?.text || "").slice(0, 180),
  provider: event.payload?.provider,
  ok: event.payload?.ok,
  error: event.payload?.error,
  durationMs: event.payload?.durationMs,
  detail: event.payload?.detail,
})).slice(-24);

const makeSession = ({ checkpoint, transcriptMessages, screenText, answerText, currentTranscriptText }) => {
  const now = Date.now();
  const latestTranscript = String(currentTranscriptText || "").trim();
  const genericManualPrompt = [
    "user_request: The candidate pressed Answer at the current video timestamp.",
    "task: Use only the transcript available up to now and the current visible screen context to give the next useful live-coding interview answer.",
    latestTranscript ? "audio_context: Mixed audio was transcribed for this timestamp and is available in the transcript context." : "audio_context: No fresh audio transcript was captured for this timestamp.",
    latestTranscript ? `fresh_mixed_audio_evidence_not_manual_question: ${latestTranscript.slice(-1200)}` : "",
    "constraint: Do not treat mixed audio as a manual user question unless it clearly contains an interviewer question.",
    "constraint: If the latest audio transcript is not a direct question, rely on the current screen context rather than stale earlier transcript.",
  ].filter(Boolean).join("\n");
  return {
    id: `local-video-${runId}`,
    title: `Local video interview ${runId}`,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    activeMode: "live_coding",
    transcript: {
      messages: transcriptMessages,
      paused: false,
      updatedAt: now,
    },
    screenText: screenText || "",
    companyName: "",
    roleTitle: "Software Engineer",
    resumeText: "",
    starStories: "",
    jobDescription: "Software engineering interview/live coding evaluation. Keep answers concise and grounded in the current transcript and visible screen.",
    notes: [
      "Local MP4 E2E phase: diarization is out of scope.",
      "The audio source is mixed interviewer/candidate audio.",
      `Current video timestamp: ${checkpoint.timestamp_ms} ms.`,
    ].join("\n"),
    profile: "",
    targetUseCase: "live coding interview",
    preferredLanguage: sessionPreferredLanguage,
    codingLanguage: "Python",
    answerVerbosity: sessionAnswerVerbosity,
    modelProvider: provider,
    modelName: answerModelName,
    question: genericManualPrompt,
    answer: answerText || "",
  };
};

const seedSession = async (client, session) => evaluate(client, `new Promise(async (resolve) => {
  window.localStorage.setItem("callpilot_v0_session", ${JSON.stringify(JSON.stringify(session))});
  await window.callpilotDesktop?.saveSettings?.({
    activeMode: "live_coding",
    preferredLanguage: ${JSON.stringify(sessionPreferredLanguage)},
    defaultCodingLanguage: "Python",
    answerVerbosity: ${JSON.stringify(sessionAnswerVerbosity)},
    modelProvider: ${JSON.stringify(provider)},
    modelName: ${JSON.stringify(answerModelName)}
  }).catch(() => undefined);
  resolve(true);
  setTimeout(() => window.location.reload(), 0);
})`);

const waitForAnswer = async (mainClient, overlayClient) => {
  const requestStartedAt = Date.now();
  if (skipAnswer) return {
    skipped: true,
    error: "answer_skipped",
    answerText: "",
    completionStatus: "skipped",
    events: [],
    latency_ms: { trigger_to_first_token: null, trigger_to_complete: null },
  };
  if (!canSpend(1)) return {
    skipped: true,
    error: `real_call_budget_exhausted:${realCalls}/${maxRealCalls}`,
    answerText: "",
    completionStatus: "skipped",
    events: [],
    latency_ms: { trigger_to_first_token: null, trigger_to_complete: null },
  };
  recordRealCall();
  const requestResult = await evaluate(mainClient, `window.callpilotDesktop.requestAnswer()`);
  if (!requestResult.ok) throw new Error(`answer:request failed: ${requestResult.error || "unknown"}`);
  const events = await evaluate(overlayClient, `new Promise((resolve) => {
    const baseline = ${JSON.stringify(requestStartedAt)};
    const started = Date.now();
    const tick = () => {
      const events = (window.__callpilotLocalVideoOverlayEvents || []).filter((event) => event.at >= baseline);
      const terminal = events.find((event) => event.type === "status" && ["completed", "failed", "cancelled"].includes(event.payload?.status));
      if (terminal || Date.now() - started > 180000) {
        resolve(events);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  })`, 190000);
  const textEvents = events.filter((event) => event.type === "status" && String(event.payload?.text || "").trim() && event.payload?.status !== "busy");
  const firstNonBusy = textEvents[0];
  const lastTextEvent = textEvents[textEvents.length - 1];
  const completed = events.find((event) => event.type === "status" && event.payload?.status === "completed");
  const failed = events.find((event) => event.type === "status" && event.payload?.status === "failed");
  const cancelled = events.find((event) => event.type === "status" && event.payload?.status === "cancelled");
  const structured = events.find((event) => event.type === "structured");
  const answerText = String(completed?.payload?.text || structured?.payload?.renderedText || lastTextEvent?.payload?.text || "");
  return {
    requestResult,
    answerText,
    completionStatus: completed ? "completed" : failed ? "failed" : cancelled ? "cancelled" : answerText ? "partial_or_timeout" : "no_answer",
    events,
    latency_ms: {
      trigger_to_first_token: firstNonBusy ? firstNonBusy.at - requestStartedAt : null,
      trigger_to_complete: completed ? completed.at - requestStartedAt : lastTextEvent ? lastTextEvent.at - requestStartedAt : null,
    },
  };
};

const connectOverlayForRun = async (existingClient) => {
  existingClient?.close();
  const overlayTarget = await getPageTarget((target) => String(target.url).includes("#/overlay"), 15000);
  if (!overlayTarget?.webSocketDebuggerUrl) throw new Error("Overlay target did not open.");
  const client = await connectCdp(overlayTarget.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await evaluate(client, waitForBridgeExpression);
  await evaluate(client, `(() => {
    window.__callpilotLocalVideoOverlayEvents = [];
    window.__callpilotLocalVideoOverlayDisposers?.forEach?.((dispose) => dispose());
    window.__callpilotLocalVideoOverlayDisposers = [
      window.callpilotDesktop.onTranscriptMessage((payload) => window.__callpilotLocalVideoOverlayEvents.push({ type: "transcript", at: Date.now(), payload })),
      window.callpilotDesktop.onAnswerStatus((payload) => window.__callpilotLocalVideoOverlayEvents.push({ type: "status", at: Date.now(), payload })),
      window.callpilotDesktop.onStructuredAnswer((payload) => window.__callpilotLocalVideoOverlayEvents.push({ type: "structured", at: Date.now(), payload }))
    ];
    return true;
  })()`);
  return client;
};

const analyzeFrame = async (client, framePath) => {
  if (skipVision) return { ok: false, text: "", skipped: true, error: "vision_skipped" };
  if (!canSpend(1)) return { ok: false, text: "", skipped: true, error: `real_call_budget_exhausted:${realCalls}/${maxRealCalls}` };
  recordRealCall();
  return evaluate(client, `window.callpilotDesktop.analyzeScreenshot({
    path: ${JSON.stringify(framePath)},
    provider: ${JSON.stringify(provider === "nvidia" ? "nvidia" : "openai")},
    modelName: ${JSON.stringify(visionModelName)},
    apiKey: ${JSON.stringify(process.env.OPENAI_API_KEY || "")},
    nvidiaApiKey: ${JSON.stringify(process.env.NVIDIA_API_KEY || process.env.CALLPILOT_NVIDIA_API_KEY || "")}
  })`, 180000);
};

const normalizeEvaluationText = (value) => String(value || "")
  .toLowerCase()
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, "\"")
  .replace(/\bno dot\b/g, "node dot")
  .replace(/\bn o\.?\s*val\b/g, "node val")
  .replace(/\s+/g, " ")
  .trim();

const topicMatches = (text, topic) => {
  const normalized = normalizeEvaluationText(text);
  const expected = normalizeEvaluationText(topic);
  if (!expected) return false;
  if (normalized.includes(expected)) return true;
  const checks = [
    [/node\.?val\s*\+\s*1|node dot val plus 1|node val plus 1|current value plus one|current node'?s value plus one/, "node.val + 1"],
    [/strictly greater|greater than/, "strictly greater"],
    [/lower bound|min(?:imum)? bound|low value/, "lower bound"],
    [/right child|right subtree|node dot right|node\.right/, "right child"],
    [/bst|binary search tree/, "BST invariant"],
    [/bounds?|low and high|min(?:imum)?.*max(?:imum)?/, "bounds"],
    [/recurs(?:ion|ive|ively)|helper function/, "recursion"],
    [/left subtree|left child/, "left subtree less than node"],
    [/right subtree|right child/, "right subtree greater than node"],
    [/two pointers?|odd.*even|even.*odd/, "two pointers"],
    [/relative order|preserve.*order|same order/, "preserve relative order"],
    [/o\(n\)|linear time|one pass/, "O(n) time"],
    [/o\(1\)|constant (?:extra )?space|in place|without extra/, "O(1) extra space"],
    [/pointer rewiring|rewir(?:e|ing)|next pointers?/, "pointer rewiring"],
    [/even head|evenhead|head\.next/, "even head preservation"],
    [/while.*condition|loop condition|while loop/, "loop condition"],
    [/edge cases?|empty list|single node|two nodes|null/, "edge cases"],
    [/manual test|test reasoning|walk through|dry run/, "manual test reasoning"],
    [/invalid subtree|violates.*subtree|global bound/, "invalid subtree case"],
    [/bounds? propagation|propagat(?:e|ing).*bounds?/, "bounds propagation"],
    [/o\(h\)|recursion space|call stack|tree height/, "O(h) recursion space"],
  ];
  return checks.some(([pattern, label]) => normalizeEvaluationText(label) === expected && pattern.test(normalized));
};

const evaluateCheckpoint = ({ checkpoint, stt, vision, answer, cumulativeTranscript }) => {
  const answerText = answer?.answerText || "";
  const screenText = vision?.text || "";
  const expectedTopics = checkpoint.evaluation?.expected_topics || [];
  const forbidden = checkpoint.evaluation?.forbidden_claims || [];
  const normalizedAnswer = answerText.toLowerCase();
  const normalizedCheckpoint = String(checkpoint.checkpoint_id || checkpoint.id || "").toLowerCase();
  const normalizedScreen = screenText.toLowerCase();
  const expectedTopicsPresentInAnswer = expectedTopics.filter((term) => topicMatches(answerText, term));
  const expectedTopicsMissingFromAnswer = expectedTopics.filter((term) => !topicMatches(answerText, term));
  const visionWarnings = [
    /\bjavascript\b/i.test(screenText) && /\bdef\s+\w+\s*\(/i.test(screenText) ? "vision_language_conflict_javascript_vs_python_ocr" : "",
  ].filter(Boolean);
  const staleTopicFlags = [
    normalizedCheckpoint.includes("bst") && /\blinked[- ]?list|lista enlazada|singly[- ]?linked|singly length/i.test(answerText) ? "answered_linked_list_during_bst_checkpoint" : "",
    normalizedCheckpoint.includes("linked-list") && /\bbst\b|binary search tree|arbol binario|árbol binario/i.test(answerText) ? "answered_bst_during_linked_list_checkpoint" : "",
  ].filter(Boolean);
  const onExpectedTopic = expectedTopics.length === 0
    ? staleTopicFlags.length === 0
    : expectedTopicsPresentInAnswer.length > 0 && staleTopicFlags.length === 0;
  return {
    transcription: {
      ok: Boolean(stt?.ok && stt.text),
      transcript_chars: stt?.text?.length || 0,
      mixed_audio_no_diarization: true,
      technical_terms_detected: expectedTopics.filter((term) => cumulativeTranscript.toLowerCase().includes(String(term).toLowerCase())),
      technical_terms_omitted: expectedTopics.filter((term) => !cumulativeTranscript.toLowerCase().includes(String(term).toLowerCase())),
      notes: stt?.error ? [stt.error] : [],
    },
    vision: {
      ok: Boolean(vision?.ok && screenText),
      frame_used: checkpoint.source_frame_path,
      visible_text_chars: screenText.length,
      expected_visual_topics: checkpoint.visual_context_expected || [],
      errors: vision?.error ? [vision.error] : [],
      warnings: visionWarnings,
    },
    context: {
      ok: Boolean(cumulativeTranscript || screenText),
      uses_context_signals: expectedTopics.some((term) => normalizedAnswer.includes(String(term).toLowerCase())),
      cumulative_transcript_chars: cumulativeTranscript.length,
    },
    technical_answer: {
      ok: Boolean(answerText.trim()) && !/^Generation failed:/i.test(answerText) && onExpectedTopic,
      answer_chars: answerText.length,
      too_long_for_live_interview: answerText.split(/\s+/).filter(Boolean).length > 180,
      expected_topics_present: expectedTopicsPresentInAnswer,
      expected_topics_missing: expectedTopicsMissingFromAnswer,
      stale_topic_flags: staleTopicFlags,
      unsupported_forbidden_claims: forbidden.filter((claim) => normalizedAnswer.includes(String(claim).toLowerCase())),
    },
  };
};

const deterministicScoresForCheckpoint = (evaluation) => ({
  transcription_ok: Boolean(evaluation?.transcription?.ok),
  vision_ok: Boolean(evaluation?.vision?.ok),
  context_ok: Boolean(evaluation?.context?.ok),
  technical_answer_ok: Boolean(evaluation?.technical_answer?.ok),
});

const writeMarkdownReport = (reportPath, report) => {
  const mdPath = reportPath.replace(/\.json$/i, ".md");
  const checkpointLines = report.checkpoints.flatMap((checkpoint) => [
    `### ${checkpoint.checkpoint_id}`,
    "",
    `- Timestamp: ${checkpoint.video_timestamp_ms} ms`,
    `- Answer text produced: ${Boolean(checkpoint.answer)}`,
    `- Answer completion status: ${checkpoint.answer_completion_status || "unknown"}`,
    `- Technical rubric ok: ${Boolean(checkpoint.evaluation?.technical_answer?.ok)}`,
    `- Latency complete: ${checkpoint.latency_ms.trigger_to_complete ?? "n/a"} ms`,
    `- Errors: ${checkpoint.errors.length ? checkpoint.errors.join("; ") : "none"}`,
    "",
  ]);
  const lines = [
    "# Local MP4 Interview E2E Report",
    "",
    `Generated: ${report.generated_at}`,
    `Mode: ${report.methodology.mode}`,
    `Manifest: ${report.manifest_path}`,
    `Dataset: ${report.evaluation_dataset?.dataset || "unknown"} (${report.evaluation_dataset?.split || "development"})`,
    `Real calls: ${report.cost_guard.real_calls}/${report.cost_guard.max_real_calls}`,
    "",
    "## Transcription",
    "",
    report.summary.transcription,
    "",
    "## Vision",
    "",
    report.summary.vision,
    "",
    "## Context Retention",
    "",
    report.summary.context_retention,
    "",
    "## Coding/Problem Understanding",
    "",
    report.summary.coding_problem_understanding,
    "",
    "## Answer Quality",
    "",
    report.summary.answer_quality,
    "",
    "## Latency",
    "",
    report.summary.latency,
    "",
    "## Stability",
    "",
    report.summary.stability,
    "",
    "## Limitations",
    "",
    ...report.limitations.map((item) => `- ${item}`),
    "",
    "## Checkpoints",
    "",
    ...checkpointLines,
  ];
  fs.writeFileSync(mdPath, `${lines.join("\n")}\n`, "utf8");
  return mdPath;
};

const main = async () => {
  fs.mkdirSync(runDir, { recursive: true });
  const { manifestPath, manifest, datasetMetadata } = loadOrCreateManifest();
  const datasetCases = datasetCasesByCheckpoint(manifestPath);
  const checkpoints = selectCheckpoints(manifest);
  const audioSegments = prepareAudioSegments(manifest, checkpoints);

  const report = {
    generated_at: new Date().toISOString(),
    runner: "tests/e2e/video-interview/localVideoInterviewRunner.cjs",
    manifest_path: manifestPath,
    evaluation_dataset: datasetMetadata,
    run_dir: runDir,
    methodology: {
      mode: "controlled_local_mp4_e2e",
      video_config_path: videoConfigPath ? path.resolve(videoConfigPath) : null,
      audio_lookback_ms: audioLookbackMs,
      stt: {
        adapter: skipStt ? "none" : sttAdapter,
        mode: skipStt ? "none" : sttMode,
        frame_delay_ms: sttFrameDelayMs,
        drain_ms: sttDrainMs,
      },
      preferred_language: sessionPreferredLanguage,
      answer_verbosity: sessionAnswerVerbosity,
      real_components: [
        "CallPilot Electron app startup",
        "CDP-triggered manual Answer path",
        "Selected CallPilot STT adapter and audio delivery mode when budget allows",
        "CallPilot vision IPC on frame images when budget allows",
        "CallPilot answer generation IPC when budget allows",
        "session trace/report capture"
      ],
      simulated_or_controlled_components: [
        "User timing is based on precomputed checkpoints.",
        "Video frame is supplied as a checkpoint image instead of relying on OS desktop capture.",
        "Audio is extracted into WAV segments and streamed through IPC, not captured from the system loopback.",
        "No diarization: mixed audio is not assigned to interviewer/candidate."
      ],
    },
    video: manifest.video,
    cost_guard: { max_real_calls: maxRealCalls, real_calls: 0 },
    checkpoints: [],
    limitations: [
      "Diarization is out of scope; both voices remain mixed.",
      "The manifest may use full-video visual analysis to choose human Answer moments, but CallPilot receives only data available up to each checkpoint.",
      "Ground-truth transcript and candidate answers are not passed to CallPilot.",
      "This first runner is a controlled media harness, not a full desktop system-audio capture test.",
    ],
    summary: {},
  };

  if (analysisOnly || checkpoints.length === 0) {
    report.summary = {
      transcription: "Not run.",
      vision: "Not run.",
      context_retention: "Not run.",
      coding_problem_understanding: "Not run.",
      answer_quality: "Not run.",
      latency: "Not run.",
      stability: checkpoints.length > 0 ? "Analysis-only mode completed." : "No checkpoints selected.",
    };
    const reportPath = path.join(runDir, "report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const mdPath = writeMarkdownReport(reportPath, report);
    process.stdout.write(`${JSON.stringify({ reportPath, markdownPath: mdPath, checkpoints: checkpoints.length, costGuard: report.cost_guard }, null, 2)}\n`);
    return;
  }

  ensure(fs.existsSync(path.join(root, "dist", "index.html")), "dist/index.html is missing. The npm script should run build first.");
  const userDataDir = path.join(runDir, "user-data");
  fs.mkdirSync(userDataDir, { recursive: true });
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const electron = spawn(electronBin, ["."], {
    cwd: root,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...childEnv,
      CALLPILOT_REMOTE_DEBUG_PORT: String(debugPort),
      CALLPILOT_USER_DATA_DIR: userDataDir,
    },
  });

  let stdout = "";
  let stderr = "";
  electron.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  electron.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  let mainClient;
  let overlayClient;
  try {
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/list`, 30000);
    const mainTarget = await getPageTarget((target) => !String(target.url).includes("#/overlay") && !String(target.url).includes("#/coding"), 30000);
    if (!mainTarget?.webSocketDebuggerUrl) throw new Error(`Could not find Electron main target.\nstdout:${stdout}\nstderr:${stderr}`);
    mainClient = await connectCdp(mainTarget.webSocketDebuggerUrl);
    await mainClient.send("Runtime.enable");
    const hasBridge = await evaluate(mainClient, waitForBridgeExpression);
    if (!hasBridge) throw new Error("Desktop bridge did not become available in renderer");
    await installNativelyEventCapture(mainClient, { resetEvents: true });

    await evaluate(mainClient, `window.callpilotDesktop.startSession({ mode: "live_coding" })`);
    overlayClient = await connectOverlayForRun(overlayClient);

    const transcriptMessages = [];
    let cumulativeTranscript = "";
    let previousAnswer = "";
    for (let pass = 0; pass < repeatCount; pass += 1) {
      for (let index = 0; index < checkpoints.length; index += 1) {
        const checkpoint = checkpoints[index];
        const segment = audioSegments.find((item) => item.checkpoint_id === checkpoint.id);
        const errors = [];
        let stt;
        try {
          stt = await transcribeSegment(mainClient, segment);
        } catch (error) {
          stt = {
            ok: false,
            text: "",
            events: [],
            error: error instanceof Error ? error.message : "stt_failed",
            adapter: skipStt ? "none" : sttAdapter,
            mode: skipStt ? "none" : sttMode,
          };
        }
        if (!stt.ok && stt.error && !isExpectedSkip(stt.error)) errors.push(`stt:${stt.error}`);
        if (stt.text) {
          cumulativeTranscript = [cumulativeTranscript, stt.text].filter(Boolean).join(" ").trim();
          transcriptMessages.push({
            id: `local-video-${checkpoint.id}-${pass + 1}`,
            text: stt.text,
            timestamp: Date.now(),
            source: "stt",
            speaker: "unknown",
          });
        }

        let vision;
        try {
          vision = await analyzeFrame(mainClient, checkpoint.source_frame_path);
        } catch (error) {
          vision = { ok: false, text: "", error: error instanceof Error ? error.message : "vision_failed" };
        }
        if (!vision.ok && vision.error && !isExpectedSkip(vision.error)) errors.push(`vision:${vision.error}`);
        const session = makeSession({
          checkpoint,
          transcriptMessages,
          screenText: vision.text || "",
          answerText: previousAnswer,
          currentTranscriptText: stt.text || "",
        });
        await seedSession(mainClient, session);
        await evaluate(mainClient, waitForBridgeExpression);
        await evaluate(mainClient, `window.callpilotDesktop.startSession({ mode: "live_coding" })`);
        overlayClient = await connectOverlayForRun(overlayClient);
        await sleep(750);
        let answer;
        try {
          answer = await waitForAnswer(mainClient, overlayClient);
        } catch (error) {
          answer = {
            answerText: "",
            completionStatus: "failed",
            events: [],
            error: error instanceof Error ? error.message : "answer_failed",
            latency_ms: { trigger_to_first_token: null, trigger_to_complete: null },
          };
        }
        if (answer.error && !isExpectedSkip(answer.error)) errors.push(`answer:${answer.error}`);
        previousAnswer = answer.answerText || previousAnswer;
        const evaluation = evaluateCheckpoint({ checkpoint, stt, vision, answer, cumulativeTranscript });
        const deterministicScores = deterministicScoresForCheckpoint(evaluation);
        const evaluationRecord = createEvaluationRecord({
          run_id: `${runId}-${checkpoint.id}-${pass + 1}`,
          dataset: datasetMetadata.dataset,
          split: datasetMetadata.split,
          scenario_id: repeatCount > 1 ? `${checkpoint.id}-repeat-${pass + 1}` : checkpoint.id,
          source_id: datasetMetadata.source_id,
          source_type: datasetMetadata.source_type,
          provider,
          model: answerModelName,
          model_parameters: {
            preferred_language: sessionPreferredLanguage,
            answer_verbosity: sessionAnswerVerbosity,
            stt_adapter: stt.adapter || (skipStt ? "none" : sttAdapter),
            stt_mode: stt.mode || (skipStt ? "none" : sttMode),
            vision_model: visionModelName,
          },
          input_snapshot: {
            checkpoint_id: checkpoint.id,
            video_timestamp_ms: checkpoint.timestamp_ms,
            reason_for_answer: checkpoint.reason,
            expected_topics: checkpoint.evaluation?.expected_topics || [],
          },
          available_transcript: cumulativeTranscript,
          available_screen_context: vision.text || "",
          raw_model_output: answer.answerText || "",
          parsed_output: null,
          recovered_output: null,
          final_rendered_output: answer.answerText || "",
          raw_model_pass: Boolean(answer.answerText?.trim()) && !/^Generation failed:/i.test(answer.answerText || ""),
          parsed_pass: false,
          recovered_pass: Boolean(evaluation.technical_answer.ok),
          retry_count: 0,
          repair_events: [],
          deterministic_scores: deterministicScores,
          execution_scores: {},
          judge_scores: null,
          latency: {
            first_usable_ms: answer.latency_ms?.trigger_to_first_token ?? null,
            complete_ms: answer.latency_ms?.trigger_to_complete ?? null,
          },
          failure_class: Object.values(deterministicScores).every(Boolean) ? null : "local_video_deterministic_failure",
          severity: evaluation.technical_answer.ok ? null : "P1",
          artifacts: {
            screen_capture_path: checkpoint.source_frame_path,
            audio_segment_path: segment?.path || null,
            dataset_jsonl_path: datasetCases.jsonlPath,
          },
        });
        const datasetCase = datasetCases.casesByCheckpoint.get(checkpoint.id);
        if (datasetCase) {
          const sharedScores = scoreEvaluationRecordForCase(evaluationRecord, datasetCase);
          evaluationRecord.deterministic_scores = {
            ...evaluationRecord.deterministic_scores,
            ...sharedScores.deterministic_scores,
          };
          evaluationRecord.execution_scores = sharedScores.execution_scores;
          evaluationRecord.judge_scores = sharedScores.judge_scores;
          evaluationRecord.failure_class = Object.values(evaluationRecord.deterministic_scores).every(Boolean)
            && (sharedScores.execution_scores.skipped || sharedScores.execution_scores.ok)
            ? null
            : "local_video_shared_scoring_failure";
          evaluationRecord.severity = evaluationRecord.failure_class ? "P1" : null;
        }

        report.checkpoints.push({
          checkpoint_id: repeatCount > 1 ? `${checkpoint.id}-repeat-${pass + 1}` : checkpoint.id,
          video_timestamp_ms: checkpoint.timestamp_ms,
          reason_for_answer: checkpoint.reason,
          transcript_before_answer: cumulativeTranscript,
          transcript_recent_used_for_answer: stt.text || "",
          stt_adapter: stt.adapter || (skipStt ? "none" : sttAdapter),
          stt_mode: stt.mode || (skipStt ? "none" : sttMode),
          stt_events: summarizeSttEvents(stt.events),
          screen_capture_path: checkpoint.source_frame_path,
          callpilot_screen_analysis: vision,
          answer: answer.answerText || "",
          answer_completion_status: answer.completionStatus || "unknown",
          answer_events: (answer.events || []).map((event) => ({
            type: event.type,
            status: event.payload?.status,
            text_preview: String(event.payload?.text || event.payload?.renderedText || "").slice(0, 240),
            error: event.payload?.error,
          })),
          latency_ms: answer.latency_ms,
          evaluation,
          dataset_case_id: datasetCase?.case_id || null,
          evaluation_record: evaluationRecord,
          errors,
        });
      }
    }
    if (persistentNativelyStreamId) {
      await evaluate(mainClient, `window.callpilotDesktop.stopNativelyTranscription({ streamId: ${JSON.stringify(persistentNativelyStreamId)} })`).catch(() => undefined);
    }
    const endSession = await evaluate(mainClient, `window.callpilotDesktop.endSession()`).catch((error) => ({ ok: false, error: error.message }));
    report.trace = endSession;
  } finally {
    overlayClient?.close();
    mainClient?.close();
    electron.kill();
  }

  report.cost_guard.real_calls = realCalls;
  const completedAnswers = report.checkpoints.filter((item) => item.answer).length;
  const technicallyOk = report.checkpoints.filter((item) => item.evaluation.technical_answer.ok).length;
  const errorCount = report.checkpoints.reduce((sum, item) => sum + item.errors.length, 0);
  const completedLatencies = report.checkpoints
    .map((item) => item.latency_ms.trigger_to_complete)
    .filter((item) => typeof item === "number")
    .sort((a, b) => a - b);
  report.summary = {
    transcription: `${report.checkpoints.filter((item) => item.evaluation.transcription.ok).length}/${report.checkpoints.length} checkpoints produced STT text.`,
    vision: `${report.checkpoints.filter((item) => item.evaluation.vision.ok).length}/${report.checkpoints.length} checkpoints produced screen analysis.`,
    context_retention: `${report.checkpoints.filter((item) => item.evaluation.context.ok).length}/${report.checkpoints.length} checkpoints had transcript or screen context available.`,
    coding_problem_understanding: `${report.checkpoints.filter((item) => item.evaluation.vision.visible_text_chars > 0 || item.evaluation.transcription.transcript_chars > 0).length}/${report.checkpoints.length} checkpoints had observable technical inputs.`,
    answer_quality: `${completedAnswers}/${report.checkpoints.length} checkpoints produced answer text; ${technicallyOk}/${report.checkpoints.length} passed the configured technical rubric.`,
    latency: completedLatencies.length
      ? `Median observed answer latency: ${completedLatencies[Math.floor(completedLatencies.length / 2)]} ms.`
      : "No answer attempts.",
    stability: errorCount === 0 ? "No runner errors recorded." : `${errorCount} runner/provider errors recorded.`,
  };
  report.evaluation_version = report.checkpoints[0]?.evaluation_record?.evaluation_version || "callpilot-eval-result-v1";
  report.evaluation_records = report.checkpoints.map((checkpoint) => checkpoint.evaluation_record).filter(Boolean);
  report.evaluation_summary = summarizeEvaluationRecords(report.evaluation_records);

  const reportPath = path.join(runDir, "report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const mdPath = writeMarkdownReport(reportPath, report);
  process.stdout.write(`${JSON.stringify({
    reportPath,
    markdownPath: mdPath,
    checkpoints: report.checkpoints.length,
    completedAnswers,
    errors: errorCount,
    costGuard: report.cost_guard,
  }, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : error}\n`);
  process.exit(1);
});
