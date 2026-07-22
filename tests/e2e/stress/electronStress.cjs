const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const argValue = (name, fallback = "") => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
};
const runId = argValue("--run-id", `stress-${stamp()}`);
const debugPort = Number(argValue("--debug-port", process.env.CALLPILOT_E2E_DEBUG_PORT || "9481"));
const mockPort = Number(argValue("--mock-port", process.env.CALLPILOT_E2E_MOCK_PORT || "9482"));
const appData = path.join(root, ".cache", "e2e", `appdata-${runId}`);
const outDir = path.join(root, ".cache", "e2e", "stress");
const outPath = path.join(outDir, `${runId}.json`);
const electronBin = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");

fs.mkdirSync(appData, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const elapsed = (startedAt) => Date.now() - startedAt;
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const killProcessTree = (child) => {
  if (!child?.pid || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
};
const json = (response, status, payload) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
};

const mockOpenAI = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    json(response, 404, { error: "not_found" });
    return;
  }
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", async () => {
    const payload = JSON.parse(body || "{}");
    const input = JSON.stringify(payload.input || "");
    await sleep(input.includes("input_image") ? 180 : 160);
    const text = input.includes("input_image")
      ? JSON.stringify({
        visibleTextExact: ["def normalize_name(name):"],
        technicalFocus: "Visible Python CoderPad task: normalize a name.",
        problemStatement: "Normalize a username.",
        visibleCode: "def normalize_name(name):",
        testsOrErrors: "normalize_name(' Ada Lovelace ') == 'ada_lovelace'",
        constraints: [],
        examples: ["Ada Lovelace -> ada_lovelace"],
        inferredTask: "Implement normalize_name.",
        ignoredUi: [],
      })
      : JSON.stringify({
        kind: "coding",
        payload: {
          version: "1",
          answerNeeded: true,
          intent: null,
          responseType: "initial_solution",
          spokenAnswer: "Mantengo la firma visible y normalizo con strip, lower, split y join.",
          keyPoints: [],
          correction: { needed: false, transition: null, correctedClaim: null },
          assumptions: [],
          evidenceRefs: [],
          followUpHint: null,
          problem: {
            title: "Normalize name",
            summary: "Normalize user names from the visible CoderPad prompt.",
            language: "Python",
            functionSignature: "def normalize_name(name):",
            constraints: [],
          },
          solution: {
            approachSteps: ["Trim whitespace.", "Lowercase.", "Split repeated spaces and join with underscores."],
            code: "def normalize_name(name):\n    # Trim and lowercase the input.\n    parts = name.strip().lower().split()\n    # Collapse spaces by joining words with underscores.\n    return \"_\".join(parts)",
            complexity: { time: "O(n)", space: "O(n)", rationale: "We scan and store the normalized words." },
            edgeCases: ["Repeated spaces", "Leading or trailing spaces"],
            invariants: ["Keep the visible function signature."],
          },
          narration: {
            spokenAnswer: "Mantengo la firma y uso split para colapsar cualquier cantidad de espacios.",
            currentStep: "Implementing the baseline.",
          },
          tests: [],
          patch: { kind: "none", code: null },
        },
      });
    json(response, 200, {
      output_text: text,
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
    });
  });
});

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
};
const waitForHttp = async (url, timeoutMs = 25000) => {
  const startedAt = Date.now();
  while (elapsed(startedAt) < timeoutMs) {
    try {
      return await fetchJson(url);
    } catch {}
    await sleep(200);
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
const evaluate = async (client, expression, timeoutMs = 120000) => {
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
const getPageTarget = async (predicate) => {
  const startedAt = Date.now();
  while (elapsed(startedAt) < 25000) {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    const target = targets.find((item) => item.type === "page" && predicate(item));
    if (target) return target;
    await sleep(200);
  }
  return null;
};

const waitForBridgeExpression = `new Promise((resolve) => {
  const started = performance.now();
  const tick = () => {
    if (window.callpilotDesktop?.startSession && window.callpilotDesktop?.recognizeScreenText && window.callpilotDesktop?.requestAnswer && window.callpilotDesktop?.publishTranscriptMessage) {
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

const eventCaptureExpression = `(() => {
  window.__callpilotStressEvents = [];
  window.__callpilotStressDisposers?.forEach?.((dispose) => { try { dispose?.(); } catch {} });
  window.__callpilotStressDisposers = [
    window.callpilotDesktop.onAnswerStatus((payload) => window.__callpilotStressEvents.push({ type: "status", at: Date.now(), payload })),
    window.callpilotDesktop.onStructuredAnswer((payload) => window.__callpilotStressEvents.push({ type: "structured", at: Date.now(), payload })),
    window.callpilotDesktop.onScreenContextPublished((payload) => window.__callpilotStressEvents.push({ type: "screen", at: Date.now(), payload }))
  ];
  return true;
})()`;

const loadTraceSummary = (tracePath) => {
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  const counts = {};
  let maxOcrDurationMs = 0;
  const ocrErrors = [];
  const answerModes = [];
  for (const event of trace.events || []) {
    counts[event.type] = (counts[event.type] || 0) + 1;
    if (event.type === "screen_ocr_completed") {
      maxOcrDurationMs = Math.max(maxOcrDurationMs, Number(event.durationMs || 0));
      if (event.error) ocrErrors.push(event.error);
    }
    if (event.type === "answer_timing" && event.activeMode) answerModes.push(event.activeMode);
  }
  return { status: trace.status, durationMs: trace.durationMs, eventCount: trace.events?.length || 0, counts, maxOcrDurationMs, ocrErrors, answerModes };
};

const run = async () => {
  await new Promise((resolve) => mockOpenAI.listen(mockPort, "127.0.0.1", resolve));
  const childEnv = {
    ...process.env,
    APPDATA: appData,
    CALLPILOT_USER_DATA_DIR: appData,
    CALLPILOT_OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}`,
    CALLPILOT_REMOTE_DEBUG_PORT: String(debugPort),
    OPENAI_API_KEY: "callpilot-stress-key",
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [root], {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  child.stdout.on("data", () => {});

  const report = { runId, appData, debugPort, scenarios: {}, assertions: [], stderr: [] };
  const assertReport = (condition, message) => {
    report.assertions.push({ ok: Boolean(condition), message });
    ensure(condition, message);
  };

  try {
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`);
    const target = await getPageTarget((item) =>
      !String(item.url).includes("#/overlay")
      && !String(item.url).includes("#/coding")
    );
    ensure(target?.webSocketDebuggerUrl, "Could not find main Electron target");
    const client = await connectCdp(target.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    const bridgeReady = await evaluate(client, waitForBridgeExpression);
    assertReport(bridgeReady, "desktop bridge becomes ready");
    await evaluate(client, eventCaptureExpression);
    await evaluate(client, `window.callpilotDesktop.saveSettings({
      activeMode: "live_coding",
      preferredLanguage: "spanish",
      defaultCodingLanguage: "Python",
      modelProvider: "openai",
      modelName: "gpt-5-mini",
      liveTranscriptionProvider: "deepgram",
      liveLatencyPreset: "balanced",
      liveAudioSource: "both"
    })`);
    await evaluate(client, `window.callpilotDesktop.startSession({ mode: "live_coding" })`);
    await sleep(500);
    const codingTarget = await getPageTarget((item) => String(item.url).includes("#/coding"));
    assertReport(codingTarget?.webSocketDebuggerUrl, "coding overlay window opens");
    const codingClient = await connectCdp(codingTarget.webSocketDebuggerUrl);
    await codingClient.send("Runtime.enable");
    await evaluate(codingClient, eventCaptureExpression);

    const normalImagePath = path.join(root, "tests", "fixtures", "coderpad", "string_normalize_username_followup_input", "stage_01_collapse_spaces", "coderpad.png");
    const emptyImagePath = path.join(appData, "empty-screenshot.png");
    fs.writeFileSync(emptyImagePath, Buffer.alloc(0));
    ensure(fs.existsSync(normalImagePath), `Missing fixture ${normalImagePath}`);

    const sequentialStarted = Date.now();
    const sequential = await evaluate(client, `window.callpilotDesktop.recognizeScreenText({
      path: ${JSON.stringify(normalImagePath)},
      language: "auto"
    })`);
    report.scenarios.normalOcr = {
      durationMs: elapsed(sequentialStarted),
      ok: sequential?.ok,
      error: sequential?.error,
      confidence: sequential?.confidence,
      textChars: String(sequential?.text || "").length,
    };
    assertReport(report.scenarios.normalOcr.durationMs < 15000, "normal OCR stays bounded");
    assertReport(sequential?.ok && String(sequential?.text || "").length > 100, "normal OCR returns usable text");

    const emptyStarted = Date.now();
    const empty = await evaluate(client, `window.callpilotDesktop.recognizeScreenText({
      path: ${JSON.stringify(emptyImagePath)},
      language: "auto"
    })`);
    report.scenarios.emptyOcr = {
      durationMs: elapsed(emptyStarted),
      ok: empty?.ok,
      error: empty?.error,
      textChars: String(empty?.text || "").length,
    };
    assertReport(empty?.ok === false && empty?.error === "empty_image_file", "empty screenshots fail with explicit error");
    assertReport(report.scenarios.emptyOcr.durationMs < 1500, "empty screenshots fail fast");

    const parallel = await evaluate(client, `(async () => {
      const started = Date.now();
      let transcriptPublishes = 0;
      const publishLoop = (async () => {
        for (let i = 0; i < 80; i += 1) {
          await window.callpilotDesktop.publishTranscriptMessage({
            id: "stress-transcript-" + Date.now() + "-" + i,
            speaker: i % 2 ? "candidate" : "interviewer",
            text: i % 2 ? "Perfecto, mantengo la firma." : "Implementa normalize_name con la pantalla actual.",
            timestamp: Date.now()
          });
          transcriptPublishes += 1;
          await new Promise((resolve) => setTimeout(resolve, 35));
        }
        return transcriptPublishes;
      })();
      const normalOcr = window.callpilotDesktop.recognizeScreenText({ path: ${JSON.stringify(normalImagePath)}, language: "auto" });
      const emptyOcr = window.callpilotDesktop.recognizeScreenText({ path: ${JSON.stringify(emptyImagePath)}, language: "auto" });
      const answer = new Promise((resolve) => setTimeout(resolve, 150)).then(() => window.callpilotDesktop.requestAnswer({
        audience: "coding",
        questionOverride: "interviewer: Implementa normalize_name segun la pantalla. remote_action: Answer code was pressed."
      }).catch((error) => ({ ok: false, error: String(error?.message || error) })));
      const [publishCount, normal, empty, answerResult] = await Promise.all([publishLoop, normalOcr, emptyOcr, answer]);
      return {
        durationMs: Date.now() - started,
        publishCount,
        normalOcr: { ok: normal?.ok, error: normal?.error, textChars: String(normal?.text || "").length },
        emptyOcr: { ok: empty?.ok, error: empty?.error, textChars: String(empty?.text || "").length },
        answer: answerResult
      };
    })()`, 120000);
    report.scenarios.parallelTranscriptOcrAnswer = parallel;
    assertReport(parallel.durationMs < 15000, "parallel transcript plus OCR plus answer stays bounded");
    assertReport(parallel.publishCount === 80, "all transcript events publish under stress");
    assertReport(parallel.normalOcr.ok === true, "parallel normal OCR succeeds");
    assertReport(parallel.emptyOcr.error === "empty_image_file", "parallel empty OCR fails fast and explicitly");
    assertReport(parallel.answer.ok === true, "parallel answer request is accepted");

    const burst = await evaluate(client, `(async () => {
      const started = Date.now();
      const requests = [];
      for (let i = 0; i < 8; i += 1) {
        requests.push(window.callpilotDesktop.requestAnswer({
          audience: "coding",
          questionOverride: "interviewer: Stress duplicate answer request " + i
        }).catch((error) => ({ ok: false, error: String(error?.message || error) })));
      }
      const results = await Promise.all(requests);
      return { durationMs: Date.now() - started, results };
    })()`, 120000);
    report.scenarios.answerBurst = burst;
    assertReport(burst.durationMs < 12000, "duplicate answer burst returns promptly");
    assertReport(burst.results.some((item) => item?.ok), "at least one answer request is accepted in burst");

    await sleep(1500);
    report.events = {
      main: await evaluate(client, `window.__callpilotStressEvents || []`),
      coding: await evaluate(codingClient, `window.__callpilotStressEvents || []`),
    };
    const traceStatus = await evaluate(client, `window.callpilotDesktop.getSessionTraceStatus()`);
    report.traceStatus = traceStatus;
    assertReport(traceStatus?.path && fs.existsSync(traceStatus.path), "session trace is written");
    report.traceSummary = loadTraceSummary(traceStatus.path);
    assertReport(report.traceSummary.counts.screen_ocr_started === report.traceSummary.counts.screen_ocr_completed, "every OCR start has an OCR completion");
    assertReport(report.traceSummary.maxOcrDurationMs < 25000, "no OCR operation exceeds bounded budget");
    assertReport(report.traceSummary.ocrErrors.includes("empty_image_file"), "trace records empty image failure class");
    assertReport(report.traceSummary.answerModes.includes("live_coding"), "answer path remains in live_coding mode");
    assertReport(report.events.coding.some((event) => event.type === "structured"), "structured answer reaches renderer event bridge");
    codingClient.close();
    client.close();
  } finally {
    report.stderr = stderr.join("").split(/\r?\n/).filter(Boolean).slice(-40);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    killProcessTree(child);
    mockOpenAI.close();
    console.log(outPath);
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
