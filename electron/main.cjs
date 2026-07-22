const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, safeStorage, screen, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createWorker } = require("tesseract.js");
const { loadDotEnv } = require("./env.cjs");

loadDotEnv();

if (process.env.CALLPILOT_USER_DATA_DIR) {
  app.setPath("userData", path.resolve(process.env.CALLPILOT_USER_DATA_DIR));
}

if (process.env.CALLPILOT_REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.CALLPILOT_REMOTE_DEBUG_PORT);
}

let mainWindow = null;
let overlayWindow = null;
let codingWindow = null;
let shortcutHealth = [];
let remoteControlServer = null;
let remoteControlStatus = {
  enabled: false,
  port: 0,
  mode: null,
  urls: [],
  friendlyUrls: [],
  error: "",
};
const ocrWorkers = new Map();
const nativelyStreams = new Map();
const deepgramStreams = new Map();
const activeAnswerControllers = new Map();

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(Object.assign(new Error("Request cancelled"), { name: "AbortError" }));
    return;
  }
  const timeout = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timeout);
    reject(Object.assign(new Error("Request cancelled"), { name: "AbortError" }));
  }, { once: true });
});

const isAbortError = (error) => error?.name === "AbortError" || /aborted|cancelled|canceled/i.test(String(error?.message || error || ""));
const isTransientStatus = (status) => [429, 500, 502, 503, 504].includes(Number(status));
const retryDelayMs = (attempt) => Math.min(1200, 180 * (2 ** Math.max(0, attempt - 1))) + Math.round(Math.random() * 60);

const fetchWithRetry = async (url, options = {}, meta = {}) => {
  const maxAttempts = meta.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (!isTransientStatus(response.status) || attempt >= maxAttempts) return response;
      appendTraceEvent("provider_retry_scheduled", {
        requestId: meta.requestId,
        provider: meta.provider,
        attempt,
        status: response.status,
      });
      await sleep(retryDelayMs(attempt), options.signal);
    } catch (error) {
      if ((isAbortError(error) && options.signal?.aborted) || attempt >= maxAttempts) throw error;
      appendTraceEvent("provider_retry_scheduled", {
        requestId: meta.requestId,
        provider: meta.provider,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(retryDelayMs(attempt), options.signal);
    }
  }
  throw new Error("provider_retry_exhausted");
};

const stealthState = {
  callPrivacyAllowed: true,
  overlayVisible: true,
  contentProtectionEnabled: true,
  mousePassthroughEnabled: true,
  focusMode: "passthrough",
  shortcutLayerActive: true,
};

const defaultNvidiaAnswerModel = () => (process.env.CALLPILOT_NVIDIA_MODEL || "meta/llama-3.1-8b-instruct").trim();
const defaultGroqAnswerModel = () => (process.env.CALLPILOT_GROQ_MODEL || "llama-3.3-70b-versatile").trim();

const settingsDefaults = {
  modelProvider: "openai",
  modelName: "gpt-5-mini",
  visionModelName: "meta/llama-3.2-11b-vision-instruct",
  ollamaBaseUrl: "http://localhost:11434",
  transcriptionModelName: "gpt-4o-transcribe",
  preferredLanguage: "auto",
  defaultCodingLanguage: "Python",
  answerVerbosity: "medium",
  activeMode: "live_coding",
  liveTranscriptionProvider: "local",
  liveLatencyPreset: "balanced",
  liveAudioSource: "both",
  nativelyApiKeyHint: "",
  autoAnswerCooldownMs: 12000,
  autoAnswerMinConfidence: 0.45,
};

const openAITranscriptionMaxBytes = 25 * 1024 * 1024;
const openAIBaseUrl = () => (process.env.CALLPILOT_OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
const normalizeOpenAICompatibleChatUrl = (url) => {
  const clean = String(url || "").trim().replace(/\/+$/, "");
  if (!clean) return "";
  return /\/chat\/completions$/i.test(clean) ? clean : `${clean}/chat/completions`;
};
const openAICompatibleModelsUrl = (chatUrl) => {
  const clean = String(chatUrl || "").trim().replace(/\/+$/, "");
  if (!clean) return "";
  if (/\/chat\/completions$/i.test(clean)) return clean.replace(/\/chat\/completions$/i, "/models");
  if (/\/completions$/i.test(clean)) return clean.replace(/\/completions$/i, "/models");
  return `${clean}/models`;
};
const nativelyTranscriptionUrl = () => (process.env.CALLPILOT_NATIVELY_STT_URL || "wss://api.natively.software/v1/transcribe").trim();
const nativelyLLMUrl = () => (process.env.CALLPILOT_NATIVELY_LLM_URL || "https://api.natively.software/v1/chat/completions").trim();
const deepgramTranscriptionUrl = () => (process.env.CALLPILOT_DEEPGRAM_STT_URL || "wss://api.deepgram.com/v1/listen").trim();
const defaultDeepgramModel = () => (process.env.CALLPILOT_DEEPGRAM_MODEL || "nova-3").trim();
const defaultNvidiaVisionModel = () => (process.env.CALLPILOT_NVIDIA_VISION_MODEL || settingsDefaults.visionModelName).trim();
const isLikelyVisionModel = (modelName) => /vision|vlm|omni|ocr|image|cosmos|fuyu|deplot/i.test(String(modelName || ""));
const supportedAudioMimeTypes = new Set([
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/mpga",
  "audio/m4a",
  "audio/wav",
  "audio/webm",
  "video/mp4",
]);

const userDataPath = () => app.getPath("userData");
const settingsPath = () => path.join(userDataPath(), "settings.json");
const credentialsPath = () => path.join(userDataPath(), "credentials.json");
const sessionReportsDir = () => path.join(userDataPath(), "reports", "sessions");

let activeSessionTrace = null;

const safeIsoStamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const hashText = (value) => crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
const textSummary = (value, maxPreview = 160) => {
  const text = String(value || "");
  const normalized = text.replace(/\s+/g, " ").trim();
  return {
    chars: text.length,
    lines: text ? text.split(/\r?\n/).length : 0,
    hash: hashText(text),
    preview: normalized.slice(0, maxPreview),
    truncated: normalized.length > maxPreview,
  };
};
const extractPromptSection = (promptUser, sectionName) => {
  const value = typeof promptUser === "string" ? promptUser : "";
  if (!value || !sectionName) return "";
  const match = value.match(new RegExp(`<${sectionName}>\\n([\\s\\S]*?)\\n<\\/${sectionName}>`));
  return match?.[1]?.trim() || "";
};
const promptSummary = (prompt) => ({
  system: textSummary(prompt?.system, 120),
  user: textSummary(prompt?.user, 180),
  debug: prompt?.debug ? {
    modeId: prompt.debug.modeId,
    includedSections: prompt.debug.includedSections,
    omittedSections: prompt.debug.omittedSections,
    approximateChars: prompt.debug.approximateChars,
    selectedEvidenceCount: Array.isArray(prompt.debug.selectedEvidence) ? prompt.debug.selectedEvidence.length : 0,
    evidenceQueryTerms: Array.isArray(prompt.debug.evidenceQueryTerms) ? prompt.debug.evidenceQueryTerms.slice(0, 24) : [],
    latestActionableInput: textSummary(extractPromptSection(prompt.user, "latest_actionable_input"), 320),
    userInput: textSummary(extractPromptSection(prompt.user, "user_input"), 320),
  } : null,
});

const liveSpokenPromptInstructions = [
  "Live spoken response mode.",
  "Return concise natural text that the candidate can say aloud immediately.",
  "Do not return JSON, markdown fences, schema fields, or headings.",
  "Start with the answer itself.",
  "Target 60-100 words and stay under 120 words unless code is explicitly requested.",
  "For live coding, answer the coding problem or follow-up directly; do not describe screenshot UI, buttons, players, or page chrome.",
  "For live coding, start with a natural baseline approach for new problems unless the interviewer asks to optimize or the visible constraints require the optimal algorithm.",
  "For live coding, include the current approach and time/space complexity first; mention optimization as a later iteration when useful.",
  "For live coding, include code only when the latest prompt explicitly asks to write code, fix code, or add tests.",
  "A visible problem statement or function signature is not by itself a request to output code; for an intro Answer press, explain the approach without code.",
].join("\n");

const buildLiveSpokenPrompt = (prompt) => {
  const system = String(prompt?.system ?? "")
    .split("\n")
    .filter((line) => !/output_format|raw JSON|JSON contract|required keys|markdown fences/i.test(line))
    .join("\n")
    .trim();
  const user = String(prompt?.user ?? "").replace(
    /<output_format>[\s\S]*?<\/output_format>/,
    `<output_format>\n${liveSpokenPromptInstructions}\n</output_format>`,
  );
  return {
    ...prompt,
    system: `${system}\n${liveSpokenPromptInstructions}`.trim(),
    user,
  };
};

const liveCodingChatPromptInstructions = [
  "Live coding conversation side-channel.",
  "Return a natural spoken preview that the candidate can say to the interviewer before or while coding.",
  "Use the transcript, previous assistant answers, and visible screen context to keep continuity.",
  "Write like a candidate thinking out loud: 'Voy a...', 'Empezaria por...', 'Ahora cambiaria...'.",
  "Explain the immediate plan and reasoning in simple terms, not a polished final report.",
  "Name the central constraint or bug for the current step in the spoken preview, so the interviewer hears why the next code change is correct.",
  "Start with the most natural simple version for the current request. Do not jump to optimal data structures, future follow-ups, sorting, parsing hardening, or windowing unless the interviewer has already asked for them.",
  "When the transcript says a feature is for later, explicitly frame it as later and keep the current step intentionally simple.",
  "For follow-ups, explain how you would adapt the existing solution and what small issue or requirement changed.",
  "You may use compact inline flows like strip -> lower -> return, but do not include full code blocks.",
  "Do not return JSON, markdown fences, code blocks, schema fields, headings, formal sections, or complexity sections.",
  "Do not duplicate the full reasoning or code answer; that belongs in the coding panel.",
  "Prefer 2 to 5 collaborative spoken sentences: clarify an assumption, confirm the current baseline, ask a bounded question, or explain the next change.",
  "If there is no new interviewer instruction, give a short continuation or confirmation instead of recalculating the solution.",
  "Aim for 45 to 120 words.",
].join("\n");

const buildLiveCodingChatPrompt = (prompt) => {
  const system = String(prompt?.system ?? "")
    .split("\n")
    .filter((line) => !/output_format|raw JSON|JSON contract|required keys|markdown fences/i.test(line))
    .join("\n")
    .trim();
  const user = String(prompt?.user ?? "").replace(
    /<output_format>[\s\S]*?<\/output_format>/,
    `<output_format>\n${liveCodingChatPromptInstructions}\n</output_format>`,
  );
  return {
    ...prompt,
    system: `${system}\n${liveCodingChatPromptInstructions}`.trim(),
    user,
  };
};

const resultSummary = (result) => ({
  ok: Boolean(result?.ok),
  provider: result?.provider,
  modelName: result?.modelName,
  requestId: result?.requestId,
  error: result?.error,
  text: textSummary(result?.text, 160),
});
const safeTraceStringKeys = new Set([
  "activeMode",
  "evidenceStrategy",
  "modelName",
  "provider",
  "protocol",
  "reason",
  "requestId",
  "stage",
  "status",
  "structuredKind",
]);
const sanitizeTracePayload = (value, depth = 0) => {
  if (depth > 4) return "[max_depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return textSummary(value, 140);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => sanitizeTracePayload(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/api.?key|token|secret|audio|arrayBuffer/i.test(key)) {
        output[key] = "[redacted]";
      } else if (safeTraceStringKeys.has(key) && typeof nested === "string") {
        output[key] = nested.slice(0, 160);
      } else if (/text|prompt|draft|normalized/i.test(key) && typeof nested === "string") {
        output[key] = textSummary(nested, 140);
      } else {
        output[key] = sanitizeTracePayload(nested, depth + 1);
      }
    }
    return output;
  }
  return String(value);
};
const appendTraceEvent = (type, payload = {}) => {
  if (!activeSessionTrace) return;
  activeSessionTrace.events.push({
    index: activeSessionTrace.events.length,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - activeSessionTrace.startedAtMs,
    type,
    ...payload,
  });
};
const writeActiveSessionTrace = (status = "active") => {
  if (!activeSessionTrace) return null;
  activeSessionTrace.status = status;
  activeSessionTrace.updatedAt = new Date().toISOString();
  activeSessionTrace.durationMs = Date.now() - activeSessionTrace.startedAtMs;
  fs.mkdirSync(path.dirname(activeSessionTrace.path), { recursive: true });
  const serialized = {
    ...activeSessionTrace,
    startedAtMs: undefined,
  };
  fs.writeFileSync(activeSessionTrace.path, `${JSON.stringify(serialized, null, 2)}\n`);
  return activeSessionTrace.path;
};

const sanitizeCaptureSourceName = (name) => {
  const value = String(name || "").trim();
  if (!value) return "";
  if (/callpilot e2e video player/i.test(value)) return "CallPilot E2E Video Player";
  if (/callpilot/i.test(value)) return "CallPilot window";
  if (/visual studio code|code\.exe/i.test(value)) return "Visual Studio Code window";
  if (/google chrome|chrome/i.test(value)) return "Google Chrome window";
  if (/chatgpt/i.test(value)) return "ChatGPT window";
  if (/screen|toda la pantalla|entire screen/i.test(value)) return value;
  return value.split(/\s+-\s+/).pop()?.slice(0, 80) || "Window";
};

const startSessionTrace = (options = {}) => {
  const id = `session-${safeIsoStamp()}-${crypto.randomBytes(3).toString("hex")}`;
  activeSessionTrace = {
    schemaVersion: 1,
    id,
    status: "active",
    mode: options?.mode || "technical_qa",
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    updatedAt: new Date().toISOString(),
    durationMs: 0,
    path: path.join(sessionReportsDir(), `${id}.metrics.json`),
    privacy: {
      detailedContent: false,
      storesRawAudio: false,
      storesScreenshots: false,
      storesApiKeys: false,
      transcriptTextMode: "preview_hash_only",
      promptTextMode: "preview_hash_only",
    },
    settings: (() => {
      const settings = readSettings();
      return {
        modelProvider: options?.modelProvider || settings.modelProvider,
        modelName: options?.modelName || settings.modelName,
        liveTranscriptionProvider: options?.liveTranscriptionProvider || settings.liveTranscriptionProvider,
        liveLatencyPreset: options?.liveLatencyPreset || settings.liveLatencyPreset,
        liveAudioSource: options?.liveAudioSource || settings.liveAudioSource,
        preferredLanguage: options?.preferredLanguage || settings.preferredLanguage,
        activeMode: options?.activeMode || settings.activeMode,
      };
    })(),
    events: [],
  };
  appendTraceEvent("session_started", { mode: activeSessionTrace.mode });
  writeActiveSessionTrace("active");
  return activeSessionTrace;
};
const finishSessionTrace = () => {
  if (!activeSessionTrace) return null;
  appendTraceEvent("session_ended", {});
  const tracePath = writeActiveSessionTrace("ended");
  activeSessionTrace = null;
  return tracePath;
};

