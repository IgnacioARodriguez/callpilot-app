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
  captureScreenshot: (input) => ipcRenderer.invoke("screen:capture", input),
  recognizeScreenText: (input) => ipcRenderer.invoke("screen:ocr", input),
  analyzeScreenshot: (input) => ipcRenderer.invoke("screen:analyze", input),
  publishScreenContext: (payload) => ipcRenderer.invoke("screen:publish-context", payload),
  startSession: (options) => ipcRenderer.invoke("session:start", options),
  endSession: () => ipcRenderer.invoke("session:end"),
  getSessionTraceStatus: () => ipcRenderer.invoke("session:trace-status"),
  recordSessionEvent: (type, payload) => ipcRenderer.invoke("session:trace-event", type, payload),
  requestAnswer: () => ipcRenderer.invoke("answer:request"),
  cancelAnswer: (requestId) => ipcRenderer.invoke("answer:cancel", requestId),
  publishTranscriptMessage: (message) => ipcRenderer.invoke("transcript:publish", message),
  publishLiveTranscript: (message) => ipcRenderer.invoke("transcript:publish-live", message),
  publishStructuredAnswer: (payload) => ipcRenderer.invoke("answer:publish-structured", payload),
  publishAnswerStatus: (payload) => ipcRenderer.invoke("answer:publish-status", payload),
  listOllamaModels: (input) => ipcRenderer.invoke("ollama:list-models", input),
  listNvidiaModels: () => ipcRenderer.invoke("nvidia:list-models"),
  generateAnswer: (input) => ipcRenderer.invoke("model:generate", input),
  transcribeAudio: (input) => ipcRenderer.invoke("audio:transcribe", input),
  startNativelyTranscription: (input) => ipcRenderer.invoke("natively:start", input),
  sendNativelyAudio: (input) => ipcRenderer.invoke("natively:audio", input),
  stopNativelyTranscription: (input) => ipcRenderer.invoke("natively:stop", input),
  getCredentialStatus: () => ipcRenderer.invoke("credentials:status"),
  saveOpenAIKey: (apiKey) => ipcRenderer.invoke("credentials:save-openai-key", apiKey),
  saveNativelyKey: (apiKey) => ipcRenderer.invoke("credentials:save-natively-key", apiKey),
  saveNvidiaKey: (apiKey) => ipcRenderer.invoke("credentials:save-nvidia-key", apiKey),
  clearOpenAIKey: () => ipcRenderer.invoke("credentials:clear-openai-key"),
  clearNativelyKey: () => ipcRenderer.invoke("credentials:clear-natively-key"),
  clearNvidiaKey: () => ipcRenderer.invoke("credentials:clear-nvidia-key"),
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
  onManualAnswerRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("answer:manual-request", handler);
    return () => ipcRenderer.removeListener("answer:manual-request", handler);
  },
  onManualAnswerStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("answer:manual-status", handler);
    return () => ipcRenderer.removeListener("answer:manual-status", handler);
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
  onStructuredAnswer: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("answer:structured", handler);
    return () => ipcRenderer.removeListener("answer:structured", handler);
  },
  onAnswerStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("answer:status", handler);
    return () => ipcRenderer.removeListener("answer:status", handler);
  },
  onTranscriptMessage: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("transcript:message", handler);
    return () => ipcRenderer.removeListener("transcript:message", handler);
  },
  onLiveTranscript: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("transcript:live", handler);
    return () => ipcRenderer.removeListener("transcript:live", handler);
  },
  onNativelyTranscript: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("natively:transcript", handler);
    return () => ipcRenderer.removeListener("natively:transcript", handler);
  },
  onNativelyStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("natively:status", handler);
    return () => ipcRenderer.removeListener("natively:status", handler);
  },
  onScreenContextPublished: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("screen:context-published", handler);
    return () => ipcRenderer.removeListener("screen:context-published", handler);
  },
});
