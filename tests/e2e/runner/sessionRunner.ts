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
  | "real-coding-reset-flow"
  | "real-suite"
  | "real-vision"
  | "real-audio-track-d"
  | "real-long-session"
  | "real-text-batch"
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
  expected_function?: string;
  starter_code?: string;
  screen_context?: string;
  expected_behavior?: string;
  turns: CodingTurn[];
  critical_failure_categories?: string[];
  notes?: string;
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
  critical_failure_categories?: string[];
  notes?: string;
}

interface SystemDesignScenario {
  scenarioId: string;
  question: string;
  expected_coverage: string[];
  critical_failure_categories?: string[];
  notes?: string;
}

interface TextBatchFixture {
  live_coding_evolutivo?: CodingScenario[];
  live_coding_adversarial?: CodingScenario[];
  technical_interview?: TextInterviewScenario[];
  technical_interview_adversarial?: TextInterviewScenario[];
  background_adversarial?: TextInterviewScenario[];
  system_design?: SystemDesignScenario[];
}

interface VisionScenario {
  scenarioId: string;
  image: string;
  description: string;
  exact_text_present: string[];
  must_not_mention: string[];
  expected_behavior: string;
  critical_failure_categories?: string[];
}

interface AudioTrackDScenario {
  scenarioId: string;
  channel: "mic" | "system";
  audio_file: string;
  profile: "clean" | "laptop_mic_zoom" | "headset_meet" | "phone_speaker_teams" | "noisy_cafe";
  ground_truth_transcript: string;
  test_type: "race_condition_cutoff" | "chunk_boundary_word_split";
  trigger_timestamp_ms: number | null;
  critical_word: string;
  expected_behavior: string;
  critical_word_start_ms?: number;
  critical_word_end_ms?: number;
  boundary_timestamp_ms?: number;
  duration_ms?: number;
  sample_rate_hz?: number;
  tts_provider?: string;
}

interface AudioTrackHEvent {
  eventId: string;
  audio_segment: string;
  channel: "mic" | "system";
  start_ms: number;
  duration_ms: number;
  trigger_answer_ms?: number;
  expected_critical_terms: string[];
  expected_topic: string;
  expected_no_answer: boolean;
  ground_truth_transcript: string;
}

interface AudioTrackHSession {
  sessionId: string;
  mode: "technical_qa" | "behavioral" | "live_coding" | "system_design";
  profile: "clean" | "laptop_mic_zoom" | "headset_meet" | "phone_speaker_teams" | "noisy_cafe";
  duration_ms: number;
  full_duration_ms?: number;
  channels: Array<"mic" | "system" | "both">;
  description: string;
  events: AudioTrackHEvent[];
  expected_checks: {
    latest_question_terms: string[];
    stale_topic_forbidden_terms: string[];
    unsupported_behavioral_specifics: string[];
  };
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

type PublishedAnswerMode = "interview" | "coding";

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
const longSessionMode = process.env.E2E_LONG_SESSION_MODE === "full" ? "full" : "short";
const longSessionLimit = Math.max(1, Number(process.env.E2E_LONG_SESSION_LIMIT || "1"));
const longSessionTimeScale = Math.max(0.01, Number(process.env.E2E_LONG_SESSION_TIME_SCALE || (longSessionMode === "full" ? "0.04" : "0.08")));
let realCalls = 0;

const readJson = <T>(relativePath: string): T =>
  JSON.parse(fs.readFileSync(path.join(fixturesDir, relativePath), "utf8")) as T;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const textBatchFixturePaths = (): string[] => {
  const requested = (argValue("--fixtures") || "batch1,batch2-adversarial")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return requested.map((name) => name.includes("/") || name.includes("\\")
    ? name
    : `text/${name.endsWith(".json") ? name : `${name}.json`}`);
};

const loadTextBatchFixtures = (): Array<{ path: string; fixture: TextBatchFixture }> =>
  textBatchFixturePaths().map((fixturePath) => ({
    path: fixturePath,
    fixture: readJson<TextBatchFixture>(fixturePath),
  }));

const scenarioWithSource = <T extends { scenarioId: string }>(
  fixturePath: string,
  scenarios: T[] | undefined,
  sourceKey: string,
): Array<T & { fixturePath: string; sourceKey: string }> =>
  (scenarios ?? []).map((scenario) => ({ ...scenario, fixturePath, sourceKey }));

const builtinCodingScenarios = (): Array<CodingScenario & { fixturePath: string; sourceKey: string }> => [{
  scenarioId: "coderpad_longest_substring_multiturn",
  language: "python",
  expected_function: "length_of_longest_substring",
  fixturePath: "builtin:coderpad_longest_substring_multiturn",
  sourceKey: "builtin_coderpad",
  starter_code: [
    "def length_of_longest_substring(s):",
    "    # Write your solution here",
    "    pass",
  ].join("\n"),
  screen_context: [
    "CoderPad",
    "Longest Substring Without Repeating Characters",
    "Python 3",
    "Function signature:",
    "def length_of_longest_substring(s):",
    "Return the length of the longest substring without repeating characters.",
    "Examples:",
    "abcabcbb -> 3",
    "bbbbb -> 1",
    "Run Code",
  ].join("\n"),
  expected_behavior: "Maintain executable Python code, keep the function name, and carry prior behavior through follow-up changes.",
  turns: [
    {
      turnId: 1,
      prompt_transcript: "Implement length_of_longest_substring(s) in Python for CoderPad. I need commented code visible and an easy explanation next to it.",
      expected_behavior: "Return an integer length using a sliding window.",
      test_cases: [
        "def _cp_len(value):",
        "    return value[0] if isinstance(value, tuple) else value",
        "assert _cp_len(length_of_longest_substring('abcabcbb')) == 3",
        "assert _cp_len(length_of_longest_substring('bbbbb')) == 1",
        "assert _cp_len(length_of_longest_substring('')) == 0",
      ].join("\n"),
    },
    {
      turnId: 2,
      prompt_transcript: "CoderPad hidden tests are dirty: abba and tmmzuxt are failing in some submissions. Update the existing solution so left never moves backward. Keep the code and explanation.",
      expected_behavior: "Preserve the integer return shape and fix the sliding-window left pointer invariant.",
      test_cases: [
        "assert _cp_len(length_of_longest_substring('abba')) == 2",
        "assert _cp_len(length_of_longest_substring('tmmzuxt')) == 5",
        "assert _cp_len(length_of_longest_substring('pwwkew')) == 3",
      ].join("\n"),
    },
    {
      turnId: 3,
      prompt_transcript: "Follow-up: update the existing function code now to return both the length and one substring as a tuple (length, substring). Preserve all previous edge cases. For empty input return (0, ''). Track best_start and best_len as you scan; do not slice with the final left/right after the loop.",
      expected_behavior: "Update the same function to return (length, substring), preserve previous cases, handle empty input, and track the best window explicitly.",
      test_cases: [
        "length, sub = length_of_longest_substring('abcabcbb')",
        "assert length == 3 and len(sub) == 3 and len(set(sub)) == 3 and sub in 'abcabcbb'",
        "assert length_of_longest_substring('bbbbb') == (1, 'b')",
        "assert length_of_longest_substring('') == (0, '')",
        "length, sub = length_of_longest_substring('tmmzuxt')",
        "assert length == 5 and len(sub) == 5 and len(set(sub)) == 5 and sub in 'tmmzuxt'",
      ].join("\n"),
    },
  ],
  critical_failure_categories: ["missing_code", "wrong_function_name", "lost_followup_state", "python_execution_failure"],
  notes: "Built-in CoderPad baseline kept outside protected fixture assets.",
}, {
  scenarioId: "coderpad_two_sum_reset_flow",
  language: "python",
  expected_function: "two_sum",
  fixturePath: "builtin:coderpad_two_sum_reset_flow",
  sourceKey: "builtin_coderpad",
  starter_code: [
    "def two_sum(nums, target):",
    "    # Write your solution here",
    "    pass",
  ].join("\n"),
  screen_context: [
    "CoderPad",
    "Two Sum",
    "Python 3",
    "Function signature:",
    "def two_sum(nums, target):",
    "Return indices of two numbers that add up to target.",
    "If there is no solution, return None.",
    "Examples:",
    "nums = [2, 7, 11, 15], target = 9 -> [0, 1]",
    "Run Code",
    "Console",
  ].join("\n"),
  expected_behavior: "Maintain executable Python code for Two Sum and update it across follow-ups.",
  turns: [
    {
      turnId: 1,
      prompt_transcript: "Implement Two Sum in Python for CoderPad. Keep commented code visible, explain it simply, and include complexity.",
      expected_behavior: "Return indices for a valid pair or None when absent.",
      test_cases: [
        "assert two_sum([2, 7, 11, 15], 9) == [0, 1]",
        "assert two_sum([1, 2, 3], 99) is None",
      ].join("\n"),
    },
    {
      turnId: 2,
      prompt_transcript: "Follow-up: duplicates are allowed, especially nums=[3,3], target=6. Update the same solution and include a patch.",
      expected_behavior: "Preserve the existing solution and handle duplicate values by storing the prior index before returning.",
      test_cases: [
        "assert two_sum([3, 3], 6) == [0, 1]",
        "assert two_sum([3, 2, 4], 6) == [1, 2]",
      ].join("\n"),
    },
    {
      turnId: 3,
      prompt_transcript: "Add the edge case/test explanation for no solution and negative numbers. Do not destroy the working code.",
      expected_behavior: "Keep the same executable function and mention tests/edge cases.",
      test_cases: [
        "assert two_sum([-3, 4, 3, 90], 0) == [0, 2]",
        "assert two_sum([5], 5) is None",
      ].join("\n"),
    },
  ],
  critical_failure_categories: ["missing_code", "missing_patch", "lost_followup_state", "python_execution_failure"],
  notes: "Built-in E2E reset-flow first exercise.",
}, {
  scenarioId: "coderpad_rotate_matrix_after_reset",
  language: "python",
  expected_function: "rotate",
  fixturePath: "builtin:coderpad_rotate_matrix_after_reset",
  sourceKey: "builtin_coderpad",
  starter_code: [
    "def rotate(matrix):",
    "    # Modify matrix in-place and return it for CoderPad checks",
    "    pass",
  ].join("\n"),
  screen_context: [
    "CoderPad",
    "Rotate Matrix",
    "Python 3",
    "Function signature:",
    "def rotate(matrix):",
    "Rotate an n x n matrix 90 degrees clockwise in-place.",
    "Return the matrix too so tests can assert easily.",
    "Example:",
    "[[1,2,3],[4,5,6],[7,8,9]] -> [[7,4,1],[8,5,2],[9,6,3]]",
    "Run Code",
  ].join("\n"),
  expected_behavior: "Solve Rotate Matrix as a fresh exercise after New exercise, with no Two Sum carry-over.",
  turns: [{
    turnId: 1,
    prompt_transcript: "New CoderPad exercise: implement rotate(matrix) for Rotate Matrix. This is a fresh exercise after clicking New exercise. Keep commented code and an easy explanation.",
    expected_behavior: "Return/modify a matrix rotation solution and do not mention or implement Two Sum.",
    test_cases: [
      "m = [[1,2,3],[4,5,6],[7,8,9]]",
      "assert rotate(m) == [[7,4,1],[8,5,2],[9,6,3]]",
      "m2 = [[1,2],[3,4]]",
      "assert rotate(m2) == [[3,1],[4,2]]",
    ].join("\n"),
  }],
  critical_failure_categories: ["stale_problem_carryover", "missing_code", "python_execution_failure"],
  notes: "Built-in E2E reset-flow second exercise.",
}];

const loadCodingScenarios = (): Array<CodingScenario & { fixturePath: string; sourceKey: string }> =>
  [
    ...loadTextBatchFixtures().flatMap(({ path: fixturePath, fixture }) => [
      ...scenarioWithSource(fixturePath, fixture.live_coding_evolutivo, "live_coding_evolutivo"),
      ...scenarioWithSource(fixturePath, fixture.live_coding_adversarial, "live_coding_adversarial"),
    ]),
    ...builtinCodingScenarios(),
  ];

const systemDesignToInterviewScenario = (
  scenario: SystemDesignScenario & { fixturePath: string; sourceKey: string },
): TextInterviewScenario & { fixturePath: string; sourceKey: string } => ({
  scenarioId: scenario.scenarioId,
  turns: [{ speaker: "interviewer", text: scenario.question }],
  trigger_turn: 1,
  expected_behavior: {
    language: "es",
    expected_topics: scenario.expected_coverage,
    must_stay_on_topic: true,
  },
  critical_failure_categories: scenario.critical_failure_categories,
  notes: scenario.notes,
  fixturePath: scenario.fixturePath,
  sourceKey: scenario.sourceKey,
});

const loadTextInterviewScenarios = (): Array<TextInterviewScenario & { fixturePath: string; sourceKey: string }> =>
  loadTextBatchFixtures().flatMap(({ path: fixturePath, fixture }) => [
    ...scenarioWithSource(fixturePath, fixture.technical_interview, "technical_interview"),
    ...scenarioWithSource(fixturePath, fixture.technical_interview_adversarial, "technical_interview_adversarial"),
    ...scenarioWithSource(fixturePath, fixture.background_adversarial, "background_adversarial"),
    ...scenarioWithSource(fixturePath, fixture.system_design, "system_design").map(systemDesignToInterviewScenario),
  ]);

const loadVisionScenarios = (): VisionScenario[] =>
  readJson<{ scenarios: VisionScenario[] }>("vision/track-g.json").scenarios;

const loadAudioTrackDScenarios = (): AudioTrackDScenario[] =>
  readJson<{ scenarios: AudioTrackDScenario[] }>("audio/track-d.json").scenarios;

const loadAudioTrackHSessions = (): AudioTrackHSession[] =>
  readJson<{ sessions: AudioTrackHSession[] }>("audio/track-h-long-session.json").sessions;

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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const isStringArray = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const hasKeys = (record: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));

