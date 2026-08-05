import { spawn, spawnSync } from "node:child_process";
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
  conversationAssistText: string;
  structured: StructuredAnswerPayload | null;
  latencyMs: number;
  requestId?: string;
  conversationAssistRequestId?: string;
  rawModelOutput?: string | null;
  rawModelOutputStage?: string;
  conversationAssistRawModelOutput?: string | null;
  conversationAssistRawModelOutputStage?: string;
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

type CodingWorkspaceExpected = {
  expectedFunction: string | null;
  mustContain?: string[];
  mustContainAny?: string[];
  mustPreserve?: string[];
  mustNotContain: string[];
  semanticExpectations?: string[];
  semanticChecks?: Record<string, boolean | undefined> & {
    sortedWordFrequency?: boolean;
    sortedEventMetrics?: boolean;
    usesDequeWindow?: boolean;
  };
  pythonAssertions?: string[];
};

type ConversationAssistExpected = {
  maxWords?: number;
  mustContain?: string[];
  mustContainAny?: string[];
  mustContainGroups?: string[][];
  mustNotContain?: string[];
  semanticChecks?: Record<string, boolean | undefined> & {
    naturalSpokenTone?: boolean;
    noCodeBlock?: boolean;
    noLongCode?: boolean;
    eventDedupPlan?: boolean;
    duplicateSemantics?: boolean;
    windowPlan?: boolean;
    staleSetBug?: boolean;
    malformedSortingPlan?: boolean;
    dequeTestsPlan?: boolean;
  };
};

type ScenarioExpected = CodingWorkspaceExpected & {
  codingWorkspace?: CodingWorkspaceExpected;
  conversationAssist?: ConversationAssistExpected;
};

type LoadedCodingWorkspaceExpected = {
  expectedFunction: string | null;
  mustContain: string[];
  mustContainAny: string[];
  mustPreserve: string[];
  mustNotContain: string[];
  semanticExpectations: string[];
  semanticChecks: Record<string, boolean> & {
    sortedWordFrequency: boolean;
    sortedEventMetrics: boolean;
    usesDequeWindow: boolean;
  };
  pythonAssertions: string[];
};

type LoadedConversationAssistExpected = {
  maxWords: number;
  mustContain: string[];
  mustContainAny: string[];
  mustContainGroups: string[][];
  mustNotContain: string[];
  semanticChecks: Record<string, boolean> & {
    naturalSpokenTone: boolean;
    noCodeBlock: boolean;
    noLongCode: boolean;
    eventDedupPlan: boolean;
    duplicateSemantics: boolean;
    windowPlan: boolean;
    staleSetBug: boolean;
    malformedSortingPlan: boolean;
    dequeTestsPlan: boolean;
  };
};

type LoadedScenarioExpected = {
  codingWorkspace: LoadedCodingWorkspaceExpected;
  conversationAssist: LoadedConversationAssistExpected | null;
};

type ScenarioStage = {
  id: string;
  order: number;
  answerAction?: "chat" | "coding" | "both";
  coverage?: string[];
  image?: string | null;
  images?: string[];
  visualContext?: Array<{
    image: string;
    role?: "implementation" | "tests" | "instructions" | "terminal" | "file_tree" | "output" | "unknown";
    visibleFile?: string;
    panelLabel?: string;
  }>;
  code: string | null;
  transcript_delta: string;
  expected: string;
};

type LoadedVisualContextImage = {
  path: string;
  role: string;
  visibleFile: string;
  panelLabel: string;
};

type StageScenario = {
  id: string;
  difficulty?: string;
  stages: ScenarioStage[];
};

