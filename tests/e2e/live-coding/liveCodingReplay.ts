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
  label: string;
  requestResult: { ok: boolean; error?: string };
  events: Array<{ type: string; at: number; payload: any }>;
  completed: boolean;
  failed: boolean;
  renderedText: string;
  structured: StructuredAnswerPayload | null;
  latencyMs: number;
  requestId?: string;
  rawModelOutput?: string | null;
  rawModelOutputStage?: string;
  actionTimings: Record<string, number>;
};

type ReplayTurn = {
  speaker?: "interviewer" | "candidate";
  text: string;
  expectTerms?: string[];
};

type ReplayCase = {
  id: string;
  screenshot?: string;
  screenText?: string;
  screenTextFile?: string;
  expectedFunction?: string;
  expectInitialTerms?: string[];
  followups: ReplayTurn[];
};

type ScenarioTranscriptTurn = {
  role: "interviewer" | "candidate";
  text: string;
};

type ScenarioExpected = {
  expectedFunction: string | null;
  mustContain?: string[];
  mustContainAny?: string[];
  mustPreserve?: string[];
  mustNotContain: string[];
  semanticExpectations?: string[];
  semanticChecks?: {
    sortedWordFrequency?: boolean;
  };
};

type LoadedScenarioExpected = {
  expectedFunction: string | null;
  mustContain: string[];
  mustContainAny: string[];
  mustPreserve: string[];
  mustNotContain: string[];
  semanticExpectations: string[];
  semanticChecks: {
    sortedWordFrequency: boolean;
  };
};

type ScenarioStage = {
  id: string;
  order: number;
  image: string | null;
  code: string | null;
  transcript_delta: string;
  expected: string;
};

type StageScenario = {
  id: string;
  difficulty?: string;
  stages: ScenarioStage[];
};

type LoadedScenarioStage = ScenarioStage & {
  imagePath: string | null;
  codePath: string | null;
  transcriptPath: string;
  expectedPath: string;
  transcript: ScenarioTranscriptTurn[];
  expectedRules: LoadedScenarioExpected;
};

type LoadedStageScenario = Omit<StageScenario, "stages"> & {
  scenarioPath: string;
  baseDir: string;
  stages: LoadedScenarioStage[];
};

type TraceSummary = {
  path: string;
  answerTimings: Array<{ requestId?: string; stage?: string; elapsedMs?: number; ok?: boolean; error?: string; textChars?: number }>;
  rawModelOutputs: Array<{ requestId?: string; stage?: string; provider?: string; modelName?: string; ok?: boolean; error?: string; text?: string; textChars?: number }>;
  providerEvents: Array<{ requestId?: string; type: string; provider?: string; modelName?: string; durationMs?: number; status?: number; ok?: boolean; stream?: boolean }>;
  screenEvents: Array<{ type: string; elapsedMs?: number; ok?: boolean; durationMs?: number; confidence?: number; hasScreenshot?: boolean; fileName?: string }>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const reportsDir = path.join(root, "tests", "e2e", "reports");
const electronBin = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");

const argValue = (name: string): string => {
  const clean = (value: string) => value.replace(/\^/g, "").trim();
  const collectValue = (start: number): string[] => {
    const values: string[] = [];
    for (let index = start; index < process.argv.length; index += 1) {
      const item = process.argv[index];
      if (item.startsWith("--")) break;
      values.push(item);
    }
    return values;
  };
  const prefix = `${name}=`;
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex >= 0) {
    return collectValue(exactIndex + 1).join(" ").trim();
  }
  const prefixIndex = process.argv.findIndex((item) => item.startsWith(prefix));
  if (prefixIndex < 0) return "";
  const first = process.argv[prefixIndex].slice(prefix.length);
  const rest = collectValue(prefixIndex + 1);
  return clean([first, ...rest].join(" "));
};

const hasArg = (name: string): boolean => process.argv.includes(name);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const screenshotPath = argValue("--screenshot") || process.env.CALLPILOT_E2E_SCREENSHOT || "";
const screenTextArg = argValue("--screen-text") || process.env.CALLPILOT_E2E_SCREEN_TEXT || "";
const screenTextFile = argValue("--screen-text-file") || process.env.CALLPILOT_E2E_SCREEN_TEXT_FILE || "";
const corpusPath = argValue("--corpus") || process.env.CALLPILOT_E2E_LIVE_CODING_CORPUS || "";
const scenarioFilePath = argValue("--scenario-file") || process.env.CALLPILOT_E2E_LIVE_CODING_SCENARIO || "";
const followup = argValue("--followup") || process.env.CALLPILOT_E2E_FOLLOWUP || "Ahora el usuario debe poner su nombre en un input.";
const expectedFunctionArg = argValue("--expected-function") || process.env.CALLPILOT_E2E_EXPECTED_FUNCTION || "";
const followupTerms = (argValue("--expect-followup-terms") || process.env.CALLPILOT_E2E_EXPECT_FOLLOWUP_TERMS || "input")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const intArg = (name: string, envName: string, fallback: string): number =>
  Number.parseInt(argValue(name) || process.env[envName] || fallback, 10);
