import test from "node:test";
import assert from "node:assert/strict";
import {
  TranscriptBuffer,
  buildAnswerContext,
  buildPrompt,
  classifyScreenText,
  createGlobalContext,
  formatAnswerContextSection,
  formatConversationWindow,
  type BuiltPrompt,
} from "../core/index.ts";

const mockProvider = (prompt: BuiltPrompt): string => {
  const user = prompt.user;
  if (/En que contexto lo usarias|En que contexto lo usar/i.test(user)) {
    return /Que es HTML|Qué es HTML|HTML/i.test(user)
      ? "Usaria HTML para estructurar contenido web semantico."
      : "No puedo resolver el referente de lo.";
  }
  if (/their disadvantages/i.test(user)) {
    return /database indexes/i.test(user)
      ? "Their disadvantages are extra write cost, storage, and maintenance for indexes."
      : "Their is ambiguous.";
  }
  if (/When would you use it/i.test(user)) {
    return /What is Redis|Redis/i.test(user)
      ? "I would use Redis for low-latency caching, counters, and short-lived coordination."
      : "I cannot resolve what it refers to.";
  }
  if (/trade-offs does that approach/i.test(user)) {
    return /cache this endpoint/i.test(user) && /Assistant suggestion:/i.test(user)
      ? "That cache approach trades freshness and invalidation complexity for lower latency."
      : "Missing previous approach context.";
  }
  return "Generic answer.";
};

test("manual follow-up in Spanish keeps first question separate from current question", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("Que es HTML?", "stt", 1_000, "interviewer");
  transcript.append("HTML es un lenguaje de marcado para estructurar paginas web.", "manual", 2_000, "assistant");
  transcript.append("En que contexto lo usarias?", "stt", 3_000, "interviewer");
  const context = createGlobalContext({ activeMode: "technical_qa", transcript: transcript.snapshot(), preferredLanguage: "spanish" });
  const prompt = buildPrompt(context, "interviewer: En que contexto lo usarias?");

  assert.match(prompt.user, /<recent_conversation>[\s\S]*Interviewer: Que es HTML\?/);
  assert.match(prompt.user, /<current_question>[\s\S]*Interviewer: En que contexto lo usarias\?/);
  assert.match(prompt.user, /<previous_assistant_answers>[\s\S]*Assistant suggestion: HTML es un lenguaje/);
  assert.match(mockProvider(prompt), /HTML/i);
});

test("manual follow-up in English resolves it to Redis through prompt context", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("What is Redis?", "stt", 1_000, "interviewer");
  transcript.append("Redis is an in-memory data store often used for caching.", "manual", 2_000, "assistant");
  transcript.append("When would you use it?", "stt", 3_000, "interviewer");
  const prompt = buildPrompt(createGlobalContext({ activeMode: "technical_qa", transcript: transcript.snapshot() }), "interviewer: When would you use it?");

  assert.match(prompt.user, /<recent_conversation>[\s\S]*Interviewer: What is Redis\?/);
  assert.match(prompt.user, /<current_question>[\s\S]*Interviewer: When would you use it\?/);
  assert.match(mockProvider(prompt), /Redis/);
});

test("follow-up about previous answer includes the generated suggestion", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("How would you cache this endpoint?", "stt", 1_000, "interviewer");
  transcript.append("I would use a short TTL cache keyed by request parameters with explicit invalidation after writes.", "manual", 2_000, "assistant");
  transcript.append("What trade-offs does that approach have?", "stt", 3_000, "interviewer");
  const prompt = buildPrompt(createGlobalContext({ activeMode: "technical_qa", transcript: transcript.snapshot() }), "interviewer: What trade-offs does that approach have?");

  assert.match(prompt.user, /<previous_assistant_answers>[\s\S]*short TTL cache/);
  assert.match(mockProvider(prompt), /freshness|invalidation/i);
});

test("consecutive follow-ups preserve the original topic in recent conversation", () => {
  const transcript = new TranscriptBuffer();
  ["What is Docker?", "Where have you used it?", "What problems did it solve?", "What would you do differently?"]
    .forEach((line, index) => transcript.append(line, "stt", 1_000 + index, "interviewer"));
  const answerContext = buildAnswerContext({
    transcript: transcript.snapshot(),
    mode: "technical_qa",
    userInput: "interviewer: What would you do differently?",
  });

  assert.equal(answerContext.currentQuestion.content, "What would you do differently?");
  assert.ok(answerContext.recentTurns.some((turn) => /Docker/i.test(turn.content)));
});

test("explicit topic switch makes the latest topic available for their", () => {
  const transcript = new TranscriptBuffer();
  ["What is HTML?", "When would you use it?", "Now explain database indexes.", "What are their disadvantages?"]
    .forEach((line, index) => transcript.append(line, "stt", 1_000 + index, "interviewer"));
  const prompt = buildPrompt(createGlobalContext({ activeMode: "technical_qa", transcript: transcript.snapshot() }), "interviewer: What are their disadvantages?");

  assert.match(prompt.user, /Now explain database indexes/);
  assert.match(mockProvider(prompt), /indexes/i);
});