type LoadedScenarioStage = ScenarioStage & {
  imagePath: string | null;
  imagePaths: string[];
  visualImages: LoadedVisualContextImage[];
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

const normalizeCoverageTags = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
    : [];

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

const loadSemanticChecks = (checks: Record<string, boolean | undefined> | undefined): Record<string, boolean> =>
  Object.fromEntries(Object.entries(checks ?? {}).map(([key, value]) => [key, Boolean(value)]));

const defaultConversationAssistForbiddenTerms = [
  "```",
  "def ",
  "class ",
  "Complejidad",
  "Complexity",
  "\"kind\"",
  "\"payload\"",
  "Código:",
  "Codigo:",
  "Code:",
];

const loadCodingWorkspaceExpected = (expectedRules: CodingWorkspaceExpected): LoadedCodingWorkspaceExpected => ({
  expectedFunction: expectedRules.expectedFunction,
  mustContain: Array.isArray(expectedRules.mustContain) ? expectedRules.mustContain.map(String) : [],
  mustContainAny: Array.isArray(expectedRules.mustContainAny) ? expectedRules.mustContainAny.map(String) : [],
  mustPreserve: Array.isArray(expectedRules.mustPreserve) ? expectedRules.mustPreserve.map(String) : [],
  mustNotContain: Array.isArray(expectedRules.mustNotContain) ? expectedRules.mustNotContain.map(String) : [],
  semanticExpectations: Array.isArray(expectedRules.semanticExpectations) ? expectedRules.semanticExpectations.map(String) : [],
  semanticChecks: {
    ...loadSemanticChecks(expectedRules.semanticChecks),
    sortedWordFrequency: Boolean(expectedRules.semanticChecks?.sortedWordFrequency),
    sortedEventMetrics: Boolean(expectedRules.semanticChecks?.sortedEventMetrics),
    usesDequeWindow: Boolean(expectedRules.semanticChecks?.usesDequeWindow),
  },
  pythonAssertions: Array.isArray(expectedRules.pythonAssertions) ? expectedRules.pythonAssertions.map(String) : [],
});

const loadConversationAssistExpected = (expectedRules: ConversationAssistExpected | undefined): LoadedConversationAssistExpected | null => {
  if (!expectedRules) return null;
  const explicitForbidden = Array.isArray(expectedRules.mustNotContain) ? expectedRules.mustNotContain.map(String) : [];
  const defaultForbidden = defaultConversationAssistForbiddenTerms.filter((term) => !/^(code|codigo|c.digo|def|class):?$/i.test(normalizeText(term)));
  return {
    maxWords: Number.isFinite(expectedRules.maxWords) ? Number(expectedRules.maxWords) : 130,
    mustContain: Array.isArray(expectedRules.mustContain) ? expectedRules.mustContain.map(String) : [],
    mustContainAny: Array.isArray(expectedRules.mustContainAny) ? expectedRules.mustContainAny.map(String) : [],
    mustContainGroups: Array.isArray(expectedRules.mustContainGroups)
      ? expectedRules.mustContainGroups
        .filter((group) => Array.isArray(group))
        .map((group) => group.map(String).filter(Boolean))
        .filter((group) => group.length > 0)
      : [],
    mustNotContain: [...defaultForbidden, ...explicitForbidden],
    semanticChecks: {
      ...loadSemanticChecks(expectedRules.semanticChecks),
      naturalSpokenTone: Boolean(expectedRules.semanticChecks?.naturalSpokenTone),
      noCodeBlock: Boolean(expectedRules.semanticChecks?.noCodeBlock),
      noLongCode: Boolean(expectedRules.semanticChecks?.noLongCode),
      eventDedupPlan: Boolean(expectedRules.semanticChecks?.eventDedupPlan),
      duplicateSemantics: Boolean(expectedRules.semanticChecks?.duplicateSemantics),
      windowPlan: Boolean(expectedRules.semanticChecks?.windowPlan),
      staleSetBug: Boolean(expectedRules.semanticChecks?.staleSetBug),
      malformedSortingPlan: Boolean(expectedRules.semanticChecks?.malformedSortingPlan),
      dequeTestsPlan: Boolean(expectedRules.semanticChecks?.dequeTestsPlan),
    },
  };
};

type CoverageSummaryEntry = {
  passed: number;
  total: number;
  failedStages: string[];
};

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
      const visualImages = Array.isArray(stage.visualContext)
        ? stage.visualContext.map((item) => ({
          path: path.resolve(baseDir, String(item.image)),
          role: String(item.role ?? "unknown"),
          visibleFile: String(item.visibleFile ?? ""),
          panelLabel: String(item.panelLabel ?? ""),
        }))
        : [];
      const imagePaths = visualImages.length > 0
        ? visualImages.map((image) => image.path)
        : Array.isArray(stage.images)
        ? stage.images.map((image) => path.resolve(baseDir, String(image)))
        : typeof stage.image === "string"
          ? [path.resolve(baseDir, stage.image)]
          : [];
      const imagePath = imagePaths[0] ?? null;
      const codePath = typeof stage.code === "string" ? path.resolve(baseDir, stage.code) : null;
      const transcriptPath = path.resolve(baseDir, stage.transcript_delta);
      const expectedPath = path.resolve(baseDir, stage.expected);
      imagePaths.forEach((currentImagePath, index) => {
        requireFixtureFile(parsed.id, stage.id, `coderpad screenshot ${index + 1}`, currentImagePath);
      });
      if (codePath) requireFixtureFile(parsed.id, stage.id, "code.py", codePath);
      requireFixtureFile(parsed.id, stage.id, "transcript_delta.json", transcriptPath);
      requireFixtureFile(parsed.id, stage.id, "expected.json", expectedPath);
      const transcript = readJsonFile<ScenarioTranscriptTurn[]>(transcriptPath);
      const expectedRules = readJsonFile<ScenarioExpected>(expectedPath);
      if (!Array.isArray(transcript)) throw new Error(`Invalid transcript_delta for ${parsed.id}/${stage.id}: ${transcriptPath}`);
      const codingWorkspace = expectedRules?.codingWorkspace === null && (stage.answerAction ?? "both") === "chat"
        ? { expectedFunction: null, mustNotContain: [] }
        : expectedRules?.codingWorkspace ?? expectedRules;
      if (!codingWorkspace || !("expectedFunction" in codingWorkspace)) throw new Error(`Invalid expected.json for ${parsed.id}/${stage.id}: ${expectedPath}`);
      return {
        ...stage,
        imagePath,
        imagePaths,
        visualImages,
        codePath,
        transcriptPath,
        expectedPath,
        transcript,
        expectedRules: {
          codingWorkspace: loadCodingWorkspaceExpected(codingWorkspace),
          conversationAssist: loadConversationAssistExpected(expectedRules.conversationAssist),
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

const mockEventDedupConversation = (stageId: string) => {
  if (/transcript_only/.test(stageId)) {
    return "I'd say: I'll keep this simple for now: parse each pipe-separated line, track seen event_id values to dedupe, and count event_type only for the first occurrence. I won't add the time window yet because the interviewer said timestamps are for later.";
  }
  if (/initial_implementation/.test(stageId)) {
    return "I'd say: I'll start with the simple first version: split each pipe-separated line, use seen_ids to skip duplicate event_id values, and update counts by event_type only for accepted events.";
  }
  if (/duplicate_semantics/.test(stageId)) {
    return "I'd say: the first event wins, so the current seen_ids set is enough: once an event_id is seen, later duplicates are skipped even if their type differs. No code change yet.";
  }
  if (/visible_duplicate_count_bug/.test(stageId)) {
    return "I'd say: the bug is ordering. We count before checking seen_ids, so a duplicate already changed counts. I’ll move the count update after the duplicate skip.";
  }
  if (/sliding_window|window_requirement/.test(stageId)) {
    return "I'd say: now the set needs to represent only the last five minutes, 300 seconds. Since timestamps arrive sorted, I can expire old recent_events as time moves forward before checking duplicates.";
  }
  if (/window_membership_stale_bug|window_membership|window_bug/.test(stageId)) {
    return "I'd say: recent_events and seen_ids drifted. When an old tuple expires, I also need to discard that id from seen_ids, otherwise the set stays stale.";
  }
  if (/return_contract|malformed/.test(stageId)) {
    return "I'd say: I'll keep the window logic, add guards to skip malformed lines without raising, then change only the final return to sorted event metrics by count descending and type alphabetically.";
  }
  if (/final_tests|deque/.test(stageId)) {
    return "I'd say: final pass is replacing pop(0) with a deque and popleft for O(1) front removal, while keeping seen_ids synchronized. Then I’ll add direct asserts for duplicates, expiry, malformed input, and sorting ties.";
  }
  return "I'd say: I'll keep the existing event dedup logic and make only the next requested change.";
};

const mockEventDedupCode = (stageId: string) => {
  if (/final_tests|deque/.test(stageId)) {
    return [
      "from collections import deque",
      "",
      "def count_event_types(lines):",
      "    counts = {}",
      "    seen_ids = set()",
      "    recent_events = deque()",
      "    for line in lines:",
      "        parts = line.split(\"|\")",
      "        if len(parts) != 3:",
      "            continue",
      "        timestamp_raw, event_id, event_type = parts",
      "        if not event_id or not event_type:",
      "            continue",
      "        try:",
      "            timestamp = int(timestamp_raw)",
      "        except ValueError:",
      "            continue",
      "",
      "        while recent_events and timestamp - recent_events[0][0] > 300:",
      "            old_timestamp, old_id = recent_events.popleft()",
      "            seen_ids.discard(old_id)",
      "",
      "        if event_id in seen_ids:",
      "            continue",
      "",
      "        seen_ids.add(event_id)",
      "        recent_events.append((timestamp, event_id))",
      "        counts[event_type] = counts.get(event_type, 0) + 1",
      "",
      "    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))",
      "",
      "assert count_event_types([\"0|a1|click\", \"10|a1|view\"]) == [(\"click\", 1)]",
      "assert count_event_types([\"0|a1|click\", \"301|a1|view\"]) == [(\"click\", 1), (\"view\", 1)]",
      "assert count_event_types([\"bad line\", \"x|a1|click\", \"1||view\"]) == []",
      "assert count_event_types([\"0|a1|view\", \"1|a2|click\"]) == [(\"click\", 1), (\"view\", 1)]",
    ].join("\n");
  }
  if (/return_contract|malformed/.test(stageId)) {
    return [
      "def count_event_types(lines):",
      "    counts = {}",
      "    seen_ids = set()",
      "    recent_events = []",
      "    for line in lines:",
      "        parts = line.split(\"|\")",
      "        if len(parts) != 3:",
      "            continue",
      "        timestamp_raw, event_id, event_type = parts",
      "        if not event_id or not event_type:",
      "            continue",
      "        try:",
      "            timestamp = int(timestamp_raw)",
      "        except ValueError:",
      "            continue",
      "",
      "        while recent_events and timestamp - recent_events[0][0] > 300:",
      "            old_timestamp, old_id = recent_events.pop(0)",
      "            seen_ids.discard(old_id)",
      "",
      "        if event_id in seen_ids:",
      "            continue",
      "",
      "        seen_ids.add(event_id)",
      "        recent_events.append((timestamp, event_id))",
      "        counts[event_type] = counts.get(event_type, 0) + 1",
      "",
      "    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))",
    ].join("\n");
  }
  if (/window_membership_stale_bug|window_membership|window_bug/.test(stageId)) {
    return [
      "def count_event_types(lines):",
      "    counts = {}",
      "    seen_ids = set()",
      "    recent_events = []",
      "    for line in lines:",
      "        timestamp, event_id, event_type = line.split(\"|\")",
      "        timestamp = int(timestamp)",
      "",
      "        while recent_events and timestamp - recent_events[0][0] > 300:",
      "            old_timestamp, old_id = recent_events.pop(0)",
      "            seen_ids.discard(old_id)",
      "",
      "        if event_id in seen_ids:",
      "            continue",
      "",
      "        seen_ids.add(event_id)",
      "        recent_events.append((timestamp, event_id))",
      "        counts[event_type] = counts.get(event_type, 0) + 1",
      "    return counts",
    ].join("\n");
  }
  if (/sliding_window|window_requirement/.test(stageId)) {
    return [
      "def count_event_types(lines):",
      "    counts = {}",
      "    seen_ids = set()",
      "    for line in lines:",
      "        timestamp, event_id, event_type = line.split(\"|\")",
      "        if event_id in seen_ids:",
      "            continue",
      "        seen_ids.add(event_id)",
      "        counts[event_type] = counts.get(event_type, 0) + 1",
      "    return counts",
    ].join("\n");
  }
  if (/visible_duplicate_count_bug/.test(stageId)) {
    return [
      "def count_event_types(lines):",
      "    counts = {}",
      "    seen_ids = set()",
      "    for line in lines:",
      "        timestamp, event_id, event_type = line.split(\"|\")",
      "        if event_id in seen_ids:",
      "            continue",
      "        seen_ids.add(event_id)",
      "        counts[event_type] = counts.get(event_type, 0) + 1",
      "    return counts",
    ].join("\n");
  }
  return [
    "def count_event_types(lines):",
    "    counts = {}",
    "    seen_ids = set()",
    "    for line in lines:",
    "        timestamp, event_id, event_type = line.split(\"|\")",
    "        if event_id in seen_ids:",
    "            continue",
    "        seen_ids.add(event_id)",
    "        counts[event_type] = counts.get(event_type, 0) + 1",
    "    return counts",
  ].join("\n");
};

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
    const instructions = String(payload.instructions || "");
    const wantsConversationAssist = payload.stream === true
      && !payload.text?.format
      && /conversation side-channel|panel izquierdo|chat/i.test(`${instructions}\n${input}`);
    const stageId = input.match(/stage_id:\s*([A-Za-z0-9_-]+)/i)?.[1]?.trim() ?? "";
    const latestActionableInput = input.match(/<latest_actionable_input>\s*([\s\S]*?)\s*<\/latest_actionable_input>/i)?.[1] ?? "";
    const actionText = latestActionableInput || input;
    const wantsEventDedup = /event_dedup_windowed_metrics_followups|count_event_types|event_id|event_type|recent_events/.test(input);
    if (wantsEventDedup) {
      if (wantsConversationAssist) {
        const conversationText = mockEventDedupConversation(stageId);
        if (payload.stream === true) {
          response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: conversationText })}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(createOutputPayload(conversationText)));
        return;
      }
      const code = mockEventDedupCode(stageId);
      const structured = makeCodingPayload(code, /bug|requirement|contract|final_tests/.test(stageId) ? "follow_up_change" : "initial_solution", "Event dedup windowed metrics");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(createOutputPayload(JSON.stringify(structured))));
      return;
    }
    const inferredFunctionName = /sentence|word appears|count_words|count words|frequency/i.test(latestActionableInput || input)
      ? "count_words"
      : "";
    const functionName = extractExpectedFunction(input) || inferredFunctionName || "hello";
    const signatureMatch = input.match(new RegExp(`(?:async\\s+def|def)\\s+${functionName}\\s*\\(([^)\\n]*)\\)`, "m"));
    const params = signatureMatch?.[1] ?? (functionName === "count_words" ? "sentence" : "");
    const hasPriorLiveCodingSolution = /current_live_coding_solution|previous_solution_code|follow_up_rule/i.test(input);
    const wantsInput = hasPriorLiveCodingSolution
      && /input|entrada|ingres|type|typed|poner su nombre/i.test(actionText);
    const wantsNormalizeInitialBaseline = functionName === "normalize_name"
      && /nothing fancy|trim it|make it lowercase|leading and trailing whitespace|just leading and trailing/i.test(actionText)
      && !/one small change|internal spaces should become|multiple spaces should count|quick tests|add a few quick tests/i.test(actionText);
    const wantsNormalizeTests = functionName === "normalize_name"
      && !wantsNormalizeInitialBaseline
      && !/collapse_spaces/i.test(stageId)
      && (/tests?|assert|empty|tabs?/i.test(actionText) || /tests/i.test(stageId));
    const wantsNormalizeCollapsedSpaces = functionName === "normalize_name"
      && !wantsNormalizeTests
      && !wantsNormalizeInitialBaseline
      && (/internal spaces|multiple spaces|underscores|espacios internos|varios espacios/i.test(actionText) || /collapse_spaces/i.test(stageId));
    const wantsWordSorting = functionName === "count_words"
      && (/case-insensitive|descending count|alphabetical|sorted|ties/i.test(actionText) || /stage_02_sorting_followup/i.test(stageId));
    if (wantsConversationAssist) {
      const conversationText = wantsWordSorting
        ? "I'd say: I'll keep the existing counting logic and only change the return step: sort by frequency descending, then alphabetically for ties."
        : wantsNormalizeTests
          ? "I'd say: I'll keep the implementation as-is and add a few small asserts for the normal case, empty input, and mixed whitespace."
          : wantsNormalizeCollapsedSpaces
            ? "I'd say: I'll keep the trim -> lowercase flow, then change the internal spaces part: split the name and join it back with underscores."
            : functionName === "count_words"
              ? /initial_code/i.test(stageId)
                ? "I'd say: I'll preserve the visible count_words signature and keep it simple: split the sentence, count each word in a dictionary, and return the counts."
                : "I'd say: I'll start by splitting the sentence into words and using a dictionary to count each word, then refine if they ask for sorting or case rules."
              : "I'd say: I'll start with the visible function and keep it direct: strip outer spaces -> lower the name -> return it, without touching internal spaces yet.";
      if (payload.stream === true) {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: conversationText })}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(createOutputPayload(conversationText)));
      return;
    }
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
  const target = await getPageTarget((item) => String(item.url).includes("#/overlay"), 10000)
    ?? await getPageTarget((item) => String(item.url).includes("#/coding"), 10000);
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
      window.callpilotDesktop.onAnswerDetailChunk((payload) => window.__callpilotReplayEvents.push({ type: "detail", at: Date.now(), payload })),
      window.callpilotDesktop.onRawModelOutput((payload) => window.__callpilotReplayEvents.push({ type: "raw", at: Date.now(), payload })),
      window.callpilotDesktop.onStructuredAnswer((payload) => window.__callpilotReplayEvents.push({ type: "structured", at: Date.now(), payload })),
      window.callpilotDesktop.onScreenContextPublished((payload) => window.__callpilotReplayEvents.push({ type: "screen", at: Date.now(), payload }))
    ];
    return true;
  })()`);
};

const isRequestEvent = (event: { payload: any }, requestId: string | undefined) =>
  !requestId || !event.payload?.requestId || event.payload.requestId === requestId;

const isConversationAssistEvent = (event: { payload: any }, codingRequestId: string | undefined, chatRequestId: string | undefined) => {
  const requestId = String(event.payload?.requestId || "");
  return event.payload?.audience === "chat"
    || Boolean(chatRequestId && requestId === chatRequestId)
    || Boolean(codingRequestId && requestId === `${codingRequestId}-chat`);
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

const publishScreen = async (
  client: CdpClient,
  text: string,
  imagePath: string,
  metadata: { visualRole?: string; visibleFile?: string; panelLabel?: string } = {},
) => {
  const result = await evaluate<any>(client, `window.callpilotDesktop.publishScreenContext({
    visibleText: ${JSON.stringify(text)},
    screenshotPath: ${JSON.stringify(imagePath)},
    displayName: ${JSON.stringify(imagePath ? path.basename(imagePath) : "manual-screen-text")},
    source: "e2e_live_coding_replay",
    visualRole: ${JSON.stringify(metadata.visualRole ?? "")},
    visibleFile: ${JSON.stringify(metadata.visibleFile ?? "")},
    panelLabel: ${JSON.stringify(metadata.panelLabel ?? "")},
    capturedAt: Date.now()
  })`);
  if (!result?.ok) throw new Error(`screen:publish-context failed: ${result?.error || "unknown"}`);
};

const resolveStageScreenText = async (
  client: CdpClient,
  imagesInput: string[] | LoadedVisualContextImage[],
  timings: Record<string, number>,
) => {
  const imageDescriptors = imagesInput.map((item): LoadedVisualContextImage =>
    typeof item === "string"
      ? { path: item, role: "unknown", visibleFile: "", panelLabel: "" }
      : item,
  );
  if (imageDescriptors.length === 0) {
    return { text: "", images: [], ocrResult: null, visionResult: null };
  }
  const images = [];
  for (let index = 0; index < imageDescriptors.length; index += 1) {
    const descriptor = imageDescriptors[index];
    const imagePath = descriptor.path;
    const imageTimings: Record<string, number> = {};
    const screen = await resolveScreenText(client, imagePath, "", imageTimings);
    timings[`resolve_screen_text_${index + 1}_ms`] = Object.values(imageTimings).reduce((sum, value) => sum + value, 0);
    images.push({
      path: imagePath,
      role: descriptor.role,
      visibleFile: descriptor.visibleFile,
      panelLabel: descriptor.panelLabel,
      text: screen.text,
      ocrResult: screen.ocrResult,
      visionResult: screen.visionResult,
    });
  }
  const text = images
    .map((image, index) => [
      `[screenshot ${index + 1}/${images.length}: ${path.basename(image.path)}]`,
      image.role && image.role !== "unknown" ? `role: ${image.role}` : "",
      image.visibleFile ? `file: ${image.visibleFile}` : "",
      image.panelLabel ? `panel: ${image.panelLabel}` : "",
      image.text,
    ].filter(Boolean).join("\n"))
    .join("\n\n")
    .trim();
  return {
    text,
    images,
    ocrResult: images[0]?.ocrResult ?? null,
    visionResult: images[0]?.visionResult ?? null,
  };
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
  `answer_action: ${stage.answerAction ?? "both"}`,
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

const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_`"'(){}\[\],.;:!?|>=-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const includesTerm = (text: string, term: string) => {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return text.toLowerCase().includes(term.toLowerCase());
  return normalizeText(text).includes(normalizedTerm);
};

