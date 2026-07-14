import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPrompt,
  createGlobalContext,
  classifyScreenText,
  formatConversationWindow,
  pickEvidenceWithEmbeddings,
  TranscriptBuffer,
  shouldAutoAnswer,
  detectQuestionIntent,
} from "../core/index.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("acceptance: no unverified OpenAI model is hardcoded", () => {
  const files = [
    "src/main.tsx",
    "src/core/settings.ts",
    "src/core/sessions.ts",
    "electron/main.cjs",
    "electron/preload.cjs",
  ];

  for (const file of files) {
    assert.equal(read(file).includes("gpt-5.5"), false, `${file} still references gpt-5.5`);
  }
});

test("acceptance: implicit interviewer turns dispatch without regex question confidence", () => {
  const detection = detectQuestionIntent("me interesaria que me cuentes tu approach aca", "spanish");

  assert.equal(detection.shouldDispatch, true);
  assert.equal(shouldAutoAnswer(detection, 20_000, 0), true);
});

test("acceptance: prompt includes embedded evidence when supplied", async () => {
  const context = createGlobalContext({
    resumeText: "Built payments reconciliation with PostgreSQL and audit logs.",
    starStories: "Led onboarding improvements for new engineers.",
  });
  const embedder = async (texts: string[]) => texts.map((text) => ({
    text,
    vector: /payments?|reconciliation|postgresql/i.test(text) ? [1, 0] : [0, 1],
  }));

  const evidence = await pickEvidenceWithEmbeddings(context, "How did you keep payment data consistent?", embedder, 1);
  const prompt = buildPrompt(context, "How did you keep payment data consistent?");

  assert.equal(evidence.debug.strategy, "embedding");
  assert.match(evidence.items[0]?.text ?? "", /payments|reconciliation|PostgreSQL/i);
  assert.match(prompt.system, /natural spoken headline/);
});

test("acceptance: overlay and streaming IPC channels are wired", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const app = read("src/main.tsx");
  const overlay = read("src/overlay/OverlayApp.tsx");
  const codingOverlay = read("src/overlay/CodingOverlayApp.tsx");

  for (const needle of ["session:start", "session:end", "session:trace-status", "answer:request", "answer:manual-request", "answer:headline", "answer:detail-chunk", "answer:structured", "transcript:message"]) {
    assert.match(`${main}\n${preload}`, new RegExp(needle.replace(":", ":")));
  }
  assert.match(overlay, /cp-overlay/);
  assert.match(overlay, /requestAnswer/);
  assert.match(overlay, /renderFormattedText/);
  assert.match(overlay, /cp-rich-text/);
  assert.match(overlay, /assistantIdByRequest/);
  assert.match(overlay, /lastSequenceByRequest/);
  assert.match(main, /requestId/);
  assert.match(main, /sequence/);
  assert.doesNotMatch(main, /pendingDetailChunks/);
  assert.match(main, /sendDetailChunk\(streamEvent\.delta\)/);
  assert.match(main, /sendToSessionWindows\("answer:structured"/);
  assert.match(app, /publishStructuredAnswer/);
  assert.match(codingOverlay, /cp-code-panel/);
  assert.match(codingOverlay, /cp-reasoning-panel/);
  assert.match(codingOverlay, /onStructuredAnswer/);
  assert.match(codingOverlay, /displayCode/);
  assert.doesNotMatch(codingOverlay, /starterCode/);
});

