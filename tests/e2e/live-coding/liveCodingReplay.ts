import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURRENT_SESSION_KEY,
  parseStructuredAnswerPayload,
  type CodingAnswerPayload,
  type ModelProvider,
  type StructuredAnswerPayload,
} from "../../../src/core/index.ts";

type CdpClient = {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
};

type AnswerRun = {
  label: "initial" | "followup";
  requestResult: { ok: boolean; error?: string };
  events: Array<{ type: string; at: number; payload: any }>;
  completed: boolean;
  failed: boolean;
  renderedText: string;
  structured: StructuredAnswerPayload | null;
  latencyMs: number;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const reportsDir = path.join(root, "tests", "e2e", "reports");
const electronBin = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");

const argValue = (name: string): string => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
};

const hasArg = (name: string): boolean => process.argv.includes(name);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const screenshotPath = argValue("--screenshot") || process.env.CALLPILOT_E2E_SCREENSHOT || "";
const screenTextArg = argValue("--screen-text") || process.env.CALLPILOT_E2E_SCREEN_TEXT || "";
const screenTextFile = argValue("--screen-text-file") || process.env.CALLPILOT_E2E_SCREEN_TEXT_FILE || "";
const followup = argValue("--followup") || process.env.CALLPILOT_E2E_FOLLOWUP || "Ahora el usuario debe poner su nombre en un input.";
const expectedFunctionArg = argValue("--expected-function") || process.env.CALLPILOT_E2E_EXPECTED_FUNCTION || "";
const followupTerms = (argValue("--expect-followup-terms") || process.env.CALLPILOT_E2E_EXPECT_FOLLOWUP_TERMS || "input")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const loops = Math.max(1, Number(argValue("--loops") || process.env.CALLPILOT_E2E_LOOPS || "1"));
const timeoutMs = Math.max(5000, Number(argValue("--timeout-ms") || process.env.CALLPILOT_E2E_ANSWER_TIMEOUT_MS || "180000"));
const debugPort = Number(argValue("--debug-port") || process.env.CALLPILOT_E2E_DEBUG_PORT || "9369");
const mockPort = Number(argValue("--mock-port") || process.env.CALLPILOT_E2E_MOCK_PORT || "9370");
const requestedProvider = (argValue("--provider") || process.env.CALLPILOT_E2E_PROVIDER || "mock") as "mock" | "openai" | "nvidia";
const provider: ModelProvider = requestedProvider === "mock" ? "openai" : requestedProvider;
const modelName = argValue("--model")
  || process.env.CALLPILOT_E2E_MODEL
  || (provider === "nvidia" ? process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.1-8b-instruct" : "mock-live-coding-replay");
const useVision = hasArg("--vision") || process.env.CALLPILOT_E2E_USE_VISION === "1";

const readOptionalScreenText = (): string => {
  if (screenTextArg.trim()) return screenTextArg.trim();
  if (screenTextFile.trim()) return fs.readFileSync(path.resolve(root, screenTextFile), "utf8").trim();
  return "";
};

const extractExpectedFunction = (text: string): string => {
  if (expectedFunctionArg.trim()) return expectedFunctionArg.trim();
  const match = text.match(/^\s*(?:\d+\s+)?(?:async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/m);
  return match?.[1] ?? "";
};

const extractCode = (payload: StructuredAnswerPayload | null): string =>
  payload?.kind === "coding" ? payload.payload.solution.code : "";

const makeCodingPayload = (code: string, responseType: "initial_solution" | "follow_up_change", title = "Visible Python task"): StructuredAnswerPayload => ({
  kind: "coding",
  payload: {
    version: "1",
    answerNeeded: true,
    intent: null,
    responseType,
    spokenAnswer: responseType === "follow_up_change"
      ? "Actualizo la misma funcion visible con el cambio pedido."
      : "Uso la funcion visible y completo la implementacion.",
    keyPoints: [],
    correction: { needed: false, transition: null, correctedClaim: null },
    assumptions: [],
    evidenceRefs: [],
    followUpHint: null,
    problem: {
      title,
      summary: "Solve the visible Python task without renaming the function.",
      language: "Python",
      functionSignature: code.split(/\r?\n/)[0]?.trim() || null,
      constraints: [],
    },
    solution: {
      approachSteps: ["Preserve the visible Python function and update only its body."],
      code,
      complexity: { time: "O(1)", space: "O(1)", rationale: "The visible task returns one value." },
      edgeCases: ["Empty input can return an empty string if the interviewer asks for typed input."],
      invariants: ["The visible function name and signature remain unchanged."],
    },
    narration: {
      spokenAnswer: responseType === "follow_up_change"
        ? "Mantengo la misma funcion y cambio el cuerpo para leer el nombre desde input."
        : "Mantengo la firma visible y retorno el nombre solicitado.",
      currentStep: "Preserve visible function",
    },
    tests: [],
    patch: responseType === "follow_up_change" ? { kind: "replace", code } : { kind: "none", code: null },
  },
});

const createOutputPayload = (text: string) => ({
  output_text: text,
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
});

const mockOpenAI = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += chunk.toString();
  });
  request.on("end", async () => {
    await sleep(80);
    const payload = JSON.parse(body || "{}");
    const input = String(payload.input || "");
    const functionName = extractExpectedFunction(input) || "hello";
    const signatureMatch = input.match(new RegExp(`(?:async\\s+def|def)\\s+${functionName}\\s*\\(([^)\\n]*)\\)`, "m"));
    const params = signatureMatch?.[1] ?? "";
    const latestActionableInput = input.match(/<latest_actionable_input>\s*([\s\S]*?)\s*<\/latest_actionable_input>/i)?.[1] ?? "";
    const hasPriorLiveCodingSolution = /current_live_coding_solution|previous_solution_code|follow_up_rule/i.test(input);
    const wantsInput = hasPriorLiveCodingSolution
      && /input|entrada|ingres|type|typed|poner su nombre/i.test(latestActionableInput || input);
    const code = wantsInput
      ? [`def ${functionName}(${params}):`, "    # Read the username requested by the interviewer.", "    username = input(\"Nombre de usuario: \")", "    return username"].join("\n")
      : [`def ${functionName}(${params}):`, "    # Return the requested username while preserving the visible function.", "    username = \"example_user\"", "    return username"].join("\n");
    const structured = makeCodingPayload(code, wantsInput ? "follow_up_change" : "initial_solution");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(createOutputPayload(JSON.stringify(structured))));
  });
});