const validatePublishedStructuredAnswer = (
  payload: unknown,
  mode: PublishedAnswerMode,
): { ok: boolean; errors: string[]; kind: string | null } => {
  const errors: string[] = [];
  const envelope = asRecord(payload);
  if (!envelope) {
    return { ok: false, errors: ["missing_structured_event"], kind: null };
  }
  if (typeof envelope.requestId !== "string" || !envelope.requestId.trim()) errors.push("requestId");
  if (typeof envelope.renderedText !== "string" || !envelope.renderedText.trim()) errors.push("renderedText");
  if (typeof envelope.timestamp !== "number") errors.push("timestamp");

  const answer = asRecord(envelope.answer);
  if (!answer) {
    errors.push("answer");
    return { ok: false, errors, kind: null };
  }
  const expectedKind = mode === "coding" ? "coding" : "interview";
  const kind = typeof answer.kind === "string" ? answer.kind : null;
  if (kind !== expectedKind) errors.push(`kind:${kind ?? "missing"}`);
  const payloadRecord = asRecord(answer.payload);
  if (!payloadRecord) {
    errors.push("payload");
    return { ok: false, errors, kind };
  }

  if (mode === "interview") {
    const required = [
      "version",
      "answerNeeded",
      "intent",
      "spokenAnswer",
      "keyPoints",
      "correction",
      "assumptions",
      "evidenceRefs",
      "followUpHint",
    ];
    if (!hasKeys(payloadRecord, required)) errors.push("interview_required_fields");
    if (payloadRecord.version !== "1") errors.push("version");
    if (typeof payloadRecord.answerNeeded !== "boolean") errors.push("answerNeeded");
    if (!["technical_qa", "behavioral", "system_design", "clarification", "no_answer"].includes(String(payloadRecord.intent))) errors.push("intent");
    if (typeof payloadRecord.spokenAnswer !== "string" || !payloadRecord.spokenAnswer.trim()) errors.push("spokenAnswer");
    if (!isStringArray(payloadRecord.keyPoints)) errors.push("keyPoints");
    if (!isStringArray(payloadRecord.assumptions)) errors.push("assumptions");
    if (!isStringArray(payloadRecord.evidenceRefs)) errors.push("evidenceRefs");
    const correction = asRecord(payloadRecord.correction);
    if (!correction || typeof correction.needed !== "boolean") errors.push("correction");
  } else {
    const required = [
      "version",
      "answerNeeded",
      "responseType",
      "problem",
      "solution",
      "narration",
      "tests",
      "patch",
    ];
    if (!hasKeys(payloadRecord, required)) errors.push("coding_required_fields");
    if (payloadRecord.version !== "1") errors.push("version");
    if (typeof payloadRecord.answerNeeded !== "boolean") errors.push("answerNeeded");
    if (!["initial_solution", "explanation", "follow_up_change", "debug_fix", "clarification"].includes(String(payloadRecord.responseType))) errors.push("responseType");
    const problem = asRecord(payloadRecord.problem);
    const solution = asRecord(payloadRecord.solution);
    const narration = asRecord(payloadRecord.narration);
    const complexity = asRecord(solution?.complexity);
    if (!problem || typeof problem.language !== "string") errors.push("problem");
    if (!solution || typeof solution.code !== "string") errors.push("solution.code");
    if (!solution || !isStringArray(solution.approachSteps)) errors.push("solution.approachSteps");
    if (!complexity || typeof complexity.time !== "string" || typeof complexity.space !== "string") errors.push("solution.complexity");
    if (!narration || typeof narration.spokenAnswer !== "string") errors.push("narration");
    if (!Array.isArray(payloadRecord.tests)) errors.push("tests");
    if (!asRecord(payloadRecord.patch)) errors.push("patch");
  }

  return { ok: errors.length === 0, errors, kind };
};

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
  return loadCodingScenarios().map((scenario) => {
    const testCaseTurns = scenario.turns.filter((turn) => typeof turn.test_cases === "string" && turn.test_cases.trim());
    const deterministicChecks = {
      hasScenarioId: Boolean(scenario.scenarioId),
      hasAtLeastOneTurn: scenario.turns.length >= 1,
      hasSequentialTurnIds: hasSequentialTurnIds(scenario.turns),
      hasPromptsForEveryTurn: scenario.turns.every((turn) => Boolean(turn.prompt_transcript?.trim())),
      hasExpectedBehaviorForEveryTurn: scenario.turns.every((turn) => Boolean(turn.expected_behavior?.trim() || scenario.expected_behavior?.trim())),
    };
    return {
      scenarioId: scenario.scenarioId,
      track: "live_coding_evolutivo_fixture_validation",
      run: runNumber,
      deterministicChecks,
      judge: null,
      latency_ms: finishLatency("track-f-fixture-validation"),
      diagnostics: {
        fixturePath: scenario.fixturePath,
        sourceKey: scenario.sourceKey,
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

const executablePythonAssertions = (turns: CodingTurn[]): string[] =>
  turns
    .map((turn) => turn.test_cases?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value) => /^(assert|import|from|for|with|def|class|async|if|result\s*=|[a-zA-Z_]\w*\s*=|[a-zA-Z_][\w.]*\()/m.test(value));

const rawTestCases = (turns: CodingTurn[]): string[] =>
  turns
    .map((turn) => turn.test_cases?.trim())
    .filter((value): value is string => Boolean(value));

const codingTurnRequiresCode = (turn: CodingTurn | undefined): boolean => {
  const text = normalizeForChecks([
    turn?.prompt_transcript ?? "",
    turn?.expected_behavior ?? "",
  ].join(" "));
  if (/\b(?:que pasa|y si|como lo testeas|resumime|tradeoff|tradeoffs|alto nivel|cuando|por que)\b/.test(text)) {
    return false;
  }
  return /\b(?:implement|resolve|resolv|correg|optimiza|agrega|agregale|escrib|invert|merge|funcion|clase|endpoint|test)\b/.test(text);
};

const forbiddenVisionMentions = (answerText: string, forbiddenItems: string[]): string[] => {
  const normalized = normalizeForChecks(answerText);
  const hasCodeLikeOutput = /```|^\s*(?:def|class|function|const|let|var|import|return)\b|here is the code|codigo:|solution code/i.test(answerText);
  return forbiddenItems.filter((item) => {
    const forbidden = normalizeForChecks(item);
    if (normalized.includes(forbidden)) return true;
    if (/\b(?:codigo|code|solucion)\b/.test(forbidden) && hasCodeLikeOutput) return true;
    if (/\bslack\b/.test(forbidden) && /\b(?:slack|standup|martina|pr de ayer|team-standup)\b/.test(normalized)) return true;
    if (/\bkeyerror\b/.test(forbidden) && /\bkeyerror\b/.test(normalized)) return true;
    if (/\bindexerror\b/.test(forbidden) && !/\bindexerror\b/.test(normalized)) return true;
    return false;
  });
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const expectedPythonFunctionName = (scenario: CodingScenario): string | null => {
  if (scenario.expected_function?.trim()) return scenario.expected_function.trim();
  const functionFromStarter = scenario.starter_code?.match(/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1];
  if (functionFromStarter) return functionFromStarter;
  const functionFromScreen = scenario.screen_context?.match(/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1];
  if (functionFromScreen) return functionFromScreen;
  return scenario.scenarioId === "coding_evol_two_sum" ? "two_sum" : null;
};

const definesExpectedPythonFunction = (code: string, scenario: CodingScenario): boolean => {
  const expectedFunction = expectedPythonFunctionName(scenario);
  if (!expectedFunction) return true;
  return new RegExp(`\\bdef\\s+${escapeRegExp(expectedFunction)}\\s*\\(`).test(code);
};

const makeCodingPayloadFromCode = (scenario: CodingScenario, code: string) => ({
  version: "1",
  answerNeeded: true,
  responseType: "solution",
  problem: {
    title: scenario.screen_context?.split(/\r?\n/).find((line) => line.trim() && !/coderpad|python|function signature|run code/i.test(line))?.trim()
      || scenario.scenarioId,
    summary: scenario.expected_behavior || scenario.turns[0]?.expected_behavior || "Live coding exercise",
    language: scenario.language === "javascript" ? "JavaScript" : "Python",
    functionSignature: expectedPythonFunctionName(scenario) ? `def ${expectedPythonFunctionName(scenario)}(...)` : null,
    constraints: [],
  },
  solution: {
    approachSteps: ["Preserve prior passing behavior while applying the latest follow-up."],
    code,
    complexity: { time: "", space: "", rationale: "" },
    edgeCases: [],
    invariants: [],
  },
  narration: {
    spokenAnswer: "Current live coding solution carried from the previous turn.",
    currentStep: "Update the existing solution for the latest interviewer request.",
  },
  tests: [],
  patch: { kind: "none", code: null },
});

const extractPythonCode = (text: string, expectedFunction?: string | null): string => {
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
  const expectedFunctionPattern = expectedFunction
    ? new RegExp(`\\bdef\\s+${escapeRegExp(expectedFunction)}\\s*\\(`)
    : /\bdef\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/;
  const exactFunctionBlock = fencedBlocks.find((block) => expectedFunctionPattern.test(block));
  if (exactFunctionBlock) return exactFunctionBlock;
  const fenced = fencedBlocks[0];
  if (fenced) return fenced;
  const defIndex = text.search(expectedFunctionPattern);
  if (defIndex >= 0) return text.slice(defIndex).replace(/\*\*[\s\S]*$/m, "").trim();
  return "";
};

const normalizeForChecks = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const normalizedWords = (text: string): string[] =>
  normalizeForChecks(text).match(/[a-z0-9]+/g) ?? [];

const containsOrderedWords = (actual: string, expected: string): boolean => {
  const actualWords = normalizedWords(actual);
  const expectedWords = normalizedWords(expected);
  let cursor = 0;
  for (const expectedWord of expectedWords) {
    const found = actualWords.findIndex((word, index) => index >= cursor && word === expectedWord);
    if (found < 0) return false;
    cursor = found + 1;
  }
  return true;
};

const containsCriticalWordOrVariant = (actual: string, criticalWord: string): boolean => {
  const normalized = normalizeForChecks(actual);
  const critical = normalizeForChecks(criticalWord);
  if (normalized.includes(critical)) return true;
  if (critical === "checksum") {
    return /\bchecks?\b/.test(normalized) && /\b(?:sum|some|room)\b/.test(normalized);
  }
  return false;
};

const bestNativelyTranscriptText = (payloads: Array<{ text?: unknown; isFinal?: unknown }>): string => {
  let best = "";
  let bestScore = -1;
  for (const payload of payloads) {
    const text = String(payload?.text || "").trim();
    if (!text) continue;
    const score = normalizedWords(text).length * 10 + text.length / 1000 + (payload?.isFinal ? 0.2 : 0);
    if (score >= bestScore) {
      best = text;
      bestScore = score;
    }
  }
  return best;
};

const assembleNativelyTranscriptText = (payloads: Array<{ text?: unknown; isFinal?: unknown }>): string => {
  const finalTexts = payloads
    .filter((payload) => payload?.isFinal)
    .map((payload) => String(payload?.text || "").trim())
    .filter(Boolean);
  const merged: string[] = [];
  for (const text of finalTexts) {
    const normalized = normalizeForChecks(text).replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const last = merged.at(-1) ?? "";
    const normalizedLast = normalizeForChecks(last).replace(/\s+/g, " ").trim();
    if (normalizedLast && normalizedLast.includes(normalized)) continue;
    if (normalizedLast && normalized.includes(normalizedLast)) {
      merged[merged.length - 1] = text;
      continue;
    }
    merged.push(text);
  }
  const finalTranscript = merged.join(" ").replace(/\s+/g, " ").trim();
  return finalTranscript || bestNativelyTranscriptText(payloads);
};

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

const wordCount = (answer: string): number =>
  answer.trim().split(/\s+/).filter(Boolean).length;

const forbiddenTechnicalPatterns: Record<string, RegExp[]> = {
  interview_redis_persistence: [
    /\bredis\b.{0,60}\b(?:relational|relacional)\b/i,
    /\b(?:relational|relacional)\b.{0,60}\bredis\b/i,
  ],
  interview_postgres_indexing: [
    /\b(?:indexes|indices)\b.{0,80}\b(?:always|siempre)\b.{0,80}\b(?:improve|mejoran)\b/i,
  ],
  interview_react_state_vs_ref: [
    /\buseref\b.{0,80}\b(?:triggers?|causes?|dispara|provoca)\b.{0,40}\bre-?render/i,
  ],
  interview_typescript_generics: [
    /\bgenerics?\b.{0,80}\b(?:same as|lo mismo que|igual(?:es)? a)\b.{0,40}\bany\b/i,
  ],
  interview_mongodb_vs_postgres: [
    /\bmongodb\b.{0,80}\b(?:best|mejor|ideal)\b.{0,80}\b(?:complex acid|acid complejo|transacciones acid complejas)\b/i,
  ],
};

const isNegatedRedisRelationalCorrection = (scenarioId: string, answerText: string): boolean =>
  scenarioId === "interview_redis_persistence"
  && (
    /\bredis\b[^.?!]{0,80}\b(?:no|not)\s+(?:es|is)\b[^.?!]{0,80}\b(?:relational|relacional)\b/i.test(answerText)
    || /\bredis\b[^.?!]{0,80}\b(?:no|not)\s+(?:relational|relacional)\b/i.test(answerText)
  );

const forbiddenTechnicalClaims = (scenarioId: string, answerText: string): string[] =>
  (forbiddenTechnicalPatterns[scenarioId] ?? [])
    .filter((pattern) => pattern.test(answerText) && !isNegatedRedisRelationalCorrection(scenarioId, answerText))
    .map((pattern) => pattern.source);

const inventsFastApiProductionExperience = (answerText: string): boolean => {
  const normalized = normalizeForChecks(answerText);
  if (!/\bfastapi\b/.test(normalized)) return false;
  const firstPersonExperience = /\b(yo\s+)?(use|utilice|trabaje|implemente|elegi|he\s+usado|he\s+trabajado|i\s+used|i\s+chose|i\s+built|my\s+project|mi\s+proyecto)\b/.test(normalized);
  const productionClaim = /\b(produccion|production|proyecto|project)\b/.test(normalized);
  const explicitRefusal = /\b(no\s+(diria|digas|afirmaria|inventaria)|not\s+(claim|say|pretend))\b/.test(normalized);
  return !explicitRefusal && (firstPersonExperience || productionClaim);
};

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
    noInventedExperience: expected.first_mention_must_not_invent_experience ? !inventsFastApiProductionExperience(answerText) : true,
    forbiddenTechnicalClaimsAbsent: forbiddenTechnicalClaims(scenario.scenarioId, answerText).length === 0,
    maxWordsPassed: wordCount(answerText) <= 180,
    noQuestionMarkMojibake: !/\?\?/.test(answerText),
    traceRecorded,
  };
};

const runCodingObjectiveSmoke = (): RunResult[] => {
  const scenario = loadCodingScenarios().find((item) => item.scenarioId === "coding_evol_two_sum");
  const assertions = scenario ? executablePythonAssertions(scenario.turns) : [];
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
      rawTestCases: scenario ? rawTestCases(scenario.turns) : [],
      executableAssertions: assertions,
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

const clickButtonByText = async (client: CdpClient, text: string): Promise<boolean> =>
  evaluate<boolean>(client, `(() => {
    const expected = ${JSON.stringify(text.trim().toLowerCase())};
    const buttons = Array.from(document.querySelectorAll("button"));
    const button = buttons.find((item) => (item.textContent || "").trim().toLowerCase().includes(expected));
    if (!button) return false;
    button.click();
    return true;
  })()`);

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

const writePcmWav = (filePath: string, pcm: Buffer, sampleRate = 16000) => {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  fs.writeFileSync(filePath, wav);
};

const slicePcm16k = (pcm: Buffer, startMs: number, endMs: number): Buffer => {
  const bytesPerMs = 16000 * 2 / 1000;
  const startByte = Math.max(0, Math.floor(startMs * bytesPerMs / 2) * 2);
  const endByte = Math.min(pcm.length, Math.ceil(endMs * bytesPerMs / 2) * 2);
  return pcm.subarray(startByte, Math.max(startByte, endByte));
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

const generateCodingProblemImage = (): { path: string; generated: boolean } => {
  fs.mkdirSync(tmpDir, { recursive: true });
  const imagePath = path.join(tmpDir, `two-sum-screen-${Date.now()}.png`);
  const lines = [
    "Two Sum",
    "Python",
    "def two_sum(nums, target):",
    "Given an integer array nums and an integer target,",
    "return indices of the two numbers such that they add up to target.",
    "Return None when there is no solution.",
    "Example: nums = [2, 7, 11, 15], target = 9 -> [0, 1]",
  ];
  if (process.platform === "win32") {
    const escapedPath = imagePath.replace(/'/g, "''");
    const escapedLines = lines.map((line) => `'${line.replace(/'/g, "''")}'`).join(",");
    const command = [
      "Add-Type -AssemblyName System.Drawing",
      "$bmp = New-Object System.Drawing.Bitmap 1100, 620",
      "$g = [System.Drawing.Graphics]::FromImage($bmp)",
      "$g.Clear([System.Drawing.Color]::FromArgb(250,250,250))",
      "$title = New-Object System.Drawing.Font 'Arial', 42, ([System.Drawing.FontStyle]::Bold)",
      "$font = New-Object System.Drawing.Font 'Consolas', 25",
      "$brush = [System.Drawing.Brushes]::Black",
      `$lines = @(${escapedLines})`,
      "$g.DrawString($lines[0], $title, $brush, 40, 35)",
      "for ($i = 1; $i -lt $lines.Length; $i++) { $g.DrawString($lines[$i], $font, $brush, 45, (110 + (($i - 1) * 62))) }",
      `$bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      "$g.Dispose(); $bmp.Dispose(); $title.Dispose(); $font.Dispose()",
    ].join("; ");
    const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
    if (result.status === 0 && fs.existsSync(imagePath) && fs.statSync(imagePath).size > 1000) {
      return { path: imagePath, generated: true };
    }
  }

  const svgPath = imagePath.replace(/\.png$/i, ".svg");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="620">
<rect width="100%" height="100%" fill="#fafafa"/>
${lines.map((line, index) => `<text x="45" y="${index === 0 ? 78 : 120 + index * 58}" font-family="${index === 0 ? "Arial" : "Consolas"}" font-size="${index === 0 ? 42 : 25}" font-weight="${index === 0 ? "700" : "400"}" fill="#111">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`).join("\n")}
</svg>`;
  fs.writeFileSync(svgPath, svg, "utf8");
  return { path: svgPath, generated: true };
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
    codingPayload: null,
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
  const expectedFunction = expectedPythonFunctionName(scenario);
  const previousAnswer = assistantAnswers.filter((answer) => answer.trim()).at(-1) ?? "";
  const previousCode = previousAnswer ? extractPythonCode(previousAnswer, expectedFunction) : "";
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
    scenario.screen_context,
    scenario.starter_code ? `Starter code:\n${scenario.starter_code}` : "",
    !scenario.screen_context && scenario.scenarioId === "coding_evol_two_sum" ? [
      "Two Sum",
      "Python function signature:",
      "def two_sum(nums, target):",
      "Given an integer array nums and an integer target, return indices of the two numbers such that they add up to target.",
      "Return None when there is no solution.",
      "Example: nums = [2, 7, 11, 15], target = 9 -> [0, 1].",
    ].join("\n") : "",
  ].filter(Boolean).join("\n\n");
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
    notes: [
      expectedFunction ? `Preserve the exact function name ${expectedFunction}.` : "Preserve the requested function name.",
      "In Spanish, 'sin que explote' means handle no-solution gracefully without crashing; do not intentionally raise.",
      "For CoderPad/live coding, keep commented executable code visible and place a simple explanation beside it. Follow-ups must update the existing code without losing prior behavior.",
    ].join(" "),
    profile: "",
    targetUseCase: "live coding interview",
    preferredLanguage: scenario.language === "python" ? "spanish" : "english",
    codingLanguage: scenario.language === "javascript" ? "JavaScript" : "Python",
    answerVerbosity: "medium",
    modelProvider: provider,
    modelName,
    question: selectedTurns.at(-1)?.prompt_transcript ?? firstTurn,
    answer: previousAnswer,
    codingPayload: previousCode ? makeCodingPayloadFromCode(scenario, previousCode) : null,
  };
};

const makeEmptyInterviewSession = (provider: "openai" | "nvidia", modelName: string, activeMode: "technical_qa" | "behavioral" | "live_coding" | "system_design") => {
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
    if (Array.isArray(window.__callpilotE2EDispose)) {
      for (const dispose of window.__callpilotE2EDispose) {
        try { dispose?.(); } catch {}
      }
    }
    window.__callpilotE2EEvents = [];
    window.__callpilotE2EDispose = [
      window.callpilotDesktop.onAnswerStatus((payload) => window.__callpilotE2EEvents.push({ type: "status", at: Date.now(), payload })),
      window.callpilotDesktop.onStructuredAnswer((payload) => window.__callpilotE2EEvents.push({ type: "structured", at: Date.now(), payload }))
    ];
    return true;
  })()`);
  await evaluate(overlayClient, `new Promise((resolve) => setTimeout(resolve, 350))`);

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
  const structuredValidation = validatePublishedStructuredAnswer(
    structured?.payload,
    options.mode === "live_coding" ? "coding" : "interview",
  );
  return {
    provider,
    modelName,
    requestResult,
    events,
    completed,
    structured,
    structuredValidation,
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

  const modelName = process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.1-8b-instruct";
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
      structuredSchemaValid: answer.structuredValidation.ok,
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
        structuredValidation: answer.structuredValidation,
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
    const structuredValidation = validatePublishedStructuredAnswer(structured?.payload, "interview");
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
      structuredSchemaValid: structuredValidation.ok,
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
        structuredValidation,
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

  const requestedScenarioId = argValue("--scenario") || "interview_redis_persistence";
  const scenarios = loadTextInterviewScenarios();
  const scenario = scenarios.find((item) => item.scenarioId === requestedScenarioId)
    ?? scenarios[0];
  if (!scenario) throw new Error("No text interview scenario found in text batch fixtures");

  return [await runRealTextInterviewScenario(scenario, "real_text_interview_ipc", "real-text-interview")];
};

const runRealTextInterviewScenario = async (
  scenario: TextInterviewScenario,
  trackName: string,
  latencyLabel: string,
): Promise<RunResult> => {
  checkBudget(1);
  const modelName = process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.1-8b-instruct";
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
      structuredSchemaValid: answer.structuredValidation.ok,
      mentionsRedis: /\bredis\b/i.test(answer.answerText),
      doesNotCallRedisRelational: !/redis\s+(es|is)\s+(una\s+)?(base de datos\s+)?relacional/i.test(normalizedAnswer),
      noQuestionMarkMojibake: !/\?\?/.test(answer.answerText),
      traceRecorded: Boolean(tracePath && traceStatus?.eventCount >= 3),
    } : {
      answerRequestAccepted: answer.requestResult.ok,
      structuredSchemaValid: answer.structuredValidation.ok,
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
        fixturePath: "fixturePath" in scenario ? scenario.fixturePath : undefined,
        sourceKey: "sourceKey" in scenario ? scenario.sourceKey : undefined,
        critical_failure_categories: scenario.critical_failure_categories ?? [],
        provider: "nvidia",
        modelName,
        transcript: scenario.turns,
        answer_received: answer.answerText,
        structuredValidation: answer.structuredValidation,
        forbiddenTechnicalClaims: forbiddenTechnicalClaims(scenario.scenarioId, answer.answerText),
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
  return runRealTextInterviewBatchWithSelection(selectedScenarioIds(), realBatchLimit);
};

const runRealTextInterviewBatchWithSelection = async (
  requested: string[],
  limit: number,
): Promise<RunResult[]> => {
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
  const allScenarios = loadTextInterviewScenarios();
  const scenarios = requested.length > 0
    ? requested.map((id) => {
        const scenario = allScenarios.find((item) => item.scenarioId === id);
        if (!scenario) throw new Error(`Unknown text scenario id: ${id}`);
        return scenario;
      })
    : allScenarios.slice(0, limit);
  if (scenarios.length === 0) return [];
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

  const scenario = loadCodingScenarios().find((item) => item.scenarioId === "coding_evol_two_sum");
  if (!scenario) throw new Error("coding_evol_two_sum scenario not found in text batch fixtures");
  const assertions = executablePythonAssertions(scenario.turns);

  const modelName = process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.1-8b-instruct";
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
    const code = extractPythonCode(answer.answerText, expectedPythonFunctionName(scenario));
    const requiresCode = codingTurnRequiresCode(scenario.turns[0]);
    const execution = code
      ? runPythonAssertions(code, assertions)
      : { ok: !requiresCode && assertions.length === 0, status: null, stdout: "", stderr: requiresCode ? "No executable Python code block was found." : "", timedOut: false };
    const totalLatency = answerDone.events.find((event) => event.stage === "response_complete")?.elapsedMs ?? 0;
    const deterministicChecks = {
      answerRequestAccepted: answer.requestResult.ok,
      answerCompleted: Boolean(answer.completed) && !failed,
      answerNonEmpty: answer.answerText.trim().length > 40,
      structuredSchemaValid: answer.structuredValidation.ok,
      codeBlockFound: requiresCode ? Boolean(code) : true,
      definesExpectedFunction: !requiresCode || definesExpectedPythonFunction(code, scenario),
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
        structuredValidation: answer.structuredValidation,
        extracted_code: code,
        requiresCode,
        rawTestCases: rawTestCases(scenario.turns),
        executableAssertions: assertions,
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
  const modelName = process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.1-8b-instruct";
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
    const code = extractPythonCode(answer.answerText, expectedPythonFunctionName(scenario));
    const requiresCode = codingTurnRequiresCode(scenario.turns[turnCount - 1]);
    const execution = code && assertions.length > 0
      ? runPythonAssertions(code, assertions)
      : { ok: assertions.length === 0 && (!requiresCode || Boolean(code)), status: null, stdout: "", stderr: code || !requiresCode ? "" : "No executable Python code block was found.", timedOut: false };
    const totalLatency = answerDone.events.find((event) => event.stage === "response_complete")?.elapsedMs ?? 0;
    const deterministicChecks = {
      answerRequestAccepted: answer.requestResult.ok,
      answerCompleted: Boolean(answer.completed) && !failed,
      answerNonEmpty: answer.answerText.trim().length > 40,
      structuredSchemaValid: answer.structuredValidation.ok,
      codeBlockFound: requiresCode ? Boolean(code) : true,
      definesExpectedFunction: !code || definesExpectedPythonFunction(code, scenario),
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
          structuredValidation: answer.structuredValidation,
          extracted_code: code,
          requiresCode,
          rawTestCases: rawTestCases(scenario.turns.slice(0, turnCount)),
          executableAssertions: assertions,
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

  const requestedScenarioId = argValue("--scenario") || "coding_evol_two_sum";
  const scenario = loadCodingScenarios().find((item) => item.scenarioId === requestedScenarioId);
  if (!scenario) throw new Error(`${requestedScenarioId} scenario not found in text batch fixtures`);
  const selectedTurns = (argValue("--turns") || "1,2,4")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= scenario.turns.length);
  if (selectedTurns.length === 0) throw new Error("No valid coding turns selected for real multi-turn run.");
  checkBudget(selectedTurns.length);

  const results: RunResult[] = [];
  const assistantAnswers: string[] = [];
  for (const turnCount of selectedTurns) {
    const assertions = executablePythonAssertions(scenario.turns.slice(0, turnCount));
    const { result, answerText } = await runRealCodingTurn(scenario, assertions, turnCount, assistantAnswers, "real_coding_multiturn_ipc");
    results.push(result);
    assistantAnswers[turnCount - 1] = answerText;
  }
  return results;
};

const runRealCodingResetFlow = async (): Promise<RunResult[]> => {
  if (!process.env.NVIDIA_API_KEY && !process.env.CALLPILOT_NVIDIA_API_KEY) {
    return [{
      scenarioId: "coderpad_two_sum_new_exercise_rotate_matrix",
      track: "real_coding_reset_flow_ipc",
      run: runNumber,
      deterministicChecks: {
        nvidiaKeyAvailable: false,
        answerCompleted: false,
        resetClicked: false,
        pythonExecutionPassed: false,
      },
      judge: null,
      latency_ms: finishLatency("real-coding-reset-flow-blocked"),
      diagnostics: {
        blocked: true,
        reason: "NVIDIA_API_KEY or CALLPILOT_NVIDIA_API_KEY is required for --track=real-coding-reset-flow",
      },
    }];
  }
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing. Run npm run build before --track=real-coding-reset-flow.");
  }

  const twoSum = loadCodingScenarios().find((item) => item.scenarioId === "coderpad_two_sum_reset_flow");
  const rotate = loadCodingScenarios().find((item) => item.scenarioId === "coderpad_rotate_matrix_after_reset");
  if (!twoSum || !rotate) throw new Error("Built-in reset-flow coding scenarios are missing.");
  checkBudget(4);

  const modelName = process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.1-8b-instruct";
  const userDataDir = path.join(tmpDir, `user-data-coding-reset-${Date.now()}`);
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

    const results: RunResult[] = [];
    const twoSumAnswers: string[] = [];
    let sessionStarted = false;

    const runTurn = async (
      scenario: CodingScenario,
      turnCount: number,
      assistantAnswers: string[],
      scenarioId: string,
      extraChecks: Record<string, boolean> = {},
    ): Promise<{ answerText: string; code: string }> => {
      const session = makeCodingSession(scenario, "nvidia", modelName, turnCount, assistantAnswers);
      await evaluate(client!, seedSessionExpression(session));
      const bridgeAfterReload = await evaluate<boolean>(client!, waitForBridgeExpression);
      if (!bridgeAfterReload) throw new Error("Desktop bridge did not recover after coding session seed reload");

      const answerStarted = markLatencyStage(createLatencyMetricRun(`${scenarioId}-answer`), "model_call_start");
      const answer = await waitForAnswerEvents(client!, "nvidia", modelName, {
        mode: "live_coding",
        timeoutMs: 120000,
        startSession: !sessionStarted,
      });
      sessionStarted = true;
      const answerDone = markLatencyStage(answerStarted, "response_complete");
      const failed = answer.events.find((event) => event.type === "status" && event.payload?.status === "failed");
      const assertions = executablePythonAssertions(scenario.turns.slice(0, turnCount));
      const code = extractPythonCode(answer.answerText, expectedPythonFunctionName(scenario));
      const execution = code && assertions.length > 0
        ? runPythonAssertions(code, assertions)
        : { ok: false, status: null, stdout: "", stderr: "No executable Python assertions or code were available.", timedOut: false };
      const structuredAnswer = answer.structured?.payload?.answer;
      const patch = structuredAnswer?.kind === "coding" ? structuredAnswer.payload?.patch : null;
      const totalLatency = answerDone.events.find((event) => event.stage === "response_complete")?.elapsedMs ?? 0;
      results.push({
        scenarioId,
        track: "real_coding_reset_flow_ipc",
        run: runNumber,
        deterministicChecks: {
          answerRequestAccepted: answer.requestResult.ok,
          answerCompleted: Boolean(answer.completed) && !failed,
          answerNonEmpty: answer.answerText.trim().length > 40,
          structuredSchemaValid: answer.structuredValidation.ok,
          codeBlockFound: Boolean(code),
          definesExpectedFunction: definesExpectedPythonFunction(code, scenario),
          ...(scenario.scenarioId === "coderpad_two_sum_reset_flow" && turnCount === 2
            ? { patchPresentForFollowUp: Boolean(patch && patch.kind !== "none" && patch.code) }
            : {}),
          pythonExecutionPassed: execution.ok,
          didNotTimeout: !execution.timedOut,
          ...extraChecks,
        },
        judge: null,
        latency_ms: { first_token: null, total: totalLatency },
        diagnostics: {
          provider: "nvidia",
          modelName,
          turnCount,
          transcript: session.transcript.messages,
          screenText: session.screenText,
          answer_received: answer.answerText,
          structuredValidation: answer.structuredValidation,
          patch,
          extracted_code: code,
          rawTestCases: rawTestCases(scenario.turns.slice(0, turnCount)),
          executableAssertions: assertions,
          execution,
          answer_events: answer.events.map((event) => ({
            type: event.type,
            status: event.payload?.status,
            answerKind: event.payload?.answer?.kind,
            textPreview: String(event.payload?.text || event.payload?.renderedText || "").slice(0, 240),
          })),
        },
      });
      return { answerText: answer.answerText, code };
    };

    for (const turnCount of [1, 2, 3]) {
      const { answerText } = await runTurn(twoSum, turnCount, twoSumAnswers, `coderpad_two_sum_reset_flow_turn_${turnCount}`);
      twoSumAnswers[turnCount - 1] = answerText;
    }

    const liveCodingSelected = await clickButtonByText(client, "Live Coding");
    await evaluate(client, `new Promise((resolve) => setTimeout(resolve, 300))`);
    const resetClicked = await clickButtonByText(client, "New exercise");
    const resetState = await evaluate<{ hasTwoSum: boolean; hasCodingPayload: boolean; answer: string; screenText: string; question: string; transcriptText: string }>(client, `(() => new Promise((resolve) => {
      setTimeout(() => {
        const raw = window.localStorage.getItem("callpilot_v0_session") || "{}";
        let session = {};
        try { session = JSON.parse(raw); } catch {}
        const codingState = [
          session.answer || "",
          session.question || "",
          session.screenText || "",
          JSON.stringify(session.transcript || {}),
          JSON.stringify(session.codingPayload || {})
        ].join("\\n");
        resolve({
          hasTwoSum: /two_sum|two sum/i.test(codingState),
          hasCodingPayload: Boolean(session && session.codingPayload && session.codingPayload.solution && session.codingPayload.solution.code),
          answer: String(session.answer || ""),
          screenText: String(session.screenText || ""),
          question: String(session.question || ""),
          transcriptText: JSON.stringify(session.transcript || {})
        });
      }, 700);
    }))()`);
    results.push({
      scenarioId: "new_exercise_reset_between_two_sum_and_rotate_matrix",
      track: "real_coding_reset_flow_ipc",
      run: runNumber,
      deterministicChecks: {
        liveCodingSelected,
        resetClicked,
        clearedTwoSumState: !resetState.hasTwoSum,
        clearedCodingPayload: !resetState.hasCodingPayload,
        clearedAnswer: resetState.answer.trim().length === 0,
        clearedScreenText: resetState.screenText.trim().length === 0,
      },
      judge: null,
      latency_ms: finishLatency("new-exercise-reset-check"),
      diagnostics: { resetState },
    });

    await runTurn(rotate, 1, [], "coderpad_rotate_matrix_after_new_exercise", {
      doesNotMentionTwoSum: true,
    });
    const rotateResult = results.at(-1);
    if (rotateResult) {
      const diagnostics = rotateResult.diagnostics as Record<string, any>;
      rotateResult.deterministicChecks.doesNotMentionTwoSum = !/\btwo_sum\b|two sum/i.test(String(diagnostics.answer_received || diagnostics.extracted_code || ""));
    }

    const traceStatus = await evaluate<any>(client, `window.callpilotDesktop.getSessionTraceStatus()`);
    const endSession = await evaluate<any>(client, `window.callpilotDesktop.endSession()`);
    results.push({
      scenarioId: "coderpad_reset_flow_trace_recorded",
      track: "real_coding_reset_flow_ipc",
      run: runNumber,
      deterministicChecks: {
        traceRecorded: Boolean((endSession?.tracePath || traceStatus?.path) && traceStatus?.eventCount >= 3),
      },
      judge: null,
      latency_ms: finishLatency("real-coding-reset-flow-trace"),
      diagnostics: {
        trace: {
          path: endSession?.tracePath || traceStatus?.path,
          eventCount: traceStatus?.eventCount,
        },
      },
    });

    return results;
  } finally {
    client?.close();
    electron.kill();
  }
};

const selectedScenarioIds = (): string[] =>
  argValue("--scenarios")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const selectedCodingTurnCounts = (scenario: CodingScenario): number[] => {
  const requested = argValue("--turns") || process.env.E2E_CODING_TURNS || "last";
  if (requested === "all") return scenario.turns.map((turn) => turn.turnId);
  if (requested === "last") return [scenario.turns.at(-1)?.turnId ?? 1];
  const parsed = requested
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= scenario.turns.length);
  return parsed.length > 0 ? parsed : [scenario.turns.at(-1)?.turnId ?? 1];
};

const runRealCodingBatch = async (
  selectedIds: string[],
  limit: number,
): Promise<RunResult[]> => {
  if (!process.env.NVIDIA_API_KEY && !process.env.CALLPILOT_NVIDIA_API_KEY) {
    return [{
      scenarioId: "coding_batch",
      track: "real_coding_batch_ipc",
      run: runNumber,
      deterministicChecks: {
        nvidiaKeyAvailable: false,
        answerCompleted: false,
        pythonExecutionPassed: false,
      },
      judge: null,
      latency_ms: finishLatency("real-coding-batch-blocked"),
      diagnostics: {
        blocked: true,
        reason: "NVIDIA_API_KEY or CALLPILOT_NVIDIA_API_KEY is required for real coding batch tracks",
      },
    }];
  }
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing. Run npm run build before real coding batch tracks.");
  }

  const allScenarios = loadCodingScenarios();
  const scenarios = selectedIds.length > 0
    ? selectedIds
        .map((id) => allScenarios.find((scenario) => scenario.scenarioId === id))
        .filter((scenario): scenario is CodingScenario & { fixturePath: string; sourceKey: string } => Boolean(scenario))
    : allScenarios.slice(0, limit);
  if (scenarios.length === 0) return [];

  const plannedCalls = scenarios.reduce((count, scenario) => count + selectedCodingTurnCounts(scenario).length, 0);
  checkBudget(plannedCalls);
  const results: RunResult[] = [];
  for (const scenario of scenarios) {
    const assistantAnswers: string[] = [];
    for (const turnCount of selectedCodingTurnCounts(scenario)) {
      const assertions = executablePythonAssertions(scenario.turns.slice(0, turnCount));
      const { result, answerText } = await runRealCodingTurn(scenario, assertions, turnCount, assistantAnswers, "real_coding_batch_ipc");
      result.diagnostics.fixturePath = scenario.fixturePath;
      result.diagnostics.sourceKey = scenario.sourceKey;
      result.diagnostics.critical_failure_categories = scenario.critical_failure_categories ?? [];
      result.diagnostics.rawTestCases = rawTestCases(scenario.turns.slice(0, turnCount));
      results.push(result);
      assistantAnswers[turnCount - 1] = answerText;
    }
  }
  return results;
};

const runRealTextBatch = async (): Promise<RunResult[]> => {
  const requested = selectedScenarioIds();
  const allCodingIds = new Set(loadCodingScenarios().map((scenario) => scenario.scenarioId));
  const allTextIds = new Set(loadTextInterviewScenarios().map((scenario) => scenario.scenarioId));
  const unknown = requested.filter((id) => !allCodingIds.has(id) && !allTextIds.has(id));
  if (unknown.length > 0) throw new Error(`Unknown text batch scenario id(s): ${unknown.join(", ")}`);

  const codingIds = requested.filter((id) => allCodingIds.has(id));
  const textIds = requested.filter((id) => allTextIds.has(id));
  if (requested.length > 0) {
    return [
      ...(codingIds.length > 0 ? await runRealCodingBatch(codingIds, realBatchLimit) : []),
      ...(textIds.length > 0 ? await runRealTextInterviewBatchWithSelection(textIds, realBatchLimit) : []),
    ];
  }

  const codingLimit = Math.ceil(realBatchLimit / 2);
  const textLimit = Math.max(0, realBatchLimit - codingLimit);
  return [
    ...await runRealCodingBatch([], codingLimit),
    ...await runRealTextInterviewBatchWithSelection([], textLimit),
  ];
};

const selectedProfiles = (): string[] =>
  argValue("--profiles")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const selectTrackHSessions = (): AudioTrackHSession[] => {
  const requested = selectedScenarioIds();
  const profiles = new Set(selectedProfiles());
  const allSessions = loadAudioTrackHSessions();
  const sessions = allSessions.filter((session) => {
    if (requested.length > 0 && !requested.includes(session.sessionId)) return false;
    if (profiles.size > 0 && !profiles.has(session.profile)) return false;
    return true;
  });
  if (sessions.length === 0) throw new Error("No Track H long sessions selected.");
  return requested.length > 0 ? sessions : sessions.slice(0, longSessionMode === "full" ? sessions.length : longSessionLimit);
};

const eventSpeaker = (channel: "mic" | "system") => channel === "mic" ? "candidate" : "interviewer";

const trackHStreamId = (sessionId: string, channel: "mic" | "system") =>
  `${channel}-track-h-${sessionId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const containsTerm = (text: string, term: string): boolean => {
  const normalizedText = normalizeForChecks(text);
  const normalizedTerm = normalizeForChecks(term);
  if (!normalizedTerm.trim()) return true;
  if (normalizedText.includes(normalizedTerm)) return true;
  const words = normalizedTerm.match(/[a-z0-9]+/g) ?? [];
  if (words.length === 0) return true;
  return words.some((word) => word.length >= 4 && normalizedText.includes(word));
};

const containsForbiddenTerm = (text: string, term: string): boolean => {
  const normalizedText = normalizeForChecks(text);
  const normalizedTerm = normalizeForChecks(term);
  if (!normalizedTerm.trim()) return true;
  const textWords = new Set(normalizedText.match(/[a-z0-9]+/g) ?? []);
  const termWords = normalizedTerm.match(/[a-z0-9]+/g) ?? [];
  if (termWords.length === 0) return true;
  const hasWord = (word: string) =>
    textWords.has(word)
    || (word.length > 3 && word.endsWith("s") && textWords.has(word.slice(0, -1)))
    || (word.length > 3 && !word.endsWith("s") && textWords.has(`${word}s`));
  if (termWords.length === 1) return hasWord(termWords[0]);
  const requiredWords = termWords.filter((word) => word.length >= 3 || /\d/.test(word));
  const wordsToMatch = requiredWords.length > 0 ? requiredWords : termWords;
  return wordsToMatch.every((word) => hasWord(word));
};

const missingCriticalTerms = (transcript: string, session: AudioTrackHSession): string[] =>
  session.events
    .flatMap((event) => event.expected_critical_terms)
    .filter((term) => !containsTerm(transcript, term));

const forbiddenTermsPresent = (text: string, terms: string[]): string[] =>
  terms.filter((term) => containsForbiddenTerm(text, term));

const answerReferencesLatestQuestion = (answerText: string, terms: string[], strict = false): boolean => {
  if (terms.length === 0) return true;
  if (!strict) return terms.some((term) => containsTerm(answerText, term));
  const matchingTerms = terms.filter((term) => containsForbiddenTerm(answerText, term));
  return matchingTerms.length >= Math.min(3, terms.length);
};

const isGroundedClarificationOrNoAnswer = (answerText: string): boolean => {
  const normalized = normalizeForChecks(answerText);
  return /\b(?:no responderia|no answer|not answer|unclear|clarification|provide more details|faltan detalles|sin inventar|not invent)\b/.test(normalized);
};

const traceHasEvent = (trace: any, type: string): boolean =>
  Array.isArray(trace?.events) && trace.events.some((event: any) => event?.type === type);

const traceString = (value: any): string => {
  if (typeof value === "string") return value;
  if (typeof value?.preview === "string") return value.preview;
  return "";
};

const traceNumber = (value: any): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const answerLatencyBreakdowns = (trace: any) => {
  const events = Array.isArray(trace?.events) ? trace.events : [];
  const requestIds = Array.from(new Set<string>(events
    .map((event: any) => traceString(event?.requestId))
    .filter((requestId: string) => requestId.startsWith("answer-"))));

  return requestIds.map((requestId) => {
    const requestEvents = events.filter((event: any) => traceString(event?.requestId) === requestId);
    const timingEvents = requestEvents
      .filter((event: any) => event?.type === "answer_timing")
      .map((event: any) => ({
        stage: traceString(event.stage),
        elapsedMs: traceNumber(event.elapsedMs),
      }))
      .filter((event: any) => event.stage && event.elapsedMs !== null);
    const elapsedAt = (stage: string): number | null => timingEvents.find((event: any) => event.stage === stage)?.elapsedMs ?? null;
    const delta = (from: string, to: string): number | null => {
      const start = elapsedAt(from);
      const end = elapsedAt(to);
      return start === null || end === null ? null : Math.max(0, end - start);
    };
    const lastOfType = (type: string) => [...requestEvents].reverse().find((event: any) => event?.type === type);
    const firstOfType = (type: string) => requestEvents.find((event: any) => event?.type === type);
    const modelCompleted = lastOfType("model_generate_completed");
    const firstChunk = firstOfType("provider_stream_first_chunk");
    const streamCompleted = lastOfType("provider_stream_completed");
    const bodyParsed = lastOfType("provider_response_body_parsed");
    const providerHeaders = firstOfType("provider_response_headers");
    const modelCallMs = delta("model_call_started", "model_call_completed");
    const localPreModelMs = delta("request_received", "model_call_started");
    const localPostModelMs = delta("model_call_completed", "request_completed");
    const providerTotalMs = traceNumber(streamCompleted?.durationMs)
      ?? traceNumber(bodyParsed?.totalDurationMs)
      ?? traceNumber(bodyParsed?.durationMs)
      ?? traceNumber(modelCompleted?.durationMs);
    const localMax = Math.max(localPreModelMs ?? 0, localPostModelMs ?? 0);
    const bottleneck = providerTotalMs !== null && providerTotalMs > Math.max(1000, localMax * 2)
      ? "provider_llm_or_network"
      : (localPreModelMs ?? 0) > Math.max(1000, (modelCallMs ?? 0), (localPostModelMs ?? 0))
        ? "local_prompt_or_evidence"
        : (localPostModelMs ?? 0) > Math.max(1000, (modelCallMs ?? 0), (localPreModelMs ?? 0))
          ? "local_parse_format_publish"
          : "mixed_or_small";

    return {
      requestId,
      provider: traceString(firstOfType("provider_request_started")?.provider) || traceString(modelCompleted?.result?.provider),
      modelName: traceString(firstOfType("provider_request_started")?.modelName) || traceString(modelCompleted?.result?.modelName),
      bottleneck,
      renderer_ms: {
        pre_model: localPreModelMs,
        evidence_lookup: delta("evidence_lookup_started", "evidence_lookup_completed"),
        model_call: modelCallMs,
        post_model: localPostModelMs,
        parse_format: delta("format_started", "format_completed"),
        total: elapsedAt("request_completed"),
      },
      provider_ms: {
        headers: traceNumber(providerHeaders?.durationMs),
        first_chunk: traceNumber(firstChunk?.durationMs),
        stream_complete: traceNumber(streamCompleted?.durationMs),
        body_parsed: traceNumber(bodyParsed?.durationMs),
        total: providerTotalMs,
        chunks: traceNumber(streamCompleted?.chunks),
      },
      stages: timingEvents,
    };
  });
};

const startTrackHListeners = async (mainClient: CdpClient, overlayClient: CdpClient) => {
  await evaluate(mainClient, `(() => {
    window.__callpilotTrackHNativelyEvents = [];
    window.__callpilotTrackHMainEvents = [];
    window.__callpilotTrackHDisposers?.forEach?.((dispose) => dispose());
    window.__callpilotTrackHDisposers = [
      window.callpilotDesktop.onNativelyStatus((payload) => window.__callpilotTrackHNativelyEvents.push({ type: "status", at: Date.now(), payload })),
      window.callpilotDesktop.onNativelyTranscript((payload) => window.__callpilotTrackHNativelyEvents.push({ type: "transcript", at: Date.now(), payload })),
      window.callpilotDesktop.onManualAnswerStatus((payload) => window.__callpilotTrackHMainEvents.push({ type: "manual-status", at: Date.now(), payload }))
    ];
    return true;
  })()`);
  await evaluate(overlayClient, `(() => {
    window.__callpilotTrackHOverlayEvents = [];
    window.__callpilotTrackHOverlayDisposers?.forEach?.((dispose) => dispose());
    window.__callpilotTrackHOverlayDisposers = [
      window.callpilotDesktop.onTranscriptMessage((payload) => window.__callpilotTrackHOverlayEvents.push({ type: "transcript", at: Date.now(), payload })),
      window.callpilotDesktop.onLiveTranscript((payload) => window.__callpilotTrackHOverlayEvents.push({ type: "live-transcript", at: Date.now(), payload })),
      window.callpilotDesktop.onAnswerStatus((payload) => window.__callpilotTrackHOverlayEvents.push({ type: "status", at: Date.now(), payload })),
      window.callpilotDesktop.onStructuredAnswer((payload) => window.__callpilotTrackHOverlayEvents.push({ type: "structured", at: Date.now(), payload }))
    ];
    return true;
  })()`);
};

const waitForNativelyConnected = async (client: CdpClient, streamId: string) =>
  evaluate<boolean>(client, `new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const events = (window.__callpilotTrackHNativelyEvents || []).filter((event) => event.payload?.streamId === ${JSON.stringify(streamId)});
      if (events.some((event) => event.type === "status" && /connected/i.test(event.payload?.status || event.payload?.detail || ""))) {
        resolve(true);
        return;
      }
      if (Date.now() - started > 9000) {
        resolve(false);
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`);

const requestTrackHAnswer = async (
  mainClient: CdpClient,
  overlayClient: CdpClient,
  session: AudioTrackHSession,
  event: AudioTrackHEvent,
  modelName: string,
) => {
  const requestStartedAt = Date.now();
  const answerStarted = markLatencyStage(createLatencyMetricRun(`real-long-session-answer-${session.sessionId}-${event.eventId}`), "model_call_start");
  recordRealCall();
  const requestResult = await evaluate<{ ok: boolean; error?: string }>(mainClient, `window.callpilotDesktop.requestAnswer()`);
  const events = await evaluate<Array<{ type: string; at: number; payload: any }>>(overlayClient, `new Promise((resolve) => {
    const started = Date.now();
    const baseline = ${JSON.stringify(requestStartedAt)};
    const tick = () => {
      const events = (window.__callpilotTrackHOverlayEvents || []).filter((event) => event.at >= baseline);
      const terminal = events.find((event) => event.type === "status" && ["completed", "failed", "cancelled"].includes(event.payload?.status));
      if (terminal || Date.now() - started > ${JSON.stringify(Number(process.env.E2E_LONG_SESSION_ANSWER_TIMEOUT_MS || (session.mode === "live_coding" ? "180000" : "180000")))}) {
        resolve(events);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  })`);
  const answerDone = markLatencyStage(answerStarted, "response_complete");
  const completed = events.find((item) => item.type === "status" && item.payload?.status === "completed");
  const failed = events.find((item) => item.type === "status" && item.payload?.status === "failed");
  const structured = events.find((item) => item.type === "structured");
  const answerText = String(completed?.payload?.text || structured?.payload?.renderedText || "");
  return {
    eventId: event.eventId,
    trigger_answer_ms: event.trigger_answer_ms,
    provider: "nvidia",
    modelName,
    requestResult,
    completed: Boolean(completed),
    failed: Boolean(failed),
    answerText,
    latency_ms: answerDone.events.find((latencyEvent) => latencyEvent.stage === "response_complete")?.elapsedMs ?? 0,
    structuredValidation: validatePublishedStructuredAnswer(structured?.payload, session.mode === "live_coding" ? "coding" : "interview"),
    events: events.map((item) => ({
      type: item.type,
      status: item.payload?.status,
      answerKind: item.payload?.answer?.kind,
      textPreview: String(item.payload?.text || item.payload?.renderedText || "").slice(0, 260),
    })),
  };
};

const sendTrackHSegment = async (
  client: CdpClient,
  streamId: string,
  event: AudioTrackHEvent,
  options: {
    session: AudioTrackHSession;
    overlayClient: CdpClient;
    modelName: string;
    onAnswer: (answer: Awaited<ReturnType<typeof requestTrackHAnswer>>) => void;
  },
) => {
  const audioPath = path.join(fixturesDir, "audio", event.audio_segment);
  const pcm = readPcmWavAsMono16k(audioPath);
  const frameBytes = 3200;
  const eventStartedAt = Date.now();
  let answerPromise: Promise<void> | null = null;
  const triggerOffsetMs = typeof event.trigger_answer_ms === "number"
    ? Math.max(0, event.trigger_answer_ms - event.start_ms)
    : null;

  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const sentAudioMs = Math.round((offset / 2) / 16000 * 1000);
    if (triggerOffsetMs !== null && !answerPromise && sentAudioMs >= triggerOffsetMs) {
      answerPromise = requestTrackHAnswer(client, options.overlayClient, options.session, event, options.modelName)
        .then(options.onAnswer);
    }
    const frame = pcm.subarray(offset, Math.min(pcm.length, offset + frameBytes)).toString("base64");
    const audioResult = await evaluate<{ ok: boolean; error?: string }>(client, `window.callpilotDesktop.sendNativelyAudio({
      streamId: ${JSON.stringify(streamId)},
      arrayBuffer: Uint8Array.from(atob(${JSON.stringify(frame)}), (char) => char.charCodeAt(0)).buffer
    })`);
    if (!audioResult.ok) throw new Error(`natively:audio failed for ${event.eventId}: ${audioResult.error || "unknown"}`);
    const frameDurationMs = Math.round((Math.min(pcm.length - offset, frameBytes) / 2) / 16000 * 1000);
    await sleep(Math.max(20, Math.min(90, Math.round(frameDurationMs * 0.55))));
  }

  if (triggerOffsetMs !== null && !answerPromise) {
    if (triggerOffsetMs >= event.duration_ms) {
      await sleep(Math.min(5000, Math.max(1500, triggerOffsetMs - event.duration_ms)));
    }
    answerPromise = requestTrackHAnswer(client, options.overlayClient, options.session, event, options.modelName)
      .then(options.onAnswer);
  }
  if (answerPromise && process.env.E2E_LONG_SESSION_SERIAL_ANSWERS !== "0") {
    await answerPromise;
  }
  return {
    eventId: event.eventId,
    audio_segment: event.audio_segment,
    channel: event.channel,
    speaker: eventSpeaker(event.channel),
    bytes: pcm.length,
    wall_ms: Date.now() - eventStartedAt,
    trigger_answer_ms: event.trigger_answer_ms ?? null,
  };
};

const runRealLongSession = async (): Promise<RunResult[]> => {
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing. Run npm run build before --track=real-long-session.");
  }
  if (!process.env.NVIDIA_API_KEY && !process.env.CALLPILOT_NVIDIA_API_KEY) {
    return [{
      scenarioId: "track_h_long_session",
      track: "real_long_session_ipc",
      run: runNumber,
      deterministicChecks: {
        nvidiaKeyAvailable: false,
        nativelyStreamStarted: false,
        nativelyTranscriptReceived: false,
        answerCompleted: false,
      },
      judge: null,
      latency_ms: finishLatency("real-long-session-blocked", "audio_or_screen_capture"),
      diagnostics: {
        blocked: true,
        reason: "NVIDIA_API_KEY or CALLPILOT_NVIDIA_API_KEY is required for --track=real-long-session",
      },
    }];
  }

  const sessions = selectTrackHSessions();
  const plannedNativelyStarts = sessions.reduce((sum, session) => {
    const channels = new Set(session.events.map((event) => event.channel));
    return sum + channels.size;
  }, 0);
  const plannedAnswers = sessions.reduce((sum, session) => sum + session.events.filter((event) => typeof event.trigger_answer_ms === "number").length, 0);
  checkBudget(plannedNativelyStarts + plannedAnswers);

  const useDefaultUserData = process.env.E2E_USE_DEFAULT_USER_DATA === "1" && !process.env.NATIVELY_API_KEY;
  const modelName = process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.1-8b-instruct";
  const results: RunResult[] = [];

  for (const session of sessions) {
    const userDataDir = path.join(tmpDir, `user-data-track-h-${Date.now()}-${session.sessionId}`);
    if (!useDefaultUserData) fs.mkdirSync(userDataDir, { recursive: true });
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const electron = spawn(electronBin, ["."], {
      cwd: root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...childEnv,
        CALLPILOT_REMOTE_DEBUG_PORT: String(debugPort),
        ...(useDefaultUserData ? {} : { CALLPILOT_USER_DATA_DIR: userDataDir }),
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
    const started = markLatencyStage(createLatencyMetricRun(`real-long-session-${session.sessionId}`), "audio_or_screen_capture");
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
        results.push({
          scenarioId: session.sessionId,
          track: "real_long_session_ipc",
          run: runNumber,
          deterministicChecks: {
            nativelyKeyAvailable: false,
            nvidiaKeyAvailable: true,
            nativelyStreamStarted: false,
            nativelyTranscriptReceived: false,
            answerCompleted: false,
          },
          judge: null,
          latency_ms: finishLatency(`real-long-session-${session.sessionId}-blocked`, "audio_or_screen_capture"),
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
        });
        continue;
      }

      await evaluate(client, `window.callpilotDesktop.saveSettings(${JSON.stringify({
        activeMode: session.mode,
        preferredLanguage: "english",
        defaultCodingLanguage: "Python",
        answerVerbosity: "medium",
        modelProvider: "nvidia",
        modelName,
        ollamaBaseUrl: "http://localhost:11434",
        transcriptionModelName: "gpt-4o-transcribe",
        liveTranscriptionProvider: "natively",
        liveLatencyPreset: "balanced",
        liveAudioSource: session.channels.includes("both") ? "both" : session.channels.includes("mic") ? "mic" : "system",
        autoAnswerCooldownMs: 12000,
        autoAnswerMinConfidence: 0.45,
      })})`);
      await evaluate(client, seedSessionExpression(makeEmptyInterviewSession("nvidia", modelName, session.mode)));
      const bridgeAfterReload = await evaluate<boolean>(client, waitForBridgeExpression);
      if (!bridgeAfterReload) throw new Error("Desktop bridge did not recover after Track H session seed reload");
      await evaluate(client, `window.callpilotDesktop.startSession({ mode: ${JSON.stringify(session.mode)} })`);
      const overlayTarget = await getPageTarget((target) => target.url.includes(session.mode === "live_coding" ? "#/coding" : "#/overlay"), 10000);
      if (!overlayTarget?.webSocketDebuggerUrl) throw new Error("Overlay target did not open for Track H run");
      overlayClient = await cdp(overlayTarget.webSocketDebuggerUrl);
      await overlayClient.send("Runtime.enable");
      await evaluate(overlayClient, waitForBridgeExpression);
      await startTrackHListeners(client, overlayClient);

      const streamIds: Partial<Record<"mic" | "system", string>> = {};
      const streamStarts: Array<{ channel: "mic" | "system"; streamId: string; startResult: unknown; connected: boolean }> = [];
      for (const channel of [...new Set(session.events.map((event) => event.channel))]) {
        const streamId = trackHStreamId(session.sessionId, channel);
        streamIds[channel] = streamId;
        recordRealCall();
        const startResult = await evaluate<{ ok: boolean; streamId?: string; error?: string }>(client, `window.callpilotDesktop.startNativelyTranscription({
          streamId: ${JSON.stringify(streamId)},
          channel: ${JSON.stringify(channel)},
          sampleRate: 16000,
          language: "english",
          apiKey: ${JSON.stringify(process.env.NATIVELY_API_KEY || "")}
        })`);
        const connected = startResult.ok ? await waitForNativelyConnected(client, streamId) : false;
        streamStarts.push({ channel, streamId, startResult, connected });
      }

      const answerResults: Array<Awaited<ReturnType<typeof requestTrackHAnswer>>> = [];
      const sentSegments = [];
      const timelineStartedAt = Date.now();
      for (const event of [...session.events].sort((a, b) => a.start_ms - b.start_ms)) {
        const targetWallMs = Math.round(event.start_ms * longSessionTimeScale);
        const waitMs = targetWallMs - (Date.now() - timelineStartedAt);
        if (waitMs > 0) await sleep(waitMs);
        const streamId = streamIds[event.channel];
        if (!streamId) throw new Error(`Missing Track H stream for channel ${event.channel}`);
        sentSegments.push(await sendTrackHSegment(client, streamId, event, {
          session,
          overlayClient,
          modelName,
          onAnswer: (answer) => answerResults.push(answer),
        }));
      }

      await sleep(2200);
      for (const streamId of Object.values(streamIds)) {
        if (streamId) await evaluate(client, `window.callpilotDesktop.stopNativelyTranscription({ streamId: ${JSON.stringify(streamId)} })`).catch(() => undefined);
      }
      await sleep(1200);

      const nativelyEvents = await evaluate<Array<{ type: string; at: number; payload: any }>>(client, `window.__callpilotTrackHNativelyEvents || []`);
      const overlayEvents = await evaluate<Array<{ type: string; at: number; payload: any }>>(overlayClient, `window.__callpilotTrackHOverlayEvents || []`);
      const transcriptPayloads = nativelyEvents.filter((event) => event.type === "transcript").map((event) => event.payload);
      const reassembledTranscript = assembleNativelyTranscriptText(transcriptPayloads);
      const overlayTranscriptText = overlayEvents
        .filter((event) => event.type === "transcript")
        .map((event) => String(event.payload?.text || ""))
        .filter(Boolean)
        .join(" ");
      const overlayLiveTranscriptText = overlayEvents
        .filter((event) => event.type === "live-transcript")
        .map((event) => String(event.payload?.text || ""))
        .filter(Boolean)
        .join(" ");
      const transcriptForChecks = `${reassembledTranscript} ${overlayTranscriptText} ${overlayLiveTranscriptText}`.trim();
      const traceStatus = await evaluate<any>(client, `window.callpilotDesktop.getSessionTraceStatus()`);
      const endSession = await evaluate<any>(client, `window.callpilotDesktop.endSession()`);
      const tracePath = endSession?.tracePath || traceStatus?.path || "";
      const trace = tracePath && fs.existsSync(tracePath) ? JSON.parse(fs.readFileSync(tracePath, "utf8")) : null;
      const completed = markLatencyStage(started, "response_complete");
      const totalLatency = completed.events.find((event) => event.stage === "response_complete")?.elapsedMs ?? 0;
      const answerTexts = answerResults.map((answer) => answer.answerText).join("\n\n");
      const missingTerms = missingCriticalTerms(transcriptForChecks, session);
      const staleTerms = forbiddenTermsPresent(answerTexts, session.expected_checks.stale_topic_forbidden_terms);
      const unsupportedSpecifics = forbiddenTermsPresent(answerTexts, session.expected_checks.unsupported_behavioral_specifics);
      const triggerEvents = session.events.filter((event) => typeof event.trigger_answer_ms === "number");
      const noAnswerEventsWithTriggers = session.events.filter((event) => event.expected_no_answer && typeof event.trigger_answer_ms === "number");
      const latestAnswer = answerResults.at(-1)?.answerText ?? "";
      const deterministicChecks = {
        audioFilesExist: session.events.every((event) => fs.existsSync(path.join(fixturesDir, "audio", event.audio_segment))),
        nvidiaKeyAvailable: true,
        nativelyKeyAvailable: true,
        nativelyStreamStarted: streamStarts.length > 0 && streamStarts.every((item) => Boolean((item.startResult as any)?.ok)),
        nativelyStreamConnected: streamStarts.length > 0 && streamStarts.every((item) => item.connected),
        nativelyTranscriptReceived: transcriptForChecks.trim().length > 0,
        criticalTermsPresent: missingTerms.length <= Math.max(1, Math.floor(session.events.flatMap((event) => event.expected_critical_terms).length * 0.35)),
        answerRequestAccepted: triggerEvents.length > 0 && answerResults.some((answer) => answer.requestResult.ok),
        answerCompleted: answerResults.some((answer) => answer.completed && !answer.failed),
        answerNonEmpty: answerResults.some((answer) => answer.answerText.trim().length > 40),
        latestQuestionAnswered: answerReferencesLatestQuestion(
          latestAnswer || answerTexts,
          session.expected_checks.latest_question_terms,
          session.mode === "system_design",
        )
          || (session.mode === "behavioral" && isGroundedClarificationOrNoAnswer(latestAnswer || answerTexts)),
        noStaleTopicAnswer: staleTerms.length === 0,
        noUnsupportedBehavioralSpecifics: unsupportedSpecifics.length === 0,
        noAnswerMomentsRespected: noAnswerEventsWithTriggers.length === 0,
        traceRecorded: Boolean(tracePath && traceStatus?.eventCount >= 5),
        overlayEventsRecorded: overlayEvents.length > 0,
        noOpenAITranscribePath: !traceHasEvent(trace, "audio_transcribe_started"),
      };

      results.push({
        scenarioId: session.sessionId,
        track: "real_long_session_ipc",
        run: runNumber,
        deterministicChecks,
        judge: null,
        latency_ms: {
          first_token: null,
          total: totalLatency,
        },
        diagnostics: {
          fixturePath: "audio/track-h-long-session.json",
          mode: longSessionMode,
          timeScale: longSessionTimeScale,
          sessionDurationMs: longSessionMode === "full" ? session.full_duration_ms ?? session.duration_ms : session.duration_ms,
          channelsUsed: [...new Set(session.events.map((event) => event.channel))],
          profile: session.profile,
          audioFixtures: session.events.map((event) => event.audio_segment),
          sentSegments,
          transcriptExcerpts: {
            reassembled: reassembledTranscript.slice(0, 1200),
            overlayFinal: overlayTranscriptText.slice(0, 1200),
            overlayLive: overlayLiveTranscriptText.slice(-1200),
          },
          answerExcerpts: answerResults.map((answer) => ({
            eventId: answer.eventId,
            trigger_answer_ms: answer.trigger_answer_ms,
            text: answer.answerText.slice(0, 900),
            completed: answer.completed,
            failed: answer.failed,
            latency_ms: answer.latency_ms,
            structuredValidation: answer.structuredValidation,
          })),
          failedDeterministicChecks: Object.entries(deterministicChecks).filter(([, ok]) => !ok).map(([key]) => key),
          missingCriticalTerms: missingTerms,
          staleTerms,
          unsupportedSpecifics,
          noAnswerEvents: session.events.filter((event) => event.expected_no_answer).map((event) => event.eventId),
          latencySummary: {
            total_ms: totalLatency,
            answer_ms: answerResults.map((answer) => answer.latency_ms),
            answer_breakdown: answerLatencyBreakdowns(trace),
          },
          nativelyEventSummary: {
            statusCount: nativelyEvents.filter((event) => event.type === "status").length,
            transcriptCount: transcriptPayloads.length,
            finalTranscriptCount: transcriptPayloads.filter((payload) => payload?.isFinal).length,
            streams: streamStarts.map((item) => ({
              channel: item.channel,
              streamId: item.streamId,
              connected: item.connected,
            })),
          },
          nvidiaModel: modelName,
          answerEvents: answerResults.flatMap((answer) => answer.events),
          overlayEventSummary: {
            total: overlayEvents.length,
            transcripts: overlayEvents.filter((event) => event.type === "transcript").length,
            liveTranscripts: overlayEvents.filter((event) => event.type === "live-transcript").length,
            answerStatuses: overlayEvents.filter((event) => event.type === "status").length,
            structuredAnswers: overlayEvents.filter((event) => event.type === "structured").length,
          },
          trace: {
            path: tracePath,
            eventCount: traceStatus?.eventCount,
          },
        },
      });
    } finally {
      overlayClient?.close();
      client?.close();
      electron.kill();
    }
  }
  return results;
};

const audioTrackDChunkPlan = (scenario: AudioTrackDScenario, pcm: Buffer): Array<{ label: string; startMs: number; endMs: number }> => {
  const durationMs = scenario.duration_ms ?? Math.round(pcm.length / 2 / 16000 * 1000);
  if (scenario.test_type === "chunk_boundary_word_split" && scenario.boundary_timestamp_ms) {
    return [
      { label: "before-boundary", startMs: 0, endMs: scenario.boundary_timestamp_ms },
      { label: "after-boundary", startMs: scenario.boundary_timestamp_ms, endMs: durationMs },
    ];
  }
  return [{ label: "final-onstop-segment", startMs: 0, endMs: durationMs }];
};

const runRealAudioTrackD = async (): Promise<RunResult[]> => {
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing. Run npm run build before --track=real-audio-track-d.");
  }

  const requested = selectedScenarioIds();
  const profiles = new Set(selectedProfiles());
  const allScenarios = loadAudioTrackDScenarios();
  const scenarios = allScenarios.filter((scenario) => {
    if (requested.length > 0 && !requested.includes(scenario.scenarioId)) return false;
    if (profiles.size > 0 && !profiles.has(scenario.profile)) return false;
    return true;
  });
  if (scenarios.length === 0) throw new Error("No Track D audio scenarios selected.");

  const useDefaultUserData = process.env.E2E_USE_DEFAULT_USER_DATA === "1" && !process.env.NATIVELY_API_KEY;
  const userDataDir = path.join(tmpDir, `user-data-track-d-${Date.now()}`);
  if (!useDefaultUserData) fs.mkdirSync(userDataDir, { recursive: true });

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
        scenarioId: "audio_track_d",
        track: "real_audio_track_d_ipc",
        run: runNumber,
        deterministicChecks: {
          nativelyKeyAvailable: false,
          nativelyStreamStarted: false,
          nativelyTranscriptReceived: false,
          criticalWordPresent: false,
          groundTruthWordsInOrder: false,
        },
        judge: null,
        latency_ms: finishLatency("real-audio-track-d-blocked", "audio_or_screen_capture"),
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
    checkBudget(scenarios.length);

    await evaluate(client, `(() => {
      window.__callpilotTrackDNativelyEvents = [];
      window.__callpilotTrackDNativelyDispose?.forEach?.((dispose) => dispose());
      window.__callpilotTrackDNativelyDispose = [
        window.callpilotDesktop.onNativelyStatus((payload) => window.__callpilotTrackDNativelyEvents.push({ type: "status", at: Date.now(), payload })),
        window.callpilotDesktop.onNativelyTranscript((payload) => window.__callpilotTrackDNativelyEvents.push({ type: "transcript", at: Date.now(), payload }))
      ];
      return true;
    })()`);

    const results: RunResult[] = [];
    for (const scenario of scenarios) {
      const audioPath = path.join(fixturesDir, "audio", scenario.audio_file);
      const pcm = readPcmWavAsMono16k(audioPath);
      const chunks = audioTrackDChunkPlan(scenario, pcm);
      const started = markLatencyStage(createLatencyMetricRun(`real-audio-track-d-${scenario.scenarioId}`), "audio_or_screen_capture");

      await evaluate(client, `window.__callpilotTrackDNativelyEvents = []`);
      const streamId = `track-d-${scenario.channel}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      recordRealCall();
      const startResult = await evaluate<{ ok: boolean; streamId?: string; error?: string }>(client, `window.callpilotDesktop.startNativelyTranscription({
        streamId: ${JSON.stringify(streamId)},
        channel: ${JSON.stringify(scenario.channel)},
        sampleRate: 16000,
        language: "english",
        apiKey: ${JSON.stringify(process.env.NATIVELY_API_KEY || "")}
      })`);

      const connected = startResult.ok && await evaluate<boolean>(client, `new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          const events = (window.__callpilotTrackDNativelyEvents || []).filter((event) => event.payload?.streamId === ${JSON.stringify(streamId)});
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

      const sentChunks: Array<{ label: string; startMs: number; endMs: number; bytes: number }> = [];
      if (startResult.ok) {
        const frameBytes = 3200;
        for (const chunk of chunks) {
          const chunkPcm = slicePcm16k(pcm, chunk.startMs, chunk.endMs);
          sentChunks.push({ ...chunk, bytes: chunkPcm.length });
          for (let offset = 0; offset < chunkPcm.length; offset += frameBytes) {
            const frame = chunkPcm.subarray(offset, Math.min(chunkPcm.length, offset + frameBytes)).toString("base64");
            const audioResult = await evaluate<{ ok: boolean; error?: string }>(client, `window.callpilotDesktop.sendNativelyAudio({
              streamId: ${JSON.stringify(streamId)},
              arrayBuffer: Uint8Array.from(atob(${JSON.stringify(frame)}), (char) => char.charCodeAt(0)).buffer
            })`);
            if (!audioResult.ok) throw new Error(`natively:audio failed: ${audioResult.error || "unknown"}`);
            const frameDurationMs = Math.round((Math.min(chunkPcm.length - offset, frameBytes) / 2) / 16000 * 1000);
            await sleep(Math.max(20, Math.min(120, frameDurationMs)));
          }
        }
      }

      if (startResult.ok) {
        await evaluate<boolean>(client, `new Promise((resolve) => {
          const started = Date.now();
          const idleMs = ${JSON.stringify(4200)};
          const timeoutMs = ${JSON.stringify(22000)};
          const tick = () => {
            const events = (window.__callpilotTrackDNativelyEvents || []).filter((event) => event.payload?.streamId === ${JSON.stringify(streamId)});
            const transcripts = events.filter((event) => event.type === "transcript" && String(event.payload?.text || "").trim().length > 0);
            const latest = transcripts.at(-1);
            if (latest && Date.now() - latest.at > idleMs) {
              resolve(true);
              return;
            }
            if (Date.now() - started > timeoutMs) {
              resolve(Boolean(latest));
              return;
            }
            setTimeout(tick, 250);
          };
          tick();
        })`);
      }
      await evaluate(client, `window.callpilotDesktop.stopNativelyTranscription({ streamId: ${JSON.stringify(streamId)} })`).catch(() => undefined);
      const transcriptEvents = startResult.ok ? await evaluate<Array<{ type: string; at: number; payload: any }>>(client, `new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          const events = (window.__callpilotTrackDNativelyEvents || []).filter((event) => event.payload?.streamId === ${JSON.stringify(streamId)});
          const closed = events.some((event) => event.type === "status" && /closed/i.test(event.payload?.status || event.payload?.detail || ""));
          const hasFinal = events.some((event) => event.type === "transcript" && event.payload?.isFinal && String(event.payload?.text || "").trim().length > 0);
          if ((closed && Date.now() - started > 900) || hasFinal || Date.now() - started > 7000) {
            resolve(events);
            return;
          }
          setTimeout(tick, 150);
        };
        tick();
      })`) : [];

      const completed = markLatencyStage(started, "transcription_or_vision_done");
      const totalLatency = completed.events.find((event) => event.stage === "transcription_or_vision_done")?.elapsedMs ?? 0;
      const transcriptPayloads = transcriptEvents
        .filter((event) => event.type === "transcript")
        .map((event) => event.payload);
      const reassembledTranscript = assembleNativelyTranscriptText(transcriptPayloads);
      const transcriptEvidence = [
        reassembledTranscript,
        ...transcriptPayloads.map((payload) => String(payload?.text || "")),
      ].join(" ");
      const normalizedTranscript = normalizeForChecks(reassembledTranscript);
      const normalizedCriticalWord = normalizeForChecks(scenario.critical_word);
      const triggerMs = scenario.test_type === "race_condition_cutoff" ? scenario.trigger_timestamp_ms : scenario.boundary_timestamp_ms;
      const triggerInsideCriticalWord = typeof triggerMs === "number"
        && typeof scenario.critical_word_start_ms === "number"
        && typeof scenario.critical_word_end_ms === "number"
        && triggerMs > scenario.critical_word_start_ms
        && triggerMs < scenario.critical_word_end_ms;
      const deterministicChecks = {
        audioFileExists: fs.existsSync(audioPath),
        channelValid: scenario.channel === "mic" || scenario.channel === "system",
        timingSplitsCriticalWord: triggerInsideCriticalWord,
        nativelyKeyAvailable: true,
        nativelyStreamStarted: startResult.ok,
        nativelyStreamConnected: connected || transcriptPayloads.length > 0,
        nativelyTranscriptReceived: reassembledTranscript.trim().length > 0,
        criticalWordPresent: containsCriticalWordOrVariant(transcriptEvidence, scenario.critical_word),
      };

      results.push({
        scenarioId: scenario.scenarioId,
        track: "real_audio_track_d_ipc",
        run: runNumber,
        deterministicChecks,
        judge: null,
        latency_ms: {
          first_token: null,
          total: totalLatency,
        },
        diagnostics: {
          fixturePath: "audio/track-d.json",
          audio_file: scenario.audio_file,
          profile: scenario.profile,
          channel: scenario.channel,
          test_type: scenario.test_type,
          critical_word: scenario.critical_word,
          ground_truth_transcript: scenario.ground_truth_transcript,
          reassembledTranscript,
          transcriptEvidenceExcerpt: transcriptEvidence.slice(0, 1200),
          groundTruthWordsInOrder: containsOrderedWords(reassembledTranscript, scenario.ground_truth_transcript),
          trigger_timestamp_ms: scenario.trigger_timestamp_ms,
          boundary_timestamp_ms: scenario.boundary_timestamp_ms,
          critical_word_start_ms: scenario.critical_word_start_ms,
          critical_word_end_ms: scenario.critical_word_end_ms,
          streamId,
          startResult,
          sentChunks,
          transcript_events: transcriptPayloads.map((payload) => ({
            text: String(payload?.text || "").slice(0, 240),
            isFinal: Boolean(payload?.isFinal),
            confidence: payload?.confidence,
          })),
        },
      });
    }
    return results;
  } finally {
    client?.close();
    electron.kill();
  }
};

