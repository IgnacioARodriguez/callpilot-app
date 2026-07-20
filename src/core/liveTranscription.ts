import type { PreferredLanguage } from "./context.ts";

export type LiveTranscriptionProvider = "browser" | "openai_realtime" | "natively" | "deepgram" | "local";
export type LiveLatencyPreset = "fast" | "balanced" | "accurate";
export type LiveAudioSource = "microphone" | "system" | "both";

export interface LiveTranscriptionSettings {
  provider: LiveTranscriptionProvider;
  latencyPreset: LiveLatencyPreset;
  audioSource: LiveAudioSource;
  language: PreferredLanguage;
  autoAnswerCooldownMs: number;
  autoAnswerMinConfidence: number;
}

export interface LiveTranscriptionPlan {
  provider: LiveTranscriptionProvider;
  latencyPreset: LiveLatencyPreset;
  engineLabel: string;
  expectedLatency: string;
  quality: string;
  requiresDesktopBridge: boolean;
  implemented: boolean;
}

export const DEFAULT_LIVE_TRANSCRIPTION_SETTINGS: LiveTranscriptionSettings = {
  provider: "local",
  latencyPreset: "balanced",
  audioSource: "both",
  language: "auto",
  autoAnswerCooldownMs: 12000,
  autoAnswerMinConfidence: 0.45,
};

const providers = new Set<LiveTranscriptionProvider>(["browser", "openai_realtime", "natively", "deepgram", "local"]);
const presets = new Set<LiveLatencyPreset>(["fast", "balanced", "accurate"]);
const audioSources = new Set<LiveAudioSource>(["microphone", "system", "both"]);
const languages = new Set<PreferredLanguage>(["english", "spanish", "auto"]);

export const normalizeLiveTranscriptionSettings = (
  input: Partial<LiveTranscriptionSettings> = {},
): LiveTranscriptionSettings => ({
  provider: input.provider && providers.has(input.provider) ? input.provider : DEFAULT_LIVE_TRANSCRIPTION_SETTINGS.provider,
  latencyPreset: input.latencyPreset && presets.has(input.latencyPreset) ? input.latencyPreset : DEFAULT_LIVE_TRANSCRIPTION_SETTINGS.latencyPreset,
  audioSource: input.audioSource && audioSources.has(input.audioSource) ? input.audioSource : DEFAULT_LIVE_TRANSCRIPTION_SETTINGS.audioSource,
  language: input.language && languages.has(input.language) ? input.language : DEFAULT_LIVE_TRANSCRIPTION_SETTINGS.language,
  autoAnswerCooldownMs: Number.isFinite(input.autoAnswerCooldownMs)
    ? Math.min(60000, Math.max(3000, Math.round(Number(input.autoAnswerCooldownMs))))
    : DEFAULT_LIVE_TRANSCRIPTION_SETTINGS.autoAnswerCooldownMs,
  autoAnswerMinConfidence: Number.isFinite(input.autoAnswerMinConfidence)
    ? Math.min(0.95, Math.max(0.25, Number(input.autoAnswerMinConfidence)))
    : DEFAULT_LIVE_TRANSCRIPTION_SETTINGS.autoAnswerMinConfidence,
});

export const browserRecognitionLanguage = (language: PreferredLanguage): string =>
  language === "spanish" ? "es-ES" : language === "english" ? "en-US" : "";

export const realtimeDelayForPreset = (preset: LiveLatencyPreset): "minimal" | "low" | "medium" =>
  preset === "fast" ? "minimal" : preset === "accurate" ? "medium" : "low";

export const liveTranscriptionPlan = (settings: LiveTranscriptionSettings): LiveTranscriptionPlan => {
  if (settings.provider === "openai_realtime") {
    return {
      provider: settings.provider,
      latencyPreset: settings.latencyPreset,
      engineLabel: "OpenAI live chunks",
      expectedLatency: settings.latencyPreset === "fast" ? "low" : settings.latencyPreset === "accurate" ? "higher" : "medium",
      quality: settings.latencyPreset === "accurate" ? "highest" : "high",
      requiresDesktopBridge: true,
      implemented: true,
    };
  }
  if (settings.provider === "local") {
    return {
      provider: settings.provider,
      latencyPreset: settings.latencyPreset,
      engineLabel: "Local Whisper",
      expectedLatency: settings.latencyPreset === "fast" ? "medium" : "higher",
      quality: settings.latencyPreset === "accurate" ? "medium-high" : "medium",
      requiresDesktopBridge: true,
      implemented: true,
    };
  }
  if (settings.provider === "natively") {
    return {
      provider: settings.provider,
      latencyPreset: settings.latencyPreset,
      engineLabel: "Natively STT",
      expectedLatency: settings.latencyPreset === "fast" ? "low" : settings.latencyPreset === "accurate" ? "higher" : "medium",
      quality: "high",
      requiresDesktopBridge: true,
      implemented: true,
    };
  }
  if (settings.provider === "deepgram") {
    return {
      provider: settings.provider,
      latencyPreset: settings.latencyPreset,
      engineLabel: "Deepgram realtime",
      expectedLatency: settings.latencyPreset === "fast" ? "low" : settings.latencyPreset === "accurate" ? "medium" : "low",
      quality: settings.latencyPreset === "accurate" ? "high" : "high",
      requiresDesktopBridge: true,
      implemented: true,
    };
  }
  return {
    provider: "browser",
    latencyPreset: settings.latencyPreset,
    engineLabel: "Browser SpeechRecognition",
    expectedLatency: "low",
    quality: "medium",
    requiresDesktopBridge: false,
    implemented: true,
  };
};

export const buildRealtimeTranscriptionSessionUpdate = (
  settings: LiveTranscriptionSettings,
  prompt?: string,
) => ({
  type: "session.update",
  session: {
    type: "transcription",
    audio: {
      input: {
        format: {
          type: "audio/pcm",
          rate: 24000,
        },
        transcription: {
          model: "gpt-realtime-whisper",
          ...(settings.language === "english" ? { language: "en" } : {}),
          ...(settings.language === "spanish" ? { language: "es" } : {}),
          delay: realtimeDelayForPreset(settings.latencyPreset),
          ...(prompt?.trim() ? { prompt: prompt.trim() } : {}),
        },
      },
    },
  },
});
