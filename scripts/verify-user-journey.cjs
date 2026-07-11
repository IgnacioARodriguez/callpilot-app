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
  headlineMs: 1000,
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
          headline: "I chose SQL because consistency was the product risk.",
          keywords: ["SQL", "ACID", "audits"],
          detail: "",
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

    const metrics = await evaluate(client, `new Promise(async (resolve) => {
      const prompt = {
        system: "You are CallPilot test.",
        user: "<resume>Built payments reconciliation with PostgreSQL.</resume>\\n<user_input>Why SQL?</user_input>",
        debug: { modeId: "technical_qa", includedSections: [], omittedSections: [] }
      };
      const events = [];
      const t0 = performance.now();
      const offHeadline = window.callpilotDesktop.onAnswerHeadline((payload) => {
        events.push({ type: "headline", at: performance.now() - t0, payload });
      });
      const offDetail = window.callpilotDesktop.onAnswerDetailChunk((chunk) => {
        events.push({ type: "detail", at: performance.now() - t0, chunk });
      });
      const result = await window.callpilotDesktop.generateAnswer({
        provider: "openai",
        modelName: "mock-openai-e2e",
        apiKey: "callpilot-e2e-key",
        prompt
      });
      offHeadline();
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
    await evaluate(client, `window.callpilotDesktop.startSession()`);
    let overlayOpenMs = Infinity;
    for (let index = 0; index < 30; index += 1) {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      if (list.some((target) => String(target.url).includes("#/overlay"))) {
        overlayOpenMs = Date.now() - overlayStartedAt;
        break;
      }
      await sleep(100);
    }
    await evaluate(client, `window.callpilotDesktop.endSession()`);
    client.close();

    const headlineEvent = metrics.events.find((event) => event.type === "headline");
    const firstDetailEvent = metrics.events.find((event) => event.type === "detail");
    const report = {
      generatedAt: new Date().toISOString(),
      thresholds,
      answer: {
        headlineMs: Number((headlineEvent?.at ?? Infinity).toFixed(2)),
        firstDetailMs: Number((firstDetailEvent?.at ?? Infinity).toFixed(2)),
        totalMs: Number(metrics.totalMs.toFixed(2)),
        headlineBeforeDetail: Boolean(headlineEvent && firstDetailEvent && headlineEvent.at <= firstDetailEvent.at),
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
      },
    };

    console.log(JSON.stringify(report, null, 2));

    const failures = [];
    if (!report.answer.ok) failures.push("answer generation failed");
    if (!report.answer.headlineBeforeDetail) failures.push("headline did not arrive before detail");
    if (report.answer.headlineMs > thresholds.headlineMs) failures.push(`headline too slow: ${report.answer.headlineMs}ms`);
    if (report.answer.firstDetailMs > thresholds.firstDetailMs) failures.push(`first detail too slow: ${report.answer.firstDetailMs}ms`);
    if (report.answer.totalMs > thresholds.answerCompleteMs) failures.push(`answer total too slow: ${report.answer.totalMs}ms`);
    if (!report.transcription.ok || !/approach/i.test(report.transcription.text)) failures.push("transcription failed expected text");
    if (report.transcription.totalMs > thresholds.transcriptionMs) failures.push(`transcription too slow: ${report.transcription.totalMs}ms`);
    if (!report.vision.ok || !report.vision.hasFunctionSignature) failures.push("vision failed coding extraction");
    if (report.vision.totalMs > thresholds.visionMs) failures.push(`vision too slow: ${report.vision.totalMs}ms`);
    if (!report.overlay.ok || report.overlay.openMs > thresholds.overlayOpenMs) failures.push(`overlay too slow: ${report.overlay.openMs}ms`);

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
