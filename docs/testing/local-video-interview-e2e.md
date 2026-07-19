# Local Video Interview E2E

## Infrastructure Reused

- Electron desktop launch with remote debugging.
- CDP evaluation against the main renderer and overlay.
- `session:start` and `answer:request` for the manual `Answer` path.
- The selected CallPilot STT adapter route for real transcription when budget allows.
- `screen:analyze` for real vision on checkpoint frames when budget allows.
- `model:generate` through the existing React `ask()` flow.
- Session traces plus JSON/Markdown reports.
- `E2E_MAX_REAL_CALLS` as a hard real-call budget.

## Minimal Version

The first implementation is a controlled local MP4 harness:

1. Analyze the MP4 with Electron/Chromium video APIs.
2. Extract frame thumbnails and optional WAV chunks into ignored `.cache` folders.
3. Generate video-specific checkpoint candidates, a manifest, and a per-video config template.
4. Launch CallPilot desktop.
5. Stream only audio available up to each checkpoint through STT.
6. Analyze the checkpoint frame through CallPilot vision.
7. Seed CallPilot with only STT/vision outputs available at that timestamp.
8. Trigger `Answer` by IPC/CDP and collect response, latency, errors, and trace paths.

This does not introduce a second CallPilot. It exercises existing IPC and app state, but it is not yet a full system-audio desktop capture run.

The next layer is `test:e2e:desktop-video-interview:smoke`. It reuses the same manifest/checkpoint config, but opens the MP4 in a real desktop video window, starts the CallPilot UI session, relies on the app's live desktop-audio capture route, captures the actual screen, and presses `Answer` at reviewed checkpoint(s). By default it still runs one checkpoint for cost/speed, but `E2E_DESKTOP_VIDEO_CHECKPOINT` can contain comma-separated ids and `E2E_DESKTOP_VIDEO_MAX_ANSWERS` controls how many answers are attempted.

## Per-Video Configuration

There is intentionally no universal checkpoint schedule. Each interview video has different pacing, screen layout, silence, problem timing, and follow-up timing. The analyzer therefore writes:

- `manifest.json`: the exact checkpoints selected for that MP4.
- `manifest-summary.md`: reviewable checkpoint/candidate summary.
- `video-config.template.json`: editable config for that specific MP4.

Use the config to force exact timestamps, ignore intros/outros, change sampling density, and tune the audio lookback window for that video.

Execution settings can also be video-specific:

- `execution.stt.adapter`: concrete STT adapter, currently `natively`, `openai`, or `none`.
- `execution.stt.mode`: audio delivery strategy, currently `stream-per-checkpoint`, `persistent-stream`, `file-segment`, or `none`.
- `execution.stt.frame_delay_ms`: delay between PCM frames for streaming adapters.
- `execution.stt.drain_ms`: wait after sending a segment so late transcript events can arrive.
- `execution.preferred_language`: `english`, `spanish`, or `auto`.
- `execution.answer_verbosity`: `short`, `medium`, or `detailed`.
- `execution.default_audio_lookback_ms`: audio window before each checkpoint.

The harness separates the provider adapter from the audio delivery mode. For example, the Natively adapter can use `stream-per-checkpoint` or `persistent-stream`; another future STT provider can implement the same modes without changing checkpoint selection, reporting, or answer triggering.

Deprecated compatibility keys still work for older local configs: `execution.stt_provider`, `execution.natively_frame_delay_ms`, and `execution.natively_drain_ms`.

## Methodology Guards

- Do not pass ground-truth transcript to CallPilot.
- Do not pass the candidate's future answer to CallPilot.
- Do not pass a hand-written problem description to CallPilot.
- Do not use future video content to improve a current answer.
- Treat the audio as mixed; diarization and interviewer/candidate attribution are not measured.
- Use full-video analysis only for evaluator/checkpoint planning.

## Example Manifest Shape

```json
{
  "schema_version": 1,
  "video": {
    "path": "C:\\ruta\\interview.mp4",
    "fileName": "interview.mp4",
    "duration_ms": 1200000,
    "width": 1920,
    "height": 1080,
    "sha256": "..."
  },
  "checkpoints": [
    {
      "id": "checkpoint-01",
      "timestamp_ms": 185000,
      "action": "pause_and_answer",
      "reason": "Visual OCR/keywords suggest coding problem, code, tests, terminal, or technical context is visible.",
      "source_frame_path": ".cache/local-video-analysis/.../frames/frame-00185000.png",
      "visual_context_expected": ["hash map", "complexity"],
      "evaluation": {
        "expected_topics": ["hash map", "complexity"],
        "desirable_topics": [],
        "forbidden_claims": [
          "Do not claim interviewer/candidate diarization is measured."
        ],
        "critical_failures": [
          "Invents visible code/problem details not present in transcript or screen context."
        ]
      }
    }
  ]
}
```

## Commands

```powershell
$env:CALLPILOT_E2E_VIDEO="C:\Users\Asus\Downloads\videoplayback.mp4"
npm run analyze:local-video-interview
```

```powershell
$env:CALLPILOT_E2E_VIDEO_CONFIG="C:\Projects\callpilot-v0\callpilot-app\.cache\local-video-analysis\<run-id>\video-config.template.json"
$env:E2E_MAX_REAL_CALLS="6"
$env:E2E_LOCAL_VIDEO_MAX_ANSWERS="2"
npm run test:e2e:local-video-interview
```

Reports are written under `.cache/local-video-interview/<run-id>/report.json` and `.md`.

```powershell
$env:CALLPILOT_E2E_VIDEO="C:\Users\Asus\Downloads\videoplayback.mp4"
$env:CALLPILOT_E2E_VIDEO_CONFIG="C:\Projects\callpilot-v0\callpilot-app\.cache\local-video-analysis\<run-id>\video-config.template.json"
$env:E2E_DESKTOP_VIDEO_CHECKPOINT="linked-list-problem-intro"
$env:E2E_MAX_REAL_CALLS="3"
npm run test:e2e:desktop-video-interview:smoke
```

Desktop smoke reports are written under `.cache/desktop-video-interview/<run-id>/report.json` and `.md`.

For a faster multi-checkpoint debug run, set `E2E_DESKTOP_VIDEO_CHECKPOINT` to comma-separated ids, raise `E2E_DESKTOP_VIDEO_MAX_ANSWERS`, raise `E2E_MAX_REAL_CALLS`, and optionally use `E2E_DESKTOP_VIDEO_SEEK_BETWEEN_CHECKPOINTS=1`. Seek mode is useful for shaking out automation and per-checkpoint reporting, but it is not a strict continuous-playback interview simulation because the audio context between checkpoints is skipped.
