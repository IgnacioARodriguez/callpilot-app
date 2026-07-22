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

  for (const needle of ["session:start", "session:end", "session:trace-status", "answer:request", "answer:manual-request", "answer:headline", "answer:detail-chunk", "answer:structured", "answer:raw-model-output", "answer:status", "transcript:message", "deepgram:start", "deepgram:audio", "deepgram:stop", "deepgram:transcript", "deepgram:status"]) {
    assert.match(`${main}\n${preload}`, new RegExp(needle.replace(":", ":")));
  }
  assert.match(overlay, /cp-overlay/);
  assert.match(overlay, /requestAnswer/);
  assert.match(overlay, /onAnswerStatus/);
  assert.match(overlay, /renderFormattedText/);
  assert.match(overlay, /cp-rich-text/);
  assert.match(preload, /onSessionEnded/);
  assert.match(app, /onSessionEnded/);
  assert.match(app, /Overlay session ended; live transcription stopped/);
  assert.match(overlay, /assistantIdByRequest/);
  assert.match(overlay, /lastSequenceByRequest/);
  assert.match(main, /requestId/);
  assert.match(main, /sequence/);
  assert.doesNotMatch(main, /pendingDetailChunks/);
  assert.match(main, /sendDetailChunk\(extractProviderStreamDelta\(streamEvent\)\)/);
  assert.match(main, /sendToSessionWindows\("answer:structured"/);
  assert.match(main, /appendTraceEvent\("answer_raw_model_output"/);
  assert.doesNotMatch(main, /sendToSessionWindows\("answer:raw-model-output"/);
  assert.match(main, /sendToSessionWindows\("answer:status"/);
  assert.match(app, /publishStructuredAnswer/);
  assert.match(app, /publishRawModelOutput/);
  assert.match(codingOverlay, /cp-code-panel/);
  assert.match(codingOverlay, /cp-reasoning-panel/);
  assert.match(codingOverlay, /onStructuredAnswer/);
  assert.match(codingOverlay, /displayCode/);
  assert.doesNotMatch(codingOverlay, /starterCode/);
});

test("acceptance: session windows open side-by-side at the bottom with compact height", () => {
  const main = read("electron/main.cjs");

  assert.match(main, /const sessionWindowBounds = \(\) =>/);
  assert.match(main, /const margin = 24/);
  assert.match(main, /const gap = 12/);
  assert.match(main, /const preferredHeight = 410/);
  assert.match(main, /Math\.floor\(\(workArea\.height - margin \* 2\) \* 0\.5\)/);
  assert.match(main, /const y = workArea\.y \+ workArea\.height - margin - height/);
  assert.match(main, /coding: \{ x, y, width: codingWidth, height \}/);
  assert.match(main, /overlay: \{ x: x \+ codingWidth \+ gap, y, width: overlayWidth, height \}/);
  assert.match(main, /overlayWindow\.setBounds\(overlay\)/);
  assert.match(main, /codingWindow\.setBounds\(coding\)/);
});

test("acceptance: live coding code panel uses One Dark Pro contrast", () => {
  const css = read("src/styles.css");

  assert.match(css, /\.cp-code-panel\s*\{[\s\S]*background:\s*rgba\(40,\s*44,\s*52/);
  assert.match(css, /\.cp-code-panel \.cp-panel-title\s*\{[\s\S]*background:\s*rgba\(33,\s*37,\s*43/);
  assert.match(css, /\.cp-code-panel \.cp-panel-title strong\s*\{[\s\S]*color:\s*#e5c07b/);
  assert.match(css, /\.cp-code-panel \.cp-panel-title span\s*\{[\s\S]*color:\s*#61afef/);
  assert.match(css, /\.cp-code-panel pre\s*\{[\s\S]*color:\s*#d7dae0/);
  assert.match(css, /\.cp-token-keyword\s*\{[\s\S]*color:\s*#c678dd/);
  assert.match(css, /\.cp-token-string\s*\{[\s\S]*color:\s*#98c379/);
  assert.match(css, /\.cp-token-comment\s*\{[\s\S]*color:\s*#8b949e/);
  assert.match(css, /\.cp-token-variable\s*\{[\s\S]*color:\s*#d7dae0/);
  assert.match(css, /"Cascadia Code", "Fira Code"/);
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
  assert.match(main, /appendTraceEvent\("provider_request_started"/);
  assert.match(main, /appendTraceEvent\("provider_response_headers"/);
  assert.match(main, /appendTraceEvent\("provider_response_body_parsed"/);
  assert.match(main, /appendTraceEvent\("provider_stream_completed"/);
  assert.match(main, /appendTraceEvent\("audio_transcribe_completed"/);
  assert.match(main, /appendTraceEvent\("screen_capture_completed"/);
  assert.match(main, /storesRawAudio:\s*false/);
  assert.match(main, /storesScreenshots:\s*false/);
  assert.match(main, /latestActionableInput/);
  assert.match(main, /extractPromptSection\(prompt\.user, "latest_actionable_input"\)/);
  assert.match(app, /recordSessionEvent\?\.\("answer_timing"/);
  assert.match(app, /emitAnswerTiming\("model_call_started"/);
  assert.match(app, /emitAnswerTiming\("format_completed"/);
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
  assert.match(main, /response_format:\s*\{\s*type:\s*"json_object"\s*\}/);
  assert.match(main, /provider_structured_response_format_fallback/);
  assert.match(main, /provider_stream_first_chunk/);
  assert.match(main, /choices/);
  assert.match(app, /liveSpokenOutput/);
  assert.match(app, /structuredOutput:\s*!liveSpokenOutput/);
  assert.doesNotMatch(modelClient, /answerSchema/);
  assert.doesNotMatch(`${main}\n${modelClient}`, /structured_interview_answer/);
  assert.match(main, /nvidia/);
  assert.match(`${main}\n${preload}`, /nvidia:list-models/);
  assert.match(app, /listNvidiaModels/);
  assert.match(app, /nvidiaStatus/);
  assert.match(`${main}\n${preload}\n${app}`, /saveNvidiaKey/);
  assert.match(`${main}\n${preload}\n${app}`, /clearNvidiaKey/);
  assert.match(app, /NVIDIA_MODEL_PRESETS/);
  assert.match(main, /groq/);
  assert.match(main, /api\.groq\.com\/openai\/v1\/chat\/completions/);
  assert.match(`${main}\n${preload}`, /groq:list-models/);
  assert.match(app, /listGroqModels/);
  assert.match(app, /groqStatus/);
  assert.match(`${main}\n${preload}\n${app}`, /saveGroqKey/);
  assert.match(`${main}\n${preload}\n${app}`, /clearGroqKey/);
  assert.match(app, /GROQ_MODEL_PRESETS/);
  assert.match(read("package.json"), /test:e2e:live-coding-replay:groq/);
  assert.match(read("package.json"), /check:groq/);
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

test("acceptance: stopping live recording preserves pending final audio chunks", () => {
  const app = read("src/main.tsx");
  const stopStart = app.indexOf("const stopLiveRecording = React.useCallback(() => {");
  const stopEnd = app.indexOf("React.useEffect", stopStart);
  const stopBody = app.slice(stopStart, stopEnd);

  assert.ok(stopStart > 0, "stopLiveRecording must exist");
  assert.match(stopBody, /recorder\.stop\(\)/);
  assert.doesNotMatch(stopBody, /localSegmentChunksByIdRef\.current\.clear\(\)/);
  assert.doesNotMatch(stopBody, /localSttQueueByIdRef\.current\.clear\(\)/);
  assert.doesNotMatch(stopBody, /liveChunkQueueByIdRef\.current\.clear\(\)/);
  assert.match(app, /consumeSegmentChunks\(localSegmentChunksByIdRef\.current, channelId\)/);
  assert.match(app, /shouldDrainTranscriptionQueue\(liveContinueRef\.current/);
});

test("acceptance: Natively keeps low-volume system audio while filtering mic noise", () => {
  const app = read("src/main.tsx");

  assert.match(app, /const nativelySpeaker = channel\.speaker === "candidate" \? "candidate" : "interviewer"/);
  assert.match(app, /shouldSendNativelyFrame\(nativelySpeaker, energy\)/);
  assert.doesNotMatch(app, /if \(energy\.rms < 0\.0018 && energy\.peak < 0\.018\) return/);
});

test("acceptance: Natively stream close is recoverable while audio is still flowing", () => {
  const main = read("electron/main.cjs");

  assert.match(main, /openNativelyStreamSocket/);
  assert.match(main, /reconnectNativelyStream/);
  assert.match(main, /natively_stream_reconnecting/);
  assert.match(main, /stream\.closed/);
  assert.match(main, /reconnects >= 3/);
  assert.doesNotMatch(main, /if \(!stream \|\| stream\.closed\)[\s\S]{0,220}natively_stream_not_started/);
});

test("acceptance: session lifecycle stops stale live transcription streams", () => {
  const main = read("electron/main.cjs");
  const sessionStart = main.indexOf('ipcMain.handle("session:start"');
  const sessionEnd = main.indexOf('ipcMain.handle("session:end"');
  const traceEvent = main.indexOf('ipcMain.handle("session:trace-event"');
  const startBody = main.slice(sessionStart, sessionEnd);
  const endBody = main.slice(sessionEnd, traceEvent);

  assert.match(main, /const stopAllNativelyStreams = \(\) =>/);
  assert.match(main, /const stopAllDeepgramStreams = \(\) =>/);
  assert.match(startBody, /startSessionTrace\(options\)[\s\S]*stopAllNativelyStreams\(\)/);
  assert.match(startBody, /stopAllDeepgramStreams\(\)/);
  assert.match(startBody, /live_transcription_runtime_reset/);
  assert.match(endBody, /mainWindow\?\.webContents\.send\("session:ended"\)/);
  assert.match(endBody, /stopAllNativelyStreams\(\)/);
  assert.match(endBody, /stopAllDeepgramStreams\(\)/);
  assert.match(endBody, /reason: "session_end"/);
});

test("acceptance: Deepgram realtime STT uses the production live audio path", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const app = read("src/main.tsx");
  const liveTranscription = read("src/core/liveTranscription.ts");

  assert.match(liveTranscription, /"deepgram"/);
  assert.match(liveTranscription, /engineLabel:\s*"Deepgram realtime"/);
  assert.match(main, /const deepgramUrlForConfig = \(config\) =>/);
  assert.match(main, /wss:\/\/api\.deepgram\.com\/v1\/listen/);
  assert.match(main, /interim_results", "true"/);
  assert.match(main, /language", config\.language/);
  assert.match(main, /new WebSocketCtor\(deepgramUrlForConfig\(config\), \["token", config\.apiKey\]\)/);
  assert.match(main, /appendTraceEvent\("deepgram_audio_chunk"/);
  assert.match(main, /appendTraceEvent\("deepgram_transcript"/);
  assert.match(main, /credentials:save-deepgram-key/);
  assert.match(main, /credentials:clear-deepgram-key/);
  assert.match(preload, /startDeepgramTranscription/);
  assert.match(preload, /sendDeepgramAudio/);
  assert.match(preload, /onDeepgramTranscript/);
  assert.match(app, /startDeepgramListening/);
  assert.match(app, /requestLiveAudioStreams\(\)/);
  assert.match(app, /resampleMono\(input, context\.sampleRate, 16000\)/);
  assert.match(app, /sendDeepgramAudio/);
  assert.match(app, /onDeepgramTranscript/);
  assert.match(app, /provider: "deepgram"/);
  assert.match(app, /<option value="deepgram">Deepgram realtime<\/option>/);
  assert.doesNotMatch(app, /<option value="natively">Natively STT testing<\/option>/);
  assert.match(app, /saveDeepgramSessionKey/);
  assert.match(app, /hasDeepgramTranscriptionKey/);
});

test("acceptance: Deepgram realtime settings respect provider parameter bounds", () => {
  const main = read("electron/main.cjs");

  assert.match(main, /Math\.max\(1000,\s*Math\.min\(5000,\s*Math\.round\(Number\(input\.utteranceEndMs\)\)\)\)/);
  assert.doesNotMatch(main, /latencyPreset === "fast" \? 800/);
  assert.match(main, /latencyPreset === "accurate" \? 1400 : 1000/);
  assert.match(main, /closedAudioLogged/);
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

test("acceptance: live coding setup defaults to OpenAI gpt-5-mini without changing touched providers", () => {
  const app = read("src/main.tsx");
  const settings = read("src/core/settings.ts");
  const main = read("electron/main.cjs");
  const setupStart = app.indexOf("const applyInterviewSetup");
  const setupBody = app.slice(setupStart, app.indexOf("React.useEffect", setupStart));

  assert.match(app, /const LIVE_CODING_DEFAULT_PROVIDER: ModelProvider = "openai"/);
  assert.match(app, /const LIVE_CODING_DEFAULT_MODEL = "gpt-5-mini"/);
  assert.match(app, /const TECHNICAL_INTERVIEW_DEFAULT_PROVIDER: ModelProvider = "nvidia"/);
  assert.match(setupBody, /setup\.mode === "live_coding"[\s\S]*LIVE_CODING_DEFAULT_PROVIDER/);
  assert.match(setupBody, /answerProviderTouchedRef\.current/);
  assert.match(setupBody, /modelProvider: nextProvider/);
  assert.match(setupBody, /modelName: nextModelName/);
  assert.match(settings, /modelProvider:\s*"openai"/);
  assert.match(settings, /modelName:\s*"gpt-5-mini"/);
  assert.match(main, /modelProvider:\s*"openai"/);
  assert.match(main, /modelName:\s*"gpt-5-mini"/);
  assert.match(main, /settings\.activeMode === "live_coding"[\s\S]*settings\.modelProvider === "nvidia"[\s\S]*settings\.modelName === defaultNvidiaAnswerModel\(\)[\s\S]*settings\.modelProvider = "openai"[\s\S]*settings\.modelName = "gpt-5-mini"/);
});

test("acceptance: app startup warms the selected remote answer model", () => {
  const app = read("src/main.tsx");
  const warmIndex = app.indexOf("warmAnswerModel({ silent: true, reason: \"startup\" })");
  const startIndex = app.indexOf("const startSession");

  assert.ok(warmIndex > 0, "startup warmup must be wired");
  assert.ok(warmIndex < startIndex, "startup warmup should not wait for session start");
  assert.match(app, /settingsLoaded \|\| !credentialStatusLoaded/);
  assert.match(app, /answerWarmupHealth\.label/);
  assert.match(app, /answerWarmupChipClass/);
  assert.match(app, /timeoutMs: 90000/);
  assert.match(app, /nvidiaApiKey/);
  assert.match(app, /groqApiKey/);
  assert.match(app, /modelProvider === "groq" \|\| modelProvider === "openai"/);
  assert.match(app, /OpenAI warmup skipped to avoid extra token spend/);
});

test("acceptance: app startup warms local evidence embeddings before session start", () => {
  const app = read("src/main.tsx");
  const warmIndex = app.indexOf("callpilot startup evidence warmup");
  const startIndex = app.indexOf("const startSession");
  const startSessionBody = app.slice(startIndex, app.indexOf("const stopMicRecording", startIndex));

  assert.ok(warmIndex > 0, "evidence embedder startup warmup must be wired");
  assert.ok(warmIndex < startIndex, "evidence warmup should not wait for session start");
  assert.match(app, /evidence_embedder_warmup_state/);
  assert.match(app, /evidence_embedder_warmup_completed/);
  assert.doesNotMatch(startSessionBody, /getEvidenceEmbedder\(\)/);
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

test("acceptance: completed assistant answer replaces streamed detail in overlay", () => {
  const overlay = read("src/overlay/OverlayApp.tsx");

  assert.match(overlay, /detail:\s*terminal \? "" : undefined/);
  assert.match(overlay, /\{ \.\.\.message, \.\.\.assistantMessage \}/);
});

test("acceptance: Deepgram microphone audio is sent to provider instead of locally filtered", () => {
  const app = read("src/main.tsx");
  const deepgramStart = app.indexOf("const startDeepgramListening = async");
  const toggleStart = app.indexOf("const toggleDictation = async", deepgramStart);
  const body = app.slice(deepgramStart, toggleStart);

  assert.match(body, /recordSessionEvent\?\.\("live_audio_signal"/);
  assert.doesNotMatch(body, /shouldSendNativelyFrame\(speaker, energy\)/);
  assert.match(body, /sendDeepgramAudio/);
});

test("acceptance: overlay shows the changing tail of long live transcripts", () => {
  const overlay = read("src/overlay/OverlayApp.tsx");

  assert.match(overlay, /liveTranscriptText/);
  assert.match(overlay, /clean\.slice\(-260\)/);
  assert.match(overlay, /message\.isStreaming \? liveTranscriptText/);
});

test("acceptance: LLM quality runner has a broad scenario corpus", () => {
  const runner = read("scripts/run-llm-scenarios.mjs");
  const pkg = read("package.json");
  const scenarioLikeEntries = (runner.match(/(?:id:\s*"|makeTechnicalScenario\("|makeBehavioralScenario\("|makeCodingScenario\(")/g) ?? []).length;

  assert.ok(scenarioLikeEntries >= 50, `expected at least 50 LLM scenarios, found ${scenarioLikeEntries}`);
  for (const category of ["technical", "background", "followup", "candidate_error", "no_answer", "coding", "coding_followup", "adversarial_spanish", "coding_contract", "coderpad_baseline", "executable_code", "executable_code_stretch"]) {
    assert.match(runner, new RegExp(`category:\\s*"${category}"|category:\\s*options\\.category\\s*\\|\\|\\s*"${category}"`));
  }
  assert.match(runner, /--category/);
  assert.match(runner, /--scenario/);
  assert.match(runner, /--limit/);
  assert.match(runner, /--dry-run/);
  assert.match(runner, /forbiddenTermsAbsent/);
  assert.match(runner, /expectedResponseType/);
  assert.match(runner, /codingPatchExpected/);
  assert.match(runner, /codingInlineComments/);
  assert.match(runner, /runPythonAssertions/);
  assert.match(runner, /codingExecutableAssertions/);
  assert.match(runner, /coderpad_dirty_ocr_two_sum_console/);
  assert.match(runner, /executable_valid_parentheses/);
  assert.match(runner, /executable_two_sum/);
  assert.match(runner, /executable_rotate_matrix/);
  assert.match(runner, /executable_lru_cache/);
  assert.match(runner, /executable_dijkstra_shortest_path/);
  assert.match(runner, /expectedFunctionName/);
  assert.match(runner, /codingExpectedFunctionName/);
  assert.match(pkg, /verify:llm-executable-code/);
  assert.match(runner, /buildScenarioObservability/);
  assert.match(runner, /observabilitySummary/);
  assert.match(runner, /answeredQuestion/);
  assert.match(runner, /contextUsed/);
  assert.match(runner, /contextIgnored/);
  assert.match(runner, /executableOk/);
  assert.match(runner, /buildLiveCodingFollowUpPrompt/);
  assert.match(runner, /liveSpokenOutput/);
  assert.match(runner, /scenario\.mode === "live_coding" \? true : !liveSpokenOutput/);
});

test("acceptance: CoderPad multi-turn E2E validates executable code per turn", () => {
  const runner = read("tests/e2e/runner/sessionRunner.ts");
  const pkg = read("package.json");

  assert.match(runner, /coderpad_longest_substring_multiturn/);
  assert.match(runner, /coderpad_two_sum_reset_flow/);
  assert.match(runner, /coderpad_rotate_matrix_after_reset/);
  assert.match(runner, /real-coding-reset-flow/);
  assert.match(runner, /clickButtonByText\(client,\s*"New exercise"\)/);
  assert.match(runner, /expected_function:\s*"length_of_longest_substring"/);
  assert.match(runner, /expectedPythonFunctionName/);
  assert.match(runner, /definesExpectedPythonFunction/);
  assert.match(runner, /extractPythonCode\(answer\.answerText,\s*expectedPythonFunctionName\(scenario\)\)/);
  assert.match(runner, /runPythonAssertions\(code,\s*assertions\)/);
  assert.match(runner, /current.*tuple|return both the length and one substring/s);
  assert.match(pkg, /test:e2e:coderpad-multiturn/);
  assert.match(pkg, /test:e2e:coderpad-reset-flow/);
});

test("acceptance: live coding replay E2E drives screenshot answer and follow-up through IPC", () => {
  const runner = read("tests/e2e/live-coding/liveCodingReplay.ts");
  const pkg = read("package.json");

  assert.match(pkg, /test:e2e:live-coding-replay/);
  assert.match(pkg, /test:e2e:live-coding-replay:real/);
  assert.match(runner, /ReplayCase/);
  assert.match(runner, /--corpus/);
  assert.match(runner, /startSession/);
  assert.match(runner, /publishScreenContext/);
  assert.match(runner, /requestAnswer/);
  assert.match(runner, /recognizeScreenText/);
  assert.match(runner, /ocr_ms/);
  assert.match(runner, /vision_ms/);
  assert.match(runner, /traceSummary/);
  assert.match(runner, /codingPayload/);
  assert.match(runner, /PreservedVisibleFunction/);
  assert.match(runner, /raw_model_output_available:\s*"after_session_trace"/);
  assert.match(runner, /rawModelOutputs/);
  assert.match(runner, /parsed_output/);
  assert.match(runner, /final_rendered_output/);
});

test("acceptance: CoderPad staged replay keeps one live coding session across screenshots", () => {
  const runner = read("tests/e2e/live-coding/liveCodingReplay.ts");
  const pkg = read("package.json");
  const scenario = read("tests/fixtures/coderpad/string_normalize_username_followup_input/scenario.json");
  const stage0Expected = read("tests/fixtures/coderpad/string_normalize_username_followup_input/stage_00_initial/expected.json");
  const stage1Expected = read("tests/fixtures/coderpad/string_normalize_username_followup_input/stage_01_collapse_spaces/expected.json");
  const stage2Expected = read("tests/fixtures/coderpad/string_normalize_username_followup_input/stage_02_tests/expected.json");
  const transcriptOnlyScenario = read("tests/fixtures/coderpad/word_frequency_conversation_first/scenario.json");
  const transcriptOnlyExpected = read("tests/fixtures/coderpad/word_frequency_conversation_first/stage_00_transcript_only/expected.json");
  const sortingExpected = read("tests/fixtures/coderpad/word_frequency_conversation_first/stage_02_sorting_followup/expected.json");

  assert.match(pkg, /test:e2e:live-coding-replay:normalize-name/);
  assert.match(pkg, /test:e2e:live-coding-replay:word-frequency/);
  assert.match(runner, /--scenario-file/);
  assert.match(runner, /readStageScenario/);
  assert.match(runner, /runStageScenarioLoop/);
  assert.match(runner, /publishTranscriptDelta/);
  assert.match(runner, /transcriptPrompt/);
  assert.match(runner, /validateScenarioStageAnswer/);
  assert.match(runner, /mustContainAny/);
  assert.match(runner, /mustPreserve/);
  assert.match(runner, /conversationAssistText/);
  assert.match(runner, /onAnswerDetailChunk/);
  assert.match(runner, /conversation_assist/);
  assert.match(runner, /codingWorkspace/);
  assert.match(runner, /mustContainGroups/);
  assert.match(runner, /There is no current screenshot for this stage/);
  assert.match(runner, /sameSessionAsPreviousStage:\s*true/);
  assert.match(runner, /Screenshot not found for \$\{stageScenario\.id\}\/\$\{stage\.id\}/);
  assert.match(scenario, /string_normalize_username_followup_input/);
  assert.match(scenario, /stage_00_initial\/coderpad\.png/);
  assert.match(scenario, /stage_01_collapse_spaces\/coderpad\.png/);
  assert.match(scenario, /stage_02_tests\/coderpad\.png/);
  assert.match(stage0Expected, /conversationAssist/);
  assert.match(stage0Expected, /codingWorkspace/);
  assert.match(stage0Expected, /mustContainGroups/);
  assert.match(stage0Expected, /normalize_name/);
  assert.match(stage0Expected, /limpio/);
  assert.match(stage1Expected, /conversationAssist/);
  assert.match(stage1Expected, /codingWorkspace/);
  assert.match(stage1Expected, /split/);
  assert.match(stage1Expected, /join/);
  assert.match(stage2Expected, /conversationAssist/);
  assert.match(stage2Expected, /codingWorkspace/);
  assert.match(stage2Expected, /assert normalize_name/);
  assert.match(transcriptOnlyScenario, /word_frequency_conversation_first/);
  assert.match(transcriptOnlyScenario, /"image": null/);
  assert.match(transcriptOnlyScenario, /"code": null/);
  assert.match(transcriptOnlyExpected, /mustContainAny/);
  assert.match(transcriptOnlyExpected, /conversationAssist/);
  assert.match(transcriptOnlyExpected, /codingWorkspace/);
  assert.match(transcriptOnlyExpected, /count_words/);
  assert.match(sortingExpected, /conversationAssist/);
  assert.match(sortingExpected, /codingWorkspace/);
  assert.match(sortingExpected, /mustContainGroups/);
  assert.match(sortingExpected, /sortedWordFrequency/);
});

test("acceptance: extreme event dedup replay fixture declares panel-specific answer actions", () => {
  const runner = read("tests/e2e/live-coding/liveCodingReplay.ts");
  const scenario = read("tests/fixtures/coderpad/event_dedup_windowed_metrics_followups/scenario.json");
  const manifest = read("tests/fixtures/coderpad/event_dedup_windowed_metrics_followups/screenshot_manifest.json");
  const readme = read("tests/fixtures/coderpad/event_dedup_windowed_metrics_followups/README.md");
  const stage0Expected = read("tests/fixtures/coderpad/event_dedup_windowed_metrics_followups/stage_00_transcript_only/expected.json");
  const stage5Expected = read("tests/fixtures/coderpad/event_dedup_windowed_metrics_followups/stage_05_window_bug/expected.json");
  const stage7Expected = read("tests/fixtures/coderpad/event_dedup_windowed_metrics_followups/stage_07_tests_and_deque/expected.json");

  assert.match(runner, /answerAction\?:\s*"chat"\s*\|\s*"coding"\s*\|\s*"both"/);
  assert.match(runner, /answer_action:/);
  assert.match(scenario, /event_dedup_windowed_metrics_followups/);
  assert.match(scenario, /"difficulty":\s*"hard"/);
  assert.match(scenario, /"answerAction":\s*"chat"/);
  assert.match(scenario, /"answerAction":\s*"coding"/);
  assert.match(scenario, /"answerAction":\s*"both"/);
  assert.match(scenario, /"image":\s*null/);
  assert.match(scenario, /stage_07_tests_and_deque\/coderpad\.png/);
  assert.match(manifest, /stage_02_duplicate_semantics_chat\/coderpad\.png/);
  assert.match(manifest, /stage_07_tests_and_deque\/capture_instructions\.md/);
  assert.match(readme, /Do not create blank or artificial PNGs/);
  assert.match(stage0Expected, /conversationAssist/);
  assert.match(stage0Expected, /codingWorkspace/);
  assert.match(stage0Expected, /No debe implementar todavia ventana temporal/);
  assert.match(stage5Expected, /seen_ids\.discard|seen_ids\.remove/);
  assert.match(stage5Expected, /stale/);
  assert.match(stage7Expected, /from collections import deque/);
  assert.match(stage7Expected, /usesDequeWindow/);
});

test("acceptance: priority scheduler extreme replay fixture declares multi-screenshot stages", () => {
  const runner = read("tests/e2e/live-coding/liveCodingReplay.ts");
  const scenario = read("tests/fixtures/coderpad/priority_dependency_task_scheduler_extreme/scenario.json");
  const manifest = read("tests/fixtures/coderpad/priority_dependency_task_scheduler_extreme/screenshot_manifest.json");
  const readme = read("tests/fixtures/coderpad/priority_dependency_task_scheduler_extreme/README.md");
  const stage7Expected = read("tests/fixtures/coderpad/priority_dependency_task_scheduler_extreme/stage_07_long_blocked_classification/expected.json");
  const stage8Expected = read("tests/fixtures/coderpad/priority_dependency_task_scheduler_extreme/stage_08_heap_optimization/expected.json");
  const stage9Expected = read("tests/fixtures/coderpad/priority_dependency_task_scheduler_extreme/stage_09_final_tests/expected.json");

  assert.match(runner, /images\?:\s*string\[\]/);
  assert.match(runner, /imagePaths:\s*string\[\]/);
  assert.match(runner, /resolveStageScreenText/);
  assert.match(runner, /screenshotCount/);
  assert.match(scenario, /priority_dependency_task_scheduler_extreme/);
  assert.match(scenario, /"difficulty":\s*"extreme"/);
  assert.match(scenario, /"answerAction":\s*"chat"/);
  assert.match(scenario, /"answerAction":\s*"coding"/);
  assert.match(scenario, /"answerAction":\s*"both"/);
  assert.match(scenario, /"images":\s*\[/);
  assert.match(scenario, /coderpad_top\.png/);
  assert.match(scenario, /coderpad_middle\.png/);
  assert.match(scenario, /coderpad_bottom\.png/);
  assert.match(manifest, /accumulateWithOtherImagesInStage/);
  assert.match(readme, /top\/middle\/bottom/);
  assert.match(stage7Expected, /integratesAllCurrentScreenshots/);
  assert.match(stage7Expected, /missing_dependency/);
  assert.match(stage8Expected, /heapq\.heappush/);
  assert.match(stage8Expected, /usesIndegree/);
  assert.match(stage9Expected, /testsCycle/);
  assert.match(stage9Expected, /pythonAssertions/);
});

test("acceptance: live coding controls separate exercise reset from full session reset", () => {
  const app = read("src/main.tsx");
  const overlay = read("src/overlay/OverlayApp.tsx");
  const codingOverlay = read("src/overlay/CodingOverlayApp.tsx");
  const desktopTypes = read("src/desktop.d.ts");
  const electronMain = read("electron/main.cjs");
  const resetExerciseStart = app.indexOf("const resetLiveCodingExercise");
  const resetExerciseEnd = app.indexOf("const resetFullSession", resetExerciseStart);
  const resetExerciseBody = app.slice(resetExerciseStart, resetExerciseEnd);
  const resetFullStart = app.indexOf("const resetFullSession");
  const dispatchResetStart = app.indexOf("const dispatchResetCommand", resetFullStart);
  const dispatchResetEnd = app.indexOf("const handleFinalTranscript", dispatchResetStart);
  const dispatchResetBody = app.slice(dispatchResetStart, dispatchResetEnd);
  const resetFullEnd = app.indexOf("const dispatchResetCommand", resetFullStart);
  const resetFullBody = app.slice(resetFullStart, resetFullEnd);

  assert.ok(resetExerciseStart > 0, "New exercise reset helper must exist");
  assert.ok(resetFullStart > 0, "New session reset helper must exist");
  assert.ok(dispatchResetStart > 0, "Reset buttons must dispatch through the shared remote command path");
  assert.match(resetExerciseBody, /setCurrentCodingPayload\(null\)/);
  assert.doesNotMatch(resetExerciseBody, /setResumeText\(""\)/);
  assert.doesNotMatch(resetExerciseBody, /setJobDescription\(""\)/);
  assert.match(resetFullBody, /resetSessionRuntimeContext\(\)/);
  assert.match(resetFullBody, /setResumeText\(""\)/);
  assert.match(resetFullBody, /setJobDescription\(""\)/);
  assert.match(dispatchResetBody, /dispatchRemoteControlCommand\?\.\(\{ type \}\)/);
  assert.match(dispatchResetBody, /resetLiveCodingExercise\(\)/);
  assert.match(dispatchResetBody, /resetFullSession\(\)/);
  assert.match(app, />\s*New exercise\s*</);
  assert.match(app, />\s*New session\s*</);
  assert.match(overlay, /command\.type === "reset_session" \|\| command\.type === "reset_exercise"/);
  assert.match(overlay, /setMessages\(\[\]\)/);
  assert.match(overlay, /assistantIdByRequest\.current = \{\}/);
  assert.match(codingOverlay, /command\.type === "reset_session" \|\| command\.type === "reset_exercise"/);
  assert.match(codingOverlay, /setPayload\(emptyCodingAnswer\)/);
  assert.match(codingOverlay, /setScreenshotCount\(0\)/);
  assert.match(electronMain, /data-action="answer_code"/);
  assert.match(electronMain, /button-answer/);
  assert.match(electronMain, /button-answer-code/);
  assert.match(electronMain, /button-screenshot/);
  assert.match(electronMain, /button-reset/);
  assert.match(electronMain, /"answer_code"/);
  assert.match(desktopTypes, /"answer_code"/);
  assert.match(app, /command\.type === "answer_code"/);
  assert.match(app, /void ask\(prompt, "coding", "live_coding"\)/);
});

test("acceptance: live coding screenshots accumulate before Answer code", () => {
  const app = read("src/main.tsx");
  const codingOverlay = read("src/overlay/CodingOverlayApp.tsx");
  const styles = read("src/styles.css");

  assert.match(app, /type LiveCodingScreenCapture/);
  assert.match(app, /mergeScreenTextWithOverlap/);
  assert.match(app, /Combined live coding screenshots: \$\{captures\.length\} ready/);
  assert.match(app, /payload\.source === "coding_overlay"/);
  assert.match(app, /liveCodingScreenCapturesRef\.current = captures\.map/);
  assert.match(app, /formatLiveCodingScreenCaptures\(liveCodingScreenCapturesRef\.current\)/);
  assert.match(app, /const screenBudget = activeMode === "live_coding" \? 6000 : 1800/);
  assert.match(app, /screen\.slice\(-screenBudget\)/);
  assert.match(codingOverlay, /const \[screenshotCount, setScreenshotCount\]/);
  assert.match(codingOverlay, /setScreenshotCount\(\(current\) => Math\.min\(5, current \+ 1\)\)/);
  assert.match(codingOverlay, /Screenshots ready for Answer code/);
  assert.match(codingOverlay, /OCR failed; trying vision/);
  assert.match(codingOverlay, /skipOcr: true/);
  assert.match(codingOverlay, /Vision fallback:/);
  assert.match(codingOverlay, /cp-service-chip/);
  assert.match(codingOverlay, /Still reading screenshot/);
  assert.match(codingOverlay, /May be stuck; recapture if needed/);
  assert.match(codingOverlay, /cp-capture-count/);
  assert.match(styles, /\.cp-coding__actions \.cp-capture-count/);
  assert.match(styles, /\.cp-coding__actions \.cp-capture-count\.ready/);
});

test("acceptance: overlays expose user-readable service readiness and stuck states", () => {
  const overlay = read("src/overlay/OverlayApp.tsx");
  const codingOverlay = read("src/overlay/CodingOverlayApp.tsx");
  const styles = read("src/styles.css");

  assert.match(overlay, /Audio/);
  assert.match(overlay, /Answer/);
  assert.match(overlay, /Still working/);
  assert.match(overlay, /May be stuck; Stop is safe/);
  assert.match(codingOverlay, /Image/);
  assert.match(codingOverlay, /Answer/);
  assert.match(codingOverlay, /Ready for Answer code/);
  assert.match(styles, /\.cp-service-strip/);
  assert.match(styles, /\.cp-service-chip--working/);
  assert.match(styles, /\.cp-service-chip--ready/);
  assert.match(styles, /\.cp-service-chip--warn/);
  assert.match(styles, /\.cp-service-chip--error/);
});

test("acceptance: desktop OCR is bounded and traceable", () => {
  const electronMain = read("electron/main.cjs");

  assert.match(electronMain, /OCR_RECOGNIZE_TIMEOUT_MS/);
  assert.match(electronMain, /OCR_BEST_EFFORT_BUDGET_MS/);
  assert.match(electronMain, /screen_ocr_started/);
  assert.match(electronMain, /ocr_recognize_timeout/);
  assert.match(electronMain, /empty_image_file/);
  assert.match(electronMain, /empty_screen_capture/);
  assert.match(electronMain, /resetOcrWorker/);
});

test("acceptance: Electron stress runner covers real hang classes", () => {
  const pkg = JSON.parse(read("package.json"));
  const stress = read("tests/e2e/stress/electronStress.cjs");

  assert.match(pkg.scripts["test:e2e:stress"], /tests\/e2e\/stress\/electronStress\.cjs/);
  assert.match(stress, /empty_image_file/);
  assert.match(stress, /parallel transcript plus OCR plus answer stays bounded/);
  assert.match(stress, /every OCR start has an OCR completion/);
  assert.match(stress, /no OCR operation exceeds bounded budget/);
  assert.match(stress, /answer path remains in live_coding mode/);
  assert.match(stress, /structured answer reaches renderer event bridge/);
});

test("acceptance: session start clears stale live transcription streams", () => {
  const app = read("src/main.tsx");
  const startSessionStart = app.indexOf("const startSession = React.useCallback");
  const startSessionEnd = app.indexOf("const stopMicRecording", startSessionStart);
  const startSessionBody = app.slice(startSessionStart, startSessionEnd);
  const toggleStart = app.indexOf("const toggleDictation = async");
  const toggleEnd = app.indexOf("const startSession = React.useCallback", toggleStart);
  const toggleBody = app.slice(toggleStart, toggleEnd);

  assert.ok(startSessionStart > 0, "startSession helper must exist");
  assert.match(startSessionBody, /stopLiveRecording\(\)[\s\S]*resetSessionRuntimeContext\(\)/);
  assert.ok(
    startSessionBody.indexOf("window.callpilotDesktop.startSession") < startSessionBody.indexOf("await toggleDictation(true)"),
    "session trace must open before live transcription starts so STT startup failures are observable",
  );
  assert.match(toggleBody, /if\s*\(forceStart\)\s*{\s*stopLiveRecording\(\);/);
  assert.match(toggleBody, /live_transcription_start_requested/);
  assert.match(toggleBody, /provider:\s*liveTranscriptionProvider/);
  assert.match(toggleBody, /audioSource:\s*liveAudioSource/);
  assert.match(app, /local_stt_started/);
  assert.match(app, /local_stt_blob_received/);
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
