const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = 5174;
const devUrl = `http://127.0.0.1:${port}`;

const run = (command, args, env = {}) =>
  spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });

const waitForServer = () =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const request = http.get(devUrl, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() - started > 30000) {
          reject(new Error(`Timed out waiting for ${devUrl}`));
          return;
        }
        setTimeout(tick, 400);
      });
    };
    tick();
  });

const vite = run("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"]);

waitForServer()
  .then(() => {
    const electron = run("npx", ["electron", "."], { VITE_DEV_SERVER_URL: devUrl });
    electron.on("exit", (code) => {
      vite.kill();
      process.exit(code ?? 0);
    });
  })
  .catch((error) => {
    console.error(error);
    vite.kill();
    process.exit(1);
  });
