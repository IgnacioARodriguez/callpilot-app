const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const appDir = root;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const killTree = (child) => child?.pid && spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
const fetchJson = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
const waitFor = async (fn, timeoutMs, label) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { const value = await fn().catch(() => undefined); if (value) return value; await sleep(250); }
  throw new Error(`Timed out waiting for ${label}`);
};
const connect = (url) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url); let id = 0; const pending = new Map();
  socket.onopen = () => resolve({
    send(method, params = {}) { const requestId = ++id; socket.send(JSON.stringify({ id: requestId, method, params })); return new Promise((ok, fail) => pending.set(requestId, { ok, fail })); },
    close() { socket.close(); },
  });
  socket.onerror = () => reject(new Error("CDP connection failed"));
  socket.onmessage = (event) => { const message = JSON.parse(event.data); if (message.method === "Runtime.exceptionThrown" || message.method === "Runtime.consoleAPICalled" || message.method === "Log.entryAdded") console.error(`[cdp:${message.method}]`, JSON.stringify(message.params)); if (!pending.has(message.id)) return; const item = pending.get(message.id); pending.delete(message.id); message.error ? item.fail(new Error(message.error.message)) : item.ok(message.result); };
});
const evaluate = async (client, expression) => {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 120000 });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime evaluation failed");
  return result.result.value;
};

const policyFor = (answer) => {
  if (/limited experience|haven't|not sure|no direct|no he usado/i.test(answer)) return "clarify_scope";
  if (/actually|correct|corrijo|not quite/i.test(answer)) return "repair_claim";
  if (/trade[- ]?off|latency|failure|scale|monitor|alert|retry|incident|database/i.test(answer)) return "challenge_tradeoff";
  if (/because|for example|first|then|we would|I would|porque|por ejemplo/i.test(answer)) return "deepen_mechanism";
  return "close_topic";
};
const branches = {
  start: { question: "Have you used Prometheus?", candidate: "Yes, but only at a basic level; I understand metrics and dashboards, but I would not claim deep production ownership." },
  clarify_scope: { question: "What would you monitor first and how would you validate that your alerts are useful?", candidate: "I would start with request rate, errors and latency, then validate alerts against a runbook and a realistic incident." },
  deepen_mechanism: { question: "How would the scrape and alert flow work in practice?", candidate: "Prometheus scrapes targets, stores time series, and evaluates alert rules; Alertmanager then routes notifications." },
  challenge_tradeoff: { question: "What trade-off would you consider when defining Prometheus alerts?", candidate: "I would balance sensitivity against noise, use sensible windows, and make sure every alert has an owner and a runbook." },
  repair_claim: { question: "You sounded uncertain there. What part would you say you know confidently?", candidate: "I can explain the architecture and operational principles, but I would be transparent that my direct Prometheus production experience is limited." },
  close_topic: { question: "How would Prometheus fit into an incident response workflow?", candidate: "It would provide service signals and alert context, while the runbook and incident process guide diagnosis and recovery." },
};

async function main() {
  const vite = null;
  const electron = spawn(path.join(appDir, "node_modules", "electron", "dist", "electron.exe"), [".", "--remote-debugging-port=9339"], {
    cwd: appDir,
    windowsHide: true,
    env: { ...process.env },
  });
  electron.stderr?.on("data", (chunk) => process.stderr.write(`[electron] ${chunk}`));
  try {
    const target = await waitFor(async () => (await fetchJson("http://127.0.0.1:9339/json/list")).find((x) => x.type === "page" && x.url.includes("dist/index.html")), 30000, "Electron page");
    console.log(JSON.stringify({ target: { url: target.url, title: target.title } }));
    const client = await connect(target.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await waitFor(async () => evaluate(client, `(() => [...document.querySelectorAll('button')].some(x=>x.innerText.trim().startsWith('Technical Interview')))()`), 15000, "Technical Interview UI").catch(async () => { throw new Error(await evaluate(client, `document.documentElement.outerHTML.slice(0,5000)`)); });
    await evaluate(client, `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim().startsWith('Technical Interview')); if(!b) throw Error(document.body.innerText.slice(0,2000)); b.click(); return true; })()`);
    await sleep(500);
    await evaluate(client, `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('Start interview overlay')); if(!b) throw Error('Start interview overlay button not found'); b.click(); return true; })()`);
    await sleep(1200);
    await evaluate(client, `(() => { window.__adaptiveAnswers=[]; window.callpilotDesktop.onAnswerStatus?.(p => { if(p.status==='completed') window.__adaptiveAnswers.push(p.text||''); }); return true; })()`);
    const trace = [{ type: "test_manifest", payload: { seed: "adaptive-prometheus-p1", mode: "technical_qa", manualAnswers: 0, adaptive: true } }];
    let branch = "start";
    for (let index = 0; index < 30; index += 1) {
      const turn = branches[branch] || branches.close_topic;
      const base = Date.now() + index * 1000;
      const fragmentCount = index < 10 ? 4 : 3;
      const interviewerFragments = [turn.question, "Take your time and be concrete.", "What would you do next?"]; 
      const candidateFragments = [turn.candidate, "I would keep the explanation grounded in what I know.", "I would be transparent about the limits of my experience."];
      if (fragmentCount === 4) { interviewerFragments.push("And connect it to an incident workflow."); candidateFragments.push("That is how I would explain it in an interview."); }
      for (const [speaker, text, fragmentIndex] of interviewerFragments.slice(0, fragmentCount).map((text, fragmentIndex) => ["interviewer", text, fragmentIndex]).concat(candidateFragments.slice(0, fragmentCount).map((text, fragmentIndex) => ["candidate", text, fragmentIndex]))) {
        await evaluate(client, `window.callpilotDesktop.publishTranscriptMessage(${JSON.stringify({ id: `adaptive-${index}-${speaker}-${fragmentIndex}`, speaker, text, timestamp: base + fragmentIndex, simulation: true })})`);
      }
      const before = await evaluate(client, `window.__adaptiveAnswers.length`);
      await evaluate(client, `window.callpilotDesktop.requestAnswer()`);
      const answer = await waitFor(async () => evaluate(client, `window.__adaptiveAnswers.length > ${before} ? window.__adaptiveAnswers[window.__adaptiveAnswers.length-1] : ''`), 120000, `answer ${index + 1}`);
      const nextPolicy = policyFor(answer);
      trace.push({ type: "adaptive_turn", payload: { index: index + 1, branch, question: turn.question, candidate: turn.candidate, answer, nextPolicy, generationCompleted: true } });
      branch = nextPolicy;
      await sleep(600);
    }
    const result = await evaluate(client, `window.callpilotDesktop.endSession()`);
    trace.push({ type: "session_end", payload: result });
    const out = path.join(root, ".cache", `adaptive-technical-interview-${stamp()}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(trace, null, 2));
    console.log(JSON.stringify({ ok: true, out, tracePath: result.tracePath, turns: 30, interviewerTranscripts: 100, candidateTranscripts: 100, manualAnswers: 30 }, null, 2));
    client.close();
  } finally { killTree(electron); killTree(vite); }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
