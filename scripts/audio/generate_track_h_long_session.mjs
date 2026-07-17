import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const audioRoot = path.join(root, "tests", "fixtures", "audio");
const trackDir = path.join(audioRoot, "track-h");
const tempDir = path.join(os.tmpdir(), `callpilot-track-h-${Date.now()}`);
const sampleRate = 16000;

const gitBashCandidates = [
  process.env.BASH_BIN,
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "bash",
].filter(Boolean);

const ffmpegCandidates = [
  process.env.FFMPEG_BIN,
  path.join(root, ".cache", "ffmpeg-static", "node_modules", "ffmpeg-static", "ffmpeg.exe"),
  "ffmpeg",
].filter(Boolean);

const sessions = [
  {
    sessionId: "behavioral_mixed_context",
    mode: "behavioral",
    profile: "clean",
    duration_ms: 610000,
    full_duration_ms: 1510000,
    channels: ["system", "mic", "both"],
    description: "STAR behavioral flow with correction, silence, follow-up, and an answer trigger near speech.",
    events: [
      {
        id: "opening_star",
        channel: "system",
        start_ms: 0,
        text: "Tell me about a production incident where you had to coordinate under pressure. Please answer in STAR format.",
        critical_terms: ["production incident", "coordinate", "STAR"],
        topic: "behavioral_incident_star",
      },
      {
        id: "candidate_context",
        channel: "mic",
        start_ms: 39000,
        text: "I would frame the situation as a payment latency incident. Actually wait, I should not invent numbers. I would say I triaged logs, aligned support, and communicated status.",
        critical_terms: ["payment latency", "logs", "support", "communicated"],
        topic: "candidate_correction",
        no_answer_expected: true,
      },
      {
        id: "interviewer_followup",
        channel: "system",
        start_ms: 89000,
        text: "Good correction. What was your specific action, and how did you avoid overclaiming impact?",
        critical_terms: ["specific action", "avoid overclaiming"],
        topic: "behavioral_action",
      },
      {
        id: "candidate_restart",
        channel: "mic",
        start_ms: 149000,
        text: "I would say my action was to narrow the blast radius, ask for timestamps, and keep the update factual. The result was clearer ownership, not a made up percentage.",
        critical_terms: ["blast radius", "timestamps", "factual", "ownership"],
        topic: "candidate_factual_result",
        no_answer_expected: true,
      },
      {
        id: "silent_checkpoint",
        channel: "system",
        start_ms: 228000,
        text: "Pause here for a moment.",
        critical_terms: ["pause"],
        topic: "silence_checkpoint",
        no_answer_expected: true,
      },
      {
        id: "latest_question",
        channel: "system",
        start_ms: 306000,
        text: "Now turn that into a concise spoken answer for a backend engineer interview.",
        critical_terms: ["concise spoken answer", "backend engineer"],
        topic: "behavioral_final_answer",
        trigger_answer_ms: 311600,
      },
    ],
    expected: {
      latest_question_terms: ["concise", "spoken", "backend engineer"],
      stale_topic_forbidden_terms: ["Redis index", "two sum", "phone speaker"],
      unsupported_behavioral_specifics: ["fifty percent", "one million users", "Black Friday", "TechCorp", "database outage"],
    },
  },
  {
    sessionId: "technical_backend",
    mode: "technical_qa",
    profile: "headset_meet",
    duration_ms: 655000,
    full_duration_ms: 1660000,
    channels: ["system", "mic", "both"],
    description: "Backend interview that chains Redis, Postgres, APIs, retries, indexing, then returns to cache invalidation.",
    events: [
      {
        id: "redis_question",
        channel: "system",
        start_ms: 0,
        text: "How would you use Redis in front of a Postgres backed API without making cache invalidation unsafe?",
        critical_terms: ["Redis", "Postgres", "API", "cache invalidation"],
        topic: "redis_postgres_cache",
      },
      {
        id: "candidate_cache_answer",
        channel: "mic",
        start_ms: 52000,
        text: "I would use Redis as a bounded cache, with short TTLs, explicit invalidation after writes, and fall back to Postgres when the cache misses.",
        critical_terms: ["bounded cache", "TTLs", "explicit invalidation", "cache misses"],
        topic: "candidate_cache",
        no_answer_expected: true,
      },
      {
        id: "retry_followup",
        channel: "system",
        start_ms: 115000,
        text: "Suppose the write succeeds but invalidation fails. What retry strategy and idempotency key would you use?",
        critical_terms: ["write succeeds", "invalidation fails", "retry strategy", "idempotency key"],
        topic: "retry_idempotency",
      },
      {
        id: "index_shift",
        channel: "system",
        start_ms: 232000,
        text: "Switch topics. In Postgres, when does an index help, and when can it hurt write throughput?",
        critical_terms: ["Postgres", "index", "write throughput"],
        topic: "postgres_indexing",
      },
      {
        id: "return_to_redis",
        channel: "system",
        start_ms: 412000,
        text: "Bring it back to the original Redis cache design and summarize the trade off.",
        critical_terms: ["original Redis", "cache design", "trade off"],
        topic: "redis_tradeoff_return",
        trigger_answer_ms: 417400,
      },
    ],
    expected: {
      latest_question_terms: ["Redis", "cache", "trade"],
      stale_topic_forbidden_terms: ["STAR", "stakeholder conflict", "two sum"],
      unsupported_behavioral_specifics: [],
    },
  },
  {
    sessionId: "live_coding_guidance",
    mode: "live_coding",
    profile: "phone_speaker_teams",
    duration_ms: 705000,
    full_duration_ms: 1740000,
    channels: ["system", "mic", "both"],
    description: "Live coding guidance with an initial problem, requirement change, bug report, and tests request.",
    events: [
      {
        id: "initial_problem",
        channel: "system",
        start_ms: 0,
        text: "Implement an endpoint that returns recent orders by customer id. Explain the data shape before writing code.",
        critical_terms: ["endpoint", "recent orders", "customer id", "data shape"],
        topic: "orders_endpoint",
      },
      {
        id: "candidate_plan",
        channel: "mic",
        start_ms: 68000,
        text: "I would start with a route handler, validate customer id, query by created at descending, and limit the result size.",
        critical_terms: ["route handler", "validate", "created at", "limit"],
        topic: "candidate_endpoint_plan",
        no_answer_expected: true,
      },
      {
        id: "requirement_change",
        channel: "system",
        start_ms: 174000,
        text: "Change the requirement. Now include pagination with a cursor and keep the API backward compatible.",
        critical_terms: ["pagination", "cursor", "backward compatible"],
        topic: "pagination_change",
      },
      {
        id: "bug_report",
        channel: "system",
        start_ms: 358000,
        text: "Bug report: duplicate orders appear when two rows share the same timestamp. How would you fix the ordering?",
        critical_terms: ["duplicate orders", "same timestamp", "ordering"],
        topic: "stable_cursor_ordering",
      },
      {
        id: "tests_request",
        channel: "system",
        start_ms: 532000,
        text: "What tests would you add for the cursor, duplicate timestamps, and empty result pages?",
        critical_terms: ["tests", "cursor", "duplicate timestamps", "empty result pages"],
        topic: "pagination_tests",
        trigger_answer_ms: 539000,
      },
    ],
    expected: {
      latest_question_terms: ["tests", "cursor", "duplicate", "empty"],
      stale_topic_forbidden_terms: ["Redis", "STAR", "production incident"],
      unsupported_behavioral_specifics: [],
    },
  },
  {
    sessionId: "noisy_interruptions",
    mode: "technical_qa",
    profile: "noisy_cafe",
    duration_ms: 590000,
    full_duration_ms: 1480000,
    channels: ["system", "mic", "both"],
    description: "Noisy interrupted interview with overlap, cut phrases, actually wait, reformulation, and filler.",
    events: [
      {
        id: "cut_question",
        channel: "system",
        start_ms: 0,
        text: "Can you explain message queues for background processing, and when you would not use one?",
        critical_terms: ["message queues", "background processing", "not use"],
        topic: "message_queue_tradeoffs",
      },
      {
        id: "candidate_overlap",
        channel: "mic",
        start_ms: 4300,
        text: "Yeah, so, I would use a queue for slow jobs. Actually wait, not for synchronous reads where the user needs the result immediately.",
        critical_terms: ["slow jobs", "synchronous reads", "immediately"],
        topic: "candidate_overlap_correction",
        no_answer_expected: true,
      },
      {
        id: "reformulated_question",
        channel: "system",
        start_ms: 94000,
        text: "Let me reformulate. Compare a queue with direct API retry for an email delivery workflow.",
        critical_terms: ["queue", "direct API retry", "email delivery"],
        topic: "queue_vs_retry",
      },
      {
        id: "filler_candidate",
        channel: "mic",
        start_ms: 177000,
        text: "Um, the queue gives buffering and retry visibility, while a direct retry is simpler but can tie up the request path.",
        critical_terms: ["buffering", "retry visibility", "request path"],
        topic: "candidate_queue_tradeoff",
        no_answer_expected: true,
      },
      {
        id: "latest_interrupt",
        channel: "system",
        start_ms: 392000,
        text: "Ignore the earlier payment example. For the latest question, focus only on queues, retries, dead letters, and idempotency.",
        critical_terms: ["latest question", "queues", "retries", "dead letters", "idempotency"],
        topic: "queue_latest_focus",
        trigger_answer_ms: 402800,
      },
    ],
    expected: {
      latest_question_terms: ["queues", "retries", "dead letters", "idempotency"],
      stale_topic_forbidden_terms: ["payment latency", "Postgres index", "recent orders"],
      unsupported_behavioral_specifics: ["one million users", "Black Friday", "TechCorp"],
    },
  },
];

const powershellQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

const synthesizeWithSapi = (text, outputPath) => {
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
    `$synth.SetOutputToWaveFile(${powershellQuote(outputPath)}, $format)`,
    `$synth.Speak(${powershellQuote(text)})`,
    "$synth.Dispose()",
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
  });
  if (result.status !== 0) {
    throw new Error(`SAPI TTS failed for "${text}": ${result.stderr || result.stdout}`);
  }
};

const readWav = (filePath) => {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${filePath} is not a RIFF/WAVE file`);
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || !data || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16 || fmt.sampleRate !== sampleRate) {
    throw new Error(`${filePath} must be 16 kHz 16-bit PCM WAV`);
  }
  const frames = data.length / 2 / fmt.channels;
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < fmt.channels; channel += 1) {
      sum += data.readInt16LE((frame * fmt.channels + channel) * 2) / 32768;
    }
    samples[frame] = sum / fmt.channels;
  }
  return samples;
};

const writeWav = (filePath, samples) => {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    buffer.writeInt16LE(Math.round(sample < 0 ? sample * 32768 : sample * 32767), 44 + index * 2);
  }
  fs.writeFileSync(filePath, buffer);
};

const trimSilence = (samples, padMs = 45) => {
  const threshold = 0.004;
  const pad = Math.round(sampleRate * padMs / 1000);
  let start = 0;
  let end = samples.length - 1;
  while (start < samples.length && Math.abs(samples[start] ?? 0) < threshold) start += 1;
  while (end > start && Math.abs(samples[end] ?? 0) < threshold) end -= 1;
  start = Math.max(0, start - pad);
  end = Math.min(samples.length - 1, end + pad);
  return samples.slice(start, end + 1);
};

const silence = (ms) => new Float32Array(Math.max(0, Math.round(sampleRate * ms / 1000)));

const concat = (parts) => {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const commandExists = (command) => {
  if (path.isAbsolute(command)) return fs.existsSync(command);
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return result.status === 0;
};

const firstExistingCommand = (commands, label) => {
  const found = commands.find(commandExists);
  if (!found) throw new Error(`${label} is required to generate degraded Track H audio. Set ${label === "ffmpeg" ? "FFMPEG_BIN" : "BASH_BIN"} to an executable path.`);
  return found;
};

const toBashPath = (value) => {
  const resolved = path.resolve(value);
  const match = resolved.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return resolved.replace(/\\/g, "/");
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
};

const degrade = (inputPath, outputPath, profile) => {
  const bash = firstExistingCommand(gitBashCandidates, "bash");
  const ffmpeg = firstExistingCommand(ffmpegCandidates, "ffmpeg");
  const script = path.join(__dirname, "degrade_audio.sh");
  const envPath = `${path.dirname(ffmpeg)}${path.delimiter}${process.env.PATH ?? ""}`;
  const result = spawnSync(bash, [toBashPath(script), toBashPath(inputPath), toBashPath(outputPath), profile], {
    cwd: root,
    env: { ...process.env, PATH: envPath },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Audio degradation failed for ${profile}: ${result.stderr || result.stdout}`);
  }
};

