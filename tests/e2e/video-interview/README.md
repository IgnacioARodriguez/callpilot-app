# Local MP4 Interview E2E

Controlled local harness for a real software engineering/live-coding interview MP4.

## Run

```powershell
$env:CALLPILOT_E2E_VIDEO="C:\ruta\interview.mp4"
npm run analyze:local-video-interview
```

The analysis writes three important files under `.cache/local-video-analysis/<run-id>/`:

- `manifest.json`: exact checkpoints used by the runner.
- `manifest-summary.md`: human-readable review of chosen checkpoints and candidates.
- `review.html`: visual contact sheet with frames, scores, OCR excerpts, and JSON snippets for forced checkpoints.
- `video-config.template.json`: copy/edit this per video when the automatic checkpoints need correction.

A generic config example lives at `tests/e2e/video-interview/video-config.example.json`.

For a new video, open `review.html`, choose the timestamps where a human should press `Answer`, copy those JSON snippets into `analysis.force_checkpoints`, and edit the config before spending provider calls:

```powershell
$env:CALLPILOT_E2E_VIDEO_CONFIG="C:\Projects\callpilot-v0\callpilot-app\.cache\local-video-analysis\<run-id>\video-config.template.json"
npm run analyze:local-video-interview
```

Then run:

```powershell
$env:CALLPILOT_E2E_VIDEO_CONFIG="C:\Projects\callpilot-v0\callpilot-app\.cache\local-video-analysis\<run-id>\video-config.template.json"
npm run test:e2e:local-video-interview
```

By default `E2E_MAX_REAL_CALLS` is treated as `0`, so provider calls are skipped and recorded as blocked. Set an explicit budget for a real run:

```powershell
$env:E2E_MAX_REAL_CALLS="6"
$env:E2E_LOCAL_VIDEO_MAX_ANSWERS="2"
npm run test:e2e:local-video-interview
```

## Useful Variables

- `CALLPILOT_E2E_VIDEO`: local MP4 path.
- `CALLPILOT_E2E_VIDEO_CONFIG`: per-video config JSON with forced checkpoints, ignored ranges, and execution defaults.
- `CALLPILOT_E2E_VIDEO_MANIFEST`: reuse a generated manifest JSON.
- `E2E_LOCAL_VIDEO_CHECKPOINTS`: comma-separated checkpoint ids.
- `E2E_LOCAL_VIDEO_RESUME_FROM`: resume from one checkpoint id.
- `E2E_LOCAL_VIDEO_REPEAT`: repeat each selected checkpoint.
- `E2E_LOCAL_VIDEO_MAX_ANSWERS`: limit answer attempts.
- `E2E_LOCAL_VIDEO_ANALYSIS_ONLY=1`: generate reports without STT/vision/answer calls.
- `E2E_LOCAL_VIDEO_AUDIO_LOOKBACK_MS`: recent audio window before each checkpoint, default `60000`.
- `E2E_LOCAL_VIDEO_STT_ADAPTER`: concrete STT adapter, currently `natively`, `openai`, or `none`.
- `E2E_LOCAL_VIDEO_STT_MODE`: audio delivery mode, currently `stream-per-checkpoint`, `persistent-stream`, `file-segment`, or `none`.
- `E2E_LOCAL_VIDEO_STT_FRAME_DELAY_MS`: delay between 100 ms PCM frames; use `100` for near-real-time streaming adapters.
- `E2E_LOCAL_VIDEO_STT_DRAIN_MS`: wait after sending a segment so late transcript events can arrive.
- `E2E_LOCAL_VIDEO_PREFERRED_LANGUAGE`: `english`, `spanish`, or `auto`; can also be set in `execution.preferred_language`.
- `E2E_LOCAL_VIDEO_ANSWER_VERBOSITY`: `short`, `medium`, or `detailed`; can also be set in `execution.answer_verbosity`.
- `E2E_LOCAL_VIDEO_SKIP_STT=1`: skip STT.
- `E2E_LOCAL_VIDEO_SKIP_VISION=1`: skip provider vision analysis.
- `E2E_LOCAL_VIDEO_SKIP_ANSWER=1`: skip answer generation while still testing STT/vision.
- `E2E_MAX_REAL_CALLS`: hard budget for real STT, vision, and answer calls.

