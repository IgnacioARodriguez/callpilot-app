const { app, BrowserWindow, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const argValue = (name, fallback = "") => {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
};

const videoPath = path.resolve(argValue("--video", process.env.CALLPILOT_E2E_VIDEO || ""));
const debugPort = argValue("--debug-port", process.env.CALLPILOT_DESKTOP_VIDEO_PLAYER_DEBUG_PORT || "");
const startMs = Math.max(0, Number(argValue("--start-ms", process.env.CALLPILOT_DESKTOP_VIDEO_START_MS || "0")));
const requestedWidth = Number(argValue("--width", process.env.CALLPILOT_DESKTOP_VIDEO_WIDTH || "0"));
const requestedHeight = Number(argValue("--height", process.env.CALLPILOT_DESKTOP_VIDEO_HEIGHT || "0"));

if (debugPort) app.commandLine.appendSwitch("remote-debugging-port", debugPort);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const fileUrl = (filePath) => `file:///${filePath.replace(/\\/g, "/").replace(/#/g, "%23")}`;

const html = () => `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>CallPilot E2E Video Player</title>
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #050505;
      color: #f8fafc;
      font-family: Arial, sans-serif;
    }
    video {
      width: 100vw;
      height: 100vh;
      object-fit: contain;
      background: #050505;
    }
    .hud {
      position: fixed;
      left: 12px;
      bottom: 12px;
      padding: 6px 8px;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.64);
      font-size: 12px;
      line-height: 1.3;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <video id="video" src="${fileUrl(videoPath)}" playsinline controls></video>
  <div class="hud">
    <div>CallPilot E2E Video Player</div>
    <div id="time">0.000s</div>
  </div>
  <script>
    const video = document.getElementById("video");
    const time = document.getElementById("time");
    const startSeconds = ${JSON.stringify(startMs / 1000)};
    window.__callpilotVideoReady = false;
    window.__callpilotVideoError = "";
    window.__callpilotVideo = video;
    window.__callpilotVideoControls = {
      play: async () => {
        await video.play();
        return { ok: true, currentTime: video.currentTime, paused: video.paused };
      },
      pause: () => {
        video.pause();
        return { ok: true, currentTime: video.currentTime, paused: video.paused };
      },
      seek: (seconds) => new Promise((resolve) => {
        const done = () => {
          video.removeEventListener("seeked", done);
          resolve({ ok: true, currentTime: video.currentTime, paused: video.paused });
        };
        video.addEventListener("seeked", done);
        video.currentTime = Math.max(0, Number(seconds) || 0);
      }),
      status: () => ({
        ok: true,
        ready: window.__callpilotVideoReady,
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        muted: video.muted,
        volume: video.volume,
        error: window.__callpilotVideoError,
      }),
    };
    video.addEventListener("loadedmetadata", async () => {
      if (startSeconds > 0) video.currentTime = Math.min(startSeconds, Math.max(0, video.duration - 0.5));
    });
    video.addEventListener("canplay", async () => {
      window.__callpilotVideoReady = true;
      video.volume = 1;
      video.muted = false;
      try {
        await video.play();
      } catch (error) {
        window.__callpilotVideoError = error?.message || String(error);
      }
    });
    video.addEventListener("error", () => {
      window.__callpilotVideoError = video.error?.message || "video_error";
    });
    setInterval(() => {
      time.textContent = String(video.currentTime.toFixed(3)) + "s";
    }, 200);
  </script>
</body>
</html>`;

app.whenReady().then(async () => {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath || "(missing)"}`);
  }
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = requestedWidth > 0 ? Math.max(640, requestedWidth) : workArea.width;
  const height = requestedHeight > 0 ? Math.max(480, requestedHeight) : workArea.height;
  const htmlPath = path.join(app.getPath("userData"), `desktop-video-player-${Date.now()}.html`);
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html(), "utf8");
  const win = new BrowserWindow({
    title: "CallPilot E2E Video Player",
    width,
    height,
    x: workArea.x,
    y: workArea.y,
    backgroundColor: "#050505",
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  await win.loadFile(htmlPath);
});

app.on("window-all-closed", () => app.quit());