const safeStem = (value) => value.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();

fs.mkdirSync(trackDir, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });

try {
  const manifestSessions = [];
  for (const session of sessions) {
    const manifestEvents = [];
    for (const event of session.events) {
      const rawPath = path.join(tempDir, `${safeStem(session.sessionId)}-${safeStem(event.id)}-raw.wav`);
      const cleanTempPath = path.join(tempDir, `${safeStem(session.sessionId)}-${safeStem(event.id)}-clean.wav`);
      synthesizeWithSapi(event.text, rawPath);
      const samples = concat([silence(160), trimSilence(readWav(rawPath)), silence(260)]);
      writeWav(cleanTempPath, samples);

      const audioFile = `${safeStem(session.sessionId)}-${safeStem(event.id)}-${session.profile}.wav`;
      const outputPath = path.join(trackDir, audioFile);
      if (session.profile === "clean") {
        fs.copyFileSync(cleanTempPath, outputPath);
      } else {
        degrade(cleanTempPath, outputPath, session.profile);
      }
      const audioDurationMs = Math.round(samples.length * 1000 / sampleRate);
      manifestEvents.push({
        eventId: event.id,
        audio_segment: `track-h/${audioFile}`,
        channel: event.channel,
        start_ms: event.start_ms,
        duration_ms: audioDurationMs,
        ...(typeof event.trigger_answer_ms === "number" ? { trigger_answer_ms: event.trigger_answer_ms } : {}),
        expected_critical_terms: event.critical_terms,
        expected_topic: event.topic,
        expected_no_answer: Boolean(event.no_answer_expected),
        ground_truth_transcript: event.text,
      });
    }

    manifestSessions.push({
      sessionId: session.sessionId,
      mode: session.mode,
      profile: session.profile,
      duration_ms: session.duration_ms,
      full_duration_ms: session.full_duration_ms,
      channels: session.channels,
      description: session.description,
      events: manifestEvents,
      expected_checks: {
        transcript_contains_critical_terms: true,
        answer_generated_only_when_expected: true,
        no_stale_topic_answer: true,
        answer_references_latest_question: true,
        no_invented_candidate_specifics: true,
        overlay_session_trace_recorded: true,
        latency_within_broad_thresholds: true,
        latest_question_terms: session.expected.latest_question_terms,
        stale_topic_forbidden_terms: session.expected.stale_topic_forbidden_terms,
        unsupported_behavioral_specifics: session.expected.unsupported_behavioral_specifics,
      },
    });
  }

  const manifest = {
    _meta: {
      description: "Track H long realistic interview sessions. Audio is synthetic TTS with deterministic degradation; no downloaded interview audio and no OpenAI STT path.",
      generated_at: new Date().toISOString(),
      generation_script: "scripts/audio/generate_track_h_long_session.mjs",
      degradation_script: "scripts/audio/degrade_audio.sh",
      sample_rate_hz: sampleRate,
      default_short_limit: 2,
      budget_controls: {
        E2E_LONG_SESSION_LIMIT: "default 1, runner raises short default to 2 for acceptance when unset",
        E2E_LONG_SESSION_MODE: "short|full",
        E2E_MAX_REAL_CALLS: "guards Natively stream starts and NVIDIA answer calls",
      },
      protected_asset_rule: "Once accepted, Track H fixtures should not be mutated to make tests pass; fix the pipeline instead.",
    },
    sessions: manifestSessions,
  };
  fs.writeFileSync(path.join(audioRoot, "track-h-long-session.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    manifest: path.join(audioRoot, "track-h-long-session.json"),
    audioDir: trackDir,
    sessions: manifestSessions.length,
    audioFiles: manifestSessions.reduce((count, session) => count + session.events.length, 0),
  }, null, 2));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
