import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createLatencyMetricRun,
  detectQuestionIntent,
  markLatencyStage,
  type PreferredLanguage,
} from "../../../src/core/index.ts";

type Track = "no-answer" | "coding-fixtures" | "real-behavioral" | "all";

interface NoAnswerCase {
  scenarioId: string;
  language: PreferredLanguage;
  text: string;
  expected: {
    answerNeeded: boolean;
    intent: "no_answer";
  };
}

interface CodingTurn {
  turnId: number;
  prompt_transcript: string;
  expected_behavior: string;
  test_cases?: string;
}

interface CodingScenario {
  scenarioId: string;
  language: string;
  turns: CodingTurn[];
}

interface RunResult {
  scenarioId: string;
  track: string;
  run: number;
  deterministicChecks: Record<string, boolean>;
  judge: null;
  latency_ms: {
    first_token: number | null;
    total: number;
  };
  diagnostics: Record<string, unknown>;
}

interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { loadDotEnv } = require("../../../electron/env.cjs");
loadDotEnv(root);

const fixturesDir = path.join(root, "tests", "fixtures");
const reportsDir = path.join(root, "tests", "e2e", "reports");
const tmpDir = path.join(root, ".cache", "e2e");
const electronBin = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");

const argValue = (name: string): string => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
};

const selectedTrack = (argValue("--track") || "all") as Track;
const runNumber = Number(argValue("--run") || "1");
const debugPort = Number(process.env.CALLPILOT_E2E_DEBUG_PORT || "9359");
const maxRealCalls = Number(process.env.E2E_MAX_REAL_CALLS || "0");
let realCalls = 0;

const readJson = <T>(relativePath: string): T =>
  JSON.parse(fs.readFileSync(path.join(fixturesDir, relativePath), "utf8")) as T;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const finishLatency = (label: string, startedStage: "audio_or_screen_capture" | "model_call_start" = "model_call_start") => {
  const started = markLatencyStage(createLatencyMetricRun(label), startedStage);
  const completed = markLatencyStage(started, "response_complete");
  const responseComplete = completed.events.find((event) => event.stage === "response_complete");
  return {
    first_token: null,
    total: responseComplete?.elapsedMs ?? 0,
  };
};

const checkBudget = (nextCalls = 0) => {
  if (realCalls + nextCalls > maxRealCalls) {
    throw new Error(`E2E real call budget exceeded: requested ${realCalls + nextCalls}/${maxRealCalls}`);
  }
};

const recordRealCall = () => {
  checkBudget(1);
  realCalls += 1;
};

const intentForDetection = (shouldDispatch: boolean) => shouldDispatch ? "answer" : "no_answer";

const runNoAnswer = (): RunResult[] => {
  const fixture = readJson<{ cases: NoAnswerCase[] }>("no-answer.track-c.json");
  return fixture.cases.map((scenario) => {
    const detection = detectQuestionIntent(scenario.text, scenario.language);
    const actualIntent = intentForDetection(detection.shouldDispatch);
    const deterministicChecks = {
      latestQuestionAnswered: !scenario.expected.answerNeeded ? !detection.shouldAnswer : detection.shouldAnswer,
      answerNeededCorrect: detection.shouldDispatch === scenario.expected.answerNeeded,
      intentCorrect: actualIntent === scenario.expected.intent,
      confidenceBelowAutoAnswerThreshold: detection.confidence < 0.45,
    };
    return {
      scenarioId: scenario.scenarioId,
      track: "no_answer",
      run: runNumber,
      deterministicChecks,
      judge: null,
      latency_ms: finishLatency("track-c-no-answer"),
      diagnostics: {
        text: scenario.text,
        expected: scenario.expected,
        detection,
      },
    };
  });
};

const hasSequentialTurnIds = (turns: CodingTurn[]) =>
  turns.every((turn, index) => turn.turnId === index + 1);

const runCodingFixtureValidation = (): RunResult[] => {
  const fixture = readJson<{ live_coding_evolutivo: CodingScenario[] }>("text-fixtures.batch1.json");
  return fixture.live_coding_evolutivo.map((scenario) => {
    const testCaseTurns = scenario.turns.filter((turn) => typeof turn.test_cases === "string" && turn.test_cases.trim());
    const deterministicChecks = {
      hasScenarioId: Boolean(scenario.scenarioId),
      hasAtLeastFourTurns: scenario.turns.length >= 4,
      hasSequentialTurnIds: hasSequentialTurnIds(scenario.turns),
      hasPromptsForEveryTurn: scenario.turns.every((turn) => Boolean(turn.prompt_transcript?.trim())),
      hasExpectedBehaviorForEveryTurn: scenario.turns.every((turn) => Boolean(turn.expected_behavior?.trim())),
    };
    return {
      scenarioId: scenario.scenarioId,
      track: "live_coding_evolutivo_fixture_validation",
      run: runNumber,
      deterministicChecks,
      judge: null,
      latency_ms: finishLatency("track-f-fixture-validation"),
      diagnostics: {
        language: scenario.language,
        turnCount: scenario.turns.length,
        testCaseTurnIds: testCaseTurns.map((turn) => turn.turnId),
      },
    };
  });
};

