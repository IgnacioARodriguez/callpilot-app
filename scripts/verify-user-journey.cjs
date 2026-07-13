const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const electronBin = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");
const debugPort = Number(process.env.CALLPILOT_E2E_DEBUG_PORT || 9339);
const mockPort = Number(process.env.CALLPILOT_E2E_MOCK_PORT || 9340);
const thresholds = {
  firstDetailMs: 1500,
  answerCompleteMs: 2500,
  transcriptionMs: 1200,
  visionMs: 1600,
  overlayOpenMs: 1200,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const json = (response, payload) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
};

const createOutputPayload = (text) => ({
  output_text: text,
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
});

const mockOpenAI = http.createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/v1/audio/transcriptions") {
    await sleep(120);
    json(response, { text: "me interesaria que me cuentes tu approach aca" });
    return;
  }

  if (request.method === "POST" && request.url === "/v1/responses") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      const payload = JSON.parse(body || "{}");
      if (payload.stream) {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        await sleep(90);
        response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Start with the tradeoff: " })}\n\n`);
        await sleep(90);
        response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "consistency mattered more than flexibility." })}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }

      await sleep(payload.text?.format?.type === "json_schema" ? 160 : 180);
      if (payload.text?.format?.type === "json_schema") {
        json(response, createOutputPayload(JSON.stringify({
          kind: "interview",
          payload: {
            version: "1",
            answerNeeded: true,
            intent: "technical_qa",
            spokenAnswer: "I chose SQL because consistency was the product risk.",
            keyPoints: ["SQL", "ACID", "audits"],
            correction: { needed: false, transition: null, correctedClaim: null },
            assumptions: [],
            evidenceRefs: [],
            followUpHint: null,
          },
        })));
        return;
      }

      json(response, createOutputPayload(JSON.stringify({
        problemTitle: "Two Sum",
        functionSignature: "def two_sum(nums: list[int], target: int) -> list[int]:",
        language: "Python",
        examples: [{ input: "nums = [2,7,11,15], target = 9", output: "[0,1]" }],
        constraints: ["2 <= nums.length <= 10^4"],
        solution: {
          problemDetected: "Two Sum",
          approach: "Use a hash map from value to index.",
          code: "def two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen: return [seen[target-n], i]\n        seen[n] = i",
          complexity: "O(n) time, O(n) space",
          edgeCases: ["duplicate values"],
          whatToSayOutLoud: "I will trade memory for one-pass lookup speed.",
        },
      })));
    });
    return;
  }

  response.writeHead(404);
  response.end("not found");
});

const waitForHttp = async (url, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const cdp = async (targetUrl) => {
  const socket = new WebSocket(targetUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
};

const evaluate = async (client, expression) => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result.result.value;
};

const getPageTarget = async (predicate) => {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  return targets.find((target) => target.type === "page" && predicate(target));
};

const pngPath = path.join(os.tmpdir(), `callpilot-e2e-${Date.now()}.png`);
fs.writeFileSync(pngPath, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
));

