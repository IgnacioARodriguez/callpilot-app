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
  publishRawModelOutput: (payload) => ipcRenderer.invoke("answer:publish-raw-model-output", payload),
  publishAnswerStatus: (payload) => ipcRenderer.invoke("answer:publish-status", payload),
  listOllamaModels: (input) => ipcRenderer.invoke("ollama:list-models", input),
  listNvidiaModels: () => ipcRenderer.invoke("nvidia:list-models"),
  listGroqModels: () => ipcRenderer.invoke("groq:list-models"),
  generateAnswer: (input) => ipcRenderer.invoke("model:generate", input),
  transcribeAudio: (input) => ipcRenderer.invoke("audio:transcribe", input),
  startNativelyTranscription: (input) => ipcRenderer.invoke("natively:start", input),
  sendNativelyAudio: (input) => ipcRenderer.invoke("natively:audio", input),
  stopNativelyTranscription: (input) => ipcRenderer.invoke("natively:stop", input),
  startDeepgramTranscription: (input) => ipcRenderer.invoke("deepgram:start", input),
  sendDeepgramAudio: (input) => ipcRenderer.invoke("deepgram:audio", input),
  stopDeepgramTranscription: (input) => ipcRenderer.invoke("deepgram:stop", input),
  getCredentialStatus: () => ipcRenderer.invoke("credentials:status"),
  saveOpenAIKey: (apiKey) => ipcRenderer.invoke("credentials:save-openai-key", apiKey),
  saveNativelyKey: (apiKey) => ipcRenderer.invoke("credentials:save-natively-key", apiKey),
  saveDeepgramKey: (apiKey) => ipcRenderer.invoke("credentials:save-deepgram-key", apiKey),
  saveNvidiaKey: (apiKey) => ipcRenderer.invoke("credentials:save-nvidia-key", apiKey),
  saveGroqKey: (apiKey) => ipcRenderer.invoke("credentials:save-groq-key", apiKey),
  clearOpenAIKey: () => ipcRenderer.invoke("credentials:clear-openai-key"),
  clearNativelyKey: () => ipcRenderer.invoke("credentials:clear-natively-key"),
  clearDeepgramKey: () => ipcRenderer.invoke("credentials:clear-deepgram-key"),
  clearNvidiaKey: () => ipcRenderer.invoke("credentials:clear-nvidia-key"),
  clearGroqKey: () => ipcRenderer.invoke("credentials:clear-groq-key"),
  exportSessionFile: (session) => ipcRenderer.invoke("session:export-file", session),
  importSessionFile: () => ipcRenderer.invoke("session:import-file"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  getShortcutHealth: () => ipcRenderer.invoke("shortcuts:health"),
  getRemoteControlStatus: () => ipcRenderer.invoke("remote-control:get-status"),
  dispatchRemoteControlCommand: (command) => ipcRenderer.invoke("remote-control:dispatch-command", command),
  onShortcut: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("shortcut", handler);
    return () => ipcRenderer.removeListener("shortcut", handler);
  },
  onRemoteControlCommand: (callback) => {
    const handler = (_event, command) => callback(command);
    ipcRenderer.on("remote-control:command", handler);
    return () => ipcRenderer.removeListener("remote-control:command", handler);
  },
  onRemoteControlStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("remote-control:status", handler);
    return () => ipcRenderer.removeListener("remote-control:status", handler);
  },
  onManualAnswerRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("answer:manual-request", handler);
    return () => ipcRenderer.removeListener("answer:manual-request", handler);
  },
  onSessionEnded: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("session:ended", handler);
    return () => ipcRenderer.removeListener("session:ended", handler);
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
  onRawModelOutput: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("answer:raw-model-output", handler);
    return () => ipcRenderer.removeListener("answer:raw-model-output", handler);
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
  onDeepgramTranscript: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("deepgram:transcript", handler);
    return () => ipcRenderer.removeListener("deepgram:transcript", handler);
  },
  onDeepgramStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("deepgram:status", handler);
    return () => ipcRenderer.removeListener("deepgram:status", handler);
  },
  onScreenContextPublished: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("screen:context-published", handler);
    return () => ipcRenderer.removeListener("screen:context-published", handler);
  },
});
