import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MODES,
  DEFAULT_APP_SETTINGS,
  DEFAULT_TRANSCRIPTION_MODEL,
  TranscriptBuffer,
  buildOllamaChatRequest,
  buildRealtimeTranscriptionSessionUpdate,
  buildOpenAIImageAnalysisRequest,
  buildOpenAICompatibleChatRequest,
  buildOpenAIResponsesRequest,
  buildPrompt,
  classifyScreenText,
  createLatencyMetricRun,
  createSessionSnapshot,
  createGlobalContext,
  defaultStealthState,
  detectQuestionIntent,
  cleanOcrText,
  extractOllamaModels,
  extractOllamaResponseText,
  extractOpenAICompatibleChatText,
  extractOpenAIResponseText,
  extractOpenAITranscriptionText,
  formatStructuredAnswerPayload,
  formatConversationWindow,
  assessPartialTurnStability,
  isSupportedAudioMimeType,
  liveTranscriptionPlan,
  mergeAppSettings,
  markLatencyStage,
  normalizeOllamaBaseUrl,
  normalizeOcrLanguage,
  normalizeLiveTranscriptionSettings,
  normalizeTranscriptionModelName,
  ocrConfidenceLabel,
  pickEvidence,
  pickEvidenceWithEmbeddings,
  parseSessionJson,
  parseStructuredAnswerPayload,
  reduceStealthState,
  resetStealthState,
  serializeSession,
  shouldAutoAnswer,
  shouldDropCandidateEcho,
  speechSimilarity,
  upsertSession,
  validateAudioTranscriptionInput,
} from "../core/index.ts";

test("fixed modes are available", () => {
  assert.deepEqual(MODES.map((mode) => mode.id), ["live_coding", "system_design", "behavioral", "technical_qa", "meeting_notes"]);
});

test("context defaults to live coding and Python", () => {
  const context = createGlobalContext();
  assert.equal(context.activeMode, "live_coding");
  assert.equal(context.codingLanguagePreference, "Python");
  assert.doesNotThrow(() => JSON.stringify(context));
});

test("latency metrics record elapsed stages", () => {
  const run = createLatencyMetricRun("answer", 1000);
  const marked = markLatencyStage(run, "first_token", 1250);

  assert.equal(marked.id, run.id);
  assert.equal(marked.events[0].stage, "first_token");
  assert.equal(marked.events[0].elapsedMs, 250);
});

test("prompt builder emits debug metadata", () => {
  const buffer = new TranscriptBuffer();
  buffer.append("Can you solve Two Sum?");
  const context = createGlobalContext({
    transcript: buffer.snapshot(),
    screenContext: classifyScreenText("Two Sum\nExample 1:\nInput: nums=[2,7]\nOutput: 9\nConstraints:\n2 <= nums.length"),
  });
  const prompt = buildPrompt(context, "Give me the approach");
  assert.equal(prompt.debug.modeId, "live_coding");
  assert.ok(prompt.debug.includedSections.includes("transcript"));
  assert.ok(prompt.user.includes("<screen_context>"));
});

test("prompt builder grounds interview answers in resume, STAR stories, and job description", () => {
  const context = createGlobalContext({
    activeMode: "behavioral",
    companyName: "Ebury",
    roleTitle: "Backend Engineer",
    resumeText: "Built settlement reporting APIs with PostgreSQL and Python.",
    starStories: "STAR: Chose SQL for financial reconciliation because consistency, auditability, and joins mattered more than flexible documents. Result: faster month-end close.",
    jobDescription: "Requires payments experience, SQL, distributed systems, and pragmatic tradeoff communication.",
  });
  const prompt = buildPrompt(context, "Why did you use SQL instead of NoSQL?");
  assert.ok(prompt.debug.includedSections.includes("resume"));
  assert.ok(prompt.debug.includedSections.includes("star_stories"));
  assert.ok(prompt.debug.includedSections.includes("job_description"));
  assert.ok(prompt.debug.includedSections.includes("selected_evidence"));
  assert.ok(prompt.debug.selectedEvidence.some((item) => item.source === "star_stories"));
  assert.ok(prompt.system.includes("Ground every interview answer"));
  assert.ok(prompt.user.includes("<company_name>\nEbury"));
  assert.ok(prompt.user.includes("<selected_evidence>"));
});