test("non-actionable fillers do not replace the useful antecedent", () => {
  const transcript = new TranscriptBuffer();
  ["What is Kubernetes?", "Okay.", "Right.", "And where would you use it?"]
    .forEach((line, index) => transcript.append(line, "stt", 1_000 + index, "interviewer"));
  const answerContext = buildAnswerContext({
    transcript: transcript.snapshot(),
    mode: "technical_qa",
    userInput: "interviewer: And where would you use it?",
  });

  assert.equal(answerContext.currentQuestion.content, "And where would you use it?");
  assert.ok(answerContext.recentTurns.some((turn) => /Kubernetes/i.test(turn.content)));
});

test("interviewer correction updates the active referent", () => {
  const transcript = new TranscriptBuffer();
  ["Tell me about Redis.", "Actually, I meant RabbitMQ.", "Where did you use it?"]
    .forEach((line, index) => transcript.append(line, "stt", 1_000 + index, "interviewer"));
  const answerContext = buildAnswerContext({
    transcript: transcript.snapshot(),
    mode: "technical_qa",
    userInput: "interviewer: Where did you use it?",
  });
  const recent = answerContext.recentTurns.map((turn) => turn.content).join("\n");

  assert.match(recent, /RabbitMQ/);
  assert.equal(answerContext.currentQuestion.content, "Where did you use it?");
});

test("cumulative STT fragments compact into the final question", () => {
  const transcript = new TranscriptBuffer();
  ["What is...", "What is HTML...", "What is HTML and where...", "What is HTML and where would you use it?"]
    .forEach((line, index) => transcript.append(line, "stt", 1_000 + index, "interviewer"));
  const answerContext = buildAnswerContext({ transcript: transcript.snapshot(), mode: "technical_qa" });

  assert.equal(answerContext.currentQuestion.content, "What is HTML and where would you use it?");
  assert.equal(answerContext.recentTurns.filter((turn) => /What is HTML/i.test(turn.content)).length, 0);
});

test("long transcript compacts without losing active topic, current question, or recent references", () => {
  const transcript = new TranscriptBuffer();
  for (let index = 0; index < 220; index += 1) {
    transcript.append(`Old unrelated exchange ${index} about background details and filler context.`, "stt", 1_000 + index, "interviewer");
  }
  transcript.append("What is PostgreSQL?", "stt", 2_000, "interviewer");
  transcript.append("PostgreSQL is a relational database.", "manual", 2_001, "assistant");
  transcript.append("When would you use it?", "stt", 2_002, "interviewer");
  const answerContext = buildAnswerContext({
    transcript: transcript.snapshot(),
    mode: "technical_qa",
    userInput: "interviewer: When would you use it?",
    maxContextChars: 1_200,
  });

  assert.equal(answerContext.compactionApplied, true);
  assert.equal(answerContext.currentQuestion.content, "When would you use it?");
  assert.ok(answerContext.recentTurns.some((turn) => /PostgreSQL/i.test(turn.content)));
  assert.ok(answerContext.previousAssistantAnswers.some((turn) => /relational database/i.test(turn.content)));
  assert.ok(answerContext.trace.excludedTurnIds.length > 0);
});

test("sessions remain separated by using only the supplied transcript snapshot", () => {
  const oldSession = new TranscriptBuffer();
  oldSession.append("What is HTML?", "stt", 1_000, "interviewer");
  const newSession = new TranscriptBuffer();
  newSession.append("What is Redis?", "stt", 2_000, "interviewer");

  const answerContext = buildAnswerContext({ transcript: newSession.snapshot(), mode: "technical_qa", sessionId: "new" });

  assert.equal(answerContext.sessionId, "new");
  assert.doesNotMatch(answerContext.recentTurns.map((turn) => turn.content).join("\n"), /HTML/);
  assert.equal(answerContext.currentQuestion.content, "What is Redis?");
});

test("mode context is explicit and does not inherit incompatible prior mode state", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("Tell me about a conflict with a stakeholder.", "stt", 1_000, "interviewer");
  const answerContext = buildAnswerContext({
    transcript: transcript.snapshot(),
    mode: "behavioral",
    userInput: "interviewer: Tell me about a conflict with a stakeholder.",
  });

  assert.equal(answerContext.mode, "behavioral");
  assert.equal(answerContext.trace.mode, "behavioral");
});

test("failed answer is not recorded as a valid assistant antecedent", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("What is Redis?", "stt", 1_000, "interviewer");
  transcript.append("When would you use it?", "stt", 2_000, "interviewer");
  const answerContext = buildAnswerContext({ transcript: transcript.snapshot(), mode: "technical_qa" });

  assert.equal(answerContext.previousAssistantAnswers.length, 0);
  assert.equal(answerContext.trace.previousAnswerIncluded, false);
});

