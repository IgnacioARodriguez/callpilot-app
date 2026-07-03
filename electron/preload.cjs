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
});
