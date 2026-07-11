export type LatencyStage =
  | "audio_or_screen_capture"
  | "transcription_or_vision_done"
  | "model_call_start"
  | "first_headline"
  | "first_token"
  | "response_complete";

export interface LatencyMetricEvent {
  stage: LatencyStage;
  at: number;
  elapsedMs: number;
}

export interface LatencyMetricRun {
  id: string;
  label: string;
  startedAt: number;
  events: LatencyMetricEvent[];
}

export const createLatencyMetricRun = (label: string, now = Date.now()): LatencyMetricRun => ({
  id: `lat-${now}`,
  label,
  startedAt: now,
  events: [],
});

export const markLatencyStage = (
  run: LatencyMetricRun,
  stage: LatencyStage,
  now = Date.now(),
): LatencyMetricRun => ({
  ...run,
  events: [
    ...run.events,
    {
      stage,
      at: now,
      elapsedMs: now - run.startedAt,
    },
  ],
});