const run = async () => {
  await new Promise((resolve) => mockOpenAI.listen(mockPort, "127.0.0.1", resolve));
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const electron = spawn(electronBin, ["."], {
    cwd: root,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...childEnv,
      CALLPILOT_OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}`,
      CALLPILOT_REMOTE_DEBUG_PORT: String(debugPort),
      OPENAI_API_KEY: "callpilot-e2e-key",
    },
  });

  let stderr = "";
  let stdout = "";
  electron.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  electron.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  electron.on("exit", (code) => {
    if (code !== null && code !== 0 && !process.exitCode) {
      process.exitCode = code;
    }
  });

  try {
    let targetsResponse;
    try {
      targetsResponse = await waitForHttp(`http://127.0.0.1:${debugPort}/json/list`, 25000);
    } catch (error) {
      throw new Error(`${error.message}\nElectron stdout:\n${stdout}\nElectron stderr:\n${stderr}`);
    }
    const targets = await targetsResponse.json();
    const page = targets.find((target) => target.type === "page" && !String(target.url).includes("#/overlay")) ?? targets[0];
    if (!page?.webSocketDebuggerUrl) throw new Error("Could not find Electron renderer target");

    const client = await cdp(page.webSocketDebuggerUrl);
    await client.send("Runtime.enable");

    const setupUi = await evaluate(client, `new Promise((resolve) => {
      const read = () => ({
        hasRoot: Boolean(document.querySelector("#root")),
        hasStartSession: [...document.querySelectorAll("button")].some((button) => /start (session|interview overlay)/i.test(button.textContent || "")),
        hasSetupCards: /technical interview/i.test(document.body?.innerText || "")
          && /live coding/i.test(document.body?.innerText || ""),
        hasContextFields: /context fields/i.test(document.body?.innerText || ""),
        bodyTextLength: (document.body?.innerText || "").length
      });
      const started = performance.now();
      const tick = () => {
        const snapshot = read();
        if (snapshot.hasStartSession || performance.now() - started > 5000) {
          resolve(snapshot);
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    })`);

    const metrics = await evaluate(client, `new Promise(async (resolve) => {
      const prompt = {
        system: "You are CallPilot test.",
        user: "<resume>Built payments reconciliation with PostgreSQL.</resume>\\n<user_input>Why SQL?</user_input>",
        debug: { modeId: "technical_qa", includedSections: [], omittedSections: [] }
      };
      const events = [];
      const t0 = performance.now();
      const offDetail = window.callpilotDesktop.onAnswerDetailChunk((chunk) => {
        events.push({ type: "detail", at: performance.now() - t0, chunk });
      });
      const result = await window.callpilotDesktop.generateAnswer({
        provider: "openai",
        modelName: "mock-openai-e2e",
        apiKey: "callpilot-e2e-key",
        prompt
      });
      offDetail();
      resolve({ result, events, totalMs: performance.now() - t0 });
    })`);

    const transcript = await evaluate(client, `new Promise(async (resolve) => {
      const t0 = performance.now();
      const result = await window.callpilotDesktop.transcribeAudio({
        arrayBuffer: new Uint8Array([1,2,3,4]).buffer,
        fileName: "clip.webm",
        mimeType: "audio/webm",
        modelName: "mock-transcribe",
        apiKey: "callpilot-e2e-key"
      });
      resolve({ result, totalMs: performance.now() - t0 });
    })`);

    const vision = await evaluate(client, `new Promise(async (resolve) => {
      const t0 = performance.now();
      const result = await window.callpilotDesktop.analyzeScreenshot({
        path: ${JSON.stringify(pngPath)},
        modelName: "mock-vision-e2e",
        apiKey: "callpilot-e2e-key"
      });
      resolve({ result, totalMs: performance.now() - t0 });
    })`);

    const overlayStartedAt = Date.now();
    await evaluate(client, `window.callpilotDesktop.startSession({ mode: "live_coding" })`);
    let overlayOpenMs = Infinity;
    let overlayTarget = null;
    let codingTarget = null;
    for (let index = 0; index < 30; index += 1) {
      overlayTarget = await getPageTarget((target) => String(target.url).includes("#/overlay"));
      codingTarget = await getPageTarget((target) => String(target.url).includes("#/coding"));
      if (overlayTarget && codingTarget) {
        overlayOpenMs = Date.now() - overlayStartedAt;
        break;
      }
      await sleep(100);
    }
    if (!overlayTarget?.webSocketDebuggerUrl) {
      throw new Error("Overlay target did not open");
    }
    if (!codingTarget?.webSocketDebuggerUrl) {
      throw new Error("Coding target did not open");
    }

    const overlayClient = await cdp(overlayTarget.webSocketDebuggerUrl);
    await overlayClient.send("Runtime.enable");
    const overlayInitialUi = await evaluate(overlayClient, `({
      hasOverlayRoot: Boolean(document.querySelector(".cp-overlay")),
      hasOverlayBar: Boolean(document.querySelector(".cp-overlay__bar")),
      hasConfigControls: [...document.querySelectorAll("button")].some((button) => /config|context|start listening|capture/i.test(button.textContent || "")),
      text: document.body.innerText
    })`);

    const codingClient = await cdp(codingTarget.webSocketDebuggerUrl);
    await codingClient.send("Runtime.enable");
    const codingInitialUi = await evaluate(codingClient, `({
      hasCodingRoot: Boolean(document.querySelector(".cp-coding")),
      hasCodePanel: Boolean(document.querySelector(".cp-code-panel")),
      hasReasoningPanel: Boolean(document.querySelector(".cp-reasoning-panel")),
      text: document.body.innerText
    })`);

    await evaluate(client, `window.callpilotDesktop.publishStructuredAnswer({
      requestId: "journey-coding-1",
      timestamp: Date.now(),
      renderedText: "**Respuesta:** Use a hash map.",
      answer: {
        kind: "coding",
        payload: {
          version: "1",
          answerNeeded: true,
          responseType: "initial_solution",
          problem: {
            title: "Two Sum",
            summary: "Find two indices that add to the target.",
            language: "Python",
            functionSignature: "def two_sum(nums, target):",
            constraints: ["Return any valid pair"]
          },
          solution: {
            approachSteps: ["Store seen values in a dictionary.", "Check each complement before inserting the current value."],
            code: "def two_sum(nums, target):\\n    seen = {}\\n    for i, num in enumerate(nums):\\n        need = target - num\\n        if need in seen:\\n            return [seen[need], i]\\n        seen[num] = i\\n    return []",
            complexity: { time: "O(n)", space: "O(n)", rationale: "One pass with hash lookups." },
            edgeCases: ["Duplicate values", "No valid pair"],
            invariants: []
          },
          narration: { spokenAnswer: "I will trade O(n) memory for a single pass lookup.", currentStep: "Implementing the hash map." },
          tests: [{ input: "[2,7,11,15], 9", expected: "[0,1]", rationale: "2 + 7 = 9" }],
          patch: { kind: "none", code: null }
        }
      }
    })`);
    await sleep(100);
    const codingRenderedUi = await evaluate(codingClient, `({
      hasTwoSum: /Two Sum/i.test(document.body.innerText || ""),
      hasCode: /def two_sum/.test(document.body.innerText || ""),
      hasApproach: /dictionary|complement/i.test(document.body.innerText || ""),
      hasComplexity: /O\\(n\\)/.test(document.body.innerText || ""),
      text: document.body.innerText
    })`);

    await evaluate(client, `window.callpilotDesktop.publishTranscriptMessage({
      id: "journey-recruiter-1",
      speaker: "recruiter",
      text: "Walk me through your SQL approach.",
      timestamp: Date.now()
    })`);
    const overlayAnswer = await evaluate(client, `window.callpilotDesktop.generateAnswer({
      provider: "openai",
      modelName: "mock-openai-e2e",
      apiKey: "callpilot-e2e-key",
      prompt: {
        system: "You are CallPilot overlay test.",
        user: "<resume>Built payments reconciliation with PostgreSQL.</resume>\\n<user_input>Walk me through SQL.</user_input>",
        debug: { modeId: "technical_qa", includedSections: [], omittedSections: [] }
      }
    })`);
    await sleep(100);
    const overlayRenderedUi = await evaluate(overlayClient, `({
      bubbleCount: document.querySelectorAll(".cp-bubble").length,
      hasRecruiterBubble: Boolean(document.querySelector(".cp-bubble--recruiter")),
      hasAssistantBubble: Boolean(document.querySelector(".cp-bubble--assistant")),
      headline: document.querySelector(".cp-bubble__headline")?.textContent || "",
      keywords: [...document.querySelectorAll(".cp-keyword")].map((node) => node.textContent),
      detail: document.querySelector(".cp-bubble__detail")?.textContent || "",
      text: document.body.innerText
    })`);
    overlayClient.close();
    codingClient.close();

    await evaluate(client, `window.callpilotDesktop.endSession()`);
    client.close();

    const firstDetailEvent = metrics.events.find((event) => event.type === "detail");
    const report = {
      generatedAt: new Date().toISOString(),
      thresholds,
      answer: {
        firstDetailMs: Number((firstDetailEvent?.at ?? Infinity).toFixed(2)),
        totalMs: Number(metrics.totalMs.toFixed(2)),
        ok: metrics.result.ok,
      },
      transcription: {
        totalMs: Number(transcript.totalMs.toFixed(2)),
        text: transcript.result.text,
        ok: transcript.result.ok,
      },
      vision: {
        totalMs: Number(vision.totalMs.toFixed(2)),
        ok: vision.result.ok,
        hasFunctionSignature: /functionSignature|two_sum|Two Sum/i.test(vision.result.text || ""),
      },
      overlay: {
        openMs: overlayOpenMs,
        ok: Number.isFinite(overlayOpenMs),
        initialUi: overlayInitialUi,
        renderedUi: overlayRenderedUi,
        answerOk: overlayAnswer.ok,
      },
      coding: {
        ok: Boolean(codingInitialUi.hasCodingRoot && codingInitialUi.hasCodePanel && codingInitialUi.hasReasoningPanel),
        initialUi: codingInitialUi,
        renderedUi: codingRenderedUi,
      },
      setupUi,
    };

    console.log(JSON.stringify(report, null, 2));

    const failures = [];
    if (!report.answer.ok) failures.push("answer generation failed");
    if (report.answer.firstDetailMs > thresholds.firstDetailMs) failures.push(`first detail too slow: ${report.answer.firstDetailMs}ms`);
    if (report.answer.totalMs > thresholds.answerCompleteMs) failures.push(`answer total too slow: ${report.answer.totalMs}ms`);
    if (!report.transcription.ok || !/approach/i.test(report.transcription.text)) failures.push("transcription failed expected text");
    if (report.transcription.totalMs > thresholds.transcriptionMs) failures.push(`transcription too slow: ${report.transcription.totalMs}ms`);
    if (!report.vision.ok || !report.vision.hasFunctionSignature) failures.push("vision failed coding extraction");
    if (report.vision.totalMs > thresholds.visionMs) failures.push(`vision too slow: ${report.vision.totalMs}ms`);
    if (!report.overlay.ok || report.overlay.openMs > thresholds.overlayOpenMs) failures.push(`overlay too slow: ${report.overlay.openMs}ms`);
    if (!report.setupUi.hasRoot || !report.setupUi.hasStartSession || !report.setupUi.hasSetupCards || !report.setupUi.hasContextFields) failures.push("setup UI did not render expected controls");
    if (!report.overlay.initialUi.hasOverlayRoot || !report.overlay.initialUi.hasOverlayBar) failures.push("overlay UI did not render expected shell");
    if (!report.coding.ok) failures.push("coding overlay did not render expected workspace");
    if (!report.coding.renderedUi.hasTwoSum || !report.coding.renderedUi.hasCode || !report.coding.renderedUi.hasApproach || !report.coding.renderedUi.hasComplexity) failures.push("coding overlay did not render structured solution");
    if (report.overlay.initialUi.hasConfigControls) failures.push("overlay exposes setup/config controls");
    if (!report.overlay.answerOk) failures.push("overlay answer generation failed");
    if (!report.overlay.renderedUi.hasRecruiterBubble) failures.push("overlay did not render transcript bubble");
    if (!report.overlay.renderedUi.hasAssistantBubble) failures.push("overlay did not render assistant bubble");
    if (!/tradeoff|consistency/i.test(report.overlay.renderedUi.detail)) failures.push("overlay detail did not render");

    if (failures.length > 0) {
      console.error(`User journey failed: ${failures.join("; ")}`);
      process.exitCode = 1;
    }
  } finally {
    electron.kill();
    mockOpenAI.close();
    fs.rmSync(pngPath, { force: true });
    if (process.exitCode && stderr.trim()) {
      console.error(stderr.trim());
    }
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
