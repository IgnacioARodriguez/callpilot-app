const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

const argValue = (name, fallback = "") => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};

const parseNumberList = (value) => String(value || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => Number(item))
  .filter((item) => Number.isFinite(item) && item >= 0);

const fail = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  app.exit(1);
};

const main = async () => {
  const videoPath = path.resolve(argValue("--video"));
  const outDir = path.resolve(argValue("--out"));
  const frameStepMs = Math.max(5000, Number(argValue("--frame-step-ms", "30000")));
  const maxFrames = Math.max(1, Number(argValue("--max-frames", "24")));
  const requestedFrameTimes = parseNumberList(argValue("--frame-times-ms"));
  const audioSegments = parseNumberList(argValue("--audio-segments-ms"));
  const audioPrefix = String(argValue("--audio-prefix", "segment"));
  const audioLookbackMs = Math.max(0, Number(argValue("--audio-lookback-ms", "0")));

  if (!fs.existsSync(videoPath)) throw new Error(`Video not found: ${videoPath}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "audio"), { recursive: true });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      webSecurity: false,
    },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
    <meta charset="utf-8">
    <style>html,body{margin:0;background:#111} video{width:100vw;height:100vh;object-fit:contain}</style>
    <video id="video" preload="auto" muted playsinline></video>
  `)}`);

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const videoPath = ${JSON.stringify(videoPath)};
      const outDir = ${JSON.stringify(outDir)};
      const videoUrl = ${JSON.stringify(pathToFileURL(videoPath).href)};
      const frameStepMs = ${JSON.stringify(frameStepMs)};
      const maxFrames = ${JSON.stringify(maxFrames)};
      const requestedFrameTimes = ${JSON.stringify(requestedFrameTimes)};
      const audioSegments = ${JSON.stringify(audioSegments)};
      const audioPrefix = ${JSON.stringify(audioPrefix)};
      const audioLookbackMs = ${JSON.stringify(audioLookbackMs)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const video = document.getElementById("video");

      const waitFor = (eventName, timeoutMs = 30000) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for " + eventName)), timeoutMs);
        video.addEventListener(eventName, () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });

      video.src = videoUrl;
      await waitFor("loadedmetadata");
      const durationMs = Math.round((Number.isFinite(video.duration) ? video.duration : 0) * 1000);
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;

      const canvas = document.createElement("canvas");
      const maxWidth = 1280;
      const scale = width > maxWidth ? maxWidth / width : 1;
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      let frameTimes = [];
      if (requestedFrameTimes.length > 0) {
        frameTimes = [...new Set(requestedFrameTimes
          .map((value) => Math.round(Math.max(0, Math.min(durationMs, value))))
          .filter((value) => Number.isFinite(value)))].slice(0, maxFrames);
      } else if (durationMs > 0 && Math.ceil(durationMs / frameStepMs) > maxFrames) {
        const intervals = Math.max(1, maxFrames - 1);
        for (let index = 0; index < maxFrames; index += 1) {
          frameTimes.push(Math.round((durationMs * index) / intervals));
        }
      } else {
        for (let ms = 0; ms <= durationMs && frameTimes.length < maxFrames; ms += frameStepMs) {
          frameTimes.push(ms);
        }
      }
      if (requestedFrameTimes.length === 0 && !frameTimes.includes(durationMs) && frameTimes.length < maxFrames && durationMs > 0) frameTimes.push(durationMs);

      const frames = [];
      let previousSample = null;
      for (const timestampMs of frameTimes) {
        const nextTime = Math.min(Math.max(0, timestampMs / 1000), Math.max(0, (durationMs / 1000) - 0.05));
        if (Math.abs(video.currentTime - nextTime) > 0.01) {
          video.currentTime = nextTime;
          await waitFor("seeked");
        } else if (video.readyState < 2) {
          await waitFor("loadeddata");
        }
        await sleep(80);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const png = canvas.toDataURL("image/png").split(",")[1];
        const fileName = "frame-" + String(timestampMs).padStart(8, "0") + ".png";
        const framePath = path.join(outDir, "frames", fileName);
        fs.writeFileSync(framePath, Buffer.from(png, "base64"));

        const sampleCanvas = document.createElement("canvas");
        sampleCanvas.width = 64;
        sampleCanvas.height = 36;
        const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
        sampleCtx.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);
        const sample = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
        let diff = previousSample ? 0 : 1;
        if (previousSample) {
          let total = 0;
          for (let i = 0; i < sample.length; i += 4) {
            total += Math.abs(sample[i] - previousSample[i]);
            total += Math.abs(sample[i + 1] - previousSample[i + 1]);
            total += Math.abs(sample[i + 2] - previousSample[i + 2]);
          }
          diff = total / ((sample.length / 4) * 255 * 3);
        }
        previousSample = new Uint8ClampedArray(sample);
        frames.push({ timestamp_ms: timestampMs, path: framePath, width: canvas.width, height: canvas.height, diff_from_previous: Number(diff.toFixed(4)) });
      }

      const encodeWav = (float32, sampleRate) => {
        const headerBytes = 44;
        const dataBytes = float32.length * 2;
        const buffer = Buffer.alloc(headerBytes + dataBytes);
        const writeString = (offset, value) => buffer.write(value, offset, "ascii");
        writeString(0, "RIFF");
        buffer.writeUInt32LE(36 + dataBytes, 4);
        writeString(8, "WAVE");
        writeString(12, "fmt ");
        buffer.writeUInt32LE(16, 16);
        buffer.writeUInt16LE(1, 20);
        buffer.writeUInt16LE(1, 22);
        buffer.writeUInt32LE(sampleRate, 24);
        buffer.writeUInt32LE(sampleRate * 2, 28);
        buffer.writeUInt16LE(2, 32);
        buffer.writeUInt16LE(16, 34);
        writeString(36, "data");
        buffer.writeUInt32LE(dataBytes, 40);
        for (let i = 0; i < float32.length; i += 1) {
          const clamped = Math.max(-1, Math.min(1, float32[i] || 0));
          buffer.writeInt16LE(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, headerBytes + i * 2);
        }
        return buffer;
      };

      const audio = [];
      if (audioSegments.length > 0 && durationMs > 0) {
        const arrayBuffer = await fetch(videoUrl).then((response) => response.arrayBuffer());
        const decoder = new OfflineAudioContext(1, 1, 16000);
        const decoded = await decoder.decodeAudioData(arrayBuffer.slice(0));
        const targetRate = 16000;
        const totalFrames = Math.ceil(decoded.duration * targetRate);
        const offline = new OfflineAudioContext(1, totalFrames, targetRate);
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start(0);
        const rendered = await offline.startRendering();
        const mono = rendered.getChannelData(0);
        let segmentStartMs = 0;
        for (let index = 0; index < audioSegments.length; index += 1) {
          const endMs = Math.min(durationMs, Math.max(segmentStartMs, audioSegments[index]));
          const startMs = audioLookbackMs > 0 ? Math.max(0, endMs - audioLookbackMs) : segmentStartMs;
          const startSample = Math.floor(startMs * targetRate / 1000);
          const endSample = Math.floor(endMs * targetRate / 1000);
          const slice = mono.slice(startSample, endSample);
          const fileName = audioPrefix + "-" + String(index + 1).padStart(2, "0") + "-" + String(Math.round(startMs)).padStart(8, "0") + "-" + String(Math.round(endMs)).padStart(8, "0") + ".wav";
          const filePath = path.join(outDir, "audio", fileName);
          fs.writeFileSync(filePath, encodeWav(slice, targetRate));
          audio.push({ index: index + 1, start_ms: Math.round(startMs), end_ms: Math.round(endMs), path: filePath, sample_rate_hz: targetRate, bytes: fs.statSync(filePath).size });
          segmentStartMs = endMs;
        }
      }

      return {
        video: {
          path: videoPath,
          fileName: path.basename(videoPath),
          bytes: fs.statSync(videoPath).size,
          duration_ms: durationMs,
          width,
          height,
        },
        frames,
        audio,
        probe: "electron-video-probe",
      };
    })()
  `);

  fs.writeFileSync(path.join(outDir, "probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  app.exit(0);
};

app.whenReady().then(main).catch(fail);
