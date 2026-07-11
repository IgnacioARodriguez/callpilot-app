const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, safeStorage, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createWorker } = require("tesseract.js");

if (process.env.CALLPILOT_REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.CALLPILOT_REMOTE_DEBUG_PORT);
}

let mainWindow = null;
let overlayWindow = null;
let shortcutHealth = [];
const ocrWorkers = new Map();

const stealthState = {
  callPrivacyAllowed: false,
  overlayVisible: true,
  contentProtectionEnabled: false,
  mousePassthroughEnabled: false,
  focusMode: "interactive",
  shortcutLayerActive: true,
};

const settingsDefaults = {
  modelProvider: "mock",
  // ASSUMPTION: no OpenAI API key was available during implementation to verify /v1/models, so OpenAI model selection is user-configured instead of hardcoded.
  modelName: "",
  ollamaBaseUrl: "http://localhost:11434",
  transcriptionModelName: "gpt-4o-transcribe",
  preferredLanguage: "auto",
  defaultCodingLanguage: "Python",
  answerVerbosity: "medium",
  activeMode: "live_coding",
  liveTranscriptionProvider: "local",
  liveLatencyPreset: "balanced",
  liveAudioSource: "both",
  autoAnswerCooldownMs: 12000,
  autoAnswerMinConfidence: 0.45,
};

const openAITranscriptionMaxBytes = 25 * 1024 * 1024;
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

const readSettings = () => {
  try {
    return { ...settingsDefaults, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
  } catch {
    return { ...settingsDefaults };
  }
};

const writeSettings = (settings) => {
  const next = { ...settingsDefaults, ...(settings && typeof settings === "object" ? settings : {}) };
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

const credentialStatus = () => ({
  ok: true,
  hasOpenAIKey: Boolean(getStoredOpenAIKey()),
  encryptionAvailable: safeStorage.isEncryptionAvailable(),
});

const saveStoredOpenAIKey = (apiKey) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, hasOpenAIKey: false, encryptionAvailable: false, error: "safe_storage_unavailable" };
  }
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return { ...credentialStatus(), ok: false, error: "empty_api_key" };
  saveCredentials({
    ...readCredentials(),
    openaiApiKey: safeStorage.encryptString(key).toString("base64"),
  });
  return { ok: true, hasOpenAIKey: true, encryptionAvailable: true };
};

const clearStoredOpenAIKey = () => {
  const credentials = readCredentials();
  delete credentials.openaiApiKey;
  saveCredentials(credentials);
  return { ok: true, hasOpenAIKey: false, encryptionAvailable: safeStorage.isEncryptionAvailable() };
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

const structuredAnswerJsonSchema = {
  name: "structured_interview_answer",
  schema: {
    type: "object",
    properties: {
      headline: { type: "string" },
      keywords: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 5 },
      detail: { type: "string" },
    },
    required: ["headline", "keywords", "detail"],
    additionalProperties: false,
  },
};

const parseStructuredAnswer = (text) => {
  try {
    const value = JSON.parse(String(text || ""));
    return {
      headline: typeof value.headline === "string" ? value.headline : "",
      keywords: Array.isArray(value.keywords) ? value.keywords.filter((item) => typeof item === "string").slice(0, 5) : [],
      detail: typeof value.detail === "string" ? value.detail : "",
    };
  } catch {
    return { headline: "", keywords: [], detail: String(text || "") };
  }
};

const createPromptCacheKey = (prompt) => {
  const stablePrefix = [
    String(prompt?.system ?? ""),
    String(prompt?.user ?? "").split("<transcript>")[0] ?? "",
  ].join("\n");
  return `callpilot:${crypto.createHash("sha256").update(stablePrefix).digest("hex").slice(0, 24)}`;
};

const readOpenAISseStream = async (response, onEvent) => {
  if (!response.body) return "";
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const rawEvent of events) {
      const dataLines = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      for (const line of dataLines) {
        if (!line || line === "[DONE]") continue;
        const event = JSON.parse(line);
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          fullText += event.delta;
        }
        onEvent?.(event);
      }
    }
  }
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

const getOcrWorker = async (language) => {
  const normalizedLanguage = normalizeOcrLanguage(language);
  if (!ocrWorkers.has(normalizedLanguage)) {
    const workerPromise = createWorker(normalizedLanguage, 1, {
      cachePath: path.join(userDataPath(), "tesseract-cache"),
      logger: () => {},
    });
    ocrWorkers.set(normalizedLanguage, workerPromise);
  }
  return ocrWorkers.get(normalizedLanguage);
};

