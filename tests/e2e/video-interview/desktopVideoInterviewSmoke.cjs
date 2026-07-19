const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const electronBin = require("electron");
const { loadDotEnv } = require("../../../electron/env.cjs");

const root = path.resolve(__dirname, "..", "..", "..");
loadDotEnv(root);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
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

const runId = argValue("--run-id", `run-${stamp()}`);
const tmpRoot = path.join(root, ".cache", "desktop-video-interview");
const analysisRoot = path.join(root, ".cache", "local-video-analysis");
const runDir = path.resolve(argValue("--out", path.join(tmpRoot, runId)));
const videoConfigPath = argValue("--config", process.env.CALLPILOT_E2E_VIDEO_CONFIG || "");
const videoConfig = readJsonIfPresent(videoConfigPath);
const executionConfig = videoConfig.execution && typeof videoConfig.execution === "object" ? videoConfig.execution : {};
const videoPath = path.resolve(argValue("--video", process.env.CALLPILOT_E2E_VIDEO || videoConfig.video_path || ""));
const manifestArg = argValue("--manifest", process.env.CALLPILOT_E2E_VIDEO_MANIFEST || "");
const checkpointId = argValue("--checkpoint", process.env.E2E_DESKTOP_VIDEO_CHECKPOINT || process.env.E2E_LOCAL_VIDEO_CHECKPOINTS || "");
const maxRealCalls = Number(process.env.E2E_MAX_REAL_CALLS || "0");
const provider = argValue("--provider", process.env.E2E_DESKTOP_VIDEO_PROVIDER || process.env.E2E_LOCAL_VIDEO_PROVIDER || "nvidia");
const modelName = argValue("--model", process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.1-8b-instruct");
const visionModelName = argValue("--vision-model", process.env.CALLPILOT_NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct");
const liveTranscriptionProvider = argValue("--live-stt-provider", process.env.E2E_DESKTOP_VIDEO_LIVE_STT_PROVIDER || executionConfig.live_transcription_provider || "natively");
const liveAudioSource = argValue("--live-audio-source", process.env.E2E_DESKTOP_VIDEO_LIVE_AUDIO_SOURCE || executionConfig.live_audio_source || "system");
const preferredLanguage = argValue("--preferred-language", process.env.E2E_DESKTOP_VIDEO_PREFERRED_LANGUAGE || executionConfig.preferred_language || "auto");
const answerVerbosity = argValue("--answer-verbosity", process.env.E2E_DESKTOP_VIDEO_ANSWER_VERBOSITY || executionConfig.answer_verbosity || "medium");
const warmupMs = Math.max(0, Number(argValue("--warmup-ms", process.env.E2E_DESKTOP_VIDEO_WARMUP_MS || "60000")));
const startFromBeginning = argValue("--from-beginning", process.env.E2E_DESKTOP_VIDEO_FROM_BEGINNING || "") === "1";
const sttDrainMs = Math.max(0, Number(argValue("--stt-drain-ms", process.env.E2E_DESKTOP_VIDEO_STT_DRAIN_MS || "7000")));
const skipVision = argValue("--skip-vision", process.env.E2E_DESKTOP_VIDEO_SKIP_VISION || "") === "1";
const skipAnswer = argValue("--skip-answer", process.env.E2E_DESKTOP_VIDEO_SKIP_ANSWER || "") === "1";
const debugPort = Number(process.env.CALLPILOT_E2E_DEBUG_PORT || "9379");
const playerDebugPort = Number(process.env.CALLPILOT_DESKTOP_VIDEO_PLAYER_DEBUG_PORT || "9380");

let realCalls = 0;
const plannedRealCalls = () => {
  let calls = 0;
  if (["natively", "openai_realtime"].includes(liveTranscriptionProvider)) calls += 1;
  if (!skipVision) calls += 1;
  if (!skipAnswer) calls += 1;
  return calls;
};
const recordRealCall = () => {
  realCalls += 1;
};
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
const getPageTarget = async (port, predicate, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const target = targets.find((item) => item.type === "page" && predicate(item));
    if (target) return target;
    await sleep(250);
  }
  return null;
};

const waitForBridgeExpression = `new Promise((resolve) => {
  const started = performance.now();
  const tick = () => {
    if (window.callpilotDesktop?.startSession && window.callpilotDesktop?.requestAnswer && window.callpilotDesktop?.captureScreenshot) {
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

const loadOrCreateManifest = () => {
  if (manifestArg) {
    const manifestPath = path.resolve(manifestArg);
    ensure(fs.existsSync(manifestPath), `Manifest not found: ${manifestPath}`);
    return { manifestPath, manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")) };
  }
  ensure(videoPath && fs.existsSync(videoPath), "Set CALLPILOT_E2E_VIDEO or pass --video=C:\\path\\interview.mp4");
  fs.mkdirSync(analysisRoot, { recursive: true });
  const outDir = path.join(analysisRoot, runId);
  const result = spawnSync(process.execPath, [
    path.join(root, "tests", "local-video-analysis", "analyzeLocalVideo.cjs"),
    `--video=${videoPath}`,
    `--out=${outDir}`,
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
  return { manifestPath: parsed.manifestPath, manifest: JSON.parse(fs.readFileSync(parsed.manifestPath, "utf8")) };
};
const selectCheckpoint = (manifest) => {
  const checkpoints = manifest.checkpoints || [];
  if (checkpointId) {
    const ids = checkpointId.split(",").map((item) => item.trim()).filter(Boolean);
    const selected = checkpoints.find((item) => ids.includes(item.id));
    if (!selected) throw new Error(`Unknown checkpoint id for desktop smoke: ${checkpointId}`);
    return selected;
  }
  if (Array.isArray(videoConfig.analysis?.force_checkpoints) && videoConfig.analysis.force_checkpoints.length > 0) {
    const forcedId = String(videoConfig.analysis.force_checkpoints[0]?.id || "").trim();
    const selected = checkpoints.find((item) => item.id === forcedId);
    if (selected) return selected;
  }
  if (!checkpoints[0]) throw new Error("Manifest has no checkpoints for desktop smoke");
  return checkpoints[0];
};

const makeSeedSession = (checkpoint) => {
  const now = Date.now();
  return {
    id: `desktop-video-smoke-${runId}`,
    title: `Desktop video smoke ${runId}`,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    activeMode: "live_coding",
    transcript: { messages: [], paused: false, updatedAt: now },
    screenText: "",
    companyName: "",
    roleTitle: "Software Engineer",
    resumeText: "",
    starStories: "",
    jobDescription: "Software engineering live coding interview. Keep answers concise and grounded in the live transcript and current screen.",
    notes: [
      "Full desktop MP4 smoke: video is played in a real desktop window.",
      "Audio capture uses the app's live desktop audio route.",
      "Diarization remains out of scope; mixed audio should not be treated as speaker-separated.",
      `Planned checkpoint: ${checkpoint.id} at ${checkpoint.timestamp_ms} ms.`,
    ].join("\n"),
    profile: "",
    targetUseCase: "live coding interview",
    preferredLanguage,
    codingLanguage: "Python",
    answerVerbosity,
    modelProvider: provider,
    modelName,
    question: "",
    answer: "",
  };
};

const configureCallPilotUi = async (client, checkpoint) => {
  const session = makeSeedSession(checkpoint);
  await evaluate(client, `new Promise(async (resolve) => {
    window.localStorage.setItem("callpilot_e2e_desktop_smoke", "1");
    window.localStorage.setItem("callpilot_v0_session", ${JSON.stringify(JSON.stringify(session))});
    await window.callpilotDesktop.saveSettings({
      activeMode: "live_coding",
      preferredLanguage: ${JSON.stringify(preferredLanguage)},
      defaultCodingLanguage: "Python",
      answerVerbosity: ${JSON.stringify(answerVerbosity)},
      modelProvider: ${JSON.stringify(provider)},
      modelName: ${JSON.stringify(modelName)},
      liveTranscriptionProvider: ${JSON.stringify(liveTranscriptionProvider)},
      liveAudioSource: ${JSON.stringify(liveAudioSource)},
      liveLatencyPreset: "balanced",
      autoAnswerCooldownMs: 12000,
      autoAnswerMinConfidence: 0.45
    });
    resolve(true);
    setTimeout(() => window.location.reload(), 0);
  })`);
  await sleep(1200);
  await evaluate(client, waitForBridgeExpression);
  await clickSelectorCenter(client, ".setup-card-list .setup-card:nth-child(2)");
  await sleep(350);
  await clickSelectorCenter(client, "nav.tabs button:nth-child(3)");
  await sleep(350);
  await evaluate(client, `(() => {
    const setSelectByLabel = (labelNeedle, value) => {
      const label = [...document.querySelectorAll("label")].find((item) => item.innerText.toLowerCase().includes(labelNeedle.toLowerCase()));
      const select = label?.querySelector("select");
      if (!select) throw new Error("select_not_found:" + labelNeedle);
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    setSelectByLabel("Live transcription", ${JSON.stringify(liveTranscriptionProvider)});
    setSelectByLabel("Listen to", ${JSON.stringify(liveAudioSource)});
    setSelectByLabel("Language", ${JSON.stringify(preferredLanguage)});
    setSelectByLabel("Answer length", ${JSON.stringify(answerVerbosity)});
    return true;
  })`);
  await sleep(350);
  await clickSelectorCenter(client, "nav.tabs button:nth-child(1)");
  await sleep(750);
};

const installCallPilotEventCapture = async (client) => evaluate(client, `(() => {
  window.__callpilotDesktopVideoEvents = [];
  window.__callpilotDesktopVideoDisposers?.forEach?.((dispose) => dispose());
  window.__callpilotDesktopVideoDisposers = [
    window.callpilotDesktop.onNativelyStatus((payload) => window.__callpilotDesktopVideoEvents.push({ type: "natively_status", at: Date.now(), payload })),
    window.callpilotDesktop.onNativelyTranscript((payload) => window.__callpilotDesktopVideoEvents.push({ type: "natively_transcript", at: Date.now(), payload })),
    window.callpilotDesktop.onTranscriptMessage((payload) => window.__callpilotDesktopVideoEvents.push({ type: "transcript", at: Date.now(), payload })),
    window.callpilotDesktop.onAnswerStatus((payload) => window.__callpilotDesktopVideoEvents.push({ type: "answer_status", at: Date.now(), payload })),
    window.callpilotDesktop.onStructuredAnswer((payload) => window.__callpilotDesktopVideoEvents.push({ type: "structured", at: Date.now(), payload }))
  ];
  return true;
})`);

const decodeEvalPayload = (payload) => {
  if (payload && typeof payload === "object") return payload;
  const text = String(payload || "").trim();
  if (!text) return {};
  if (text.startsWith("{") || text.startsWith("[")) return JSON.parse(text);
  return JSON.parse(Buffer.from(text, "base64").toString("utf8"));
};

const clickSelectorCenter = async (client, selector) => {
  await client.send("DOM.enable");
  await client.send("Input.setIgnoreInputEvents", { ignore: false }).catch(() => undefined);
  const documentNode = await client.send("DOM.getDocument", { depth: 3 });
  const query = await client.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector,
  });
  if (!query.nodeId) throw new Error(`selector_not_found:${selector}`);
  const box = await client.send("DOM.getBoxModel", { nodeId: query.nodeId });
  const border = box.model?.border || [];
  const xs = [border[0], border[2], border[4], border[6]].filter((value) => typeof value === "number");
  const ys = [border[1], border[3], border[5], border[7]].filter((value) => typeof value === "number");
  if (xs.length < 4 || ys.length < 4) throw new Error(`selector_box_unavailable:${selector}`);
  const x = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const y = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return { selector, x, y };
};
const clickStartInterview = (client) => clickSelectorCenter(client, ".primary-actions .primary");
const readCallPilotUiState = async (client) => {
  const payload = await evaluate(client, `(() => {
  const readSelect = (labelNeedle) => {
    const label = [...document.querySelectorAll("label")].find((item) => item.innerText.toLowerCase().includes(labelNeedle.toLowerCase()));
    const select = label?.querySelector("select");
    return select ? { value: select.value, text: select.selectedOptions?.[0]?.textContent || "" } : null;
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify({
    title: document.title,
    buttons: [...document.querySelectorAll("button")].map((item) => item.innerText.replace(/\\s+/g, " ").trim()).filter(Boolean).slice(0, 40),
    liveTranscription: readSelect("Live transcription"),
    listenTo: readSelect("Listen to"),
    language: readSelect("Language"),
    answerLength: readSelect("Answer length"),
    statusText: [...document.querySelectorAll(".quick-status span, .health-chip, .helper, .setting-note span")]
      .map((item) => item.textContent.replace(/\\s+/g, " ").trim())
      .filter(Boolean)
      .slice(-40),
  }))));
})`);
  return decodeEvalPayload(payload);
};
const listTargets = async (port) => fetchJson(`http://127.0.0.1:${port}/json/list`).catch((error) => [{ error: error.message }]);
const connectOverlay = async () => {
  const overlayTarget = await getPageTarget(debugPort, (target) => String(target.url).includes("#/overlay"), 60000);
  if (!overlayTarget?.webSocketDebuggerUrl) {
    const targets = await listTargets(debugPort);
    throw new Error(`Overlay target did not open for desktop smoke. Targets: ${JSON.stringify(targets.map((target) => ({ type: target.type, title: target.title, url: target.url, error: target.error })).slice(0, 12))}`);
  }
  const overlayClient = await connectCdp(overlayTarget.webSocketDebuggerUrl);
  await overlayClient.send("Runtime.enable");
  await evaluate(overlayClient, waitForBridgeExpression);
  await installCallPilotEventCapture(overlayClient);
  return overlayClient;
};

