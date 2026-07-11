import { performance } from "node:perf_hooks";
import {
  buildPrompt,
  createGlobalContext,
  createLatencyMetricRun,
  markLatencyStage,
  pickEvidence,
  pickEvidenceWithEmbeddings,
  type EvidenceEmbedder,
} from "../src/core/index.ts";

const iterations = Number(process.env.CALLPILOT_BENCH_ITERATIONS ?? 200);

const context = createGlobalContext({
  companyName: "Acme",
  roleTitle: "Senior Backend Engineer",
  resumeText: Array.from({ length: 30 }, (_, index) =>
    `Project ${index}: Built payments reconciliation services with PostgreSQL, queues, observability, and audit controls.`,
  ).join("\n\n"),
  starStories: Array.from({ length: 20 }, (_, index) =>
    `STAR ${index}: I handled a tradeoff between consistency and latency by using SQL transactions and idempotent workers.`,
  ).join("\n\n"),
  jobDescription: "Backend role focused on distributed systems, payments, SQL, APIs, reliability, and ownership.",
});

const question = "Why did you choose SQL instead of NoSQL for financial reconciliation?";

const time = async (label: string, fn: () => void | Promise<void>) => {
  const started = performance.now();
  await fn();
  const elapsedMs = performance.now() - started;
  return {
    label,
    iterations,
    totalMs: Number(elapsedMs.toFixed(2)),
    avgMs: Number((elapsedMs / iterations).toFixed(3)),
  };
};

const embedder: EvidenceEmbedder = async (texts) => texts.map((text) => ({
  text,
  vector: /sql|postgres|financial|reconciliation|transaction/i.test(text) ? [1, 0, 0] : [0, 1, 0],
}));

const results = [];

results.push(await time("pickEvidence lexical", () => {
  for (let index = 0; index < iterations; index += 1) {
    pickEvidence(context, question, 4);
  }
}));

results.push(await time("pickEvidence embeddings cached-sim", async () => {
  for (let index = 0; index < iterations; index += 1) {
    await pickEvidenceWithEmbeddings(context, question, embedder, 4);
  }
}));

results.push(await time("buildPrompt", () => {
  for (let index = 0; index < iterations; index += 1) {
    buildPrompt(context, question);
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
  results,
  latencySmoke: latency,
};

console.log(JSON.stringify(report, null, 2));

const failures = results.filter((result) => result.avgMs > 25);
if (failures.length > 0) {
  console.error(`Benchmark threshold exceeded: ${failures.map((item) => `${item.label} ${item.avgMs}ms`).join(", ")}`);
  process.exit(1);
}
