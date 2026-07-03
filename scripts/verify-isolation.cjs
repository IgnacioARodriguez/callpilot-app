const fs = require("node:fs");
const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "..", "..");
const originalApp = path.join(workspaceRoot, "original-repo", "natively-cluely-ai-assistant-main");

if (!fs.existsSync(originalApp)) {
  console.log("Original repo not present; isolation check skipped.");
  process.exit(0);
}

const forbiddenPaths = [
  path.join(originalApp, "src", "core"),
  path.join(originalApp, "node_modules"),
  path.join(originalApp, "dist"),
];

const existing = forbiddenPaths.filter((target) => fs.existsSync(target));
if (existing.length > 0) {
  console.error("Isolation check failed. The original repo contains generated/new app artifacts:");
  for (const target of existing) console.error(`- ${target}`);
  process.exit(1);
}

console.log("Isolation verified: original repo has no generated CallPilot app artifacts.");