const connectPlayer = async () => {
  await waitForHttp(`http://127.0.0.1:${playerDebugPort}/json/list`, 30000);
  const target = await getPageTarget(playerDebugPort, (item) => String(item.title || item.url).includes("CallPilot E2E Video Player"), 30000);
  if (!target?.webSocketDebuggerUrl) throw new Error("Video player target did not open");
  const client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  const ready = await evaluate(client, `new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const status = window.__callpilotVideoControls?.status?.();
      if (status?.ready) {
        resolve(status);
        return;
      }
      if (Date.now() - started > 30000) {
        resolve(status || { ok: false, error: window.__callpilotVideoError || "video_not_ready" });
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  })`);
  return { client, ready };
};
const playerPlay = (client) => evaluate(client, `window.__callpilotVideoControls.play()`);
const playerPause = (client) => evaluate(client, `window.__callpilotVideoControls.pause()`);
const waitForPlayerTime = async (client, targetSeconds, timeoutMs) => evaluate(client, `new Promise((resolve) => {
  const target = ${JSON.stringify(targetSeconds)};
  const started = Date.now();
  const timeoutMs = ${JSON.stringify(timeoutMs)};
  const tick = () => {
    const status = window.__callpilotVideoControls.status();
    if (status.currentTime >= target || Date.now() - started > timeoutMs) {
      resolve({ ...status, reached: status.currentTime >= target, waitedMs: Date.now() - started });
      return;
    }
    setTimeout(tick, 200);
  };
  tick();
})`, timeoutMs + 5000);
const capturePlayerScreenshot = async (client, filePath) => {
  const result = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
  return filePath;
};

