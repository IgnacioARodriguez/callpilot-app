import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { loadDotEnv } = require("../electron/env.cjs");
loadDotEnv(root);

const apiKey = process.env.GROQ_API_KEY || process.env.CALLPILOT_GROQ_API_KEY || "";
const baseUrl = (process.env.CALLPILOT_GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
const model = process.env.CALLPILOT_GROQ_MODEL || "llama-3.3-70b-versatile";

if (!apiKey) {
  console.log(JSON.stringify({
    ok: false,
    provider: "groq",
    reason: "GROQ_API_KEY or CALLPILOT_GROQ_API_KEY is not set.",
  }, null, 2));
  process.exit(0);
}

const startedAt = Date.now();
const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    stream: false,
    max_tokens: 16,
    messages: [
      { role: "system", content: "Reply with OK only." },
      { role: "user", content: "health check" },
    ],
  }),
});

const payload = await response.json().catch(() => ({}));
const text = payload?.choices?.[0]?.message?.content ?? "";
const result = {
  ok: response.ok && Boolean(String(text).trim()),
  provider: "groq",
  model,
  status: response.status,
  durationMs: Date.now() - startedAt,
  textPreview: String(text).trim().slice(0, 40),
  error: response.ok ? undefined : payload?.error?.message ?? payload?.error ?? `groq_http_${response.status}`,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
