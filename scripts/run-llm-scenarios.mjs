import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../src/core/promptBuilder.ts";
import { createGlobalContext } from "../src/core/context.ts";
import { TranscriptBuffer, formatConversationWindow } from "../src/core/transcriptBuffer.ts";
import { classifyScreenText } from "../src/core/screenContext.ts";
import { formatAnswerForDisplay, parseStructuredAnswerPayload } from "../src/core/answerPayload.ts";
import { assessAnswerGrounding } from "../src/core/answerGrounding.ts";
import { detectQuestionIntent, extractLatestQuestionFocus } from "../src/core/liveConversation.ts";
import { buildLiveCodingFollowUpPrompt } from "../src/core/liveCodingInteraction.ts";
import { buildLiveCodingCompletenessRetryPrompt, shouldRetryLiveCodingCompleteness } from "../src/core/answerRepair.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { loadDotEnv } = require("../electron/env.cjs");
const {
  createEvaluationRecord,
  summarizeEvaluationRecords,
} = require("../tests/eval/evaluationContract.cjs");
const { scoreExecutableRecord } = require("../tests/eval/scorers/executableScorers.cjs");
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
const cliScenario = argValue("--scenario");
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
  maxTokens: options.maxTokens || 360,
  latencyTargetMs: options.latencyTargetMs || 3500,
  allowUngroundedNoAnswer: Boolean(options.allowUngroundedNoAnswer),
  expectedDispatch: options.expectedDispatch ?? true,
  mustUseContext: options.mustUseContext || [],
  mustIgnoreContext: options.mustIgnoreContext || [],
  expectedLanguage: options.expectedLanguage,
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
  expectedResponseType: options.expectedResponseType,
  expectedPatch: options.expectedPatch,
  requireInlineComments: options.requireInlineComments,
  requireStructuredCoding: options.requireStructuredCoding,
  previousCodingPayload: options.previousCodingPayload,
  followUpChange: options.followUpChange,
  expectedFunctionName: options.expectedFunctionName,
  executableAssertions: options.executableAssertions || [],
  mustUseContext: options.mustUseContext || [],
  mustIgnoreContext: options.mustIgnoreContext || [],
});