test("evidence picker selects STAR tradeoff evidence for SQL vs NoSQL questions", () => {
  const context = createGlobalContext({
    companyName: "Ebury",
    roleTitle: "Backend Engineer",
    resumeText: "Built backend services with TypeScript, Python, Redis, and PostgreSQL for operational reporting.",
    starStories: [
      "STAR: During a financial reconciliation project, I chose PostgreSQL instead of a document database because we needed ACID transactions, joins, auditability, and consistent settlement reports. The result was fewer manual checks and faster month-end close.",
      "STAR: Led an onboarding improvement project and reduced setup time for new engineers.",
    ].join("\n\n"),
    jobDescription: "Ebury role: payments, FX, SQL, distributed systems, ownership, and pragmatic tradeoff communication.",
  });
  const selection = pickEvidence(context, "Why did you choose SQL instead of NoSQL?");
  assert.equal(selection.items[0]?.source, "star_stories");
  assert.match(selection.items[0]?.text ?? "", /PostgreSQL|ACID|auditability|settlement/i);
  assert.ok(selection.items[0]?.matchedTerms.includes("sql"));
});

test("embedding evidence picker ranks semantic matches", async () => {
  const context = createGlobalContext({
    resumeText: "Built a payments reconciliation service with ledger audits.",
    starStories: "Mentored two engineers through a stakeholder conflict.",
  });
  const embedder = async (texts: string[]) => texts.map((text) => ({
    text,
    vector: /payments|ledger|reconciliation|financial/i.test(text) ? [1, 0] : [0, 1],
  }));

  const selection = await pickEvidenceWithEmbeddings(context, "How did you handle financial consistency?", embedder, 1);

  assert.equal(selection.debug.strategy, "embedding");
  assert.equal(selection.items[0]?.source, "resume");
});

test("mode contracts include expected sections", () => {
  const liveCoding = MODES.find((mode) => mode.id === "live_coding");
  const systemDesign = MODES.find((mode) => mode.id === "system_design");
  const behavioral = MODES.find((mode) => mode.id === "behavioral");
  assert.ok(liveCoding?.defaultOutputFormat.includes("Complexity"));
  assert.ok(systemDesign?.defaultOutputFormat.includes("Data flow"));
  assert.ok(behavioral?.defaultOutputFormat.includes("STAR version"));
});

test("transcript pause excludes new lines", () => {
  const buffer = new TranscriptBuffer();
  buffer.append("one", "manual", 1000, "interviewer");
  buffer.pause();
  buffer.append("two", "stt", 2000, "candidate");
  assert.deepEqual(buffer.snapshot().messages.map((message) => message.text), ["one"]);
  assert.equal(buffer.snapshot().messages[0]?.speaker, "interviewer");
});

test("transcript compaction respects tiny budgets", () => {
  const buffer = new TranscriptBuffer();
  buffer.append("This is a long transcript entry that should not fit into a tiny budget.", "manual", 1000, "interviewer");
  assert.equal(buffer.compact(10), "");
});

test("transcript compaction includes conversation participants", () => {
  const buffer = new TranscriptBuffer();
  buffer.append("Do you prefer SQL or NoSQL?", "stt", 1000, "interviewer");
  buffer.append("SQL.", "stt", 2000, "candidate");
  buffer.append("Use a STAR story about consistency and reporting.", "manual", 3000, "assistant");

  const compacted = buffer.compact(1000);
  assert.match(compacted, /interviewer: Do you prefer SQL or NoSQL\?/);
  assert.match(compacted, /candidate: SQL\./);
  assert.match(compacted, /assistant: Use a STAR story/);
});

test("conversation window preserves interviewer and candidate roles", () => {
  const buffer = new TranscriptBuffer();
  buffer.append("What is SQL?", "stt", 1000, "interviewer");
  buffer.append("It is a programming language for apps.", "stt", 2000, "candidate");
  buffer.append("Why would you describe it that way?", "stt", 3000, "interviewer");

  const conversation = formatConversationWindow(buffer.snapshot(), "Can you clarify?");

  assert.match(conversation, /^interviewer: What is SQL\?/);
  assert.match(conversation, /candidate: It is a programming language for apps\./);
  assert.match(conversation, /interviewer: Why would you describe it that way\?/);
  assert.match(conversation, /interviewer_partial: Can you clarify\?/);
});

