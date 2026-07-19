import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MODES,
  DEFAULT_APP_SETTINGS,
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_NVIDIA_VISION_MODEL,
  TranscriptBuffer,
  assessAnswerGrounding,
  assessPlainInterviewAnswerGrounding,
  assembleTurn,
  buildOllamaChatRequest,
  appendSegmentChunk,
  buildRealtimeTranscriptionSessionUpdate,
  buildOpenAIImageAnalysisRequest,
  buildOpenAICompatibleChatRequest,
  buildOpenAICompatibleImageAnalysisRequest,
  buildOpenAIResponsesRequest,
  buildPrompt,
  classifyScreenText,
  consumeSegmentChunks,
  createLatencyMetricRun,
  createSessionSnapshot,
  createGlobalContext,
  defaultStealthState,
  createTurnAssemblerState,
  detectQuestionIntent,
  hasTranscriptProgress,
  cleanOcrText,
  extractOllamaModels,
  extractOllamaResponseText,
  extractOpenAICompatibleModels,
  extractOpenAICompatibleChatText,
  extractOpenAIResponseText,
  extractOpenAITranscriptionText,
  extractLatestQuestionFocus,
  formatAnswerForDisplay,
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
  normalizeTechnicalTranscript,
  normalizeTranscriptionModelName,
  ocrConfidenceLabel,
  pickEvidence,
  pickEvidenceWithEmbeddings,
  parseSessionJson,
  parseStructuredAnswerPayload,
  reduceStealthState,
  repairSystemDesignAnswerCoverage,
  resetStealthState,
  serializeSession,
  shouldAutoAnswer,
  shouldDropCandidateEcho,
  shouldDrainTranscriptionQueue,
  shouldSendNativelyFrame,
  speechSimilarity,
  STRUCTURED_ANSWER_PAYLOAD_JSON_SCHEMA,
  transcriptDelta,
  upsertSession,
  validateAudioTranscriptionInput,
  withNoAnswerForUngroundedDrift,
  retryDelayMs,
  shouldRetryProviderFailure,
  withRetry,
  createSseParseState,
  parseSseChunk,
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

test("provider retry policy retries transient failures only", () => {
  assert.deepEqual(
    shouldRetryProviderFailure({ attempt: 1, maxAttempts: 3, status: 429 }),
    { retry: true, reason: "transient_http_429" },
  );
  assert.deepEqual(
    shouldRetryProviderFailure({ attempt: 1, maxAttempts: 3, status: 503 }),
    { retry: true, reason: "transient_http_503" },
  );
  assert.equal(shouldRetryProviderFailure({ attempt: 1, maxAttempts: 3, status: 401, authError: true }).retry, false);
  assert.equal(shouldRetryProviderFailure({ attempt: 1, maxAttempts: 3, validationError: true }).retry, false);
  assert.equal(shouldRetryProviderFailure({ attempt: 3, maxAttempts: 3, status: 500 }).retry, false);
  assert.equal(retryDelayMs(2, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0.2 }, () => 0), 200);
});

test("withRetry backs off and stops when operation succeeds", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];
  const result = await withRetry(
    async (attempt) => {
      attempts.push(attempt);
      return attempt < 3
        ? { ok: false, status: attempt === 1 ? 500 : 429 }
        : { ok: true, status: 200 };
    },
    {
      policy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
      shouldRetryResult: (result, attempt) => shouldRetryProviderFailure({ attempt, maxAttempts: 3, status: result.status }),
      sleep: async (ms) => { delays.push(ms); },
      random: () => 0,
    },
  );

  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(result.ok, true);
});

test("withRetry does not retry cancelled requests", async () => {
  const error = new DOMException("Request cancelled", "AbortError");
  await assert.rejects(
    withRetry(
      async () => { throw error; },
      { sleep: async () => undefined },
    ),
    /cancelled/i,
  );
});

test("live audio segment buffers survive stop until recorder onstop consumes them", () => {
  const chunks = new Map<string, string[]>();
  appendSegmentChunk(chunks, "mic-0", "hello");
  appendSegmentChunk(chunks, "mic-0", "tail");

  assert.deepEqual(chunks.get("mic-0"), ["hello", "tail"]);
  assert.equal(shouldDrainTranscriptionQueue(false, 2), true);
  assert.equal(shouldDrainTranscriptionQueue(false, 0), false);
  assert.deepEqual(consumeSegmentChunks(chunks, "mic-0"), ["hello", "tail"]);
  assert.equal(chunks.has("mic-0"), false);
});

test("Natively frame gate filters mic noise but keeps low system audio", () => {
  const lowEnergy = { rms: 0.0002, peak: 0.003 };
  const speechEnergy = { rms: 0.004, peak: 0.04 };

  assert.equal(shouldSendNativelyFrame("candidate", lowEnergy), false);
  assert.equal(shouldSendNativelyFrame("candidate", speechEnergy), true);
  assert.equal(shouldSendNativelyFrame("interviewer", lowEnergy), true);
});

test("SSE parser handles split JSON events and missing done", () => {
  let state = createSseParseState();
  let parsed = parseSseChunk(state, 'data: {"type":"response.output_text.delta","del');
  assert.equal(parsed.textDelta, "");
  state = parsed.state;
  parsed = parseSseChunk(state, 'ta":"hello"}\n\n');

  assert.equal(parsed.textDelta, "hello");
  assert.equal(parsed.state.done, false);
  assert.equal(parsed.state.malformedCount, 0);
});