const includesCodeTerm = (code: string, term: string) => code.toLowerCase().includes(term.toLowerCase());

const hasAny = (text: string, patterns: RegExp[]) => {
  const normalized = normalizeText(text);
  return patterns.some((pattern) => pattern.test(normalized));
};

const normalizePythonSignature = (signature: string): string =>
  signature
    .replace(/\s+/g, " ")
    .replace(/\s*([(),:=])\s*/g, "$1")
    .replace(/\s*->\s*/g, "->")
    .trim();

const validateConversationSemanticChecks = (text: string, checks: LoadedConversationAssistExpected["semanticChecks"]) => {
  const failures: string[] = [];
  const normalized = normalizeText(text);
  if (checks.naturalSpokenTone && !hasAny(text, [/\bi d say\b/, /\bi ll\b/, /\bvoy\b/, /\bempez/, /\bprimero\b/, /\bahora\b/, /\bmantendr/, /\bnecesito\b/, /\bconfirm/])) {
    failures.push("conversation assist does not sound like a spoken candidate plan");
  }
  if (checks.noCodeBlock && /```|\bdef\s+\w+\s*\(|\bclass\s+\w+/.test(text)) {
    failures.push("conversation assist includes a code block or full code shape");
  }
  if (checks.noLongCode && (normalized.match(/\b(if|for|while|return|continue|try|except)\b/g)?.length ?? 0) > 5) {
    failures.push("conversation assist is contaminated with too much code-like detail");
  }
  if (checks.eventDedupPlan) {
    if (!hasAny(text, [/split|separ|divid|parse|proces|line/])) failures.push("conversation assist does not describe reading/parsing event lines");
    if (!hasAny(text, [/dedup|duplic|vist|seen|conjunto|id/])) failures.push("conversation assist does not describe event_id deduplication");
    if (!hasAny(text, [/count|conte|cuenta|contador|tipo de evento|event type|event_type/])) failures.push("conversation assist does not describe counting event types");
  }
  if (checks.duplicateSemantics) {
    if (!hasAny(text, [/primer|first/])) failures.push("conversation assist does not preserve first-occurrence semantics");
    if (!hasAny(text, [/ignor|skip|saltar|omitir|no volv/])) failures.push("conversation assist does not describe ignoring later duplicates");
    if (!hasAny(text, [/suficient|actual|sin necesidad|no necesito|conjunto|seen/])) failures.push("conversation assist does not explain why the current set-based state is enough");
  }
  if (checks.windowPlan) {
    if (!hasAny(text, [/cinco|five|\b5\b|\b300\b/])) failures.push("conversation assist does not mention the five-minute/300-second window");
    if (!hasAny(text, [/ventana|window|timestamp|tiempo/])) failures.push("conversation assist does not ground the plan in timestamp/window context");
    if (!hasAny(text, [/expir|elimin|quit|remov|viejo|antigu|old/])) failures.push("conversation assist does not describe expiring old ids");
    if (!hasAny(text, [/orden|llegan|sorted|timestamp/])) failures.push("conversation assist does not mention ordered arrival context");
  }
  if (checks.staleSetBug) {
    if (!hasAny(text, [/coher|sincron|consistent|stale|obsolet|out of sync|drift|membres|actualiz|ya no deber/])) failures.push("conversation assist does not describe stale/out-of-sync state");
    if (!hasAny(text, [/seen|conjunto|set|vist/])) failures.push("conversation assist does not mention the seen-id membership state");
    if (!hasAny(text, [/elimin|quit|discard|remove|expir/])) failures.push("conversation assist does not describe removing expired ids from seen state");
    if (!hasAny(text, [/recent events|recent_events|tupla|tuple|evento expir/])) failures.push("conversation assist does not connect the fix to recent_events");
  }
  if (checks.malformedSortingPlan) {
    if (!hasAny(text, [/malform|invalid|bad line|linea mala|lineas malas/])) failures.push("conversation assist does not mention malformed input handling");
    if (!hasAny(text, [/ignor|skip|saltar|omitir|no romper|sin lanzar/])) failures.push("conversation assist does not describe skipping malformed lines safely");
    if (!hasAny(text, [/orden|sort|descendent|alfabet|alphabet/])) failures.push("conversation assist does not describe sorted return semantics");
    if (!hasAny(text, [/mantener|preserv|conservar|ventana|window|existente/])) failures.push("conversation assist does not preserve the existing window logic");
  }
  if (checks.dequeTestsPlan) {
    if (!hasAny(text, [/deque|popleft/])) failures.push("conversation assist does not mention deque/popleft optimization");
    if (!hasAny(text, [/test|assert|prueb/])) failures.push("conversation assist does not mention tests/assertions");
    if (!hasAny(text, [/duplic|expir|malform|orden|sort/])) failures.push("conversation assist does not cover the expected test scenario families");
    if (!hasAny(text, [/o 1|complej|complexity|frente|front/])) failures.push("conversation assist does not describe the front-removal complexity improvement");
  }
  if (checks.initialPlan) {
    if (!hasAny(text, [/prioridad|priority/])) failures.push("conversation assist does not mention priority ordering");
    if (!hasAny(text, [/simple|direct|rudiment|basico|natural|primero/])) failures.push("conversation assist does not frame the first pass as simple/natural");
  }
  if (checks.mentionsStableTiesConceptually || checks.stableTieByOriginalPosition) {
    if (!hasAny(text, [/estable|stable|empate|tie|orden original|aparicion|input order/])) failures.push("conversation assist does not mention stable ordering for ties");
  }
  if (checks.doesNotPrematurelyOptimize) {
    if (!hasAny(text, [/simple|direct|rudiment|no opt|sin optim|todavia no|por ahora/])) {
      failures.push("conversation assist does not keep the first pass intentionally simple");
    }
  }
  if (checks.doesNotInventDependencies || checks.doesNotAddValidationYet) {
    if (!hasAny(text, [/por ahora|todavia no|si lo piden|sin meter|mantener|solo/])) {
      failures.push("conversation assist does not avoid future requirements clearly");
    }
  }
  if (checks.distinguishesSmallTalkFromTask) {
    if (!hasAny(text, [/ignorar|separar|small talk|ruido|foco|problema/])) failures.push("conversation assist does not separate small talk from the task");
  }
  if (checks.acknowledgesRudimentaryComplexity) {
    if (!hasAny(text, [/o n 2|n 2|cuadr|rudiment|no opt|simple/])) failures.push("conversation assist does not acknowledge the rudimentary complexity");
  }
  if (checks.clarificationOnly || checks.explicitlyAvoidsCodeChange) {
    if (!hasAny(text, [/sin cambiar|no cambi|mantendr|aclar|confirm|mismo codigo|no toc/])) failures.push("conversation assist does not treat the turn as clarification-only");
  }
  if (checks.bugExplanation) {
    if (!hasAny(text, [/bug|fall|error|orden|antes|despues|membership|seen|duplic/])) failures.push("conversation assist does not explain the duplicate membership/order bug");
  }
  if (checks.describesLocalizedPatch) {
    if (!hasAny(text, [/local|pequen|solo|minimo|mover|antes de agregar|check/])) failures.push("conversation assist does not describe a localized patch");
  }
  if (checks.multiStepFollowupPlan) {
    if (!hasAny(text, [/paso|iter|primero|luego|despues|mantener/])) failures.push("conversation assist does not describe a step-by-step follow-up plan");
  }
  if (checks.mentionsReadyTasksConceptually) {
    if (!hasAny(text, [/ready|listas|disponibles|dependencias satisfechas|pueden correr/])) failures.push("conversation assist does not mention ready tasks conceptually");
  }
  if (checks.mentionsNoProgressMeansBlocked) {
    if (!hasAny(text, [/sin progreso|no progress|bloquead|blocked|atasc|no puedo avanzar/])) failures.push("conversation assist does not mention no-progress blocked detection");
  }
  if (checks.doesNotClassifyBlockedReasonsYet) {
    if (hasAny(text, [/missing_dependency|cycle|ciclo|ausente/])) failures.push("conversation assist classifies blocked reasons before requested");
  }
  if (checks.contractChangePlan) {
    if (!hasAny(text, [/contrato|return|devolver|scheduled|blocked|bloquead/])) failures.push("conversation assist does not mention the return-contract change");
  }
  if (checks.mentionsPreservingExistingApproach || checks.mentionsPreservingExistingContracts || checks.mentionsPreservingHelpersAndLoop) {
    if (!hasAny(text, [/mantener|preserv|conservar|helper|normaliz|loop|contrato|existente/])) failures.push("conversation assist does not mention preserving existing behavior/helpers");
  }
  if (checks.dirtyInputPlan) {
    if (!hasAny(text, [/malform|sucio|invalid|valid|normaliz|priority|id/])) failures.push("conversation assist does not mention dirty input/normalization");
  }
  if (checks.separatesNormalizationFromScheduling) {
    if (!hasAny(text, [/normaliz|limpiar|parse/]) || !hasAny(text, [/scheduler|orden|schedule|planificar/])) {
      failures.push("conversation assist does not separate normalization from scheduling");
    }
  }
  if (checks.mentionsFirstValidDuplicatePolicy) {
    if (!hasAny(text, [/primer|first/]) || !hasAny(text, [/duplic|id repet|valid/])) failures.push("conversation assist does not mention first-valid duplicate policy");
  }
  if (checks.multiScreenshotContextPlan) {
    if (!hasAny(text, [/pantalla|captura|screenshot|scroll|arriba|medio|abajo|vista completa|codigo largo/])) failures.push("conversation assist does not mention using the multi-screenshot code context");
  }
  if (checks.usesSimplifiedClassificationRule) {
    if (!hasAny(text, [/missing|ausente|conocid|known|cycle|ciclo|bloquead/])) failures.push("conversation assist does not describe the simplified blocked classification rule");
  }
  if (checks.optimizationPlan) {
    if (!hasAny(text, [/optim|mejor|heap|grafo|graph|indegree|cola/])) failures.push("conversation assist does not describe the optimization plan");
  }
  if (checks.mentionsHeapAndDependencyGraphConceptually) {
    if (!hasAny(text, [/heap|cola de prioridad|priority queue/]) || !hasAny(text, [/grafo|graph|indegree|depend/])) {
      failures.push("conversation assist does not mention heap and dependency graph concepts");
    }
  }
  if (checks.testsPlan) {
    if (!hasAny(text, [/test|assert|prueb|casos/])) failures.push("conversation assist does not mention tests/assertions");
  }
  if (checks.mentionsRequestedCoverage) {
    if (!hasAny(text, [/vacio|empty|empate|tie|depend|duplic|malform|missing|cycle|ciclo/])) failures.push("conversation assist does not mention requested test coverage families");
  }
  if (checks.givesConciseComplexityExplanation) {
    if (!hasAny(text, [/complej|complexity|o n|log|e\b|edges|aristas/])) failures.push("conversation assist does not give a concise complexity explanation");
  }
  if (checks.perceivesImplementationSurface) {
    if (!hasAny(text, [/implement|codigo|code|funcion|function|archivo|file|editor/])) failures.push("conversation assist does not identify the implementation surface");
  }
  if (checks.perceivesTestsAsEvidence) {
    if (!hasAny(text, [/test|assert|expected|esperad|caso|coverage|validar/])) failures.push("conversation assist does not treat tests as behavioral evidence");
  }
  if (checks.perceivesInstructionsAsContract) {
    if (!hasAny(text, [/instruccion|instruction|readme|contrato|contract|requisit|requirement/])) failures.push("conversation assist does not treat instructions as contract");
  }
  if (checks.perceivesTerminalFailure) {
    if (!hasAny(text, [/terminal|output|traceback|error|failed|falla|exception|actual|expected/])) failures.push("conversation assist does not identify terminal failure evidence");
  }
  if (checks.usesPriorVisualContext) {
    if (!hasAny(text, [/antes|previo|previous|ya vimos|tests? vistos|archivo.*visto|mantener|combinar/])) failures.push("conversation assist does not connect current request to prior visual context");
  }
  if (checks.doesNotInventUnseenVisualContent) {
    if (!hasAny(text, [/no invent|no asumir|si no lo veo|falt|necesit|confirm|assum/])) failures.push("conversation assist does not show caution about unseen visual content");
  }
  return failures;
};

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

const validatesSortedWordFrequency = (code: string) => {
  const compact = code.replace(/\s+/g, " ");
  const countDescThenWordAsc = /key\s*=\s*lambda\s+([A-Za-z_][\w]*)\s*:\s*\(\s*-\s*\1\s*\[\s*1\s*\]\s*,\s*\1\s*\[\s*0\s*\]\s*\)/.test(compact);
  const helperTuple = /return\s+\(\s*-\s*[A-Za-z_][\w]*\s*\[\s*1\s*\]\s*,\s*[A-Za-z_][\w]*\s*\[\s*0\s*\]\s*\)/.test(compact);
  const sortsItems = /\bsorted\s*\(/.test(code) || /\.sort\s*\(/.test(code);
  return sortsItems
    && /\.items\s*\(\s*\)/.test(code)
    && (countDescThenWordAsc || helperTuple);
};

const validatesSortedEventMetrics = (code: string) => {
  const compact = code.replace(/\s+/g, " ");
  const lambdaSort = /key\s*=\s*lambda\s+([A-Za-z_][\w]*)\s*:\s*\(\s*-\s*\1\s*\[\s*1\s*\]\s*,\s*\1\s*\[\s*0\s*\]\s*\)/.test(compact);
  const namedSortKey = /return\s+\(\s*-\s*[A-Za-z_][\w]*\s*\[\s*1\s*\]\s*,\s*[A-Za-z_][\w]*\s*\[\s*0\s*\]\s*\)/.test(compact);
  return /\bsorted\s*\(/.test(code)
    && /\.items\s*\(\s*\)/.test(code)
    && (lambdaSort || namedSortKey || /reverse\s*=\s*True/.test(code));
};

const validatesDequeWindow = (code: string) =>
  /from\s+collections\s+import\s+deque/.test(code)
  && /\bdeque\s*\(/.test(code)
  && /\.popleft\s*\(/.test(code)
  && /seen_ids\.(?:discard|remove)\s*\(/.test(code);

const validateCodingSemanticChecks = (
  code: string,
  rendered: string,
  stage: LoadedScenarioStage,
  checks: LoadedCodingWorkspaceExpected["semanticChecks"],
) => {
  const failures: string[] = [];
  const compact = code.replace(/\s+/g, " ");
  const hasCodeAny = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(code) || pattern.test(compact));
  if (checks.integratesAllCurrentScreenshots && stage.imagePaths.length > 1) {
    if (!hasCodeAny([/def\s+normalize_tasks\s*\(/]) || !hasCodeAny([/def\s+schedule_tasks\s*\(/])) {
      failures.push("code does not preserve functions spread across the multi-screenshot context");
    }
  }
  if (checks.returnsIdsInPriorityOrder && !hasCodeAny([/priority/, /sorted\s*\(/, /\.sort\s*\(/])) {
    failures.push("code does not order tasks by priority");
  }
  if ((checks.stableForEqualPriority || checks.stableTieByOriginalPosition) && !hasCodeAny([/enumerate\s*\(/, /original_?position/, /\bposition\b/, /\bindex\b/, /\border\b/])) {
    failures.push("code does not preserve stable tie order by original position");
  }
  if (checks.emptyInputReturnsEmptyList && !hasCodeAny([/return\s+\[\]/, /scheduled\s*=\s*\[\]/])) {
    failures.push("code does not have a clear empty-input path");
  }
  if (checks.keepsInitialReadableApproach && hasCodeAny([/heapq/, /indegree/, /networkx/])) {
    failures.push("initial code introduces advanced scheduler machinery too early");
  }
  if (checks.workspaceUnchanged && stage.codePath) {
    const fixtureCode = fs.existsSync(stage.codePath) ? fs.readFileSync(stage.codePath, "utf8").trim() : "";
    if (fixtureCode && normalizeText(code) !== normalizeText(fixtureCode)) failures.push("chat-only stage changed the coding workspace");
  }
  if (checks.membershipCheckBeforeAdd && !hasCodeAny([/if\s+[^:\n]*in\s+seen_ids\s*:/, /seen_ids\.add\s*\(/])) {
    failures.push("code does not show duplicate membership check and seen_ids update");
  }
  if (checks.keepsFirstSelectedDuplicate && !hasCodeAny([/continue/, /seen_ids/])) {
    failures.push("code does not skip later duplicate ids");
  }
  if (checks.localizedFix && hasCodeAny([/heapq/, /indegree/, /networkx/])) {
    failures.push("localized bug fix introduces unrelated optimization machinery");
  }
  if (checks.dependenciesMustBeScheduledFirst && !hasCodeAny([/depends_on/, /scheduled_ids/, /all\s*\(/])) {
    failures.push("code does not enforce dependencies before scheduling a task");
  }
  if (checks.returnsScheduledAndBlocked || checks.preservesReturnContract) {
    if (!hasCodeAny([/return\s+\{\s*["']scheduled["']/, /["']blocked["']\s*:/])) failures.push("code does not return scheduled and blocked collections");
  }
  if (checks.blockedPreservesInputOrder && !hasCodeAny([/remaining/, /for\s+task\s+in\s+normalized/, /for\s+task\s+in\s+tasks/])) {
    failures.push("code does not appear to preserve blocked input order");
  }
  if (checks.noProgressStopsLoop && !hasCodeAny([/progress/, /break/])) {
    failures.push("code does not stop the dependency loop when no progress is possible");
  }
  if (checks.skipsMissingId && !hasCodeAny([/get\s*\(\s*["']id["']/, /continue/])) failures.push("code does not skip tasks missing id");
  if (checks.acceptsIntegerLikeStringPriority && !hasCodeAny([/int\s*\(/])) failures.push("code does not convert integer-like string priorities");
  if (checks.skipsNonConvertiblePriority && !hasCodeAny([/try\s*:/, /except/, /ValueError/, /TypeError/])) failures.push("code does not safely skip non-convertible priorities");
  if (checks.requiresDependsOnList && !hasCodeAny([/isinstance\s*\([^)]*depends_on[^)]*list/, /depends_on.*list/])) failures.push("code does not require depends_on to be a list");
  if (checks.keepsFirstValidDuplicateId && !hasCodeAny([/seen_ids/, /continue/])) failures.push("code does not preserve first valid duplicate id");
  if (checks.preservesOriginalPositionOfValidTasks && !hasCodeAny([/original_?position/, /position/, /enumerate\s*\(/])) failures.push("code does not preserve original position of valid tasks");
  if (checks.keepsNormalizationBehavior || checks.preservesDirtyInputHandling) {
    if (!hasCodeAny([/def\s+normalize_tasks\s*\(/, /try\s*:/, /int\s*\(/])) failures.push("code does not preserve normalization/dirty-input behavior");
  }
  if (checks.scheduledEntriesContainIdAndPriority && !hasCodeAny([/["']id["']\s*:/, /["']priority["']\s*:/])) {
    failures.push("scheduled entries do not clearly contain id and priority");
  }
  if (checks.missingDependencyUsesKnownIds && !hasCodeAny([/known_ids/, /missing_dependency/])) failures.push("code does not classify missing dependencies using known_ids");
  if (checks.remainingKnownDependenciesClassifiedAsCycle && !hasCodeAny([/cycle/, /remaining/])) failures.push("code does not classify remaining known-dependency tasks as cycle");
  if (checks.usesReverseAdjacency && !hasCodeAny([/dependents/, /\.append\s*\(/, /depends_on/])) failures.push("code does not build reverse adjacency/dependents");
  if (checks.usesIndegree && !hasCodeAny([/indegree/, /-= 1|=\s*indegree\[[^\]]+\]\s*-\s*1/])) failures.push("code does not maintain indegree counts");
  if (checks.usesHeapForReadyTasks && !hasCodeAny([/heapq\.heappush/, /heapq\.heappop/])) failures.push("code does not use heapq for ready tasks");
  if (checks.preservesBlockedReasonContract && !hasCodeAny([/missing_dependency/, /cycle/, /reason/])) failures.push("code does not preserve blocked reason contract");
  if (checks.testsBaseCase || checks.testsEmptyInput) {
    if (!hasCodeAny([/assert\s+schedule_tasks\s*\(\s*\[\s*\]/])) failures.push("code does not test empty/base input");
  }
  if (checks.testsStableTies && !hasCodeAny([/assert\s+schedule_tasks/, /priority/, /\bb\b/, /\bc\b/])) failures.push("code does not test stable priority ties");
  if (checks.testsDependencyOrdering && !hasCodeAny([/assert\s+schedule_tasks/, /depends_on/, /network|db/])) failures.push("code does not test dependency ordering");
  if (checks.testsDirtyInput && !hasCodeAny([/priority.*["']2["']|["']2["'].*priority/, /malformed|bad|good/])) failures.push("code does not test dirty input normalization");
  if (checks.testsFirstValidDuplicatePreserved && !hasCodeAny([/duplicate|good|seen|priority.*99/])) failures.push("code does not test first valid duplicate preservation");
  if (checks.testsMissingDependency && !hasCodeAny([/missing_dependency/, /missing/])) failures.push("code does not test missing dependency");
  if (checks.testsCycle && !hasCodeAny([/cycle/, /depends_on/])) failures.push("code does not test cycle blocking");
  if (checks.finalCodeExecutable && !hasCodeAny([/def\s+schedule_tasks\s*\(/, /assert\s+schedule_tasks/])) failures.push("final code is not shaped as executable code plus assertions");
  if (checks.complexityIsReasonable && !hasAny(rendered, [/o n|o\(|log|complej|complexity|heap|indegree|edges|aristas/])) {
    failures.push("rendered answer does not include a reasonable complexity explanation");
  }
  if (checks.doesNotCopyTestsIntoImplementation && hasCodeAny([/\bunittest\b/, /\bpytest\b/, /\bTestCase\b/, /assert\s+.*\(/])) {
    failures.push("implementation solution appears to copy test code into the implementation");
  }
  if (checks.preservesVisibleSignature && stage.codePath) {
    const fixtureCode = fs.existsSync(stage.codePath) ? fs.readFileSync(stage.codePath, "utf8") : "";
    const visibleSignatures = [...fixtureCode.matchAll(/^\s*def\s+([A-Za-z_][\w]*)\s*\(([^)\n]*)\)\s*(?:->\s*([^:\n]+))?\s*:/gm)]
      .map((match) => normalizePythonSignature(`def ${match[1]}(${match[2]})${match[3] ? ` -> ${match[3].trim()}` : ""}:`));
    for (const signature of visibleSignatures) {
      const [namePart] = signature.replace(/^def\s+/, "").split("(");
      if (namePart && !new RegExp(`\\bdef\\s+${namePart}\\s*\\(`).test(code)) {
        failures.push(`code does not preserve visible signature name: ${namePart}`);
      }
    }
  }
  if (checks.updatesImplementationNotTests && hasCodeAny([/class\s+Test/, /\bunittest\.main\s*\(/, /pytest/])) {
    failures.push("coding answer updates tests instead of implementation code");
  }
  return failures;
};

const validatePythonAssertions = (code: string, assertions: string[]) => {
  if (assertions.length === 0) return [];
  const tempDir = fs.mkdtempSync(path.join(reportsDir, "python-assert-"));
  const filePath = path.join(tempDir, "solution_check.py");
  fs.writeFileSync(filePath, [
    code,
    "",
    "# Assertions supplied by the replay fixture; not included in model prompts.",
    ...assertions,
  ].join("\n"), "utf8");
  const result = spawnSync("python", [filePath], { encoding: "utf8", timeout: 10000 });
  if (result.status === 0) return [];
  return [`python assertions failed: ${(result.stderr || result.stdout || "unknown").trim().slice(0, 500)}`];
};

const validateScenarioStageAnswer = (
  scenarioId: string,
  stage: LoadedScenarioStage,
  answerRun: AnswerRun,
) => {
  const codingRules = stage.expectedRules.codingWorkspace;
  const conversationRules = stage.expectedRules.conversationAssist;
  const code = extractCode(answerRun.structured);
  const rendered = answerRun.renderedText.trim();
  const conversationAssist = answerRun.conversationAssistText.trim();
  const failures: string[] = [];
  const expectsCoding = (stage.answerAction ?? "both") !== "chat";
  if (!answerRun.requestResult.ok) failures.push(`request was rejected: ${answerRun.requestResult.error || "unknown"}`);
  if (!answerRun.completed) failures.push("answer did not complete");
  if (expectsCoding) {
    if (!rendered) failures.push("rendered answer is empty");
    if (answerRun.structured?.kind !== "coding") failures.push("structured answer is not coding");
    if (!code.trim()) failures.push("extracted solution code is empty");
    if (codingRules.expectedFunction && !new RegExp(`\\bdef\\s+${codingRules.expectedFunction}\\s*\\(`).test(code)) {
      failures.push(`code does not preserve function ${codingRules.expectedFunction}`);
    }
    for (const term of codingRules.mustContain) {
      if (!includesCodeTerm(code, term)) failures.push(`code missing required term: ${term}`);
    }
    if (codingRules.mustContainAny.length > 0 && !codingRules.mustContainAny.some((term) => includesCodeTerm(code, term))) {
      failures.push(`code missing any required term: ${codingRules.mustContainAny.join(", ")}`);
    }
    for (const term of codingRules.mustPreserve) {
      if (!includesCodeTerm(code, term)) failures.push(`code does not preserve required term: ${term}`);
    }
    for (const term of codingRules.mustNotContain) {
      if (includesCodeTerm(code, term)) failures.push(`code contains forbidden term: ${term}`);
    }
    if (codingRules.semanticChecks.sortedWordFrequency && !validatesSortedWordFrequency(code)) {
      failures.push("code does not sort word frequencies by descending count and ascending word");
    }
    if (codingRules.semanticChecks.sortedEventMetrics && !validatesSortedEventMetrics(code)) {
      failures.push("code does not sort event metrics by descending count and ascending event type");
    }
    if (codingRules.semanticChecks.usesDequeWindow && !validatesDequeWindow(code)) {
      failures.push("code does not use deque/popleft while keeping seen_ids synchronized");
    }
    failures.push(...validateCodingSemanticChecks(code, rendered, stage, codingRules.semanticChecks));
    failures.push(...validatePythonAssertions(code, codingRules.pythonAssertions));
  }
  const expectsConversation = (stage.answerAction ?? "both") !== "coding";
  if (conversationRules && expectsConversation) {
    if (!conversationAssist) failures.push("conversation assist is empty");
    if (!answerRun.conversationAssistRequestId) failures.push("conversation assist request id was not captured");
    if (conversationAssist && wordCount(conversationAssist) > conversationRules.maxWords) {
      failures.push(`conversation assist has ${wordCount(conversationAssist)} words, above ${conversationRules.maxWords}`);
    }
    for (const term of conversationRules.mustContain) {
      if (!includesTerm(conversationAssist, term)) failures.push(`conversation assist missing required term: ${term}`);
    }
    if (conversationRules.mustContainAny.length > 0 && !conversationRules.mustContainAny.some((term) => includesTerm(conversationAssist, term))) {
      failures.push(`conversation assist missing any required term: ${conversationRules.mustContainAny.join(", ")}`);
    }
    conversationRules.mustContainGroups.forEach((group, index) => {
      if (!group.some((term) => includesTerm(conversationAssist, term))) {
        failures.push(`conversation assist missing concept group ${index + 1}: ${group.join(", ")}`);
      }
    });
    for (const term of conversationRules.mustNotContain) {
      if (includesTerm(conversationAssist, term)) failures.push(`conversation assist contains forbidden term: ${term}`);
    }
    failures.push(...validateConversationSemanticChecks(conversationAssist, conversationRules.semanticChecks));
  }
  return {
    ok: failures.length === 0,
    failures: failures.map((failure) => `${scenarioId}/${stage.id}: ${failure}`),
    code,
    rendered,
    conversationAssist,
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

const summarizeCoverage = (loops: any[]): Record<string, CoverageSummaryEntry> => {
  const summary: Record<string, CoverageSummaryEntry> = {};
  for (const loop of loops ?? []) {
    for (const stage of loop.stages ?? []) {
      for (const tag of normalizeCoverageTags(stage.coverage)) {
        const entry = summary[tag] ?? { passed: 0, total: 0, failedStages: [] };
        entry.total += 1;
        if (stage.ok) {
          entry.passed += 1;
        } else {
          entry.failedStages.push(stage.id);
        }
        summary[tag] = entry;
      }
    }
  }
  return summary;
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

const requestAnswer = async (
  mainClient: CdpClient,
  eventClient: CdpClient,
  label: string,
  questionOverride = "",
  audience: "chat" | "coding" | "both" = "both",
): Promise<AnswerRun> => {
  const actionTimings: Record<string, number> = {};
  await timed(actionTimings, "install_event_capture_ms", () => installEventCapture(eventClient));
  await sleep(150);
  const started = Date.now();
  const requestResult = await timed(actionTimings, "request_answer_ipc_ms", () =>
    evaluate<{ ok: boolean; requestId?: string; error?: string }>(mainClient, `window.callpilotDesktop.requestAnswer(${JSON.stringify({ questionOverride, audience })})`));
  const expectedRequestId = requestResult.requestId;
  const events = await timed(actionTimings, "wait_for_terminal_answer_event_ms", () =>
    evaluate<Array<{ type: string; at: number; payload: any }>>(eventClient, `new Promise((resolve) => {
    const started = Date.now();
    const expectedRequestId = ${JSON.stringify(expectedRequestId)};
    const tick = () => {
      const events = window.__callpilotReplayEvents || [];
      const chatRequestId = expectedRequestId ? expectedRequestId + "-chat" : "";
      const terminal = events.find((event) =>
        event.type === "status"
        && (!expectedRequestId || event.payload?.requestId === expectedRequestId)
        && ["completed", "failed", "cancelled"].includes(event.payload?.status)
      );
      const chatDone = events.some((event) =>
        event.type === "detail"
        && event.payload?.done
        && (event.payload?.audience === "chat" || (chatRequestId && event.payload?.requestId === chatRequestId))
      );
      const terminalGraceElapsed = terminal && Date.now() - terminal.at > 2500;
      if ((terminal && (chatDone || terminalGraceElapsed)) || Date.now() - started > ${JSON.stringify(timeoutMs)}) {
        resolve(events);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  })`));
  const chatRequestId = expectedRequestId ? `${expectedRequestId}-chat` : undefined;
  const requestEvents = events.filter((event) => isRequestEvent(event, expectedRequestId));
  const conversationAssistEvents = events.filter((event) => isConversationAssistEvent(event, expectedRequestId, chatRequestId));
  const status = requestEvents.find((event) => event.type === "status" && ["completed", "failed", "cancelled"].includes(event.payload?.status));
  const rawEvent = [...requestEvents].reverse().find((event) => event.type === "raw");
  const conversationRawEvent = [...conversationAssistEvents].reverse().find((event) => event.type === "raw");
  const structuredEvent = requestEvents.find((event) => event.type === "structured");
  const conversationAssistText = conversationAssistEvents
    .filter((event) => event.type === "detail" && !event.payload?.done && typeof event.payload?.text === "string")
    .map((event) => event.payload.text)
    .join("");
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
    conversationAssistText,
    structured,
    requestId: status?.payload?.requestId || structuredEvent?.payload?.requestId,
    conversationAssistRequestId: conversationAssistEvents.find((event) => event.payload?.requestId)?.payload?.requestId,
    rawModelOutput: typeof rawEvent?.payload?.text === "string" ? rawEvent.payload.text : null,
    rawModelOutputStage: rawEvent?.payload?.stage,
    conversationAssistRawModelOutput: typeof conversationRawEvent?.payload?.text === "string" ? conversationRawEvent.payload.text : null,
    conversationAssistRawModelOutputStage: conversationRawEvent?.payload?.stage,
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
    const screenInputs = stage.visualImages.length > 0 ? stage.visualImages : stage.imagePaths;
    const screen = stage.imagePaths.length > 0
      ? await timed(stageTimings, "resolve_screen_text_ms", () => resolveStageScreenText(client, screenInputs, stageTimings))
      : { text: "", ocrResult: null, visionResult: null };
    if (stage.imagePaths.length > 0 && !screen.text.trim()) {
      stages.push({
        id: stage.id,
        order: stage.order,
        coverage: normalizeCoverageTags(stage.coverage),
        ok: false,
        failures: [`${scenario.id}/${stage.id}: screen text is empty after OCR/vision`],
        screenshot: stage.imagePath,
        screenshots: stage.imagePaths,
      });
      ok = false;
      break;
    }
    if (stage.imagePaths.length > 0) {
      const firstVisualImage = stage.visualImages[0];
      await timed(stageTimings, "publish_screen_context_ms", () => publishScreen(client, screen.text, stage.imagePath, {
        visualRole: firstVisualImage?.role,
        visibleFile: firstVisualImage?.visibleFile,
        panelLabel: firstVisualImage?.panelLabel,
      }));
    }
    const eventClient = await timed(stageTimings, "open_session_event_client_ms", () => getSessionEventClient());
    const answerRun = await requestAnswer(
      client,
      eventClient,
      stage.id,
      transcriptPrompt(scenario.id, stage),
      stage.answerAction ?? "both",
    );
    eventClient.close();
    answerRun.actionTimings = { ...stageTimings, ...answerRun.actionTimings };
    const validation = validateScenarioStageAnswer(scenario.id, stage, answerRun);
    const codeChangedFromPreviousStage = previousCode ? validation.code !== previousCode : null;
    previousCode = validation.code || previousCode;
    stages.push({
      id: stage.id,
      order: stage.order,
      answerAction: stage.answerAction ?? "both",
      coverage: normalizeCoverageTags(stage.coverage),
      ok: validation.ok,
      failures: validation.failures,
      screenshot: stage.imagePath,
      screenshots: stage.imagePaths,
      codeFixture: stage.codePath,
      expected: stage.expectedPath,
      transcriptDelta: stage.transcriptPath,
      screen: {
        hasScreenshot: stage.imagePaths.length > 0,
        screenshotCount: stage.imagePaths.length,
        images: screen.images?.map((image: any) => ({
          path: image.path,
          role: image.role,
          visibleFile: image.visibleFile,
          panelLabel: image.panelLabel,
          textChars: image.text.length,
          textPreview: image.text.slice(0, 300),
          ocrOk: image.ocrResult?.ok ?? null,
          ocrConfidence: image.ocrResult?.confidence ?? null,
          visionOk: image.visionResult?.ok ?? null,
        })) ?? [],
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
        conversationAssistRequestId: answerRun.conversationAssistRequestId,
        actionTimings: answerRun.actionTimings,
        renderedText: answerRun.renderedText,
        conversation_assist: answerRun.conversationAssistText,
        parsed_output: answerRun.structured,
        final_rendered_output: answerRun.renderedText,
        raw_model_output: answerRun.rawModelOutput ?? null,
        raw_model_output_stage: answerRun.rawModelOutputStage ?? null,
        raw_model_output_available: Boolean(answerRun.rawModelOutput),
        conversation_assist_raw_model_output: answerRun.conversationAssistRawModelOutput ?? null,
        conversation_assist_raw_model_output_stage: answerRun.conversationAssistRawModelOutputStage ?? null,
        conversation_assist_raw_model_output_available: Boolean(answerRun.conversationAssistRawModelOutput),
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
      for (const imagePath of stage.imagePaths) {
        if (!fs.existsSync(imagePath)) throw new Error(`Screenshot not found for ${stageScenario.id}/${stage.id}: ${imagePath}`);
      }
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
      scenarioReport.coverageSummary = summarizeCoverage(scenarioReport.loops);
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
              conversationAssistRequestId: turn.conversationAssistRequestId,
              actionTimings: turn.actionTimings,
              renderedText: turn.renderedText,
              conversation_assist: turn.conversationAssistText,
              parsed_output: turn.structured,
              final_rendered_output: turn.renderedText,
              raw_model_output: turn.rawModelOutput ?? null,
              raw_model_output_stage: turn.rawModelOutputStage ?? null,
              raw_model_output_available: Boolean(turn.rawModelOutput),
              conversation_assist_raw_model_output: turn.conversationAssistRawModelOutput ?? null,
              conversation_assist_raw_model_output_stage: turn.conversationAssistRawModelOutputStage ?? null,
              conversation_assist_raw_model_output_available: Boolean(turn.conversationAssistRawModelOutput),
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
