const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const requiredSourceChecks = [
  ["src/core/stealth.ts", "callPrivacyAllowed: true"],
  ["src/core/stealth.ts", "set_call_privacy_allowed"],
  ["src/core/stealth.ts", "apply_share_safe"],
  ["src/core/stealth.ts", "reset_privacy"],
  ["src/core/stealth.ts", "assessPrivacyState"],
  ["src/core/stealth.ts", "overlayVisible: false"],
  ["src/core/stealth.ts", "contentProtectionEnabled: true"],
  ["src/core/stealth.ts", "mousePassthroughEnabled: true"],
  ["electron/main.cjs", "stealth:set-call-privacy-allowed"],
  ["electron/main.cjs", "stealth:apply-share-safe"],
  ["electron/main.cjs", "stealth:reset-privacy"],
  ["electron/main.cjs", "privacy:check"],
  ["electron/main.cjs", "CommandOrControl+Alt+R"],
  ["electron/main.cjs", "setContentProtection(Boolean(stealthState.contentProtectionEnabled))"],
  ["electron/main.cjs", "setIgnoreMouseEvents(Boolean(stealthState.mousePassthroughEnabled)"],
  ["electron/preload.cjs", "setCallPrivacyAllowed"],
  ["electron/preload.cjs", "applyShareSafe"],
  ["electron/preload.cjs", "resetPrivacy"],
  ["electron/preload.cjs", "runPrivacyCheck"],
  ["src/desktop.d.ts", "setCallPrivacyAllowed"],
  ["src/desktop.d.ts", "PrivacyCheckResult"],
  ["src/main.tsx", "Not approved"],
  ["src/main.tsx", "Protected sharing mode"],
  ["src/main.tsx", "runPrivacyCheck"],
  ["src/main.tsx", "resetPrivacy"],
  ["src/main.tsx", "disabled={!stealth.callPrivacyAllowed}"],
  ["tests/privacy/platform-privacy-matrix.json", "google_meet"],
  ["tests/privacy/platform-privacy-matrix.json", "zoom"],
  ["tests/privacy/platform-privacy-matrix.json", "microsoft_teams"],
  ["tests/privacy/platform-privacy-matrix.json", "LeetCode or similar interview/proctoring anti-detection checks"],
  ["tests/privacy/platform-privacy-qa.md", "Everyone in the call knows CallPilot is being tested"],
  ["tests/privacy/platform-privacy-qa.md", "Out Of Scope"],
];

for (const [file, needle] of requiredSourceChecks) {
  if (!read(file).includes(needle)) {
    console.error(`Privacy verification failed: ${file} is missing ${needle}`);
    process.exit(1);
  }
}

const matrix = JSON.parse(read("tests/privacy/platform-privacy-matrix.json"));
if (!matrix.requiredConsent || matrix.platforms.length < 3 || matrix.states.length < 3) {
  console.error("Privacy verification failed: platform matrix must require consent and cover platforms/states.");
  process.exit(1);
}

const pkg = JSON.parse(read("package.json"));
for (const scriptName of ["test:privacy", "verify:privacy"]) {
  if (!pkg.scripts?.[scriptName]) {
    console.error(`Privacy verification failed: package.json is missing script ${scriptName}`);
    process.exit(1);
  }
}

console.log("Privacy controls verified.");
