import { performance } from "node:perf_hooks";
import {
  assembleTurn,
  buildPrompt,
  classifyScreenText,
  compactTranscript,
  createGlobalContext,
  createLatencyMetricRun,
  createTurnAssemblerState,
  formatConversationWindow,
  markLatencyStage,
  pickEvidence,
  pickEvidenceWithEmbeddings,
  TranscriptBuffer,
  type EvidenceEmbedder,
} from "../src/core/index.ts";

const iterations = Number(process.env.CALLPILOT_BENCH_ITERATIONS ?? 200);
const largeIterations = Math.max(20, Math.floor(iterations / 5));

interface BenchResult {
  label: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  thresholdMs: number;
  ok: boolean;
}

const makeResumeLine = (index: number) =>
  `Project ${index}: Built payments reconciliation services with PostgreSQL, queues, observability, idempotency keys, audit controls, and incident review notes.`;

const makeStarStory = (index: number) =>
  `STAR ${index}: Situation: settlement reports drifted under retries. Task: keep financial data consistent. Action: used SQL transactions, outbox workers, idempotent consumers, dashboards, and rollout checks. Result: fewer manual audits and faster close.`;

const smallContext = createGlobalContext({
  companyName: "Acme",
  roleTitle: "Senior Backend Engineer",
  resumeText: Array.from({ length: 30 }, (_, index) => makeResumeLine(index)).join("\n\n"),
  starStories: Array.from({ length: 20 }, (_, index) => makeStarStory(index)).join("\n\n"),
  jobDescription: "Backend role focused on distributed systems, payments, SQL, APIs, reliability, and ownership.",
});

const longTranscript = new TranscriptBuffer(undefined, 1_000);
for (let index = 0; index < 900; index += 1) {
  const speaker = index % 3 === 1 ? "candidate" : "interviewer";
  const text = speaker === "candidate"
    ? `Candidate answer ${index}: I would make this reliable with idempotency, retries, metrics, and a rollback plan.`
    : `Interviewer turn ${index}: Can you explain the tradeoff between SQL consistency and queue latency for payment reconciliation?`;
  longTranscript.append(text, "stt", 1_700_000_000_000 + index * 1_500, speaker);
}

const largeContext = createGlobalContext({
  companyName: "Ebury",
  roleTitle: "Senior Backend Engineer",
  activeMode: "technical_qa",
  preferredLanguage: "english",
  resumeText: Array.from({ length: 180 }, (_, index) => makeResumeLine(index)).join("\n\n"),
  starStories: Array.from({ length: 80 }, (_, index) => makeStarStory(index)).join("\n\n"),
  jobDescription: Array.from({ length: 40 }, (_, index) =>
    `Requirement ${index}: backend ownership, distributed systems, SQL, payments, observability, incident response, and pragmatic communication.`,
  ).join("\n"),
  userNotes: "Prefer crisp interview-ready answers with one concrete project tradeoff.",
  transcript: longTranscript.snapshot(),
  screenContext: classifyScreenText([
    "Two Sum",
    "Given nums and target, return two indices.",
    "Constraints: 2 <= nums.length <= 10^4",
    "Editor: Python solution stub visible",
  ].join("\n")),
});

const question = "Why did you choose SQL instead of NoSQL for financial reconciliation?";

const time = async (
  label: string,
  thresholdMs: number,
  fn: () => void | Promise<void>,
  count = iterations,
): Promise<BenchResult> => {
  const started = performance.now();
  await fn();
  const elapsedMs = performance.now() - started;
  const avgMs = Number((elapsedMs / count).toFixed(3));
  return {
    label,
    iterations: count,
    totalMs: Number(elapsedMs.toFixed(2)),
    avgMs,
    thresholdMs,
    ok: avgMs <= thresholdMs,
  };
};

const embedder: EvidenceEmbedder = async (texts) => texts.map((text) => ({
  text,
  vector: /sql|postgres|financial|reconciliation|transaction/i.test(text) ? [1, 0, 0] : [0, 1, 0],
}));

const results = [];

results.push(await time("pickEvidence lexical small", 5, () => {
  for (let index = 0; index < iterations; index += 1) {
    pickEvidence(smallContext, question, 4);
  }
}));

results.push(await time("pickEvidence embeddings cached-sim small", 8, async () => {
  for (let index = 0; index < iterations; index += 1) {
    await pickEvidenceWithEmbeddings(smallContext, question, embedder, 4);
  }
}));

results.push(await time("buildPrompt small", 8, () => {
  for (let index = 0; index < iterations; index += 1) {
    buildPrompt(smallContext, question);
  }
}));

results.push(await time("compactTranscript 60min", 15, () => {
  for (let index = 0; index < largeIterations; index += 1) {
    compactTranscript(longTranscript.snapshot(), 6000, 80);
    formatConversationWindow(longTranscript.snapshot(), "", 12);
  }
}, largeIterations));

results.push(await time("pickEvidence lexical large", 20, () => {
  for (let index = 0; index < largeIterations; index += 1) {
    pickEvidence(largeContext, question, 6);
  }
}, largeIterations));

results.push(await time("buildPrompt maximum context", 25, () => {
  for (let index = 0; index < largeIterations; index += 1) {
    buildPrompt(largeContext, "interviewer: Why did you choose SQL instead of NoSQL for payment reconciliation?");
  }
}, largeIterations));

results.push(await time("turnAssembler 100 STT events", 2, () => {
  for (let index = 0; index < iterations; index += 1) {
    const state = createTurnAssemblerState();
    for (let eventIndex = 0; eventIndex < 100; eventIndex += 1) {
      assembleTurn(state, {
        speaker: "interviewer",
        text: eventIndex % 5 === 4
          ? "Can you explain how retries work with idempotency keys?"
          : `Can you explain how retries work with idempotency key${eventIndex}`,
        isFinal: eventIndex % 5 === 4,
        timestamp: 1_700_000_000_000 + eventIndex * 250,
      });
    }
  }
}));

const latency = markLatencyStage(
  markLatencyStage(createLatencyMetricRun("benchmark", 1000), "model_call_start", 1010),
  "first_token",
  1110,
);

const report = {
  generatedAt: new Date().toISOString(),
  iterations,
  largeIterations,
  results,
  latencySmoke: latency,
};

console.log(JSON.stringify(report, null, 2));

const failures = results.filter((result) => !result.ok);
if (failures.length > 0) {
  console.error(`Benchmark threshold exceeded: ${failures.map((item) => `${item.label} ${item.avgMs}ms > ${item.thresholdMs}ms`).join(", ")}`);
  process.exit(1);
}