const loops = Math.max(1, intArg("--loops", "CALLPILOT_E2E_LOOPS", "1"));
const timeoutMs = Math.max(5000, intArg("--timeout-ms", "CALLPILOT_E2E_ANSWER_TIMEOUT_MS", "180000"));
const debugPort = intArg("--debug-port", "CALLPILOT_E2E_DEBUG_PORT", "9369");
const mockPort = intArg("--mock-port", "CALLPILOT_E2E_MOCK_PORT", "9370");
const requestedProvider = (argValue("--provider") || process.env.CALLPILOT_E2E_PROVIDER || "mock") as "mock" | "openai" | "nvidia" | "groq";
const provider: ModelProvider = requestedProvider === "mock" ? "openai" : requestedProvider;
const modelName = argValue("--model")
  || process.env.CALLPILOT_E2E_MODEL
  || (requestedProvider === "mock"
    ? "mock-live-coding-replay"
    : provider === "nvidia"
    ? process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.1-8b-instruct"
    : provider === "groq"
      ? process.env.CALLPILOT_GROQ_MODEL || "llama-3.3-70b-versatile"
      : "gpt-5-mini");
const useVision = hasArg("--vision") || process.env.CALLPILOT_E2E_USE_VISION === "1";

const nowMs = () => Date.now();
const timed = async <T>(timings: Record<string, number>, name: string, action: () => Promise<T>): Promise<T> => {
  const started = nowMs();
  try {
    return await action();
  } finally {
    timings[name] = nowMs() - started;
  }
};

const readOptionalScreenText = (): string => {
  if (screenTextArg.trim()) return screenTextArg.trim();
  if (screenTextFile.trim()) return fs.readFileSync(path.resolve(root, screenTextFile), "utf8").trim();
  return "";
};

const readCases = (): ReplayCase[] => {
  if (corpusPath.trim()) {
    const absolute = path.resolve(root, corpusPath);
    const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
    const cases = Array.isArray(parsed) ? parsed : parsed.cases;
    if (!Array.isArray(cases) || cases.length === 0) throw new Error(`Corpus has no cases: ${absolute}`);
    return cases.map((item: any, index: number) => ({
      id: String(item.id || `case-${index + 1}`),
      screenshot: typeof item.screenshot === "string" ? item.screenshot : undefined,
      screenText: typeof item.screenText === "string" ? item.screenText : undefined,
      screenTextFile: typeof item.screenTextFile === "string" ? item.screenTextFile : undefined,
      expectedFunction: typeof item.expectedFunction === "string" ? item.expectedFunction : undefined,
      expectInitialTerms: Array.isArray(item.expectInitialTerms) ? item.expectInitialTerms.map(String) : undefined,
      followups: (Array.isArray(item.followups) && item.followups.length > 0 ? item.followups : [{ text: followup }]).map((turn: any) => ({
        speaker: turn.speaker === "candidate" ? "candidate" : "interviewer",
        text: String(turn.text || ""),
        expectTerms: Array.isArray(turn.expectTerms) ? turn.expectTerms.map(String) : undefined,
      })),
    }));
  }
  return [{
    id: "single",
    screenshot: screenshotPath || undefined,
    screenText: screenTextArg || undefined,
    screenTextFile: screenTextFile || undefined,
    expectedFunction: expectedFunctionArg || undefined,
    followups: [{ speaker: "interviewer", text: followup, expectTerms: followupTerms }],
  }];
};

const readJsonFile = <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, "utf8"));

