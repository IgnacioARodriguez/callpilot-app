# event_dedup_windowed_metrics_followups

Extreme CallPilot live-coding fixture for a single long session.

The problem processes event lines in this format:

```text
timestamp|event_id|event_type
```

The session evolves from basic event de-duplication into a five-minute sliding window, stale id cleanup, malformed input handling, a return-contract change, sorted metrics, tests, and a final `deque` optimization.

## Answer Actions

| Stage | Action |
|---|---|
| 00 | chat |
| 01 | both |
| 02 | chat |
| 03 | coding |
| 04 | chat |
| 05 | both |
| 06 | coding |
| 07 | both |

## Screenshots

Stage 00 has no screenshot and uses `"image": null`.

Stages 01-07 require real CoderPad captures at the paths listed in `screenshot_manifest.json`. Do not create blank or artificial PNGs. Stage 02 may reuse an exact copy of the Stage 01 screenshot if the visible code has not changed.

## Run

After all PNGs are captured:

```bash
npm run build && node --experimental-strip-types tests/e2e/live-coding/liveCodingReplay.ts --provider=openai --scenario-file=tests/fixtures/coderpad/event_dedup_windowed_metrics_followups/scenario.json
```
