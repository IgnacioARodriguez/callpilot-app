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
  const overlay = read("src/overlay/OverlayApp.tsx");
  const codingOverlay = read("src/overlay/CodingOverlayApp.tsx");

  for (const needle of ["session:start", "session:end", "answer:request", "answer:manual-request", "answer:headline", "answer:detail-chunk", "transcript:message"]) {
    assert.match(`${main}\n${preload}`, new RegExp(needle.replace(":", ":")));
  }
  assert.match(overlay, /cp-overlay/);
  assert.match(overlay, /requestAnswer/);
  assert.match(overlay, /renderFormattedText/);
  assert.match(overlay, /cp-rich-text/);
  assert.match(main, /pendingDetailChunks/);
  assert.match(codingOverlay, /cp-code-panel/);
  assert.match(codingOverlay, /cp-reasoning-panel/);
  assert.match(codingOverlay, /starterCode/);
});

test("acceptance: answer providers are routed through a registry", () => {
  const main = read("electron/main.cjs");

  assert.match(main, /providerPresets/);
  assert.match(main, /protocol:\s*"openai_chat"/);
  assert.match(main, /protocol:\s*"openai_responses"/);
  assert.match(main, /generateWithOpenAICompatibleChat/);
  assert.match(main, /nvidia/);
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