test("manual question without STT enters the same context contract", () => {
  const transcript = new TranscriptBuffer();
  const answerContext = buildAnswerContext({
    transcript: transcript.snapshot(),
    mode: "technical_qa",
    userInput: "What is a message queue?",
    now: 42,
  });

  assert.equal(answerContext.currentQuestion.id, "manual-question-42");
  assert.equal(answerContext.currentQuestion.content, "What is a message queue?");
  assert.equal(answerContext.currentQuestion.source, "manual");
});

test("conversation window can exclude turns older than a freshness cutoff", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("Given a linked list, group odd and even nodes.", "stt", 1_000, "interviewer");
  transcript.append("Now determine if this binary tree is a valid BST.", "stt", 1_000_000, "interviewer");

  const window = formatConversationWindow(transcript.snapshot(), "", 10, { minTimestamp: 900_000 });

  assert.doesNotMatch(window, /linked list/i);
  assert.match(window, /valid BST/i);
});

test("fresh live coding screen prevents stale transcript from becoming current question", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("Given a linked list, group odd and even nodes.", "stt", 1_000, "interviewer");
  const screenContext = classifyScreenText("Q2. Given the root of a binary tree, determine if it is a valid binary search tree (BST).");
  screenContext.capturedAt = 1_000_000;

  const answerContext = buildAnswerContext({
    transcript: transcript.snapshot(),
    mode: "live_coding",
    screenContext,
    now: 1_000_100,
  });

  assert.equal(answerContext.currentQuestion.content, "");
  assert.doesNotMatch(formatAnswerContextSection([answerContext.currentQuestion]), /linked list/i);
});

test("fresh live coding screen excludes stale previous assistant answers", () => {
  const transcript = new TranscriptBuffer();
  transcript.append("Given a linked list, group odd and even nodes.", "stt", 1_000, "interviewer");
  transcript.append("Use odd and even pointers for the linked list.", "manual", 2_000, "assistant");
  const screenContext = classifyScreenText("Q2. Given the root of a binary tree, determine if it is a valid binary search tree (BST).");
  screenContext.capturedAt = 1_000_000;

  const prompt = buildPrompt(createGlobalContext({
    activeMode: "live_coding",
    transcript: transcript.snapshot(),
    screenContext,
  }), "");

  const currentQuestion = prompt.user.match(/<current_question>\n([\s\S]*?)\n<\/current_question>/)?.[1] ?? "";
  const previousAnswers = prompt.user.match(/<previous_assistant_answers>\n([\s\S]*?)\n<\/previous_assistant_answers>/)?.[1] ?? "";
  assert.doesNotMatch(currentQuestion, /linked list/i);
  assert.doesNotMatch(previousAnswers, /linked list/i);
  assert.match(prompt.user, /<screen_context>[\s\S]*binary search tree/i);
});

test("new exercise reset leaves subsequent live coding prompt without prior transcript, answer, or solution code", () => {
  const previousExercise = new TranscriptBuffer();
  previousExercise.append("Solve the old array problem.", "stt", 1_000, "interviewer");
  previousExercise.append("def old_solution(): return 1", "manual", 2_000, "assistant");

  const resetTranscript = new TranscriptBuffer().snapshot();
  const prompt = buildPrompt(createGlobalContext({
    activeMode: "live_coding",
    transcript: resetTranscript,
    screenContext: classifyScreenText(""),
  }), "interviewer: Start the next exercise.");
  const answerContext = buildAnswerContext({
    transcript: resetTranscript,
    mode: "live_coding",
    userInput: "interviewer: Start the next exercise.",
  });

  assert.equal(answerContext.recentTurns.length, 0);
  assert.equal(answerContext.previousAssistantAnswers.length, 0);
  assert.doesNotMatch(prompt.user, /old array problem/i);
  assert.doesNotMatch(prompt.user, /old_solution/i);
  assert.doesNotMatch(prompt.user, /previous_solution_code/i);
});

test("live coding prompt places technical screen focus before raw player text", () => {
  const screenContext = classifyScreenText([
    "The image shows a screenshot with a video player and replay controls.",
    "Need some interview practice? interviewing.io/signup",
    "Given the root of a binary tree, determine if it is a valid binary search tree.",
    "Use bounds while recursing through left and right subtrees.",
  ].join("\n"));

  const prompt = buildPrompt(createGlobalContext({
    activeMode: "live_coding",
    screenContext,
  }), "");
  const screenSection = prompt.user.match(/<screen_context>\n([\s\S]*?)\n<\/screen_context>/)?.[1] ?? "";

  assert.match(screenSection, /technical_focus:/);
  assert.match(screenSection, /valid binary search tree/i);
  assert.doesNotMatch(screenSection.split("technical_focus:")[1]?.split("raw_visible_text:")[0] ?? "", /video player|signup/i);
});
