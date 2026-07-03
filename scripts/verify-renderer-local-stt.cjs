const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = 9333 + Math.floor(Math.random() * 400);
const electronBin = require("electron");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
};

const connectCdp = (webSocketDebuggerUrl) => new Promise((resolve, reject) => {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];

  socket.onopen = () => {
    resolve({
      events,
      send(method, params = {}) {
        const id = nextId++;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((ok, fail) => pending.set(id, { ok, fail }));
      },
      close() {
        socket.close();
      },
    });
  };
  socket.onerror = () => reject(new Error("CDP websocket connection failed"));
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown" || message.method === "Runtime.consoleAPICalled") {
      events.push(message);
    }
    if (!message.id || !pending.has(message.id)) return;
    const { ok, fail } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) fail(new Error(message.error.message));
    else ok(message.result);
  };
});

const waitForPage = async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json`);
      const page = pages.find((item) => item.type === "page" && /CallPilot|localhost|index\.html/i.test(`${item.title} ${item.url}`));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Electron is still starting.
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for Electron renderer page.");
};

const evaluate = async (client, expression, timeoutMs = 300000) => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Renderer evaluation failed");
  }
  return result.result.value;
};

const main = async () => {
  const env = { ...process.env, CALLPILOT_REMOTE_DEBUG_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBin, ["."], {
    cwd: root,
    env,
    stdio: "ignore",
    shell: false,
  });

  let client;
  try {
    const page = await waitForPage();
    client = await connectCdp(page.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    let result;
    try {
      result = await evaluate(client, `
      (async () => {
        const textOf = (element) => (element?.textContent || "").trim();
        const findButton = (label) => [...document.querySelectorAll("button")]
          .find((button) => textOf(button).includes(label));

        const waitForButton = async (label, timeout = 30000) => {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const button = findButton(label);
            if (button) return button;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          throw new Error(label + " button not found. Location: " + location.href + " HTML: " + document.documentElement.outerHTML.slice(0, 1000));
        };

        (await waitForButton("Config")).click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!document.body.innerText.includes("Computer audio")) {
          throw new Error("Computer audio source option is missing from Config.");
        }
        if (!document.body.innerText.includes("Automatic conversation")) {
          throw new Error("Automatic conversation audio source option is missing from Config.");
        }
        const displayCapture = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const displayCaptureResult = {
          audioTracks: displayCapture.getAudioTracks().length,
          videoTracks: displayCapture.getVideoTracks().length,
        };
        displayCapture.getTracks().forEach((track) => track.stop());
        if (displayCaptureResult.videoTracks < 1) {
          throw new Error("Automatic display capture did not return a video track.");
        }
        if (${JSON.stringify(process.platform)} === "win32" && displayCaptureResult.audioTracks < 1) {
          throw new Error("Automatic display capture did not return Windows loopback audio.");
        }
        const button = await waitForButton("Test Local Whisper");
        button.click();

        const deadline = Date.now() + 240000;
        while (Date.now() < deadline) {
          const body = document.body.innerText;
          if (body.includes("Local Whisper test OK")) return body;
          if (body.includes("Local Whisper test failed")) throw new Error(body.match(/Local Whisper test failed:[^\\n]+/)?.[0] || "Local Whisper test failed");
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error("Timed out waiting for Local Whisper test result");
      })()
      `);
    } catch (error) {
      const eventText = JSON.stringify(client.events.slice(-5), null, 2);
      throw new Error(`${error instanceof Error ? error.message : error}\nRenderer events: ${eventText}`);
    }
    if (!String(result).includes("Local Whisper test OK")) {
      throw new Error("Renderer Local Whisper verification did not report OK.");
    }
    console.log("Renderer Local Whisper verified.");
  } finally {
    client?.close();
    child.kill();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
