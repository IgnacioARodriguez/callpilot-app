const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("callpilotDesktop", {
  getStealthState: () => ipcRenderer.invoke("stealth:get"),
  setCallPrivacyAllowed: (allowed) => ipcRenderer.invoke("stealth:set-call-privacy-allowed", allowed),
  setOverlayVisible: (visible) => ipcRenderer.invoke("stealth:set-overlay-visible", visible),
  setContentProtection: (enabled) => ipcRenderer.invoke("stealth:set-content-protection", enabled),
  setMousePassthrough: (enabled) => ipcRenderer.invoke("stealth:set-mouse-passthrough", enabled),
  applyShareSafe: () => ipcRenderer.invoke("stealth:apply-share-safe"),
  resetPrivacy: () => ipcRenderer.invoke("stealth:reset-privacy"),
  runPrivacyCheck: () => ipcRenderer.invoke("privacy:check"),
  captureScreenshot: () => ipcRenderer.invoke("screen:capture"),
  recognizeScreenText: (input) => ipcRenderer.invoke("screen:ocr", input),
  analyzeScreenshot: (input) => ipcRenderer.invoke("screen:analyze", input),
  startSession: () => ipcRenderer.invoke("session:start"),
  endSession: () => ipcRenderer.invoke("session:end"),
  publishTranscriptMessage: (message) => ipcRenderer.invoke("transcript:publish", message),
  listOllamaModels: (input) => ipcRenderer.invoke("ollama:list-models", input),
  generateAnswer: (input) => ipcRenderer.invoke("model:generate", input),
  transcribeAudio: (input) => ipcRenderer.invoke("audio:transcribe", input),
  getCredentialStatus: () => ipcRenderer.invoke("credentials:status"),
  saveOpenAIKey: (apiKey) => ipcRenderer.invoke("credentials:save-openai-key", apiKey),
  clearOpenAIKey: () => ipcRenderer.invoke("credentials:clear-openai-key"),
  exportSessionFile: (session) => ipcRenderer.invoke("session:export-file", session),
  importSessionFile: () => ipcRenderer.invoke("session:import-file"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  getShortcutHealth: () => ipcRenderer.invoke("shortcuts:health"),
  onShortcut: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("shortcut", handler);
    return () => ipcRenderer.removeListener("shortcut", handler);
  },
  onAnswerHeadline: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("answer:headline", handler);
    return () => ipcRenderer.removeListener("answer:headline", handler);
  },
  onAnswerDetailChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on("answer:detail-chunk", handler);
    return () => ipcRenderer.removeListener("answer:detail-chunk", handler);
  },
  onTranscriptMessage: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("transcript:message", handler);
    return () => ipcRenderer.removeListener("transcript:message", handler);
  },
});