const waitForHttp = async (url: string, timeoutMs = 25000): Promise<Response> => {
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

const cdp = async (targetUrl: string): Promise<CdpClient> => {
  const socket = new WebSocket(targetUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
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

const evaluate = async <T = any>(client: CdpClient, expression: string): Promise<T> => {
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

const getPageTargets = async () => {
  const response = await waitForHttp(`http://127.0.0.1:${debugPort}/json/list`);
  return await response.json() as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
};

const getPageTarget = async (predicate: (target: { type: string; url: string }) => boolean, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await getPageTargets();
    const found = targets.find((target) => target.type === "page" && predicate(target));
    if (found?.webSocketDebuggerUrl) return found;
    await sleep(150);
  }
  return null;
};

const audioMimeType = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/m4a";
  if (ext === ".mp4") return "audio/mp4";
  return "audio/webm";
};

const generateWindowsSpeechAudio = (text: string, outputPath: string): boolean => {
  if (process.platform !== "win32") return false;
  const escapedText = text.replace(/'/g, "''");
  const escapedPath = outputPath.replace(/'/g, "''");
  const command = [
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$synth.SetOutputToWaveFile('${escapedPath}')`,
    `$synth.Speak('${escapedText}')`,
    "$synth.Dispose()",
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
  });
  return result.status === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
};

const resolveBehavioralAudio = () => {
  const provided = process.env.E2E_AUDIO_PATH || argValue("--audio");
  if (provided) {
    const absolute = path.resolve(root, provided);
    if (!fs.existsSync(absolute)) throw new Error(`E2E audio file not found: ${absolute}`);
    return { path: absolute, generated: false };
  }

  fs.mkdirSync(tmpDir, { recursive: true });
  const audioPath = path.join(tmpDir, `behavioral-${Date.now()}.wav`);
  const spokenText = "Tell me about a time you handled a production incident.";
  if (!generateWindowsSpeechAudio(spokenText, audioPath)) {
    throw new Error("Could not generate temporary speech audio. Set E2E_AUDIO_PATH to a real audio file.");
  }
  return { path: audioPath, generated: true };
};

const seedSessionExpression = (session: unknown) => `
  (() => {
    window.localStorage.setItem("callpilot_v0_session", ${JSON.stringify(JSON.stringify(session))});
    window.location.reload();
    return true;
  })()
`;

const waitForBridgeExpression = `new Promise((resolve) => {
  const started = performance.now();
  const tick = () => {
    if (window.callpilotDesktop?.startSession && window.callpilotDesktop?.transcribeAudio && window.callpilotDesktop?.requestAnswer) {
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

const makeSession = (transcriptText: string, modelName: string) => {
  const now = Date.now();
  return {
    id: `e2e-behavioral-${now}`,
    title: "E2E behavioral checkpoint",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    activeMode: "behavioral",
    transcript: {
      messages: [{
        id: `tr-${now}-1`,
        text: transcriptText,
        timestamp: now,
        source: "stt",
        speaker: "interviewer",
      }],
      paused: false,
      updatedAt: now,
    },
    screenText: "",
    companyName: "",
    roleTitle: "Backend Engineer",
    resumeText: "Backend engineer with payments migration experience and production incident runbooks.",
    starStories: "Handled a production payment incident by coordinating mitigation, adding runbooks, and reducing recurrence.",
    jobDescription: "Backend role focused on reliability, incident response, and clear communication.",
    notes: "",
    profile: "backend engineer, payments migration, reduced incident recurrence with runbooks",
    targetUseCase: "technical interview preparation",
    preferredLanguage: "english",
    codingLanguage: "Python",
    answerVerbosity: "medium",
    modelProvider: "openai",
    modelName,
    question: "",
    answer: "",
  };
};

const runRealBehavioral = async (): Promise<RunResult[]> => {
  if (!process.env.OPENAI_API_KEY) {
    return [{
      scenarioId: "behavioralQuestion",
      track: "real_behavioral_ipc",
      run: runNumber,
      deterministicChecks: {
        openAIKeyAvailable: false,
        transcriptionSucceeded: false,
        answerCompleted: false,
      },
      judge: null,
      latency_ms: finishLatency("real-behavioral-blocked"),
      diagnostics: {
        blocked: true,
        reason: "OPENAI_API_KEY is required for --track=real-behavioral",
        availableEnvKeys: {
          hasNvidiaKey: Boolean(process.env.NVIDIA_API_KEY || process.env.CALLPILOT_NVIDIA_API_KEY),
          hasNativelyKey: Boolean(process.env.NATIVELY_API_KEY),
          hasOpenAIBaseUrl: Boolean(process.env.CALLPILOT_OPENAI_BASE_URL),
        },
      },
    }];
  }
  checkBudget(2);
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing. Run npm run build before --track=real-behavioral.");
  }

  const modelName = process.env.E2E_OPENAI_MODEL || process.env.CALLPILOT_E2E_OPENAI_MODEL || "gpt-4o-mini";
  const transcriptionModelName = process.env.E2E_TRANSCRIPTION_MODEL || "gpt-4o-transcribe";
  const audio = resolveBehavioralAudio();
  const userDataDir = path.join(tmpDir, `user-data-${Date.now()}`);
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
  electron.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  electron.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let client: CdpClient | null = null;
  let overlayClient: CdpClient | null = null;

  try {
    const mainTarget = await getPageTarget((target) => !target.url.includes("#/overlay") && !target.url.includes("#/coding"), 30000);
    if (!mainTarget?.webSocketDebuggerUrl) {
      throw new Error(`Could not find Electron main target.\nstdout:\n${stdout.slice(-1200)}\nstderr:\n${stderr.slice(-1200)}`);
    }
    client = await cdp(mainTarget.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    const hasBridge = await evaluate<boolean>(client, waitForBridgeExpression);
    if (!hasBridge) throw new Error("Desktop bridge did not become available in renderer");

    await evaluate(client, `window.callpilotDesktop.saveSettings(${JSON.stringify({
      activeMode: "behavioral",
      preferredLanguage: "english",
      defaultCodingLanguage: "Python",
      answerVerbosity: "medium",
      modelProvider: "openai",
      modelName,
      ollamaBaseUrl: "http://localhost:11434",
      transcriptionModelName,
      liveTranscriptionProvider: "local",
      liveLatencyPreset: "balanced",
      liveAudioSource: "both",
      autoAnswerCooldownMs: 12000,
      autoAnswerMinConfidence: 0.45,
    })})`);

    const audioBuffer = fs.readFileSync(audio.path);
    const audioBase64 = audioBuffer.toString("base64");
    const transcribeStarted = createLatencyMetricRun("real-behavioral-stt");
    const transcribeCapture = markLatencyStage(transcribeStarted, "audio_or_screen_capture");
    recordRealCall();
    const transcriptResult = await evaluate<{ ok: boolean; text: string; modelName?: string; error?: string }>(client, `window.callpilotDesktop.transcribeAudio({
      arrayBuffer: Uint8Array.from(atob(${JSON.stringify(audioBase64)}), (char) => char.charCodeAt(0)).buffer,
      fileName: ${JSON.stringify(path.basename(audio.path))},
      mimeType: ${JSON.stringify(audioMimeType(audio.path))},
      modelName: ${JSON.stringify(transcriptionModelName)},
      provider: "openai"
    })`);
    const transcribeDone = markLatencyStage(transcribeCapture, "transcription_or_vision_done");
    if (!transcriptResult.ok || !transcriptResult.text?.trim()) {
      throw new Error(`Real transcription failed: ${transcriptResult.error || "empty_transcription"}`);
    }

    const session = makeSession(transcriptResult.text, modelName);
    await evaluate(client, seedSessionExpression(session));
    const bridgeAfterReload = await evaluate<boolean>(client, waitForBridgeExpression);
    if (!bridgeAfterReload) throw new Error("Desktop bridge did not recover after session seed reload");

    await evaluate(client, `window.callpilotDesktop.startSession({ mode: "behavioral" })`);
    const overlayTarget = await getPageTarget((target) => target.url.includes("#/overlay"), 10000);
    if (!overlayTarget?.webSocketDebuggerUrl) throw new Error("Overlay target did not open for real behavioral run");
    overlayClient = await cdp(overlayTarget.webSocketDebuggerUrl);
    await overlayClient.send("Runtime.enable");
    await evaluate(overlayClient, waitForBridgeExpression);
    await evaluate(overlayClient, `(() => {
      window.__callpilotE2EEvents = [];
      window.__callpilotE2EDispose = [
        window.callpilotDesktop.onAnswerStatus((payload) => window.__callpilotE2EEvents.push({ type: "status", at: Date.now(), payload })),
        window.callpilotDesktop.onStructuredAnswer((payload) => window.__callpilotE2EEvents.push({ type: "structured", at: Date.now(), payload }))
      ];
      return true;
    })()`);

    const answerStarted = markLatencyStage(createLatencyMetricRun("real-behavioral-answer"), "model_call_start");
    recordRealCall();
    const requestResult = await evaluate<{ ok: boolean; error?: string }>(client, `window.callpilotDesktop.requestAnswer()`);
    if (!requestResult.ok) throw new Error(`answer:request failed: ${requestResult.error || "unknown"}`);

    const answerEvents = await evaluate<Array<{ type: string; at: number; payload: any }>>(overlayClient, `new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const events = window.__callpilotE2EEvents || [];
        const terminal = events.find((event) => event.type === "status" && ["completed", "failed", "cancelled"].includes(event.payload?.status));
        if (terminal || Date.now() - started > 45000) {
          resolve(events);
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    })`);
    const answerDone = markLatencyStage(answerStarted, "response_complete");
    const completed = answerEvents.find((event) => event.type === "status" && event.payload?.status === "completed");
    const failed = answerEvents.find((event) => event.type === "status" && event.payload?.status === "failed");
    const structured = answerEvents.find((event) => event.type === "structured");
    const answerText = String(completed?.payload?.text || structured?.payload?.renderedText || "");

    const traceStatus = await evaluate<any>(client, `window.callpilotDesktop.getSessionTraceStatus()`);
    const endSession = await evaluate<any>(client, `window.callpilotDesktop.endSession()`);
    const tracePath = endSession?.tracePath || traceStatus?.path || "";
    const trace = tracePath && fs.existsSync(tracePath)
      ? JSON.parse(fs.readFileSync(tracePath, "utf8"))
      : null;
    const promptTrace = Array.isArray(trace?.events)
      ? [...trace.events].reverse().find((event: any) => event.type === "model_generate_started")?.prompt
      : null;

    const totalLatency = answerDone.events.find((event) => event.stage === "response_complete")?.elapsedMs ?? 0;
    const sttLatency = transcribeDone.events.find((event) => event.stage === "transcription_or_vision_done")?.elapsedMs ?? 0;
    const deterministicChecks = {
      transcriptionSucceeded: transcriptResult.ok && transcriptResult.text.trim().length > 0,
      answerRequestAccepted: requestResult.ok,
      answerCompleted: Boolean(completed) && !failed,
      answerNonEmpty: answerText.trim().length > 40,
      traceRecorded: Boolean(tracePath && traceStatus?.eventCount >= 3),
      promptSentRecorded: Boolean(promptTrace),
    };

    return [{
      scenarioId: "behavioralQuestion",
      track: "real_behavioral_ipc",
      run: runNumber,
      deterministicChecks,
      judge: null,
      latency_ms: {
        first_token: null,
        total: totalLatency,
      },
      diagnostics: {
        audio: {
          generated: audio.generated,
          fileName: path.basename(audio.path),
          bytes: audioBuffer.length,
        },
        transcript_result: transcriptResult.text,
        answer_received: answerText,
        prompt_sent: promptTrace,
        stt_latency_ms: sttLatency,
        answer_events: answerEvents.map((event) => ({
          type: event.type,
          status: event.payload?.status,
          answerKind: event.payload?.answer?.kind,
          textPreview: String(event.payload?.text || event.payload?.renderedText || "").slice(0, 240),
        })),
        trace: {
          path: tracePath,
          eventCount: traceStatus?.eventCount,
        },
      },
    }];
  } finally {
    overlayClient?.close();
    client?.close();
    electron.kill();
    if (audio.generated) fs.rmSync(audio.path, { force: true });
  }
};

const run = async () => {
  checkBudget();
  const results = [
    ...(selectedTrack === "all" || selectedTrack === "no-answer" ? runNoAnswer() : []),
    ...(selectedTrack === "all" || selectedTrack === "coding-fixtures" ? runCodingFixtureValidation() : []),
    ...(selectedTrack === "real-behavioral" ? await runRealBehavioral() : []),
  ];

  if (results.length === 0) {
    throw new Error(`Unknown or empty track: ${selectedTrack}`);
  }

  const failed = results.filter((result) => !Object.values(result.deterministicChecks).every(Boolean));
  const report = {
    generatedAt: new Date().toISOString(),
    runner: "tests/e2e/runner/sessionRunner.ts",
    track: selectedTrack,
    costGuard: {
      maxRealCalls,
      realCalls,
    },
    totals: {
      scenarios: results.length,
      failed: failed.length,
      passed: results.length - failed.length,
    },
    results,
  };

  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `continuous-eval-${stamp}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    reportPath,
    ...report.totals,
    failedScenarioIds: failed.map((result) => result.scenarioId),
    costGuard: report.costGuard,
  }, null, 2));

  if (failed.length > 0) process.exitCode = 1;
};

await run();
