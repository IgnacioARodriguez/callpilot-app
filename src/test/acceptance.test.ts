import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPrompt,
  createGlobalContext,
  classifyScreenText,
  createTurnAssemblerState,
  formatConversationWindow,
  pickEvidenceWithEmbeddings,
  TranscriptBuffer,
  assembleTurn,
  assessPartialTurnStability,
  shouldAutoAnswer,
  detectQuestionIntent,
  speechSimilarity,
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

  for (const needle of ["session:start", "session:end", "session:trace-status", "answer:request", "answer:manual-request", "answer:headline", "answer:detail-chunk", "answer:structured", "answer:status", "transcript:message"]) {
    assert.match(`${main}\n${preload}`, new RegExp(needle.replace(":", ":")));
  }
  assert.match(overlay, /cp-overlay/);
  assert.match(overlay, /requestAnswer/);
  assert.match(overlay, /onAnswerStatus/);
  assert.match(overlay, /renderFormattedText/);
  assert.match(overlay, /cp-rich-text/);
  assert.match(overlay, /assistantIdByRequest/);
  assert.match(overlay, /lastSequenceByRequest/);
  assert.match(main, /requestId/);
  assert.match(main, /sequence/);
  assert.doesNotMatch(main, /pendingDetailChunks/);
  assert.match(main, /sendDetailChunk\(streamEvent\.delta\)/);
  assert.match(main, /sendToSessionWindows\("answer:structured"/);
  assert.match(main, /sendToSessionWindows\("answer:status"/);
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
  assert.match(main, /latestActionableInput/);
  assert.match(main, /extractPromptSection\(prompt\.user, "latest_actionable_input"\)/);
  assert.match(preload, /getSessionTraceStatus/);
  assert.match(app, /Metrics trace:/);
});

test("acceptance: answer providers are routed through a registry", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
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
  assert.match(`${main}\n${preload}`, /nvidia:list-models/);
  assert.match(app, /listNvidiaModels/);
  assert.match(app, /nvidiaStatus/);
  assert.match(`${main}\n${preload}\n${app}`, /saveNvidiaKey/);
  assert.match(`${main}\n${preload}\n${app}`, /clearNvidiaKey/);
  assert.match(app, /NVIDIA_MODEL_PRESETS/);
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
  const partial = "Can you walk me through how you would design retries for payments?";
  const changed = assessPartialTurnStability(partial, "Can you walk me through", 1_000, 2_000);
  const tooSoon = assessPartialTurnStability(partial, partial, 1_500, 2_000);
  const stable = assessPartialTurnStability(partial, partial, 1_000, 2_000);
  const detection = detectQuestionIntent(partial, "english");

  assert.deepEqual(changed, { stable: false, reason: "changed_recently" });
  assert.deepEqual(tooSoon, { stable: false, reason: "changed_recently" });
  assert.deepEqual(stable, { stable: true, reason: "stable_partial" });
  assert.equal(shouldAutoAnswer(detection, 20_000, 0), true);
});

test("acceptance: starting an overlay session resets stale runtime context", () => {
  const app = read("src/main.tsx");
  const resetIndex = app.indexOf("const resetSessionRuntimeContext");
  const startIndex = app.indexOf("const startSession");
  const callIndex = app.indexOf("resetSessionRuntimeContext();", startIndex);
  const beginIndex = app.indexOf("window.callpilotDesktop.startSession", startIndex);

  assert.ok(resetIndex > 0, "runtime reset helper must exist");
  assert.ok(callIndex > startIndex && callIndex < beginIndex, "startSession must reset before opening the overlay session");
  assert.match(app, /setTranscript\(emptyTranscript\)/);
  assert.match(app, /setScreenText\(""\)/);
  assert.match(app, /setQuestion\(""\)/);
  assert.match(app, /turnAssemblerRef\.current = createTurnAssemblerState\(\)/);
  assert.doesNotMatch(app.slice(startIndex, app.indexOf("const stopMicRecording", startIndex)), /warmAnswerModel\(\)/);
});