const readSettings = () => {
  try {
    const settings = { ...settingsDefaults, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
    if (settings.modelProvider === "nvidia" && settings.modelName === "meta/llama-3.2-1b-instruct") {
      settings.modelName = defaultNvidiaAnswerModel();
    }
    if (settings.activeMode === "live_coding" && settings.modelProvider === "nvidia" && settings.modelName === defaultNvidiaAnswerModel()) {
      settings.modelProvider = "openai";
      settings.modelName = "gpt-5-mini";
    }
    return settings;
  } catch {
    return { ...settingsDefaults };
  }
};

const writeSettings = (settings) => {
  const next = { ...settingsDefaults, ...(settings && typeof settings === "object" ? settings : {}) };
  if (next.modelProvider === "nvidia" && next.modelName === "meta/llama-3.2-1b-instruct") {
    next.modelName = defaultNvidiaAnswerModel();
  }
  if (next.activeMode === "live_coding" && next.modelProvider === "nvidia" && next.modelName === defaultNvidiaAnswerModel()) {
    next.modelProvider = "openai";
    next.modelName = "gpt-5-mini";
  }
  fs.mkdirSync(userDataPath(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
};

const readCredentials = () => {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
  } catch {
    return {};
  }
};

const saveCredentials = (credentials) => {
  fs.mkdirSync(userDataPath(), { recursive: true });
  fs.writeFileSync(credentialsPath(), JSON.stringify(credentials, null, 2));
};

const getStoredOpenAIKey = () => {
  const encrypted = readCredentials().openaiApiKey;
  if (!encrypted || typeof encrypted !== "string" || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return "";
  }
};

const getStoredNativelyKey = () => {
  const encrypted = readCredentials().nativelyApiKey;
  if (!encrypted || typeof encrypted !== "string" || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return "";
  }
};

const getStoredDeepgramKey = () => {
  const encrypted = readCredentials().deepgramApiKey;
  if (!encrypted || typeof encrypted !== "string" || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return "";
  }
};

const getStoredNvidiaKey = () => {
  const encrypted = readCredentials().nvidiaApiKey;
  if (!encrypted || typeof encrypted !== "string" || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return "";
  }
};

const getStoredGroqKey = () => {
  const encrypted = readCredentials().groqApiKey;
  if (!encrypted || typeof encrypted !== "string" || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return "";
  }
};

const credentialStatus = () => {
  const hasOpenAIStoredKey = Boolean(getStoredOpenAIKey());
  const hasNativelyStoredKey = Boolean(getStoredNativelyKey());
  const hasDeepgramStoredKey = Boolean(getStoredDeepgramKey());
  const hasNvidiaStoredKey = Boolean(getStoredNvidiaKey());
  const hasGroqStoredKey = Boolean(getStoredGroqKey());
  const hasOpenAIEnvKey = Boolean(process.env.OPENAI_API_KEY);
  const hasNativelyEnvKey = Boolean(process.env.NATIVELY_API_KEY);
  const hasDeepgramEnvKey = Boolean(process.env.DEEPGRAM_API_KEY || process.env.CALLPILOT_DEEPGRAM_API_KEY);
  const hasNvidiaEnvKey = Boolean(process.env.NVIDIA_API_KEY || process.env.CALLPILOT_NVIDIA_API_KEY);
  const hasGroqEnvKey = Boolean(process.env.GROQ_API_KEY || process.env.CALLPILOT_GROQ_API_KEY);
  return {
    ok: true,
    hasOpenAIKey: hasOpenAIStoredKey || hasOpenAIEnvKey,
    hasNativelyKey: hasNativelyStoredKey || hasNativelyEnvKey,
    hasDeepgramKey: hasDeepgramStoredKey || hasDeepgramEnvKey,
    hasNvidiaKey: hasNvidiaStoredKey || hasNvidiaEnvKey,
    hasGroqKey: hasGroqStoredKey || hasGroqEnvKey,
    hasOpenAIStoredKey,
    hasNativelyStoredKey,
    hasDeepgramStoredKey,
    hasNvidiaStoredKey,
    hasGroqStoredKey,
    hasOpenAIEnvKey,
    hasNativelyEnvKey,
    hasDeepgramEnvKey,
    hasNvidiaEnvKey,
    hasGroqEnvKey,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
};

const saveStoredOpenAIKey = (apiKey) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, hasOpenAIKey: false, hasNativelyKey: Boolean(getStoredNativelyKey()), hasDeepgramKey: Boolean(getStoredDeepgramKey()), hasNvidiaKey: Boolean(getStoredNvidiaKey()), encryptionAvailable: false, error: "safe_storage_unavailable" };
  }
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return { ...credentialStatus(), ok: false, error: "empty_api_key" };
  saveCredentials({
    ...readCredentials(),
    openaiApiKey: safeStorage.encryptString(key).toString("base64"),
  });
  return { ...credentialStatus(), ok: true };
};

const saveStoredNativelyKey = (apiKey) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, hasOpenAIKey: Boolean(getStoredOpenAIKey()), hasNativelyKey: false, hasDeepgramKey: Boolean(getStoredDeepgramKey()), hasNvidiaKey: Boolean(getStoredNvidiaKey()), encryptionAvailable: false, error: "safe_storage_unavailable" };
  }
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return { ...credentialStatus(), ok: false, error: "empty_api_key" };
  saveCredentials({
    ...readCredentials(),
    nativelyApiKey: safeStorage.encryptString(key).toString("base64"),
  });
  return { ...credentialStatus(), ok: true };
};

const saveStoredDeepgramKey = (apiKey) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, hasOpenAIKey: Boolean(getStoredOpenAIKey()), hasNativelyKey: Boolean(getStoredNativelyKey()), hasDeepgramKey: false, hasNvidiaKey: Boolean(getStoredNvidiaKey()), encryptionAvailable: false, error: "safe_storage_unavailable" };
  }
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return { ...credentialStatus(), ok: false, error: "empty_api_key" };
  saveCredentials({
    ...readCredentials(),
    deepgramApiKey: safeStorage.encryptString(key).toString("base64"),
  });
  return { ...credentialStatus(), ok: true };
};

const saveStoredNvidiaKey = (apiKey) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, hasOpenAIKey: Boolean(getStoredOpenAIKey()), hasNativelyKey: Boolean(getStoredNativelyKey()), hasDeepgramKey: Boolean(getStoredDeepgramKey()), hasNvidiaKey: false, hasGroqKey: Boolean(getStoredGroqKey()), encryptionAvailable: false, error: "safe_storage_unavailable" };
  }
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return { ...credentialStatus(), ok: false, error: "empty_api_key" };
  saveCredentials({
    ...readCredentials(),
    nvidiaApiKey: safeStorage.encryptString(key).toString("base64"),
  });
  return { ...credentialStatus(), ok: true };
};

const saveStoredGroqKey = (apiKey) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, hasOpenAIKey: Boolean(getStoredOpenAIKey()), hasNativelyKey: Boolean(getStoredNativelyKey()), hasDeepgramKey: Boolean(getStoredDeepgramKey()), hasNvidiaKey: Boolean(getStoredNvidiaKey()), hasGroqKey: false, encryptionAvailable: false, error: "safe_storage_unavailable" };
  }
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return { ...credentialStatus(), ok: false, error: "empty_api_key" };
  saveCredentials({
    ...readCredentials(),
    groqApiKey: safeStorage.encryptString(key).toString("base64"),
  });
  return { ...credentialStatus(), ok: true };
};

const clearStoredOpenAIKey = () => {
  const credentials = readCredentials();
  delete credentials.openaiApiKey;
  saveCredentials(credentials);
  return { ...credentialStatus(), ok: true };
};

const clearStoredNativelyKey = () => {
  const credentials = readCredentials();
  delete credentials.nativelyApiKey;
  saveCredentials(credentials);
  return { ...credentialStatus(), ok: true };
};

const clearStoredDeepgramKey = () => {
  const credentials = readCredentials();
  delete credentials.deepgramApiKey;
  saveCredentials(credentials);
  return { ...credentialStatus(), ok: true };
};

const clearStoredNvidiaKey = () => {
  const credentials = readCredentials();
  delete credentials.nvidiaApiKey;
  saveCredentials(credentials);
  return { ...credentialStatus(), ok: true };
};

const clearStoredGroqKey = () => {
  const credentials = readCredentials();
  delete credentials.groqApiKey;
  saveCredentials(credentials);
  return { ...credentialStatus(), ok: true };
};

const nativelyLanguageForPreference = (language) => {
  if (language === "spanish") return { language: "es-ES", alternates: ["es-ES", "en-US"] };
  if (language === "english") return { language: "en-US", alternates: ["en-US", "es-ES"] };
  return { language: "auto", alternates: ["es-ES", "en-US"] };
};

const emitNativelyStatus = (streamId, status, detail) => {
  mainWindow?.webContents.send("natively:status", { streamId, status, detail });
};

const terminalNativelyErrors = new Set([
  "auth_timeout",
  "invalid_key_format",
  "trial_expired",
  "transcription_quota_exceeded",
]);

const stopNativelyStream = (streamId) => {
  const stream = nativelyStreams.get(streamId);
  if (!stream) return { ok: true };
  nativelyStreams.delete(streamId);
  try {
    stream.ws?.close();
  } catch {}
  return { ok: true };
};

const stopAllNativelyStreams = () => {
  const streamIds = [...nativelyStreams.keys()];
  for (const streamId of streamIds) stopNativelyStream(streamId);
  return streamIds;
};

const emitDeepgramStatus = (streamId, status, detail) => {
  mainWindow?.webContents.send("deepgram:status", { streamId, status, detail });
};

const deepgramLanguageForPreference = (language) => {
  if (language === "spanish") return "es";
  if (language === "english") return "en";
  return "multi";
};

const deepgramUrlForConfig = (config) => {
  const url = new URL(deepgramTranscriptionUrl());
  url.searchParams.set("model", config.model || defaultDeepgramModel());
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", String(config.sampleRate || 16000));
  url.searchParams.set("channels", "1");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("endpointing", config.endpointingMs ? String(config.endpointingMs) : "300");
  url.searchParams.set("utterance_end_ms", config.utteranceEndMs ? String(config.utteranceEndMs) : "1000");
  if (config.language) url.searchParams.set("language", config.language);
  return url.toString();
};

const stopDeepgramStream = (streamId) => {
  const stream = deepgramStreams.get(streamId);
  if (!stream) return { ok: true };
  deepgramStreams.delete(streamId);
  try {
    stream.ws?.close();
  } catch {}
  return { ok: true };
};

const stopAllDeepgramStreams = () => {
  const streamIds = [...deepgramStreams.keys()];
  for (const streamId of streamIds) stopDeepgramStream(streamId);
  return streamIds;
};

const openDeepgramStreamSocket = (streamId, config) => {
  const WebSocketCtor = globalThis.WebSocket;
  const ws = new WebSocketCtor(deepgramUrlForConfig(config), ["token", config.apiKey]);
  const stream = {
    ws,
    queue: [],
    connected: false,
    closed: false,
    closedAudioLogged: false,
    config,
  };
  deepgramStreams.set(streamId, stream);

  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    const active = deepgramStreams.get(streamId);
    if (active?.ws !== ws) return;
    active.connected = true;
    active.closed = false;
    for (const chunk of active.queue.splice(0)) ws.send(chunk);
    emitDeepgramStatus(streamId, "connected", `Deepgram ${config.channel} stream connected`);
  });
  ws.addEventListener("message", async (event) => {
    let raw = "";
    if (typeof event.data === "string") raw = event.data;
    else if (event.data instanceof ArrayBuffer) raw = Buffer.from(event.data).toString("utf8");
    else if (event.data && typeof event.data.text === "function") raw = await event.data.text().catch(() => "");
    if (!raw) return;
    try {
      const message = JSON.parse(raw);
      if (message?.type === "Metadata" || message?.type === "SpeechStarted" || message?.type === "UtteranceEnd") {
        appendTraceEvent("deepgram_stream_event", { streamId, eventType: message.type });
        writeActiveSessionTrace("active");
        return;
      }
      const alternative = message?.channel?.alternatives?.[0];
      const text = typeof alternative?.transcript === "string" ? alternative.transcript.trim() : "";
      if (!text) return;
      const payload = {
        streamId,
        text,
        isFinal: Boolean(message.is_final || message.speech_final),
        confidence: typeof alternative.confidence === "number" ? alternative.confidence : 1,
      };
      appendTraceEvent("deepgram_transcript", {
        streamId,
        isFinal: payload.isFinal,
        confidence: payload.confidence,
        text: textSummary(payload.text, 120),
      });
      writeActiveSessionTrace("active");
      mainWindow?.webContents.send("deepgram:transcript", payload);
    } catch {
      appendTraceEvent("deepgram_stream_malformed_event", { streamId, raw: textSummary(raw, 120) });
      writeActiveSessionTrace("active");
    }
  });
  ws.addEventListener("error", () => {
    appendTraceEvent("deepgram_stream_error", { streamId, error: "websocket_error" });
    writeActiveSessionTrace("active");
    emitDeepgramStatus(streamId, "error", "Deepgram WebSocket error");
  });
  ws.addEventListener("close", (event) => {
    const active = deepgramStreams.get(streamId);
    if (!active || active.ws !== ws) return;
    active.connected = false;
    active.closed = true;
    const detail = event?.reason ? String(event.reason).slice(0, 160) : "Deepgram stream closed";
    appendTraceEvent("deepgram_stream_closed", { streamId, code: event?.code, reason: detail });
    writeActiveSessionTrace("active");
    emitDeepgramStatus(streamId, "closed", detail);
  });
  return stream;
};

const openNativelyStreamSocket = (streamId, config, existing = {}) => {
  const WebSocketCtor = globalThis.WebSocket;
  const ws = new WebSocketCtor(nativelyTranscriptionUrl());
  const stream = {
    ws,
    queue: existing.queue || [],
    connected: false,
    closed: false,
    terminal: false,
    reconnects: existing.reconnects || 0,
    config,
  };
  nativelyStreams.set(streamId, stream);

  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    const active = nativelyStreams.get(streamId);
    if (active?.ws !== ws) return;
    active.connected = true;
    active.closed = false;
    ws.send(JSON.stringify({
      key: config.apiKey,
      sample_rate: config.sampleRate,
      audio_channels: 1,
      language: config.language.language,
      language_alternates: config.language.alternates,
      channel: config.channel,
    }));
    for (const chunk of active.queue.splice(0)) ws.send(chunk);
    emitNativelyStatus(streamId, "connected", `Natively ${config.channel} stream connected`);
  });
  ws.addEventListener("message", async (event) => {
    let raw = "";
    if (typeof event.data === "string") raw = event.data;
    else if (event.data instanceof ArrayBuffer) raw = Buffer.from(event.data).toString("utf8");
    else if (event.data && typeof event.data.text === "function") raw = await event.data.text().catch(() => "");
    if (!raw) return;
    try {
      const message = JSON.parse(raw);
      if (message?.error) {
        appendTraceEvent("natively_stream_error", {
          streamId,
          error: String(message.error),
        });
        writeActiveSessionTrace("active");
        emitNativelyStatus(streamId, "error", String(message.error));
        if (terminalNativelyErrors.has(message.error)) {
          const active = nativelyStreams.get(streamId);
          if (active) active.terminal = true;
          stopNativelyStream(streamId);
        }
        return;
      }
      if (message?.language_detected) {
        emitNativelyStatus(streamId, "language", `Detected ${message.language_detected}`);
      }
      if (typeof message?.text === "string" && message.text.trim()) {
        const payload = {
          streamId,
          text: message.text.trim(),
          isFinal: Boolean(message.is_final),
          confidence: typeof message.confidence === "number" ? message.confidence : 1,
        };
        appendTraceEvent("natively_transcript", {
          streamId,
          isFinal: payload.isFinal,
          confidence: payload.confidence,
          text: textSummary(payload.text, 120),
        });
        writeActiveSessionTrace("active");
        mainWindow?.webContents.send("natively:transcript", payload);
      }
    } catch {
      emitNativelyStatus(streamId, "message", raw.slice(0, 200));
    }
  });
  ws.addEventListener("error", () => {
    appendTraceEvent("natively_stream_error", { streamId, error: "websocket_error" });
    writeActiveSessionTrace("active");
    emitNativelyStatus(streamId, "error", "Natively WebSocket error");
  });
  ws.addEventListener("close", () => {
    const active = nativelyStreams.get(streamId);
    if (!active || active.ws !== ws) return;
    active.connected = false;
    active.closed = true;
    appendTraceEvent("natively_stream_closed", { streamId });
    writeActiveSessionTrace("active");
    emitNativelyStatus(streamId, "closed", "Natively stream closed");
  });
  return stream;
};

const reconnectNativelyStream = (streamId, stream, audioBuffer) => {
  if (!stream?.config || stream.terminal) return { ok: false, error: "natively_stream_not_started" };
  if (stream.reconnects >= 3) return { ok: false, error: "natively_stream_reconnect_limit" };
  const nextQueue = [...(stream.queue || []), audioBuffer].slice(-500);
  const reconnects = stream.reconnects + 1;
  appendTraceEvent("natively_stream_reconnecting", {
    streamId,
    channel: stream.config.channel,
    reconnects,
    queuedFrames: nextQueue.length,
  });
  writeActiveSessionTrace("active");
  try {
    stream.ws?.close();
  } catch {}
  openNativelyStreamSocket(streamId, stream.config, { queue: nextQueue, reconnects });
  emitNativelyStatus(streamId, "reconnecting", `Natively ${stream.config.channel} stream reconnecting`);
  return { ok: true, reconnected: true };
};

