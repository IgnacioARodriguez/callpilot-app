const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "dist/index.html",
  "electron/main.cjs",
  "electron/preload.cjs",
  "package.json",
];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length > 0) {
  console.error(`Missing desktop build inputs: ${missing.join(", ")}`);
  process.exit(1);
}

const distAssets = fs.readdirSync(path.join(root, "dist", "assets"));
if (!distAssets.some((file) => file.endsWith(".wasm"))) {
  console.error("Desktop build is missing local STT WASM runtime.");
  process.exit(1);
}
if (!distAssets.some((file) => /transformers/i.test(file))) {
  console.error("Desktop build is missing local Transformers STT bundle.");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.main !== "electron/main.cjs") {
  console.error(`package.json main must point to electron/main.cjs, got ${pkg.main}`);
  process.exit(1);
}

const indexHtml = fs.readFileSync(path.join(root, "dist", "index.html"), "utf8");
if (indexHtml.includes('src="/assets/') || indexHtml.includes('href="/assets/')) {
  console.error("dist/index.html uses absolute asset paths that break under Electron file:// loading.");
  process.exit(1);
}

const mainSource = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
for (const needle of ["setContentProtection", "setIgnoreMouseEvents", "globalShortcut", "desktopCapturer", "setDisplayMediaRequestHandler", "loopback", "audio:transcribe", "/api/chat", "/api/tags", "ollama:list-models", "screen:ocr", "tesseract.js"]) {
  if (!mainSource.includes(needle)) {
    console.error(`Electron main is missing expected desktop capability: ${needle}`);
    process.exit(1);
  }
}

const preloadSource = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
for (const needle of ["generateAnswer", "listOllamaModels", "captureScreenshot", "recognizeScreenText", "transcribeAudio", "runPrivacyCheck", "applyShareSafe", "getSessionTraceStatus"]) {
  if (!preloadSource.includes(needle)) {
    console.error(`Electron preload is missing expected bridge capability: ${needle}`);
    process.exit(1);
  }
}

console.log("Desktop build inputs verified.");
