import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { loadDotEnv } = require("../electron/env.cjs");
loadDotEnv(root);

const apiKey = process.env.NVIDIA_API_KEY || process.env.CALLPILOT_NVIDIA_API_KEY || "";
const baseUrl = (process.env.CALLPILOT_NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");

if (!apiKey) {
  console.log(JSON.stringify({
    ok: false,
    reason: "NVIDIA_API_KEY or CALLPILOT_NVIDIA_API_KEY is not set.",
  }, null, 2));
  process.exit(0);
}

const response = await fetch(`${baseUrl}/models`, {
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  },
});

const bodyText = await response.text();
let body = null;
try {
  body = bodyText ? JSON.parse(bodyText) : null;
} catch {
  body = { raw: bodyText.slice(0, 500) };
}

const headers = {};
for (const [key, value] of response.headers.entries()) {
  if (/rate|limit|quota|remaining|reset|credit/i.test(key)) headers[key] = value;
}

const models = Array.isArray(body?.data)
  ? body.data.map((model) => model?.id).filter(Boolean)
  : [];

console.log(JSON.stringify({
  ok: response.ok,
  status: response.status,
  baseUrl,
  rateOrQuotaHeaders: headers,
  modelCount: models.length,
  sampleModels: models.slice(0, 30),
  visionModelHints: models.filter((id) => /vision|vlm|omni|ocr|image|cosmos|qwen.*vl|llava|pixtral/i.test(id)).slice(0, 30),
}, null, 2));