const makeCodingPayload = ({ title, summary, language = "Python", signature = null, code, approach = [], edgeCases = [] }) => ({
  version: "1",
  answerNeeded: true,
  responseType: "initial_solution",
  problem: {
    title,
    summary,
    language,
    functionSignature: signature,
    constraints: [],
  },
  solution: {
    approachSteps: approach,
    code,
    complexity: { time: "", space: "", rationale: "" },
    edgeCases,
    invariants: [],
  },
  narration: {
    spokenAnswer: "",
    currentStep: "",
  },
  tests: [],
  patch: { kind: "none", code: null },
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
  makeTechnicalScenario("manual_long_monologue_technical_isolated", [
    "Antes de entrar en detalle te cuento un poco como trabajamos aca.",
    "El equipo tiene varios servicios, algunos en Java y otros en Python.",
    "La mayoria de nuestros problemas aparecen cuando una integracion externa tarda mas de lo esperado.",
    "A veces hay ruido operacional, dashboards, alertas y cosas que no necesariamente estan conectadas.",
    "Ahora, dejando eso aparte, quiero ir a una pregunta concreta.",
    "Que significa que un endpoint sea idempotente y por que importa para retries?",
  ].join(" "), ["idempot", "retry", "duplic", "mismo"], {
    category: "manual_interview",
    forbidden: ["java", "dashboard", "alertas"],
    maxChars: 760,
    maxTokens: 170,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_long_monologue_contextual_followup", [
    "Te doy contexto: en nuestro sistema tenemos pagos que entran por un proveedor externo.",
    "A veces el proveedor envia dos notificaciones por la misma operacion.",
    "Tambien puede pasar que nuestro worker se caiga despues de escribir una parte del estado.",
    "No quiero que me describas todo el sistema, quiero una respuesta concreta.",
    "Como diseniarias retries sin duplicar operaciones en ese flujo?",
  ].join(" "), ["idempot", "dedup", "operacion", "retry"], {
    category: "manual_interview",
    forbidden: ["todo el sistema", "historia completa"],
    maxChars: 1050,
    maxTokens: 240,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_long_monologue_background_required", [
    "Estuve mirando tu perfil y veo varias cosas de backend.",
    "Me interesa entender no solo definiciones teoricas sino como lo aplicaste.",
    "Tambien vi que trabajaste con pagos y conciliacion, aunque quiero que lo conectes a una decision concreta.",
    "Contame un ejemplo de tu experiencia donde hayas usado SQL para resolver un problema real.",
  ].join(" "), ["concili", "sql", "postgres", "auditor"], {
    category: "manual_interview",
    maxChars: 1150,
    maxTokens: 260,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_long_monologue_stale_context_switch", [
    "Venimos hablando de videojuegos, reservas digitales y cosas bastante casuales.",
    "Eso era solo charla mientras esperamos al resto del equipo.",
    "Ahora vuelvo a la entrevista tecnica y cambio totalmente de tema.",
    "Que es consistencia eventual y que tradeoff tiene?",
  ].join(" "), ["eventual", "consisten", "latencia", "dispon"], {
    category: "manual_interview",
    forbidden: ["videojuego", "reservas", "digitales", "gta"],
    maxChars: 950,
    maxTokens: 220,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_long_monologue_candidate_correction", [
    "Te hago una repregunta porque antes dijiste algo que quiero revisar.",
    "Mencionaste que una cola garantiza exactamente una vez siempre.",
    "En la practica nosotros vemos duplicados, retries y consumidores que pueden fallar.",
    "Que corregirias de esa afirmacion y como lo explicarias mejor?",
  ].join(" "), ["cola", "exactamente", "idempot", "duplic"], {
    category: "manual_interview",
    transcript: [
      { speaker: "interviewer", text: "Usarias colas para procesar pagos?" },
      { speaker: "candidate", text: "Si, una cola garantiza que cada mensaje se procesa exactamente una vez siempre." },
      { speaker: "interviewer", text: "Te hago una repregunta porque antes dijiste algo que quiero revisar. Mencionaste que una cola garantiza exactamente una vez siempre. En la practica nosotros vemos duplicados, retries y consumidores que pueden fallar. Que corregirias de esa afirmacion y como lo explicarias mejor?" },
    ],
    maxChars: 1050,
    maxTokens: 240,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_hard_dirty_stt_retries", [
    "ok so eh we talked about the team and alerts and some dashboards",
    "the provider sometimes sends the same payment event twice and maybe the worker crashes after writing state",
    "the concrete thing I want to ask is how would you design retries without charging the user twice",
  ].join(" "), ["reint", "estado", "carg", "unico"], {
    category: "manual_interview_hard",
    forbidden: ["dashboard", "alerts", "equipo"],
    maxChars: 760,
    maxTokens: 170,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_hard_multiple_partial_questions_final_focus", [
    "What is caching and what is Redis, we can talk about that but not yet.",
    "Actually ignore that for now because I want to focus on a production issue.",
    "How would you debug a latency spike in an API?",
  ].join(" "), ["latency", "metric", "trace", "log"], {
    category: "manual_interview_hard",
    forbidden: ["redis", "cache invalidation"],
    maxChars: 760,
    maxTokens: 170,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_hard_contextual_that_reference", [
    "Imagine service A calls service B synchronously during checkout.",
    "Service B also calls a third party and sometimes that dependency is slow.",
    "If we keep chaining those calls, why is that dangerous?",
  ].join(" "), ["depend", "timeout", "fallo", "cuello"], {
    category: "manual_interview_hard",
    maxChars: 760,
    maxTokens: 170,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_hard_context_switch_to_isolated_acid", [
    "We were discussing microservices, Kafka, and asynchronous events.",
    "That context is not important for the next question.",
    "What is ACID in databases?",
  ].join(" "), ["atomic", "consisten", "isol", "durab"], {
    category: "manual_interview_hard",
    forbidden: ["kafka", "microservice", "event"],
    maxChars: 720,
    maxTokens: 160,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_hard_background_implicit_experience", [
    "I saw in your background that you worked with payments and async jobs.",
    "I do not want a textbook definition.",
    "Where did you apply that kind of approach in a real project?",
  ].join(" "), ["pagos", "concili", "asincron", "sql"], {
    category: "manual_interview_hard",
    maxChars: 780,
    maxTokens: 180,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_hard_bilingual_stt_race_condition", [
    "so vamos con algo de backend real",
    "imagine two workers agarran el mismo payment casi al mismo tiempo",
    "como manejarias that race condition so the operation is processed once",
  ].join(" "), ["idempot", "lock", "concurr", "proces"], {
    category: "manual_interview_hard",
    maxChars: 760,
    maxTokens: 170,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_hard_chitchat_then_n_plus_one", [
    "By the way we were joking about games and weekend plans while everyone joined.",
    "That was just small talk.",
    "Explain the N+1 query problem in an API and how you would fix it.",
  ].join(" "), ["n+1", "consulta", "join", "batch"], {
    category: "manual_interview_hard",
    forbidden: ["games", "weekend", "small talk", "juegos", "fin de semana", "charla anterior"],
    maxChars: 760,
    maxTokens: 170,
    latencyTargetMs: 4500,
  }),
  makeTechnicalScenario("manual_hard_implicit_no_question_mark", [
    "there are many ways to approach observability and we have logs metrics traces",
    "walk me through how you would debug an API latency spike in production",
  ].join(" "), ["latencia", "metrics", "traces", "logs"], {
    category: "manual_interview_hard",
    maxChars: 760,
    maxTokens: 170,
    latencyTargetMs: 4500,
  }),
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
  makeTechnicalScenario("adversarial_es_cache_invalidation_write_consistency", "Como mantendrias consistente Redis con Postgres si una fila cambia justo despues de poblar la cache?", ["redis", "postgres", "invalid", "ttl"], {
    category: "adversarial_spanish",
    transcript: [
      { speaker: "interviewer", text: "Antes dijiste que el servicio usa Redis como cache read-through delante de Postgres." },
      { speaker: "interviewer", text: "Dato aparte: en otro equipo usaban Memcached para sesiones, pero no aplica aca." },
      { speaker: "candidate", text: "Yo pondria TTL en las keys y listo." },
      { speaker: "interviewer", text: "Como mantendrias consistente Redis con Postgres si una fila cambia justo despues de poblar la cache?" },
    ],
    forbidden: ["memcached", "auto-invalida", "60 segundos"],
    mustUseContext: ["Redis read-through delante de Postgres", "TTL como backstop, no mecanismo principal"],
    mustIgnoreContext: ["Memcached"],
    expectedLanguage: "spanish",
    maxChars: 780,
  }),
  makeTechnicalScenario("adversarial_es_indexes_write_heavy", "Cual es el tradeoff real de agregar indices en esta tabla?", ["indice", "write", "40", "selectiv"], {
    category: "adversarial_spanish",
    transcript: [
      { speaker: "interviewer", text: "La tabla tiene 40 millones de filas y un job de ingesta write-heavy cada 5 minutos." },
      { speaker: "interviewer", text: "Hay otra tabla de reporting con 200 filas, pero no es esta." },
      { speaker: "candidate", text: "Indexaria todas las columnas, mas indices siempre es mejor." },
      { speaker: "interviewer", text: "Cual es el tradeoff real de agregar indices en esta tabla?" },
    ],
    forbidden: ["200 filas", "gratis", "siempre es mejor"],
    mustUseContext: ["40 millones de filas", "write-heavy cada 5 minutos"],
    mustIgnoreContext: ["tabla de reporting"],
    expectedLanguage: "spanish",
    maxChars: 820,
  }),
  makeTechnicalScenario("adversarial_es_python_memory_leak", "Como investigarias este leak en el worker?", ["tracemalloc", "snapshot", "objeto", "cache"], {
    category: "adversarial_spanish",
    transcript: [
      { speaker: "interviewer", text: "Tenemos un worker Python de larga duracion. El RSS crece durante 48 horas hasta OOM." },
      { speaker: "interviewer", text: "Antes hablamos de bundle size frontend, pero es otro tema." },
      { speaker: "candidate", text: "Seguro es un bug del garbage collector de Python." },
      { speaker: "interviewer", text: "Como investigarias este leak en el worker?" },
    ],
    forbidden: ["frontend", "bundle", "bug del gc", "culpa del interprete"],
    mustUseContext: ["worker Python de larga duracion", "RSS crece durante 48 horas"],
    mustIgnoreContext: ["bundle size frontend"],
    expectedLanguage: "spanish",
    maxChars: 900,
  }),
  makeTechnicalScenario("adversarial_es_kafka_lag_reference", "Que pasa con ese enfoque si un consumer queda varias horas atrasado?", ["kafka", "offset", "retention", "lag"], {
    category: "adversarial_spanish",
    transcript: [
      { speaker: "candidate", text: "Para event sourcing usaria Kafka porque necesitamos replay y varios consumer groups independientes." },
      { speaker: "interviewer", text: "Personalmente me gusta mas la UI de RabbitMQ, pero eso es aparte." },
      { speaker: "interviewer", text: "Que pasa con ese enfoque si un consumer queda varias horas atrasado?" },
    ],
    forbidden: ["rabbitmq", "ui", "retencion infinita"],
    mustUseContext: ["Kafka para replay", "consumer groups independientes"],
    mustIgnoreContext: ["RabbitMQ UI"],
    expectedLanguage: "spanish",
    maxChars: 820,
  }),
  makeCodingScenario("coding_contract_two_sum_follow_up_duplicates", "Two Sum structured follow-up with patch", codingProblem, [
    { speaker: "interviewer", text: "Resuelve Two Sum con hashmap." },
    { speaker: "candidate", text: "Primero busco complemento y despues guardo el numero actual." },
    { speaker: "interviewer", text: "Ahora adapta la solucion para dejar claro que [3,3] con target 6 funciona." },
  ], ["def", "complement", "duplic", "o(n)"], {
    category: "coding_contract",
    expectedResponseType: "follow_up_change",
    expectedPatch: true,
    requireInlineComments: true,
    requireStructuredCoding: true,
    followUpChange: "Asegura y explica que el caso [3,3] con target 6 funciona sin reutilizar el mismo indice.",
    previousCodingPayload: makeCodingPayload({
      title: "Two Sum",
      summary: "Return indices of two numbers that add to target.",
      signature: "def two_sum(nums, target)",
      approach: ["Use a hashmap from value to index."],
      code: "def two_sum(nums, target):\n    # Store values seen so far so each lookup is O(1).\n    seen = {}\n    for i, num in enumerate(nums):\n        # Check before inserting to avoid reusing the same index.\n        complement = target - num\n        if complement in seen:\n            return [seen[complement], i]\n        seen[num] = i\n    return []",
    }),
    forbidden: ["memcached", "billing", "empresa"],
    executableAssertions: [
      { python: "__callpilot_assert_equal(two_sum([3, 3], 6), [0, 1])" },
      { python: "__callpilot_assert_equal(two_sum([2, 7, 11, 15], 9), [0, 1])" },
      { python: "__callpilot_assert_equal(two_sum([1, 2, 3], 10), [])" },
    ],
    maxTokens: 520,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("coderpad_baseline_longest_substring", "CoderPad baseline executable solution", [
    "CoderPad Interview",
    "Python 3",
    "Write a function length_of_longest_substring(s) that returns the length of the longest substring without repeating characters.",
    "Example: s = 'abcabcbb' -> 3",
    "Example: s = 'bbbbb' -> 1",
    "Example: s = '' -> 0",
    "Constraints: 0 <= len(s) <= 5 * 10^4",
  ].join("\n"), [
    { speaker: "interviewer", text: "This is in CoderPad. Implement length_of_longest_substring and explain the sliding window." },
  ], ["sliding", "window", "seen", "o(n)"], {
    category: "coderpad_baseline",
    expectedResponseType: "initial_solution",
    expectedPatch: false,
    requireInlineComments: true,
    requireStructuredCoding: true,
    executableAssertions: [
      { python: "__callpilot_assert_equal(length_of_longest_substring('abcabcbb'), 3)" },
      { python: "__callpilot_assert_equal(length_of_longest_substring('bbbbb'), 1)" },
      { python: "__callpilot_assert_equal(length_of_longest_substring('pwwkew'), 3)" },
      { python: "__callpilot_assert_equal(length_of_longest_substring(''), 0)" },
    ],
    forbidden: ["leetcode premium", "mercado", "billing"],
    maxTokens: 560,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("coderpad_multiturn_followup_return_substring", "CoderPad multi-turn follow-up keeps previous code", [
    "CoderPad Interview",
    "Python 3",
    "Current code:",
    "def length_of_longest_substring(s):",
    "    left = 0",
    "    seen = {}",
    "    best = 0",
    "    for right, ch in enumerate(s):",
    "        if ch in seen and seen[ch] >= left:",
    "            left = seen[ch] + 1",
    "        seen[ch] = right",
    "        best = max(best, right - left + 1)",
    "    return best",
    "Follow-up requirement:",
    "Return (best_length, best_substring). Track best_start and best_len, and update them only when the current window length is greater than best_len.",
    "Required return shape: after the loop return (best_len, s[best_start:best_start + best_len]). Do not return s[left:right] because right is exclusive.",
  ].join("\n"), [
    { speaker: "interviewer", text: "Ahora en CoderPad cambia la funcion para devolver tambien el substring, no solo el largo. Ojo: no devuelvas la ventana final; trackea best_start/best_len y actualizalos solo cuando el largo actual mejora el mejor. Al final devolve exactamente (best_len, s[best_start:best_start + best_len]); no uses s[left:right]." },
  ], ["tuple", "substring", "window", "o(n)"], {
    category: "coderpad_baseline",
    expectedResponseType: "follow_up_change",
    expectedPatch: true,
    requireInlineComments: true,
    requireStructuredCoding: true,
    followUpChange: "Update length_of_longest_substring(s) to return a tuple (best_length, best_substring) while preserving the sliding-window logic. Track best_start and best_len, and update them only when the current window length is greater than best_len; do not return the final window unless it is also the best. After the loop return exactly (best_len, s[best_start:best_start + best_len]); do not use s[left:right] because right is exclusive.",
    previousCodingPayload: makeCodingPayload({
      title: "Longest Substring Without Repeating Characters",
      summary: "Return the length of the longest substring without duplicate characters.",
      signature: "def length_of_longest_substring(s)",
      code: "def length_of_longest_substring(s):\n    # left marks the start of the current duplicate-free window.\n    left = 0\n    seen = {}\n    best = 0\n    for right, ch in enumerate(s):\n        # Move left only past duplicates inside the active window.\n        if ch in seen and seen[ch] >= left:\n            left = seen[ch] + 1\n        seen[ch] = right\n        best = max(best, right - left + 1)\n    return best",
      approach: ["Use a sliding window with last-seen indexes."],
      edgeCases: ["empty string", "all repeated characters"],
    }),
    executableAssertions: [
      { python: "__res = length_of_longest_substring('abcabcbb')\n__callpilot_assert_equal(__res[0], 3)\nassert __res[1] in 'abcabcbb' and len(__res[1]) == 3 and len(set(__res[1])) == 3" },
      { python: "__res = length_of_longest_substring('bbbbb')\n__callpilot_assert_equal(__res[0], 1)\nassert __res[1] == 'b'" },
      { python: "__callpilot_assert_equal(length_of_longest_substring(''), (0, ''))" },
    ],
    forbidden: ["start over", "regex", "mercado"],
    maxTokens: 640,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("coderpad_debug_fix_sliding_window_left_regression", "CoderPad debug fix for stale left pointer", [
    "CoderPad Interview",
    "Python 3",
    "Current code:",
    "def length_of_longest_substring(s):",
    "    left = 0",
    "    seen = {}",
    "    best = 0",
    "    for right, ch in enumerate(s):",
    "        if ch in seen:",
    "            left = seen[ch] + 1",
    "        seen[ch] = right",
    "        best = max(best, right - left + 1)",
    "    return best",
    "Failing test: length_of_longest_substring('abba') should be 2 but this returns 3.",
  ].join("\n"), [
    { speaker: "interviewer", text: "El test de abba falla porque left vuelve hacia atras. Corregilo en CoderPad sin cambiar la firma: left tiene que seguir siendo un indice absoluto, no una distancia." },
  ], ["left", "seen", "window", "o(n)"], {
    category: "coderpad_baseline",
    expectedResponseType: "follow_up_change",
    expectedPatch: true,
    requireInlineComments: true,
    requireStructuredCoding: true,
    followUpChange: "Fix the sliding-window bug where left can move backwards; keep def length_of_longest_substring(s) returning an int. Preserve the invariant that left is an absolute window-start index, for example max(left, seen[ch] + 1), not a distance like right - seen[ch] + 1.",
    previousCodingPayload: makeCodingPayload({
      title: "Longest Substring Without Repeating Characters",
      summary: "Return the length of the longest substring without duplicate characters.",
      signature: "def length_of_longest_substring(s)",
      code: "def length_of_longest_substring(s):\n    # BUG: this can move left backward for stale duplicates.\n    left = 0\n    seen = {}\n    best = 0\n    for right, ch in enumerate(s):\n        if ch in seen:\n            left = seen[ch] + 1\n        seen[ch] = right\n        best = max(best, right - left + 1)\n    return best",
      approach: ["Use a sliding window with last-seen indexes."],
      edgeCases: ["stale duplicate before the active window"],
    }),
    executableAssertions: [
      { python: "__callpilot_assert_equal(length_of_longest_substring('abba'), 2)" },
      { python: "__callpilot_assert_equal(length_of_longest_substring('pwwkew'), 3)" },
      { python: "__callpilot_assert_equal(length_of_longest_substring('tmmzuxt'), 5)" },
      { python: "__callpilot_assert_equal(length_of_longest_substring(''), 0)" },
    ],
    forbidden: ["regex", "start over with brute force", "mercado"],
    maxTokens: 620,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("coderpad_group_anagrams_stable_order", "CoderPad stable-order group anagrams", [
    "CoderPad Interview",
    "Python 3",
    "Write group_anagrams(words).",
    "Return a list of groups of anagrams.",
    "Keep groups in the order their first word appears.",
    "Keep words inside each group in input order.",
    "Example: ['eat','tea','tan','ate','nat','bat'] -> [['eat','tea','ate'], ['tan','nat'], ['bat']]",
  ].join("\n"), [
    { speaker: "interviewer", text: "Implement group_anagrams in CoderPad, but keep the group order stable like the prompt says." },
  ], ["dict", "sort", "order", "o("], {
    category: "coderpad_baseline",
    expectedResponseType: "initial_solution",
    expectedPatch: false,
    requireInlineComments: true,
    requireStructuredCoding: true,
    executableAssertions: [
      { python: "__callpilot_assert_equal(group_anagrams(['eat','tea','tan','ate','nat','bat']), [['eat','tea','ate'], ['tan','nat'], ['bat']])" },
      { python: "__callpilot_assert_equal(group_anagrams(['','b','']), [['',''], ['b']])" },
      { python: "__callpilot_assert_equal(group_anagrams([]), [])" },
    ],
    forbidden: ["set output order", "mercado", "billing"],
    maxTokens: 560,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("coderpad_dirty_ocr_two_sum_console", "CoderPad dirty OCR ignores chrome and fixes visible failing test", [
    "Google Chrome",
    "https://app.coderpad.io/interview/abc123",
    "CoderPad",
    "Invite",
    "Run Code",
    "Submit",
    "Participants",
    "Chat",
    "Earlier transcript: explain Redis cache invalidation from the previous interview.",
    "Two Sum",
    "Python 3",
    "Function signature:",
    "def two_sum(nums, target):",
    "Return indices of two different elements whose values add to target.",
    "Return [] if there is no solution.",
    "Required invariant: check complement before inserting the current number so [3,3], target=6 returns [0,1] and never reuses the same index.",
    "Example 1:",
    "Input: nums=[2,7,11,15], target=9",
    "Output: [0,1]",
    "Example 2:",
    "Input: nums=[3,3], target=6",
    "Output: [0,1]",
    "Console",
    "AssertionError: expected [0,1], got []",
  ].join("\n"), [
    { speaker: "interviewer", text: "I'm looking at the CoderPad screen. Ignore the browser UI and previous Redis discussion; fix the visible Two Sum failing test with commented executable Python and a quick explanation. Please check the complement before inserting the current number so duplicates like [3,3] work." },
  ], ["two_sum", "complement", "hash", "o(n)"], {
    category: "coderpad_baseline",
    expectedResponseType: "initial_solution",
    expectedPatch: false,
    requireInlineComments: true,
    requireStructuredCoding: true,
    expectedFunctionName: "two_sum",
    executableAssertions: [
      { python: "__callpilot_assert_equal(two_sum([2, 7, 11, 15], 9), [0, 1])" },
      { python: "__callpilot_assert_equal(two_sum([3, 3], 6), [0, 1])" },
      { python: "__callpilot_assert_equal(two_sum([1, 2, 3], 10), [])" },
    ],
    forbidden: ["redis", "chrome", "invite", "participants", "browser"],
    maxChars: 1500,
    maxTokens: 620,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("executable_valid_parentheses", "Executable Valid Parentheses", [
    "CoderPad Interview",
    "Python 3",
    "Implement def is_valid(s):",
    "Return True if s contains valid parentheses/brackets/braces, False otherwise.",
    "Characters are only brackets: (), [], {}.",
    "Required algorithm:",
    "pairs = {')': '(', ']': '[', '}': '{'}",
    "If char is in pairs.values(), it is an opening bracket: push it.",
    "If char is in pairs, it is a closing bracket: stack must be non-empty and stack.pop() must equal pairs[char].",
    "Return len(stack) == 0 after scanning all chars.",
    "Examples:",
    "'()[]{}' -> True",
    "'(]' -> False",
    "'([)]' -> False",
  ].join("\n"), [
    { speaker: "interviewer", text: "Implement is_valid(s) for Valid Parentheses. Important: pairs keys are closing brackets, pairs values are opening brackets, so push openings and pop on closings. I need executable Python with comments, a simple explanation, complexity, and runnable tests." },
  ], ["stack", "map", "o(n)", "false"], {
    category: "executable_code",
    expectedResponseType: "initial_solution",
    expectedPatch: false,
    requireInlineComments: true,
    requireStructuredCoding: true,
    expectedFunctionName: "is_valid",
    executableAssertions: [
      { python: "__callpilot_assert_equal(is_valid('()[]{}'), True)" },
      { python: "__callpilot_assert_equal(is_valid('(]'), False)" },
      { python: "__callpilot_assert_equal(is_valid('([)]'), False)" },
      { python: "__callpilot_assert_equal(is_valid('{[]}'), True)" },
      { python: "__callpilot_assert_equal(is_valid(''), True)" },
    ],
    forbidden: ["regex", "mercado", "billing"],
    maxTokens: 560,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("executable_two_sum", "Executable Two Sum", [
    "CoderPad Interview",
    "Python 3",
    "Implement def two_sum(nums, target):",
    "Return indices of two different elements whose values add to target.",
    "Return [] if there is no solution.",
    "Example: nums=[2,7,11,15], target=9 -> [0,1]",
    "Example: nums=[3,3], target=6 -> [0,1]",
  ].join("\n"), [
    { speaker: "interviewer", text: "Implement exactly def two_sum(nums, target). Keep commented executable Python, a simple explanation, complexity, and handle no solution with []." },
  ], ["hash", "complement", "o(n)", "return"], {
    category: "executable_code",
    expectedResponseType: "initial_solution",
    expectedPatch: false,
    requireInlineComments: true,
    requireStructuredCoding: true,
    expectedFunctionName: "two_sum",
    executableAssertions: [
      { python: "__callpilot_assert_equal(two_sum([2, 7, 11, 15], 9), [0, 1])" },
      { python: "__callpilot_assert_equal(two_sum([3, 3], 6), [0, 1])" },
      { python: "__callpilot_assert_equal(two_sum([1, 2, 3], 10), [])" },
      { python: "__callpilot_assert_equal(two_sum([-3, 4, 3, 90], 0), [0, 2])" },
    ],
    forbidden: ["mercado", "billing"],
    maxTokens: 560,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("executable_rotate_matrix", "Executable Rotate Matrix", [
    "CoderPad Interview",
    "Python 3",
    "Implement def rotate(matrix):",
    "Rotate an n x n matrix 90 degrees clockwise.",
    "Return the rotated matrix so CoderPad tests can assert it.",
    "Example: [[1,2,3],[4,5,6],[7,8,9]] -> [[7,4,1],[8,5,2],[9,6,3]]",
  ].join("\n"), [
    { speaker: "interviewer", text: "Implement exactly def rotate(matrix). Keep commented executable Python, a simple explanation, and complexity. Returning the rotated matrix is fine." },
  ], ["transpose", "reverse", "matrix", "o("], {
    category: "executable_code",
    expectedResponseType: "initial_solution",
    expectedPatch: false,
    requireInlineComments: true,
    requireStructuredCoding: true,
    expectedFunctionName: "rotate",
    executableAssertions: [
      { python: "__callpilot_assert_equal(rotate([[1,2,3],[4,5,6],[7,8,9]]), [[7,4,1],[8,5,2],[9,6,3]])" },
      { python: "__callpilot_assert_equal(rotate([[1,2],[3,4]]), [[3,1],[4,2]])" },
      { python: "__callpilot_assert_equal(rotate([[1]]), [[1]])" },
    ],
    forbidden: ["mercado", "billing"],
    maxTokens: 560,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("executable_lru_cache", "Executable LRU Cache", [
    "CoderPad Interview",
    "Python 3",
    "Implement class LRUCache:",
    "  __init__(capacity)",
    "  get(key) -> value or -1",
    "  put(key, value) -> None",
    "Both get and put should be O(1). Evict the least recently used key when capacity is exceeded.",
    "Use from collections import OrderedDict. Do not implement a custom Node or linked list for this baseline.",
    "Use move_to_end(key) after get/update, and popitem(last=False) to evict.",
  ].join("\n"), [
    { speaker: "interviewer", text: "Implement LRUCache in Python with collections.OrderedDict, not a custom Node. Keep commented code visible, explain the data structure simply, and include complexity." },
  ], ["ordered", "dict", "o(1)", "evict"], {
    category: "executable_code_stretch",
    expectedPatch: false,
    requireInlineComments: true,
    requireStructuredCoding: true,
    expectedFunctionName: "LRUCache",
    executableAssertions: [
      { python: "cache = LRUCache(2)\ncache.put(1, 1)\ncache.put(2, 2)\n__callpilot_assert_equal(cache.get(1), 1)\ncache.put(3, 3)\n__callpilot_assert_equal(cache.get(2), -1)\ncache.put(4, 4)\n__callpilot_assert_equal(cache.get(1), -1)\n__callpilot_assert_equal(cache.get(3), 3)\n__callpilot_assert_equal(cache.get(4), 4)" },
      { python: "cache = LRUCache(1)\ncache.put(1, 10)\ncache.put(2, 20)\n__callpilot_assert_equal(cache.get(1), -1)\n__callpilot_assert_equal(cache.get(2), 20)" },
    ],
    forbidden: ["database", "redis", "mercado"],
    maxChars: 1750,
    maxTokens: 760,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("executable_dijkstra_shortest_path", "Executable Dijkstra shortest path", [
    "CoderPad Interview",
    "Python 3",
    "Implement def shortest_path(graph, start, end):",
    "The top-level function name must be exactly shortest_path, not dijkstra.",
    "graph is a dict where graph[node] is a list of (neighbor, weight) tuples.",
    "All weights are non-negative.",
    "Return the shortest distance from start to end, or -1 if end is unreachable.",
    "Example: {'A': [('B', 2), ('C', 5)], 'B': [('C', 1)]}, A -> C returns 3.",
    "Required skeleton:",
    "heap = [(0, start)]",
    "dist = {start: 0}",
    "while heap: pop; skip stale entries; if node == end return cost; relax graph.get(node, [])",
    "After the while loop return -1. Do not return -1 inside the neighbor loop.",
  ].join("\n"), [
    { speaker: "interviewer", text: "Fresh CoderPad task: implement exactly def shortest_path(graph, start, end). Use Dijkstra internally with heapq and graph.get(node, []), but do not name the required top-level function dijkstra. Return -1 only after the heap is exhausted. I need executable Python, comments, and a simple explanation." },
  ], ["dijkstra", "heap", "weight", "o("], {
    category: "executable_code_stretch",
    expectedResponseType: "initial_solution",
    expectedPatch: false,
    requireInlineComments: true,
    requireStructuredCoding: true,
    expectedFunctionName: "shortest_path",
    executableAssertions: [
      { python: "graph = {'A': [('B', 2), ('C', 5)], 'B': [('C', 1), ('D', 4)], 'C': [('D', 1)], 'D': []}\n__callpilot_assert_equal(shortest_path(graph, 'A', 'D'), 4)" },
      { python: "graph = {1: [(2, 7), (3, 1)], 3: [(2, 2)], 2: []}\n__callpilot_assert_equal(shortest_path(graph, 1, 2), 3)" },
      { python: "graph = {'A': [('B', 1)], 'B': [], 'C': []}\n__callpilot_assert_equal(shortest_path(graph, 'A', 'C'), -1)" },
      { python: "__callpilot_assert_equal(shortest_path({'A': []}, 'A', 'A'), 0)" },
    ],
    forbidden: ["bfs only", "unweighted", "mercado"],
    maxChars: 1900,
    maxTokens: 700,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("coding_contract_matrix_rotate_in_place", "Matrix rotate in-place commented code", "def rotate(matrix):\n    n = len(matrix)\n    return [[matrix[n-1-j][i] for j in range(n)] for i in range(n)]", [
    { speaker: "interviewer", text: "Esto crea una matriz nueva. Hacelo in-place con O(1) extra space." },
    { speaker: "interviewer", text: "Una libreria de imagenes que vimos antes no aplica a este ejercicio." },
    { speaker: "interviewer", text: "Mostrame el approach in-place." },
  ], ["transpose", "reverse", "o(1)", "square"], {
    category: "coding_contract",
    expectedResponseType: "initial_solution",
    expectedPatch: false,
    requireInlineComments: true,
    requireStructuredCoding: true,
    forbidden: ["libreria", "imagen"],
    mustUseContext: ["codigo actual crea una matriz nueva", "O(1) extra space"],
    mustIgnoreContext: ["libreria de imagenes"],
    maxTokens: 520,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("coding_contract_threading_busy_wait_patch", "Producer-consumer busy wait follow-up patch", "import threading\nlock = threading.Lock()\nbuffer = []\n\ndef produce(item):\n    with lock:\n        buffer.append(item)\n\ndef consume():\n    while True:\n        with lock:\n            if buffer:\n                return buffer.pop(0)", [
    { speaker: "interviewer", text: "Este consume hace busy-wait cuando el buffer esta vacio." },
    { speaker: "interviewer", text: "En otra entrevista hablaron de async/await, pero aca son threads." },
    { speaker: "interviewer", text: "Reescribi consume para bloquear eficientemente." },
  ], ["condition", "wait", "notify", "queue"], {
    category: "coding_contract",
    expectedResponseType: "follow_up_change",
    expectedPatch: true,
    requireInlineComments: true,
    requireStructuredCoding: true,
    followUpChange: "Reescribe producer/consume para usar Condition o queue.Queue y evitar busy-wait en threads.",
    previousCodingPayload: makeCodingPayload({
      title: "Producer Consumer",
      summary: "Producer appends to a shared buffer and consumer removes items.",
      code: "import threading\nlock = threading.Lock()\nbuffer = []\n\ndef produce(item):\n    # Protect shared list mutation with a lock.\n    with lock:\n        buffer.append(item)\n\ndef consume():\n    while True:\n        # This loop spins when the buffer is empty.\n        with lock:\n            if buffer:\n                return buffer.pop(0)",
    }),
    forbidden: ["asyncio", "async/await", "sleep polling"],
    maxTokens: 560,
    latencyTargetMs: 12000,
  }),
  makeCodingScenario("coding_contract_weighted_graph_dijkstra", "BFS to Dijkstra explanation/code", "from collections import deque\n\ndef shortest_path(graph, start, end):\n    visited = {start}\n    queue = deque([(start, 0)])\n    while queue:\n        node, dist = queue.popleft()\n        if node == end:\n            return dist\n        for neighbor in graph.get(node, []):\n            if neighbor not in visited:\n                visited.add(neighbor)\n                queue.append((neighbor, dist + 1))\n    return -1", [
    { speaker: "interviewer", text: "Esto sirve para unweighted. Si las aristas tienen pesos positivos, BFS sigue dando shortest path?" },
    { speaker: "interviewer", text: "Random aside, algun hiking trail recomendado? No relacionado." },
    { speaker: "interviewer", text: "Que algoritmo usarias para weighted edges?" },
  ], ["dijkstra", "heap", "positive", "weight"], {
    category: "coding_contract",
    expectedResponseType: "follow_up_change",
    expectedPatch: true,
    requireInlineComments: true,
    requireStructuredCoding: true,
    followUpChange: "Cambia la solucion de BFS a Dijkstra para aristas con pesos positivos.",
    previousCodingPayload: makeCodingPayload({
      title: "Shortest Path",
      summary: "Current code uses BFS for an unweighted graph.",
      code: "from collections import deque\n\ndef shortest_path(graph, start, end):\n    # BFS counts edges, which is only correct for unweighted graphs.\n    visited = {start}\n    queue = deque([(start, 0)])\n    while queue:\n        node, dist = queue.popleft()\n        if node == end:\n            return dist\n        for neighbor in graph.get(node, []):\n            if neighbor not in visited:\n                visited.add(neighbor)\n                queue.append((neighbor, dist + 1))\n    return -1",
    }),
    forbidden: ["hiking", "trail", "bfs still"],
    maxTokens: 560,
    latencyTargetMs: 12000,
  }),
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
  const contextualInput = focusedQuestion && focusedQuestion !== conversationWindow ? `interviewer: ${focusedQuestion}` : conversationWindow;
  const userInput = definition.followUpChange && definition.previousCodingPayload
    ? buildLiveCodingFollowUpPrompt({
      changeRequest: definition.followUpChange,
      currentSolution: definition.previousCodingPayload,
      problemContext: contextualInput,
    })
    : contextualInput;
  const prompt = buildPrompt(context, userInput);
  return { ...definition, context, prompt, userInput };
};

const selectScenarioDefinitions = () => scenarioDefinitions
  .filter((scenario) => !cliCategory || scenario.category === cliCategory)
  .filter((scenario) => !cliScenario || scenario.id === cliScenario)
  .slice(0, cliLimit > 0 ? cliLimit : undefined);

const summarizeCorpus = (selectedDefinitions) => ({
  totalAvailable: scenarioDefinitions.length,
  selected: selectedDefinitions.length,
  category: cliCategory || "all",
  scenario: cliScenario || null,
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
    return "nvidia/llama-3.3-nemotron-super-49b-v1";
  }
  return savedModel || "";
};

const runPythonAssertions = (code, assertions = []) => {
  if (!assertions.length) return { required: false, ok: true, passed: 0, total: 0, error: "", scorer: null };
  const result = scoreExecutableRecord({ parsed_output: { kind: "coding", payload: { solution: { code } } } }, {
    language: "python",
    public_tests: assertions,
    timeout_ms: 5000,
    cwd: root,
  });
  const total = result.public_tests?.total ?? assertions.length;
  return {
    required: true,
    ok: result.ok,
    passed: result.public_tests?.passed ?? (result.ok ? total : 0),
    total,
    error: String(result.error || "").slice(0, 1200),
    timedOut: Boolean(result.timeout),
    scorer: result,
  };
};

const codingPayloadFromResult = (result) => {
  const structured = result?.ok ? parseStructuredAnswerPayload(String(result.text || "")) : null;
  return structured?.kind === "coding" ? structured.payload : null;
};

const executableAssertionsForResult = (scenario, result) => {
  const payload = codingPayloadFromResult(result);
  return runPythonAssertions(payload?.solution?.code || "", scenario.executableAssertions);
};

const compactText = (value, maxChars = 240) => String(value || "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, maxChars);

const buildExecutableRepairPrompt = (prompt, result, validation, scenario = {}) => {
  const payload = codingPayloadFromResult(result);
  const failedCode = payload?.solution?.code || String(result?.text || "").slice(0, 3000);
  const expectedResponseType = scenario.expectedResponseType || payload?.responseType || "initial_solution";
  const expectedPatchLine = scenario.expectedPatch === false
    ? "This is a fresh CoderPad task, not a follow-up. Set responseType to initial_solution, set patch.kind to none, and put the full final code only in solution.code."
    : "If a patch is expected, include a complete patch that preserves the existing code and only changes what is needed.";
  const expectedFunctionLine = scenario.expectedFunctionName
    ? `The top-level Python function/class required by the prompt is exactly ${scenario.expectedFunctionName}. Do not rename it, do not replace it with a helper name, and make sure solution.code defines it.`
    : "";
  const instruction = [
    "The previous coding answer failed executable validation in a Python runner.",
    `Return the same raw JSON schema and set responseType exactly to ${expectedResponseType}.`,
    "Return one valid JSON object only. Keep problem as metadata only; do not nest solution, tests, or patch inside problem. Put solution and patch directly under payload.",
    expectedPatchLine,
    "Provide a complete executable solution.code with inline comments. Do not return explanation-only text.",
    "Fix the code so every validation assertion passes; preserve the requested function name and return shape.",
    expectedFunctionLine,
    "validation_error:",
    validation.error || "missing or invalid code",
    "previous_code_or_answer:",
    failedCode,
  ].join("\n");
  return {
    ...prompt,
    user: `${prompt.user}\n\n<executable_code_validation_failed>\n${instruction}\n</executable_code_validation_failed>`,
    debug: {
      ...prompt.debug,
      approximateChars: prompt.debug.approximateChars + instruction.length,
    },
  };
};

const scoreAnswer = (scenario, result, elapsedMs) => {
  const rawText = String(result?.text || "");
  const structured = parseStructuredAnswerPayload(rawText);
  const codingPayload = structured?.kind === "coding" ? structured.payload : null;
  const codingCode = codingPayload?.solution?.code || "";
  const codingPatch = codingPayload?.patch;
  const codingNarration = codingPayload?.narration?.spokenAnswer || "";
  let text = formatAnswerForDisplay(rawText, structured, {
    mode: scenario.mode === "live_coding" ? "coding" : "interview",
    maxInterviewWords: scenario.category === "manual_interview_hard" ? 95 : 140,
  });
  const repairEvents = [];
  const modelText = rawText;
  const normalizeLatin = (value) => String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const lower = normalizeLatin(text);
  const includesTerm = (value, term) => {
    const cleanTerm = normalizeLatin(term);
    if (/^[a-z0-9+#.-]{1,4}$/i.test(cleanTerm)) {
      const escaped = cleanTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(value);
    }
    return value.includes(cleanTerm);
  };
  const wordCount = (value) => String(value).trim().split(/\s+/).filter(Boolean).length;
  const missingExpected = scenario.expected.filter((term) => !lower.includes(term));
  const forbiddenPresent = (scenario.forbidden || []).filter((term) => includesTerm(lower, term));
  const missingMustUseDiagnostics = (scenario.mustUseContext || []).filter((term) => {
    const tokens = normalizeLatin(term).split(/[^a-z0-9+#.-]+/).filter((token) => token.length >= 4);
    if (tokens.length === 0) return false;
    return !tokens.some((token) => includesTerm(lower, token));
  });
  const expectsNoAnswer = scenario.category === "no_answer";
  const structuredNoAnswer = structured?.kind === "interview" && structured.payload.intent === "no_answer";
  const structuredNoAnswerOrClarification = structured?.kind === "interview" && ["no_answer", "clarification"].includes(structured.payload.intent);
  const forbiddenRoleLabels = /\b(interviewer|entrevistador)\s*:/i.test(text);
  const forcedCompanyContext = scenario.mode === "live_coding" && /\b(mercado\s+pago|pagos?|financier[oa]s?|conciliaci[oó]n|pipelines?)\b/i.test(text);
  const proseOnlyText = text.replace(/```[\s\S]*?```/g, "");
  const hugeParagraph = proseOnlyText.split(/\n{2,}/).some((block) => block.length > 650);
  const codeBlockCount = (text.match(/```/g) || []).length / 2;
  const answerWithoutLeadLabel = text.replace(/^\s*(?:\*\*[^*\n]{1,40}:?\*\*|[A-Z][^:\n]{1,30}:)\s*/i, "").trim();
  const chattyOpener = /^(?:"|')?\s*(hola|claro|por supuesto|sure|of course|absolutely)\b/i.test(answerWithoutLeadLabel);
  const decorativeMarkdown = /\*\*_[^*]+|\b[A-Z]{4,}(?:\s+[A-Z]{3,}){1,}\b/.test(text.replace(/\b(SQL|ACID|API|TTL|LRU|JSON|STT|CV|SELECT|UPDATE|FOR)\b/g, ""));
  const metaPhrasing = /\b(ahi tienes|ahí tienes|segun tus requisitos|según tus requisitos|recuerdos previos|ignore la charla|opcional|pleasantries)\b/i.test(text);
  const artifactScanText = text.replace(/\b(OrderedDict|JavaScript|TypeScript|PostgreSQL|OpenAI|NoSQL|queue\.Queue)\b/g, "");
  const garbledArtifact = /(?:\.raise\b|[a-zÃ¡Ã©Ã­Ã³ÃºÃ±]{4,}[A-Z][A-Za-z]{3,})/u.test(artifactScanText);
  const normalizedForMeta = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const strictMetaPhrasing = /\b(ahi|segun tus requisitos|recuerdos previos|ignore la charla|opcional|pleasantries)\b/i.test(normalizedForMeta);
  const strictGarbledArtifact = /(?:para dici\b|latiencia\b|deshilaceraoin\b|responseivo\b|conoptimistic\b|bifrost\b|sadece\b|conipo\b|despeici\b)/i.test(artifactScanText);
  const rawNormalizedForMeta = rawText.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const rawModelChecks = {
    noRawCodeBlocks: scenario.mode === "live_coding" || scenario.allowCodeBlocks || !/```/.test(rawText),
    noRawMetaPhrasing: !/\b(ahi|segun tus requisitos|recuerdos previos|ignore la charla|opcional|pleasantries)\b/i.test(rawNormalizedForMeta),
    noRawJsonScaffold: structured !== null || !/^\s*\{[\s\S]*"(kind|payload|spokenAnswer)"\s*:/i.test(rawText),
  };
  const grounding = structured ? assessAnswerGrounding(scenario.context, scenario.userInput, structured) : null;
  const questionDetection = detectQuestionIntent(scenario.userInput, scenario.context.preferredLanguage);
  const clearQuestionGotNoAnswer = questionDetection.shouldDispatch
    && structured?.kind === "interview"
    && structured.payload.intent === "no_answer"
    && !scenario.allowUngroundedNoAnswer
    && scenario.category !== "no_answer";
  const expectsCodingContract = scenario.requireStructuredCoding || scenario.expectedResponseType || scenario.expectedPatch || scenario.requireInlineComments;
  const inlineCommentPattern = /(^|\n)\s*(#|\/\/|\/\*|\*)\s+\S/;
  const pythonAssertions = runPythonAssertions(codingCode, scenario.executableAssertions);
  const expectedFunctionName = scenario.expectedFunctionName;
  const expectedFunctionPattern = expectedFunctionName
    ? new RegExp(`(^|\\n)\\s*(?:def|class)\\s+${expectedFunctionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:\\(|:)`)
    : null;
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
    noGarbledArtifacts: !garbledArtifact && !strictGarbledArtifact,
    limitedCodeBlocks: scenario.mode !== "live_coding" || codeBlockCount <= 1,
    noUnexpectedCodeBlocks: scenario.mode === "live_coding" || scenario.allowCodeBlocks || codeBlockCount === 0,
    noChattyOpeners: scenario.mode === "live_coding" || expectsNoAnswer || !chattyOpener,
    noDecorativeMarkdown: !decorativeMarkdown,
    noMetaPhrasing: !metaPhrasing && !strictMetaPhrasing,
    forbiddenTermsAbsent: forbiddenPresent.length === 0,
    noAnswerDoesNotOverExplain: !expectsNoAnswer || structuredNoAnswer || text.length <= scenario.maxChars,
    noAnswerIntentAppropriate: !expectsNoAnswer || structuredNoAnswerOrClarification,
    groundedWhenStructured: scenario.mode === "live_coding" || !grounding || grounding.ok,
    clearQuestionAnswered: !clearQuestionGotNoAnswer,
    structuredCodingContract: !expectsCodingContract || structured?.kind === "coding",
    codingResponseTypeExpected: !scenario.expectedResponseType || codingPayload?.responseType === scenario.expectedResponseType,
    codingCodePresent: !scenario.requireStructuredCoding || codingCode.trim().length > 40,
    codingInlineComments: !scenario.requireInlineComments || inlineCommentPattern.test(codingCode),
    codingPatchExpected: scenario.expectedPatch !== true || Boolean(codingPatch && codingPatch.kind !== "none" && codingPatch.code && codingPatch.code.trim()),
    codingNarrationShort: !expectsCodingContract || Boolean(codingNarration.trim()) && wordCount(codingNarration) <= 55,
    codingExpectedFunctionName: !expectedFunctionPattern || expectedFunctionPattern.test(codingCode),
    codingExecutableAssertions: !pythonAssertions.required || pythonAssertions.ok,
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
    rawChars: rawText.length,
    renderedText: text,
    parsedOutput: structured,
    recoveredText: null,
    repairEvents,
    modelText,
    rawModelChecks,
    checks,
    qualityChecks,
    missingExpected,
    forbiddenPresent,
    missingMustUseDiagnostics,
    codingContract: codingPayload ? {
      responseType: codingPayload.responseType,
      codeChars: codingCode.length,
      hasInlineComments: inlineCommentPattern.test(codingCode),
      patchKind: codingPatch?.kind,
      patchChars: codingPatch?.code?.length || 0,
      narrationWords: wordCount(codingNarration),
      executableAssertions: pythonAssertions,
    } : null,
    structured: structured?.kind,
    grounding,
    questionDetection,
  };
};

const buildScenarioObservability = (scenario, metrics, response) => {
  const trace = scenario.prompt.debug.answerContextTrace || {};
  const screenContext = scenario.context.screenContext;
  const transcriptTurns = scenario.context.transcript?.messages || [];
  const lastTranscriptTurn = transcriptTurns.at(-1);
  const lastTranscriptSpeaker = lastTranscriptTurn?.role || lastTranscriptTurn?.speaker || lastTranscriptTurn?.source || "unknown";
  const selectedEvidence = scenario.prompt.debug.selectedEvidence || [];
  const coding = metrics.codingContract;
  return {
    scenarioId: scenario.id,
    responseType: coding?.responseType || metrics.structured || null,
    answeredQuestion: metrics.questionDetection?.normalizedText || compactText(scenario.userInput),
    questionIntent: {
      shouldDispatch: metrics.questionDetection?.shouldDispatch,
      confidence: metrics.questionDetection?.confidence,
      reason: metrics.questionDetection?.reason,
    },
    contextUsed: {
      mode: scenario.mode,
      screenKind: screenContext?.kind || "none",
      screenConfidence: screenContext?.confidence ?? 0,
      screenFocus: compactText(screenContext?.summary || screenContext?.visibleText),
      lastTranscriptTurn: lastTranscriptTurn
        ? compactText(`${lastTranscriptSpeaker}: ${lastTranscriptTurn.text}`)
        : "",
      includedSections: scenario.prompt.debug.includedSections,
      selectedEvidenceLabels: selectedEvidence.map((item) => item.label || item.source).filter(Boolean),
    },
    contextIgnored: {
      omittedSections: scenario.prompt.debug.omittedSections,
      forbiddenPresent: metrics.forbiddenPresent,
      missingMustUseDiagnostics: metrics.missingMustUseDiagnostics,
      staleCutoffMs: trace.freshnessCutoff ?? null,
    },
    coding: coding ? {
      codePresent: coding.codeChars > 0,
      codeChars: coding.codeChars,
      patchKind: coding.patchKind || "none",
      patchChars: coding.patchChars,
      hasInlineComments: coding.hasInlineComments,
      executableAssertions: coding.executableAssertions,
    } : null,
    validation: {
      qualityOk: metrics.qualityOk,
      latencyOk: metrics.latencyOk,
      latencyMs: metrics.latencyMs,
      failedChecks: Object.entries(metrics.qualityChecks || {})
        .filter(([, ok]) => ok === false)
        .map(([key]) => key),
      providerOk: metrics.checks?.providerOk ?? Boolean(response?.ok),
      requestId: response?.requestId || "",
    },
  };
};

const runScenario = async ({ client, settings, provider, modelName, scenario }) => {
  const preflightDetection = detectQuestionIntent(scenario.userInput, scenario.context.preferredLanguage);
  if (scenario.expectedDispatch === false) {
    const ok = !preflightDetection.shouldDispatch;
    const evaluationRecord = createEvaluationRecord({
      run_id: `${scenario.id}-${Date.now()}`,
      dataset: "llm-scenarios",
      split: "development",
      scenario_id: scenario.id,
      source_id: scenario.category || "llm-scenario",
      source_type: "synthetic_scenario",
      provider,
      model: modelName,
      input_snapshot: {
        mode: scenario.mode,
        category: scenario.category,
        label: scenario.label,
        expected_dispatch: false,
      },
      available_transcript: (scenario.context.transcript?.messages || [])
        .map((item) => `${item.speaker || item.role || "unknown"}: ${item.text}`)
        .join("\n"),
      available_screen_context: scenario.context.screenContext?.visibleText || "",
      raw_model_output: "",
      parsed_output: null,
      recovered_output: null,
      final_rendered_output: "",
      raw_model_pass: ok,
      parsed_pass: ok,
      recovered_pass: ok,
      retry_count: 0,
      repair_events: [],
      deterministic_scores: { noDispatchExpected: ok },
      execution_scores: {},
      latency: { complete_ms: 0 },
      failure_class: ok ? null : "unexpected_dispatch",
      severity: ok ? null : "P1",
    });
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
      evaluationRecord,
      response: { ok, text: "", provider, modelName, requestId: `${scenario.id}-preflight`, error: ok ? undefined : "unexpected_dispatch" },
    };
  }
  const liveSpokenOutput = (provider === "openai" || provider === "nvidia") && scenario.mode !== "live_coding";
  const input = {
    provider,
    modelName,
    prompt: scenario.prompt,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    maxTokens: scenario.maxTokens,
    structuredOutput: scenario.mode === "live_coding" ? true : !liveSpokenOutput,
    liveSpokenOutput,
  };
  const started = performance.now();
  let retryCount = 0;
  let result = await evaluate(client, `window.callpilotDesktop.generateAnswer(${JSON.stringify(input)})`);
  const parsedStructured = result.ok ? parseStructuredAnswerPayload(result.text) : null;
  if (result.ok && scenario.mode === "live_coding" && shouldRetryLiveCodingCompleteness(parsedStructured, scenario.prompt.user, result.text)) {
    retryCount += 1;
    const retryPrompt = buildLiveCodingCompletenessRetryPrompt(scenario.prompt);
    result = await evaluate(client, `window.callpilotDesktop.generateAnswer(${JSON.stringify({
      ...input,
      prompt: retryPrompt,
      structuredOutput: true,
      liveSpokenOutput: false,
      maxTokens: Math.max(input.maxTokens || 0, 1200),
    })})`);
  }
  for (let validationAttempt = 1; validationAttempt <= 2; validationAttempt += 1) {
    const executableValidation = executableAssertionsForResult(scenario, result);
    if (!result.ok || scenario.mode !== "live_coding" || !executableValidation.required || executableValidation.ok) break;
    retryCount += 1;
    const repairPrompt = buildExecutableRepairPrompt(scenario.prompt, result, executableValidation, scenario);
    result = await evaluate(client, `window.callpilotDesktop.generateAnswer(${JSON.stringify({
      ...input,
      prompt: repairPrompt,
      structuredOutput: true,
      liveSpokenOutput: false,
      maxTokens: Math.max(input.maxTokens || 0, 1400),
    })})`);
  }
  const elapsedMs = Math.round(performance.now() - started);
  const metrics = scoreAnswer(scenario, result, elapsedMs);
  const observability = buildScenarioObservability(scenario, metrics, result);
  const evaluationRecord = createEvaluationRecord({
    run_id: `${scenario.id}-${Date.now()}`,
    dataset: "llm-scenarios",
    split: "development",
    scenario_id: scenario.id,
    source_id: scenario.category || "llm-scenario",
    source_type: "synthetic_scenario",
    provider,
    model: modelName,
    model_parameters: {
      maxTokens: scenario.maxTokens,
      structuredOutput: input.structuredOutput,
      liveSpokenOutput: input.liveSpokenOutput,
    },
    input_snapshot: {
      mode: scenario.mode,
      category: scenario.category,
      label: scenario.label,
      prompt_debug: scenario.prompt.debug,
    },
    available_transcript: (scenario.context.transcript?.messages || [])
      .map((item) => `${item.speaker || item.role || "unknown"}: ${item.text}`)
      .join("\n"),
    available_screen_context: scenario.context.screenContext?.visibleText || "",
    raw_model_output: result?.text || "",
    parsed_output: metrics.parsedOutput,
    recovered_output: metrics.recoveredText,
    final_rendered_output: metrics.renderedText,
    raw_model_pass: Boolean(result?.ok) && Object.values(metrics.rawModelChecks || {}).every(Boolean),
    parsed_pass: Boolean(metrics.parsedOutput),
    recovered_pass: Boolean(metrics.qualityOk),
    retry_count: retryCount,
    repair_events: metrics.repairEvents || [],
    deterministic_scores: metrics.qualityChecks || metrics.checks || {},
    execution_scores: metrics.codingContract?.executableAssertions || {},
    judge_scores: null,
    latency: {
      complete_ms: elapsedMs,
      target_ms: scenario.latencyTargetMs || null,
    },
    failure_class: metrics.qualityOk ? null : "deterministic_quality_failure",
    severity: metrics.qualityOk ? null : "P1",
    artifacts: {
      request_id: result?.requestId || null,
    },
  });
  return {
    id: scenario.id,
    label: scenario.label,
    mode: scenario.mode,
    promptDebug: scenario.prompt.debug,
    observability,
    evaluationRecord,
    metrics,
    response: result,
  };
};

const summarizeObservability = (results) => results.map((result) => ({
  id: result.id,
  ok: result.metrics.qualityOk ?? result.metrics.ok,
  answeredQuestion: result.observability?.answeredQuestion || "",
  responseType: result.observability?.responseType || null,
  screenKind: result.observability?.contextUsed?.screenKind || "none",
  patchKind: result.observability?.coding?.patchKind || null,
  codePresent: result.observability?.coding?.codePresent ?? false,
  executableOk: result.observability?.coding?.executableAssertions?.ok ?? null,
  failedChecks: result.observability?.validation?.failedChecks || [],
  latencyMs: result.metrics.latencyMs,
}));

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
      observabilitySummary: summarizeObservability(results),
      evaluationVersion: results[0]?.evaluationRecord?.evaluation_version || "callpilot-eval-result-v1",
      evaluationRecords: results.map((item) => item.evaluationRecord),
      evaluationSummary: summarizeEvaluationRecords(results.map((item) => item.evaluationRecord)),
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
        codingContract: item.metrics.codingContract,
        error: item.response?.error,
        missingMustUseDiagnostics: item.metrics.missingMustUseDiagnostics,
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