const requireFixtureFile = (scenarioId: string, stageId: string, label: string, filePath: string) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fixture file missing for ${scenarioId}/${stageId} (${label}): ${filePath}`);
  }
};

const readStageScenario = (): LoadedStageScenario | null => {
  if (!scenarioFilePath.trim()) return null;
  const absolute = path.resolve(root, scenarioFilePath);
  const parsed = readJsonFile<StageScenario>(absolute);
  if (!parsed?.id || !Array.isArray(parsed.stages) || parsed.stages.length === 0) {
    throw new Error(`Stage scenario has no stages: ${absolute}`);
  }
  const baseDir = path.dirname(absolute);
  const stages = [...parsed.stages]
    .sort((a, b) => a.order - b.order)
    .map((stage) => {
      const imagePath = typeof stage.image === "string" ? path.resolve(baseDir, stage.image) : null;
      const codePath = typeof stage.code === "string" ? path.resolve(baseDir, stage.code) : null;
      const transcriptPath = path.resolve(baseDir, stage.transcript_delta);
      const expectedPath = path.resolve(baseDir, stage.expected);
      if (imagePath) requireFixtureFile(parsed.id, stage.id, "coderpad.png", imagePath);
      if (codePath) requireFixtureFile(parsed.id, stage.id, "code.py", codePath);
      requireFixtureFile(parsed.id, stage.id, "transcript_delta.json", transcriptPath);
      requireFixtureFile(parsed.id, stage.id, "expected.json", expectedPath);
      const transcript = readJsonFile<ScenarioTranscriptTurn[]>(transcriptPath);
      const expectedRules = readJsonFile<ScenarioExpected>(expectedPath);
      if (!Array.isArray(transcript)) throw new Error(`Invalid transcript_delta for ${parsed.id}/${stage.id}: ${transcriptPath}`);
      if (!expectedRules || !("expectedFunction" in expectedRules)) throw new Error(`Invalid expected.json for ${parsed.id}/${stage.id}: ${expectedPath}`);
      return {
        ...stage,
        imagePath,
        codePath,
        transcriptPath,
        expectedPath,
        transcript,
        expectedRules: {
          expectedFunction: expectedRules.expectedFunction,
          mustContain: Array.isArray(expectedRules.mustContain) ? expectedRules.mustContain.map(String) : [],
          mustContainAny: Array.isArray(expectedRules.mustContainAny) ? expectedRules.mustContainAny.map(String) : [],
          mustPreserve: Array.isArray(expectedRules.mustPreserve) ? expectedRules.mustPreserve.map(String) : [],
          mustNotContain: Array.isArray(expectedRules.mustNotContain) ? expectedRules.mustNotContain.map(String) : [],
          semanticExpectations: Array.isArray(expectedRules.semanticExpectations) ? expectedRules.semanticExpectations.map(String) : [],
          semanticChecks: {
            sortedWordFrequency: Boolean(expectedRules.semanticChecks?.sortedWordFrequency),
          },
        },
      };
    });
  stages.forEach((stage, index) => {
    if (stage.order !== index) throw new Error(`Scenario ${parsed.id} stage order must be contiguous from 0; got ${stage.id} order ${stage.order}`);
  });
  return {
    id: parsed.id,
    difficulty: parsed.difficulty,
    scenarioPath: absolute,
    baseDir,
    stages,
  };
};

const extractExpectedFunction = (text: string, explicit = ""): string => {
  if (explicit.trim()) return explicit.trim();
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
    const latestActionableInput = input.match(/<latest_actionable_input>\s*([\s\S]*?)\s*<\/latest_actionable_input>/i)?.[1] ?? "";
    const inferredFunctionName = /sentence|word appears|count_words|count words|frequency/i.test(latestActionableInput || input)
      ? "count_words"
      : "";
    const functionName = extractExpectedFunction(input) || inferredFunctionName || "hello";
    const signatureMatch = input.match(new RegExp(`(?:async\\s+def|def)\\s+${functionName}\\s*\\(([^)\\n]*)\\)`, "m"));
    const params = signatureMatch?.[1] ?? (functionName === "count_words" ? "sentence" : "");
    const hasPriorLiveCodingSolution = /current_live_coding_solution|previous_solution_code|follow_up_rule/i.test(input);
    const wantsInput = hasPriorLiveCodingSolution
      && /input|entrada|ingres|type|typed|poner su nombre/i.test(latestActionableInput || input);
    const wantsNormalizeTests = functionName === "normalize_name" && /tests?|assert|empty|tabs?|whitespace/i.test(latestActionableInput || input);
    const wantsNormalizeCollapsedSpaces = functionName === "normalize_name" && /internal spaces|multiple spaces|underscores|espacios internos|varios espacios/i.test(latestActionableInput || input);
    const wantsWordSorting = functionName === "count_words" && /case-insensitive|descending count|alphabetical|sorted|ties/i.test(latestActionableInput || input);
    const code = functionName === "count_words" && wantsWordSorting
      ? [
        "def count_words(sentence):",
        "    counts = {}",
        "    for word in sentence.lower().split():",
        "        counts[word] = counts.get(word, 0) + 1",
        "    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))",
      ].join("\n")
      : functionName === "count_words"
        ? [
          "def count_words(sentence):",
          "    counts = {}",
          "    for word in sentence.split(\" \"):",
          "        counts[word] = counts.get(word, 0) + 1",
          "    return counts",
        ].join("\n")
        : functionName === "normalize_name" && wantsNormalizeTests
      ? [
        "def normalize_name(name):",
        "    limpio = \"_\".join(name.strip().lower().split())",
        "    return limpio",
        "",
        "assert normalize_name(\" Ana \") == \"ana\"",
        "assert normalize_name(\"Ana   Pérez\") == \"ana_pérez\"",
        "assert normalize_name(\"\") == \"\"",
        "assert normalize_name(\"\\t Ana\\tPérez \\n\") == \"ana_pérez\"",
        "print(\"ok\")",
      ].join("\n")
      : functionName === "normalize_name" && wantsNormalizeCollapsedSpaces
        ? ["def normalize_name(name):", "    limpio = \"_\".join(name.strip().lower().split())", "    return limpio"].join("\n")
        : functionName === "normalize_name"
          ? ["def normalize_name(name):", "    limpio = name.strip()", "    limpio = limpio.lower()", "    return limpio"].join("\n")
          : wantsInput
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
      window.callpilotDesktop.onRawModelOutput((payload) => window.__callpilotReplayEvents.push({ type: "raw", at: Date.now(), payload })),
      window.callpilotDesktop.onStructuredAnswer((payload) => window.__callpilotReplayEvents.push({ type: "structured", at: Date.now(), payload })),
      window.callpilotDesktop.onScreenContextPublished((payload) => window.__callpilotReplayEvents.push({ type: "screen", at: Date.now(), payload }))
    ];
    return true;
  })()`);
};