const listen = (server: http.Server, port: number) =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

const waitForHttp = async (url: string, waitMs = 25000) => {
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const cdp = async (targetUrl: string): Promise<CdpClient> => {
  const socket = new WebSocket(targetUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP websocket error")), { once: true });
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

const evaluate = async <T>(client: CdpClient, expression: string): Promise<T> => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result.result.value as T;
};

const getPageTarget = async (predicate: (target: any) => boolean, waitMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target = targets.find((item: any) => item.type === "page" && predicate(item));
    if (target) return target;
    await sleep(150);
  }
  return null;
};

const getSessionEventClient = async (): Promise<CdpClient> => {
  const target = await getPageTarget((item) => String(item.url).includes("#/coding"), 10000)
    ?? await getPageTarget((item) => String(item.url).includes("#/overlay"), 10000);
  if (!target?.webSocketDebuggerUrl) throw new Error("Could not find live coding session event window");
  const client = await cdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  const ready = await evaluate<boolean>(client, waitForBridgeExpression);
  if (!ready) throw new Error("Session event window bridge did not become ready");
  return client;
};

const waitForBridgeExpression = `new Promise((resolve) => {
  const started = performance.now();
  const tick = () => {
    if (window.callpilotDesktop?.startSession && window.callpilotDesktop?.requestAnswer && window.callpilotDesktop?.publishScreenContext) {
      resolve(true);
      return;
    }
    if (performance.now() - started > 10000) {
      resolve(false);
      return;
    }
    setTimeout(tick, 100);
  };
  tick();
})`;

const makeSession = (input: {
  id: string;
  screenText: string;
  answer?: string;
  codingPayload?: CodingAnswerPayload | null;
  transcriptText?: string;
}) => {
  const now = Date.now();
  const transcriptMessages = input.transcriptText?.trim()
    ? [{
      id: `tr-${now}-1`,
      text: input.transcriptText.trim(),
      timestamp: now,
      source: "stt",
      speaker: "interviewer",
    }]
    : [];
  return {
    id: input.id,
    title: "E2E live coding replay",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    activeMode: "live_coding",
    transcript: { messages: transcriptMessages, paused: false, updatedAt: now },
    screenText: input.screenText,
    companyName: "",
    roleTitle: "Backend Engineer",
    resumeText: "",
    starStories: "",
    jobDescription: "Live coding interview. Preserve visible Python code and apply interviewer follow-ups.",
    notes: "Use Python. Preserve visible function names and signatures unless the interviewer explicitly asks to rename them.",
    profile: "",
    targetUseCase: "live coding interview",
    preferredLanguage: "spanish",
    codingLanguage: "Python",
    answerVerbosity: "medium",
    modelProvider: provider,
    modelName,
    question: "",
    answer: input.answer ?? "",
    codingPayload: input.codingPayload ?? null,
  };
};

const seedSession = async (client: CdpClient, session: any) => {
  await evaluate(client, `(async () => {
    window.localStorage.setItem("callpilot_e2e_desktop_smoke", "1");
    await window.callpilotDesktop?.saveSettings?.({
      activeMode: "live_coding",
      preferredLanguage: "spanish",
      defaultCodingLanguage: "Python",
      answerVerbosity: "medium",
      modelProvider: ${JSON.stringify(provider)},
      modelName: ${JSON.stringify(modelName)},
      liveTranscriptionProvider: "deepgram",
      liveLatencyPreset: "balanced",
      liveAudioSource: "both"
    });
    window.localStorage.setItem(${JSON.stringify(CURRENT_SESSION_KEY)}, ${JSON.stringify(JSON.stringify(session))});
    window.location.reload();
    return true;
  })()`);
  await sleep(700);
  const ready = await evaluate<boolean>(client, waitForBridgeExpression);
  if (!ready) throw new Error("Desktop bridge did not recover after session seed reload");
};

const installEventCapture = async (client: CdpClient) => {
  await evaluate(client, `(() => {
    window.__callpilotReplayEvents = [];
    window.__callpilotReplayDisposers?.forEach?.((dispose) => { try { dispose?.(); } catch {} });
    window.__callpilotReplayDisposers = [
      window.callpilotDesktop.onAnswerStatus((payload) => window.__callpilotReplayEvents.push({ type: "status", at: Date.now(), payload })),
      window.callpilotDesktop.onStructuredAnswer((payload) => window.__callpilotReplayEvents.push({ type: "structured", at: Date.now(), payload })),
      window.callpilotDesktop.onScreenContextPublished((payload) => window.__callpilotReplayEvents.push({ type: "screen", at: Date.now(), payload }))
    ];
    return true;
  })()`);
};

const resolveScreenText = async (client: CdpClient, imagePath: string, fallbackText: string) => {
  let text = fallbackText.trim();
  let ocrResult: any = null;
  let visionResult: any = null;
  if (!text && imagePath) {
    ocrResult = await evaluate<any>(client, `window.callpilotDesktop.recognizeScreenText({
      path: ${JSON.stringify(imagePath)},
      language: "auto"
    })`);
    text = String(ocrResult?.text || "").trim();
  }
  if (useVision && imagePath) {
    visionResult = await evaluate<any>(client, `window.callpilotDesktop.analyzeScreenshot({
      path: ${JSON.stringify(imagePath)},
      provider: ${JSON.stringify(provider === "nvidia" ? "nvidia" : "openai")},
      modelName: ${JSON.stringify(provider === "nvidia" ? process.env.CALLPILOT_NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct" : modelName)}
    })`);
    if (visionResult?.ok && visionResult.text) text = [text, String(visionResult.text).trim()].filter(Boolean).join("\n");
  }
  return { text, ocrResult, visionResult };
};

const publishScreen = async (client: CdpClient, text: string, imagePath: string) => {
  const result = await evaluate<any>(client, `window.callpilotDesktop.publishScreenContext({
    visibleText: ${JSON.stringify(text)},
    screenshotPath: ${JSON.stringify(imagePath)},
    displayName: ${JSON.stringify(imagePath ? path.basename(imagePath) : "manual-screen-text")},
    source: "e2e_live_coding_replay",
    capturedAt: Date.now()
  })`);
  if (!result?.ok) throw new Error(`screen:publish-context failed: ${result?.error || "unknown"}`);
};

const requestAnswer = async (mainClient: CdpClient, eventClient: CdpClient, label: "initial" | "followup"): Promise<AnswerRun> => {
  await installEventCapture(eventClient);
  await sleep(150);
  const started = Date.now();
  const requestResult = await evaluate<{ ok: boolean; error?: string }>(mainClient, "window.callpilotDesktop.requestAnswer()");
  const events = await evaluate<Array<{ type: string; at: number; payload: any }>>(eventClient, `new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const events = window.__callpilotReplayEvents || [];
      const terminal = events.find((event) => event.type === "status" && ["completed", "failed", "cancelled"].includes(event.payload?.status));
      if (terminal || Date.now() - started > ${JSON.stringify(timeoutMs)}) {
        resolve(events);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  })`);
  const status = events.find((event) => event.type === "status" && ["completed", "failed", "cancelled"].includes(event.payload?.status));
  const structuredEvent = events.find((event) => event.type === "structured");
  const structured = structuredEvent?.payload?.answer
    ? parseStructuredAnswerPayload(JSON.stringify(structuredEvent.payload.answer))
    : null;
  return {
    label,
    requestResult,
    events,
    completed: status?.payload?.status === "completed",
    failed: status?.payload?.status === "failed",
    renderedText: String(status?.payload?.text || structuredEvent?.payload?.renderedText || ""),
    structured,
    latencyMs: Date.now() - started,
  };
};

const runLoop = async (client: CdpClient, loop: number, baseScreenText: string, imagePath: string) => {
  const sessionId = `e2e-live-coding-replay-${Date.now()}-${loop}`;
  await seedSession(client, makeSession({ id: sessionId, screenText: baseScreenText }));
  await evaluate(client, `window.callpilotDesktop.startSession({
    mode: "live_coding",
    modelProvider: ${JSON.stringify(provider)},
    modelName: ${JSON.stringify(modelName)},
    preferredLanguage: "spanish"
  })`);
  await publishScreen(client, baseScreenText, imagePath);
  const initialEventClient = await getSessionEventClient();
  const initial = await requestAnswer(client, initialEventClient, "initial");
  initialEventClient.close();
  const initialCode = extractCode(initial.structured);
  const initialPayload = initial.structured?.kind === "coding" ? initial.structured.payload : null;

  await seedSession(client, makeSession({
    id: sessionId,
    screenText: baseScreenText,
    answer: initial.renderedText,
    codingPayload: initialPayload,
    transcriptText: followup,
  }));
  await evaluate(client, `window.callpilotDesktop.startSession({
    mode: "live_coding",
    modelProvider: ${JSON.stringify(provider)},
    modelName: ${JSON.stringify(modelName)},
    preferredLanguage: "spanish"
  })`);
  await publishScreen(client, baseScreenText, imagePath);
  const followupEventClient = await getSessionEventClient();
  const followupRun = await requestAnswer(client, followupEventClient, "followup");
  followupEventClient.close();
  const followupCode = extractCode(followupRun.structured);
  const expectedFunction = extractExpectedFunction(baseScreenText);
  const checks = {
    screenContextAvailable: baseScreenText.trim().length > 0,
    expectedFunctionDetected: Boolean(expectedFunction),
    initialRequestAccepted: initial.requestResult.ok,
    initialCompleted: initial.completed,
    initialStructuredCoding: initial.structured?.kind === "coding",
    initialPreservedVisibleFunction: expectedFunction ? new RegExp(`\\bdef\\s+${expectedFunction}\\s*\\(`).test(initialCode) : false,
    followupRequestAccepted: followupRun.requestResult.ok,
    followupCompleted: followupRun.completed,
    followupStructuredCoding: followupRun.structured?.kind === "coding",
    followupPreservedVisibleFunction: expectedFunction ? new RegExp(`\\bdef\\s+${expectedFunction}\\s*\\(`).test(followupCode) : false,
    followupChangedCode: Boolean(initialCode && followupCode && initialCode !== followupCode),
    followupContainsExpectedTerms: followupTerms.every((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(followupCode)),
  };
  return {
    loop,
    expectedFunction,
    initial,
    followup: followupRun,
    checks,
    ok: Object.values(checks).every(Boolean),
  };
};

const run = async () => {
  if (!fs.existsSync(electronBin)) throw new Error(`Electron binary not found: ${electronBin}`);
  const absoluteScreenshot = screenshotPath ? path.resolve(root, screenshotPath) : "";
  if (absoluteScreenshot && !fs.existsSync(absoluteScreenshot)) throw new Error(`Screenshot not found: ${absoluteScreenshot}`);
  if (!absoluteScreenshot && !readOptionalScreenText()) {
    throw new Error("Provide --screenshot, CALLPILOT_E2E_SCREENSHOT, --screen-text, or --screen-text-file.");
  }
  if (requestedProvider === "mock") {
    await listen(mockOpenAI, mockPort);
  }

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const electron = spawn(electronBin, ["."], {
    cwd: root,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...childEnv,
      CALLPILOT_REMOTE_DEBUG_PORT: String(debugPort),
      ...(requestedProvider === "mock" ? {
        CALLPILOT_OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}`,
        OPENAI_API_KEY: "callpilot-e2e-key",
      } : {}),
    },
  });
  let stdout = "";
  let stderr = "";
  electron.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  electron.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let client: CdpClient | null = null;
  const report: Record<string, unknown> = {
    runId: `live-coding-replay-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    provider: requestedProvider,
    modelName,
    screenshot: absoluteScreenshot || null,
    followup,
    raw_model_output_available: false,
    loops: [],
  };

  try {
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/list`, 25000);
    const mainTarget = await getPageTarget((target) => !String(target.url).includes("#/overlay") && !String(target.url).includes("#/coding"), 15000);
    if (!mainTarget?.webSocketDebuggerUrl) throw new Error("Could not find Electron main renderer target");
    client = await cdp(mainTarget.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    const bridgeReady = await evaluate<boolean>(client, waitForBridgeExpression);
    if (!bridgeReady) throw new Error("Desktop bridge did not become ready");
    const screen = await resolveScreenText(client, absoluteScreenshot, readOptionalScreenText());
    report.screen = {
      textChars: screen.text.length,
      textPreview: screen.text.slice(0, 700),
      ocrOk: screen.ocrResult?.ok ?? null,
      ocrConfidence: screen.ocrResult?.confidence ?? null,
      visionOk: screen.visionResult?.ok ?? null,
    };
    if (!screen.text.trim()) throw new Error("Screen text is empty after OCR/manual input.");

    const loopResults = [];
    for (let index = 1; index <= loops; index += 1) {
      const result = await runLoop(client, index, screen.text, absoluteScreenshot);
      loopResults.push(result);
      if (!result.ok) break;
    }
    report.loops = loopResults.map((item) => ({
      loop: item.loop,
      ok: item.ok,
      expectedFunction: item.expectedFunction,
      checks: item.checks,
      initial: {
        completed: item.initial.completed,
        failed: item.initial.failed,
        latencyMs: item.initial.latencyMs,
        renderedText: item.initial.renderedText,
        parsed_output: item.initial.structured,
        final_rendered_output: item.initial.renderedText,
        raw_model_output: null,
      },
      followup: {
        completed: item.followup.completed,
        failed: item.followup.failed,
        latencyMs: item.followup.latencyMs,
        renderedText: item.followup.renderedText,
        parsed_output: item.followup.structured,
        final_rendered_output: item.followup.renderedText,
        raw_model_output: null,
      },
    }));
    report.ok = loopResults.length === loops && loopResults.every((item) => item.ok);
    const traceStatus = await evaluate<any>(client, "window.callpilotDesktop.getSessionTraceStatus()");
    const endSession = await evaluate<any>(client, "window.callpilotDesktop.endSession()");
    report.trace = { status: traceStatus, endSession };
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
    report.electron = { stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) };
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, `${String(report.runId)}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`Live coding replay report: ${reportPath}`);
    console.log(JSON.stringify({ ok: report.ok, provider: requestedProvider, modelName, loops: (report.loops as any[])?.length ?? 0 }, null, 2));
    client?.close();
    electron.kill();
    mockOpenAI.close();
  }
};

await run();
