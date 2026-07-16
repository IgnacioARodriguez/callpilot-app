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

type Track =
  | "no-answer"
  | "coding-fixtures"
  | "coding-objective-smoke"
  | "real-behavioral"
  | "real-coding"
  | "real-coding-multiturn"
  | "real-suite"
  | "real-text-interview"
  | "real-text-interview-batch"
  | "real-natively-interview"
  | "all";

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

interface TextInterviewTurn {
  speaker: "interviewer" | "candidate" | "assistant" | "unknown";
  text: string;
}

interface TextInterviewScenario {
  scenarioId: string;
  turns: TextInterviewTurn[];
  trigger_turn: number;
  expected_behavior: Record<string, unknown>;
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
const realBatchLimit = Math.max(1, Number(process.env.E2E_REAL_BATCH_LIMIT || "3"));
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

const runPythonAssertions = (code: string, assertions: string[]) => {
  fs.mkdirSync(tmpDir, { recursive: true });
  const scriptPath = path.join(tmpDir, `python-objective-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  const script = [
    code.trim(),
    "",
    ...assertions,
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    const result = spawnSync(process.env.PYTHON || "python", [scriptPath], {
      cwd: tmpDir,
      encoding: "utf8",
      timeout: 5000,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: Boolean(result.error && /timed?out/i.test(result.error.message)),
    };
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
};

const extractPythonCode = (text: string): string => {
  const jsonCandidates = [
    text.trim(),
    text.match(/```json\s*([\s\S]*?)```/i)?.[1]?.trim() ?? "",
  ].filter(Boolean);
  for (const candidate of jsonCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      const code = parsed?.kind === "coding" ? parsed?.payload?.solution?.code : null;
      if (typeof code === "string" && code.trim()) return code.trim();
    } catch {}
  }
  const fencedBlocks = [...text.matchAll(/```(?:python|py)\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  const exactFunctionBlock = fencedBlocks.find((block) => /\bdef\s+two_sum\s*\(/.test(block));
  if (exactFunctionBlock) return exactFunctionBlock;
  const fenced = fencedBlocks[0];
  if (fenced) return fenced;
  const defIndex = text.search(/\bdef\s+two_sum\s*\(/);
  if (defIndex >= 0) return text.slice(defIndex).replace(/\*\*[\s\S]*$/m, "").trim();
  return "";
};

const normalizeForChecks = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const termsFrom = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(termsFrom);
  if (typeof value !== "string") return [];
  return normalizeForChecks(value)
    .match(/[a-z0-9_+#.-]{4,}/g)
    ?.filter((term) => !new Set(["debe", "para", "cuando", "como", "with", "that", "this", "must", "real"]).has(term)) ?? [];
};

const hasAnyTerm = (answer: string, value: unknown): boolean => {
  const normalized = normalizeForChecks(answer);
  const terms = termsFrom(value);
  return terms.length === 0 || terms.some((term) => normalized.includes(term));
};

const hasLikelySpanish = (answer: string): boolean =>
  /\b(para|cuando|porque|respuesta|correccion|usaria|deberia|indices|lectura|escritura)\b/i.test(normalizeForChecks(answer));

const hasLikelyEnglish = (answer: string): boolean =>
  /\b(the|when|because|would|should|answer|mitigate|concurrency|package|runtime)\b/i.test(normalizeForChecks(answer));

const evaluateTextInterviewChecks = (scenario: TextInterviewScenario, answerText: string, failed: unknown, traceRecorded: boolean) => {
  const expected = scenario.expected_behavior ?? {};
  const normalized = normalizeForChecks(answerText);
  const expectedLanguage = expected.language;
  const expectedTopics = expected.expected_topics;
  const correctionContent = expected.correction_content;
  const referent = expected.must_resolve_referent;
  return {
    answerCompleted: !failed,
    answerNonEmpty: answerText.trim().length > 40,
    expectedLanguageRespected: expectedLanguage === "en" ? hasLikelyEnglish(answerText) : hasLikelySpanish(answerText),
    expectedTopicMentioned: hasAnyTerm(answerText, expectedTopics ?? correctionContent ?? referent),
    correctionWhenExpected: expected.must_correct_candidate_error ? (
      /(?:no|not|correccion|corregiria|en realidad|actually|rather|instead)/i.test(normalized)
      || hasAnyTerm(answerText, correctionContent)
    ) : true,
    doesNotExposeEmptyResume: !/\bresume|cv|star stor/i.test(answerText),
    noQuestionMarkMojibake: !/\?\?/.test(answerText),
    traceRecorded,
  };
};

const runCodingObjectiveSmoke = (): RunResult[] => {
  const fixture = readJson<{ live_coding_evolutivo: CodingScenario[] }>("text-fixtures.batch1.json");
  const scenario = fixture.live_coding_evolutivo.find((item) => item.scenarioId === "coding_evol_two_sum");
  const assertions = scenario?.turns
    .map((turn) => turn.test_cases?.trim())
    .filter((value): value is string => Boolean(value)) ?? [];
  const code = `
def two_sum(nums, target):
    seen = {}
    for index, value in enumerate(nums):
        complement = target - value
        if complement in seen:
            return [seen[complement], index]
        seen[value] = index
    return None
`;
  const execution = assertions.length > 0
    ? runPythonAssertions(code, assertions)
    : { ok: false, status: null, stdout: "", stderr: "missing assertions", timedOut: false };
  const deterministicChecks = {
    scenarioFound: Boolean(scenario),
    hasAccumulatedAssertions: assertions.length >= 2,
    pythonExecutionPassed: execution.ok,
    didNotTimeout: !execution.timedOut,
  };
  return [{
    scenarioId: "coding_evol_two_sum",
    track: "live_coding_objective_smoke",
    run: runNumber,
    deterministicChecks,
    judge: null,
    latency_ms: finishLatency("track-f-objective-smoke"),
    diagnostics: {
      assertions,
      execution,
    },
  }];
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

const readPcmWavAsMono16k = (filePath: string): Buffer => {
  const wav = fs.readFileSync(filePath);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Expected WAV audio for Natively PCM test: ${filePath}`);
  }
  let offset = 12;
  let channels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let audioFormat = 1;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      audioFormat = wav.readUInt16LE(start);
      channels = wav.readUInt16LE(start + 2);
      sampleRate = wav.readUInt32LE(start + 4);
      bitsPerSample = wav.readUInt16LE(start + 14);
    }
    if (id === "data") {
      dataStart = start;
      dataSize = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (audioFormat !== 1 || bitsPerSample !== 16 || dataStart < 0 || dataSize <= 0) {
    throw new Error(`Unsupported WAV format for Natively PCM test: format=${audioFormat} bits=${bitsPerSample}`);
  }
  const frames = Math.floor(dataSize / (channels * 2));
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const sampleOffset = dataStart + (frame * channels + channel) * 2;
      sum += wav.readInt16LE(sampleOffset) / 32768;
    }
    mono[frame] = sum / channels;
  }
  const outputRate = 16000;
  const ratio = sampleRate / outputRate;
  const outputLength = sampleRate === outputRate ? mono.length : Math.max(1, Math.floor(mono.length / ratio));
  const output = Buffer.alloc(outputLength * 2);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = sampleRate === outputRate ? index : index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(mono.length - 1, left + 1);
    const weight = sourceIndex - left;
    const sample = sampleRate === outputRate
      ? mono[index] ?? 0
      : (mono[left] ?? 0) * (1 - weight) + (mono[right] ?? 0) * weight;
    const clamped = Math.max(-1, Math.min(1, sample));
    output.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), index * 2);
  }
  return output;
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
  const spokenText = "Describe a production incident you handled.";
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

const makeTextInterviewSession = (
  scenario: TextInterviewScenario,
  provider: "openai" | "nvidia",
  modelName: string,
) => {
  const now = Date.now();
  return {
    id: `e2e-text-${scenario.scenarioId}-${now}`,
    title: `E2E ${scenario.scenarioId}`,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    activeMode: "technical_qa",
    transcript: {
      messages: scenario.turns.map((turn, index) => ({
        id: `tr-${now}-${index + 1}`,
        text: turn.text,
        timestamp: now + index,
        source: "stt",
        speaker: turn.speaker,
      })),
      paused: false,
      updatedAt: now + scenario.turns.length,
    },
    screenText: "",
    companyName: "",
    roleTitle: "Backend Engineer",
    resumeText: "",
    starStories: "",
    jobDescription: "Backend interview with concise technical follow-ups.",
    notes: "",
    profile: "",
    targetUseCase: "technical interview preparation",
    preferredLanguage: scenario.expected_behavior?.language === "en" ? "english" : "spanish",
    codingLanguage: "Python",
    answerVerbosity: "medium",
    modelProvider: provider,
    modelName,
    question: "",
    answer: "",
  };
};

const makeCodingSession = (
  scenario: CodingScenario,
  provider: "openai" | "nvidia",
  modelName: string,
  turnCount = 1,
  assistantAnswers: string[] = [],
) => {
  const now = Date.now();
  const firstTurn = scenario.turns[0]?.prompt_transcript ?? "Solve Two Sum in Python.";
  const selectedTurns = scenario.turns.slice(0, Math.max(1, turnCount));
  const messages = selectedTurns.flatMap((turn, index) => {
    const interviewerMessage = {
      id: `turn-${now}-${turn.turnId}-interviewer`,
      speaker: "interviewer",
      text: turn.prompt_transcript,
      timestamp: now + index * 2,
    };
    const assistantAnswer = assistantAnswers[index];
    return assistantAnswer
      ? [
        interviewerMessage,
        {
          id: `turn-${now}-${turn.turnId}-assistant`,
          speaker: "assistant",
          text: assistantAnswer,
          timestamp: now + index * 2 + 1,
        },
      ]
      : [interviewerMessage];
  });
  const screenText = [
    "Two Sum",
    "Python function signature:",
    "def two_sum(nums, target):",
    "Given an integer array nums and an integer target, return indices of the two numbers such that they add up to target.",
    "Return None when there is no solution.",
    "Example: nums = [2, 7, 11, 15], target = 9 -> [0, 1].",
  ].join("\n");
  return {
    id: `e2e-coding-${now}`,
    title: "E2E live coding checkpoint",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    activeMode: "live_coding",
    transcript: {
      messages,
      paused: false,
      updatedAt: now + messages.length,
    },
    screenText,
    companyName: "",
    roleTitle: "Backend Engineer",
    resumeText: "",
    starStories: "",
    jobDescription: "Live coding interview. Keep code correct and concise.",
    notes: "Preserve the exact function name two_sum. In Spanish, 'sin que explote' means handle no-solution gracefully without crashing; do not intentionally raise.",
    profile: "",
    targetUseCase: "live coding interview",
    preferredLanguage: scenario.language === "python" ? "spanish" : "english",
    codingLanguage: "Python",
    answerVerbosity: "medium",
    modelProvider: provider,
    modelName,
    question: selectedTurns.at(-1)?.prompt_transcript ?? firstTurn,
    answer: "",
  };
};

const makeEmptyInterviewSession = (provider: "openai" | "nvidia", modelName: string, activeMode: "technical_qa" | "behavioral") => {
  const now = Date.now();
  return {
    id: `e2e-natively-${now}`,
    title: "E2E Natively interview",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    activeMode,
    transcript: {
      messages: [],
      paused: false,
      updatedAt: now,
    },
    screenText: "",
    companyName: "",
    roleTitle: "Backend Engineer",
    resumeText: "",
    starStories: "",
    jobDescription: "Backend interview with concise technical follow-ups.",
    notes: "",
    profile: "",
    targetUseCase: "technical interview preparation",
    preferredLanguage: "english",
    codingLanguage: "Python",
    answerVerbosity: "medium",
    modelProvider: provider,
    modelName,
    question: "",
    answer: "",
  };
};

const waitForAnswerEvents = async (
  mainClient: CdpClient,
  provider: string,
  modelName: string,
  options: { startSession?: boolean; mode?: "technical_qa" | "behavioral" | "live_coding"; timeoutMs?: number } = {},
) => {
  if (options.startSession !== false) {
    await evaluate(mainClient, `window.callpilotDesktop.startSession({ mode: ${JSON.stringify(options.mode ?? "technical_qa")} })`);
  }
  const overlayTarget = await getPageTarget((target) => target.url.includes("#/overlay"), 10000);
  if (!overlayTarget?.webSocketDebuggerUrl) throw new Error("Overlay target did not open for text interview run");
  const overlayClient = await cdp(overlayTarget.webSocketDebuggerUrl);
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

  recordRealCall();
  const requestResult = await evaluate<{ ok: boolean; error?: string }>(mainClient, `window.callpilotDesktop.requestAnswer()`);
  if (!requestResult.ok) throw new Error(`answer:request failed: ${requestResult.error || "unknown"}`);
  const events = await evaluate<Array<{ type: string; at: number; payload: any }>>(overlayClient, `new Promise((resolve) => {
    const started = Date.now();
    const timeoutMs = ${JSON.stringify(options.timeoutMs ?? 45000)};
    const tick = () => {
      const events = window.__callpilotE2EEvents || [];
      const terminal = events.find((event) => event.type === "status" && ["completed", "failed", "cancelled"].includes(event.payload?.status));
      if (terminal || Date.now() - started > timeoutMs) {
        resolve(events);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  })`);
  overlayClient.close();
  const completed = events.find((event) => event.type === "status" && event.payload?.status === "completed");
  const structured = events.find((event) => event.type === "structured");
  return {
    provider,
    modelName,
    requestResult,
    events,
    completed,
    structured,
    answerText: String(completed?.payload?.text || structured?.payload?.renderedText || ""),
  };
};

const runRealNativelyInterview = async (): Promise<RunResult[]> => {
  if (!process.env.NVIDIA_API_KEY && !process.env.CALLPILOT_NVIDIA_API_KEY) {
    return [{
      scenarioId: "natively_interview_smoke",
      track: "real_natively_interview_ipc",
      run: runNumber,
      deterministicChecks: {
        nvidiaKeyAvailable: false,
        nativelyTranscriptReceived: false,
        answerCompleted: false,
      },
      judge: null,
      latency_ms: finishLatency("real-natively-interview-blocked"),
      diagnostics: {
        blocked: true,
        reason: "NVIDIA_API_KEY or CALLPILOT_NVIDIA_API_KEY is required for the answer half of --track=real-natively-interview",
      },
    }];
  }
  checkBudget(2);
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing. Run npm run build before --track=real-natively-interview.");
  }

  const modelName = process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.2-1b-instruct";
  const useDefaultUserData = process.env.E2E_USE_DEFAULT_USER_DATA === "1" && !process.env.NATIVELY_API_KEY;
  const userDataDir = path.join(tmpDir, `user-data-natively-${Date.now()}`);
  if (!useDefaultUserData) fs.mkdirSync(userDataDir, { recursive: true });

  const audio = resolveBehavioralAudio();
  const pcm = readPcmWavAsMono16k(audio.path);
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const electronEnv = {
    ...childEnv,
    CALLPILOT_REMOTE_DEBUG_PORT: String(debugPort),
    ...(useDefaultUserData ? {} : { CALLPILOT_USER_DATA_DIR: userDataDir }),
  };
  const electron = spawn(electronBin, ["."], {
    cwd: root,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: electronEnv,
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
  let originalSettings: unknown = null;
  try {
    const mainTarget = await getPageTarget((target) => !target.url.includes("#/overlay") && !target.url.includes("#/coding"), 30000);
    if (!mainTarget?.webSocketDebuggerUrl) {
      throw new Error(`Could not find Electron main target.\nstdout:\n${stdout.slice(-1200)}\nstderr:\n${stderr.slice(-1200)}`);
    }
    client = await cdp(mainTarget.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    const hasBridge = await evaluate<boolean>(client, waitForBridgeExpression);
    if (!hasBridge) throw new Error("Desktop bridge did not become available in renderer");

    const credentialStatus = await evaluate<any>(client, `window.callpilotDesktop.getCredentialStatus()`);
    if (!credentialStatus?.hasNativelyKey && !process.env.NATIVELY_API_KEY) {
      return [{
        scenarioId: "natively_interview_smoke",
        track: "real_natively_interview_ipc",
        run: runNumber,
        deterministicChecks: {
          nativelyKeyAvailable: false,
          nativelyTranscriptReceived: false,
          answerCompleted: false,
        },
        judge: null,
        latency_ms: finishLatency("real-natively-interview-blocked"),
        diagnostics: {
          blocked: true,
          reason: useDefaultUserData
            ? "No stored Natively key was available in the default Electron profile."
            : "Set NATIVELY_API_KEY or rerun with E2E_USE_DEFAULT_USER_DATA=1 to use the Natively key saved in the app.",
          credentialStatus: {
            hasNativelyKey: Boolean(credentialStatus?.hasNativelyKey),
            hasNvidiaKey: Boolean(credentialStatus?.hasNvidiaKey),
          },
        },
      }];
    }

    originalSettings = await evaluate(client, `window.callpilotDesktop.getSettings()`);
    await evaluate(client, `window.callpilotDesktop.saveSettings(${JSON.stringify({
      activeMode: "behavioral",
      preferredLanguage: "english",
      defaultCodingLanguage: "Python",
      answerVerbosity: "medium",
      modelProvider: "nvidia",
      modelName,
      ollamaBaseUrl: "http://localhost:11434",
      transcriptionModelName: "gpt-4o-transcribe",
      liveTranscriptionProvider: "natively",
      liveLatencyPreset: "balanced",
      liveAudioSource: "system",
      autoAnswerCooldownMs: 12000,
      autoAnswerMinConfidence: 0.45,
    })})`);

    await evaluate(client, seedSessionExpression(makeEmptyInterviewSession("nvidia", modelName, "behavioral")));
    const bridgeAfterReload = await evaluate<boolean>(client, waitForBridgeExpression);
    if (!bridgeAfterReload) throw new Error("Desktop bridge did not recover after Natively session seed reload");
    await evaluate(client, `window.callpilotDesktop.startSession({ mode: "behavioral" })`);
    await evaluate(client, `(() => {
      window.__callpilotNativelyEvents = [];
      window.__callpilotNativelyDispose = [
        window.callpilotDesktop.onNativelyStatus((payload) => window.__callpilotNativelyEvents.push({ type: "status", at: Date.now(), payload })),
        window.callpilotDesktop.onNativelyTranscript((payload) => window.__callpilotNativelyEvents.push({ type: "transcript", at: Date.now(), payload }))
      ];
      return true;
    })()`);

    const streamId = `system-e2e-${Date.now()}`;
    const sttStarted = markLatencyStage(createLatencyMetricRun("real-natively-stt"), "audio_or_screen_capture");
    recordRealCall();
    const startResult = await evaluate<{ ok: boolean; streamId?: string; error?: string }>(client, `window.callpilotDesktop.startNativelyTranscription({
      streamId: ${JSON.stringify(streamId)},
      channel: "system",
      sampleRate: 16000,
      language: "english",
      apiKey: ${JSON.stringify(process.env.NATIVELY_API_KEY || "")}
    })`);
    if (!startResult.ok) throw new Error(`natively:start failed: ${startResult.error || "unknown"}`);

    await evaluate(client, `new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const events = window.__callpilotNativelyEvents || [];
        if (events.some((event) => event.type === "status" && /connected/i.test(event.payload?.status || event.payload?.detail || ""))) {
          resolve(true);
          return;
        }
        if (Date.now() - started > 7000) {
          resolve(false);
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    })`);

    const chunkSize = 3200;
    for (let offset = 0; offset < pcm.length; offset += chunkSize) {
      const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + chunkSize)).toString("base64");
      const audioResult = await evaluate<{ ok: boolean; error?: string }>(client, `window.callpilotDesktop.sendNativelyAudio({
        streamId: ${JSON.stringify(streamId)},
        arrayBuffer: Uint8Array.from(atob(${JSON.stringify(chunk)}), (char) => char.charCodeAt(0)).buffer
      })`);
      if (!audioResult.ok) throw new Error(`natively:audio failed: ${audioResult.error || "unknown"}`);
      await sleep(45);
    }

    const transcriptEvents = await evaluate<Array<{ type: string; at: number; payload: any }>>(client, `new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const events = window.__callpilotNativelyEvents || [];
        const transcripts = events.filter((event) => event.type === "transcript");
        if (transcripts.some((event) => event.payload?.isFinal && String(event.payload?.text || "").trim().length > 0)) {
          resolve(events);
          return;
        }
        if (Date.now() - started > 45000) {
          resolve(events);
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    })`);
    await evaluate(client, `window.callpilotDesktop.stopNativelyTranscription({ streamId: ${JSON.stringify(streamId)} })`);
    const sttDone = markLatencyStage(sttStarted, "transcription_or_vision_done");
    const transcriptPayloads = transcriptEvents
      .filter((event) => event.type === "transcript")
      .map((event) => event.payload);
    const finalTranscript = [...transcriptPayloads].reverse().find((payload) => payload?.isFinal && String(payload.text || "").trim())?.text
      || transcriptPayloads.map((payload) => payload?.text).filter(Boolean).at(-1)
      || "";

    await sleep(700);
    const answerStarted = markLatencyStage(createLatencyMetricRun("real-natively-answer"), "model_call_start");
    const answer = await waitForAnswerEvents(client, "nvidia", modelName, { startSession: false });
    const answerDone = markLatencyStage(answerStarted, "response_complete");
    const traceStatus = await evaluate<any>(client, `window.callpilotDesktop.getSessionTraceStatus()`);
    const endSession = await evaluate<any>(client, `window.callpilotDesktop.endSession()`);
    const tracePath = endSession?.tracePath || traceStatus?.path || "";
    const failed = answer.events.find((event) => event.type === "status" && event.payload?.status === "failed");
    const unsupportedSpecifics = [
      /\b\d{2,}(?:,\d{3})?\s+(?:users|customers|requests|minutes|hours|horas|minutos)\b/i,
      /\b(?:TechCorp|UserSync|Black Friday|SLAs?|e-?commerce platform)\b/i,
      /\b(?:database|db)\s+outage\b/i,
      /\b(?:hotfix|root cause)\b/i,
      /\brestored service in\b/i,
    ].filter((pattern) => pattern.test(answer.answerText)).map((pattern) => pattern.source);
    const totalLatency = answerDone.events.find((event) => event.stage === "response_complete")?.elapsedMs ?? 0;
    const sttLatency = sttDone.events.find((event) => event.stage === "transcription_or_vision_done")?.elapsedMs ?? 0;
    const deterministicChecks = {
      nativelyStreamStarted: startResult.ok,
      nativelyTranscriptReceived: finalTranscript.trim().length > 0,
      transcriptMentionsIncident: /incident|production|producci/i.test(finalTranscript),
      answerRequestAccepted: answer.requestResult.ok,
      answerCompleted: Boolean(answer.completed) && !failed,
      answerNonEmpty: answer.answerText.trim().length > 40,
      noUnsupportedBehavioralSpecifics: unsupportedSpecifics.length === 0,
      traceRecorded: Boolean(tracePath && traceStatus?.eventCount >= 3),
    };

    return [{
      scenarioId: "natively_interview_smoke",
      track: "real_natively_interview_ipc",
      run: runNumber,
      deterministicChecks,
      judge: null,
      latency_ms: {
        first_token: null,
        total: totalLatency,
      },
      diagnostics: {
        userData: useDefaultUserData ? "default" : "isolated",
        audio: {
          generated: audio.generated,
          fileName: path.basename(audio.path),
          pcmBytes: pcm.length,
        },
        stt_latency_ms: sttLatency,
        transcript_result: finalTranscript,
        transcript_events: transcriptPayloads.map((payload) => ({
          text: String(payload?.text || "").slice(0, 240),
          isFinal: Boolean(payload?.isFinal),
          confidence: payload?.confidence,
        })),
        answer_received: answer.answerText,
        unsupportedSpecifics,
        answer_events: answer.events.map((event) => ({
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
    if (client && useDefaultUserData && originalSettings) {
      await evaluate(client, `window.callpilotDesktop.saveSettings(${JSON.stringify(originalSettings)})`).catch(() => undefined);
      await evaluate(client, `window.localStorage.removeItem("callpilot_v0_session")`).catch(() => undefined);
    }
    client?.close();
    electron.kill();
    if (audio.generated) fs.rmSync(audio.path, { force: true });
  }
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

const runRealTextInterview = async (): Promise<RunResult[]> => {
  if (!process.env.NVIDIA_API_KEY && !process.env.CALLPILOT_NVIDIA_API_KEY) {
    return [{
      scenarioId: "interview_redis_persistence",
      track: "real_text_interview_ipc",
      run: runNumber,
      deterministicChecks: {
        nvidiaKeyAvailable: false,
        answerCompleted: false,
      },
      judge: null,
      latency_ms: finishLatency("real-text-interview-blocked"),
      diagnostics: {
        blocked: true,
        reason: "NVIDIA_API_KEY or CALLPILOT_NVIDIA_API_KEY is required for --track=real-text-interview",
      },
    }];
  }
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing. Run npm run build before --track=real-text-interview.");
  }

  const fixture = readJson<{ technical_interview: TextInterviewScenario[] }>("text-fixtures.batch1.json");
  const requestedScenarioId = argValue("--scenario") || "interview_redis_persistence";
  const scenario = fixture.technical_interview.find((item) => item.scenarioId === requestedScenarioId)
    ?? fixture.technical_interview[0];
  if (!scenario) throw new Error("No technical_interview scenario found in text-fixtures.batch1.json");

  return [await runRealTextInterviewScenario(scenario, "real_text_interview_ipc", "real-text-interview")];
};

const runRealTextInterviewScenario = async (
  scenario: TextInterviewScenario,
  trackName: string,
  latencyLabel: string,
): Promise<RunResult> => {
  checkBudget(1);
  const modelName = process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.2-1b-instruct";
  const userDataDir = path.join(tmpDir, `user-data-text-${Date.now()}`);
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
      activeMode: "technical_qa",
      preferredLanguage: scenario.expected_behavior?.language === "en" ? "english" : "spanish",
      defaultCodingLanguage: "Python",
      answerVerbosity: "medium",
      modelProvider: "nvidia",
      modelName,
      ollamaBaseUrl: "http://localhost:11434",
      transcriptionModelName: "gpt-4o-transcribe",
      liveTranscriptionProvider: "local",
      liveLatencyPreset: "balanced",
      liveAudioSource: "both",
      autoAnswerCooldownMs: 12000,
      autoAnswerMinConfidence: 0.45,
    })})`);

    const session = makeTextInterviewSession(scenario, "nvidia", modelName);
    await evaluate(client, seedSessionExpression(session));
    const bridgeAfterReload = await evaluate<boolean>(client, waitForBridgeExpression);
    if (!bridgeAfterReload) throw new Error("Desktop bridge did not recover after text session seed reload");

    const answerStarted = markLatencyStage(createLatencyMetricRun(`${latencyLabel}-answer`), "model_call_start");
    const answer = await waitForAnswerEvents(client, "nvidia", modelName);
    const answerDone = markLatencyStage(answerStarted, "response_complete");
    const traceStatus = await evaluate<any>(client, `window.callpilotDesktop.getSessionTraceStatus()`);
    const endSession = await evaluate<any>(client, `window.callpilotDesktop.endSession()`);
    const tracePath = endSession?.tracePath || traceStatus?.path || "";
    const failed = answer.events.find((event) => event.type === "status" && event.payload?.status === "failed");
    const normalizedAnswer = answer.answerText.toLowerCase();
    const deterministicChecks = scenario.scenarioId === "interview_redis_persistence" ? {
      answerRequestAccepted: answer.requestResult.ok,
      answerCompleted: Boolean(answer.completed) && !failed,
      answerNonEmpty: answer.answerText.trim().length > 40,
      mentionsRedis: /\bredis\b/i.test(answer.answerText),
      doesNotCallRedisRelational: !/redis\s+(es|is)\s+(una\s+)?(base de datos\s+)?relacional/i.test(normalizedAnswer),
      noQuestionMarkMojibake: !/\?\?/.test(answer.answerText),
      traceRecorded: Boolean(tracePath && traceStatus?.eventCount >= 3),
    } : {
      answerRequestAccepted: answer.requestResult.ok,
      ...evaluateTextInterviewChecks(scenario, answer.answerText, failed, Boolean(tracePath && traceStatus?.eventCount >= 3)),
    };
    const totalLatency = answerDone.events.find((event) => event.stage === "response_complete")?.elapsedMs ?? 0;

    return {
      scenarioId: scenario.scenarioId,
      track: trackName,
      run: runNumber,
      deterministicChecks,
      judge: null,
      latency_ms: {
        first_token: null,
        total: totalLatency,
      },
      diagnostics: {
        provider: "nvidia",
        modelName,
        transcript: scenario.turns,
        answer_received: answer.answerText,
        answer_events: answer.events.map((event) => ({
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
    };
  } finally {
    client?.close();
    electron.kill();
  }
};

const runRealTextInterviewBatch = async (): Promise<RunResult[]> => {
  if (!process.env.NVIDIA_API_KEY && !process.env.CALLPILOT_NVIDIA_API_KEY) {
    return [{
      scenarioId: "technical_interview_batch",
      track: "real_text_interview_batch_ipc",
      run: runNumber,
      deterministicChecks: {
        nvidiaKeyAvailable: false,
        answerCompleted: false,
      },
      judge: null,
      latency_ms: finishLatency("real-text-interview-batch-blocked"),
      diagnostics: {
        blocked: true,
        reason: "NVIDIA_API_KEY or CALLPILOT_NVIDIA_API_KEY is required for --track=real-text-interview-batch",
      },
    }];
  }
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing. Run npm run build before --track=real-text-interview-batch.");
  }
  const fixture = readJson<{ technical_interview: TextInterviewScenario[] }>("text-fixtures.batch1.json");
  const requested = argValue("--scenarios")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const scenarios = (requested.length > 0
    ? requested
        .map((id) => fixture.technical_interview.find((scenario) => scenario.scenarioId === id))
        .filter((scenario): scenario is TextInterviewScenario => Boolean(scenario))
    : fixture.technical_interview.slice(0, realBatchLimit)
  );
  if (scenarios.length === 0) throw new Error("No technical_interview scenarios selected for real batch.");
  checkBudget(scenarios.length);

  const results: RunResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runRealTextInterviewScenario(scenario, "real_text_interview_batch_ipc", "real-text-interview-batch"));
  }
  return results;
};

const runRealCoding = async (): Promise<RunResult[]> => {
  if (!process.env.NVIDIA_API_KEY && !process.env.CALLPILOT_NVIDIA_API_KEY) {
    return [{
      scenarioId: "coding_evol_two_sum",
      track: "real_coding_ipc",
      run: runNumber,
      deterministicChecks: {
        nvidiaKeyAvailable: false,
        answerCompleted: false,
        pythonExecutionPassed: false,
      },
      judge: null,
      latency_ms: finishLatency("real-coding-blocked"),
      diagnostics: {
        blocked: true,
        reason: "NVIDIA_API_KEY or CALLPILOT_NVIDIA_API_KEY is required for --track=real-coding",
      },
    }];
  }
  checkBudget(1);
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing. Run npm run build before --track=real-coding.");
  }

  const fixture = readJson<{ live_coding_evolutivo: CodingScenario[] }>("text-fixtures.batch1.json");
  const scenario = fixture.live_coding_evolutivo.find((item) => item.scenarioId === "coding_evol_two_sum");
  if (!scenario) throw new Error("coding_evol_two_sum scenario not found in text-fixtures.batch1.json");
  const assertions = scenario.turns
    .map((turn) => turn.test_cases?.trim())
    .filter((value): value is string => Boolean(value));

  const modelName = process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.2-1b-instruct";
  const userDataDir = path.join(tmpDir, `user-data-coding-${Date.now()}`);
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
      activeMode: "live_coding",
      preferredLanguage: "spanish",
      defaultCodingLanguage: "Python",
      answerVerbosity: "medium",
      modelProvider: "nvidia",
      modelName,
      ollamaBaseUrl: "http://localhost:11434",
      transcriptionModelName: "gpt-4o-transcribe",
      liveTranscriptionProvider: "natively",
      liveLatencyPreset: "balanced",
      liveAudioSource: "both",
      autoAnswerCooldownMs: 12000,
      autoAnswerMinConfidence: 0.45,
    })})`);

    const session = makeCodingSession(scenario, "nvidia", modelName);
    await evaluate(client, seedSessionExpression(session));
    const bridgeAfterReload = await evaluate<boolean>(client, waitForBridgeExpression);
    if (!bridgeAfterReload) throw new Error("Desktop bridge did not recover after coding session seed reload");

    const answerStarted = markLatencyStage(createLatencyMetricRun("real-coding-answer"), "model_call_start");
    const answer = await waitForAnswerEvents(client, "nvidia", modelName, { mode: "live_coding", timeoutMs: 120000 });
    const answerDone = markLatencyStage(answerStarted, "response_complete");
    const traceStatus = await evaluate<any>(client, `window.callpilotDesktop.getSessionTraceStatus()`);
    const endSession = await evaluate<any>(client, `window.callpilotDesktop.endSession()`);
    const tracePath = endSession?.tracePath || traceStatus?.path || "";
    const failed = answer.events.find((event) => event.type === "status" && event.payload?.status === "failed");
    const code = extractPythonCode(answer.answerText);
    const execution = code
      ? runPythonAssertions(code, assertions)
      : { ok: false, status: null, stdout: "", stderr: "No Python code block with two_sum was found.", timedOut: false };
    const totalLatency = answerDone.events.find((event) => event.stage === "response_complete")?.elapsedMs ?? 0;
    const deterministicChecks = {
      answerRequestAccepted: answer.requestResult.ok,
      answerCompleted: Boolean(answer.completed) && !failed,
      answerNonEmpty: answer.answerText.trim().length > 40,
      codeBlockFound: Boolean(code),
      definesTwoSum: /\bdef\s+two_sum\s*\(/.test(code),
      hasAccumulatedAssertions: assertions.length >= 2,
      pythonExecutionPassed: execution.ok,
      didNotTimeout: !execution.timedOut,
      traceRecorded: Boolean(tracePath && traceStatus?.eventCount >= 3),
    };

    return [{
      scenarioId: scenario.scenarioId,
      track: "real_coding_ipc",
      run: runNumber,
      deterministicChecks,
      judge: null,
      latency_ms: {
        first_token: null,
        total: totalLatency,
      },
      diagnostics: {
        provider: "nvidia",
        modelName,
        transcript: session.transcript.messages,
        screenText: session.screenText,
        answer_received: answer.answerText,
        extracted_code: code,
        assertions,
        execution,
        answer_events: answer.events.map((event) => ({
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
    client?.close();
    electron.kill();
  }
};

const runRealCodingTurn = async (
  scenario: CodingScenario,
  assertions: string[],
  turnCount: number,
  assistantAnswers: string[],
  trackName: string,
): Promise<{ result: RunResult; answerText: string; code: string }> => {
  const modelName = process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.2-1b-instruct";
  const userDataDir = path.join(tmpDir, `user-data-coding-${Date.now()}-${turnCount}`);
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
      activeMode: "live_coding",
      preferredLanguage: "spanish",
      defaultCodingLanguage: "Python",
      answerVerbosity: "medium",
      modelProvider: "nvidia",
      modelName,
      ollamaBaseUrl: "http://localhost:11434",
      transcriptionModelName: "gpt-4o-transcribe",
      liveTranscriptionProvider: "natively",
      liveLatencyPreset: "balanced",
      liveAudioSource: "both",
      autoAnswerCooldownMs: 12000,
      autoAnswerMinConfidence: 0.45,
    })})`);

    const session = makeCodingSession(scenario, "nvidia", modelName, turnCount, assistantAnswers);
    await evaluate(client, seedSessionExpression(session));
    const bridgeAfterReload = await evaluate<boolean>(client, waitForBridgeExpression);
    if (!bridgeAfterReload) throw new Error("Desktop bridge did not recover after coding session seed reload");

    const answerStarted = markLatencyStage(createLatencyMetricRun(`${trackName}-answer-turn-${turnCount}`), "model_call_start");
    const answer = await waitForAnswerEvents(client, "nvidia", modelName, { mode: "live_coding", timeoutMs: 120000 });
    const answerDone = markLatencyStage(answerStarted, "response_complete");
    const traceStatus = await evaluate<any>(client, `window.callpilotDesktop.getSessionTraceStatus()`);
    const endSession = await evaluate<any>(client, `window.callpilotDesktop.endSession()`);
    const tracePath = endSession?.tracePath || traceStatus?.path || "";
    const failed = answer.events.find((event) => event.type === "status" && event.payload?.status === "failed");
    const code = extractPythonCode(answer.answerText);
    const execution = code && assertions.length > 0
      ? runPythonAssertions(code, assertions)
      : { ok: assertions.length === 0, status: null, stdout: "", stderr: code ? "" : "No Python code block with two_sum was found.", timedOut: false };
    const totalLatency = answerDone.events.find((event) => event.stage === "response_complete")?.elapsedMs ?? 0;
    const deterministicChecks = {
      answerRequestAccepted: answer.requestResult.ok,
      answerCompleted: Boolean(answer.completed) && !failed,
      answerNonEmpty: answer.answerText.trim().length > 40,
      codeBlockFound: Boolean(code),
      definesTwoSum: !code || /\bdef\s+two_sum\s*\(/.test(code),
      accumulatedTranscriptHasExpectedTurns: session.transcript.messages.filter((message) => message.speaker === "interviewer").length === turnCount,
      pythonExecutionPassed: execution.ok,
      didNotTimeout: !execution.timedOut,
      traceRecorded: Boolean(tracePath && traceStatus?.eventCount >= 3),
    };

    return {
      answerText: answer.answerText,
      code,
      result: {
        scenarioId: `${scenario.scenarioId}_turn_${turnCount}`,
        track: trackName,
        run: runNumber,
        deterministicChecks,
        judge: null,
        latency_ms: {
          first_token: null,
          total: totalLatency,
        },
        diagnostics: {
          provider: "nvidia",
          modelName,
          turnCount,
          transcript: session.transcript.messages,
          screenText: session.screenText,
          answer_received: answer.answerText,
          extracted_code: code,
          assertions,
          execution,
          answer_events: answer.events.map((event) => ({
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
      },
    };
  } finally {
    client?.close();
    electron.kill();
  }
};

const runRealCodingMultiturn = async (): Promise<RunResult[]> => {
  if (!process.env.NVIDIA_API_KEY && !process.env.CALLPILOT_NVIDIA_API_KEY) {
    return [{
      scenarioId: "coding_evol_two_sum_multiturn",
      track: "real_coding_multiturn_ipc",
      run: runNumber,
      deterministicChecks: {
        nvidiaKeyAvailable: false,
        answerCompleted: false,
        pythonExecutionPassed: false,
      },
      judge: null,
      latency_ms: finishLatency("real-coding-multiturn-blocked"),
      diagnostics: {
        blocked: true,
        reason: "NVIDIA_API_KEY or CALLPILOT_NVIDIA_API_KEY is required for --track=real-coding-multiturn",
      },
    }];
  }
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing. Run npm run build before --track=real-coding-multiturn.");
  }

  const fixture = readJson<{ live_coding_evolutivo: CodingScenario[] }>("text-fixtures.batch1.json");
  const scenario = fixture.live_coding_evolutivo.find((item) => item.scenarioId === "coding_evol_two_sum");
  if (!scenario) throw new Error("coding_evol_two_sum scenario not found in text-fixtures.batch1.json");
  const selectedTurns = (argValue("--turns") || "1,2,4")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= scenario.turns.length);
  if (selectedTurns.length === 0) throw new Error("No valid coding turns selected for real multi-turn run.");
  checkBudget(selectedTurns.length);

  const results: RunResult[] = [];
  const assistantAnswers: string[] = [];
  for (const turnCount of selectedTurns) {
    const assertions = scenario.turns
      .slice(0, turnCount)
      .map((turn) => turn.test_cases?.trim())
      .filter((value): value is string => Boolean(value));
    const { result, answerText } = await runRealCodingTurn(scenario, assertions, turnCount, assistantAnswers, "real_coding_multiturn_ipc");
    results.push(result);
    assistantAnswers[turnCount - 1] = answerText;
  }
  return results;
};

const run = async () => {
  checkBudget();
  const includeRealSuite = selectedTrack === "real-suite";
  const results = [
    ...(selectedTrack === "all" || selectedTrack === "no-answer" ? runNoAnswer() : []),
    ...(selectedTrack === "all" || selectedTrack === "coding-fixtures" ? runCodingFixtureValidation() : []),
    ...(selectedTrack === "all" || selectedTrack === "coding-objective-smoke" ? runCodingObjectiveSmoke() : []),
    ...(selectedTrack === "real-behavioral" ? await runRealBehavioral() : []),
    ...(selectedTrack === "real-coding" ? await runRealCoding() : []),
    ...(selectedTrack === "real-coding-multiturn" || includeRealSuite ? await runRealCodingMultiturn() : []),
    ...(selectedTrack === "real-text-interview" ? await runRealTextInterview() : []),
    ...(selectedTrack === "real-text-interview-batch" || includeRealSuite ? await runRealTextInterviewBatch() : []),
    ...(selectedTrack === "real-natively-interview" || includeRealSuite ? await runRealNativelyInterview() : []),
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