const resolveScreenText = async (client: CdpClient, imagePath: string, fallbackText: string, timings: Record<string, number>) => {
  let text = fallbackText.trim();
  let ocrResult: any = null;
  let visionResult: any = null;
  if (!text && imagePath) {
    ocrResult = await timed(timings, "ocr_ms", () => evaluate<any>(client, `window.callpilotDesktop.recognizeScreenText({
      path: ${JSON.stringify(imagePath)},
      language: "auto"
    })`));
    text = String(ocrResult?.text || "").trim();
  }
  if (useVision && imagePath) {
    visionResult = await timed(timings, "vision_ms", () => evaluate<any>(client, `window.callpilotDesktop.analyzeScreenshot({
      path: ${JSON.stringify(imagePath)},
      provider: ${JSON.stringify(provider === "nvidia" ? "nvidia" : "openai")},
      modelName: ${JSON.stringify(provider === "nvidia" ? process.env.CALLPILOT_NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct" : modelName)}
    })`));
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

const publishTranscriptDelta = async (client: CdpClient, scenarioId: string, stage: LoadedScenarioStage) => {
  for (let index = 0; index < stage.transcript.length; index += 1) {
    const turn = stage.transcript[index];
    const result = await evaluate<any>(client, `window.callpilotDesktop.publishTranscriptMessage({
      id: ${JSON.stringify(`${scenarioId}-${stage.id}-${index}`)},
      speaker: ${JSON.stringify(turn.role === "candidate" ? "candidate" : "interviewer")},
      text: ${JSON.stringify(turn.text)},
      timestamp: Date.now() + ${index}
    })`);
    if (!result?.ok) throw new Error(`transcript:publish failed for ${scenarioId}/${stage.id}/${index}: ${result?.error || "unknown"}`);
  }
};

const transcriptPrompt = (scenarioId: string, stage: LoadedScenarioStage) => [
  `scenario_id: ${scenarioId}`,
  `stage_id: ${stage.id}`,
  stage.imagePath
    ? "Use the latest CoderPad screenshot as the source of truth."
    : "There is no current screenshot for this stage; answer from the technical transcript only and ignore small talk.",
  stage.imagePath
    ? "Preserve visible Python function names, signatures, and custom variable names unless explicitly asked otherwise."
    : "No Python signature is visible yet; propose a reasonable one only if useful and do not claim it was provided.",
  "Apply only the interviewer request in this stage.",
  "",
  ...stage.transcript.map((turn) => `${turn.role}: ${turn.text}`),
].join("\n");

const includesTerm = (text: string, term: string) => text.toLowerCase().includes(term.toLowerCase());

const validatesSortedWordFrequency = (code: string) => {
  const compact = code.replace(/\s+/g, " ");
  const countDescThenWordAsc = /key\s*=\s*lambda\s+([A-Za-z_][\w]*)\s*:\s*\(\s*-\s*\1\s*\[\s*1\s*\]\s*,\s*\1\s*\[\s*0\s*\]\s*\)/.test(compact);
  const helperTuple = /return\s+\(\s*-\s*[A-Za-z_][\w]*\s*\[\s*1\s*\]\s*,\s*[A-Za-z_][\w]*\s*\[\s*0\s*\]\s*\)/.test(compact);
  const sortsItems = /\bsorted\s*\(/.test(code) || /\.sort\s*\(/.test(code);
  return sortsItems
    && /\.items\s*\(\s*\)/.test(code)
    && (countDescThenWordAsc || helperTuple);
};

const validateScenarioStageAnswer = (
  scenarioId: string,
  stage: LoadedScenarioStage,
  answerRun: AnswerRun,
) => {
  const code = extractCode(answerRun.structured);
  const rendered = answerRun.renderedText.trim();
  const failures: string[] = [];
  if (!answerRun.requestResult.ok) failures.push(`request was rejected: ${answerRun.requestResult.error || "unknown"}`);
  if (!answerRun.completed) failures.push("answer did not complete");
  if (!rendered) failures.push("rendered answer is empty");
  if (answerRun.structured?.kind !== "coding") failures.push("structured answer is not coding");
  if (!code.trim()) failures.push("extracted solution code is empty");
  if (stage.expectedRules.expectedFunction && !new RegExp(`\\bdef\\s+${stage.expectedRules.expectedFunction}\\s*\\(`).test(code)) {
    failures.push(`code does not preserve function ${stage.expectedRules.expectedFunction}`);
  }
  for (const term of stage.expectedRules.mustContain) {
    if (!includesTerm(code, term)) failures.push(`code missing required term: ${term}`);
  }
  if (stage.expectedRules.mustContainAny.length > 0 && !stage.expectedRules.mustContainAny.some((term) => includesTerm(code, term))) {
    failures.push(`code missing any required term: ${stage.expectedRules.mustContainAny.join(", ")}`);
  }
  for (const term of stage.expectedRules.mustPreserve) {
    if (!includesTerm(code, term)) failures.push(`code does not preserve required term: ${term}`);
  }
  for (const term of stage.expectedRules.mustNotContain) {
    if (includesTerm(code, term)) failures.push(`code contains forbidden term: ${term}`);
  }
  if (stage.expectedRules.semanticChecks.sortedWordFrequency && !validatesSortedWordFrequency(code)) {
    failures.push("code does not sort word frequencies by descending count and ascending word");
  }
  return {
    ok: failures.length === 0,
    failures: failures.map((failure) => `${scenarioId}/${stage.id}: ${failure}`),
    code,
    rendered,
  };
};

const summarizeTrace = (tracePath: string): TraceSummary | null => {
  if (!tracePath || !fs.existsSync(tracePath)) return null;
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  const events = Array.isArray(trace.events) ? trace.events : [];
  return {
    path: tracePath,
    answerTimings: events
      .filter((event: any) => event.type === "answer_timing")
      .map((event: any) => ({
        requestId: event.requestId,
        stage: event.stage,
        elapsedMs: event.elapsedMs,
        ok: event.ok,
        error: event.error,
        textChars: event.textChars,
      })),
    rawModelOutputs: events
      .filter((event: any) => event.type === "answer_raw_model_output")
      .map((event: any) => ({
        requestId: event.requestId,
        stage: event.stage,
        provider: event.provider,
        modelName: event.modelName,
        ok: event.ok,
        error: event.error,
        text: event.text,
        textChars: event.textChars,
      })),
    providerEvents: events
      .filter((event: any) => /^provider_|^model_generate/.test(String(event.type)))
      .map((event: any) => ({
        requestId: event.requestId,
        type: event.type,
        provider: event.provider ?? event.result?.provider,
        modelName: event.modelName ?? event.result?.modelName,
        durationMs: event.durationMs,
        status: event.status,
        ok: event.ok ?? event.result?.ok,
        stream: event.stream,
      })),
    screenEvents: events
      .filter((event: any) => /^screen_/.test(String(event.type)))
      .map((event: any) => ({
        type: event.type,
        elapsedMs: event.elapsedMs,
        ok: event.ok,
        durationMs: event.durationMs,
        confidence: event.confidence,
        hasScreenshot: event.hasScreenshot,
        fileName: event.fileName,
      })),
  };
};

const resolveCasePaths = (replayCase: ReplayCase) => {
  const imagePath = replayCase.screenshot ? path.resolve(root, replayCase.screenshot) : "";
  const inlineText = replayCase.screenText?.trim() ?? "";
  const fileText = replayCase.screenTextFile ? fs.readFileSync(path.resolve(root, replayCase.screenTextFile), "utf8").trim() : "";
  return {
    imagePath,
    fallbackText: inlineText || fileText,
  };
};

const requestAnswer = async (mainClient: CdpClient, eventClient: CdpClient, label: string, questionOverride = ""): Promise<AnswerRun> => {
  const actionTimings: Record<string, number> = {};
  await timed(actionTimings, "install_event_capture_ms", () => installEventCapture(eventClient));
  await sleep(150);
  const started = Date.now();
  const requestResult = await timed(actionTimings, "request_answer_ipc_ms", () =>
    evaluate<{ ok: boolean; requestId?: string; error?: string }>(mainClient, `window.callpilotDesktop.requestAnswer(${JSON.stringify(questionOverride)})`));
  const expectedRequestId = requestResult.requestId;
  const events = await timed(actionTimings, "wait_for_terminal_answer_event_ms", () =>
    evaluate<Array<{ type: string; at: number; payload: any }>>(eventClient, `new Promise((resolve) => {
    const started = Date.now();
    const expectedRequestId = ${JSON.stringify(expectedRequestId)};
    const tick = () => {
      const events = window.__callpilotReplayEvents || [];
      const terminal = events.find((event) =>
        event.type === "status"
        && (!expectedRequestId || event.payload?.requestId === expectedRequestId)
        && ["completed", "failed", "cancelled"].includes(event.payload?.status)
      );
      if (terminal || Date.now() - started > ${JSON.stringify(timeoutMs)}) {
        resolve(events);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  })`));
  const requestEvents = expectedRequestId
    ? events.filter((event) => !event.payload?.requestId || event.payload.requestId === expectedRequestId)
    : events;
  const status = requestEvents.find((event) => event.type === "status" && ["completed", "failed", "cancelled"].includes(event.payload?.status));
  const rawEvent = [...requestEvents].reverse().find((event) => event.type === "raw");
  const structuredEvent = requestEvents.find((event) => event.type === "structured");
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
    requestId: status?.payload?.requestId || structuredEvent?.payload?.requestId,
    rawModelOutput: typeof rawEvent?.payload?.text === "string" ? rawEvent.payload.text : null,
    rawModelOutputStage: rawEvent?.payload?.stage,
    latencyMs: Date.now() - started,
    actionTimings,
  };
};

const runSingleAnswerTurn = async (input: {
  client: CdpClient;
  sessionId: string;
  baseScreenText: string;
  imagePath: string;
  answer?: string;
  codingPayload?: CodingAnswerPayload | null;
  transcriptText?: string;
  label: string;
}) => {
  const actionTimings: Record<string, number> = {};
  await timed(actionTimings, "seed_session_ms", () => seedSession(input.client, makeSession({
    id: input.sessionId,
    screenText: input.baseScreenText,
    answer: input.answer,
    codingPayload: input.codingPayload,
    transcriptText: input.transcriptText,
  })));
  await timed(actionTimings, "start_session_ms", () => evaluate(input.client, `window.callpilotDesktop.startSession({
    mode: "live_coding",
    modelProvider: ${JSON.stringify(provider)},
    modelName: ${JSON.stringify(modelName)},
    preferredLanguage: "spanish"
  })`));
  await timed(actionTimings, "publish_screen_context_ms", () => publishScreen(input.client, input.baseScreenText, input.imagePath));
  const eventClient = await timed(actionTimings, "open_session_event_client_ms", () => getSessionEventClient());
  const answerRun = await requestAnswer(input.client, eventClient, input.label);
  eventClient.close();
  answerRun.actionTimings = { ...actionTimings, ...answerRun.actionTimings };
  return answerRun;
};

const runLoop = async (client: CdpClient, replayCase: ReplayCase, loop: number, baseScreenText: string, imagePath: string) => {
  const sessionId = `e2e-live-coding-replay-${Date.now()}-${loop}`;
  const initial = await runSingleAnswerTurn({
    client,
    sessionId,
    baseScreenText,
    imagePath,
    label: "initial",
  });
  let previousCode = extractCode(initial.structured);
  let previousAnswer = initial.renderedText;
  let previousPayload = initial.structured?.kind === "coding" ? initial.structured.payload : null;
  const expectedFunction = extractExpectedFunction(baseScreenText, replayCase.expectedFunction);
  const turnResults = [initial];

  for (let index = 0; index < replayCase.followups.length; index += 1) {
    const turn = replayCase.followups[index];
    const followupRun = await runSingleAnswerTurn({
      client,
      sessionId,
      baseScreenText,
      imagePath,
      answer: previousAnswer,
      codingPayload: previousPayload,
      transcriptText: turn.text,
      label: `followup-${index + 1}`,
    });
    turnResults.push(followupRun);
    previousAnswer = followupRun.renderedText;
    previousPayload = followupRun.structured?.kind === "coding" ? followupRun.structured.payload : previousPayload;
  }

  const checks: Record<string, boolean> = {
    screenContextAvailable: baseScreenText.trim().length > 0,
    expectedFunctionDetected: Boolean(expectedFunction),
  };
  turnResults.forEach((turn, index) => {
    const code = extractCode(turn.structured);
    const priorCode = index === 0 ? "" : extractCode(turnResults[index - 1].structured);
    const expectedTerms = index === 0
      ? replayCase.expectInitialTerms ?? []
      : replayCase.followups[index - 1]?.expectTerms ?? followupTerms;
    checks[`${turn.label}RequestAccepted`] = turn.requestResult.ok;
    checks[`${turn.label}Completed`] = turn.completed;
    checks[`${turn.label}StructuredCoding`] = turn.structured?.kind === "coding";
    checks[`${turn.label}PreservedVisibleFunction`] = expectedFunction ? new RegExp(`\\bdef\\s+${expectedFunction}\\s*\\(`).test(code) : false;
    if (index > 0) checks[`${turn.label}ChangedCode`] = Boolean(priorCode && code && priorCode !== code);
    checks[`${turn.label}ContainsExpectedTerms`] = expectedTerms.every((term) =>
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(code));
  });
  return {
    loop,
    caseId: replayCase.id,
    expectedFunction,
    turns: turnResults,
    checks,
    ok: Object.values(checks).every(Boolean),
  };
};

const runStageScenarioLoop = async (client: CdpClient, scenario: LoadedStageScenario, loop: number) => {
  const sessionId = `e2e-live-coding-stage-replay-${scenario.id}-${Date.now()}-${loop}`;
  const actionTimings: Record<string, number> = {};
  await timed(actionTimings, "seed_session_ms", () => seedSession(client, makeSession({
    id: sessionId,
    screenText: "",
  })));
  await timed(actionTimings, "start_session_ms", () => evaluate(client, `window.callpilotDesktop.startSession({
    mode: "live_coding",
    modelProvider: ${JSON.stringify(provider)},
    modelName: ${JSON.stringify(modelName)},
    preferredLanguage: "spanish"
  })`));
  const stages: any[] = [];
  let previousCode = "";
  let ok = true;

  for (const stage of scenario.stages) {
    const stageTimings: Record<string, number> = {};
    await timed(stageTimings, "publish_transcript_delta_ms", () => publishTranscriptDelta(client, scenario.id, stage));
    const screen = stage.imagePath
      ? await timed(stageTimings, "resolve_screen_text_ms", () => resolveScreenText(client, stage.imagePath ?? "", "", stageTimings))
      : { text: "", ocrResult: null, visionResult: null };
    if (stage.imagePath && !screen.text.trim()) {
      stages.push({
        id: stage.id,
        order: stage.order,
        ok: false,
        failures: [`${scenario.id}/${stage.id}: screen text is empty after OCR/vision`],
        screenshot: stage.imagePath,
      });
      ok = false;
      break;
    }
    if (stage.imagePath) {
      await timed(stageTimings, "publish_screen_context_ms", () => publishScreen(client, screen.text, stage.imagePath));
    }
    const eventClient = await timed(stageTimings, "open_session_event_client_ms", () => getSessionEventClient());
    const answerRun = await requestAnswer(client, eventClient, stage.id, transcriptPrompt(scenario.id, stage));
    eventClient.close();
    answerRun.actionTimings = { ...stageTimings, ...answerRun.actionTimings };
    const validation = validateScenarioStageAnswer(scenario.id, stage, answerRun);
    const codeChangedFromPreviousStage = previousCode ? validation.code !== previousCode : null;
    previousCode = validation.code || previousCode;
    stages.push({
      id: stage.id,
      order: stage.order,
      ok: validation.ok,
      failures: validation.failures,
      screenshot: stage.imagePath,
      codeFixture: stage.codePath,
      expected: stage.expectedPath,
      transcriptDelta: stage.transcriptPath,
      screen: {
        hasScreenshot: Boolean(stage.imagePath),
        textChars: screen.text.length,
        textPreview: screen.text.slice(0, 700),
        ocrOk: screen.ocrResult?.ok ?? null,
        ocrConfidence: screen.ocrResult?.confidence ?? null,
        visionOk: screen.visionResult?.ok ?? null,
      },
      continuity: {
        sessionId,
        sameSessionAsPreviousStage: true,
        codeChangedFromPreviousStage,
      },
      answer: {
        label: answerRun.label,
        completed: answerRun.completed,
        failed: answerRun.failed,
        latencyMs: answerRun.latencyMs,
        requestId: answerRun.requestId,
        actionTimings: answerRun.actionTimings,
        renderedText: answerRun.renderedText,
        parsed_output: answerRun.structured,
        final_rendered_output: answerRun.renderedText,
        raw_model_output: answerRun.rawModelOutput ?? null,
        raw_model_output_stage: answerRun.rawModelOutputStage ?? null,
        raw_model_output_available: Boolean(answerRun.rawModelOutput),
      },
    });
    if (!validation.ok) {
      ok = false;
      break;
    }
  }

  return {
    loop,
    scenarioId: scenario.id,
    sessionId,
    actionTimings,
    stages,
    ok,
  };
};

const run = async () => {
  if (!fs.existsSync(electronBin)) throw new Error(`Electron binary not found: ${electronBin}`);
  if (useVision && requestedProvider === "groq") {
    throw new Error("Groq replay currently supports answer generation only. Run without --vision, or use NVIDIA/OpenAI for screenshot vision.");
  }
  const stageScenario = readStageScenario();
  const cases = stageScenario ? [] : readCases();
  if (stageScenario) {
    for (const stage of stageScenario.stages) {
      if (stage.imagePath && !fs.existsSync(stage.imagePath)) throw new Error(`Screenshot not found for ${stageScenario.id}/${stage.id}: ${stage.imagePath}`);
    }
  } else {
    for (const replayCase of cases) {
      const { imagePath, fallbackText } = resolveCasePaths(replayCase);
      if (imagePath && !fs.existsSync(imagePath)) throw new Error(`Screenshot not found for ${replayCase.id}: ${imagePath}`);
      if (!imagePath && !fallbackText) throw new Error(`Case ${replayCase.id} needs screenshot, screenText, or screenTextFile.`);
    }
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
  const report: Record<string, any> = {
    runId: `live-coding-replay-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    provider: requestedProvider,
    modelName,
    corpus: corpusPath || null,
    scenario: stageScenario ? { id: stageScenario.id, path: stageScenario.scenarioPath, stageCount: stageScenario.stages.length } : null,
    caseCount: stageScenario ? 1 : cases.length,
    raw_model_output_available: "after_session_trace",
    cases: [],
    actionTimings: {},
  };

  try {
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/list`, 25000);
    const mainTarget = await getPageTarget((target) => !String(target.url).includes("#/overlay") && !String(target.url).includes("#/coding"), 15000);
    if (!mainTarget?.webSocketDebuggerUrl) throw new Error("Could not find Electron main renderer target");
    client = await cdp(mainTarget.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    const bridgeReady = await evaluate<boolean>(client, waitForBridgeExpression);
    if (!bridgeReady) throw new Error("Desktop bridge did not become ready");
    if (stageScenario) {
      const scenarioReport: Record<string, any> = {
        id: stageScenario.id,
        scenarioPath: stageScenario.scenarioPath,
        difficulty: stageScenario.difficulty ?? null,
        loops: [],
      };
      for (let index = 1; index <= loops; index += 1) {
        const result = await runStageScenarioLoop(client, stageScenario, index);
        scenarioReport.loops.push(result);
        if (!result.ok) break;
      }
      scenarioReport.ok = scenarioReport.loops.length === loops && scenarioReport.loops.every((item: any) => item.ok);
      report.cases.push(scenarioReport);
    } else {
      for (const replayCase of cases) {
        const { imagePath, fallbackText } = resolveCasePaths(replayCase);
        const caseTimings: Record<string, number> = {};
        const screen = await timed(caseTimings, "resolve_screen_text_ms", () => resolveScreenText(client!, imagePath, fallbackText, caseTimings));
        const caseReport: Record<string, any> = {
          id: replayCase.id,
          screenshot: imagePath || null,
          followups: replayCase.followups,
          actionTimings: caseTimings,
          screen: {
            textChars: screen.text.length,
            textPreview: screen.text.slice(0, 700),
            ocrOk: screen.ocrResult?.ok ?? null,
            ocrConfidence: screen.ocrResult?.confidence ?? null,
            visionOk: screen.visionResult?.ok ?? null,
          },
          loops: [],
        };
        if (!screen.text.trim()) throw new Error(`Screen text is empty after OCR/manual input for ${replayCase.id}.`);
        for (let index = 1; index <= loops; index += 1) {
          const result = await runLoop(client, replayCase, index, screen.text, imagePath);
          caseReport.loops.push({
            loop: result.loop,
            ok: result.ok,
            expectedFunction: result.expectedFunction,
            checks: result.checks,
            turns: result.turns.map((turn) => ({
              label: turn.label,
              completed: turn.completed,
              failed: turn.failed,
              latencyMs: turn.latencyMs,
              requestId: turn.requestId,
              actionTimings: turn.actionTimings,
              renderedText: turn.renderedText,
              parsed_output: turn.structured,
              final_rendered_output: turn.renderedText,
              raw_model_output: turn.rawModelOutput ?? null,
              raw_model_output_stage: turn.rawModelOutputStage ?? null,
              raw_model_output_available: Boolean(turn.rawModelOutput),
            })),
          });
          if (!result.ok) break;
        }
        caseReport.ok = caseReport.loops.length === loops && caseReport.loops.every((item: any) => item.ok);
        report.cases.push(caseReport);
        if (!caseReport.ok) break;
      }
    }
    report.ok = report.cases.length === (stageScenario ? 1 : cases.length) && report.cases.every((item: any) => item.ok);
    const traceStatus = await evaluate<any>(client, "window.callpilotDesktop.getSessionTraceStatus()");
    const endSession = await evaluate<any>(client, "window.callpilotDesktop.endSession()");
    report.trace = { status: traceStatus, endSession };
    report.traceSummary = summarizeTrace(endSession?.tracePath || traceStatus?.path || "");
    const rawByRequestId = new Map<string, any>();
    for (const item of report.traceSummary?.rawModelOutputs ?? []) {
      if (item.requestId) rawByRequestId.set(item.requestId, item);
    }
    for (const caseReport of report.cases) {
      for (const loop of caseReport.loops ?? []) {
        for (const turn of loop.turns ?? []) {
          const raw = turn.requestId ? rawByRequestId.get(turn.requestId) : null;
          if (!turn.raw_model_output && raw?.text) {
            turn.raw_model_output = raw.text;
            turn.raw_model_output_stage = raw.stage ?? null;
            turn.raw_model_output_available = true;
          }
        }
        for (const stage of loop.stages ?? []) {
          const answer = stage.answer;
          const raw = answer?.requestId ? rawByRequestId.get(answer.requestId) : null;
          if (answer && !answer.raw_model_output && raw?.text) {
            answer.raw_model_output = raw.text;
            answer.raw_model_output_stage = raw.stage ?? null;
            answer.raw_model_output_available = true;
          }
        }
      }
    }
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
    console.log(JSON.stringify({ ok: report.ok, provider: requestedProvider, modelName, cases: report.cases?.length ?? 0 }, null, 2));
    client?.close();
    electron.kill();
    mockOpenAI.close();
  }
};

await run();