test("prompt instructs model to correct candidate answers using role-prefixed conversation", () => {
  const prompt = buildPrompt(
    createGlobalContext(),
    "interviewer: What is SQL?\ncandidate: It is a programming language for apps.\ninterviewer: Why?",
  );

  assert.match(prompt.system, /candidate as the user/i);
  assert.match(prompt.system, /technically wrong/i);
  assert.match(prompt.user, /candidate: It is a programming language/);
});

test("prompt tells model not to answer stale topics or non-questions", () => {
  const prompt = buildPrompt(
    createGlobalContext(),
    "interviewer: Bueno, ya no se cuantas personas hay aqui.",
  );

  assert.match(prompt.system, /latest interviewer turn is not a question/i);
  assert.match(prompt.system, /Do not answer stale topics/i);
  assert.match(prompt.system, /do not invent a technical answer/i);
  assert.match(prompt.system, /at most two compact/i);
});

test("prompt excludes previous assistant suggestions from factual transcript", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("What is SQL?", "stt", 1000, "interviewer");
  transcript.append("SQL is a relational query language.", "manual", 2000, "assistant");
  transcript.append("Can you expand?", "stt", 3000, "interviewer");
  const prompt = buildPrompt(
    createGlobalContext({ activeMode: "technical_qa", transcript: transcript.snapshot() }),
    "interviewer: Can you expand?",
  );

  assert.match(prompt.user, /interviewer: What is SQL\?/);
  assert.match(prompt.user, /interviewer: Can you expand\?/);
  assert.doesNotMatch(prompt.user, /assistant: SQL is a relational query language/);
});

test("live conversation detects interview questions in English and Spanish", () => {
  const english = detectQuestionIntent("Can you walk me through why you chose SQL instead of NoSQL?", "english");
  const spanish = detectQuestionIntent("Podrias explicar por que elegiste SQL en ese proyecto?", "spanish");
  const shortSpanish = detectQuestionIntent("¿Qué es SQL?", "spanish");
  const shortEnglish = detectQuestionIntent("What is SQL?", "english");
  const partialSpanish = detectQuestionIntent("Que es S", "spanish");
  const filler = detectQuestionIntent("ok thanks", "auto");
  const implicit = detectQuestionIntent("me interesaria que me cuentes tu approach aca", "spanish");

  assert.equal(english.shouldAnswer, true);
  assert.equal(spanish.shouldAnswer, true);
  assert.equal(shortSpanish.shouldDispatch, true);
  assert.equal(shortEnglish.shouldDispatch, true);
  assert.equal(partialSpanish.shouldDispatch, true);
  assert.equal(assessPartialTurnStability("Que es S", "Que es S", 1000, 2200).stable, false);
  assert.equal(filler.shouldAnswer, false);
  assert.equal(implicit.shouldDispatch, true);
});

test("partial turn stability requires unchanged non-truncated text", () => {
  assert.deepEqual(
    assessPartialTurnStability("Que es SQL exactamente", "Que es SQL exactamente", 1000, 2200),
    { stable: true, reason: "stable_partial" },
  );
  assert.equal(assessPartialTurnStability("Que es S", "Que es S", 1000, 2200).reason, "truncated_definition");
  assert.equal(assessPartialTurnStability("Que es SQL exactamente", "Que es SQ", 1000, 2200).reason, "changed_recently");
  assert.equal(assessPartialTurnStability("Que es SQL exactamente", "Que es SQL exactamente", 1000, 1200).reason, "changed_recently");
});

test("structured interview answers parse and render compactly", () => {
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      spokenAnswer: "SQL is a declarative language for relational data.",
      keyPoints: ["ACID", "joins"],
      correction: { needed: true, transition: "I would clarify that SQL is not a general-purpose app language.", correctedClaim: "SQL is domain-specific." },
      assumptions: [],
      evidenceRefs: ["resume:1"],
      followUpHint: null,
    },
  }));

  assert.equal(structured?.kind, "interview");
  assert.match(structured ? formatStructuredAnswerPayload(structured) : "", /\*\*Respuesta:\*\*/);
  assert.match(structured ? formatStructuredAnswerPayload(structured) : "", /SQL is a declarative/);
});

