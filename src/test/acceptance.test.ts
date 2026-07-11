import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPrompt,
  createGlobalContext,
  pickEvidenceWithEmbeddings,
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

  for (const needle of ["session:start", "session:end", "answer:headline", "answer:detail-chunk", "transcript:message"]) {
    assert.match(`${main}\n${preload}`, new RegExp(needle.replace(":", ":")));
  }
  assert.match(overlay, /cp-overlay/);
  assert.match(main, /pendingDetailChunks/);
});
