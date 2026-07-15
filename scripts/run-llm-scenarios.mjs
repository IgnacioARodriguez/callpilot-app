import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../src/core/promptBuilder.ts";
import { createGlobalContext } from "../src/core/context.ts";
import { TranscriptBuffer, formatConversationWindow } from "../src/core/transcriptBuffer.ts";
import { classifyScreenText } from "../src/core/screenContext.ts";
import { formatStructuredAnswerPayload, parseStructuredAnswerPayload } from "../src/core/answerPayload.ts";
import { assessAnswerGrounding } from "../src/core/answerGrounding.ts";
import { detectQuestionIntent, extractLatestQuestionFocus } from "../src/core/liveConversation.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { loadDotEnv } = require("../electron/env.cjs");
loadDotEnv(root);
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
const cliLimit = Number(argValue("--limit") || "0");
const cliCategory = argValue("--category");
const respectSettings = process.argv.includes("--respect-settings");
const dryRun = process.argv.includes("--dry-run");
const strictLatency = process.argv.includes("--strict-latency");

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

const makeTechnicalScenario = (id, text, expected, options = {}) => ({
  id,
  label: options.label || text,
  category: options.category || "technical",
  mode: "technical_qa",
  transcript: options.transcript || [{ speaker: "interviewer", text }],
  expected,
  forbidden: options.forbidden || [],
  maxChars: options.maxChars || 1000,
  maxTokens: options.maxTokens || 220,
  latencyTargetMs: options.latencyTargetMs || 3500,
  allowUngroundedNoAnswer: Boolean(options.allowUngroundedNoAnswer),
  expectedDispatch: options.expectedDispatch ?? true,
});

const makeBehavioralScenario = (id, text, expected, transcript = undefined) => ({
  id,
  label: text,
  category: "background",
  mode: "behavioral",
  transcript: transcript || [{ speaker: "interviewer", text }],
  expected,
  maxChars: 1150,
  maxTokens: 240,
  latencyTargetMs: 3500,
});

const makeCodingScenario = (id, label, screenText, transcript, expected, options = {}) => ({
  id,
  label,
  category: options.category || "coding",
  mode: "live_coding",
  screenText,
  transcript,
  expected,
  forbidden: options.forbidden || [],
  maxChars: options.maxChars || 1650,
  maxTokens: options.maxTokens || 380,
  latencyTargetMs: options.latencyTargetMs || 4500,
});

const validParenthesesProblem = [
  "LeetCode - Valid Parentheses",
  "Given a string s containing just the characters '(', ')', '{', '}', '[' and ']', determine if the input string is valid.",
  "Open brackets must be closed by the same type of brackets and in the correct order.",
  "Example: Input: s = '()[]{}' Output: true",
  "Example: Input: s = '(]' Output: false",
].join("\n");

const mergeIntervalsProblem = [
  "LeetCode - Merge Intervals",
  "Given an array of intervals where intervals[i] = [starti, endi], merge all overlapping intervals.",
  "Example: Input: [[1,3],[2,6],[8,10],[15,18]] Output: [[1,6],[8,10],[15,18]]",
].join("\n");

const lruCacheProblem = [
  "Design LRU Cache",
  "Implement get and put in O(1). When capacity is exceeded, evict the least recently used key.",
  "Example: put(1,1), put(2,2), get(1), put(3,3), get(2) -> -1",
].join("\n");

const binarySearchProblem = [
  "Binary Search",
  "Given a sorted array of integers nums and a target, return the index if found, otherwise return -1.",
  "Example: nums = [-1,0,3,5,9,12], target = 9 Output: 4",
].join("\n");

