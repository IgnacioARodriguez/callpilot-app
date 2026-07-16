import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLatencyMetricRun,
  detectQuestionIntent,
  markLatencyStage,
  type PreferredLanguage,
} from "../../../src/core/index.ts";

type Track = "no-answer" | "coding-fixtures" | "all";

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const fixturesDir = path.join(root, "tests", "fixtures");
const reportsDir = path.join(root, "tests", "e2e", "reports");

const argValue = (name: string): string => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
};

const selectedTrack = (argValue("--track") || "all") as Track;
const runNumber = Number(argValue("--run") || "1");
const maxRealCalls = Number(process.env.E2E_MAX_REAL_CALLS || "0");
let realCalls = 0;

const readJson = <T>(relativePath: string): T =>
  JSON.parse(fs.readFileSync(path.join(fixturesDir, relativePath), "utf8")) as T;

const finishLatency = (label: string, startedStage: "audio_or_screen_capture" | "model_call_start" = "model_call_start") => {
  const started = markLatencyStage(createLatencyMetricRun(label), startedStage);
  const completed = markLatencyStage(started, "response_complete");
  const responseComplete = completed.events.find((event) => event.stage === "response_complete");
  return {
    first_token: null,
    total: responseComplete?.elapsedMs ?? 0,
  };
};

const checkBudget = () => {
  if (realCalls > maxRealCalls) {
    throw new Error(`E2E real call budget exceeded: ${realCalls}/${maxRealCalls}`);
  }
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

const run = () => {
  checkBudget();
  const results = [
    ...(selectedTrack === "all" || selectedTrack === "no-answer" ? runNoAnswer() : []),
    ...(selectedTrack === "all" || selectedTrack === "coding-fixtures" ? runCodingFixtureValidation() : []),
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

run();
