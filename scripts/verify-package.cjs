const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const root = path.resolve(__dirname, "..");
const release = path.join(root, "release");

if (!fs.existsSync(release)) {
  console.error("Missing release directory. Run npm run pack first.");
  process.exit(1);
}

const appDir = fs.readdirSync(release)
  .map((name) => path.join(release, name))
  .find((candidate) => fs.statSync(candidate).isDirectory() && /CallPilot/i.test(path.basename(candidate)));

if (!appDir) {
  console.error("Could not find unpacked CallPilot app directory in release/.");
  process.exit(1);
}

const exe = fs.readdirSync(appDir).find((name) => /^CallPilot.*\.exe$/i.test(name));
if (process.platform === "win32" && !exe) {
  console.error("Windows package is missing CallPilot executable.");
  process.exit(1);
}

const appAsar = path.join(appDir, "resources", "app.asar");
if (!fs.existsSync(appAsar)) {
  console.error("Package is missing resources/app.asar.");
  process.exit(1);
}

const entries = asar.listPackage(appAsar).map((entry) => entry.replace(/\\/g, "/"));
for (const expected of ["/dist/index.html", "/electron/main.cjs", "/electron/preload.cjs", "/package.json"]) {
  if (!entries.includes(expected)) {
    console.error(`Package app.asar is missing ${expected}.`);
    process.exit(1);
  }
}
for (const expected of ["/node_modules/tesseract.js/package.json", "/node_modules/tesseract.js-core/package.json"]) {
  if (!entries.includes(expected)) {
    console.error(`Package app.asar is missing OCR runtime dependency ${expected}.`);
    process.exit(1);
  }
}
if (!entries.some((entry) => /^\/dist\/assets\/.*\.wasm$/i.test(entry))) {
  console.error("Package app.asar is missing local STT WASM runtime.");
  process.exit(1);
}
if (!entries.some((entry) => /^\/dist\/assets\/.*transformers.*\.js$/i.test(entry))) {
  console.error("Package app.asar is missing local Transformers STT bundle.");
  process.exit(1);
}

const mainSource = asar.extractFile(appAsar, "electron/main.cjs").toString("utf8");
const preloadSource = asar.extractFile(appAsar, "electron/preload.cjs").toString("utf8");
const indexHtml = asar.extractFile(appAsar, "dist/index.html").toString("utf8");
if (indexHtml.includes('src="/assets/') || indexHtml.includes('href="/assets/')) {
  console.error("Package dist/index.html uses absolute asset paths that break under Electron file:// loading.");
  process.exit(1);
}
for (const needle of ["callPrivacyAllowed: true", "stealth:set-call-privacy-allowed", "stealth:apply-share-safe", "stealth:reset-privacy", "privacy:check", "screen:ocr", "ollama:list-models", "/api/tags", "setContentProtection", "setDisplayMediaRequestHandler", "loopback"]) {
  if (!mainSource.includes(needle)) {
    console.error(`Package electron/main.cjs is missing privacy capability: ${needle}`);
    process.exit(1);
  }
}
for (const needle of ["setCallPrivacyAllowed", "applyShareSafe", "resetPrivacy", "runPrivacyCheck", "recognizeScreenText", "listOllamaModels"]) {
  if (!preloadSource.includes(needle)) {
    console.error(`Package electron/preload.cjs is missing privacy bridge capability: ${needle}`);
    process.exit(1);
  }
}

console.log(`Package verified: ${appDir}`);