const summarizeEvents = (events) => events.map((event) => ({
  type: event.type,
  status: event.payload?.status,
  isFinal: event.payload?.isFinal,
  text_preview: String(event.payload?.text || event.payload?.renderedText || "").replace(/\s+/g, " ").slice(0, 240),
  error: event.payload?.error,
  detail: event.payload?.detail,
})).slice(-80);
const extractTranscript = (events) => {
  const texts = [];
  const seen = new Set();
  for (const event of events) {
    if (!["natively_transcript", "transcript"].includes(event.type)) continue;
    const text = String(event.payload?.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(text);
  }
  return texts.join(" ").trim();
};
const readSavedSession = async (client) => evaluate(client, `(() => {
  try {
    return JSON.parse(window.localStorage.getItem("callpilot_v0_session") || "{}");
  } catch {
    return {};
  }
})`).catch(() => ({}));
const readE2EState = async (client) => evaluate(client, `window.__callpilotE2EGetState?.() || {}`).catch(() => ({}));
const readTraceFile = (tracePath) => {
  if (!tracePath || !fs.existsSync(tracePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tracePath, "utf8"));
  } catch {
    return null;
  }
};
const traceTranscriptText = (trace) => {
  const texts = [];
  const seen = new Set();
  for (const event of trace?.events || []) {
    if (event.type !== "natively_transcript") continue;
    const text = String(event.text?.preview || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(text);
  }
  return texts.join(" ").trim();
};
const traceSttEvents = (trace) => (trace?.events || [])
  .filter((event) => /^natively_/.test(event.type || ""))
  .map((event) => ({
    type: event.type,
    elapsed_ms: event.elapsedMs,
    streamId: event.streamId,
    connected: event.connected,
    queuedAfter: event.queuedAfter,
    text_preview: event.text?.preview,
    text_truncated: event.text?.truncated,
    error: event.error,
  }))
  .slice(-120);
const savedSessionTranscriptText = (session) => (session?.transcript?.messages || [])
  .map((message) => String(message?.text || "").replace(/\s+/g, " ").trim())
  .filter(Boolean)
  .join(" ")
  .trim();

const waitForAnswer = async (mainClient, overlayClient) => {
  const startedAt = Date.now();
  recordRealCall();
  const requestResult = await evaluate(mainClient, `window.callpilotDesktop.requestAnswer()`);
  if (!requestResult.ok) throw new Error(`answer:request failed: ${requestResult.error || "unknown"}`);
  const traceStatus = await evaluate(mainClient, `window.callpilotDesktop.getSessionTraceStatus()`).catch(() => null);
  const tracePath = traceStatus?.path || "";
  const events = await evaluate(overlayClient, `new Promise((resolve) => {
    const baseline = ${JSON.stringify(startedAt)};
    const started = Date.now();
    const tick = () => {
      const events = (window.__callpilotDesktopVideoEvents || []).filter((event) => event.at >= baseline);
      const terminal = events.find((event) => event.type === "answer_status" && ["completed", "failed", "cancelled"].includes(event.payload?.status));
      if (terminal || Date.now() - started > 45000) {
        resolve(events);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  })`, 45000).catch(() => []);
  let trace = readTraceFile(tracePath);
  const traceStarted = Date.now();
  while (!events.some((event) => event.type === "answer_status" && ["completed", "failed", "cancelled"].includes(event.payload?.status)) && Date.now() - traceStarted < 180000) {
    trace = readTraceFile(tracePath);
    const terminalTrace = (trace?.events || []).find((event) => event.type === "answer_status_published" && ["completed", "failed", "cancelled"].includes(event.status));
    if (terminalTrace) break;
    await sleep(300);
  }
  const completed = events.find((event) => event.type === "answer_status" && event.payload?.status === "completed");
  const failed = events.find((event) => event.type === "answer_status" && event.payload?.status === "failed");
  const structured = events.find((event) => event.type === "structured");
  const textEvents = events.filter((event) => event.type === "answer_status" && String(event.payload?.text || "").trim() && event.payload?.status !== "busy");
  const traceCompleted = (trace?.events || []).find((event) => event.type === "answer_status_published" && event.status === "completed");
  const traceFailed = (trace?.events || []).find((event) => event.type === "answer_status_published" && event.status === "failed");
  const firstText = textEvents[0];
  const lastText = textEvents[textEvents.length - 1];
  const savedSession = await readSavedSession(mainClient);
  const e2eState = await readE2EState(mainClient);
  const liveAnswer = String(e2eState?.answer || "").trim();
  const savedAnswer = String(savedSession?.answer || "").trim();
  const traceManual = (trace?.events || []).find((event) => event.type === "manual_answer_requested");
  return {
    requestResult,
    events,
    traceEvents: trace?.events || [],
    answerText: String(completed?.payload?.text || structured?.payload?.renderedText || lastText?.payload?.text || liveAnswer || savedAnswer || traceCompleted?.renderedText?.preview || ""),
    completionStatus: completed || traceCompleted ? "completed" : failed || traceFailed ? "failed" : lastText ? "partial_or_timeout" : "no_answer",
    latency_ms: {
      trigger_to_first_token: firstText ? firstText.at - startedAt : null,
      trigger_to_complete: completed
        ? completed.at - startedAt
        : traceCompleted && typeof traceManual?.elapsedMs === "number"
          ? traceCompleted.elapsedMs - traceManual.elapsedMs
          : lastText ? lastText.at - startedAt : null,
    },
  };
};
const analyzeScreen = async (mainClient, capturePath) => {
  if (skipVision) return { ok: false, skipped: true, error: "vision_skipped", text: "" };
  recordRealCall();
  return evaluate(mainClient, `window.callpilotDesktop.analyzeScreenshot({
    path: ${JSON.stringify(capturePath)},
    provider: ${JSON.stringify(provider === "nvidia" ? "nvidia" : "openai")},
    modelName: ${JSON.stringify(visionModelName)},
    apiKey: ${JSON.stringify(process.env.OPENAI_API_KEY || "")},
    nvidiaApiKey: ${JSON.stringify(process.env.NVIDIA_API_KEY || process.env.CALLPILOT_NVIDIA_API_KEY || "")}
  })`, 180000);
};

const writeMarkdownReport = (reportPath, report) => {
  const mdPath = reportPath.replace(/\.json$/i, ".md");
  const checkpoint = report.checkpoint || {};
  const lines = [
    "# Desktop MP4 Interview Smoke Report",
    "",
    `Generated: ${report.generated_at}`,
    `Mode: ${report.methodology.mode}`,
    `Manifest: ${report.manifest_path}`,
    `Real calls: ${report.cost_guard.real_calls}/${report.cost_guard.max_real_calls}`,
    "",
    "## Summary",
    "",
    `- Player opened: ${Boolean(report.summary.player_opened)}`,
    `- UI session started: ${Boolean(report.summary.ui_session_started)}`,
    `- Live STT connected: ${Boolean(report.summary.live_stt_connected)}`,
    `- Transcript produced: ${Boolean(report.summary.transcript_produced)}`,
    `- Screen captured: ${Boolean(report.summary.screen_captured)}`,
    `- Vision analysis produced: ${Boolean(report.summary.vision_produced)}`,
    `- Answer produced: ${Boolean(report.summary.answer_produced)}`,
    `- Runner errors: ${report.summary.error_count}`,
    "",
    "## Checkpoint",
    "",
    `- ID: ${checkpoint.checkpoint_id || ""}`,
    `- Timestamp: ${checkpoint.video_timestamp_ms ?? ""} ms`,
    `- Playback start: ${checkpoint.playback_start_ms ?? ""} ms`,
    `- Reason: ${checkpoint.reason_for_answer || ""}`,
    `- Answer status: ${checkpoint.answer_completion_status || ""}`,
    `- Complete latency: ${checkpoint.latency_ms?.trigger_to_complete ?? "n/a"} ms`,
    "",
    "## Limitations",
    "",
    ...report.limitations.map((item) => `- ${item}`),
    "",
  ];
  fs.writeFileSync(mdPath, `${lines.join("\n")}\n`, "utf8");
  return mdPath;
};
const writeBlockedReport = (manifestPath, manifest, checkpoint, reason) => {
  fs.mkdirSync(runDir, { recursive: true });
  const report = {
    generated_at: new Date().toISOString(),
    runner: "tests/e2e/video-interview/desktopVideoInterviewSmoke.cjs",
    manifest_path: manifestPath,
    run_dir: runDir,
    methodology: {
      mode: "desktop_mp4_smoke_blocked",
      planned_live_transcription_provider: liveTranscriptionProvider,
      planned_live_audio_source: liveAudioSource,
    },
    video: manifest.video,
    checkpoint: checkpoint ? { checkpoint_id: checkpoint.id, video_timestamp_ms: checkpoint.timestamp_ms } : null,
    cost_guard: { max_real_calls: maxRealCalls, planned_real_calls: plannedRealCalls(), real_calls: 0 },
    summary: { blocked: true, reason, error_count: 1 },
    limitations: ["No provider calls were made because the configured real-call budget was insufficient."],
    errors: [reason],
  };
  const reportPath = path.join(runDir, "report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownPath = writeMarkdownReport(reportPath, report);
  process.stdout.write(`${JSON.stringify({ reportPath, markdownPath, blocked: true, reason }, null, 2)}\n`);
};

const main = async () => {
  fs.mkdirSync(runDir, { recursive: true });
  const { manifestPath, manifest } = loadOrCreateManifest();
  const checkpoint = selectCheckpoint(manifest);
  const requiredCalls = plannedRealCalls();
  if (maxRealCalls < requiredCalls) {
    writeBlockedReport(manifestPath, manifest, checkpoint, `real_call_budget_too_low:${maxRealCalls}/${requiredCalls}`);
    return;
  }
  ensure(fs.existsSync(path.join(root, "dist", "index.html")), "dist/index.html is missing. The npm script should run build first.");

  const playbackStartMs = startFromBeginning ? 0 : Math.max(0, Number(checkpoint.timestamp_ms || 0) - warmupMs);
  const report = {
    generated_at: new Date().toISOString(),
    runner: "tests/e2e/video-interview/desktopVideoInterviewSmoke.cjs",
    manifest_path: manifestPath,
    run_dir: runDir,
    methodology: {
      mode: "desktop_mp4_smoke",
      video_config_path: videoConfigPath ? path.resolve(videoConfigPath) : null,
      live_transcription_provider: liveTranscriptionProvider,
      live_audio_source: liveAudioSource,
      playback_start_ms: playbackStartMs,
      checkpoint_from_beginning: startFromBeginning,
      real_components: [
        "CallPilot Electron app startup",
        "CallPilot UI Start interview overlay button",
        "Electron getDisplayMedia desktop/system-audio capture route",
        "Real MP4 playback in a visible desktop window",
        "CallPilot screen:capture desktop screenshot",
        "CallPilot vision IPC on the captured screenshot",
        "CallPilot answer:request manual Answer path",
      ],
      controlled_components: [
        "The runner chooses a reviewed checkpoint timestamp and pauses the video there.",
        "The runner may start playback shortly before the checkpoint for smoke-test speed.",
      ],
    },
    video: manifest.video,
    cost_guard: { max_real_calls: maxRealCalls, planned_real_calls: requiredCalls, real_calls: 0 },
    checkpoint: {
      checkpoint_id: checkpoint.id,
      video_timestamp_ms: checkpoint.timestamp_ms,
      playback_start_ms: playbackStartMs,
      reason_for_answer: checkpoint.reason,
      player_screenshot_path: null,
      screen_capture_path: null,
      transcript_before_answer: "",
      callpilot_screen_analysis: null,
      answer: "",
      answer_completion_status: "not_run",
      answer_events: [],
      latency_ms: { trigger_to_first_token: null, trigger_to_complete: null },
      errors: [],
    },
    summary: {},
    diagnostics: {},
    limitations: [
      "This is a one-checkpoint desktop smoke, not the full multi-checkpoint desktop suite.",
      "Diarization remains out of scope; mixed video audio is not speaker-separated.",
      "The runner chooses the Answer timestamp; it does not claim autonomous Answer detection.",
      "If playback starts near the checkpoint, long-range transcript context before playback_start_ms is intentionally absent.",
    ],
    errors: [],
  };

  const userDataDir = path.join(runDir, "user-data");
  fs.mkdirSync(userDataDir, { recursive: true });
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const callpilot = spawn(electronBin, ["."], {
    cwd: root,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...childEnv, CALLPILOT_REMOTE_DEBUG_PORT: String(debugPort), CALLPILOT_USER_DATA_DIR: userDataDir },
  });
  const player = spawn(electronBin, [
    path.join(root, "tests", "e2e", "video-interview", "desktopVideoPlayer.cjs"),
    `--video=${videoPath}`,
    `--debug-port=${playerDebugPort}`,
    `--start-ms=${playbackStartMs}`,
  ], { cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"], env: childEnv });

  let callpilotStdout = "";
  let callpilotStderr = "";
  let playerStdout = "";
  let playerStderr = "";
  callpilot.stdout.on("data", (chunk) => { callpilotStdout += chunk.toString(); });
  callpilot.stderr.on("data", (chunk) => { callpilotStderr += chunk.toString(); });
  player.stdout.on("data", (chunk) => { playerStdout += chunk.toString(); });
  player.stderr.on("data", (chunk) => { playerStderr += chunk.toString(); });

  let mainClient;
  let overlayClient;
  let playerClient;
  try {
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/list`, 30000);
    const mainTarget = await getPageTarget(debugPort, (target) => !String(target.url).includes("#/overlay") && !String(target.url).includes("#/coding"), 30000);
    if (!mainTarget?.webSocketDebuggerUrl) throw new Error(`Could not find Electron main target.\nstdout:${callpilotStdout.slice(-1000)}\nstderr:${callpilotStderr.slice(-1000)}`);
    mainClient = await connectCdp(mainTarget.webSocketDebuggerUrl);
    await mainClient.send("Runtime.enable");
    const hasBridge = await evaluate(mainClient, waitForBridgeExpression);
    if (!hasBridge) throw new Error("Desktop bridge did not become available in renderer");
    await configureCallPilotUi(mainClient, checkpoint);
    report.diagnostics.share_safe = await evaluate(mainClient, `window.callpilotDesktop.applyShareSafe()`).catch((error) => ({ error: error.message }));
    await installCallPilotEventCapture(mainClient);
    report.diagnostics.ui_after_config = await readCallPilotUiState(mainClient).catch((error) => ({ error: error.message }));

    const playerConnection = await connectPlayer();
    playerClient = playerConnection.client;
    report.summary.player_opened = Boolean(playerConnection.ready?.ready);
    if (!playerConnection.ready?.ready) report.checkpoint.errors.push(`player_not_ready:${playerConnection.ready?.error || "unknown"}`);

    await playerPlay(playerClient).catch((error) => {
      report.checkpoint.errors.push(`player_play:${error.message}`);
    });
    report.diagnostics.start_click = await clickStartInterview(mainClient);
    report.summary.ui_session_started = true;
    report.diagnostics.ui_after_start_click = await readCallPilotUiState(mainClient).catch((error) => ({ error: error.message }));
    report.diagnostics.trace_after_start_click = await evaluate(mainClient, `window.callpilotDesktop.getSessionTraceStatus()`).catch((error) => ({ error: error.message }));
    report.diagnostics.targets_after_start_click = await listTargets(debugPort);
    overlayClient = await connectOverlay();
    await sleep(1500);

    if (["natively", "openai_realtime"].includes(liveTranscriptionProvider)) recordRealCall();
    const targetSeconds = Number(checkpoint.timestamp_ms || 0) / 1000;
    const waitMs = Math.max(5000, (Number(checkpoint.timestamp_ms || 0) - playbackStartMs) + 15000);
    const reached = await waitForPlayerTime(playerClient, targetSeconds, waitMs);
    if (!reached.reached) report.checkpoint.errors.push(`player_checkpoint_not_reached:${reached.currentTime}`);
    await playerPause(playerClient);
    await sleep(sttDrainMs);

    const playerShot = path.join(runDir, `player-${checkpoint.id}.png`);
    report.checkpoint.player_screenshot_path = await capturePlayerScreenshot(playerClient, playerShot).catch((error) => {
      report.checkpoint.errors.push(`player_screenshot:${error.message}`);
      return null;
    });

    const screenCapture = await evaluate(mainClient, `window.callpilotDesktop.captureScreenshot()`);
    if (screenCapture?.ok && screenCapture.path) {
      report.checkpoint.screen_capture_path = screenCapture.path;
      report.summary.screen_captured = true;
      try {
        report.checkpoint.callpilot_screen_analysis = await analyzeScreen(mainClient, screenCapture.path);
        if (report.checkpoint.callpilot_screen_analysis?.ok && report.checkpoint.callpilot_screen_analysis?.text) {
          await evaluate(mainClient, `window.__callpilotE2ESetScreenText?.(${JSON.stringify(`${report.checkpoint.callpilot_screen_analysis.text}\n\nScreenshot: ${screenCapture.path}`)})`).catch((error) => {
            report.checkpoint.errors.push(`screen_context_seed:${error.message}`);
          });
          await sleep(500);
        }
      } catch (error) {
        report.checkpoint.callpilot_screen_analysis = { ok: false, text: "", error: error instanceof Error ? error.message : "vision_failed" };
        report.checkpoint.errors.push(`vision:${report.checkpoint.callpilot_screen_analysis.error}`);
      }
    } else {
      report.summary.screen_captured = false;
      report.checkpoint.errors.push(`screen_capture:${screenCapture?.error || "failed"}`);
    }

    const mainEventsBeforeAnswer = await evaluate(mainClient, `window.__callpilotDesktopVideoEvents || []`);
    const overlayEventsBeforeAnswer = overlayClient ? await evaluate(overlayClient, `window.__callpilotDesktopVideoEvents || []`).catch(() => []) : [];
    const allBeforeAnswer = [...mainEventsBeforeAnswer, ...overlayEventsBeforeAnswer].sort((a, b) => a.at - b.at);
    const traceStatusBeforeAnswer = await evaluate(mainClient, `window.callpilotDesktop.getSessionTraceStatus()`).catch(() => null);
    const traceBeforeAnswer = readTraceFile(traceStatusBeforeAnswer?.path);
    const savedSessionBeforeAnswer = await readSavedSession(mainClient);
    const e2eStateBeforeAnswer = await readE2EState(mainClient);
    report.checkpoint.transcript_before_answer = extractTranscript(allBeforeAnswer)
      || String(e2eStateBeforeAnswer?.transcriptText || "").trim()
      || savedSessionTranscriptText(savedSessionBeforeAnswer)
      || traceTranscriptText(traceBeforeAnswer);
    report.summary.live_stt_connected = allBeforeAnswer.some((event) => event.type === "natively_status" && event.payload?.status === "connected")
      || (traceBeforeAnswer?.events || []).some((event) => event.type === "natively_audio_chunk" && event.connected);
    report.summary.transcript_produced = Boolean(report.checkpoint.transcript_before_answer);
    report.checkpoint.stt_events = summarizeEvents(allBeforeAnswer.filter((event) => event.type.startsWith("natively") || event.type === "transcript"));
    if (report.checkpoint.stt_events.length === 0) report.checkpoint.stt_events = traceSttEvents(traceBeforeAnswer);
    report.summary.vision_produced = Boolean(report.checkpoint.callpilot_screen_analysis?.ok && report.checkpoint.callpilot_screen_analysis?.text);

    if (!skipAnswer) {
      try {
        const answer = await waitForAnswer(mainClient, overlayClient);
        report.checkpoint.answer = answer.answerText || "";
        report.checkpoint.answer_completion_status = answer.completionStatus;
        report.checkpoint.answer_events = summarizeEvents(answer.events || []);
        if (report.checkpoint.answer_events.length === 0) {
          report.checkpoint.answer_events = (answer.traceEvents || [])
            .filter((event) => /^answer_|manual_answer/.test(event.type || ""))
            .map((event) => ({
              type: event.type,
              elapsed_ms: event.elapsedMs,
              stage: event.stage,
              status: event.status,
              text_preview: event.renderedText?.preview || event.text?.preview,
              text_truncated: event.renderedText?.truncated || event.text?.truncated,
              error: event.error,
            }))
            .slice(-80);
        }
        report.checkpoint.latency_ms = answer.latency_ms;
      } catch (error) {
        report.checkpoint.answer_completion_status = "failed";
        report.checkpoint.errors.push(`answer:${error instanceof Error ? error.message : "answer_failed"}`);
      }
    } else {
      report.checkpoint.answer_completion_status = "skipped";
    }

    const endSession = await evaluate(mainClient, `window.callpilotDesktop.endSession()`).catch((error) => ({ ok: false, error: error.message }));
    report.trace = endSession;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.errors.push(message);
    report.checkpoint.errors.push(message);
  } finally {
    overlayClient?.close();
    mainClient?.close();
    playerClient?.close();
    callpilot.kill();
    player.kill();
  }

  report.cost_guard.real_calls = realCalls;
  report.summary.answer_produced = Boolean(report.checkpoint.answer);
  report.summary.error_count = report.errors.length + report.checkpoint.errors.length;
  report.summary.stability = report.summary.error_count === 0 ? "No runner errors recorded." : `${report.summary.error_count} runner/provider errors recorded.`;
  report.process_output = {
    callpilot_stdout_tail: callpilotStdout.slice(-2000),
    callpilot_stderr_tail: callpilotStderr.slice(-2000),
    player_stdout_tail: playerStdout.slice(-1000),
    player_stderr_tail: playerStderr.slice(-1000),
  };

  const reportPath = path.join(runDir, "report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownPath = writeMarkdownReport(reportPath, report);
  process.stdout.write(`${JSON.stringify({
    reportPath,
    markdownPath,
    checkpoint: report.checkpoint.checkpoint_id,
    answerProduced: report.summary.answer_produced,
    transcriptProduced: report.summary.transcript_produced,
    screenCaptured: report.summary.screen_captured,
    errors: report.summary.error_count,
    costGuard: report.cost_guard,
  }, null, 2)}\n`);
};

main().catch((error) => {
  fs.mkdirSync(runDir, { recursive: true });
  const reportPath = path.join(runDir, "report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify({
    generated_at: new Date().toISOString(),
    runner: "tests/e2e/video-interview/desktopVideoInterviewSmoke.cjs",
    run_dir: runDir,
    fatal: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`, "utf8");
  console.error(error);
  process.exit(1);
});
