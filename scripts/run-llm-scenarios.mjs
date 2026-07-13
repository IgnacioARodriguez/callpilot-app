import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../src/core/promptBuilder.ts";
import { createGlobalContext } from "../src/core/context.ts";
import { TranscriptBuffer, formatConversationWindow } from "../src/core/transcriptBuffer.ts";
import { classifyScreenText } from "../src/core/screenContext.ts";
import { formatStructuredAnswerPayload, parseStructuredAnswerPayload } from "../src/core/answerPayload.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const electronBin = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");
const debugPort = Number(process.env.CALLPILOT_LLM_SCENARIO_DEBUG_PORT || 9349);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const argValue = (name) => {
  const prefix = `${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : "";
};

const cliProvider = argValue("--provider");
const cliModel = argValue("--model");
const respectSettings = process.argv.includes("--respect-settings");

const waitForHttp = async (url, timeoutMs = 25000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const cdp = async (targetUrl) => {
  const socket = new WebSocket(targetUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
};

const evaluate = async (client, expression) => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result.result.value;
};

const makeTranscript = (turns) => {
  const buffer = new TranscriptBuffer();
  const base = Date.now() - turns.length * 1000;
  turns.forEach((turn, index) => {
    buffer.append(turn.text, "manual", base + index * 1000, turn.speaker);
  });
  return buffer.snapshot();
};

const baseContext = {
  companyName: "Mercado Pago",
  roleTitle: "Backend Engineer",
  preferredLanguage: "spanish",
  userProfile: "Candidato backend/data con experiencia en Python, SQL, APIs y sistemas de pagos.",
  resumeText: [
    "Experiencia creando pipelines de conciliacion de pagos con Python, PostgreSQL y jobs asincronicos.",
    "Trabajo frecuente con SQL para joins, agregaciones, auditoria de transacciones y analisis de inconsistencias.",
    "Experiencia explicando tradeoffs entre consistencia, latencia y mantenibilidad en servicios backend.",
  ].join("\n"),
  starStories: [
    "STAR: En un proyecto de conciliacion, habia diferencias entre proveedores de pago. Cree consultas SQL auditables, agregaciones por estado y reportes reproducibles. Resultado: redujimos el tiempo de investigacion manual.",
    "STAR: En una migracion de API, priorice cambios incrementales, tests de contrato y rollback simple para reducir riesgo operacional.",
  ].join("\n"),
  jobDescription: "Backend role focused on APIs, databases, distributed systems, pragmatic debugging, and clear technical communication.",
  responseConstraints: [
    "Responde en espanol salvo que el entrevistador pregunte en ingles.",
    "Devuelve solo lo que conviene decir ahora, no una explicacion completa.",
    "Maximo 3 micro-secciones para Q&A y 4 para live coding.",
    "Cada micro-seccion debe ser de una o dos lineas.",
    "Usa secciones cortas con negrita, sin parrafos largos ni cierre duplicado.",
    "Si mi respuesta previa fue incorrecta, corrigeme de forma natural y tactica.",
  ],
};

const codingProblem = [
  "LeetCode - Two Sum",
  "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.",
  "You may assume that each input would have exactly one solution, and you may not use the same element twice.",
  "Example 1:",
  "Input: nums = [2,7,11,15], target = 9",
  "Output: [0,1]",
  "Constraints:",
  "2 <= nums.length <= 10^4",
  "-10^9 <= nums[i] <= 10^9",
].join("\n");

const scenarioDefinitions = [
  {
    id: "technical_question_direct",
    label: "Pregunta tecnica directa",
    mode: "technical_qa",
    transcript: [{ speaker: "interviewer", text: "Que es SQL y para que lo usarias en un sistema backend?" }],
    expected: ["sql", "base", "datos"],
    maxChars: 950,
    maxTokens: 220,
    latencyTargetMs: 3000,
  },
  {
    id: "technical_followup_correction",
    label: "Pregunta, mi respuesta y repregunta",
    mode: "technical_qa",
    transcript: [
      { speaker: "interviewer", text: "Que es SQL?" },
      { speaker: "candidate", text: "SQL es un lenguaje de programacion general para crear aplicaciones completas y manejar cualquier tipo de logica." },
      { speaker: "interviewer", text: "Por que lo describirias de esa manera? Hay algo que corregirias?" },
    ],
    expected: ["corre", "base", "relacional"],
    maxChars: 1000,
    maxTokens: 220,
    latencyTargetMs: 3000,
  },
  {
    id: "coding_exercise_solution",
    label: "Coding exercise y solucion",
    mode: "live_coding",
    screenText: codingProblem,
    transcript: [{ speaker: "interviewer", text: "Resuelve este ejercicio y explicame la complejidad." }],
    expected: ["hash", "dic", "o(n)", "indices"],
    maxChars: 1500,
    maxTokens: 360,
    latencyTargetMs: 3500,
  },
  {
    id: "coding_followup_change",
    label: "Repregunta de coding",
    mode: "live_coding",
    screenText: codingProblem,
    transcript: [
      { speaker: "interviewer", text: "Resuelve Two Sum." },
      { speaker: "candidate", text: "Usaria un diccionario para guardar numero a indice y buscar el complemento en una sola pasada." },
      { speaker: "interviewer", text: "Y que cambiarias si puede no existir solucion o si hay numeros duplicados?" },
    ],
    expected: ["duplic", "sin solucion", "empty", "excepcion", "o(n)"],
    maxChars: 1500,
    maxTokens: 340,
    latencyTargetMs: 3500,
  },
];

const buildScenario = (definition) => {
  const transcript = makeTranscript(definition.transcript);
  const screenContext = definition.screenText ? classifyScreenText(definition.screenText) : undefined;
  const context = createGlobalContext({
    ...baseContext,
    activeMode: definition.mode,
    codingLanguagePreference: "Python",
    transcript,
    screenContext,
  });
  const userInput = formatConversationWindow(transcript, "", 10);
  const prompt = buildPrompt(context, userInput);
  return { ...definition, context, prompt };
};

const chooseProvider = (settings, credentialStatus) => {
  if (cliProvider) return { provider: cliProvider, reason: "CLI override" };
  if (!respectSettings && (settings.modelProvider === "ollama" || settings.modelProvider === "mock") && credentialStatus?.hasNativelyKey) {
    return { provider: "natively", reason: "Natively key available; avoiding local/mock provider for real LLM scenario run" };
  }
  return { provider: settings.modelProvider || "mock", reason: "Saved settings" };
};

const defaultModelName = (provider, savedModel) => {
  if (cliModel) return cliModel;
  if (provider === "natively" && (!savedModel || savedModel === "mock-local" || savedModel === "llama3.1" || savedModel.startsWith("llama3.1:"))) {
    return "default";
  }
  if (provider === "nvidia" && (!savedModel || savedModel === "mock-local" || savedModel === "llama3.1" || savedModel.startsWith("llama3.1:"))) {
    return "nvidia-default";
  }
  return savedModel || "";
};

const scoreAnswer = (scenario, result, elapsedMs) => {
  const rawText = String(result?.text || "");
  const structured = parseStructuredAnswerPayload(rawText);
  const text = structured ? formatStructuredAnswerPayload(structured) : rawText;
  const lower = text.toLowerCase();
  const missingExpected = scenario.expected.filter((term) => !lower.includes(term));
  const forbiddenRoleLabels = /\b(interviewer|entrevistador)\s*:/i.test(text);
  const forcedCompanyContext = scenario.mode === "live_coding" && /\b(mercado\s+pago|pagos?|financier[oa]s?|conciliaci[oó]n|pipelines?)\b/i.test(text);
  const hugeParagraph = text.split(/\n{2,}/).some((block) => block.length > 650);
  const codeBlockCount = (text.match(/```/g) || []).length / 2;
  const checks = {
    providerOk: Boolean(result?.ok),
    nonEmpty: text.trim().length > 40,
    conciseEnough: text.length <= scenario.maxChars,
    latencyWithinTarget: !scenario.latencyTargetMs || elapsedMs <= scenario.latencyTargetMs,
    expectedTermsPresent: missingExpected.length <= Math.max(0, scenario.expected.length - 2),
    readableFormat: /\*\*[^*]+:\*\*/.test(text) || /\n[-*]\s+/.test(text) || text.split(/\n+/).length >= 2,
    noConfusingRoleLabels: !forbiddenRoleLabels,
    noForcedCompanyContext: !forcedCompanyContext,
    noHugeParagraphs: !hugeParagraph,
    limitedCodeBlocks: scenario.mode !== "live_coding" || codeBlockCount <= 1,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    latencyMs: elapsedMs,
    chars: text.length,
    renderedText: text,
    checks,
    missingExpected,
    structured: structured?.kind,
  };
};