const recognizeImageText = async ({ imagePath, language }) => {
  const normalizedLanguage = normalizeOcrLanguage(language);
  if (!imagePath || typeof imagePath !== "string") {
    return { ok: false, text: "", language: normalizedLanguage, error: "missing_image_path" };
  }
  if (!fs.existsSync(imagePath)) {
    return { ok: false, text: "", language: normalizedLanguage, path: imagePath, error: "image_not_found" };
  }

  try {
    const worker = await getOcrWorker(normalizedLanguage);
    const result = await worker.recognize(imagePath);
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
    return {
      ok: false,
      text: "",
      language: normalizedLanguage,
      path: imagePath,
      error: error instanceof Error ? error.message : "ocr_failed",
    };
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
  stealthState.overlayVisible = false;
  stealthState.contentProtectionEnabled = true;
  stealthState.mousePassthroughEnabled = true;
  stealthState.focusMode = "passthrough";
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
  });
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

  const status = !stealthState.overlayVisible && stealthState.contentProtectionEnabled ? "safe" : "risk";
  return {
    status,
    summary: status === "safe"
      ? "Local privacy posture is share-safe, pending platform observer check."
      : "Local privacy posture has visible or unprotected elements.",
    findings,
    checkedAt: new Date().toISOString(),
  };
};

const syncWindowState = () => {
  normalizeStealthState();
  for (const windowRef of [mainWindow, overlayWindow]) {
    if (!windowRef) continue;
    windowRef.setAlwaysOnTop(true, "screen-saver");
    windowRef.setContentProtection(Boolean(stealthState.contentProtectionEnabled));
    windowRef.setIgnoreMouseEvents(Boolean(stealthState.mousePassthroughEnabled), { forward: true });
  }
  if (mainWindow && stealthState.overlayVisible && !overlayWindow) {
    if (!mainWindow.isVisible()) mainWindow.showInactive();
  } else if (mainWindow) {
    mainWindow.hide();
  }
};