Deprecated aliases still work for older local configs:

- `E2E_LOCAL_VIDEO_STT_PROVIDER=natively-stream` maps to `adapter=natively`, `mode=stream-per-checkpoint`.
- `E2E_LOCAL_VIDEO_STT_PROVIDER=natively-persistent` maps to `adapter=natively`, `mode=persistent-stream`.
- `E2E_LOCAL_VIDEO_STT_PROVIDER=openai-file` maps to `adapter=openai`, `mode=file-segment`.
- `E2E_LOCAL_VIDEO_NATIVELY_FRAME_DELAY_MS` and `E2E_LOCAL_VIDEO_NATIVELY_DRAIN_MS` map to the generic STT timing variables.

## Scope

This is a controlled media harness, not a full desktop-loopback audio test. It extracts frames and WAV segments from the MP4, feeds audio through the selected CallPilot STT adapter/mode when budget allows, analyzes checkpoint frames through CallPilot's vision IPC path when budget allows, and presses `Answer` through the same Electron IPC path used by the overlay.

Checkpoint timing is video-specific. The automatic analyzer proposes candidates, but each MP4 should have its own reviewed config because interviews differ in pace, screen layout, problem timing, and when a human would reasonably press `Answer`. The key fields to edit per video are `force_checkpoints` and `ignore_ranges_ms`.

Diarization is out of scope. The MP4 audio contains both voices mixed; transcripts are stored as `unknown` speaker. In this controlled harness, pressing `Answer` seeds the transcript and screen context, then uses a generic manual-answer prompt rather than treating mixed audio as a hand-written user question.

Generated MP4-derived artifacts remain under `.cache/local-video-analysis/` and `.cache/local-video-interview/`, both ignored by Git.

## Desktop Smoke

The first full-desktop step is a one-checkpoint smoke. It opens CallPilot desktop, opens the MP4 in a real Electron video window with audio, starts the CallPilot UI session, pauses the video at a reviewed checkpoint, captures the actual desktop screen, presses `Answer`, and writes a report under `.cache/desktop-video-interview/<run-id>/`.

```powershell
$env:CALLPILOT_E2E_VIDEO="C:\Users\Asus\Downloads\videoplayback.mp4"
$env:CALLPILOT_E2E_VIDEO_CONFIG="C:\Projects\callpilot-v0\callpilot-app\.cache\local-video-analysis\<run-id>\video-config.template.json"
$env:E2E_DESKTOP_VIDEO_CHECKPOINT="linked-list-problem-intro"
$env:E2E_MAX_REAL_CALLS="3"
npm run test:e2e:desktop-video-interview:smoke
```

Useful desktop-smoke variables:

- `E2E_DESKTOP_VIDEO_CHECKPOINT`: one reviewed checkpoint id.
- `E2E_DESKTOP_VIDEO_WARMUP_MS`: playback window before the checkpoint, default `60000`.
- `E2E_DESKTOP_VIDEO_FROM_BEGINNING=1`: play from the start instead of the warmup window.
- `E2E_DESKTOP_VIDEO_LIVE_STT_PROVIDER`: UI live provider, default `natively`.
- `E2E_DESKTOP_VIDEO_LIVE_AUDIO_SOURCE`: UI audio source, default `system`.
- `E2E_DESKTOP_VIDEO_STT_DRAIN_MS`: wait after pausing so late transcript events can arrive.
- `E2E_DESKTOP_VIDEO_SKIP_VISION=1` or `E2E_DESKTOP_VIDEO_SKIP_ANSWER=1`: isolate automation/audio/vision.

This smoke is still user-timed: the runner chooses the checkpoint and presses `Answer`. It is the first test of the desktop capture path, not a claim that CallPilot autonomously knows when to answer.