const extractOpenAIResponseText = (response) => {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  if (!Array.isArray(response?.output)) return "";
  return response.output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
};

const createPromptCacheKey = (prompt) => {
  const stablePrefix = [
    String(prompt?.system ?? ""),
    String(prompt?.user ?? "").split("<transcript>")[0] ?? "",
  ].join("\n");
  return `callpilot:${crypto.createHash("sha256").update(stablePrefix).digest("hex").slice(0, 24)}`;
};

const structuredAnswerPayloadJsonSchema = {
  name: "callpilot_structured_answer",
  schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["interview", "coding"] },
      payload: {
        type: "object",
        properties: {
          version: { type: "string", enum: ["1"] },
          answerNeeded: { type: "boolean" },
          intent: { type: ["string", "null"], enum: ["technical_qa", "behavioral", "system_design", "clarification", "no_answer", null] },
          responseType: { type: ["string", "null"], enum: ["initial_solution", "explanation", "follow_up_change", "debug_fix", "clarification", null] },
          spokenAnswer: { type: "string" },
          keyPoints: { type: "array", items: { type: "string" } },
          correction: {
            type: "object",
            properties: {
              needed: { type: "boolean" },
              transition: { type: ["string", "null"] },
              correctedClaim: { type: ["string", "null"] },
            },
            required: ["needed", "transition", "correctedClaim"],
            additionalProperties: false,
          },
          assumptions: { type: "array", items: { type: "string" } },
          evidenceRefs: { type: "array", items: { type: "string" } },
          followUpHint: { type: ["string", "null"] },
          problem: {
            type: "object",
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              language: { type: "string" },
              functionSignature: { type: ["string", "null"] },
              constraints: { type: "array", items: { type: "string" } },
            },
            required: ["title", "summary", "language", "functionSignature", "constraints"],
            additionalProperties: false,
          },
          solution: {
            type: "object",
            properties: {
              approachSteps: { type: "array", items: { type: "string" } },
              code: { type: "string" },
              complexity: {
                type: "object",
                properties: {
                  time: { type: "string" },
                  space: { type: "string" },
                  rationale: { type: "string" },
                },
                required: ["time", "space", "rationale"],
                additionalProperties: false,
              },
              edgeCases: { type: "array", items: { type: "string" } },
              invariants: { type: "array", items: { type: "string" } },
            },
            required: ["approachSteps", "code", "complexity", "edgeCases", "invariants"],
            additionalProperties: false,
          },
          narration: {
            type: "object",
            properties: {
              spokenAnswer: { type: "string" },
              currentStep: { type: "string" },
            },
            required: ["spokenAnswer", "currentStep"],
            additionalProperties: false,
          },
          tests: {
            type: "array",
            items: {
              type: "object",
              properties: {
                input: { type: "string" },
                expected: { type: "string" },
                rationale: { type: "string" },
              },
              required: ["input", "expected", "rationale"],
              additionalProperties: false,
            },
          },
          patch: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["replace", "diff", "none"] },
              code: { type: ["string", "null"] },
            },
            required: ["kind", "code"],
            additionalProperties: false,
          },
        },
        required: [
          "version",
          "answerNeeded",
          "intent",
          "responseType",
          "spokenAnswer",
          "keyPoints",
          "correction",
          "assumptions",
          "evidenceRefs",
          "followUpHint",
          "problem",
          "solution",
          "narration",
          "tests",
          "patch",
        ],
        additionalProperties: false,
      },
    },
    required: ["kind", "payload"],
    additionalProperties: false,
  },
};

const extractProviderStreamDelta = (streamEvent) => {
  if (streamEvent?.type === "response.output_text.delta" && typeof streamEvent.delta === "string") {
    return streamEvent.delta;
  }
  if (!Array.isArray(streamEvent?.choices)) return "";
  return streamEvent.choices
    .map((choice) => {
      if (typeof choice?.delta?.content === "string") return choice.delta.content;
      if (Array.isArray(choice?.delta?.content)) {
        return choice.delta.content
          .map((part) => typeof part?.text === "string" ? part.text : "")
          .join("");
      }
      if (typeof choice?.text === "string") return choice.text;
      if (typeof choice?.message?.content === "string") return choice.message.content;
      return "";
    })
    .join("");
};

const readOpenAISseStream = async (response, onEvent, signal) => {
  if (!response.body) return "";
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let fullText = "";
  let malformedCount = 0;

  const consumeRawEvent = (rawEvent) => {
    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    for (const line of dataLines) {
      if (!line) continue;
      if (line === "[DONE]") continue;
      try {
        const streamEvent = JSON.parse(line);
        fullText += extractProviderStreamDelta(streamEvent);
        onEvent?.(streamEvent);
      } catch (error) {
        malformedCount += 1;
        appendTraceEvent("provider_stream_malformed_event", {
          malformedCount,
          previewHash: crypto.createHash("sha256").update(line).digest("hex").slice(0, 12),
          previewLength: line.length,
        });
      }
    }
  };

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("Request cancelled"), { name: "AbortError" });
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const rawEvent of events) {
      consumeRawEvent(rawEvent);
    }
  }
  const trailing = buffer.trim();
  if (trailing) consumeRawEvent(trailing);
  return fullText.trim();
};

const normalizeOllamaBaseUrl = (baseUrl) => {
  const normalized = typeof baseUrl === "string" ? baseUrl.trim().replace(/\/+$/, "") : "";
  return normalized || settingsDefaults.ollamaBaseUrl;
};

const extractOllamaResponseText = (response) => {
  if (typeof response?.message?.content === "string") return response.message.content.trim();
  if (typeof response?.response === "string") return response.response.trim();
  return "";
};