const createOverlayWindow = async () => {
  if (overlayWindow) {
    overlayWindow.showInactive();
    return;
  }
  overlayWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 320,
    minHeight: 260,
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

const sendToOverlay = (channel, payload) => {
  overlayWindow?.webContents.send(channel, payload);
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
ipcMain.handle("session:start", async () => {
  await createOverlayWindow();
  mainWindow?.hide();
  return { ok: true };
});
ipcMain.handle("session:end", () => {
  closeOverlayWindow();
  mainWindow?.show();
  return { ok: true };
});
ipcMain.handle("transcript:publish", (_event, message) => {
  sendToOverlay("transcript:message", message);
  return { ok: true };
});
ipcMain.handle("settings:get", () => readSettings());
ipcMain.handle("settings:save", (_event, settings) => writeSettings(settings));
ipcMain.handle("shortcuts:health", () => shortcutHealth.map((item) => ({ ...item })));
ipcMain.handle("credentials:status", () => credentialStatus());
ipcMain.handle("credentials:save-openai-key", (_event, apiKey) => saveStoredOpenAIKey(apiKey));
ipcMain.handle("credentials:clear-openai-key", () => clearStoredOpenAIKey());
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
ipcMain.handle("model:generate", async (_event, input) => {
  const provider = input?.provider === "openai" || input?.provider === "ollama" ? input.provider : "mock";
  const modelName = typeof input?.modelName === "string" && input.modelName.trim() ? input.modelName.trim() : settingsDefaults.modelName;
  const prompt = input?.prompt;

  if (provider === "mock") {
    return { ok: true, text: createMockAnswer(prompt), provider, modelName: "mock-local" };
  }

  if (provider === "ollama") {
    const ollamaBaseUrl = normalizeOllamaBaseUrl(input?.ollamaBaseUrl || readSettings().ollamaBaseUrl);
    const ollamaModel = modelName === settingsDefaults.modelName ? "llama3.1" : modelName;
    try {
      const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ollamaModel,
          stream: false,
          messages: [
            { role: "system", content: String(prompt?.system ?? "") },
            { role: "user", content: String(prompt?.user ?? "") },
          ],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {
          ok: false,
          text: "",
          provider,
          modelName: ollamaModel,
          error: payload?.error ?? `ollama_http_${response.status}`,
        };
      }
      const text = extractOllamaResponseText(payload);
      return {
        ok: Boolean(text),
        text,
        provider,
        modelName: ollamaModel,
        error: text ? undefined : "empty_ollama_response",
      };
    } catch (error) {
      return {
        ok: false,
        text: "",
        provider,
        modelName: ollamaModel,
        error: error instanceof Error ? `ollama_unavailable: ${error.message}` : "ollama_unavailable",
      };
    }
  }

  const apiKey = typeof input?.apiKey === "string" && input.apiKey.trim()
    ? input.apiKey.trim()
    : process.env.OPENAI_API_KEY || getStoredOpenAIKey();
  if (!apiKey) {
    return { ok: false, text: "", provider, modelName, error: "missing_openai_api_key" };
  }
  if (!modelName) {
    return { ok: false, text: "", provider, modelName, error: "missing_openai_model" };
  }

  try {
    const requestBase = {
      model: modelName,
      instructions: String(prompt?.system ?? ""),
      input: String(prompt?.user ?? ""),
      prompt_cache_key: createPromptCacheKey(prompt),
      store: false,
    };
    let headlineDelivered = false;
    const pendingDetailChunks = [];
    const sendDetailChunk = (chunk) => {
      _event.sender.send("answer:detail-chunk", chunk);
      sendToOverlay("answer:detail-chunk", chunk);
    };
    const flushPendingDetailChunks = () => {
      while (pendingDetailChunks.length > 0) {
        sendDetailChunk(pendingDetailChunks.shift());
      }
    };
    const headlinePromise = fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...requestBase,
        text: {
          format: {
            type: "json_schema",
            name: structuredAnswerJsonSchema.name,
            strict: true,
            schema: structuredAnswerJsonSchema.schema,
          },
        },
      }),
    }).then(async (headlineResponse) => {
      const payload = await headlineResponse.json().catch(() => ({}));
      if (!headlineResponse.ok) {
        throw new Error(payload?.error?.message ?? `openai_headline_http_${headlineResponse.status}`);
      }
      const structured = parseStructuredAnswer(extractOpenAIResponseText(payload));
      if (structured.headline || structured.keywords.length) {
        _event.sender.send("answer:headline", {
          headline: structured.headline,
          keywords: structured.keywords,
        });
        sendToOverlay("answer:headline", {
          headline: structured.headline,
          keywords: structured.keywords,
        });
        headlineDelivered = true;
        flushPendingDetailChunks();
      }
      return structured;
    });

    const detailResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...requestBase,
        stream: true,
      }),
    });
    if (!detailResponse.ok) {
      const payload = await detailResponse.json().catch(() => ({}));
      await headlinePromise.catch(() => undefined);
      return {
        ok: false,
        text: "",
        provider,
        modelName,
        error: payload?.error?.message ?? `openai_http_${detailResponse.status}`,
      };
    }

    const text = await readOpenAISseStream(detailResponse, (event) => {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        if (headlineDelivered) {
          sendDetailChunk(event.delta);
        } else {
          pendingDetailChunks.push(event.delta);
        }
      }
    });
    const headlineResult = await headlinePromise.catch((error) => ({ headline: "", keywords: [], detail: "", error: error.message }));
    headlineDelivered = true;
    flushPendingDetailChunks();
    return {
      ok: Boolean(text),
      text,
      provider,
      modelName,
      structured: headlineResult,
      error: text ? undefined : headlineResult.error || "empty_openai_response",
    };
  } catch (error) {
    return {
      ok: false,
      text: "",
      provider,
      modelName,
      error: error instanceof Error ? error.message : "openai_request_failed",
    };
  }
});
ipcMain.handle("audio:transcribe", async (_event, input) => {
  const modelName = typeof input?.modelName === "string" && input.modelName.trim()
    ? input.modelName.trim()
    : readSettings().transcriptionModelName || settingsDefaults.transcriptionModelName;
  const mimeType = normalizeAudioMimeType(input?.mimeType);
  const fileName = typeof input?.fileName === "string" && input.fileName.trim()
    ? input.fileName.trim()
    : `callpilot-audio.${audioExtensionForMimeType(mimeType)}`;
  const apiKey = typeof input?.apiKey === "string" && input.apiKey.trim()
    ? input.apiKey.trim()
    : process.env.OPENAI_API_KEY || getStoredOpenAIKey();

  const rawAudio = input?.arrayBuffer;
  const audioBuffer = rawAudio instanceof ArrayBuffer
    ? Buffer.from(rawAudio)
    : ArrayBuffer.isView(rawAudio)
      ? Buffer.from(rawAudio.buffer, rawAudio.byteOffset, rawAudio.byteLength)
      : Buffer.alloc(0);

  if (!apiKey) return { ok: false, text: "", modelName, error: "missing_openai_api_key" };
  if (!supportedAudioMimeTypes.has(mimeType)) return { ok: false, text: "", modelName, error: "unsupported_audio_type" };
  if (audioBuffer.length === 0) return { ok: false, text: "", modelName, error: "empty_audio_file" };
  if (audioBuffer.length > openAITranscriptionMaxBytes) return { ok: false, text: "", modelName, error: "audio_file_too_large" };

  try {
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: mimeType }), fileName);
    form.append("model", modelName);
    form.append("response_format", "json");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
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
      return {
        ok: false,
        text: "",
        modelName,
        error: payload?.error?.message ?? `openai_http_${response.status}`,
      };
    }

    const text = extractOpenAITranscriptionText(payload);
    return { ok: Boolean(text), text, modelName, error: text ? undefined : "empty_transcription_response" };
  } catch (error) {
    return {
      ok: false,
      text: "",
      modelName,
      error: error instanceof Error ? error.message : "audio_transcription_failed",
    };
  }
});
ipcMain.handle("screen:capture", async () => {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1600, height: 1000 } });
  const source = sources[0];
  if (!source) return { ok: false, error: "no_screen_source" };
  const screenshotDir = path.join(userDataPath(), "screenshots");
  fs.mkdirSync(screenshotDir, { recursive: true });
  const filePath = path.join(screenshotDir, `screen-${Date.now()}.png`);
  fs.writeFileSync(filePath, source.thumbnail.toPNG());
  return { ok: true, path: filePath, displayName: source.name };
});
ipcMain.handle("screen:ocr", async (_event, input) => recognizeImageText({
  imagePath: typeof input?.path === "string" ? input.path : "",
  language: input?.language,
}));
ipcMain.handle("screen:analyze", async (_event, input) => {
  const imagePath = typeof input?.path === "string" ? input.path : "";
  const modelName = typeof input?.modelName === "string" && input.modelName.trim() ? input.modelName.trim() : settingsDefaults.modelName;
  const apiKey = typeof input?.apiKey === "string" && input.apiKey.trim()
    ? input.apiKey.trim()
    : process.env.OPENAI_API_KEY || getStoredOpenAIKey();

  if (!apiKey) return { ok: false, text: "", error: "missing_openai_api_key" };
  if (!modelName) return { ok: false, text: "", error: "missing_openai_model" };
  if (!imagePath || !fs.existsSync(imagePath)) return { ok: false, text: "", error: "missing_screenshot_file" };

  try {
    const imageDataUrl = `data:image/png;base64,${fs.readFileSync(imagePath, "base64")}`;
    const prompt = [
      "Analyze this screenshot for a live coding interview assistant.",
      "Use the screenshot image, not OCR text, as the source of truth.",
      "Return JSON with problemTitle, functionSignature, language, examples, constraints, and solution.",
      "The solution must follow these sections: Problem detected, Approach, Solution, Complexity, Edge cases, What to say out loud.",
      "If the screenshot is not a coding problem or code editor, return empty coding fields and a concise summary.",
    ].join(" ");
    const response = await fetch("https://api.openai.com/v1/responses", {
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
      return { ok: false, text: "", error: payload?.error?.message ?? `openai_http_${response.status}` };
    }
    const text = extractOpenAIResponseText(payload);
    return { ok: Boolean(text), text, error: text ? undefined : "empty_openai_response" };
  } catch (error) {
    return { ok: false, text: "", error: error instanceof Error ? error.message : "screen_analysis_failed" };
  }
});

app.whenReady().then(async () => {
  configureMediaCapture();
  await createWindow();
  registerShortcuts();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  for (const workerPromise of ocrWorkers.values()) {
    workerPromise.then((worker) => worker.terminate()).catch(() => {});
  }
});
