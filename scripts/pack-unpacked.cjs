const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const stage = path.join(root, ".pack-stage");
const release = path.join(root, "release");

const copyRecursive = (from, to) => {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      copyRecursive(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

const copyRuntimeDependency = (packageName, seen = new Set()) => {
  if (seen.has(packageName)) return;
  seen.add(packageName);

  const packagePath = path.join(root, "node_modules", ...packageName.split("/"));
  const packageJsonPath = path.join(packagePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Missing runtime dependency ${packageName}. Run npm install.`);
  }

  copyRecursive(packagePath, path.join(stage, "node_modules", ...packageName.split("/")));
  const dependencyPackage = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  for (const dependencyName of Object.keys(dependencyPackage.dependencies || {})) {
    copyRuntimeDependency(dependencyName, seen);
  }
};

fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(release, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

copyRecursive(path.join(root, "dist"), path.join(stage, "dist"));
copyRecursive(path.join(root, "electron"), path.join(stage, "electron"));
copyRuntimeDependency("tesseract.js");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const stagePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  private: true,
  main: pkg.main,
  dependencies: {
    "tesseract.js": pkg.dependencies["tesseract.js"],
  },
};
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(stagePkg, null, 2));

const result = spawnSync(
  path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron-packager.cmd" : "electron-packager"),
  [
    stage,
    "CallPilot V0",
    "--out",
    release,
    "--overwrite",
    "--platform",
    process.platform,
    "--arch",
    process.arch,
    "--app-version",
    pkg.version,
    "--electron-version",
    pkg.devDependencies.electron.replace(/^[^0-9]*/, ""),
  ],
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
);

fs.rmSync(stage, { recursive: true, force: true });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("Unpacked desktop app created in release/.");