test("acceptance: normal sessions persist metrics traces", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const app = read("src/main.tsx");

  assert.match(main, /sessionReportsDir/);
  assert.match(main, /startSessionTrace/);
  assert.match(main, /finishSessionTrace/);
  assert.match(main, /appendTraceEvent\("model_generate_started"/);
  assert.match(main, /appendTraceEvent\("model_generate_completed"/);
  assert.match(main, /appendTraceEvent\("audio_transcribe_completed"/);
  assert.match(main, /appendTraceEvent\("screen_capture_completed"/);
  assert.match(main, /storesRawAudio:\s*false/);
  assert.match(main, /storesScreenshots:\s*false/);
  assert.match(preload, /getSessionTraceStatus/);
  assert.match(app, /Metrics trace:/);
});

test("acceptance: answer providers are routed through a registry", () => {
  const main = read("electron/main.cjs");
  const app = read("src/main.tsx");
  const modelClient = read("src/core/modelClient.ts");

  assert.match(main, /providerPresets/);
  assert.match(main, /protocol:\s*"openai_chat"/);
  assert.match(main, /protocol:\s*"openai_responses"/);
  assert.match(main, /generateWithOpenAICompatibleChat/);
  assert.match(main, /structuredAnswerPayloadJsonSchema/);
  assert.match(main, /input\?\.structuredOutput/);
  assert.match(app, /structuredOutput:\s*true/);
  assert.doesNotMatch(modelClient, /answerSchema/);
  assert.doesNotMatch(`${main}\n${modelClient}`, /structured_interview_answer/);
  assert.match(main, /nvidia/);
});

test("acceptance: live STT chunks are queued instead of dropped while busy", () => {
  const app = read("src/main.tsx");
  const localEnqueue = app.indexOf("enqueueLocalSttBlob(channelId, blob, speaker)");
  const localBusy = app.indexOf("localSttBusyByIdRef.current.has(channelId)");
  const liveEnqueue = app.indexOf("enqueueLiveChunkBlob(channelId, blob, speaker)");
  const liveBusy = app.indexOf("liveChunkBusyByIdRef.current.has(channelId)");

  assert.ok(localEnqueue > 0 && localBusy > localEnqueue, "local STT must enqueue before checking busy state");
  assert.ok(liveEnqueue > 0 && liveBusy > liveEnqueue, "live chunk STT must enqueue before checking busy state");
  assert.match(app, /localSttQueueByIdRef/);
  assert.match(app, /liveChunkQueueByIdRef/);
  assert.doesNotMatch(app, /channels\.slice\(1\).*stop/s);
});

test("acceptance: Natively partial auto-answer waits for turn stability", () => {
  const app = read("src/main.tsx");
  const stability = app.indexOf("assessPartialTurnStability");
  const askPartial = app.indexOf("Auto answering stable partial");

  assert.ok(stability > 0, "Natively partials must be assessed for stability");
  assert.ok(askPartial > stability, "partial auto-answer must happen after stability assessment");
  assert.doesNotMatch(app, /Auto answering partial \(/);
});

test("acceptance: Natively final fragments do not pollute live transcript drafts", () => {
  const app = read("src/main.tsx");

  assert.match(app, /isNativelyFinalFragment/);
  assert.match(app, /Natively final fragment folded into live draft/);
  assert.match(app, /clean\.length < draft\.length \* 0\.75/);
});

test("acceptance: realistic interview exchange preserves roles and asks for correction", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("What is SQL?", "stt", 1000, "interviewer");
  transcript.append("It is a programming language for building apps.", "stt", 2000, "candidate");
  transcript.append("Why would you describe it that way?", "stt", 3000, "interviewer");
  const context = createGlobalContext({
    activeMode: "technical_qa",
    resumeText: "Built payments reconciliation with PostgreSQL, audit logs, joins, and transaction consistency.",
    starStories: "Situation: reporting data was inconsistent. Action: introduced PostgreSQL constraints and reconciliation checks. Result: reduced audit issues.",
    transcript: transcript.snapshot(),
    preferredLanguage: "english",
  });
  const userInput = formatConversationWindow(transcript.snapshot(), "", 10);
  const prompt = buildPrompt(context, userInput);

  assert.match(prompt.user, /interviewer: What is SQL\?/);
  assert.match(prompt.user, /candidate: It is a programming language/);
  assert.match(prompt.user, /interviewer: Why would you describe it that way\?/);
  assert.match(prompt.user, /PostgreSQL|audit logs|transaction consistency/);
  assert.match(prompt.system, /candidate's prior answer is incomplete or technically wrong/i);
  assert.match(prompt.system, /Do not answer stale topics/i);
});

test("acceptance: manual answer falls back to context when no question is detected", () => {
  const app = read("src/main.tsx");
  const promptBuilder = read("src/core/promptBuilder.ts");

  assert.match(app, /getManualAnswerPrompt/);
  assert.match(app, /The candidate pressed Answer/);
  assert.match(app, /next useful coding help/);
  assert.match(app, /next useful thing to say/);
  assert.doesNotMatch(app, /No interviewer question detected yet/);
  assert.match(promptBuilder, /If the latest interviewer turn is not an interview/);
});

test("acceptance: non-interview casual questions must not pivot to SQL", () => {
  const promptBuilder = read("src/core/promptBuilder.ts");
  const runner = read("scripts/run-llm-scenarios.mjs");

  assert.match(promptBuilder, /casual, entertainment-related, logistical, or unrelated/);
  assert.match(promptBuilder, /do not answer it with SQL/);
  assert.match(runner, /no_answer_gaming_physical_copy/);
  assert.match(runner, /no_answer_gaming_reservations/);
});

test("acceptance: transcript publishing is idempotent under React StrictMode", () => {
  const app = read("src/main.tsx");

  assert.match(app, /recentPublishedTranscriptRef/);
  assert.match(app, /duplicatePublish/);
  assert.match(app, /speechSimilarity\(recent\.text, message\.text\) >= 0\.96/);
});

test("acceptance: LLM quality runner has a broad scenario corpus", () => {
  const runner = read("scripts/run-llm-scenarios.mjs");
  const scenarioLikeEntries = (runner.match(/(?:id:\s*"|makeTechnicalScenario\("|makeBehavioralScenario\("|makeCodingScenario\(")/g) ?? []).length;

  assert.ok(scenarioLikeEntries >= 50, `expected at least 50 LLM scenarios, found ${scenarioLikeEntries}`);
  for (const category of ["technical", "background", "followup", "candidate_error", "no_answer", "coding", "coding_followup"]) {
    assert.match(runner, new RegExp(`category:\\s*"${category}"|category:\\s*options\\.category\\s*\\|\\|\\s*"${category}"`));
  }
  assert.match(runner, /--category/);
  assert.match(runner, /--limit/);
  assert.match(runner, /--dry-run/);
  assert.match(runner, /forbiddenTermsAbsent/);
});

test("acceptance: live coding prompt includes problem, solution intent, and coding screen context", () => {
  const visibleText = [
    "Two Sum",
    "Example 1:",
    "Input: nums = [2,7,11,15], target = 9",
    "Output: [0,1]",
    "Constraints:",
    "2 <= nums.length <= 10^4",
  ].join("\n");
  const transcript = new TranscriptBuffer();
  transcript.append("Can you solve this and explain complexity?", "stt", 1000, "interviewer");
  const context = createGlobalContext({
    activeMode: "live_coding",
    codingLanguagePreference: "Python",
    screenContext: classifyScreenText(visibleText),
    transcript: transcript.snapshot(),
  });
  const prompt = buildPrompt(context, formatConversationWindow(transcript.snapshot(), "", 5));

  assert.match(prompt.user, /<active_mode>\nlive_coding/);
  assert.match(prompt.user, /<coding_language_preference>\nPython/);
  assert.match(prompt.user, /kind: coding_problem/);
  assert.match(prompt.user, /Two Sum/);
  assert.match(prompt.user, /Can you solve this and explain complexity/);
  assert.match(prompt.system, /screen text/);
});
