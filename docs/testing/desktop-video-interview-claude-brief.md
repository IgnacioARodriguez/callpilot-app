# Desktop MP4 Interview Debug Brief

Use this brief to ask a second model/reviewer to analyze the latest full-desktop MP4 run. The goal is to diagnose product behavior and propose general fixes. Do not hardcode this MP4, its transcript, or its expected answers into CallPilot.

## Context

We built a reusable desktop E2E harness for local MP4 interview videos. The runner simulates a human user watching a real software engineering/live-coding interview:

- opens CallPilot desktop;
- opens the MP4 in a real Electron video window;
- starts the CallPilot UI session;
- plays the video continuously from the beginning;
- pauses at reviewed per-video checkpoints;
- lets CallPilot capture the current screen;
- runs CallPilot vision;
- presses `Answer`;
- records transcript, vision, answer, latency, errors, and rubric output.

Diarization is intentionally out of scope. The MP4 audio contains both voices mixed.

## Final Run Evidence

Latest full-desktop continuous run:

```text
.cache/desktop-video-interview/run-2026-07-19T11-51-24-829Z/report.json
.cache/desktop-video-interview/run-2026-07-19T11-51-24-829Z/report.md
```

Command shape:

```powershell
$env:CALLPILOT_E2E_VIDEO="C:\Users\Asus\Downloads\videoplayback.mp4"
$env:CALLPILOT_E2E_VIDEO_CONFIG="C:\Projects\callpilot-v0\callpilot-app\.cache\local-video-analysis\analysis-2026-07-18T16-27-06-169Z\video-config.template.json"
$env:E2E_DESKTOP_VIDEO_CHECKPOINT="linked-list-problem-intro,bst-problem-intro"
$env:E2E_DESKTOP_VIDEO_MAX_ANSWERS="2"
$env:E2E_DESKTOP_VIDEO_FROM_BEGINNING="1"
$env:E2E_DESKTOP_VIDEO_PREFERRED_LANGUAGE="english"
$env:E2E_MAX_REAL_CALLS="5"
npm run test:e2e:desktop-video-interview
```

Run result:

- Mode: `desktop_mp4_multi_checkpoint`
- Seek between checkpoints: `false`
- Player opened: `true`
- UI session started: `true`
- Live STT connected: `true`
- Screen captured: `true`
- Vision produced: `true`
- Answer produced: `true`
- Runner/provider errors: `0`
- Real calls: `5/5`
- Median answer latency: `4826 ms`
- Technical rubric: `0/2` checkpoints passed

## Checkpoints

### linked-list-problem-intro

- Timestamp: `151289 ms`
- Player reached checkpoint: `true`
- Screen capture source: `CallPilot E2E Video Player`
- Transcript source: `none`
- Vision detected:
  - `odd/even linked list`
  - `preserve relative order`
- Vision omitted:
  - `two pointers`
  - `O(n) time`
  - `O(1) extra space`
- Answer status: `completed`
- Answer words: `246`
- Rubric result: `false`
- Main failures:
  - STT produced no transcript by this checkpoint.
  - Answer was too long for live interview use.
  - Answer omitted `preserve relative order`, `O(n) time`, and `O(1) extra space`.

### bst-problem-intro

- Timestamp: `1361602 ms`
- Player reached checkpoint: `true`
- Screen capture source: `CallPilot E2E Video Player`
- Transcript source: `e2e_ui_state:possible_prior_answer_echo`
- Vision detected:
  - `BST invariant`
- Vision omitted:
  - `bounds`
  - `recursion`
  - `left subtree less than node`
  - `right subtree greater than node`
- Answer status: `completed`
- Answer words: `203`
- Rubric result: `false`
- Main failures:
  - The response answered the previous linked-list problem instead of the visible BST problem.
  - The context appears contaminated by prior answer/state.
  - The answer ignored fresh screen evidence that the visible problem had changed to BST.
  - The answer was too long for live interview use.

## Fixed Harness Issues

These have already been fixed and pushed to `main`; do not spend analysis time proposing them again.

- Continuous timing now waits from the current player time, not from per-checkpoint warmup.
- The runner forces video playback before waiting for each checkpoint.
- CallPilot Start Interview no longer overrides configured `liveAudioSource` to `both`; it preserves `system`, `mic`, or `both`.
- The E2E player disables hardware acceleration to make window capture usable for video.
- `captureScreenshot({ preferWindowTitle })` can prefer a specific window source.
- The runner records `screen_capture_display_name` to confirm what source was captured.

## Constraints

Any proposed fix must preserve these methodology rules:

- Do not pass ground-truth transcript to CallPilot.
- Do not pass the candidate's future answer to CallPilot.
- Do not pass a hand-written problem description to CallPilot.
- Do not use future video content to improve current answers.
- Do not hardcode checkpoint content or answers into prompts.
- Do not claim autonomous Answer detection; the runner still chooses when to press `Answer`.
- Keep STT provider and transcript delivery provider-agnostic. Avoid Natively-specific product logic unless it belongs only inside a Natively adapter.

## Requested Analysis

Please inspect the repo and the run report, then answer:

1. Why did the BST checkpoint answer the previous linked-list problem even though the current screen showed BST?
2. Where can previous assistant answers or stale screen/transcript state leak into the next manual answer prompt?
3. How should live coding answer construction prioritize fresh screen evidence vs accumulated transcript vs prior assistant answers?
4. Should transcript used for answer generation exclude assistant messages by default?
5. How can we make the prompt shorter and more live-interview appropriate without special-casing this video?
6. What tests should be added so this regression is caught without needing to replay the full MP4 every time?

Please propose concrete, general code changes with file-level pointers. Separate:

- product fixes;
- runner/reporting fixes;
- tests;
- risks or tradeoffs.

## Success Criteria For Next Run

Using the same MP4 and checkpoints, a better run should show:

- linked-list answer under `180` words, mentioning `two pointers`, preserve relative order, `O(n)`, and `O(1)`;
- BST answer focused on BST, bounds/ranges, recursion or iterative equivalent, and left/right subtree constraints;
- no stale linked-list answer during the BST checkpoint;
- transcript source not marked as possible prior-answer echo;
- runner errors remain `0`;
- screen capture source remains `CallPilot E2E Video Player`.