test("acceptance: Natively final fragments do not pollute live transcript drafts", () => {
  const state = createTurnAssemblerState();
  const partial = assembleTurn(state, {
    speaker: "interviewer",
    text: "Can you explain how you would make the payment worker idempotent",
    isFinal: false,
    timestamp: 1_000,
  });
  const folded = assembleTurn(state, {
    speaker: "interviewer",
    text: "payment worker idempotent?",
    isFinal: true,
    timestamp: 1_500,
  });

  assert.equal(partial.action, "publish_live");
  assert.equal(folded.action, "fold_final");
  assert.match(folded.action === "fold_final" ? folded.draftText : "", /payment worker idempotent\?/);
  assert.deepEqual(state.committedBySpeaker, {});
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
  assert.doesNotMatch(prompt.user, /PostgreSQL|audit logs|transaction consistency/);
  assert.match(prompt.system, /candidate's prior answer is incomplete or technically wrong/i);
  assert.match(prompt.system, /Do not answer stale topics/i);
});

test("acceptance: manual answer falls back to context when no question is detected", () => {
  const visibleText = "function twoSum(nums, target) {\n  // TODO\n}";
  const context = createGlobalContext({
    activeMode: "live_coding",
    screenContext: classifyScreenText(visibleText),
    codingLanguagePreference: "TypeScript",
  });
  const manualInput = [
    "user_request: The candidate pressed Answer. There may not be a clean question mark in the transcript.",
    "task: Use the current coding problem, screen context, and transcript to provide the next useful coding help.",
  ].join("\n");
  const prompt = buildPrompt(context, manualInput);

  assert.match(prompt.user, /The candidate pressed Answer/);
  assert.match(prompt.user, /next useful coding help/);
  assert.match(prompt.user, /function twoSum/);
  assert.match(prompt.system, /most useful next thing to say/i);
  assert.doesNotMatch(prompt.user, /No interviewer question detected yet/);
});

test("acceptance: non-interview casual questions must not pivot to SQL", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("What is SQL?", "stt", 1_000, "interviewer");
  transcript.append("SQL is a relational query language.", "manual", 2_000, "assistant");
  transcript.append("Do you think GTA will have physical copies?", "stt", 3_000, "interviewer");
  const latestInput = formatConversationWindow(transcript.snapshot(), "", 10);
  const detection = detectQuestionIntent(latestInput, "english");
  const prompt = buildPrompt(
    createGlobalContext({
      activeMode: "technical_qa",
      resumeText: "Built PostgreSQL reporting systems.",
      transcript: transcript.snapshot(),
    }),
    latestInput,
  );

  assert.equal(detection.shouldDispatch, false);
  assert.equal(detection.reason, "non_interview_casual");
  assert.match(prompt.system, /do not answer it with SQL/i);
  assert.match(prompt.user.match(/<current_question>\n([\s\S]*?)\n<\/current_question>/)?.[1] ?? "", /GTA/i);
  assert.doesNotMatch(prompt.user, /<resume>/);
});

test("acceptance: transcript publishing is idempotent under React StrictMode", () => {
  const recent = { speaker: "interviewer", text: "Can you explain idempotency?", timestamp: 1_000 };
  const duplicate = { speaker: "interviewer", text: "Can you explain idempotency", timestamp: 1_500 };
  const nextTurn = { speaker: "interviewer", text: "How would you implement retries?", timestamp: 2_000 };
  const isDuplicatePublish =
    recent.speaker === duplicate.speaker
    && speechSimilarity(recent.text, duplicate.text) >= 0.96
    && duplicate.timestamp - recent.timestamp < 2_000;
  const isNewPublish =
    recent.speaker === nextTurn.speaker
    && speechSimilarity(recent.text, nextTurn.text) >= 0.96
    && nextTurn.timestamp - recent.timestamp < 2_000;

  assert.equal(isDuplicatePublish, true);
  assert.equal(isNewPublish, false);
});

test("acceptance: overlay starts a new live bubble after an assistant answer", () => {
  const overlay = read("src/overlay/OverlayApp.tsx");

  assert.match(overlay, /assistantAfterExisting/);
  assert.match(overlay, /hasTranscriptProgress/);
  assert.match(overlay, /mode === "partial" && committed && !hasTranscriptProgress\(committed, clean\)/);
  assert.match(overlay, /targetId = mode === "partial" && assistantAfterExisting/);
  assert.match(overlay, /!assistantAfterExistingBeforeUpdate/);
  assert.match(overlay, /baseline\?: string/);
  assert.match(overlay, /transcriptDelta\(targetBaseline, clean\)/);
});

test("acceptance: repeated assistant errors stay visible as separate answer attempts", () => {
  const overlay = read("src/overlay/OverlayApp.tsx");

  assert.match(overlay, /mode === "final" && role !== "assistant"/);
});

test("acceptance: overlay shows the changing tail of long live transcripts", () => {
  const overlay = read("src/overlay/OverlayApp.tsx");

  assert.match(overlay, /liveTranscriptText/);
  assert.match(overlay, /clean\.slice\(-260\)/);
  assert.match(overlay, /message\.isStreaming \? liveTranscriptText/);
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