const runScenario = async ({ client, settings, provider, modelName, scenario }) => {
  const input = {
    provider,
    modelName,
    prompt: scenario.prompt,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    maxTokens: scenario.maxTokens,
  };
  const started = performance.now();
  const result = await evaluate(client, `window.callpilotDesktop.generateAnswer(${JSON.stringify(input)})`);
  const elapsedMs = Math.round(performance.now() - started);
  return {
    id: scenario.id,
    label: scenario.label,
    mode: scenario.mode,
    promptDebug: scenario.prompt.debug,
    metrics: scoreAnswer(scenario, result, elapsedMs),
    response: result,
  };
};

const run = async () => {
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const electron = spawn(electronBin, ["."], {
    cwd: root,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...childEnv,
      CALLPILOT_REMOTE_DEBUG_PORT: String(debugPort),
    },
  });

  let stdout = "";
  let stderr = "";
  electron.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  electron.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let client;
  try {
    const targetsResponse = await waitForHttp(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await targetsResponse.json();
    const page = targets.find((target) => target.type === "page" && !String(target.url).includes("#/overlay")) ?? targets[0];
    if (!page?.webSocketDebuggerUrl) throw new Error("Could not find Electron renderer target");
    client = await cdp(page.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    await evaluate(client, `new Promise((resolve) => {
      const started = performance.now();
      const tick = () => {
        if (window.callpilotDesktop?.generateAnswer && window.callpilotDesktop?.getSettings) resolve(true);
        else if (performance.now() - started > 8000) resolve(false);
        else setTimeout(tick, 100);
      };
      tick();
    })`);

    const settings = await evaluate(client, "window.callpilotDesktop.getSettings()");
    const credentialStatus = await evaluate(client, "window.callpilotDesktop.getCredentialStatus()");
    const providerChoice = chooseProvider(settings, credentialStatus);
    const modelName = defaultModelName(providerChoice.provider, settings.modelName);
    const scenarios = scenarioDefinitions.map(buildScenario);
    const coldProbeScenario = { ...scenarios[0], id: "technical_question_direct_cold_probe", label: "Pregunta tecnica directa cold probe", latencyTargetMs: undefined };
    const coldProbe = await runScenario({
      client,
      settings,
      provider: providerChoice.provider,
      modelName,
      scenario: coldProbeScenario,
    });
    const results = [];

    for (const scenario of scenarios) {
      results.push(await runScenario({
        client,
        settings,
        provider: providerChoice.provider,
        modelName,
        scenario,
      }));
    }

    const report = {
      generatedAt: new Date().toISOString(),
      provider: providerChoice.provider,
      providerReason: providerChoice.reason,
      modelName,
      savedSettings: {
        modelProvider: settings.modelProvider,
        modelName: settings.modelName,
        liveTranscriptionProvider: settings.liveTranscriptionProvider,
      },
      credentialStatus: {
        hasOpenAIKey: Boolean(credentialStatus?.hasOpenAIKey),
        hasNativelyKey: Boolean(credentialStatus?.hasNativelyKey),
        encryptionAvailable: Boolean(credentialStatus?.encryptionAvailable),
      },
      latencyDiagnostics: {
        coldProbe,
        warmTechnicalQuestionMs: results.find((item) => item.id === "technical_question_direct")?.metrics.latencyMs,
        coldToWarmDeltaMs: coldProbe.metrics.latencyMs - (results.find((item) => item.id === "technical_question_direct")?.metrics.latencyMs ?? coldProbe.metrics.latencyMs),
      },
      results,
    };
    const passed = results.every((item) => item.metrics.ok);

    const reportsDir = path.join(root, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(reportsDir, `llm-scenarios-${stamp}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    console.log(JSON.stringify({
      reportPath,
      provider: report.provider,
      providerReason: report.providerReason,
      modelName: report.modelName,
      passed,
      latencyDiagnostics: {
        coldTechnicalQuestionMs: coldProbe.metrics.latencyMs,
        warmTechnicalQuestionMs: report.latencyDiagnostics.warmTechnicalQuestionMs,
        coldToWarmDeltaMs: report.latencyDiagnostics.coldToWarmDeltaMs,
      },
      scenarios: results.map((item) => ({
        id: item.id,
        ok: item.metrics.ok,
        latencyMs: item.metrics.latencyMs,
        chars: item.metrics.chars,
        checks: item.metrics.checks,
        error: item.response?.error,
        preview: String(item.response?.text || "").slice(0, 220),
        renderedPreview: String(item.metrics.renderedText || item.response?.text || "").slice(0, 220),
      })),
    }, null, 2));
    if (!passed) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : "scenario_run_failed",
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-4000),
    }, null, 2));
    process.exitCode = 1;
  } finally {
    client?.close();
    electron.kill();
  }
};

await run();
