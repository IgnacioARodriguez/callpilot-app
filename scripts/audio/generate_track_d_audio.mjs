import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const audioDir = path.join(root, "tests", "fixtures", "audio");
const tempDir = path.join(os.tmpdir(), `callpilot-track-d-${Date.now()}`);
const sampleRate = 16000;
const profiles = ["clean", "laptop_mic_zoom", "headset_meet", "phone_speaker_teams", "noisy_cafe"];
const channels = ["mic", "system"];
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

const scenarios = [
  {
    baseId: "race_condition_cutoff",
    fileStem: "track-d-race-cutoff",
    test_type: "race_condition_cutoff",
    ground_truth_transcript: "When the recorder stops keep the final keyword checksum.",
    prefix: "When the recorder stops keep the final keyword",
    critical_word: "checksum",
  },
  ...[4500, 6500, 9000].map((boundaryMs) => ({
    baseId: `chunk_boundary_${boundaryMs}`,
    fileStem: `track-d-boundary-${boundaryMs}`,
    test_type: "chunk_boundary_word_split",
    ground_truth_transcript: "Remember this boundary checksum before answering.",
    prefix: "Remember this boundary",
    critical_word: "checksum",
    suffix: "before answering",
    boundary_timestamp_ms: boundaryMs,
  })),
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

const trimSilence = (samples, padMs = 35) => {
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

const ttsPart = (label, text) => {
  const filePath = path.join(tempDir, `${label}.wav`);
  synthesizeWithSapi(text, filePath);
  return trimSilence(readWav(filePath));
};

const commandExists = (command) => {
  if (path.isAbsolute(command)) return fs.existsSync(command);
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return result.status === 0;
};

const firstExistingCommand = (commands, label) => {
  const found = commands.find(commandExists);
  if (!found) throw new Error(`${label} is required to generate degraded Track D audio. Set ${label === "ffmpeg" ? "FFMPEG_BIN" : "BASH_BIN"} to an executable path.`);
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

fs.mkdirSync(audioDir, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });

const generated = [];

try {
  for (const scenario of scenarios) {
    const prefix = ttsPart(`${scenario.fileStem}-prefix`, scenario.prefix);
    const word = ttsPart(`${scenario.fileStem}-word`, scenario.critical_word);
    const suffix = scenario.suffix ? ttsPart(`${scenario.fileStem}-suffix`, scenario.suffix) : new Float32Array();

    let criticalWordStartMs;
    let triggerTimestampMs = null;
    let cleanSamples;
    if (scenario.test_type === "race_condition_cutoff") {
      const gap = silence(70);
      criticalWordStartMs = Math.round((prefix.length + gap.length) * 1000 / sampleRate);
      triggerTimestampMs = Math.round((prefix.length + gap.length + Math.floor(word.length / 2)) * 1000 / sampleRate);
      cleanSamples = concat([silence(180), prefix, gap, word, silence(1500)]);
      criticalWordStartMs += 180;
      triggerTimestampMs += 180;
    } else {
      const halfWordMs = Math.round(word.length * 500 / sampleRate);
      const targetWordStartMs = scenario.boundary_timestamp_ms - halfWordMs;
      const currentPrefixMs = Math.round(prefix.length * 1000 / sampleRate);
      if (currentPrefixMs >= targetWordStartMs) {
        throw new Error(`${scenario.baseId} prefix is ${currentPrefixMs} ms, longer than target word start ${targetWordStartMs} ms`);
      }
      const pad = silence(targetWordStartMs - currentPrefixMs);
      criticalWordStartMs = targetWordStartMs;
      cleanSamples = concat([prefix, pad, word, silence(120), suffix, silence(1500)]);
    }

    const cleanFile = `${scenario.fileStem}-clean.wav`;
    const cleanPath = path.join(audioDir, cleanFile);
    writeWav(cleanPath, cleanSamples);
    const durationMs = Math.round(cleanSamples.length * 1000 / sampleRate);

    const filesByProfile = { clean: cleanFile };
    for (const profile of profiles.filter((item) => item !== "clean")) {
      const file = `${scenario.fileStem}-${profile}.wav`;
      degrade(cleanPath, path.join(audioDir, file), profile);
      filesByProfile[profile] = file;
    }

    for (const profile of profiles) {
      for (const channel of channels) {
        generated.push({
          scenarioId: `${scenario.baseId}_${channel}_${profile}`,
          channel,
          audio_file: filesByProfile[profile],
          profile,
          ground_truth_transcript: scenario.ground_truth_transcript,
          test_type: scenario.test_type,
          trigger_timestamp_ms: scenario.test_type === "race_condition_cutoff" ? triggerTimestampMs : null,
          critical_word: scenario.critical_word,
          expected_behavior: "el ground_truth_transcript completo debe aparecer en el transcript final reensamblado, incluyendo critical_word",
          critical_word_start_ms: criticalWordStartMs,
          critical_word_end_ms: criticalWordStartMs + Math.round(word.length * 1000 / sampleRate),
          ...(scenario.boundary_timestamp_ms ? { boundary_timestamp_ms: scenario.boundary_timestamp_ms } : {}),
          duration_ms: durationMs,
          sample_rate_hz: sampleRate,
          tts_provider: "windows_sapi_system_speech",
        });
      }
    }
  }

  const manifest = {
    _meta: {
      description: "Track D audio fixtures generated from synthetic TTS, never downloaded interview audio. Clean plus four deterministic degraded variants are covered for mic and system channels.",
      generated_at: new Date().toISOString(),
      live_chunk_ms_presets: {
        fast: 4500,
        balanced: 6500,
        accurate: 9000,
      },
      generation_script: "scripts/audio/generate_track_d_audio.mjs",
      degradation_script: "scripts/audio/degrade_audio.sh",
      protected_asset_rule: "Una vez aprobados, estos fixtures no deben modificarse para hacer pasar tests; si falla, se corrige el pipeline.",
    },
    scenarios: generated,
  };
  fs.writeFileSync(path.join(audioDir, "track-d.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    audioDir,
    scenarios: generated.length,
    files: [...new Set(generated.map((item) => item.audio_file))].length,
  }, null, 2));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