const scenarioDefinitions = [
  makeTechnicalScenario("regression_incomplete_usage_question", "Para que sirve", ["esper", "pregunta", "incompleta"], {
    category: "regression",
    forbidden: ["sql", "kafka", "backend", "base de datos"],
    maxChars: 450,
    allowUngroundedNoAnswer: true,
    expectedDispatch: false,
  }),
  makeTechnicalScenario("regression_relational_db_after_gaming_context", "Que es una base de datos relacional?", ["base", "datos", "relacional"], {
    category: "regression",
    transcript: [
      { speaker: "interviewer", text: "Estamos hablando de videojuegos y reservas de GTA." },
      { speaker: "interviewer", text: "Que es una base de datos relacional?" },
    ],
    forbidden: ["sql es", "structured query language", "videojuego", "gta", "mercado"],
  }),
  makeTechnicalScenario("regression_kafka_after_gaming_context", "Para que sirve Kafka?", ["kafka", "event", "mensaj", "stream"], {
    category: "regression",
    transcript: [
      { speaker: "interviewer", text: "La conversacion anterior era casual sobre videojuegos, fisico o digital." },
      { speaker: "interviewer", text: "Para que sirve Kafka? Kafka." },
    ],
    forbidden: ["sql", "videojuego", "gta", "fisico", "digital"],
  }),
  makeTechnicalScenario("regression_kafka_followup", "Y cuando no usarias Kafka?", ["kafka", "no", "simple", "overhead"], {
    category: "regression",
    transcript: [
      { speaker: "interviewer", text: "Para que sirve Kafka?" },
      { speaker: "candidate", text: "Kafka sirve para streaming de eventos y comunicacion asincronica entre servicios." },
      { speaker: "interviewer", text: "Y cuando no usarias Kafka?" },
    ],
    forbidden: ["sql", "base relacional", "videojuego"],
  }),
  makeTechnicalScenario("regression_bare_usage_followup_uses_previous_topic", "bit. Para que sirve", ["list", "orden", "collection"], {
    category: "regression",
    transcript: [
      { speaker: "interviewer", text: "A list, because I think a list is ordered. It's a collection of items, and a dictionary would lose the ordering." },
      { speaker: "interviewer", text: "bit. Para que sirve" },
    ],
    forbidden: ["sql", "kafka", "juego", "gta", "fuera de la entrevista"],
  }),
  {
    id: "technical_question_direct",
    label: "Pregunta tecnica directa",
    category: "technical",
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
    category: "candidate_error",
    mode: "technical_qa",
    transcript: [
      { speaker: "interviewer", text: "Que es SQL?" },
      { speaker: "candidate", text: "SQL es un lenguaje de programacion general para crear aplicaciones completas y manejar cualquier tipo de logica." },
      { speaker: "interviewer", text: "Por que lo describirias de esa manera? Hay algo que corregirias?" },
    ],
    expected: ["sql", "lenguaje", "language", "relacional", "relational"],
    maxChars: 1000,
    maxTokens: 220,
    latencyTargetMs: 3000,
  },
  {
    id: "coding_exercise_solution",
    label: "Coding exercise y solucion",
    category: "coding",
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
    category: "coding_followup",
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
  makeTechnicalScenario("technical_sql_index", "Que es un indice en SQL y cuando puede empeorar una consulta?", ["indice", "lectura", "write", "escrit"]),
  makeTechnicalScenario("technical_acid", "Explicame ACID como si estuvieramos hablando de pagos.", ["atomic", "consisten", "aisl", "durab"]),
  makeTechnicalScenario("technical_transaction_isolation", "Que problemas resuelven los niveles de aislamiento de transacciones?", ["sucia", "fantasma", "aisl", "concurr"]),
  makeTechnicalScenario("technical_rest_idempotency", "Que significa que un endpoint sea idempotente?", ["mismo", "resultado", "retry", "post"]),
  makeTechnicalScenario("technical_rate_limiting", "Puedes explicar rate limiting with token bucket?", ["token", "bucket", "rate", "limite"]),
  makeTechnicalScenario("technical_cache_invalidation", "Como pensarias cache invalidation en un servicio backend?", ["ttl", "invalid", "consisten", "stale"]),
  makeTechnicalScenario("technical_queue_vs_sync", "Cuando usarias una cola en vez de hacer todo sincronicamente?", ["cola", "asincron", "desacopl", "picos"]),
  makeTechnicalScenario("technical_eventual_consistency", "Que es consistencia eventual y que tradeoff tiene?", ["eventual", "consisten", "latencia", "dispon"]),
  makeTechnicalScenario("technical_optimistic_locking", "Explain optimistic locking versus pessimistic locking.", ["optimist", "pesimist", "bloque", "conflict"]),
  makeTechnicalScenario("technical_n_plus_one", "Que es el problema N+1 en una API con base de datos?", ["n+1", "query", "join", "batch"]),
  makeTechnicalScenario("technical_pagination", "Cursor pagination vs offset pagination, que preferis y por que?", ["cursor", "offset", "estab", "performance"]),
  makeTechnicalScenario("technical_sql_nosql", "Cuando elegirias SQL sobre NoSQL?", ["sql", "nosql", "schema", "consisten"]),
  makeTechnicalScenario("technical_deadlock", "Que es un deadlock y como lo mitigarias?", ["deadlock", "orden", "timeout", "retry"]),
  makeTechnicalScenario("technical_api_versioning", "Como versionarias una API publica sin romper clientes?", ["version", "backward", "compat", "deprecat"]),
  makeTechnicalScenario("technical_observability", "Que logs y metricas mirarias si sube la latencia de un endpoint?", ["latencia", "metric", "trace", "log"]),
  makeTechnicalScenario("technical_auth_jwt", "JWT vs session server-side, que tradeoffs ves?", ["jwt", "session", "revoc", "state"]),
  makeTechnicalScenario("technical_testing_contract", "Que son contract tests y cuando te ayudan?", ["contract", "consumer", "provider", "api"]),
  makeTechnicalScenario("technical_migration", "Como harias una migracion de base de datos con cero downtime?", ["expand", "compat", "migracion", "validacion"]),
  makeTechnicalScenario("technical_retries", "Como disenas retries sin duplicar operaciones?", ["reintent", "idempot", "backoff", "duplic"]),
  makeTechnicalScenario("technical_background_sql", "Veo SQL en tu background, que hiciste concretamente con eso?", ["concili", "postgres", "consulta", "auditor"]),
  makeTechnicalScenario("followup_candidate_wrong_sql", "Entonces SQL no es para programar toda la aplicacion?", ["sql", "logica", "datos", "aplicacion"], {
    category: "candidate_error",
    transcript: [
      { speaker: "interviewer", text: "Que es SQL?" },
      { speaker: "candidate", text: "Es como Python, sirve para programar cualquier logica de negocio completa." },
      { speaker: "interviewer", text: "Entonces SQL no es para programar toda la aplicacion?" },
    ],
  }),
  makeTechnicalScenario("followup_candidate_wrong_cache", "Pero si cacheas todo, como evitas datos viejos?", ["ttl", "invalid", "consisten", "source"], {
    category: "candidate_error",
    transcript: [
      { speaker: "interviewer", text: "Como mejorarias latencia?" },
      { speaker: "candidate", text: "Pondria cache para todo y asi siempre seria correcto." },
      { speaker: "interviewer", text: "Pero si cacheas todo, como evitas datos viejos?" },
    ],
  }),
  makeTechnicalScenario("followup_candidate_wrong_queue", "Que pasa si el mensaje se procesa dos veces?", ["idempot", "duplic", "dedup", "retry"], {
    category: "candidate_error",
    transcript: [
      { speaker: "interviewer", text: "Usarias colas?" },
      { speaker: "candidate", text: "Si, una cola garantiza que cada mensaje se procesa exactamente una vez siempre." },
      { speaker: "interviewer", text: "Que pasa si el mensaje se procesa dos veces?" },
    ],
  }),
  makeTechnicalScenario("followup_candidate_partial", "Podrias completar la respuesta con un ejemplo concreto?", ["ejemplo", "sql", "consulta", "concili"], {
    category: "followup",
    transcript: [
      { speaker: "interviewer", text: "Como usas SQL?" },
      { speaker: "candidate", text: "Lo uso para datos." },
      { speaker: "interviewer", text: "Podrias completar la respuesta con un ejemplo concreto?" },
    ],
  }),
  makeTechnicalScenario("followup_why_choice", "Por que elegiste esa solucion y no otra?", ["tradeoff", "consisten", "latencia", "riesgo"], {
    category: "followup",
    transcript: [
      { speaker: "interviewer", text: "Como resolviste conciliacion de pagos?" },
      { speaker: "candidate", text: "Use consultas SQL auditables y jobs asincronicos." },
      { speaker: "interviewer", text: "Por que elegiste esa solucion y no otra?" },
    ],
  }),
  makeBehavioralScenario("background_incident", "Tell me about a time you handled a production incident.", ["incident", "produccion", "resultado", "redu"]),
  makeBehavioralScenario("background_conflict", "Contame de una vez que tuviste desacuerdo tecnico con alguien.", ["debat", "incremental", "riesgo", "rollback"]),
  makeBehavioralScenario("background_failure", "Tell me about a time you made a technical mistake.", ["error", "aprendi", "accion", "resultado"]),
  makeBehavioralScenario("background_pressure", "Como priorizas cuando hay una fecha limite y deuda tecnica?", ["prior", "riesgo", "impacto", "tradeoff"]),
  makeBehavioralScenario("background_payments_project", "Que proyecto de tu CV representa mejor tu experiencia backend?", ["concili", "pagos", "python", "postgres"]),
  makeBehavioralScenario("background_star_sql", "Dame un ejemplo STAR usando SQL.", ["concili", "sql", "audit", "redu"]),
  makeBehavioralScenario("background_ownership", "Describe a time you took ownership beyond your assigned task.", ["proactiv", "automatic", "audit", "reduccion"]),
  makeBehavioralScenario("background_learning", "Como aprendes una tecnologia nueva rapido?", ["aprend", "pract", "protot", "aplic"]),
  makeTechnicalScenario("no_answer_chitchat", "Bueno, dame un segundo que estoy abriendo el repo.", ["esperar", "contexto", "listo"], {
    category: "no_answer",
    forbidden: ["sql", "hash", "codigo", "acid"],
    maxChars: 450,
    expectedDispatch: false,
  }),
  makeTechnicalScenario("no_answer_noise", "Si, si, perfecto, ahora vemos.", ["no", "neces", "esper"], {
    category: "no_answer",
    forbidden: ["sql", "base de datos", "python"],
    maxChars: 450,
    expectedDispatch: false,
  }),
  makeTechnicalScenario("no_answer_personal_comment", "A mi tambien me gustan los juegos, despues seguimos.", ["breve", "cordial", "retomar"], {
    category: "no_answer",
    forbidden: ["sql", "arquitectura", "codigo"],
    maxChars: 500,
    expectedDispatch: false,
  }),
  makeTechnicalScenario("no_answer_audio_fragment", "eh entonces por ahi no se si", ["fragment", "esper", "context"], {
    category: "no_answer",
    forbidden: ["sql", "respuesta directa", "def "],
    maxChars: 500,
    expectedDispatch: false,
  }),
  makeTechnicalScenario("no_answer_gaming_physical_copy", "A mi me gustaria tenerlo fisico, claro. Lo quieres tener fisico?", ["no", "neces", "casual"], {
    category: "no_answer",
    forbidden: ["sql", "base de datos", "backend", "relacional"],
    maxChars: 500,
    expectedDispatch: false,
  }),
  makeTechnicalScenario("no_answer_gaming_reservations", "Cuantas reservas crees que puede tener GTA en el primer mes?", ["no", "neces", "casual"], {
    category: "no_answer",
    forbidden: ["sql", "postgres", "api", "codigo"],
    maxChars: 500,
    expectedDispatch: false,
  }),
  makeCodingScenario("coding_valid_parentheses", "Valid Parentheses solution", validParenthesesProblem, [
    { speaker: "interviewer", text: "Resuelve Valid Parentheses y explicame el approach." },
  ], ["stack", "pila", "o(n)", "parent"]),
  makeCodingScenario("coding_merge_intervals", "Merge Intervals solution", mergeIntervalsProblem, [
    { speaker: "interviewer", text: "Como resolverias Merge Intervals?" },
  ], ["sort", "orden", "merge", "o(n)"]),
  { category: "coding", id: "coding_lru_cache", label: "LRU Cache design", mode: "live_coding", screenText: lruCacheProblem, transcript: [{ speaker: "interviewer", text: "Implementa LRU Cache con get y put O(1)." }], expected: ["hash", "lista", "o(1)", "evict"], maxChars: 1800, maxTokens: 420, latencyTargetMs: 5000 },
  makeCodingScenario("coding_binary_search", "Binary Search solution", binarySearchProblem, [
    { speaker: "interviewer", text: "Implementa binary search y explicame edge cases." },
  ], ["left", "right", "mid", "o(log"]),
  makeCodingScenario("coding_two_sum_no_solution", "Two Sum no solution follow-up", codingProblem, [
    { speaker: "interviewer", text: "Resuelve Two Sum." },
    { speaker: "candidate", text: "Uso hashmap y retorno cuando encuentro complemento." },
    { speaker: "interviewer", text: "Ahora cambia el codigo para devolver [] si no existe solucion." },
  ], ["return", "[]", "sin solucion", "hash"], { category: "coding_followup" }),
  makeCodingScenario("coding_two_sum_duplicates", "Two Sum duplicates follow-up", codingProblem, [
    { speaker: "interviewer", text: "Resuelve Two Sum." },
    { speaker: "candidate", text: "Uso un diccionario numero a indice." },
    { speaker: "interviewer", text: "Y si nums tiene [3,3] y target 6?" },
  ], ["duplic", "antes", "insert", "complement"], { category: "coding_followup" }),
  makeCodingScenario("coding_valid_parentheses_followup", "Valid Parentheses invalid chars", validParenthesesProblem, [
    { speaker: "interviewer", text: "Resuelve Valid Parentheses." },
    { speaker: "candidate", text: "Uso una pila para brackets." },
    { speaker: "interviewer", text: "Que harias si aparecen caracteres que no son brackets?" },
  ], ["ignorar", "validar", "caracter", "pila"], { category: "coding_followup" }),
  makeCodingScenario("coding_merge_intervals_followup", "Merge touching intervals follow-up", mergeIntervalsProblem, [
    { speaker: "interviewer", text: "Resuelve Merge Intervals." },
    { speaker: "candidate", text: "Ordeno por inicio y mergeo overlaps." },
    { speaker: "interviewer", text: "Si [1,4] y [4,5] cuentan como overlap, cambia algo?" },
  ], ["<=", "overlap", "merge", "orden"], { category: "coding_followup" }),
  makeCodingScenario("coding_lru_capacity_one", "LRU capacity one follow-up", lruCacheProblem, [
    { speaker: "interviewer", text: "Disena LRU Cache." },
    { speaker: "candidate", text: "Uso hashmap y lista doblemente enlazada." },
    { speaker: "interviewer", text: "Que edge case hay con capacity 1?" },
  ], ["capacity", "evict", "o(1)", "lista"], { category: "coding_followup" }),
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
  const conversationWindow = formatConversationWindow(transcript, "", 10);
  const focusedQuestion = extractLatestQuestionFocus(conversationWindow);
  const userInput = focusedQuestion && focusedQuestion !== conversationWindow ? `interviewer: ${focusedQuestion}` : conversationWindow;
  const prompt = buildPrompt(context, userInput);
  return { ...definition, context, prompt, userInput };
};

const selectScenarioDefinitions = () => scenarioDefinitions
  .filter((scenario) => !cliCategory || scenario.category === cliCategory)
  .slice(0, cliLimit > 0 ? cliLimit : undefined);

const summarizeCorpus = (selectedDefinitions) => ({
  totalAvailable: scenarioDefinitions.length,
  selected: selectedDefinitions.length,
  category: cliCategory || "all",
  limit: cliLimit || null,
  categories: scenarioDefinitions.reduce((acc, item) => {
    const category = item.category || "uncategorized";
    acc[category] = (acc[category] || 0) + 1;
    return acc;
  }, {}),
  selectedIds: selectedDefinitions.map((scenario) => scenario.id),
});

const chooseProvider = (settings, credentialStatus) => {
  if (cliProvider) return { provider: cliProvider, reason: "CLI override" };
  if (!respectSettings && (settings.modelProvider === "ollama" || settings.modelProvider === "mock") && credentialStatus?.hasNativelyKey) {
    return { provider: "natively", reason: "Natively key available; avoiding local/mock provider for real LLM scenario run" };
  }
  return { provider: settings.modelProvider || "mock", reason: "Saved settings" };
};

const defaultModelName = (provider, savedModel) => {
  if (cliModel) return cliModel;
  if (provider === "nvidia" && process.env.CALLPILOT_NVIDIA_MODEL) return process.env.CALLPILOT_NVIDIA_MODEL;
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
  const includesTerm = (value, term) => {
    const cleanTerm = String(term).toLowerCase();
    if (/^[a-z0-9+#.-]{1,4}$/i.test(cleanTerm)) {
      const escaped = cleanTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(value);
    }
    return value.includes(cleanTerm);
  };
  const missingExpected = scenario.expected.filter((term) => !lower.includes(term));
  const forbiddenPresent = (scenario.forbidden || []).filter((term) => includesTerm(lower, term));
  const expectsNoAnswer = scenario.category === "no_answer";
  const structuredNoAnswer = structured?.kind === "interview" && structured.payload.intent === "no_answer";
  const structuredNoAnswerOrClarification = structured?.kind === "interview" && ["no_answer", "clarification"].includes(structured.payload.intent);
  const forbiddenRoleLabels = /\b(interviewer|entrevistador)\s*:/i.test(text);
  const forcedCompanyContext = scenario.mode === "live_coding" && /\b(mercado\s+pago|pagos?|financier[oa]s?|conciliaci[oó]n|pipelines?)\b/i.test(text);
  const hugeParagraph = text.split(/\n{2,}/).some((block) => block.length > 650);
  const codeBlockCount = (text.match(/```/g) || []).length / 2;
  const artifactScanText = text.replace(/\b(OrderedDict|JavaScript|TypeScript|PostgreSQL|OpenAI|NoSQL)\b/g, "");
  const garbledArtifact = /(?:\.raise\b|[a-zÃ¡Ã©Ã­Ã³ÃºÃ±]{4,}[A-Z][A-Za-z]{3,})/u.test(artifactScanText);
  const grounding = structured ? assessAnswerGrounding(scenario.context, scenario.userInput, structured) : null;
  const questionDetection = detectQuestionIntent(scenario.userInput, scenario.context.preferredLanguage);
  const clearQuestionGotNoAnswer = questionDetection.shouldDispatch
    && structured?.kind === "interview"
    && structured.payload.intent === "no_answer"
    && !scenario.allowUngroundedNoAnswer
    && scenario.category !== "no_answer";
  const checks = {
    providerOk: Boolean(result?.ok),
    nonEmpty: expectsNoAnswer ? text.trim().length > 15 : text.trim().length > 40,
    conciseEnough: text.length <= scenario.maxChars,
    latencyWithinTarget: !scenario.latencyTargetMs || elapsedMs <= scenario.latencyTargetMs,
    expectedTermsPresent: expectsNoAnswer
      ? true
      : missingExpected.length <= Math.max(0, scenario.expected.length - 1),
    readableFormat: /\*\*[^*]+:\*\*/.test(text) || /\n[-*]\s+/.test(text) || text.split(/\n+/).length >= 2,
    noConfusingRoleLabels: !forbiddenRoleLabels,
    noForcedCompanyContext: !forcedCompanyContext,
    noHugeParagraphs: !hugeParagraph,
    noGarbledArtifacts: !garbledArtifact,
    limitedCodeBlocks: scenario.mode !== "live_coding" || codeBlockCount <= 1,
    forbiddenTermsAbsent: forbiddenPresent.length === 0,
    noAnswerDoesNotOverExplain: !expectsNoAnswer || structuredNoAnswer || text.length <= scenario.maxChars,
    noAnswerIntentAppropriate: !expectsNoAnswer || structuredNoAnswerOrClarification,
    groundedWhenStructured: scenario.mode === "live_coding" || !grounding || grounding.ok,
    clearQuestionAnswered: !clearQuestionGotNoAnswer,
  };
  const qualityChecks = Object.fromEntries(
    Object.entries(checks).filter(([key]) => key !== "latencyWithinTarget"),
  );
  const qualityOk = Object.values(qualityChecks).every(Boolean);
  return {
    ok: qualityOk,
    qualityOk,
    latencyOk: checks.latencyWithinTarget,
    latencyMs: elapsedMs,
    chars: text.length,
    renderedText: text,
    checks,
    qualityChecks,
    missingExpected,
    forbiddenPresent,
    structured: structured?.kind,
    grounding,
    questionDetection,
  };
};

const runScenario = async ({ client, settings, provider, modelName, scenario }) => {
  const preflightDetection = detectQuestionIntent(scenario.userInput, scenario.context.preferredLanguage);
  if (scenario.expectedDispatch === false) {
    const ok = !preflightDetection.shouldDispatch;
    return {
      id: scenario.id,
      label: scenario.label,
      mode: scenario.mode,
      promptDebug: scenario.prompt.debug,
      metrics: {
        ok,
        latencyMs: 0,
        chars: 0,
        renderedText: "",
        checks: {
          noDispatchExpected: ok,
        },
        missingExpected: [],
        forbiddenPresent: [],
        structured: null,
        grounding: null,
        questionDetection: preflightDetection,
      },
      response: { ok, text: "", provider, modelName, requestId: `${scenario.id}-preflight`, error: ok ? undefined : "unexpected_dispatch" },
    };
  }
  const input = {
    provider,
    modelName,
    prompt: scenario.prompt,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    maxTokens: scenario.maxTokens,
    structuredOutput: true,
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
  const selectedForDryRun = selectScenarioDefinitions();
  if (dryRun) {
    console.log(JSON.stringify(summarizeCorpus(selectedForDryRun), null, 2));
    return;
  }

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
    const selectedDefinitions = selectScenarioDefinitions();
    if (selectedDefinitions.length === 0) {
      throw new Error(`No scenarios selected for category=${cliCategory || "all"}`);
    }
    const scenarios = selectedDefinitions.map(buildScenario);
    const firstDispatchScenario = scenarios.find((scenario) => scenario.expectedDispatch !== false) ?? scenarios[0];
    const coldProbeScenario = { ...firstDispatchScenario, id: `${firstDispatchScenario.id}_cold_probe`, label: `${firstDispatchScenario.label} cold probe`, latencyTargetMs: undefined };
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
      strictLatency,
      latencyDiagnostics: {
        coldProbe,
        warmTechnicalQuestionMs: results.find((item) => item.id === "technical_question_direct")?.metrics.latencyMs,
        coldToWarmDeltaMs: coldProbe.metrics.latencyMs - (results.find((item) => item.id === "technical_question_direct")?.metrics.latencyMs ?? coldProbe.metrics.latencyMs),
      },
      corpus: summarizeCorpus(selectedDefinitions),
      results,
    };
    const qualityPassed = results.every((item) => item.metrics.qualityOk ?? item.metrics.ok);
    const latencyPassed = results.every((item) => item.metrics.latencyOk !== false);
    report.qualityPassed = qualityPassed;
    report.latencyPassed = latencyPassed;
    const passed = qualityPassed && (!strictLatency || latencyPassed);

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
      qualityPassed,
      latencyPassed,
      strictLatency,
      latencyDiagnostics: {
        coldTechnicalQuestionMs: coldProbe.metrics.latencyMs,
        warmTechnicalQuestionMs: report.latencyDiagnostics.warmTechnicalQuestionMs,
        coldToWarmDeltaMs: report.latencyDiagnostics.coldToWarmDeltaMs,
      },
      corpus: report.corpus,
      scenarios: results.map((item) => ({
        id: item.id,
        ok: item.metrics.ok,
        qualityOk: item.metrics.qualityOk ?? item.metrics.ok,
        latencyOk: item.metrics.latencyOk,
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
