const fs = require("node:fs");
const path = require("node:path");

const parseEnvLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const equalsIndex = withoutExport.indexOf("=");
  if (equalsIndex <= 0) return null;
  const key = withoutExport.slice(0, equalsIndex).trim();
  let value = withoutExport.slice(equalsIndex + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
};

const loadDotEnv = (cwd = process.cwd()) => {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) return { loaded: false, path: envPath, keys: [] };
  const keys = [];
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
      keys.push(parsed.key);
    }
  }
  return { loaded: true, path: envPath, keys };
};

module.exports = { loadDotEnv, parseEnvLine };