const extractOpenAICompatibleChatText = (response) => {
  if (Array.isArray(response?.choices)) {
    const text = response.choices
      .map((choice) => {
        if (typeof choice?.message?.content === "string") return choice.message.content;
        if (typeof choice?.text === "string") return choice.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }
  if (typeof response?.text === "string" && response.text.trim()) return response.text.trim();
  if (typeof response?.output_text === "string") return response.output_text.trim();
  return "";
};

const providerPresets = {
  mock: {
    id: "mock",
    protocol: "mock",
    defaultModel: "mock-local",
    auth: "none",
  },
  ollama: {
    id: "ollama",
    protocol: "ollama_chat",
    defaultModel: "llama3.1",
    auth: "none",
    baseUrl: () => normalizeOllamaBaseUrl(readSettings().ollamaBaseUrl),
  },
  openai: {
    id: "openai",
    protocol: "openai_responses",
    defaultModel: "",
    auth: "bearer",
    baseUrl: () => openAIBaseUrl(),
    apiKey: (input) => (typeof input?.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : process.env.OPENAI_API_KEY || getStoredOpenAIKey()),
  },
  natively: {
    id: "natively",
    protocol: "openai_chat",
    defaultModel: "default",
    auth: "bearer",
    chatUrl: () => nativelyLLMUrl(),
    apiKey: (input) => (typeof input?.nativelyApiKey === "string" && input.nativelyApiKey.trim() ? input.nativelyApiKey.trim() : getStoredNativelyKey()),
  },
  nvidia: {
    id: "nvidia",
    protocol: "openai_chat",
    defaultModel: defaultNvidiaAnswerModel(),
    auth: "bearer",
    chatUrl: () => normalizeOpenAICompatibleChatUrl(process.env.CALLPILOT_NVIDIA_LLM_URL || "https://integrate.api.nvidia.com/v1/chat/completions"),
    apiKey: (input) => (typeof input?.nvidiaApiKey === "string" && input.nvidiaApiKey.trim() ? input.nvidiaApiKey.trim() : process.env.NVIDIA_API_KEY || process.env.CALLPILOT_NVIDIA_API_KEY || getStoredNvidiaKey()),
  },
  groq: {
    id: "groq",
    protocol: "openai_chat",
    defaultModel: defaultGroqAnswerModel(),
    auth: "bearer",
    chatUrl: () => normalizeOpenAICompatibleChatUrl(process.env.CALLPILOT_GROQ_LLM_URL || "https://api.groq.com/openai/v1/chat/completions"),
    apiKey: (input) => (typeof input?.groqApiKey === "string" && input.groqApiKey.trim() ? input.groqApiKey.trim() : process.env.GROQ_API_KEY || process.env.CALLPILOT_GROQ_API_KEY || getStoredGroqKey()),
  },
};

const resolveAnswerProvider = (input) => {
  const requested = typeof input?.provider === "string" ? input.provider : "mock";
  return providerPresets[requested] ?? providerPresets.mock;
};

const resolveAnswerModel = (provider, input) => {
  const value = typeof input?.modelName === "string" && input.modelName.trim() ? input.modelName.trim() : "";
  return value || provider.defaultModel || "";
};

const createAnswerRequestId = (input) => {
  const requested = typeof input?.requestId === "string" && input.requestId.trim() ? input.requestId.trim() : "";
  return requested || `answer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

const generateWithOllamaChat = async ({ provider, input, prompt, modelName, signal }) => {
  const baseUrl = normalizeOllamaBaseUrl(input?.ollamaBaseUrl || provider.baseUrl?.());
  const maxTokens = Number.isFinite(Number(input?.maxTokens)) ? Math.max(64, Math.min(2048, Math.round(Number(input.maxTokens)))) : undefined;
  const requestId = input.requestId;
  const providerStartedAt = Date.now();
  try {
    appendTraceEvent("provider_request_started", {
      requestId,
      provider: provider.id,
      modelName,
      protocol: provider.protocol,
      stream: false,
      structuredOutput: false,
      maxTokens,
    });
    writeActiveSessionTrace("active");
    const response = await fetchWithRetry(`${baseUrl}/api/chat`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        stream: false,
        ...(maxTokens ? { options: { num_predict: maxTokens } } : {}),
        messages: [
          { role: "system", content: String(prompt?.system ?? "") },
          { role: "user", content: String(prompt?.user ?? "") },
        ],
      }),
    }, { requestId, provider: provider.id });
    appendTraceEvent("provider_response_headers", {
      requestId,
      provider: provider.id,
      modelName,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - providerStartedAt,
    });
    writeActiveSessionTrace("active");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      appendTraceEvent("provider_response_body_parsed", {
        requestId,
        provider: provider.id,
        modelName,
        ok: false,
        durationMs: Date.now() - providerStartedAt,
      });
      writeActiveSessionTrace("active");
      return { ok: false, text: "", provider: provider.id, modelName, requestId, error: payload?.error ?? `ollama_http_${response.status}` };
    }
    const text = extractOllamaResponseText(payload);
    appendTraceEvent("provider_response_body_parsed", {
      requestId,
      provider: provider.id,
      modelName,
      ok: Boolean(text),
      durationMs: Date.now() - providerStartedAt,
      text: textSummary(text, 120),
    });
    writeActiveSessionTrace("active");
    return { ok: Boolean(text), text, provider: provider.id, modelName, requestId, error: text ? undefined : "empty_ollama_response" };
  } catch (error) {
    return { ok: false, text: "", provider: provider.id, modelName, requestId, error: error instanceof Error ? `ollama_unavailable: ${error.message}` : "ollama_unavailable" };
  }
};

const generateWithOpenAICompatibleChat = async ({ provider, input, prompt, modelName, event, signal }) => {
  const apiKey = provider.apiKey?.(input) ?? "";
  const maxTokens = Number.isFinite(Number(input?.maxTokens)) ? Math.max(64, Math.min(2048, Math.round(Number(input.maxTokens)))) : undefined;
  const requestId = input.requestId;
  const providerStartedAt = Date.now();
  if (provider.auth === "bearer" && !apiKey) {
    return { ok: false, text: "", provider: provider.id, modelName, requestId, error: `missing_${provider.id}_api_key` };
  }
  try {
    const structuredOutput = Boolean(input?.structuredOutput);
    const liveSpokenOutput = Boolean(input?.liveSpokenOutput) && !structuredOutput;
    const audience = input?.audience === "chat" || input?.audience === "coding" ? input.audience : undefined;
    const requestPrompt = liveSpokenOutput
      ? audience === "chat" ? buildLiveCodingChatPrompt(prompt) : buildLiveSpokenPrompt(prompt)
      : prompt;
    const structuredSystemSuffix = structuredOutput
      ? "\nReturn only one valid JSON object that matches the structured answer contract in output_format. Do not wrap it in markdown, do not add prose before or after the JSON, and keep all required keys present."
      : "";
    const liveSpokenSystemSuffix = liveSpokenOutput && audience !== "chat"
      ? "\nLive interview response mode: ignore any output_format or JSON contract above. Return concise spoken text only, with no JSON and no decorative headings. For live coding, include commented code when a concrete solution or change is useful; otherwise start with the spoken answer immediately. Keep non-code narration interview-ready and under 120 words."
      : "";
    const buildBody = (includeResponseFormat, stream = false) => JSON.stringify({
      model: modelName,
      stream,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(includeResponseFormat ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: `${String(requestPrompt?.system ?? "")}${structuredSystemSuffix}${liveSpokenSystemSuffix}` },
        { role: "user", content: String(requestPrompt?.user ?? "") },
      ],
    });
    if (liveSpokenOutput) {
      let detailSequence = 0;
      let firstChunkSent = false;
      const sendDetailChunk = (chunk) => {
        if (signal?.aborted || !chunk) return;
        detailSequence += 1;
        if (!firstChunkSent) {
          firstChunkSent = true;
          appendTraceEvent("provider_stream_first_chunk", {
            requestId,
            provider: provider.id,
            modelName,
            durationMs: Date.now() - providerStartedAt,
            sequence: detailSequence,
          });
          writeActiveSessionTrace("active");
        }
        const payload = { requestId, sequence: detailSequence, text: chunk, done: false, audience };
        event?.sender?.send("answer:detail-chunk", payload);
        sendToOverlay("answer:detail-chunk", payload);
      };
      appendTraceEvent("provider_request_started", {
        requestId,
        provider: provider.id,
        modelName,
        protocol: provider.protocol,
        stream: true,
        structuredOutput: false,
        liveSpokenOutput,
        maxTokens,
      });
      writeActiveSessionTrace("active");
      const streamResponse = await fetchWithRetry(provider.chatUrl(), {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
        },
        body: buildBody(false, true),
      }, { requestId, provider: provider.id });
      appendTraceEvent("provider_response_headers", {
        requestId,
        provider: provider.id,
        modelName,
        stream: true,
        status: streamResponse.status,
        ok: streamResponse.ok,
        durationMs: Date.now() - providerStartedAt,
      });
      writeActiveSessionTrace("active");
      if (streamResponse.ok) {
        const text = await readOpenAISseStream(streamResponse, (streamEvent) => {
          sendDetailChunk(extractProviderStreamDelta(streamEvent));
        }, signal);
        const completedPayload = { requestId, sequence: detailSequence + 1, text: "", done: true, audience };
        event?.sender?.send("answer:detail-chunk", completedPayload);
        sendToOverlay("answer:detail-chunk", completedPayload);
        appendTraceEvent("provider_stream_completed", {
          requestId,
          provider: provider.id,
          modelName,
          ok: Boolean(text),
          durationMs: Date.now() - providerStartedAt,
          chunks: detailSequence,
          text: textSummary(text, 120),
        });
        writeActiveSessionTrace("active");
        return { ok: Boolean(text), text, provider: provider.id, modelName, requestId, error: text ? undefined : `empty_${provider.id}_response` };
      }
      if (![400, 404, 405, 422, 501].includes(Number(streamResponse.status))) {
        const payload = await streamResponse.json().catch(() => ({}));
        appendTraceEvent("provider_response_body_parsed", {
          requestId,
          provider: provider.id,
          modelName,
          stream: true,
          ok: false,
          durationMs: Date.now() - providerStartedAt,
        });
        writeActiveSessionTrace("active");
        return { ok: false, text: "", provider: provider.id, modelName, requestId, error: payload?.error?.message ?? payload?.error ?? `${provider.id}_http_${streamResponse.status}` };
      }
      appendTraceEvent("provider_stream_fallback_to_nonstream", { requestId, provider: provider.id, status: streamResponse.status });
      writeActiveSessionTrace("active");
    }
    const nonStreamStartedAt = Date.now();
    appendTraceEvent("provider_request_started", {
      requestId,
      provider: provider.id,
      modelName,
      protocol: provider.protocol,
      stream: false,
      structuredOutput,
      liveSpokenOutput,
      maxTokens,
    });
    writeActiveSessionTrace("active");
    let response = await fetchWithRetry(provider.chatUrl(), {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
      },
      body: buildBody(structuredOutput),
    }, { requestId, provider: provider.id });
    appendTraceEvent("provider_response_headers", {
      requestId,
      provider: provider.id,
      modelName,
      stream: false,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - nonStreamStartedAt,
      totalDurationMs: Date.now() - providerStartedAt,
    });
    writeActiveSessionTrace("active");
    let payload = await response.json().catch(() => ({}));
    if (!response.ok && structuredOutput && [400, 422].includes(response.status)) {
      appendTraceEvent("provider_structured_response_format_fallback", {
        requestId,
        provider: provider.id,
        status: response.status,
        error: payload?.error?.message ?? payload?.error,
      });
      response = await fetchWithRetry(provider.chatUrl(), {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
        },
        body: buildBody(false),
      }, { requestId, provider: provider.id, maxAttempts: 1 });
      appendTraceEvent("provider_response_headers", {
        requestId,
        provider: provider.id,
        modelName,
        stream: false,
        fallback: "without_response_format",
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - nonStreamStartedAt,
        totalDurationMs: Date.now() - providerStartedAt,
      });
      writeActiveSessionTrace("active");
      payload = await response.json().catch(() => ({}));
    }
    if (!response.ok) {
      appendTraceEvent("provider_response_body_parsed", {
        requestId,
        provider: provider.id,
        modelName,
        stream: false,
        ok: false,
        durationMs: Date.now() - nonStreamStartedAt,
        totalDurationMs: Date.now() - providerStartedAt,
      });
      writeActiveSessionTrace("active");
      return { ok: false, text: "", provider: provider.id, modelName, requestId, error: payload?.error?.message ?? payload?.error ?? `${provider.id}_http_${response.status}` };
    }
    const text = extractOpenAICompatibleChatText(payload);
    appendTraceEvent("provider_response_body_parsed", {
      requestId,
      provider: provider.id,
      modelName,
      stream: false,
      ok: Boolean(text),
      durationMs: Date.now() - nonStreamStartedAt,
      totalDurationMs: Date.now() - providerStartedAt,
      text: textSummary(text, 120),
    });
    writeActiveSessionTrace("active");
    return { ok: Boolean(text), text, provider: provider.id, modelName, requestId, error: text ? undefined : `empty_${provider.id}_response` };
  } catch (error) {
    return { ok: false, text: "", provider: provider.id, modelName, requestId, error: error instanceof Error ? `${provider.id}_unavailable: ${error.message}` : `${provider.id}_unavailable` };
  }
};

const generateWithOpenAIResponses = async ({ provider, input, prompt, modelName, event, signal }) => {
  const apiKey = provider.apiKey?.(input) ?? "";
  const requestId = input.requestId;
  const audience = input?.audience === "chat" || input?.audience === "coding" ? input.audience : undefined;
  const providerStartedAt = Date.now();
  if (!apiKey) return { ok: false, text: "", provider: provider.id, modelName, requestId, error: `missing_${provider.id}_api_key` };
  if (!modelName) return { ok: false, text: "", provider: provider.id, modelName, requestId, error: `missing_${provider.id}_model` };

  try {
    const liveSpokenOutput = Boolean(input?.liveSpokenOutput) && !input?.structuredOutput;
    const requestPrompt = liveSpokenOutput
      ? audience === "chat" ? buildLiveCodingChatPrompt(prompt) : buildLiveSpokenPrompt(prompt)
      : prompt;
    const liveSpokenSystemSuffix = liveSpokenOutput && audience !== "chat"
      ? "\nLive interview response mode: ignore any output_format or JSON contract above. Return concise spoken text only, with no JSON and no decorative headings. For live coding, include commented code when a concrete solution or change is useful; otherwise start with the spoken answer immediately. Keep non-code narration interview-ready and under 120 words."
      : "";
    const requestBase = {
      model: modelName,
      instructions: `${String(requestPrompt?.system ?? "")}${liveSpokenSystemSuffix}`,
      input: String(requestPrompt?.user ?? ""),
      prompt_cache_key: createPromptCacheKey(requestPrompt),
      store: false,
    };
    if (input?.structuredOutput) {
      appendTraceEvent("provider_request_started", {
        requestId,
        provider: provider.id,
        modelName,
        protocol: provider.protocol,
        stream: false,
        structuredOutput: true,
        liveSpokenOutput,
      });
      writeActiveSessionTrace("active");
      const structuredResponse = await fetchWithRetry(`${provider.baseUrl()}/v1/responses`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          ...requestBase,
          text: {
            format: {
              type: "json_schema",
              name: structuredAnswerPayloadJsonSchema.name,
              strict: true,
              schema: structuredAnswerPayloadJsonSchema.schema,
            },
          },
        }),
      }, { requestId, provider: provider.id });
      appendTraceEvent("provider_response_headers", {
        requestId,
        provider: provider.id,
        modelName,
        stream: false,
        status: structuredResponse.status,
        ok: structuredResponse.ok,
        durationMs: Date.now() - providerStartedAt,
      });
      writeActiveSessionTrace("active");
      const payload = await structuredResponse.json().catch(() => ({}));
      if (!structuredResponse.ok) {
        appendTraceEvent("provider_response_body_parsed", {
          requestId,
          provider: provider.id,
          modelName,
          stream: false,
          ok: false,
          durationMs: Date.now() - providerStartedAt,
        });
        writeActiveSessionTrace("active");
        return { ok: false, text: "", provider: provider.id, modelName, requestId, error: payload?.error?.message ?? `${provider.id}_structured_http_${structuredResponse.status}` };
      }
      const text = extractOpenAIResponseText(payload);
      appendTraceEvent("provider_response_body_parsed", {
        requestId,
        provider: provider.id,
        modelName,
        stream: false,
        ok: Boolean(text),
        durationMs: Date.now() - providerStartedAt,
        text: textSummary(text, 120),
      });
      writeActiveSessionTrace("active");
      return { ok: Boolean(text), text, provider: provider.id, modelName, requestId, error: text ? undefined : `empty_${provider.id}_structured_response` };
    }

    let detailSequence = 0;
    let firstChunkSent = false;
    const sendDetailChunk = (chunk) => {
      if (signal?.aborted || !chunk) return;
      detailSequence += 1;
      if (!firstChunkSent) {
        firstChunkSent = true;
        appendTraceEvent("provider_stream_first_chunk", {
          requestId,
          provider: provider.id,
          modelName,
          durationMs: Date.now() - providerStartedAt,
          sequence: detailSequence,
        });
        writeActiveSessionTrace("active");
      }
      const payload = { requestId, sequence: detailSequence, text: chunk, done: false, audience };
      event?.sender?.send("answer:detail-chunk", payload);
      sendToOverlay("answer:detail-chunk", payload);
    };

    appendTraceEvent("provider_request_started", {
      requestId,
      provider: provider.id,
      modelName,
      protocol: provider.protocol,
      stream: true,
      structuredOutput: false,
      liveSpokenOutput,
    });
    writeActiveSessionTrace("active");
    const detailResponse = await fetchWithRetry(`${provider.baseUrl()}/v1/responses`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...requestBase,
        stream: true,
      }),
    }, { requestId, provider: provider.id });
    appendTraceEvent("provider_response_headers", {
      requestId,
      provider: provider.id,
      modelName,
      stream: true,
      status: detailResponse.status,
      ok: detailResponse.ok,
      durationMs: Date.now() - providerStartedAt,
    });
    writeActiveSessionTrace("active");
    if (!detailResponse.ok) {
      const payload = await detailResponse.json().catch(() => ({}));
      appendTraceEvent("provider_response_body_parsed", {
        requestId,
        provider: provider.id,
        modelName,
        stream: true,
        ok: false,
        durationMs: Date.now() - providerStartedAt,
      });
      writeActiveSessionTrace("active");
      return { ok: false, text: "", provider: provider.id, modelName, requestId, error: payload?.error?.message ?? `${provider.id}_http_${detailResponse.status}` };
    }

    const text = await readOpenAISseStream(detailResponse, (streamEvent) => {
      sendDetailChunk(extractProviderStreamDelta(streamEvent));
    }, signal);
    if (signal?.aborted) throw Object.assign(new Error("Request cancelled"), { name: "AbortError" });
    const completedPayload = { requestId, sequence: detailSequence + 1, text: "", done: true, audience };
    event?.sender?.send("answer:detail-chunk", completedPayload);
    sendToOverlay("answer:detail-chunk", completedPayload);
    appendTraceEvent("provider_stream_completed", {
      requestId,
      provider: provider.id,
      modelName,
      ok: Boolean(text),
      durationMs: Date.now() - providerStartedAt,
      chunks: detailSequence,
      text: textSummary(text, 120),
    });
    writeActiveSessionTrace("active");
    return {
      ok: Boolean(text),
      text,
      provider: provider.id,
      modelName,
      requestId,
      error: text ? undefined : `empty_${provider.id}_response`,
    };
  } catch (error) {
    if (isAbortError(error)) {
      const cancelledPayload = { requestId, sequence: 0, text: "", done: true, cancelled: true, audience };
      event?.sender?.send("answer:detail-chunk", cancelledPayload);
      sendToOverlay("answer:detail-chunk", cancelledPayload);
      return { ok: false, text: "", provider: provider.id, modelName, requestId, error: "cancelled", cancelled: true };
    }
    const failedPayload = { requestId, sequence: 0, text: "", done: true, error: error instanceof Error ? error.message : `${provider.id}_request_failed`, audience };
    event?.sender?.send("answer:detail-chunk", failedPayload);
    sendToOverlay("answer:detail-chunk", failedPayload);
    return { ok: false, text: "", provider: provider.id, modelName, requestId, error: error instanceof Error ? error.message : `${provider.id}_request_failed` };
  }
};

const extractOllamaModels = (response) => {
  if (!Array.isArray(response?.models)) return [];
  return response.models
    .map((model) => {
      const name = typeof model?.name === "string" && model.name.trim()
        ? model.name.trim()
        : typeof model?.model === "string" && model.model.trim()
          ? model.model.trim()
          : "";
      if (!name) return undefined;
      return {
        name,
        modifiedAt: typeof model?.modified_at === "string" ? model.modified_at : undefined,
        size: typeof model?.size === "number" ? model.size : undefined,
      };
    })
    .filter(Boolean);
};

const extractOpenAICompatibleModels = (response) => {
  if (!Array.isArray(response?.data)) return [];
  return response.data
    .map((model) => {
      const name = typeof model?.id === "string" && model.id.trim()
        ? model.id.trim()
        : typeof model?.name === "string" && model.name.trim()
          ? model.name.trim()
          : "";
      if (!name) return undefined;
      return {
        name,
        ownedBy: typeof model?.owned_by === "string" && model.owned_by.trim() ? model.owned_by.trim() : undefined,
      };
    })
    .filter(Boolean);
};

const normalizeOcrLanguage = (language) => {
  const normalized = String(language || "").trim().toLowerCase();
  if (normalized === "spanish" || normalized === "spa" || normalized === "es") return "spa";
  if (normalized === "english" || normalized === "eng" || normalized === "en") return "eng";
  if (normalized === "eng+spa" || normalized === "spa+eng" || normalized === "auto") return "eng+spa";
  return "eng";
};

const cleanOcrText = (text) => String(text || "")
  .replace(/\r/g, "")
  .split("\n")
  .map((line) => line.replace(/\s+/g, " ").trim())
  .filter(Boolean)
  .join("\n")
  .trim();

const normalizeCodeLikeOcrText = (text) => String(text || "")
  .split("\n")
  .map((line) => line
    .replace(/\bdef\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)+)\s*\(/g, (_match, name) => `def ${String(name).trim().replace(/\s+/g, "_")}(`)
    .replace(/\b([a-zA-Z]+)\s+([a-zA-Z]+)\s*=/g, (_match, left, right) => `${left}_${right} =`)
    .replace(/\b([a-zA-Z]+)\s+([a-zA-Z]+)\s+for\b/g, (_match, left, right) => `${left}_${right} for`)
  )
  .join("\n")
  .trim();

const removeNonTechnicalOcrNoise = (text) => String(text || "")
  .split("\n")
  .map((line) => line
    .replace(/\s*#\S*standup\b.*$/i, "")
    .replace(/\s*\bMartina:.*$/i, "")
    .replace(/\s*\bPR de ayer\b.*$/i, "")
  )
  .map((line) => line.trim())
  .filter(Boolean)
  .join("\n")
  .trim();

const extractTechnicalOcrFocus = (text) => String(text || "")
  .split("\n")
  .map((line) => line.replace(/\s+/g, " ").trim())
  .filter(Boolean)
  .filter((line) => (
    /\b(given|return|determine|valid|constraints?|examples?|input|output|edge cases?)\b/i.test(line)
    || /\b(linked list|binary tree|bst|binary search tree|node|root|left|right|subtree|odd|even|indices)\b/i.test(line)
    || /\b(def|class|return|function|while|for|if|else)\b/.test(line)
    || /\b(error|exception|traceback|failed|assert|test|expected|actual)\b/i.test(line)
  ))
  .slice(0, 28)
  .join("\n")
  .trim();

const stripVisionProblemGuessesWhenOcrHasProblem = (analysisText, visibleText) => {
  if (!/\b(given|constraints?|input|output|return)\b/i.test(String(visibleText || ""))) return analysisText;
  return String(analysisText || "")
    .split("\n")
    .filter((line) => !/\b(coding problem .*asks|asks the user to write|overall, the image shows|likely python or java)\b/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const hasVisibleCodeLikeText = (text) =>
  String(text || "")
    .split("\n")
    .some((line) => /^\s*(?:def|class|return|import|from|function|const|let|var|public|private)\b/i.test(line));

const stripInventedCodeWhenNoVisibleCode = (analysisText, visibleText) => {
  if (hasVisibleCodeLikeText(visibleText)) return analysisText;
  return stripVisionProblemGuessesWhenOcrHasProblem(analysisText, visibleText)
    .replace(/\*\*Code\*\*[\s\S]*?(?=\n\n\*\*|Visible OCR text:|$)/gi, "")
    .replace(/\bCode:\s*[\s\S]*?(?=\n\n|Visible OCR text:|$)/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\bHere is (?:the )?(?:code|solution)[\s\S]*?(?=\n\n|Visible OCR text:|$)/gi, "No visible code is present in the screenshot; provide approach only.")
    .trim();
};

const OCR_WORKER_READY_TIMEOUT_MS = 15000;
const OCR_RECOGNIZE_TIMEOUT_MS = 18000;
const OCR_BEST_EFFORT_BUDGET_MS = 24000;
const OCR_MAX_UPSCALED_WIDTH = 2200;
const OCR_MAX_UPSCALED_HEIGHT = 1600;

const withTimeout = (promise, timeoutMs, message) => {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
};

const resetOcrWorker = (language, workerOrPromise) => {
  ocrWorkers.delete(language);
  Promise.resolve(workerOrPromise)
    .then((worker) => worker?.terminate?.())
    .catch(() => {});
};

const getOcrWorker = async (language) => {
  const normalizedLanguage = normalizeOcrLanguage(language);
  if (!ocrWorkers.has(normalizedLanguage)) {
    const workerPromise = createWorker(normalizedLanguage, 1, {
      cachePath: path.join(userDataPath(), "tesseract-cache"),
      logger: () => {},
    });
    ocrWorkers.set(normalizedLanguage, workerPromise);
  }
  const workerPromise = ocrWorkers.get(normalizedLanguage);
  try {
    return await withTimeout(workerPromise, OCR_WORKER_READY_TIMEOUT_MS, "ocr_worker_timeout");
  } catch (error) {
    resetOcrWorker(normalizedLanguage, workerPromise);
    throw error;
  }
};

const recognizeImageText = async ({ imagePath, language, timeoutMs = OCR_RECOGNIZE_TIMEOUT_MS }) => {
  const normalizedLanguage = normalizeOcrLanguage(language);
  if (!imagePath || typeof imagePath !== "string") {
    return { ok: false, text: "", language: normalizedLanguage, error: "missing_image_path" };
  }
  if (!fs.existsSync(imagePath)) {
    return { ok: false, text: "", language: normalizedLanguage, path: imagePath, error: "image_not_found" };
  }
  const imageStats = fs.statSync(imagePath);
  if (!imageStats.isFile() || imageStats.size === 0) {
    return { ok: false, text: "", language: normalizedLanguage, path: imagePath, error: "empty_image_file" };
  }
  if (imageStats.size < 16) {
    return { ok: false, text: "", language: normalizedLanguage, path: imagePath, error: "invalid_image_file" };
  }

  let worker;
  try {
    worker = await getOcrWorker(normalizedLanguage);
    const result = await withTimeout(
      worker.recognize(imagePath),
      timeoutMs,
      "ocr_recognize_timeout",
    );
    const text = cleanOcrText(result?.data?.text);
    return {
      ok: Boolean(text),
      text,
      language: normalizedLanguage,
      confidence: typeof result?.data?.confidence === "number" ? result.data.confidence : undefined,
      path: imagePath,
      error: text ? undefined : "empty_ocr_result",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "ocr_failed";
    if (/timeout/i.test(message)) resetOcrWorker(normalizedLanguage, worker);
    return {
      ok: false,
      text: "",
      language: normalizedLanguage,
      path: imagePath,
      error: message,
    };
  }
};

const recognizeImageTextBestEffort = async ({ imagePath, language }) => {
  const startedAt = Date.now();
  const remainingBudget = () => Math.max(2500, OCR_BEST_EFFORT_BUDGET_MS - (Date.now() - startedAt));
  const direct = await recognizeImageText({
    imagePath,
    language,
    timeoutMs: Math.min(OCR_RECOGNIZE_TIMEOUT_MS, remainingBudget()),
  });
  if (direct.ok && Number(direct.confidence ?? 0) >= 70) return direct;
  if (remainingBudget() <= 3500 || direct.error === "ocr_recognize_timeout" || direct.error === "ocr_worker_timeout") return direct;

  let upscaledPath = "";
  try {
    const image = nativeImage.createFromPath(imagePath);
    const size = image.getSize();
    if (!size.width || !size.height) return direct;
    const maxScale = Math.min(OCR_MAX_UPSCALED_WIDTH / size.width, OCR_MAX_UPSCALED_HEIGHT / size.height);
    const scale = size.width < 900 ? Math.min(2, maxScale) : Math.min(1.35, maxScale);
    if (scale <= 1.05) return direct;
    const upscaled = image.resize({
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
      quality: "best",
    });
    const screenshotDir = path.join(userDataPath(), "screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });
    upscaledPath = path.join(screenshotDir, `ocr-upscaled-${Date.now()}.png`);
    fs.writeFileSync(upscaledPath, upscaled.toPNG());
    const retry = await recognizeImageText({
      imagePath: upscaledPath,
      language,
      timeoutMs: Math.min(OCR_RECOGNIZE_TIMEOUT_MS, remainingBudget()),
    });
    const directScore = Number(direct.confidence ?? 0) + String(direct.text || "").length / 20;
    const retryScore = Number(retry.confidence ?? 0) + String(retry.text || "").length / 20;
    return retry.ok && retryScore > directScore
      ? { ...retry, sourcePath: imagePath, preprocessing: `upscaled_${scale}x` }
      : direct;
  } catch {
    return direct;
  } finally {
    if (upscaledPath) fs.rmSync(upscaledPath, { force: true });
  }
};

const normalizeAudioMimeType = (mimeType) => String(mimeType || "").toLowerCase().split(";")[0]?.trim() || "";

const audioExtensionForMimeType = (mimeType) => {
  const normalized = normalizeAudioMimeType(mimeType);
  if (normalized === "audio/mpeg" || normalized === "audio/mp3") return "mp3";
  if (normalized === "audio/mp4" || normalized === "video/mp4") return "mp4";
  if (normalized === "audio/mpga") return "mpga";
  if (normalized === "audio/m4a") return "m4a";
  if (normalized === "audio/wav") return "wav";
  return "webm";
};

const extractOpenAITranscriptionText = (payload) => {
  if (typeof payload === "string") return payload.trim();
  if (typeof payload?.text === "string") return payload.text.trim();
  return "";
};

const createMockAnswer = (prompt) => [
  `Mode: ${prompt?.debug?.modeId ?? "unknown"}`,
  "",
  "## Direct answer",
  "Use the current context as evidence and answer in an interview-ready way.",
  "",
  "## Debug",
  `${prompt?.debug?.includedSections?.length ?? 0} sections included, ${prompt?.debug?.omittedSections?.length ?? 0} omitted.`,
].join("\n");

const emitShortcut = (action) => {
  mainWindow?.webContents.send("shortcut", action);
};

const remoteControlLanHosts = () => {
  const hosts = ["127.0.0.1"];
  for (const networkInterfaces of Object.values(os.networkInterfaces())) {
    for (const item of networkInterfaces || []) {
      if (item.family === "IPv4" && !item.internal) hosts.push(item.address);
    }
  }
  return [...new Set(hosts)];
};

const remoteControlUrls = () =>
  remoteControlLanHosts().map((host) => `http://${host}:${remoteControlStatus.port}`);

const remoteControlFriendlyUrls = () => {
  const hostname = os.hostname().replace(/[^a-z0-9.-]/gi, "");
  return [
    hostname ? `http://${hostname}:${remoteControlStatus.port}` : "",
    hostname ? `http://${hostname}.local:${remoteControlStatus.port}` : "",
    ...remoteControlLanHosts().filter((host) => host !== "127.0.0.1").map((host) => `http://${host}:${remoteControlStatus.port}`),
  ].filter(Boolean);
};

const sendRemoteControlStatus = () => {
  const status = {
    ...remoteControlStatus,
    urls: remoteControlStatus.enabled ? remoteControlUrls() : [],
    friendlyUrls: remoteControlStatus.enabled ? remoteControlFriendlyUrls() : [],
  };
  mainWindow?.webContents.send("remote-control:status", status);
  overlayWindow?.webContents.send("remote-control:status", status);
  codingWindow?.webContents.send("remote-control:status", status);
};

const sendRemoteControlCommand = (command) => {
  mainWindow?.webContents.send("remote-control:command", command);
  overlayWindow?.webContents.send("remote-control:command", command);
  codingWindow?.webContents.send("remote-control:command", command);
};

const remoteControlPage = () => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>CallPilot Remote</title>
  <style>
    :root { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #ffffff; color: #111111; }
    body { margin: 0; min-height: 100vh; background: #ffffff; overscroll-behavior: none; }
    main { box-sizing: border-box; min-height: 100vh; padding: 18px; display: grid; grid-template-rows: auto minmax(220px, 1fr) auto; gap: 14px; }
    .no-session { display: none; min-height: 100vh; place-items: center; color: #111111; font-size: 18px; }
    body.waiting main { display: none; }
    body.waiting .no-session { display: grid; }
    .mode { color: #555555; font-size: 12px; text-align: right; }
    .scroll-pads { display: grid; gap: 12px; min-height: 0; }
    .scroll-pads--coding { grid-template-rows: repeat(2, minmax(150px, 1fr)); }
    .scroll-pad { border: 3px solid #111111; border-radius: 32px; background: #ffffff; color: #111111; display: grid; place-items: center; min-height: 280px; touch-action: none; user-select: none; }
    .scroll-pads--coding .scroll-pad { min-height: 150px; }
    .scroll-pad strong { font-size: 22px; }
    .buttons { display: grid; gap: 10px; }
    button { min-height: 58px; border: 3px solid #111111; border-radius: 9px; background: #ffffff; color: #111111; font: inherit; font-size: 20px; font-weight: 850; touch-action: manipulation; }
    button:active { transform: translateY(1px); filter: brightness(0.96); }
    .button-answer { background: #16a34a; color: #ffffff; border-color: #0f6b32; }
    .button-answer-code { background: #2563eb; color: #ffffff; border-color: #1d4ed8; }
    .button-screenshot { background: #f59e0b; color: #111111; border-color: #b45309; }
    .button-reset { background: #dc2626; color: #ffffff; border-color: #991b1b; }
    .button-stop { background: #f3f4f6; color: #111111; border-color: #6b7280; }
    .hidden { display: none; }
  </style>
</head>
<body class="waiting">
  <div class="no-session">No session running</div>
  <main>
    <div id="mode" class="mode"></div>
    <div id="scrollPads" class="scroll-pads">
      <section class="scroll-pad" data-scroll-target="chat" data-technical-only>
        <strong>Chat scroll</strong>
      </section>
      <section class="scroll-pad" data-scroll-target="code" data-live-only>
        <strong>Code scroll</strong>
      </section>
      <section class="scroll-pad" data-scroll-target="reasoning" data-live-only>
        <strong>Reasoning scroll</strong>
      </section>
    </div>
    <div class="buttons">
      <button class="button-answer" data-action="answer">Answer</button>
      <button class="button-answer-code" data-action="answer_code" data-live-only>Answer code</button>
      <button class="button-screenshot" data-action="screenshot" data-live-only>Screenshot</button>
      <button class="button-reset" data-action="reset_session">Reset</button>
      <button class="button-stop" data-action="stop_answer">Stop</button>
      <button class="button-stop" data-action="end_session">End</button>
    </div>
  </main>
  <script>
    let currentMode = "technical_interview";
    const scrollState = new Map();
    const mode = document.getElementById("mode");
    const scrollPads = document.getElementById("scrollPads");
    const applyMode = (nextMode) => {
      const hasSession = nextMode === "live_coding" || nextMode === "technical_interview";
      document.body.classList.toggle("waiting", !hasSession);
      if (!hasSession) return;
      currentMode = nextMode === "live_coding" ? "live_coding" : "technical_interview";
      mode.textContent = currentMode === "live_coding" ? "Live Coding" : "Technical";
      scrollPads.classList.toggle("scroll-pads--coding", currentMode === "live_coding");
      document.querySelectorAll("[data-live-only]").forEach((item) => item.classList.toggle("hidden", currentMode !== "live_coding"));
      document.querySelectorAll("[data-technical-only]").forEach((item) => item.classList.toggle("hidden", currentMode === "live_coding"));
    };
    const refreshStatus = async () => {
      try {
        const response = await fetch("/api/status");
        if (!response.ok) return;
        const result = await response.json().catch(() => ({}));
        applyMode(result.status && result.status.mode);
      } catch {}
    };
    void refreshStatus();
    window.setInterval(refreshStatus, 1200);
    const send = async (payload) => {
      if (document.body.classList.contains("waiting")) return;
      try {
        await fetch("/api/command", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {}
    };
    const stateForPad = (pad) => {
      if (!scrollState.has(pad)) scrollState.set(pad, { pendingDelta: 0, lastTouchY: null });
      return scrollState.get(pad);
    };
    const flushScroll = (pad) => {
      const state = stateForPad(pad);
      if (!state.pendingDelta) return;
      const delta = Math.max(-1200, Math.min(1200, Math.round(state.pendingDelta)));
      state.pendingDelta = 0;
      void send({ type: "scroll", target: pad.dataset.scrollTarget, delta });
    };
    window.setInterval(() => {
      document.querySelectorAll("[data-scroll-target]").forEach(flushScroll);
    }, 120);
    document.querySelectorAll("[data-scroll-target]").forEach((pad) => {
      pad.addEventListener("touchstart", (event) => {
        stateForPad(pad).lastTouchY = event.touches[0] ? event.touches[0].clientY : null;
      }, { passive: false });
      pad.addEventListener("touchmove", (event) => {
        event.preventDefault();
        const state = stateForPad(pad);
        const y = event.touches[0] ? event.touches[0].clientY : null;
        if (y === null || state.lastTouchY === null) return;
        state.pendingDelta += state.lastTouchY - y;
        state.lastTouchY = y;
      }, { passive: false });
      pad.addEventListener("touchend", () => {
        const state = stateForPad(pad);
        state.lastTouchY = null;
        flushScroll(pad);
      });
      pad.addEventListener("wheel", (event) => {
        event.preventDefault();
        stateForPad(pad).pendingDelta += event.deltaY;
        flushScroll(pad);
      }, { passive: false });
    });
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => send({ type: button.dataset.action }));
    });
  </script>
</body>
</html>`;

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
};

const readRequestJson = (request) => new Promise((resolve, reject) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 4096) {
      reject(new Error("request_too_large"));
      request.destroy();
    }
  });
  request.on("end", () => {
    try {
      resolve(body ? JSON.parse(body) : {});
    } catch {
      reject(new Error("invalid_json"));
    }
  });
  request.on("error", reject);
});

const handleRemoteControlCommand = (command) => {
  if (!remoteControlStatus.mode) return { ok: false, error: "no_session_running" };
  const type = typeof command?.type === "string" ? command.type : "";
  const target = typeof command?.target === "string" ? command.target : "";
  const delta = Number.isFinite(Number(command?.delta))
    ? Math.max(-1200, Math.min(1200, Math.round(Number(command.delta))))
    : 0;
  const normalized = { type, target, delta, timestamp: Date.now() };
  appendTraceEvent("remote_control_command", { type, target, delta });
  writeActiveSessionTrace("active");

  if (type === "answer") {
    if (!mainWindow || mainWindow.webContents.isDestroyed()) return { ok: false, error: "main_window_unavailable" };
    mainWindow.webContents.send("answer:manual-request");
    sendToSessionWindows("answer:manual-status", { ok: true, status: "sent_to_main" });
    return { ok: true };
  }
  if (type === "end_session") {
    remoteControlStatus = { ...remoteControlStatus, mode: null };
    sendRemoteControlStatus();
    mainWindow?.webContents.send("session:ended");
    const stoppedNativelyStreams = stopAllNativelyStreams();
    const stoppedDeepgramStreams = stopAllDeepgramStreams();
    appendTraceEvent("live_transcription_runtime_reset", {
      reason: "remote_session_end",
      stoppedNativelyStreams: stoppedNativelyStreams.length,
      stoppedDeepgramStreams: stoppedDeepgramStreams.length,
      nativelyStreamIds: stoppedNativelyStreams,
      deepgramStreamIds: stoppedDeepgramStreams,
    });
    closeOverlayWindow();
    closeCodingWindow();
    mainWindow?.show();
    finishSessionTrace();
    return { ok: true };
  }
  if (["answer_code", "stop_answer", "reset_exercise", "reset_session", "screenshot", "scroll"].includes(type)) {
    sendRemoteControlCommand(normalized);
    return { ok: true };
  }
  return { ok: false, error: "unknown_command" };
};

const startRemoteControlServer = () => {
  if (remoteControlServer) return;
  const requestedPort = Number(process.env.CALLPILOT_REMOTE_CONTROL_PORT || 38767);
  const port = Number.isFinite(requestedPort) && requestedPort > 0 ? Math.round(requestedPort) : 38767;
  remoteControlServer = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(remoteControlPage());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return sendJson(response, 200, { ok: true, status: { ...remoteControlStatus, urls: remoteControlUrls(), friendlyUrls: remoteControlFriendlyUrls() } });
    }
    if (request.method === "POST" && url.pathname === "/api/command") {
      try {
        return sendJson(response, 200, handleRemoteControlCommand(await readRequestJson(request)));
      } catch (error) {
        return sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "bad_request" });
      }
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  });
  remoteControlServer.on("error", (error) => {
    remoteControlStatus = { ...remoteControlStatus, enabled: false, port: 0, urls: [], error: error.message };
    sendRemoteControlStatus();
  });
  remoteControlServer.listen(port, "0.0.0.0", () => {
    const address = remoteControlServer.address();
    remoteControlStatus = {
      ...remoteControlStatus,
      enabled: true,
      port: typeof address === "object" && address ? address.port : port,
      error: "",
    };
    sendRemoteControlStatus();
  });
};

const normalizeStealthState = () => {
  if (!stealthState.callPrivacyAllowed) {
    stealthState.overlayVisible = true;
    stealthState.contentProtectionEnabled = false;
    stealthState.mousePassthroughEnabled = false;
    stealthState.focusMode = "interactive";
    return;
  }
  if (stealthState.focusMode === "passthrough") {
    stealthState.mousePassthroughEnabled = true;
  } else if (stealthState.mousePassthroughEnabled) {
    stealthState.focusMode = "passthrough";
  }
};

const applyShareSafeState = () => {
  stealthState.callPrivacyAllowed = true;
  stealthState.overlayVisible = true;
  stealthState.contentProtectionEnabled = true;
  stealthState.mousePassthroughEnabled = true;
  stealthState.focusMode = "passthrough";
  stealthState.shortcutLayerActive = true;
  normalizeStealthState();
};

const resetPrivacyState = () => {
  stealthState.callPrivacyAllowed = false;
  stealthState.overlayVisible = true;
  stealthState.contentProtectionEnabled = false;
  stealthState.mousePassthroughEnabled = false;
  stealthState.focusMode = "interactive";
  normalizeStealthState();
};

const configureMediaCapture = () => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (webContents !== mainWindow?.webContents) {
      callback(false);
      return;
    }
    callback(["media", "display-capture"].includes(permission));
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      });
      const source = sources[0];
      if (!source) {
        callback({});
        return;
      }
      callback({
        video: source,
        audio: process.platform === "win32" ? "loopback" : undefined,
      });
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });
};

const assessPrivacyState = async () => {
  normalizeStealthState();
  const findings = [];
  if (!stealthState.callPrivacyAllowed) {
    findings.push("Call privacy approval is off, so privacy controls are unavailable.");
    return {
      status: "unknown",
      summary: "Privacy mode is not approved for this call.",
      findings,
      checkedAt: new Date().toISOString(),
    };
  }

  if (stealthState.overlayVisible) {
    findings.push("CallPilot is visible locally. Test with an observer before sharing.");
  } else {
    findings.push("CallPilot window is hidden locally.");
  }

  if (stealthState.contentProtectionEnabled) {
    findings.push("Best-effort capture protection is enabled.");
  } else {
    findings.push("Best-effort capture protection is disabled.");
  }

  if (stealthState.mousePassthroughEnabled) {
    findings.push("Mouse passthrough is enabled.");
  }

  try {
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 320, height: 200 } });
    const callPilotWindows = sources.filter((source) => /callpilot/i.test(source.name));
    if (callPilotWindows.length > 0 && stealthState.overlayVisible) {
      findings.push("CallPilot is listed as a capturable window source.");
    }
    if (callPilotWindows.length === 0 && !stealthState.overlayVisible) {
      findings.push("CallPilot was not listed as a capturable window source while hidden.");
    }
  } catch (error) {
    findings.push(`Local capture source check failed: ${error instanceof Error ? error.message : "unknown error"}.`);
  }

  const status = stealthState.contentProtectionEnabled ? "safe" : "risk";
  return {
    status,
    summary: status === "safe"
      ? stealthState.overlayVisible
        ? "Private sharing mode is active. CallPilot stays visible to you with best-effort capture protection and passthrough enabled."
        : "Hidden private sharing mode is active. CallPilot is hidden locally with best-effort capture protection and passthrough enabled."
      : stealthState.overlayVisible
        ? "CallPilot is visible locally, but capture protection is not enabled."
        : "CallPilot is hidden locally; protected interview overlays should stay visible to you.",
    findings,
    checkedAt: new Date().toISOString(),
  };
};

const syncWindowState = () => {
  normalizeStealthState();
  const sessionPassthroughEnabled = Boolean(stealthState.mousePassthroughEnabled && activeSessionTrace);
  for (const windowRef of [mainWindow, overlayWindow, codingWindow]) {
    if (!windowRef) continue;
    windowRef.setAlwaysOnTop(true, "screen-saver");
    windowRef.setContentProtection(Boolean(stealthState.contentProtectionEnabled));
    windowRef.setIgnoreMouseEvents(windowRef !== mainWindow && sessionPassthroughEnabled, { forward: true });
  }
  if (mainWindow && stealthState.overlayVisible && !overlayWindow) {
    if (!mainWindow.isVisible()) mainWindow.showInactive();
  } else if (mainWindow) {
    mainWindow.hide();
  }
};

const createOverlayWindow = async () => {
  const { overlay } = sessionWindowBounds();
  if (overlayWindow) {
    overlayWindow.setBounds(overlay);
    overlayWindow.showInactive();
    return;
  }
  overlayWindow = new BrowserWindow({
    ...overlay,
    minWidth: 320,
    minHeight: 180,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  syncWindowState();
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await overlayWindow.loadURL(`${devUrl}#/overlay`);
  } else {
    await overlayWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), { hash: "/overlay" });
  }
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
};

const closeOverlayWindow = () => {
  if (!overlayWindow) return;
  overlayWindow.close();
  overlayWindow = null;
};

const createCodingWindow = async () => {
  const { coding } = sessionWindowBounds();
  if (codingWindow) {
    codingWindow.setBounds(coding);
    codingWindow.showInactive();
    return;
  }
  codingWindow = new BrowserWindow({
    ...coding,
    minWidth: 560,
    minHeight: 220,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  codingWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  syncWindowState();
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await codingWindow.loadURL(`${devUrl}#/coding`);
  } else {
    await codingWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), { hash: "/coding" });
  }
  codingWindow.on("closed", () => {
    codingWindow = null;
  });
};

const closeCodingWindow = () => {
  if (!codingWindow) return;
  codingWindow.close();
  codingWindow = null;
};

const sendToOverlay = (channel, payload) => {
  overlayWindow?.webContents.send(channel, payload);
};

const sendToSessionWindows = (channel, payload) => {
  overlayWindow?.webContents.send(channel, payload);
  codingWindow?.webContents.send(channel, payload);
};

const sessionWindowBounds = () => {
  const workArea = screen.getPrimaryDisplay().workArea;
  const margin = 24;
  const gap = 12;
  const preferredCodingWidth = 1180;
  const preferredOverlayWidth = 380;
  const preferredHeight = 410;
  const availableWidth = Math.max(680, workArea.width - margin * 2);
  const overlayWidth = Math.max(300, Math.min(preferredOverlayWidth, Math.floor(availableWidth * 0.28)));
  const codingWidth = Math.max(360, Math.min(preferredCodingWidth, availableWidth - overlayWidth - gap));
  const height = Math.max(220, Math.min(preferredHeight, Math.floor((workArea.height - margin * 2) * 0.5)));
  const x = workArea.x + margin;
  const y = workArea.y + workArea.height - margin - height;
  return {
    coding: { x, y, width: codingWidth, height },
    overlay: { x: x + codingWidth + gap, y, width: overlayWidth, height },
  };
};

const temporarilyHideSessionWindows = async (callback) => {
  const windows = [overlayWindow, codingWindow]
    .filter((windowRef) => windowRef && !windowRef.isDestroyed());
  const visibleStates = windows.map((windowRef) => windowRef.isVisible());
  for (const windowRef of windows) {
    if (windowRef.isVisible()) windowRef.hide();
  }
  if (windows.some((_windowRef, index) => visibleStates[index])) {
    await sleep(140);
  }
  try {
    return await callback();
  } finally {
    windows.forEach((windowRef, index) => {
      if (visibleStates[index] && !windowRef.isDestroyed()) windowRef.showInactive();
    });
    syncWindowState();
  }
};

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    title: "CallPilot V0",
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: "#111214",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  syncWindowState();
  mainWindow.on("focus", syncWindowState);
  mainWindow.on("show", syncWindowState);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
};

const registerShortcuts = () => {
  globalShortcut.unregisterAll();
  const registrations = [
    ["CommandOrControl+Alt+H", () => {
      if (stealthState.callPrivacyAllowed) {
        stealthState.overlayVisible = !stealthState.overlayVisible;
      } else {
        stealthState.overlayVisible = true;
      }
      syncWindowState();
      emitShortcut({ type: "stealth", state: { ...stealthState } });
    }],
    ["CommandOrControl+Alt+P", () => {
      stealthState.mousePassthroughEnabled = stealthState.callPrivacyAllowed
        ? !stealthState.mousePassthroughEnabled
        : false;
      stealthState.focusMode = stealthState.mousePassthroughEnabled ? "passthrough" : "interactive";
      syncWindowState();
      emitShortcut({ type: "stealth", state: { ...stealthState } });
    }],
    ["CommandOrControl+Alt+R", () => {
      resetPrivacyState();
      syncWindowState();
      emitShortcut({ type: "stealth", state: { ...stealthState } });
    }],
    ["CommandOrControl+Alt+S", () => emitShortcut({ type: "capture_screenshot" })],
    ["CommandOrControl+Alt+Enter", () => emitShortcut({ type: "ask" })],
    ["CommandOrControl+Alt+Backspace", () => emitShortcut({ type: "clear_context" })],
    ["CommandOrControl+Alt+1", () => emitShortcut({ type: "set_mode", mode: "live_coding" })],
    ["CommandOrControl+Alt+2", () => emitShortcut({ type: "set_mode", mode: "system_design" })],
    ["CommandOrControl+Alt+3", () => emitShortcut({ type: "set_mode", mode: "behavioral" })],
    ["CommandOrControl+Alt+4", () => emitShortcut({ type: "set_mode", mode: "technical_qa" })],
    ["CommandOrControl+Alt+5", () => emitShortcut({ type: "set_mode", mode: "meeting_notes" })],
  ];
  shortcutHealth = registrations.map(([accelerator, callback]) => ({
    accelerator,
    registered: globalShortcut.register(accelerator, callback),
  }));
};

ipcMain.handle("stealth:get", () => ({ ...stealthState }));
ipcMain.handle("stealth:set-call-privacy-allowed", (_event, allowed) => {
  stealthState.callPrivacyAllowed = Boolean(allowed);
  syncWindowState();
  return { ...stealthState };
});
ipcMain.handle("stealth:set-overlay-visible", (_event, visible) => {
  stealthState.overlayVisible = stealthState.callPrivacyAllowed ? Boolean(visible) : true;
  syncWindowState();
  return { ...stealthState };
});
ipcMain.handle("stealth:set-content-protection", (_event, enabled) => {
  stealthState.contentProtectionEnabled = stealthState.callPrivacyAllowed ? Boolean(enabled) : false;
  syncWindowState();
  return { ...stealthState };
});
ipcMain.handle("stealth:set-mouse-passthrough", (_event, enabled) => {
  stealthState.mousePassthroughEnabled = stealthState.callPrivacyAllowed ? Boolean(enabled) : false;
  stealthState.focusMode = stealthState.mousePassthroughEnabled ? "passthrough" : "interactive";
  syncWindowState();
  return { ...stealthState };
});
ipcMain.handle("stealth:apply-share-safe", () => {
  applyShareSafeState();
  syncWindowState();
  return { ...stealthState };
});
ipcMain.handle("stealth:reset-privacy", () => {
  resetPrivacyState();
  syncWindowState();
  return { ...stealthState };
});
ipcMain.handle("privacy:check", () => assessPrivacyState());
ipcMain.handle("session:start", async (_event, options = {}) => {
  remoteControlStatus = {
    ...remoteControlStatus,
    mode: options.mode === "live_coding" ? "live_coding" : "technical_interview",
  };
  sendRemoteControlStatus();
  startSessionTrace(options);
  const stoppedNativelyStreams = stopAllNativelyStreams();
  const stoppedDeepgramStreams = stopAllDeepgramStreams();
  appendTraceEvent("live_transcription_runtime_reset", {
    stoppedNativelyStreams: stoppedNativelyStreams.length,
    stoppedDeepgramStreams: stoppedDeepgramStreams.length,
    nativelyStreamIds: stoppedNativelyStreams,
    deepgramStreamIds: stoppedDeepgramStreams,
  });
  await createOverlayWindow();
  if (options.mode === "live_coding") {
    await createCodingWindow();
  } else {
    closeCodingWindow();
  }
  mainWindow?.hide();
  appendTraceEvent("session_windows_ready", { mode: options.mode || "technical_qa", hasCodingWindow: Boolean(codingWindow) });
  writeActiveSessionTrace("active");
  return { ok: true };
});
ipcMain.handle("session:end", () => {
  remoteControlStatus = { ...remoteControlStatus, mode: null };
  sendRemoteControlStatus();
  mainWindow?.webContents.send("session:ended");
  const stoppedNativelyStreams = stopAllNativelyStreams();
  const stoppedDeepgramStreams = stopAllDeepgramStreams();
  appendTraceEvent("live_transcription_runtime_reset", {
    reason: "session_end",
    stoppedNativelyStreams: stoppedNativelyStreams.length,
    stoppedDeepgramStreams: stoppedDeepgramStreams.length,
    nativelyStreamIds: stoppedNativelyStreams,
    deepgramStreamIds: stoppedDeepgramStreams,
  });
  closeOverlayWindow();
  closeCodingWindow();
  mainWindow?.show();
  syncWindowState();
  const tracePath = finishSessionTrace();
  return { ok: true, tracePath };
});
ipcMain.handle("session:trace-status", () => activeSessionTrace ? {
  ok: true,
  active: true,
  id: activeSessionTrace.id,
  path: activeSessionTrace.path,
  eventCount: activeSessionTrace.events.length,
  startedAt: activeSessionTrace.startedAt,
  updatedAt: activeSessionTrace.updatedAt,
} : { ok: true, active: false });
ipcMain.handle("session:trace-event", (_event, type, payload = {}) => {
  const safeType = String(type || "").replace(/[^a-z0-9:_-]/gi, "_").slice(0, 80);
  if (!safeType) return { ok: false, error: "missing_type" };
  appendTraceEvent(safeType, sanitizeTracePayload(payload));
  writeActiveSessionTrace("active");
  return { ok: true };
});
ipcMain.handle("answer:request", (_event, input) => {
  const override = typeof input === "string"
    ? input.trim()
    : typeof input?.questionOverride === "string" ? input.questionOverride.trim() : "";
  const audience = input?.audience === "chat" || input?.audience === "coding" || input?.audience === "both"
    ? input.audience
    : undefined;
  appendTraceEvent("manual_answer_requested", {
    hasQuestionOverride: Boolean(override),
    questionOverride: override ? textSummary(override, 180) : undefined,
    audience,
  });
  writeActiveSessionTrace("active");
  if (!mainWindow || mainWindow.webContents.isDestroyed()) {
    sendToOverlay("answer:manual-status", { ok: false, status: "main_window_unavailable" });
    return { ok: false, error: "main_window_unavailable" };
  }
  mainWindow.webContents.send("answer:manual-request", override || audience ? { questionOverride: override, audience } : undefined);
  sendToOverlay("answer:manual-status", { ok: true, status: "sent_to_main" });
  return { ok: true };
});
ipcMain.handle("answer:cancel", (_event, requestId) => {
  const id = typeof requestId === "string" ? requestId : "";
  const controller = activeAnswerControllers.get(id);
  if (!controller) return { ok: false, status: "not_found" };
  controller.abort();
  activeAnswerControllers.delete(id);
  appendTraceEvent("answer_cancelled", { requestId: id });
  writeActiveSessionTrace("active");
  sendToOverlay("answer:manual-status", { ok: true, status: "cancelled", requestId: id });
  return { ok: true, status: "cancelled", requestId: id };
});
ipcMain.handle("transcript:publish", (_event, message) => {
  appendTraceEvent("transcript_final", {
    speaker: message?.speaker,
    messageId: message?.id,
    sourceTimestamp: message?.timestamp,
    text: textSummary(message?.text, 140),
  });
  writeActiveSessionTrace("active");
  sendToOverlay("transcript:message", message);
  return { ok: true };
});
ipcMain.handle("transcript:publish-live", (_event, message) => {
  appendTraceEvent("transcript_partial", {
    speaker: message?.speaker,
    messageId: message?.id,
    sourceTimestamp: message?.timestamp,
    text: textSummary(message?.text, 120),
  });
  writeActiveSessionTrace("active");
  sendToOverlay("transcript:live", message);
  return { ok: true };
});

ipcMain.handle("answer:publish-structured", (_event, payload) => {
  appendTraceEvent("answer_structured_published", {
    requestId: payload?.requestId,
    kind: payload?.answer?.kind,
    renderedText: textSummary(payload?.renderedText, 160),
  });
  writeActiveSessionTrace("active");
  sendToSessionWindows("answer:structured", payload);
  return { ok: true };
});
ipcMain.handle("answer:publish-raw-model-output", (_event, payload) => {
  appendTraceEvent("answer_raw_model_output", {
    requestId: payload?.requestId,
    stage: payload?.stage,
    provider: payload?.provider,
    modelName: payload?.modelName,
    ok: payload?.ok,
    error: payload?.error,
    text: payload?.text,
    textChars: typeof payload?.text === "string" ? payload.text.length : 0,
  });
  writeActiveSessionTrace("active");
  return { ok: true };
});
ipcMain.handle("answer:publish-status", (_event, payload) => {
  appendTraceEvent("answer_status_published", {
    requestId: payload?.requestId,
    status: payload?.status,
    error: payload?.error,
    renderedText: textSummary(payload?.text, 160),
  });
  writeActiveSessionTrace("active");
  sendToSessionWindows("answer:status", payload);
  return { ok: true };
});
ipcMain.handle("settings:get", () => readSettings());
ipcMain.handle("settings:save", (_event, settings) => writeSettings(settings));
ipcMain.handle("shortcuts:health", () => shortcutHealth.map((item) => ({ ...item })));
ipcMain.handle("remote-control:get-status", () => ({
  ...remoteControlStatus,
  urls: remoteControlStatus.enabled ? remoteControlUrls() : [],
  friendlyUrls: remoteControlStatus.enabled ? remoteControlFriendlyUrls() : [],
}));
ipcMain.handle("remote-control:dispatch-command", (_event, command) => handleRemoteControlCommand(command));
ipcMain.handle("credentials:status", () => credentialStatus());
ipcMain.handle("credentials:save-openai-key", (_event, apiKey) => saveStoredOpenAIKey(apiKey));
ipcMain.handle("credentials:save-natively-key", (_event, apiKey) => saveStoredNativelyKey(apiKey));
ipcMain.handle("credentials:save-deepgram-key", (_event, apiKey) => saveStoredDeepgramKey(apiKey));
ipcMain.handle("credentials:save-nvidia-key", (_event, apiKey) => saveStoredNvidiaKey(apiKey));
ipcMain.handle("credentials:save-groq-key", (_event, apiKey) => saveStoredGroqKey(apiKey));
ipcMain.handle("credentials:clear-openai-key", () => clearStoredOpenAIKey());
ipcMain.handle("credentials:clear-natively-key", () => clearStoredNativelyKey());
ipcMain.handle("credentials:clear-deepgram-key", () => clearStoredDeepgramKey());
ipcMain.handle("credentials:clear-nvidia-key", () => clearStoredNvidiaKey());
ipcMain.handle("credentials:clear-groq-key", () => clearStoredGroqKey());
ipcMain.handle("deepgram:start", async (_event, input) => {
  const startedAt = Date.now();
  const WebSocketCtor = globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    appendTraceEvent("deepgram_stream_start_failed", { error: "websocket_unavailable" });
    writeActiveSessionTrace("active");
    return { ok: false, error: "websocket_unavailable" };
  }
  const streamId = typeof input?.streamId === "string" && input.streamId.trim() ? input.streamId.trim() : `deepgram-${Date.now()}`;
  stopDeepgramStream(streamId);
  const apiKey = typeof input?.apiKey === "string" && input.apiKey.trim()
    ? input.apiKey.trim()
    : process.env.DEEPGRAM_API_KEY || process.env.CALLPILOT_DEEPGRAM_API_KEY || getStoredDeepgramKey();
  if (!apiKey) {
    appendTraceEvent("deepgram_stream_start_failed", { streamId, error: "missing_deepgram_api_key" });
    writeActiveSessionTrace("active");
    return { ok: false, error: "missing_deepgram_api_key" };
  }
  const sampleRate = Number.isFinite(input?.sampleRate) ? Math.max(8000, Math.min(48000, Math.round(Number(input.sampleRate)))) : 16000;
  const channel = input?.channel === "mic" ? "mic" : "system";
  const language = deepgramLanguageForPreference(input?.language);
  const latencyPreset = input?.latencyPreset === "accurate" ? "accurate" : input?.latencyPreset === "fast" ? "fast" : "balanced";
  const endpointingMs = Number.isFinite(input?.endpointingMs)
    ? Math.max(100, Math.min(3000, Math.round(Number(input.endpointingMs))))
    : latencyPreset === "accurate" ? 700 : latencyPreset === "fast" ? 200 : 300;
  const utteranceEndMs = Number.isFinite(input?.utteranceEndMs)
    ? Math.max(1000, Math.min(5000, Math.round(Number(input.utteranceEndMs))))
    : latencyPreset === "accurate" ? 1400 : 1000;
  const model = typeof input?.modelName === "string" && input.modelName.trim() ? input.modelName.trim() : defaultDeepgramModel();
  appendTraceEvent("deepgram_stream_started", {
    streamId,
    channel,
    model,
    sampleRate,
    requestedLanguage: input?.language,
    normalizedLanguage: language,
    latencyPreset,
    endpointingMs,
    utteranceEndMs,
    durationMs: Date.now() - startedAt,
  });
  writeActiveSessionTrace("active");
  openDeepgramStreamSocket(streamId, { apiKey, sampleRate, channel, language, model, endpointingMs, utteranceEndMs });
  return { ok: true, streamId };
});
ipcMain.handle("deepgram:audio", (_event, input) => {
  const streamId = typeof input?.streamId === "string" ? input.streamId : "";
  const rawAudio = input?.arrayBuffer;
  const audioBuffer = rawAudio instanceof ArrayBuffer
    ? Buffer.from(rawAudio)
    : ArrayBuffer.isView(rawAudio)
      ? Buffer.from(rawAudio.buffer, rawAudio.byteOffset, rawAudio.byteLength)
      : Buffer.alloc(0);
  if (audioBuffer.length === 0) {
    appendTraceEvent("deepgram_audio_rejected", { streamId, error: "empty_audio_chunk" });
    writeActiveSessionTrace("active");
    return { ok: false, error: "empty_audio_chunk" };
  }
  const stream = deepgramStreams.get(streamId);
  if (!stream) {
    appendTraceEvent("deepgram_audio_rejected", { streamId, error: "deepgram_stream_not_started" });
    writeActiveSessionTrace("active");
    return { ok: false, error: "deepgram_stream_not_started" };
  }
  if (stream.closed) {
    if (!stream.closedAudioLogged) {
      stream.closedAudioLogged = true;
      appendTraceEvent("deepgram_audio_rejected", { streamId, error: "deepgram_stream_closed" });
      writeActiveSessionTrace("active");
    }
    return { ok: false, error: "deepgram_stream_closed" };
  }
  const queuedBefore = stream.queue.length;
  if (stream.connected && stream.ws?.readyState === globalThis.WebSocket.OPEN) {
    stream.ws.send(audioBuffer);
  } else {
    stream.queue.push(audioBuffer);
    if (stream.queue.length > 500) stream.queue.shift();
  }
  appendTraceEvent("deepgram_audio_chunk", {
    streamId,
    bytes: audioBuffer.length,
    connected: Boolean(stream.connected),
    queuedBefore,
    queuedAfter: stream.queue.length,
  });
  writeActiveSessionTrace("active");
  return { ok: true };
});
ipcMain.handle("deepgram:stop", (_event, input) => {
  const streamId = typeof input?.streamId === "string" ? input.streamId : "";
  appendTraceEvent("deepgram_stop_requested", { streamId: streamId || "all" });
  writeActiveSessionTrace("active");
  if (streamId) return stopDeepgramStream(streamId);
  stopAllDeepgramStreams();
  return { ok: true };
});
ipcMain.handle("natively:start", async (_event, input) => {
  const startedAt = Date.now();
  const WebSocketCtor = globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    appendTraceEvent("natively_stream_start_failed", { error: "websocket_unavailable" });
    writeActiveSessionTrace("active");
    return { ok: false, error: "websocket_unavailable" };
  }
  const streamId = typeof input?.streamId === "string" && input.streamId.trim() ? input.streamId.trim() : `natively-${Date.now()}`;
  stopNativelyStream(streamId);
  const apiKey = typeof input?.apiKey === "string" && input.apiKey.trim()
    ? input.apiKey.trim()
    : process.env.NATIVELY_API_KEY || getStoredNativelyKey();
  if (!apiKey) {
    appendTraceEvent("natively_stream_start_failed", { streamId, error: "missing_natively_api_key" });
    writeActiveSessionTrace("active");
    return { ok: false, error: "missing_natively_api_key" };
  }
  const sampleRate = Number.isFinite(input?.sampleRate) ? Math.max(8000, Math.min(48000, Math.round(Number(input.sampleRate)))) : 16000;
  const channel = input?.channel === "mic" ? "mic" : "system";
  const language = nativelyLanguageForPreference(input?.language);
  appendTraceEvent("natively_stream_started", {
    streamId,
    channel,
    sampleRate,
    requestedLanguage: input?.language,
    normalizedLanguage: language.language,
    durationMs: Date.now() - startedAt,
  });
  writeActiveSessionTrace("active");
  openNativelyStreamSocket(streamId, { apiKey, sampleRate, channel, language });
  return { ok: true, streamId };
});
ipcMain.handle("natively:audio", (_event, input) => {
  const streamId = typeof input?.streamId === "string" ? input.streamId : "";
  const rawAudio = input?.arrayBuffer;
  const audioBuffer = rawAudio instanceof ArrayBuffer
    ? Buffer.from(rawAudio)
    : ArrayBuffer.isView(rawAudio)
      ? Buffer.from(rawAudio.buffer, rawAudio.byteOffset, rawAudio.byteLength)
      : Buffer.alloc(0);
  if (audioBuffer.length === 0) {
    appendTraceEvent("natively_audio_rejected", { streamId, error: "empty_audio_chunk" });
    writeActiveSessionTrace("active");
    return { ok: false, error: "empty_audio_chunk" };
  }
  const stream = nativelyStreams.get(streamId);
  if (!stream) {
    appendTraceEvent("natively_audio_rejected", { streamId, error: "natively_stream_not_started" });
    writeActiveSessionTrace("active");
    return { ok: false, error: "natively_stream_not_started" };
  }
  if (stream.closed) {
    return reconnectNativelyStream(streamId, stream, audioBuffer);
  }
  const queuedBefore = stream.queue.length;
  if (stream.connected && stream.ws?.readyState === globalThis.WebSocket.OPEN) {
    stream.ws.send(audioBuffer);
  } else {
    stream.queue.push(audioBuffer);
    if (stream.queue.length > 500) stream.queue.shift();
  }
  appendTraceEvent("natively_audio_chunk", {
    streamId,
    bytes: audioBuffer.length,
    connected: Boolean(stream.connected),
    queuedBefore,
    queuedAfter: stream.queue.length,
  });
  writeActiveSessionTrace("active");
  return { ok: true };
});
ipcMain.handle("natively:stop", (_event, input) => {
  const streamId = typeof input?.streamId === "string" ? input.streamId : "";
  appendTraceEvent("natively_stop_requested", { streamId: streamId || "all" });
  writeActiveSessionTrace("active");
  if (streamId) return stopNativelyStream(streamId);
  stopAllNativelyStreams();
  return { ok: true };
});
ipcMain.handle("session:export-file", async (_event, session) => {
  const title = typeof session?.title === "string" && session.title.trim() ? session.title.trim() : "callpilot-session";
  const safeTitle = title.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 80) || "callpilot-session";
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export CallPilot session",
    defaultPath: `${safeTitle}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(result.filePath, JSON.stringify(session, null, 2));
  return { ok: true, path: result.filePath };
});
ipcMain.handle("session:import-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import CallPilot session",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, path: result.filePaths[0], json: fs.readFileSync(result.filePaths[0], "utf8") };
});
ipcMain.handle("ollama:list-models", async (_event, input) => {
  const baseUrl = normalizeOllamaBaseUrl(input?.ollamaBaseUrl || readSettings().ollamaBaseUrl);
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        models: [],
        baseUrl,
        error: payload?.error ?? `ollama_http_${response.status}`,
      };
    }
    return {
      ok: true,
      models: extractOllamaModels(payload),
      baseUrl,
    };
  } catch (error) {
    return {
      ok: false,
      models: [],
      baseUrl,
      error: error instanceof Error ? `ollama_unavailable: ${error.message}` : "ollama_unavailable",
    };
  }
});
const listOpenAICompatibleProviderModels = async (provider, missingKeyError, unavailablePrefix) => {
  const modelsUrl = openAICompatibleModelsUrl(provider.chatUrl());
  const apiKey = provider.apiKey?.({}) ?? "";
  if (!apiKey) {
    return {
      ok: false,
      models: [],
      baseUrl: modelsUrl,
      error: missingKeyError,
    };
  }
  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        models: [],
        baseUrl: modelsUrl,
        error: payload?.error?.message ?? payload?.error ?? `${provider.id}_models_http_${response.status}`,
      };
    }
    return {
      ok: true,
      models: extractOpenAICompatibleModels(payload),
      baseUrl: modelsUrl,
    };
  } catch (error) {
    return {
      ok: false,
      models: [],
      baseUrl: modelsUrl,
      error: error instanceof Error ? `${unavailablePrefix}: ${error.message}` : unavailablePrefix,
    };
  }
};
ipcMain.handle("nvidia:list-models", async () => listOpenAICompatibleProviderModels(providerPresets.nvidia, "missing_nvidia_api_key", "nvidia_models_unavailable"));
ipcMain.handle("groq:list-models", async () => listOpenAICompatibleProviderModels(providerPresets.groq, "missing_groq_api_key", "groq_models_unavailable"));
ipcMain.handle("model:generate", async (_event, input) => {
  const startedAt = Date.now();
  const provider = resolveAnswerProvider(input);
  const modelName = resolveAnswerModel(provider, input);
  const requestId = createAnswerRequestId(input);
  const normalizedInput = { ...(input || {}), requestId };
  const controller = new AbortController();
  let timedOut = false;
  const requestedTimeout = Number(input?.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(1000, Math.min(180000, Math.round(requestedTimeout)))
    : input?.structuredOutput ? 60000
    : Number(input?.maxTokens) > 500 ? 120000 : 25000;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  activeAnswerControllers.set(requestId, controller);
  const prompt = input?.prompt;
  appendTraceEvent("model_generate_started", {
    requestId,
    provider: provider.id,
    protocol: provider.protocol,
    modelName,
    structuredOutput: Boolean(input?.structuredOutput),
    liveSpokenOutput: Boolean(input?.liveSpokenOutput),
    maxTokens: input?.maxTokens,
    timeoutMs,
    prompt: promptSummary(prompt),
  });
  writeActiveSessionTrace("active");

  let result;
  try {
    if (provider.protocol === "mock") {
      result = { ok: true, text: createMockAnswer(prompt), provider: provider.id, modelName, requestId };
    } else if (provider.protocol === "ollama_chat") {
      result = await generateWithOllamaChat({ provider, input: normalizedInput, prompt, modelName, signal: controller.signal });
    } else if (provider.protocol === "openai_chat") {
      result = await generateWithOpenAICompatibleChat({ provider, input: normalizedInput, prompt, modelName, event: _event, signal: controller.signal });
    } else if (provider.protocol === "openai_responses") {
      result = await generateWithOpenAIResponses({ provider, input: normalizedInput, prompt, modelName, event: _event, signal: controller.signal });
    } else {
      result = { ok: false, text: "", provider: provider.id, modelName, requestId, error: `unsupported_provider_protocol:${provider.protocol}` };
    }
  } catch (error) {
    result = {
      ok: false,
      text: "",
      provider: provider.id,
      modelName,
      requestId,
      error: timedOut ? "timeout" : isAbortError(error) ? "cancelled" : error instanceof Error ? error.message : "model_generation_failed",
      cancelled: !timedOut && isAbortError(error),
    };
  } finally {
    clearTimeout(timeout);
    activeAnswerControllers.delete(requestId);
  }
  appendTraceEvent("model_generate_completed", {
    requestId,
    durationMs: Date.now() - startedAt,
    result: resultSummary(result),
  });
  writeActiveSessionTrace("active");
  return result;
});
ipcMain.handle("audio:transcribe", async (_event, input) => {
  const startedAt = Date.now();
  const provider = input?.provider === "natively" ? "natively" : "openai";
  const modelName = typeof input?.modelName === "string" && input.modelName.trim()
    ? input.modelName.trim()
    : readSettings().transcriptionModelName || settingsDefaults.transcriptionModelName;
  const mimeType = normalizeAudioMimeType(input?.mimeType);
  const fileName = typeof input?.fileName === "string" && input.fileName.trim()
    ? input.fileName.trim()
    : `callpilot-audio.${audioExtensionForMimeType(mimeType)}`;
  const apiKey = provider === "natively"
    ? (typeof input?.nativelyApiKey === "string" && input.nativelyApiKey.trim()
      ? input.nativelyApiKey.trim()
      : process.env.NATIVELY_API_KEY || getStoredNativelyKey())
    : (typeof input?.apiKey === "string" && input.apiKey.trim()
    ? input.apiKey.trim()
    : process.env.OPENAI_API_KEY || getStoredOpenAIKey());

  const rawAudio = input?.arrayBuffer;
  const audioBuffer = rawAudio instanceof ArrayBuffer
    ? Buffer.from(rawAudio)
    : ArrayBuffer.isView(rawAudio)
      ? Buffer.from(rawAudio.buffer, rawAudio.byteOffset, rawAudio.byteLength)
      : Buffer.alloc(0);

  appendTraceEvent("audio_transcribe_started", {
    provider,
    modelName,
    mimeType,
    fileName,
    audioBytes: audioBuffer.length,
  });
  writeActiveSessionTrace("active");

  const finishTranscriptionTrace = (result) => {
    appendTraceEvent("audio_transcribe_completed", {
      provider,
      modelName: result?.modelName || modelName,
      durationMs: Date.now() - startedAt,
      ok: Boolean(result?.ok),
      error: result?.error,
      text: textSummary(result?.text, 140),
    });
    writeActiveSessionTrace("active");
    return result;
  };

  if (!apiKey) return finishTranscriptionTrace({ ok: false, text: "", modelName, error: provider === "natively" ? "missing_natively_api_key" : "missing_openai_api_key" });
  if (provider === "natively") {
    return finishTranscriptionTrace({
      ok: false,
      text: "",
      modelName: "natively-stt",
      error: "natively_pcm_streaming_not_configured",
    });
  }
  if (!supportedAudioMimeTypes.has(mimeType)) return finishTranscriptionTrace({ ok: false, text: "", modelName, error: "unsupported_audio_type" });
  if (audioBuffer.length === 0) return finishTranscriptionTrace({ ok: false, text: "", modelName, error: "empty_audio_file" });
  if (audioBuffer.length > openAITranscriptionMaxBytes) return finishTranscriptionTrace({ ok: false, text: "", modelName, error: "audio_file_too_large" });

  try {
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: mimeType }), fileName);
    form.append("model", modelName);
    form.append("response_format", "json");

    const response = await fetch(`${openAIBaseUrl()}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      body: form,
    });

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => "");
    if (!response.ok) {
      return finishTranscriptionTrace({
        ok: false,
        text: "",
        modelName,
        error: payload?.error?.message ?? `openai_http_${response.status}`,
      });
    }

    const text = extractOpenAITranscriptionText(payload);
    return finishTranscriptionTrace({ ok: Boolean(text), text, modelName, error: text ? undefined : "empty_transcription_response" });
  } catch (error) {
    return finishTranscriptionTrace({
      ok: false,
      text: "",
      modelName,
      error: error instanceof Error ? error.message : "audio_transcription_failed",
    });
  }
});
ipcMain.handle("screen:capture", async (_event, input) => {
  const startedAt = Date.now();
  try {
    const preferWindowTitle = typeof input?.preferWindowTitle === "string" ? input.preferWindowTitle.trim().toLowerCase() : "";
    const strictWindowTitle = Boolean(input?.strictWindowTitle);
    const sourceTypes = preferWindowTitle ? ["window", "screen"] : ["screen"];
    const hideCallPilotWindows = Boolean(input?.hideCallPilotWindows);
    const sources = await (hideCallPilotWindows
      ? temporarilyHideSessionWindows(() => desktopCapturer.getSources({ types: sourceTypes, thumbnailSize: { width: 1600, height: 1000 } }))
      : desktopCapturer.getSources({ types: sourceTypes, thumbnailSize: { width: 1600, height: 1000 } }));
    const sourceNames = sources.map((item) => sanitizeCaptureSourceName(item.name)).filter(Boolean).slice(0, 40);
    const preferredWindowSource = preferWindowTitle
      ? sources.find((item) => item.id?.startsWith("window:") && String(item.name || "").toLowerCase().includes(preferWindowTitle))
      : null;
    if (preferWindowTitle && strictWindowTitle && !preferredWindowSource) {
      appendTraceEvent("screen_capture_completed", {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: "preferred_window_not_found",
        preferredWindowTitle: preferWindowTitle,
        sourceNames,
      });
      writeActiveSessionTrace("active");
      return { ok: false, error: "preferred_window_not_found", preferredWindowTitle: preferWindowTitle, sourceNames };
    }
    const source = preferWindowTitle
      ? preferredWindowSource || sources.find((item) => item.id?.startsWith("screen:")) || sources[0]
      : sources[0];
    if (!source) {
      appendTraceEvent("screen_capture_completed", { ok: false, durationMs: Date.now() - startedAt, error: "no_screen_source" });
      writeActiveSessionTrace("active");
      return { ok: false, error: "no_screen_source" };
    }
    const screenshotDir = path.join(userDataPath(), "screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });
    const filePath = path.join(screenshotDir, `screen-${Date.now()}.png`);
    const png = source.thumbnail.toPNG();
    if (!png.length) {
      appendTraceEvent("screen_capture_completed", {
        ok: false,
        durationMs: Date.now() - startedAt,
        displayName: source.name,
        preferredWindowTitle: preferWindowTitle || undefined,
        hideCallPilotWindows,
        error: "empty_screen_capture",
      });
      writeActiveSessionTrace("active");
      return { ok: false, error: "empty_screen_capture", displayName: source.name };
    }
    fs.writeFileSync(filePath, png);
    appendTraceEvent("screen_capture_completed", {
      ok: true,
      durationMs: Date.now() - startedAt,
      displayName: source.name,
      preferredWindowTitle: preferWindowTitle || undefined,
      hideCallPilotWindows,
      bytes: png.length,
      fileName: path.basename(filePath),
    });
    writeActiveSessionTrace("active");
    return { ok: true, path: filePath, displayName: source.name };
  } catch (error) {
    appendTraceEvent("screen_capture_completed", {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "screen_capture_failed",
    });
    writeActiveSessionTrace("active");
    return { ok: false, error: error instanceof Error ? error.message : "screen_capture_failed" };
  }
});
ipcMain.handle("screen:ocr", async (_event, input) => {
  const startedAt = Date.now();
  appendTraceEvent("screen_ocr_started", {
    language: input?.language,
    fileName: typeof input?.path === "string" && input.path ? path.basename(input.path) : "",
    timeoutMs: OCR_BEST_EFFORT_BUDGET_MS,
  });
  writeActiveSessionTrace("active");
  const result = await recognizeImageTextBestEffort({
    imagePath: typeof input?.path === "string" ? input.path : "",
    language: input?.language,
  });
  appendTraceEvent("screen_ocr_completed", {
    ok: Boolean(result?.ok),
    durationMs: Date.now() - startedAt,
    language: input?.language,
    confidence: result?.confidence,
    error: result?.error,
    text: textSummary(result?.text, 160),
  });
  writeActiveSessionTrace("active");
  return result;
});
ipcMain.handle("screen:publish-context", (_event, payload) => {
  const screenshotPath = typeof payload?.screenshotPath === "string" ? payload.screenshotPath : "";
  const visibleText = typeof payload?.visibleText === "string" ? payload.visibleText : "";
  const displayName = typeof payload?.displayName === "string" ? payload.displayName : "";
  const source = typeof payload?.source === "string" ? payload.source : "unknown";
  if (!screenshotPath && !visibleText.trim()) {
    appendTraceEvent("screen_context_publish_failed", { source, error: "empty_screen_context" });
    writeActiveSessionTrace("active");
    return { ok: false, error: "empty_screen_context" };
  }
  const contextPayload = {
    screenshotPath,
    visibleText,
    displayName,
    source,
    capturedAt: typeof payload?.capturedAt === "number" ? payload.capturedAt : Date.now(),
  };
  appendTraceEvent("screen_context_published", {
    source,
    hasScreenshot: Boolean(screenshotPath),
    displayName,
    text: textSummary(visibleText, 180),
    fileName: screenshotPath ? path.basename(screenshotPath) : "",
  });
  writeActiveSessionTrace("active");
  mainWindow?.webContents.send("screen:context-published", contextPayload);
  sendToSessionWindows("screen:context-published", contextPayload);
  return { ok: true };
});
ipcMain.handle("screen:analyze", async (_event, input) => {
  const startedAt = Date.now();
  const imagePath = typeof input?.path === "string" ? input.path : "";
  const provider = input?.provider === "nvidia" ? "nvidia" : "openai";
  const requestedModelName = typeof input?.modelName === "string" && input.modelName.trim() ? input.modelName.trim() : settingsDefaults.modelName;
  const modelName = provider === "nvidia" && !isLikelyVisionModel(requestedModelName)
    ? defaultNvidiaVisionModel()
    : requestedModelName;
  const apiKey = provider === "nvidia"
    ? (typeof input?.nvidiaApiKey === "string" && input.nvidiaApiKey.trim()
      ? input.nvidiaApiKey.trim()
      : process.env.NVIDIA_API_KEY || process.env.CALLPILOT_NVIDIA_API_KEY || getStoredNvidiaKey())
    : (typeof input?.apiKey === "string" && input.apiKey.trim()
      ? input.apiKey.trim()
      : process.env.OPENAI_API_KEY || getStoredOpenAIKey());

  const finishScreenAnalysisTrace = (result) => {
    appendTraceEvent("screen_analysis_completed", {
      ok: Boolean(result?.ok),
      durationMs: Date.now() - startedAt,
      provider,
      modelName,
      error: result?.error,
      imageFileName: imagePath ? path.basename(imagePath) : "",
      text: textSummary(result?.text, 180),
    });
    writeActiveSessionTrace("active");
    return result;
  };

  if (String(modelName).startsWith("mock-vision")) {
    return finishScreenAnalysisTrace({
      ok: true,
      text: JSON.stringify({
        problemTitle: "Two Sum",
        functionSignature: "def two_sum(nums, target):",
        language: "Python",
        examples: ["nums=[2,7,11,15], target=9 -> [0,1]"],
        constraints: [],
        solution: "Use a hashmap to track seen values and return matching indices.",
      }),
      provider: "mock",
      modelName,
    });
  }

  if (!apiKey) return finishScreenAnalysisTrace({ ok: false, text: "", error: provider === "nvidia" ? "missing_nvidia_api_key" : "missing_openai_api_key" });
  if (!modelName) return finishScreenAnalysisTrace({ ok: false, text: "", error: provider === "nvidia" ? "missing_nvidia_vision_model" : "missing_openai_model" });
  if (!imagePath || !fs.existsSync(imagePath)) return finishScreenAnalysisTrace({ ok: false, text: "", error: "missing_screenshot_file" });

  try {
    const imageDataUrl = `data:image/png;base64,${fs.readFileSync(imagePath, "base64")}`;
    const ocr = input?.skipOcr === true
      ? { ok: false, text: "", error: "ocr_skipped" }
      : await recognizeImageTextBestEffort({ imagePath, language: input?.language || "eng" }).catch((error) => ({
        ok: false,
        text: "",
        error: error instanceof Error ? error.message : "ocr_failed",
      }));
    const visibleOcrText = removeNonTechnicalOcrNoise(ocr?.text);
    const prompt = [
      "Analyze this screenshot for a live coding interview assistant.",
      "Use the screenshot image, not OCR text, as the source of truth.",
      visibleOcrText ? `Local OCR visible text, for exact transcription support:\n${visibleOcrText}` : "",
      "Return only JSON with these fields: visibleTextExact, technicalFocus, problemStatement, visibleCode, testsOrErrors, constraints, examples, inferredTask, ignoredUi.",
      "Put coding-problem, code, terminal, tests, errors, constraints, examples, function names, variables, and complexity hints in technicalFocus.",
      "Put replay/player/browser/app chrome, logos, buttons, signup banners, video titles, and generic screenshot descriptions in ignoredUi, not in technicalFocus.",
      "Include visibleTextExact as short verbatim snippets of important text that is actually visible in the screenshot.",
      "Do not invent code, errors, test results, or text that is not visible.",
      "Do not write an implementation or code block unless code is visibly present in the screenshot. For problem-statement-only screenshots, describe the approach without code.",
      "If unrelated chat, Slack, calendar, or notification content is visible, do not transcribe or treat that message as part of the technical problem.",
      "If the screenshot shows only a problem statement and no code editor content, leave solution.code empty and summarize the approach without presenting code as visible.",
      "If the screenshot is not a coding problem or code editor, return empty coding fields and a concise summary.",
    ].filter(Boolean).join(" ");
    if (provider === "nvidia") {
      const response = await fetchWithRetry(providerPresets.nvidia.chatUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          stream: false,
          max_tokens: 700,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
              ],
            },
          ],
        }),
      }, { provider: "nvidia-vision" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return finishScreenAnalysisTrace({ ok: false, text: "", error: payload?.error?.message ?? payload?.error ?? `nvidia_vision_http_${response.status}` });
      }
      const text = stripInventedCodeWhenNoVisibleCode(extractOpenAICompatibleChatText(payload), visibleOcrText);
      const codeOcrText = normalizeCodeLikeOcrText(visibleOcrText);
      const technicalOcrFocus = extractTechnicalOcrFocus(codeOcrText || visibleOcrText);
      const enrichedText = [
        technicalOcrFocus ? `Technical OCR focus:\n${technicalOcrFocus}` : "",
        text ? `Vision summary (secondary; ignore if it conflicts with OCR):\n${text}` : "",
        visibleOcrText ? `Visible OCR text:\n${visibleOcrText}` : "",
        codeOcrText && codeOcrText !== visibleOcrText ? `Code-normalized OCR text:\n${codeOcrText}` : "",
      ].filter(Boolean).join("\n\n");
      return finishScreenAnalysisTrace({
        ok: Boolean(enrichedText),
        text: enrichedText,
        provider,
        modelName,
        ocrText: visibleOcrText || "",
        rawOcrText: ocr?.text || "",
        codeOcrText,
        technicalOcrFocus,
        ocrConfidence: ocr?.confidence,
        error: enrichedText ? undefined : "empty_nvidia_vision_response",
      });
    }

    const response = await fetch(`${openAIBaseUrl()}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: prompt,
              },
              { type: "input_image", image_url: imageDataUrl, detail: "high" },
            ],
          },
        ],
        store: false,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return finishScreenAnalysisTrace({ ok: false, text: "", error: payload?.error?.message ?? `openai_http_${response.status}` });
    }
    const text = stripInventedCodeWhenNoVisibleCode(extractOpenAIResponseText(payload), visibleOcrText);
    const codeOcrText = normalizeCodeLikeOcrText(visibleOcrText);
    const technicalOcrFocus = extractTechnicalOcrFocus(codeOcrText || visibleOcrText);
    const enrichedText = [
      technicalOcrFocus ? `Technical OCR focus:\n${technicalOcrFocus}` : "",
      text ? `Vision summary (secondary; ignore if it conflicts with OCR):\n${text}` : "",
      visibleOcrText ? `Visible OCR text:\n${visibleOcrText}` : "",
      codeOcrText && codeOcrText !== visibleOcrText ? `Code-normalized OCR text:\n${codeOcrText}` : "",
    ].filter(Boolean).join("\n\n");
    return finishScreenAnalysisTrace({
      ok: Boolean(enrichedText),
      text: enrichedText,
      provider,
      modelName,
      ocrText: visibleOcrText || "",
      rawOcrText: ocr?.text || "",
      codeOcrText,
      technicalOcrFocus,
      ocrConfidence: ocr?.confidence,
      error: enrichedText ? undefined : "empty_openai_response",
    });
  } catch (error) {
    return finishScreenAnalysisTrace({ ok: false, text: "", error: error instanceof Error ? error.message : "screen_analysis_failed" });
  }
});

app.whenReady().then(async () => {
  configureMediaCapture();
  await createWindow();
  registerShortcuts();
  startRemoteControlServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (remoteControlServer) {
    remoteControlServer.close();
    remoteControlServer = null;
  }
  for (const workerPromise of ocrWorkers.values()) {
    workerPromise.then((worker) => worker.terminate()).catch(() => {});
  }
});
