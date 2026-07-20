import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { summarizeSttCheckpointObservability } = require("../../tests/e2e/video-interview/desktopVideoInterviewSmoke.cjs");

test("desktop video report computes STT checkpoint gap and reconnect counts", () => {
  const summary = summarizeSttCheckpointObservability(10_000, [
    { type: "natively_status", at: 1_000, payload: { status: "connected" } },
    { type: "natively_transcript", at: 7_250, payload: { text: "interviewer audio" } },
    { type: "transcript", at: 8_500, payload: { text: "candidate audio" } },
    { type: "natively_status", at: 9_000, payload: { status: "reconnecting" } },
    { type: "natively_transcript", at: 10_500, payload: { text: "after checkpoint" } },
  ], {
    events: [
      { type: "natively_stream_reconnecting", elapsedMs: 3_000 },
      { type: "natively_stream_started", elapsedMs: 4_000 },
    ],
  });

  assert.equal(summary.stt_gap_ms, 1_500);
  assert.equal(summary.last_stt_event_type, "transcript");
  assert.equal(summary.stt_reconnect_count, 2);
});