test("structured coding answers parse and render code block", () => {
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "coding",
    payload: {
      version: "1",
      answerNeeded: true,
      responseType: "initial_solution",
      problem: { title: "Two Sum", summary: "Find two indices", language: "Python", functionSignature: null, constraints: [] },
      solution: {
        approachSteps: ["Use a hash map."],
        code: "def two_sum(nums, target):\n    return []",
        complexity: { time: "O(n)", space: "O(n)", rationale: "One pass." },
        edgeCases: ["duplicates"],
        invariants: [],
      },
      narration: { spokenAnswer: "I will trade memory for one-pass lookup.", currentStep: "Implement hashmap." },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  const rendered = structured ? formatStructuredAnswerPayload(structured) : "";
  assert.equal(structured?.kind, "coding");
  assert.match(rendered, /```python/);
  assert.match(rendered, /O\(n\)/);
});

test("structured answer parser repairs small missing closing braces", () => {
  const structured = parseStructuredAnswerPayload(
    '{"kind":"interview","payload":{"version":"1","answerNeeded":true,"intent":"technical_qa","spokenAnswer":"Short answer","keyPoints":[],"correction":{"needed":false,"transition":null,"correctedClaim":null},"assumptions":[],"evidenceRefs":[],"followUpHint":null}',
  );

  assert.equal(structured?.kind, "interview");
  assert.match(structured ? formatStructuredAnswerPayload(structured) : "", /Short answer/);
});

test("structured renderer removes duplicated model labels", () => {
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      spokenAnswer: "**Respuesta:** SQL is declarative.",
      keyPoints: [],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
    },
  }));
  const rendered = structured ? formatStructuredAnswerPayload(structured) : "";

  assert.equal((rendered.match(/\*\*Respuesta:\*\*/g) ?? []).length, 1);
  assert.doesNotMatch(rendered, /\*\*Respuesta:\*\*\s+\*\*Respuesta:\*\*/);
});

test("live conversation auto answer respects cooldown", () => {
  const detection = detectQuestionIntent("What tradeoffs did you consider?");

  assert.equal(shouldAutoAnswer(detection, 20_000, 0), true);
  assert.equal(shouldAutoAnswer(detection, 25_000, 20_000), false);
});

test("live conversation drops microphone echo from recent interviewer audio", () => {
  const recent = [
    {
      speaker: "interviewer" as const,
      text: "Can you explain why you prefer SQL instead of NoSQL for this project?",
      timestamp: 10_000,
    },
  ];

  assert.ok(speechSimilarity(
    "could you explain why you prefer sql instead of no sql for the project",
    recent[0].text,
  ) > 0.72);
  assert.equal(shouldDropCandidateEcho("Can you explain why you prefer SQL instead of NoSQL for this project?", recent, 12_000), true);
  assert.equal(shouldDropCandidateEcho("SQL", recent, 12_000), false);
  assert.equal(shouldDropCandidateEcho("I chose SQL because consistency mattered for financial reporting.", recent, 12_000), false);
});

test("screen classifier recognizes common V0 inputs", () => {
  assert.equal(classifyScreenText("Example 1:\nInput: nums\nOutput: answer\nConstraints: n > 1").kind, "coding_problem");
  assert.equal(classifyScreenText("main.py\nclass Solution:\n  def solve(self):").kind, "code_editor");
  assert.equal(classifyScreenText("API Reference\nParameters\nReturns").kind, "documentation");
  assert.equal(classifyScreenText("10:30 Alice: Let's ship it\nBob: Action item is the rollout plan").kind, "meeting_transcript");
  assert.equal(classifyScreenText("A quiet paragraph with no technical markers.").kind, "unknown");
});

test("OCR helpers normalize language and clean extracted text", () => {
  assert.equal(normalizeOcrLanguage("spanish"), "spa");
  assert.equal(normalizeOcrLanguage("english"), "eng");
  assert.equal(normalizeOcrLanguage("auto"), "eng+spa");
  assert.equal(cleanOcrText("  Hello   world \r\n\n  SQL   tradeoff  "), "Hello world\nSQL tradeoff");
  assert.equal(ocrConfidenceLabel(90), "high");
  assert.equal(ocrConfidenceLabel(60), "medium");
  assert.equal(ocrConfidenceLabel(20), "low");
});

test("default stealth state is serializable and interactive", () => {
  assert.equal(defaultStealthState.callPrivacyAllowed, false);
  assert.equal(defaultStealthState.overlayVisible, true);
  assert.equal(defaultStealthState.focusMode, "interactive");
  assert.doesNotThrow(() => JSON.stringify(defaultStealthState));
});

test("settings merge keeps defaults and normalizes blanks", () => {
  const settings = mergeAppSettings({
    modelProvider: "ollama",
    modelName: "",
    ollamaBaseUrl: "http://localhost:11434/",
    transcriptionModelName: "gpt-4o-mini-transcribe",
    defaultCodingLanguage: "",
    activeMode: "system_design",
  });
  assert.equal(settings.modelProvider, "ollama");
  assert.equal(settings.modelName, DEFAULT_APP_SETTINGS.modelName);
  assert.equal(settings.ollamaBaseUrl, "http://localhost:11434");
  assert.equal(settings.transcriptionModelName, "gpt-4o-mini-transcribe");
  assert.equal(settings.defaultCodingLanguage, "Python");
  assert.equal(settings.activeMode, "system_design");
  assert.equal(settings.liveTranscriptionProvider, "local");
  assert.equal(settings.liveLatencyPreset, "balanced");
  assert.equal(settings.liveAudioSource, "both");
});

test("settings and sessions accept Natively as an answer provider", () => {
  const settings = mergeAppSettings({ modelProvider: "natively", modelName: "default" });
  const session = createSessionSnapshot({
    activeMode: "technical_qa",
    transcript: new TranscriptBuffer().snapshot(),
    screenText: "",
    notes: "",
    profile: "",
    targetUseCase: "technical interview preparation",
    preferredLanguage: "auto",
    codingLanguage: "Python",
    answerVerbosity: "short",
    modelProvider: "natively",
    modelName: "default",
    question: "",
    answer: "",
  });
  const parsed = parseSessionJson(serializeSession(session));

  assert.equal(settings.modelProvider, "natively");
  assert.equal(parsed?.modelProvider, "natively");
});

test("settings and sessions accept NVIDIA as an OpenAI-compatible answer provider", () => {
  const settings = mergeAppSettings({ modelProvider: "nvidia", modelName: "nvidia-default" });
  const session = createSessionSnapshot({
    activeMode: "technical_qa",
    transcript: new TranscriptBuffer().snapshot(),
    screenText: "",
    notes: "",
    profile: "",
    targetUseCase: "technical interview preparation",
    preferredLanguage: "auto",
    codingLanguage: "Python",
    answerVerbosity: "short",
    modelProvider: "nvidia",
    modelName: "nvidia-default",
    question: "",
    answer: "",
  });
  const parsed = parseSessionJson(serializeSession(session));

  assert.equal(settings.modelProvider, "nvidia");
  assert.equal(parsed?.modelProvider, "nvidia");
});

test("Ollama request helpers build local chat payloads", () => {
  const prompt = buildPrompt(createGlobalContext(), "Why SQL?");
  const request = buildOllamaChatRequest(prompt, "llama3.1");

  assert.equal(normalizeOllamaBaseUrl("http://localhost:11434/"), "http://localhost:11434");
  assert.equal(request.model, "llama3.1");
  assert.equal(request.stream, false);
  assert.equal(request.messages[0]?.role, "system");
  assert.equal(request.messages[1]?.content, prompt.user);
  assert.equal(extractOllamaResponseText({ message: { content: " local answer " } }), "local answer");
  assert.equal(extractOllamaResponseText({ response: "generate answer" }), "generate answer");
});

test("Ollama model list helper extracts installed model names", () => {
  const models = extractOllamaModels({
    models: [
      { name: "llama3.1:8b", modified_at: "2026-07-03T10:00:00Z", size: 123 },
      { model: "qwen2.5-coder:7b" },
      { name: "  " },
    ],
  });

  assert.deepEqual(models.map((model) => model.name), ["llama3.1:8b", "qwen2.5-coder:7b"]);
  assert.equal(models[0]?.modifiedAt, "2026-07-03T10:00:00Z");
  assert.equal(models[0]?.size, 123);
});

test("OpenAI-compatible chat helpers support provider-agnostic LLMs", () => {
  const prompt = buildPrompt(createGlobalContext(), "interviewer: What is SQL?");
  const request = buildOpenAICompatibleChatRequest(prompt, "default");

  assert.equal(request.model, "default");
  assert.equal(request.stream, false);
  assert.equal(request.messages[0]?.role, "system");
  assert.equal(request.messages[1]?.content, prompt.user);
  assert.equal(extractOpenAICompatibleChatText({ choices: [{ message: { content: " answer " } }] }), "answer");
  assert.equal(extractOpenAICompatibleChatText({ text: "plain answer" }), "plain answer");
});

test("live transcription settings expose professional provider plan", () => {
  const settings = normalizeLiveTranscriptionSettings({
    provider: "openai_realtime",
    latencyPreset: "fast",
    audioSource: "both",
    language: "spanish",
    autoAnswerCooldownMs: 1500,
    autoAnswerMinConfidence: 1,
  });
  const plan = liveTranscriptionPlan(settings);
  const sessionUpdate = buildRealtimeTranscriptionSessionUpdate(settings, "Names: Ebury, PostgreSQL");

  assert.equal(settings.autoAnswerCooldownMs, 3000);
  assert.equal(settings.autoAnswerMinConfidence, 0.95);
  assert.equal(settings.audioSource, "both");
  assert.equal(plan.engineLabel, "OpenAI live chunks");
  assert.equal(plan.implemented, true);
  assert.equal(sessionUpdate.session.audio.input.format.rate, 24000);
  assert.equal(sessionUpdate.session.audio.input.transcription.model, "gpt-realtime-whisper");
  assert.equal(sessionUpdate.session.audio.input.transcription.language, "es");
  assert.equal(sessionUpdate.session.audio.input.transcription.delay, "minimal");
});

test("stealth reducer keeps passthrough focus consistent and resets", () => {
  const blocked = reduceStealthState(defaultStealthState, { type: "set_mouse_passthrough", enabled: true });
  assert.equal(blocked.mousePassthroughEnabled, false);
  assert.equal(blocked.focusMode, "interactive");
  const allowed = reduceStealthState(defaultStealthState, { type: "set_call_privacy_allowed", allowed: true });
  const passthrough = reduceStealthState(allowed, { type: "set_focus_mode", focusMode: "passthrough" });
  assert.equal(passthrough.mousePassthroughEnabled, true);
  assert.equal(passthrough.focusMode, "passthrough");
  const interactive = reduceStealthState(passthrough, { type: "set_mouse_passthrough", enabled: false });
  assert.equal(interactive.mousePassthroughEnabled, false);
  assert.equal(interactive.focusMode, "interactive");
  const hidden = reduceStealthState(allowed, { type: "set_overlay_visible", visible: false });
  const revoked = reduceStealthState(hidden, { type: "set_call_privacy_allowed", allowed: false });
  assert.equal(revoked.overlayVisible, true);
  assert.equal(revoked.contentProtectionEnabled, false);
  assert.deepEqual(resetStealthState(), defaultStealthState);
  assert.deepEqual(reduceStealthState(passthrough, { type: "reset" }), defaultStealthState);
});

test("manual scenario fixtures exist", () => {
  const files = readdirSync(join(process.cwd(), "tests", "scenarios")).filter((file) => file.endsWith(".md"));
  assert.deepEqual(files.sort(), [
    "behavioralQuestion.md",
    "leetcodeScreenshot.md",
    "messyTranscript.md",
    "spanishEnglish.md",
    "systemDesignQuestion.md",
    "technicalExplanation.md",
  ]);
});

test("OpenAI Responses request uses instructions and input", () => {
  const prompt = buildPrompt(createGlobalContext(), "Explain queues");
  const request = buildOpenAIResponsesRequest(prompt, "openai-model-under-test");
  assert.equal(request.model, "openai-model-under-test");
  assert.equal(request.instructions, prompt.system);
  assert.equal(request.input, prompt.user);
  assert.equal(request.store, false);
});

test("OpenAI response text extraction supports helper and output array", () => {
  assert.equal(extractOpenAIResponseText({ output_text: "hello" }), "hello");
  assert.equal(
    extractOpenAIResponseText({
      output: [
        { type: "message", content: [{ type: "output_text", text: "one" }, { type: "output_text", text: "two" }] },
      ],
    }),
    "one\ntwo",
  );
});

test("OpenAI image analysis request uses Responses image content", () => {
  const request = buildOpenAIImageAnalysisRequest("data:image/png;base64,abc", "openai-model-under-test");
  assert.equal(request.model, "openai-model-under-test");
  assert.equal(request.store, false);
  const promptText = request.input[0]?.content[0].text ?? "";
  assert.match(promptText, /functionSignature/);
  assert.match(promptText, /What to say out loud/);
  assert.deepEqual(request.input[0]?.content[1], {
    type: "input_image",
    image_url: "data:image/png;base64,abc",
    detail: "low",
  });
});

test("audio transcription helpers validate OpenAI upload constraints", () => {
  assert.equal(DEFAULT_TRANSCRIPTION_MODEL, "gpt-4o-transcribe");
  assert.equal(normalizeTranscriptionModelName("  "), DEFAULT_TRANSCRIPTION_MODEL);
  assert.equal(normalizeTranscriptionModelName("gpt-4o-mini-transcribe"), "gpt-4o-mini-transcribe");
  assert.equal(isSupportedAudioMimeType("audio/webm;codecs=opus"), true);
  assert.equal(isSupportedAudioMimeType("audio/ogg"), false);
  assert.equal(
    validateAudioTranscriptionInput({
      provider: "openai",
      modelName: DEFAULT_TRANSCRIPTION_MODEL,
      fileName: "clip.webm",
      mimeType: "audio/webm",
      byteLength: 1024,
    }),
    undefined,
  );
  assert.equal(
    validateAudioTranscriptionInput({
      provider: "openai",
      fileName: "clip.ogg",
      mimeType: "audio/ogg",
      byteLength: 1024,
    }),
    "unsupported_audio_type",
  );
});

test("OpenAI transcription extraction supports json and text responses", () => {
  assert.equal(extractOpenAITranscriptionText({ text: " hello " }), "hello");
  assert.equal(extractOpenAITranscriptionText(" plain text "), "plain text");
  assert.equal(extractOpenAITranscriptionText({}), "");
});

test("session snapshots serialize without secrets and round trip", () => {
  const context = createGlobalContext();
  const session = createSessionSnapshot({
    activeMode: context.activeMode,
    transcript: context.transcript,
    screenText: "Two Sum",
    notes: "notes",
    profile: "profile",
    targetUseCase: context.targetUseCase,
    preferredLanguage: context.preferredLanguage,
    codingLanguage: context.codingLanguagePreference,
    answerVerbosity: "medium",
    modelProvider: "openai",
    modelName: "openai-model-under-test",
    question: "question",
    answer: "answer",
  }, new Date("2026-07-02T10:00:00.000Z"));
  const serialized = serializeSession(session);
  assert.equal(serialized.includes("apiKey"), false);
  assert.equal(parseSessionJson(serialized)?.title, "question");
});

test("session library upsert replaces by id and sorts by updatedAt", () => {
  const context = createGlobalContext();
  const oldSession = createSessionSnapshot({
    id: "same",
    activeMode: context.activeMode,
    transcript: context.transcript,
    screenText: "",
    notes: "",
    profile: "",
    targetUseCase: context.targetUseCase,
    preferredLanguage: context.preferredLanguage,
    codingLanguage: context.codingLanguagePreference,
    answerVerbosity: "medium",
    modelProvider: "mock",
    modelName: "mock-local",
    question: "old",
    answer: "",
  }, new Date("2026-07-02T10:00:00.000Z"));
  const newSession = { ...oldSession, question: "new", title: "new", updatedAt: "2026-07-02T11:00:00.000Z" };
  const library = upsertSession([oldSession], newSession);
  assert.equal(library.length, 1);
  assert.equal(library[0]?.title, "new");
});