test("SSE parser counts malformed events without dropping valid deltas", () => {
  let state = createSseParseState();
  let parsed = parseSseChunk(state, [
    "data: {bad json}",
    "",
    'data: {"type":"response.output_text.delta","delta":"good"}',
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n"));
  state = parsed.state;

  assert.equal(parsed.textDelta, "good");
  assert.equal(state.done, true);
  assert.equal(state.malformedCount, 1);
});

test("SSE parser flushes partial final event when connection closes", () => {
  const state = parseSseChunk(
    createSseParseState(),
    'data: {"type":"response.output_text.delta","delta":"partial"}',
  ).state;
  const parsed = parseSseChunk(state, "", { flush: true });

  assert.equal(parsed.textDelta, "partial");
  assert.equal(parsed.state.done, false);
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
  assert.ok(prompt.system.includes("Use resume, STAR stories"));
  assert.ok(prompt.user.includes("<company_name>\nEbury"));
  assert.ok(prompt.user.includes("<selected_evidence>"));
});

test("prompt builder forbids invented behavioral specifics without evidence", () => {
  const prompt = buildPrompt(
    createGlobalContext({ activeMode: "behavioral", preferredLanguage: "english" }),
    "interviewer: Tell me about a time you handled a production incident.",
  );

  assert.match(prompt.system, /never invent concrete incidents/i);
  assert.match(prompt.system, /user counts, timelines, outages, metrics/i);
  assert.match(prompt.system, /placeholders/i);
});

test("prompt builder clarifies Spanish no-crash live coding requests", () => {
  const prompt = buildPrompt(
    createGlobalContext({ activeMode: "live_coding", preferredLanguage: "spanish" }),
    "interviewer: Ahora maneja el caso en que no hay solucion, sin que explote.",
  );

  assert.match(prompt.system, /sin que explote/i);
  assert.match(prompt.system, /without crashing/i);
  assert.match(prompt.system, /do not intentionally throw/i);
});

test("prompt builder uses English spoken labels for English answers", () => {
  const prompt = buildPrompt(
    createGlobalContext({ activeMode: "live_coding", preferredLanguage: "english" }),
    "user_request: The candidate pressed Answer.",
  );

  assert.match(prompt.system, /\*\*To say:\*\* or \*\*Answer:\*\*/);
  assert.doesNotMatch(prompt.system, /\*\*Para decir:\*\*/);
});

test("prompt builder localizes output format labels for English technical answers", () => {
  const prompt = buildPrompt(
    createGlobalContext({ activeMode: "technical_qa", preferredLanguage: "english" }),
    "interviewer: What is the complexity?",
  );

  assert.match(prompt.user, /<output_format>\s*Answer\nExample or tradeoff only if useful\nTo say/);
  assert.doesNotMatch(prompt.user, /Para decir|Respuesta/);
});

test("prompt builder tells live coding to prefer current screen over stale prior answers", () => {
  const prompt = buildPrompt(
    createGlobalContext({ activeMode: "live_coding", preferredLanguage: "english" }),
    "user_request: The candidate pressed Answer.",
  );

  assert.match(prompt.system, /current screen_context shows a different problem/i);
  assert.match(prompt.system, /refer to the visible function and variables/i);
});

test("prompt builder prioritizes local code issues from fresh live coding transcript", () => {
  const prompt = buildPrompt(
    createGlobalContext({ activeMode: "live_coding", preferredLanguage: "english" }),
    "fresh_mixed_audio_evidence_not_manual_question: the right child lower bound should be node.val plus 1",
  );

  assert.match(prompt.system, /specific variables, bounds, failing tests, exceptions, or code edits/i);
  assert.match(prompt.user, /node\.val plus 1/);
});

test("technical definitions do not force candidate background into the prompt", () => {
  const context = createGlobalContext({
    activeMode: "technical_qa",
    companyName: "Mercado Pago",
    resumeText: "Built payments reconciliation with PostgreSQL.",
    starStories: "STAR: Used SQL for payment audits.",
    jobDescription: "Payments backend role.",
  });
  const prompt = buildPrompt(context, "interviewer: Que es una base de datos relacional?");

  assert.doesNotMatch(prompt.user, /<company_name>/);
  assert.doesNotMatch(prompt.user, /<resume>/);
  assert.doesNotMatch(prompt.user, /Mercado Pago|payments reconciliation|payment audits/i);
});

test("experience follow-ups include candidate background as memory aid", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("Que es SQL?", "stt", 1_000, "interviewer");
  transcript.append("SQL es un lenguaje para consultar bases de datos.", "manual", 2_000, "assistant");
  transcript.append("Y como lo has usado?", "stt", 3_000, "interviewer");
  const context = createGlobalContext({
    activeMode: "technical_qa",
    companyName: "Mercado Pago",
    resumeText: "Used SQL in payment reconciliation pipelines with PostgreSQL.",
    starStories: "STAR: Built auditable SQL reports for transaction mismatches.",
    jobDescription: "Backend role.",
    transcript: transcript.snapshot(),
  });
  const prompt = buildPrompt(context, "interviewer: Y como lo has usado?");

  assert.match(prompt.user, /<resume>[\s\S]*payment reconciliation/i);
  assert.match(prompt.user, /<star_stories>[\s\S]*auditable SQL/i);
  assert.match(prompt.user, /<recent_conversation>[\s\S]*Que es SQL/i);
  assert.match(prompt.user, /<current_question>[\s\S]*Y como lo has usado/i);
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

test("system design mode preserves late constraints and rejects Redis-only shortcuts", () => {
  const systemDesign = MODES.find((mode) => mode.id === "system_design");

  assert.ok(systemDesign);
  assert.match(systemDesign.systemPromptFragment, /late interviewer constraints/i);
  assert.match(systemDesign.systemPromptFragment, /unprovided numeric SLAs/i);
  assert.match(systemDesign.systemPromptFragment, /cover each named item/i);
  assert.match(systemDesign.systemPromptFragment, /final architecture\/tradeoff/i);
  assert.match(systemDesign.systemPromptFragment, /consistency choice for counters/i);
  assert.match(systemDesign.systemPromptFragment, /Redis alone is not enough/i);
  assert.match(systemDesign.systemPromptFragment, /cross-region consistency/i);
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

test("transcript buffer caps retained messages while preserving the newest turns", () => {
  const buffer = new TranscriptBuffer(undefined, 3);
  for (let index = 1; index <= 5; index += 1) {
    buffer.append(`turn ${index}`, "stt", index * 1000, index % 2 === 0 ? "candidate" : "interviewer");
  }

  assert.deepEqual(buffer.snapshot().messages.map((message) => message.text), ["turn 3", "turn 4", "turn 5"]);
  assert.match(buffer.compact(1000), /turn 5/);
  assert.doesNotMatch(buffer.compact(1000), /turn 1/);
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

  assert.match(prompt.system, /latest interviewer turn is not an interview/i);
  assert.match(prompt.system, /Do not answer stale topics/i);
  assert.match(prompt.system, /do not pivot to resume\/CV topics/i);
  assert.match(prompt.system, /do not answer it with SQL/i);
  assert.match(prompt.system, /at most two compact/i);
  assert.match(prompt.system, /write like a candidate answer to say aloud/i);
  assert.match(prompt.system, /no 'hola'/i);
  assert.match(prompt.system, /silently ignore their topic/i);
  assert.match(prompt.system, /no meta preface/i);
  assert.match(prompt.system, /no code block unless the interviewer explicitly asks for code/i);
  assert.match(prompt.system, /do not include Python, SQLAlchemy, pseudocode/i);
});

test("prompt filters stale casual context before standalone technical questions", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("Estamos hablando de videojuegos y reservas de GTA.", "stt", 1_000, "interviewer");
  transcript.append("Que es una base de datos relacional?", "stt", 2_000, "interviewer");
  const prompt = buildPrompt(
    createGlobalContext({ activeMode: "technical_qa", transcript: transcript.snapshot() }),
    "interviewer: Que es una base de datos relacional?",
  );

  assert.match(prompt.user, /Que es una base de datos relacional/);
  assert.doesNotMatch(prompt.user, /GTA|videojuegos|reservas/i);
});

test("prompt gives latest actionable input priority over stale context", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("We were chatting about videogames and market rumors.", "stt", 1_000, "interviewer");
  const prompt = buildPrompt(
    createGlobalContext({ activeMode: "technical_qa", transcript: transcript.snapshot() }),
    "interviewer: Para que sirve Kafka?",
  );

  assert.match(prompt.user, /<latest_actionable_input>\s*interviewer: Para que sirve Kafka\?/);
  assert.match(prompt.system, /latest_actionable_input section is the highest-priority task/i);
  assert.match(prompt.system, /answer that question directly even if older transcript/i);
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
  const factualTranscript = prompt.user.match(/<transcript>\n([\s\S]*?)\n<\/transcript>/)?.[1] ?? "";
  const previousAnswers = prompt.user.match(/<previous_assistant_answers>\n([\s\S]*?)\n<\/previous_assistant_answers>/)?.[1] ?? "";
  assert.doesNotMatch(factualTranscript, /assistant: SQL is a relational query language/);
  assert.match(previousAnswers, /Assistant suggestion: SQL is a relational query language/);
});

test("live conversation detects interview questions in English and Spanish", () => {
  const english = detectQuestionIntent("Can you walk me through why you chose SQL instead of NoSQL?", "english");
  const spanish = detectQuestionIntent("Podrias explicar por que elegiste SQL en ese proyecto?", "spanish");
  const shortSpanish = detectQuestionIntent("¿Qué es SQL?", "spanish");
  const shortEnglish = detectQuestionIntent("What is SQL?", "english");
  const partialSpanish = detectQuestionIntent("Que es S", "spanish");
  const incompleteUsage = detectQuestionIntent("Para que sirve", "spanish");
  const completeUsage = detectQuestionIntent("Para que sirve Kafka", "spanish");
  const casualGaming = detectQuestionIntent("Cuantas reservas crees que puede tener GTA?", "spanish");
  const filler = detectQuestionIntent("ok thanks", "auto");
  const pause = detectQuestionIntent("Bueno, dame un segundo que estoy abriendo el repo.", "spanish");
  const implicit = detectQuestionIntent("me interesaria que me cuentes tu approach aca", "spanish");

  assert.equal(english.shouldAnswer, true);
  assert.equal(spanish.shouldAnswer, true);
  assert.equal(shortSpanish.shouldDispatch, true);
  assert.equal(shortEnglish.shouldDispatch, true);
  assert.equal(partialSpanish.shouldDispatch, true);
  assert.equal(assessPartialTurnStability("Que es S", "Que es S", 1000, 2200).stable, false);
  assert.equal(incompleteUsage.shouldDispatch, false);
  assert.equal(incompleteUsage.reason, "incomplete_question");
  assert.equal(completeUsage.shouldDispatch, true);
  assert.equal(casualGaming.shouldDispatch, false);
  assert.equal(casualGaming.reason, "non_interview_casual");
  assert.equal(filler.shouldAnswer, false);
  assert.equal(pause.shouldDispatch, false);
  assert.equal(pause.reason, "non_question_pause");
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

test("technical transcript normalization repairs trailing acronym prefixes in definition questions", () => {
  assert.equal(normalizeTechnicalTranscript("¿Qué es SQ"), "¿Qué es SQL");
  assert.equal(normalizeTechnicalTranscript("What is AP"), "What is API");
  assert.equal(normalizeTechnicalTranscript("What is CI"), "What is CI");
  assert.equal(normalizeTechnicalTranscript("SQ puede significar otra cosa"), "SQ puede significar otra cosa");
});

test("interview display renderer repairs question-mark mojibake from provider text", () => {
  const raw = "Ah?? hay un peque??o error: comet?? un error. Redis es r??pida; la usar??a para sesi??n y datos le??dos.";

  const rendered = formatAnswerForDisplay(raw, null, { mode: "interview" });

  assert.match(rendered, /Ahi/);
  assert.match(rendered, /pequeno/);
  assert.match(rendered, /cometi un error/);
  assert.match(rendered, /rapida/);
  assert.match(rendered, /usaria/);
  assert.match(rendered, /sesion/);
  assert.match(rendered, /leidos/);
  assert.doesNotMatch(rendered, /\?\?/);
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

test("structured coding answers accept provider payloads with root spokenAnswer", () => {
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "coding",
    payload: {
      version: "1",
      answerNeeded: true,
      responseType: "initial_solution",
      spokenAnswer: "Uso un stack para validar cierres.",
      problem: { title: "Valid Parentheses", summary: "Validate brackets", language: "Python" },
      solution: {
        approachSteps: ["Push openings", "Check closings"],
        code: "def is_valid(s):\n    return True",
        complexity: { time: "O(n)", space: "O(n)", rationale: "One pass" },
        edgeCases: ["empty"],
      },
    },
  }));

  const rendered = structured ? formatStructuredAnswerPayload(structured) : "";

  assert.equal(structured?.kind, "coding");
  assert.match(rendered, /Uso un stack/);
  assert.match(rendered, /```python/);
});

test("structured coding parser rescues loose yaml code payloads", () => {
  const structured = parseStructuredAnswerPayload(`chooser.sequence:
  - kind: answer
    payload:
      spokenAnswer: "Aqui tienes la solucion optimizada."
      code: |
        def two_sum(nums, target):
          seen = {}
          for i, num in enumerate(nums):
              complement = target - num
              if complement in seen:
                  return [seen[complement], i]
              seen[num] = i
          return None
      complexity:
        time: "O(n)"
        space: "O(n)"`);
  const rendered = structured ? formatStructuredAnswerPayload(structured) : "";

  assert.equal(structured?.kind, "coding");
  assert.match(rendered, /def two_sum/);
  assert.doesNotMatch(rendered, /complexity:/);
  assert.match(rendered, /O\(n\)/);
});

test("structured interview answers accept provider payloads with narration spokenAnswer", () => {
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      spokenAnswer: "",
      keyPoints: ["Deadlock: espera circular", "Mitigacion: timeouts"],
      correction: { needed: false },
      narration: { spokenAnswer: "Un deadlock ocurre cuando dos procesos quedan esperando recursos entre si." },
    },
  }));

  const rendered = structured ? formatStructuredAnswerPayload(structured) : "";

  assert.equal(structured?.kind, "interview");
  assert.match(rendered, /deadlock ocurre/);
  assert.doesNotMatch(rendered, /^\s*\{/);
});

test("answer grounding guard allows focused technical answers with valid extra details", () => {
  const context = createGlobalContext({ activeMode: "technical_qa" });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      responseType: null,
      spokenAnswer: "Un indice en SQL es una estructura como un B-Tree que acelera lecturas, aunque puede empeorar escrituras.",
      keyPoints: ["SQL", "lecturas", "escrituras"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(context, "interviewer: Que es un indice en SQL y cuando puede empeorar una consulta?", structured);

  assert.equal(assessment.ok, true);
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

test("structured renderer hides no-answer follow-up drift", () => {
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: false,
      intent: "no_answer",
      responseType: null,
      spokenAnswer: "Entendido, quedo a la espera de la siguiente pregunta.",
      keyPoints: [],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: "Prepara SQL, APIs o sistemas distribuidos.",
    },
  }));

  const rendered = structured ? formatStructuredAnswerPayload(structured) : "";

  assert.match(rendered, /quedo a la espera/);
  assert.doesNotMatch(rendered, /SQL|APIs|sistemas distribuidos/);
});

test("structured answer parser tolerates provider JSON with stray backticks and numeric fields", () => {
  const withBacktick = parseStructuredAnswerPayload(
    '{"kind":"interview","payload":{"version":"1","answerNeeded":true,"intent":"technical_qa","spokenAnswer":"Token bucket answer","keyPoints":["Tasa fija (r)`, "Capacidad maxima"],"correction":{"needed":false},"assumptions":[],"evidenceRefs":[],"followUpHint":null}}',
  );
  const withNumericField = parseStructuredAnswerPayload(
    '{"kind":"interview","payload":{"version":"1","answerNeeded":true,"intent":"technical_qa","spokenAnswer":"SQL example","keyPoints":[],"correction":{"needed":false},"assumptions":[],"evidenceRefs":[],"followUpHint":null},0:{"Respuesta":"extra"}}',
  );

  assert.equal(withBacktick?.kind, "interview");
  assert.equal(withNumericField?.kind, "interview");
  assert.match(withBacktick ? formatStructuredAnswerPayload(withBacktick) : "", /Token bucket/);
  assert.match(withNumericField ? formatStructuredAnswerPayload(withNumericField) : "", /SQL example/);
});

test("interview display renderer rescues malformed structured text", () => {
  const raw = `{
    "kind": "interview",
    "payload": {
      "version": "1",
      "spokenAnswer": **Respuesta:** "Implementaria idempotencia con una clave unica por operacion antes de procesar el pago. Si llega un retry, reviso el estado y devuelvo el resultado ya registrado sin volver a cobrar.",
      "keyPoints": []
    }
  }`;

  const rendered = formatAnswerForDisplay(raw, null, { mode: "interview" });

  assert.match(rendered, /^\*\*Respuesta:\*\*/);
  assert.match(rendered, /idempotencia/);
  assert.doesNotMatch(rendered, /"kind"|payload|spokenAnswer|\{/);
});

test("interview display renderer removes meta prefaces and unexpected code", () => {
  const raw = [
    "Ahí tienes una respuesta estructurada según tus requisitos:",
    "",
    "**Para decir:**",
    "Usaria una transaccion y una clave idempotente para que dos workers no procesen el mismo pago dos veces.",
    "",
    "```python",
    "def procesar_pago(): pass",
    "```",
    "",
    "Opcional: podria mencionar locks distribuidos.",
  ].join("\n");

  const rendered = formatAnswerForDisplay(raw, null, { mode: "interview" });

  assert.match(rendered, /clave idempotente/);
  assert.doesNotMatch(rendered, /Ah[ií]|seg[uú]n tus requisitos|```|def procesar|Opcional/i);
});

test("interview display renderer removes nested say-labels and corrupt artifact lines", () => {
  const raw = [
    "**Para decir:**",
    "Para decir: Implementaria un lock transaccional y una clave idempotente para que dos workers no procesen el mismo pago.",
    "Implementaria un mecanismo de bifrost de transaccion unica con tenant de version.",
  ].join("\n");

  const rendered = formatAnswerForDisplay(raw, null, { mode: "interview" });

  assert.match(rendered, /^\*\*Respuesta:\*\*/);
  assert.match(rendered, /clave idempotente/);
  assert.doesNotMatch(rendered, /Para decir|bifrost/i);
});

test("interview display renderer keeps the main answer and drops appendix sections", () => {
  const raw = [
    "**Para decir:**",
    "En un proyecto de conciliacion de pagos, use jobs asincronos con Python y PostgreSQL para procesar confirmaciones sin bloquear el flujo principal.",
    "",
    "**Tradeoff mencionado (opcional pero relevante):**",
    "Esto agrega complejidad operativa.",
    "",
    "**Evidencia soportante:**",
    "Resume: texto interno que no debe decirse.",
  ].join("\n");

  const rendered = formatAnswerForDisplay(raw, null, { mode: "interview" });

  assert.match(rendered, /jobs asincronos/);
  assert.doesNotMatch(rendered, /Tradeoff|Evidencia|Resume|complejidad operativa/i);
});

test("interview display renderer falls back to key points when spoken answer is empty", () => {
  const raw = `{
    "kind": "interview",
    "payload": {
      "version": "1",
      "answerNeeded": true,
      "intent": "technical_qa",
      "spokenAnswer": "",
      "keyPoints": [
        "Uso de bloqueos o transacciones para evitar concurrencia",
        "Implementacion de idempotencia con una clave unica por pago"
      ],
      "correction": {
        "needed": false`;

  const rendered = formatAnswerForDisplay(raw, null, { mode: "interview" });

  assert.match(rendered, /bloqueos|transacciones/);
  assert.match(rendered, /idempotencia/);
  assert.doesNotMatch(rendered, /spokenAnswer|keyPoints|^\*\*Respuesta:\*\*\s*"?$/);
});

test("interview display renderer removes control-instruction artifacts", () => {
  const raw = [
    "**Para decir:**",
    "které meinen Einschaltstellen... **(PAUSA PARA CORRECCIÓN NATURAL Y TÁCTICA, LUEGO RESUMIR CON LA RESPUESTA)**",
    "**Respuesta:**",
    "Identificador único: asignaría un ID único por transacción para detectar duplicados antes de cobrar.",
  ].join("\n");

  const rendered = formatAnswerForDisplay(raw, null, { mode: "interview" });

  assert.match(rendered, /Identificador único/);
  assert.doesNotMatch(rendered, /PAUSA|Einschaltstellen|kter/i);
});

test("interview display renderer removes placeholders and stray foreign glyphs", () => {
  const raw = [
    "京 **Respuesta:**",
    "En un proyecto de reconciliacion de pagos en [Nombre de la Empresa Actual/Pasada], use metricas de Shakespeare para analizar latencia.",
    "Luego use logs y traces para ubicar el cuello de botella.",
  ].join("\n");

  const rendered = formatAnswerForDisplay(raw, null, { mode: "interview" });

  assert.match(rendered, /logs y traces/);
  assert.doesNotMatch(rendered, /京|Nombre de la Empresa|Shakespeare/i);
});

test("system design repair covers explicit Redis-alone requests when model omits them", () => {
  const repaired = repairSystemDesignAnswerCoverage(
    "**Respuesta:** Final link shortener design uses multi-region routing and strongly consistent click counters.",
    "Give me a concise executive summary including why Redis alone is not enough.",
    "system_design",
  );
  const unchangedTechnical = repairSystemDesignAnswerCoverage(
    "Use a cache for reads.",
    "Explain why Redis alone is not enough.",
    "technical_qa",
  );

  assert.match(repaired, /Redis alone is not enough/i);
  assert.match(repaired, /durable source of truth/i);
  assert.equal(unchangedTechnical, "Use a cache for reads.");
});

test("system design repair rewrites Redis central-store shortcuts", () => {
  const repaired = repairSystemDesignAnswerCoverage(
    "**Respuesta:** We'll use Redis as a central store for click counters across regions.",
    "Give me a concise executive summary including why Redis alone is not enough.",
    "system_design",
  );

  assert.match(repaired, /durable source of truth for click counters/i);
  assert.match(repaired, /Redis only as a cache or fast path/i);
  assert.doesNotMatch(repaired, /Redis as a central store/i);
});

test("system design repair rewrites Redis strongly-consistent counter shortcuts", () => {
  const repaired = repairSystemDesignAnswerCoverage(
    "**Respuesta:** We use Redis as a strongly consistent click counter across regions.",
    "Give me a concise executive summary including why Redis alone is not enough.",
    "system_design",
  );

  assert.match(repaired, /durable counter store for strong consistency/i);
  assert.match(repaired, /Redis only as a cache or fast path/i);
  assert.doesNotMatch(repaired, /Redis as a strongly consistent click counter/i);
});

test("system design repair rewrites Redis plus distributed-locking counter shortcuts", () => {
  const repaired = repairSystemDesignAnswerCoverage(
    "**Respuesta:** We use a combination of Redis and a distributed locking system like ZooKeeper to handle strongly consistent click counters across regions.",
    "Give me a concise executive summary including why Redis alone is not enough.",
    "system_design",
  );

  assert.match(repaired, /durable counter store for strong consistency/i);
  assert.match(repaired, /Redis only as a cache or fast path/i);
  assert.doesNotMatch(repaired, /combination of Redis and a distributed locking system/i);
});

test("system design repair rewrites Redis primary-store shortcuts", () => {
  const repaired = repairSystemDesignAnswerCoverage(
    "**Respuesta:** We'd use leader-follower replication with Redis as the primary store.",
    "Give me a concise executive summary including why Redis alone is not enough.",
    "system_design",
  );

  assert.match(repaired, /durable counter store as the source of truth/i);
  assert.match(repaired, /Redis only as a cache or fast path/i);
  assert.doesNotMatch(repaired, /Redis as the primary store/i);
});

test("structured answer json schema requires every payload property for strict providers", () => {
  const payloadSchema = STRUCTURED_ANSWER_PAYLOAD_JSON_SCHEMA.schema.properties.payload;
  const propertyNames = Object.keys(payloadSchema.properties);
  const required = new Set<string>(payloadSchema.required);

  for (const propertyName of propertyNames) {
    assert.equal(required.has(propertyName), true, `${propertyName} should be required`);
  }
  assert.equal(payloadSchema.additionalProperties, false);
});

test("live conversation auto answer respects cooldown", () => {
  const detection = detectQuestionIntent("What tradeoffs did you consider?");

  assert.equal(shouldAutoAnswer(detection, 20_000, 0), true);
  assert.equal(shouldAutoAnswer(detection, 25_000, 20_000), false);
});

test("live conversation focuses the latest question inside accumulated STT partials", () => {
  const text = [
    "Earlier implementation discussion about pages and classes.",
    "I would use one object per item.",
    "What is a relational database?",
  ].join(" ");

  const detection = detectQuestionIntent(text, "english");

  assert.equal(extractLatestQuestionFocus(text), "What is a relational database?");
  assert.equal(detection.reason, "definition_question");
  assert.equal(detection.normalizedText, "What is a relational database?");
});

test("live conversation focuses complete usage questions after incomplete prefixes", () => {
  const text = "Para que sirve interviewer: Kafka. Para que sirve Kafka?";

  assert.equal(extractLatestQuestionFocus(text), "Para que sirve Kafka?");
});

test("live conversation keeps a completed question over its dangling repeated partial", () => {
  const text = "interviewer: ¿Qué es SQL? ¿Qué es SQ";
  const detection = detectQuestionIntent(text, "spanish");

  assert.equal(extractLatestQuestionFocus(text), "¿Qué es SQL?");
  assert.equal(detection.normalizedText, "¿Qué es SQL?");
  assert.equal(detection.reason, "definition_question");
});

test("live conversation focuses the final STT question without punctuation", () => {
  const text = [
    "so earlier we talked about team process and maybe what caches are used for",
    "but the concrete thing I want to ask is how would you design retries without charging twice",
  ].join(" ");

  assert.equal(
    extractLatestQuestionFocus(text),
    "how would you design retries without charging twice",
  );
});

test("live conversation ignores earlier partial questions when a later concrete question appears", () => {
  const text = [
    "What is caching and also we could talk about Redis later.",
    "Actually let's focus on the production incident.",
    "How would you debug a latency spike in an API?",
  ].join(" ");

  assert.equal(extractLatestQuestionFocus(text), "How would you debug a latency spike in an API?");
});

test("live conversation treats interview directives as the latest actionable prompt", () => {
  const redisText = [
    "Suppose the write succeeds but invalidation fails. What retry strategy and idempotency key would you use?",
    "Switch topics. In Postgres, when does an index help, and when can it hurt write throughput?",
    "Bring it back to the original Redis cache design and summarize the trade off",
  ].join(" ");
  const noisyText = [
    "Let me reformulate. Compare a queue with direct API retry for an email delivery workflow.",
    "Ignore the earlier payment example. For the latest question, focus only on queues, retries, dead letters, and idempotency",
  ].join(" ");

  assert.equal(
    extractLatestQuestionFocus(redisText),
    "Bring it back to the original Redis cache design and summarize the trade off",
  );
  assert.match(extractLatestQuestionFocus(noisyText), /focus only on queues, retries, dead letters, and idempotency/i);
  assert.equal(detectQuestionIntent(redisText, "english").shouldDispatch, true);
  assert.equal(detectQuestionIntent(noisyText, "english").shouldDispatch, true);
});

test("live conversation does not let guardrails replace system design directives", () => {
  const text = [
    "Why not simply use an atomic counter in Redis and call it done? Push back if that is too simplistic.",
    "Final change: make it multi-region with low redirect latency. Do not invent an SLA or a number of regions.",
  ].join(" ");
  const focus = extractLatestQuestionFocus(text);

  assert.match(focus, /make it multi-region/i);
  assert.match(focus, /Do not invent an SLA/i);
  assert.equal(detectQuestionIntent(text, "english").shouldDispatch, true);
});

test("live conversation focuses final system design summary after scope changes", () => {
  const text = [
    "Design a URL shortener for ten million requests per day. Start by stating assumptions, read write ratio, and the main components.",
    "Now change the scale to five hundred million requests per day. Which part of the previous design stops holding up first?",
    "Why not simply use an atomic counter in Redis and call it done? Push back if that is too simplistic.",
    "Final change: make it multi-region with low redirect latency. Do not invent an SLA or a number of regions.",
    "Give me a concise executive summary of the final design, including the multi-region tradeoff, click counter consistency, and why Redis alone is not enough.",
  ].join(" ");
  const focus = extractLatestQuestionFocus(text);

  assert.match(focus, /^Give me a concise executive summary/i);
  assert.match(focus, /executive summary/i);
  assert.match(focus, /Final change: make it multi-region/i);
  assert.match(focus, /multi-region tradeoff/i);
  assert.match(focus, /click counter consistency/i);
  assert.match(focus, /Redis alone/i);
  assert.doesNotMatch(focus, /^Do not invent/i);
  assert.equal(detectQuestionIntent(text, "english").shouldDispatch, true);
});

test("live conversation resolves bare usage follow-ups from prior technical context", () => {
  const text = [
    "interviewer: A list, because I think a list is ordered. It's a collection of items, and a dictionary would lose the ordering.",
    "interviewer: bit. Para que sirve",
  ].join("\n");
  const focus = extractLatestQuestionFocus(text);
  const detection = detectQuestionIntent(text, "auto");

  assert.match(focus, /^Para que sirve .*list/i);
  assert.match(focus, /list/);
  assert.match(focus, /dictionary/);
  assert.equal(detection.shouldDispatch, true);
  assert.notEqual(detection.reason, "incomplete_question");
});

test("turn assembler folds provider final fragments into the live draft", () => {
  const state = createTurnAssemblerState();
  const partial = assembleTurn(state, {
    speaker: "interviewer",
    text: "Solution: optimize it and write code or pseudo-code on the spot. The interviewer expects reasoning.",
    isFinal: false,
    timestamp: 1_000,
  });
  const fragment = assembleTurn(state, {
    speaker: "interviewer",
    text: "Solution: optimize it",
    isFinal: true,
    timestamp: 1_200,
  });
  const nextPartial = assembleTurn(state, {
    speaker: "interviewer",
    text: "Solution: optimize it and write code or pseudo-code on the spot. The interviewer expects reasoning and complexity.",
    isFinal: false,
    timestamp: 1_400,
  });

  assert.equal(partial.action, "publish_live");
  assert.equal(fragment.action, "fold_final");
  assert.equal(nextPartial.action, "publish_live");
  assert.match(nextPartial.action === "publish_live" ? nextPartial.text : "", /complexity/);
});

test("turn assembler does not commit short non-question STT final fragments", () => {
  const state = createTurnAssemblerState();

  assert.deepEqual(assembleTurn(state, {
    speaker: "interviewer",
    text: "To remember",
    isFinal: false,
    timestamp: 1_000,
  }), { action: "publish_live", reason: "partial", text: "To remember" });

  const folded = assembleTurn(state, {
    speaker: "interviewer",
    text: "To remember",
    isFinal: true,
    timestamp: 1_100,
  });
  const ignored = assembleTurn(createTurnAssemblerState(), {
    speaker: "interviewer",
    text: "Uh.",
    isFinal: true,
    timestamp: 1_200,
  });
  const question = assembleTurn(createTurnAssemblerState(), {
    speaker: "interviewer",
    text: "What is SQL?",
    isFinal: true,
    timestamp: 1_300,
  });

  assert.equal(folded.action, "fold_final");
  assert.equal(ignored.action, "ignore");
  assert.equal(ignored.reason, "short_final_fragment");
  assert.equal(question.action, "commit");
});

test("turn assembler keeps growing live draft after folded short finals", () => {
  const state = createTurnAssemblerState();
  assembleTurn(state, {
    speaker: "interviewer",
    text: "To remember",
    isFinal: false,
    timestamp: 1_000,
  });
  assembleTurn(state, {
    speaker: "interviewer",
    text: "To remember",
    isFinal: true,
    timestamp: 1_100,
  });
  const next = assembleTurn(state, {
    speaker: "interviewer",
    text: "To remember page. Uh. Remember page",
    isFinal: false,
    timestamp: 1_300,
  });

  assert.equal(next.action, "publish_live");
  assert.match(next.action === "publish_live" ? next.text : "", /Remember page/);
});

test("turn assembler publishes only new text after a committed cumulative provider turn", () => {
  const state = createTurnAssemblerState();
  assembleTurn(state, {
    speaker: "interviewer",
    text: "There's a reason to use, like, a tuple over a list in this specific example.",
    isFinal: false,
    timestamp: 1_000,
  });
  const firstCommit = assembleTurn(state, {
    speaker: "interviewer",
    text: "There's a reason to use, like, a tuple over a list in this specific example.",
    isFinal: true,
    timestamp: 1_100,
  });
  const nextPartial = assembleTurn(state, {
    speaker: "interviewer",
    text: "There's a reason to use, like, a tuple over a list in this specific example. Yep. Or, like, vice versa.",
    isFinal: false,
    timestamp: 1_400,
  });

  assert.equal(firstCommit.action, "commit");
  assert.equal(nextPartial.action, "publish_live");
  assert.equal(nextPartial.action === "publish_live" ? nextPartial.text : "", "Yep. Or, like, vice versa.");
});

test("turn assembler ignores dangling repeated partial after a committed question", () => {
  const state = createTurnAssemblerState();
  const firstCommit = assembleTurn(state, {
    speaker: "interviewer",
    text: "¿Qué es SQL?",
    isFinal: true,
    timestamp: 1_000,
  });
  const repeatedPartial = assembleTurn(state, {
    speaker: "interviewer",
    text: "¿Qué es SQL? ¿Qué es SQ",
    isFinal: false,
    timestamp: 1_200,
  });

  assert.equal(firstCommit.action, "commit");
  assert.equal(repeatedPartial.action, "ignore");
  assert.equal(repeatedPartial.reason, "empty");
});

test("turn assembler commits only the delta when cumulative provider text continues after prior finals", () => {
  const state = createTurnAssemblerState();
  assembleTurn(state, {
    speaker: "interviewer",
    text: "There's a reason to use a tuple over a list.",
    isFinal: true,
    timestamp: 1_000,
  });
  assembleTurn(state, {
    speaker: "interviewer",
    text: "There's a reason to use a tuple over a list. Yep. You could choose either one.",
    isFinal: false,
    timestamp: 1_200,
  });
  const secondCommit = assembleTurn(state, {
    speaker: "interviewer",
    text: "There's a reason to use a tuple over a list. Yep. You could choose either one.",
    isFinal: true,
    timestamp: 1_500,
  });
  const thirdPartial = assembleTurn(state, {
    speaker: "interviewer",
    text: "There's a reason to use a tuple over a list. Yep. You could choose either one. So I think here I'm going to use a list.",
    isFinal: false,
    timestamp: 1_800,
  });

  assert.equal(secondCommit.action, "commit");
  assert.equal(secondCommit.action === "commit" ? secondCommit.text : "", "Yep. You could choose either one.");
  assert.equal(thirdPartial.action, "publish_live");
  assert.equal(thirdPartial.action === "publish_live" ? thirdPartial.text : "", "So I think here I'm going to use a list.");
});

test("turn assembler strips confirmed prefix even when provider inserts filler before continuing", () => {
  const state = createTurnAssemblerState();
  assembleTurn(state, {
    speaker: "interviewer",
    text: "ID of a certain book in the library. So maybe we can just add ID here,",
    isFinal: true,
    timestamp: 1_000,
  });
  assembleTurn(state, {
    speaker: "interviewer",
    text: "ID of a certain book in the library. So maybe we can just add ID here, um. And. Maybe I can make that also a string or an integer or something.",
    isFinal: false,
    timestamp: 1_200,
  });
  const folded = assembleTurn(state, {
    speaker: "interviewer",
    text: "Maybe I can make that also a string or an integer or something.",
    isFinal: true,
    timestamp: 1_500,
  });
  const next = assembleTurn(state, {
    speaker: "interviewer",
    text: "ID of a certain book in the library. So maybe we can just add ID here, um. And. Maybe I can make that also a string or an integer or something. Yep. And I'm going to add a question mark.",
    isFinal: false,
    timestamp: 1_800,
  });

  assert.equal(folded.action, "fold_final");
  assert.equal(next.action, "publish_live");
  assert.match(next.action === "publish_live" ? next.text : "", /Yep\./);
  assert.doesNotMatch(next.action === "publish_live" ? next.text : "", /^ID of a certain book/);
});

test("turn assembler applies overlapping final fragments that complete partial words", () => {
  const state = createTurnAssemblerState();
  assembleTurn(state, {
    speaker: "interviewer",
    text: "And I think what could make sense here is having the ID correspond to the book obj",
    isFinal: false,
    timestamp: 1_000,
  });
  const folded = assembleTurn(state, {
    speaker: "interviewer",
    text: "ake sense here is having the ID correspond to the book object.",
    isFinal: true,
    timestamp: 1_200,
  });
  const next = assembleTurn(state, {
    speaker: "interviewer",
    text: "And I think what could make sense here is having the ID correspond to the book object. Yep.",
    isFinal: false,
    timestamp: 1_400,
  });

  assert.equal(folded.action, "fold_final");
  assert.equal(folded.action === "fold_final" ? folded.draftText : "", "And I think what could make sense here is having the ID correspond to the book object.");
  assert.equal(next.action, "publish_live");
  assert.equal(next.action === "publish_live" ? next.text : "", "And I think what could make sense here is having the ID correspond to the book object. Yep.");
});

test("overlay transcript helpers suppress duplicate live bubbles and expose only new deltas", () => {
  const committed = "Can you explain idempotency in a payment worker?";
  assert.equal(hasTranscriptProgress(committed, committed), false);
  assert.equal(hasTranscriptProgress(committed, "Can you explain idempotency in a payment worker"), false);
  assert.equal(
    hasTranscriptProgress(committed, "Can you explain idempotency in a payment worker? And how would you test it?"),
    true,
  );
  assert.equal(
    transcriptDelta(committed, "Can you explain idempotency in a payment worker? And how would you test it?"),
    "And how would you test it?",
  );
  assert.equal(transcriptDelta("", "What is Redis?"), "What is Redis?");
});

test("turn assembler preserves only accumulated new speech across partial and final STT sequences", () => {
  const state = createTurnAssemblerState();
  const sequence = [
    { text: "What is Redis", isFinal: false },
    { text: "What is Redis?", isFinal: true },
    { text: "What is Redis? And when would you use it", isFinal: false },
    { text: "And when would you use it?", isFinal: true },
    { text: "What is Redis? And when would you use it? Follow-up: what are the tradeoffs?", isFinal: false },
  ];
  const decisions = sequence.map((item, index) => assembleTurn(state, {
    speaker: "interviewer",
    text: item.text,
    isFinal: item.isFinal,
    timestamp: 1_000 + index,
  }));

  assert.equal(decisions[1].action, "commit");
  assert.equal(decisions[1].action === "commit" ? decisions[1].text : "", "What is Redis?");
  assert.equal(decisions[3].action, "commit");
  assert.equal(decisions[3].action === "commit" ? decisions[3].text : "", "And when would you use it?");
  assert.equal(decisions[4].action, "publish_live");
  assert.equal(decisions[4].action === "publish_live" ? decisions[4].text : "", "Follow-up: what are the tradeoffs?");
});

test("answer grounding guard blocks unsupported topic drift", () => {
  const context = createGlobalContext({
    activeMode: "technical_qa",
    transcript: new TranscriptBuffer().snapshot(),
    preferredLanguage: "english",
  });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      responseType: null,
      spokenAnswer: "SQL is used to query relational databases with joins and transactions.",
      keyPoints: ["relational database"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(
    context,
    "The reading application remembers where the user left off in a book. Correct?",
    structured,
  );
  const guarded = withNoAnswerForUngroundedDrift(structured, assessment);

  assert.equal(assessment.ok, false);
  assert.equal(guarded.kind, "interview");
  if (guarded.kind === "interview") {
    assert.equal(guarded.payload.intent, "no_answer");
    assert.equal(guarded.payload.answerNeeded, false);
  }
});

test("answer grounding guard blocks invented behavioral specifics", () => {
  const context = createGlobalContext({
    activeMode: "behavioral",
    preferredLanguage: "english",
    resumeText: "Backend engineer with production incident runbook experience.",
  });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "behavioral",
      responseType: null,
      spokenAnswer: "As a Backend Engineer at TechCorp, I handled a Black Friday outage in 2022 that affected over 10,000 users. I found the root cause and rolled back the deployment within 15 minutes.",
      keyPoints: ["TechCorp", "10,000 users", "15 minutes"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(context, "Describe a production incident you handled.", structured);
  const guarded = withNoAnswerForUngroundedDrift(structured, assessment);

  assert.equal(assessment.ok, false);
  assert.equal(assessment.reason, "unsupported_behavioral_specifics");
  assert.match(assessment.unsupportedTerms.join(" "), /TechCorp|Black Friday|10,000 users|15 minutes/);
  assert.equal(guarded.kind, "interview");
  if (guarded.kind === "interview") {
    assert.equal(guarded.payload.intent, "no_answer");
    assert.match(guarded.payload.spokenAnswer, /sin inventar datos/i);
  }
});

test("answer grounding guard allows supported behavioral specifics", () => {
  const context = createGlobalContext({
    activeMode: "behavioral",
    preferredLanguage: "english",
    starStories: "At TechCorp during Black Friday 2022, I handled a production incident affecting 10,000 users and rolled back within 15 minutes after finding the root cause.",
  });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "behavioral",
      responseType: null,
      spokenAnswer: "At TechCorp during Black Friday 2022, I handled a production incident affecting 10,000 users and rolled back within 15 minutes after finding the root cause.",
      keyPoints: ["TechCorp", "10,000 users", "15 minutes"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(context, "Describe a production incident you handled.", structured);

  assert.equal(assessment.ok, true);
});

test("plain behavioral answer grounding blocks unstructured invented specifics", () => {
  const context = createGlobalContext({
    activeMode: "behavioral",
    preferredLanguage: "english",
    resumeText: "Backend engineer with production incident runbook experience.",
  });
  const assessment = assessPlainInterviewAnswerGrounding(
    context,
    "Describe a production incident you handled.",
    "**Respuesta:** En mi ultimo rol como Backend Engineer en TechCorp, el servicio UserSync afecto 10,000 users durante Black Friday.",
  );

  assert.equal(assessment.ok, false);
  assert.equal(assessment.reason, "unsupported_behavioral_specifics");
  assert.match(assessment.unsupportedTerms.join(" "), /TechCorp|UserSync|10,000 users|Black Friday/);
});

test("answer grounding guard allows explicitly mentioned technical topics", () => {
  const context = createGlobalContext({ activeMode: "technical_qa" });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      responseType: null,
      spokenAnswer: "SQL is a language for querying relational databases.",
      keyPoints: ["queries", "relational databases"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(context, "What is SQL?", structured);

  assert.equal(assessment.ok, true);
});

test("answer grounding guard blocks technical anchor swaps from stale context", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("What is RPC?", "stt", 1_000, "interviewer");
  transcript.append("**Respuesta:** RPC calls remote services.", "manual", 2_000, "assistant");
  const context = createGlobalContext({
    activeMode: "technical_qa",
    transcript: transcript.snapshot(),
    screenContext: {
      kind: "unknown",
      confidence: 0.1,
      visibleText: "Old note: RPC, IDL, protobuf",
      summary: "stale RPC note",
      capturedAt: 1_000,
    },
  });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      responseType: null,
      spokenAnswer: "RPC is a pattern for calling remote procedures across service boundaries.",
      keyPoints: ["RPC", "IDL"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(context, "Is it like SDK?", structured);

  assert.equal(assessment.ok, false);
  assert.equal(assessment.reason, "topic_anchor_mismatch");
});

test("answer grounding guard blocks definition answers that replace the asked subject", () => {
  const context = createGlobalContext({ activeMode: "technical_qa" });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      responseType: null,
      spokenAnswer: "GraphQL is a query language often used to fetch API data.",
      keyPoints: ["queries"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(context, "What is an API?", structured);

  assert.equal(assessment.ok, false);
  assert.equal(assessment.reason, "definition_subject_mismatch");
});

test("answer grounding guard ignores prior assistant answers as evidence", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("**Respuesta:** RPC is a remote procedure call pattern.", "manual", 1_000, "assistant");
  const context = createGlobalContext({
    activeMode: "technical_qa",
    transcript: transcript.snapshot(),
  });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      responseType: null,
      spokenAnswer: "RPC is a remote procedure call pattern.",
      keyPoints: ["RPC"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(context, "Para que sirve?", structured);

  assert.equal(assessment.ok, false);
});

test("answer grounding guard handles Spanish definition subjects with punctuation noise", () => {
  const context = createGlobalContext({ activeMode: "technical_qa" });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      responseType: null,
      spokenAnswer: "SQL es un lenguaje para consultar bases de datos.",
      keyPoints: ["consultas"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(context, "Â¿Qué es una base de datos relacional?", structured);

  assert.equal(assessment.ok, false);
  assert.equal(assessment.reason, "definition_subject_mismatch");
});

test("answer grounding guard blocks answers that ignore explicit Spanish usage subjects", () => {
  const context = createGlobalContext({ activeMode: "technical_qa" });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      responseType: null,
      spokenAnswer: "SQL is a language for querying relational databases.",
      keyPoints: ["queries", "relational databases"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(context, "Para que sirve Kafka. Kafka.", structured);

  assert.equal(assessment.ok, false);
  assert.equal(assessment.reason, "topic_anchor_mismatch");
});

test("answer grounding guard allows answers focused on the explicit Spanish usage subject", () => {
  const context = createGlobalContext({ activeMode: "technical_qa" });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      responseType: null,
      spokenAnswer: "Kafka sirve para construir pipelines de eventos y comunicar servicios de forma asincronica.",
      keyPoints: ["Kafka", "event streaming", "mensajeria asincronica"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(context, "Para que sirve Kafka. Kafka.", structured);

  assert.equal(assessment.ok, true);
});

test("answer grounding guard allows general knowledge for the latest explicit subject", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("Estamos hablando de videojuegos y reservas de GTA.", "stt", 1_000, "interviewer");
  transcript.append("Que es una base de datos relacional?", "stt", 2_000, "interviewer");
  const context = createGlobalContext({
    activeMode: "technical_qa",
    transcript: transcript.snapshot(),
  });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      responseType: null,
      spokenAnswer: "Una base de datos relacional organiza datos en tablas relacionadas mediante claves y puede usar propiedades ACID para consistencia.",
      keyPoints: ["tablas", "claves", "consistencia"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(
    context,
    "interviewer: Estamos hablando de videojuegos y reservas de GTA.\ninterviewer: Que es una base de datos relacional?",
    structured,
  );

  assert.equal(assessment.ok, true);
});

test("answer grounding guard allows follow-up usage decisions for explicit subjects", () => {
  const context = createGlobalContext({ activeMode: "technical_qa" });
  const structured = parseStructuredAnswerPayload(JSON.stringify({
    kind: "interview",
    payload: {
      version: "1",
      answerNeeded: true,
      intent: "technical_qa",
      responseType: null,
      spokenAnswer: "No usaria Kafka cuando la escala es baja o la sobrecarga operativa supera el beneficio del desacoplamiento.",
      keyPoints: ["Kafka", "overhead", "baja escala"],
      correction: { needed: false, transition: null, correctedClaim: null },
      assumptions: [],
      evidenceRefs: [],
      followUpHint: null,
      problem: { title: "", summary: "", language: "", functionSignature: null, constraints: [] },
      solution: { approachSteps: [], code: "", complexity: { time: "", space: "", rationale: "" }, edgeCases: [], invariants: [] },
      narration: { spokenAnswer: "", currentStep: "" },
      tests: [],
      patch: { kind: "none", code: null },
    },
  }));

  assert.ok(structured);
  const assessment = assessAnswerGrounding(context, "interviewer: Y cuando no usarias Kafka?", structured);

  assert.equal(assessment.ok, true);
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
  const settings = mergeAppSettings({ modelProvider: "nvidia", modelName: "meta/llama-3.1-8b-instruct" });
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
    modelName: "meta/llama-3.1-8b-instruct",
    question: "",
    answer: "",
  });
  const parsed = parseSessionJson(serializeSession(session));

  assert.equal(settings.modelProvider, "nvidia");
  assert.equal(settings.modelName, "meta/llama-3.1-8b-instruct");
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

test("OpenAI-compatible model list helper extracts provider model ids", () => {
  const models = extractOpenAICompatibleModels({
    data: [
      { id: "meta/llama-3.3-70b-instruct", owned_by: "meta" },
      { id: "baai/bge-m3" },
      { name: "custom/chat-model" },
      { id: "  " },
    ],
  });

  assert.deepEqual(models.map((model) => model.name), [
    "meta/llama-3.3-70b-instruct",
    "baai/bge-m3",
    "custom/chat-model",
  ]);
  assert.equal(models[0]?.ownedBy, "meta");
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
  assert.match(promptText, /visibleTextExact/);
  assert.deepEqual(request.input[0]?.content[1], {
    type: "input_image",
    image_url: "data:image/png;base64,abc",
    detail: "high",
  });
});

test("OpenAI-compatible image analysis request uses chat multimodal content", () => {
  const request = buildOpenAICompatibleImageAnalysisRequest("data:image/png;base64,abc", DEFAULT_NVIDIA_VISION_MODEL);
  assert.equal(request.model, DEFAULT_NVIDIA_VISION_MODEL);
  assert.equal(request.stream, false);
  assert.equal(request.response_format.type, "json_object");
  assert.match(request.messages[0]?.content[0].text ?? "", /functionSignature/);
  assert.deepEqual(request.messages[0]?.content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,abc", detail: "high" },
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