const runRealVision = async (): Promise<RunResult[]> => {
  if (!process.env.NVIDIA_API_KEY && !process.env.CALLPILOT_NVIDIA_API_KEY) {
    return [{
      scenarioId: "vision_track_g",
      track: "real_vision_ipc",
      run: runNumber,
      deterministicChecks: {
        nvidiaKeyAvailable: false,
        visionCompleted: false,
      },
      judge: null,
      latency_ms: finishLatency("real-vision-blocked"),
      diagnostics: {
        blocked: true,
        reason: "NVIDIA_API_KEY or CALLPILOT_NVIDIA_API_KEY is required for --track=real-vision",
      },
    }];
  }
  checkBudget(1);
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing. Run npm run build before --track=real-vision.");
  }

  const requested = selectedScenarioIds();
  const allScenarios = loadVisionScenarios();
  const scenarios = requested.length > 0
    ? requested.map((id) => {
        const scenario = allScenarios.find((item) => item.scenarioId === id);
        if (!scenario) throw new Error(`Unknown vision scenario id: ${id}`);
        return scenario;
      })
    : allScenarios.slice(0, realBatchLimit);
  if (scenarios.length === 0) throw new Error("No vision scenarios selected.");
  checkBudget(scenarios.length);

  const modelName = process.env.CALLPILOT_NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct";
  const results: RunResult[] = [];

  for (const scenario of scenarios) {
    const imagePath = path.join(fixturesDir, "vision", scenario.image);
    const userDataDir = path.join(tmpDir, `user-data-vision-${Date.now()}-${scenario.scenarioId}`);
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

      await evaluate(client, `window.callpilotDesktop.startSession({ mode: "live_coding" })`);
      recordRealCall();
      const started = markLatencyStage(createLatencyMetricRun(`real-vision-${scenario.scenarioId}`), "audio_or_screen_capture");
      const analysis = await evaluate<any>(client, `window.callpilotDesktop.analyzeScreenshot({
        path: ${JSON.stringify(imagePath)},
        provider: "nvidia",
        modelName: ${JSON.stringify(modelName)},
        nvidiaApiKey: ${JSON.stringify(process.env.NVIDIA_API_KEY || process.env.CALLPILOT_NVIDIA_API_KEY || "")}
      })`);
      const completed = markLatencyStage(started, "transcription_or_vision_done");
      const totalLatency = completed.events.find((event) => event.stage === "transcription_or_vision_done")?.elapsedMs ?? 0;
      const traceStatus = await evaluate<any>(client, `window.callpilotDesktop.getSessionTraceStatus()`);
      const endSession = await evaluate<any>(client, `window.callpilotDesktop.endSession()`);
      const analysisText = String(analysis?.text || "");
      const normalizedText = normalizeForChecks(analysisText);
      const missingExactText = scenario.exact_text_present.filter((expected) => !normalizedText.includes(normalizeForChecks(expected)));
      const forbiddenMentions = forbiddenVisionMentions(analysisText, scenario.must_not_mention);
      const deterministicChecks = {
        imageFileExists: fs.existsSync(imagePath),
        visionCompleted: Boolean(analysis?.ok),
        answerNonEmpty: analysisText.trim().length > 20,
        exactTextPresent: missingExactText.length === 0,
        mustNotMentionAbsent: forbiddenMentions.length === 0,
        traceRecorded: Boolean(traceStatus?.eventCount >= 1),
      };

      results.push({
        scenarioId: scenario.scenarioId,
        track: "real_vision_ipc",
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
          fixturePath: "vision/track-g.json",
          critical_failure_categories: scenario.critical_failure_categories ?? [],
          description: scenario.description,
          expected_behavior: scenario.expected_behavior,
          image: {
            fileName: path.basename(imagePath),
            bytes: fs.existsSync(imagePath) ? fs.statSync(imagePath).size : 0,
          },
          exact_text_present: scenario.exact_text_present,
          missingExactText,
          must_not_mention: scenario.must_not_mention,
          forbiddenMentions,
          analysis,
          trace: {
            eventCount: traceStatus?.eventCount,
            path: endSession?.tracePath || traceStatus?.path,
          },
        },
      });
    } finally {
      client?.close();
      electron.kill();
    }
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
    ...(selectedTrack === "real-coding-reset-flow" || includeRealSuite ? await runRealCodingResetFlow() : []),
    ...(selectedTrack === "real-vision" || includeRealSuite ? await runRealVision() : []),
    ...(selectedTrack === "real-audio-track-d" || includeRealSuite ? await runRealAudioTrackD() : []),
    ...(selectedTrack === "real-long-session" || includeRealSuite ? await runRealLongSession() : []),
    ...(selectedTrack === "real-text-batch" ? await runRealTextBatch() : []),
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
