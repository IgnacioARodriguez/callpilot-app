import { DEFAULT_OLLAMA_BASE_URL, normalizeOllamaBaseUrl, type ModelProvider } from "./modelClient.ts";
import type { PreferredLanguage } from "./context.ts";
import type { AssistantModeId } from "./modes.ts";
import {
  DEFAULT_LIVE_TRANSCRIPTION_SETTINGS,
  normalizeLiveTranscriptionSettings,
  type LiveLatencyPreset,
  type LiveAudioSource,
  type LiveTranscriptionProvider,
} from "./liveTranscription.ts";

export interface AppSettings {
  modelProvider: ModelProvider;
  modelName: string;
  ollamaBaseUrl: string;
  transcriptionModelName: string;
  preferredLanguage: PreferredLanguage;
  defaultCodingLanguage: string;
  answerVerbosity: "short" | "medium" | "detailed";
  activeMode: AssistantModeId;
  liveTranscriptionProvider: LiveTranscriptionProvider;
  liveLatencyPreset: LiveLatencyPreset;
  liveAudioSource: LiveAudioSource;
  nativelyApiKeyHint: string;
  autoAnswerCooldownMs: number;
  autoAnswerMinConfidence: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  modelProvider: "nvidia",
  modelName: "nvidia/llama-3.3-nemotron-super-49b-v1",
  ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  transcriptionModelName: "gpt-4o-transcribe",
  preferredLanguage: "auto",
  defaultCodingLanguage: "Python",
  answerVerbosity: "medium",
  activeMode: "live_coding",
  liveTranscriptionProvider: DEFAULT_LIVE_TRANSCRIPTION_SETTINGS.provider,
  liveLatencyPreset: DEFAULT_LIVE_TRANSCRIPTION_SETTINGS.latencyPreset,
  liveAudioSource: DEFAULT_LIVE_TRANSCRIPTION_SETTINGS.audioSource,
  nativelyApiKeyHint: "",
  autoAnswerCooldownMs: DEFAULT_LIVE_TRANSCRIPTION_SETTINGS.autoAnswerCooldownMs,
  autoAnswerMinConfidence: DEFAULT_LIVE_TRANSCRIPTION_SETTINGS.autoAnswerMinConfidence,
};

const modeIds = new Set<AssistantModeId>(["live_coding", "system_design", "behavioral", "technical_qa", "meeting_notes"]);
const providers = new Set<ModelProvider>(["mock", "openai", "ollama", "natively", "nvidia"]);
const languages = new Set<PreferredLanguage>(["english", "spanish", "auto"]);
const verbosity = new Set<AppSettings["answerVerbosity"]>(["short", "medium", "detailed"]);

export const mergeAppSettings = (input: Partial<AppSettings> = {}): AppSettings => ({
  ...(() => {
    const live = normalizeLiveTranscriptionSettings({
      provider: input.liveTranscriptionProvider,
      latencyPreset: input.liveLatencyPreset,
      audioSource: input.liveAudioSource,
      language: input.preferredLanguage,
      autoAnswerCooldownMs: input.autoAnswerCooldownMs,
      autoAnswerMinConfidence: input.autoAnswerMinConfidence,
    });
    return {
      modelProvider: input.modelProvider && providers.has(input.modelProvider) ? input.modelProvider : DEFAULT_APP_SETTINGS.modelProvider,
      modelName: input.modelName?.trim() || DEFAULT_APP_SETTINGS.modelName,
      ollamaBaseUrl: normalizeOllamaBaseUrl(input.ollamaBaseUrl),
      transcriptionModelName: input.transcriptionModelName?.trim() || DEFAULT_APP_SETTINGS.transcriptionModelName,
      preferredLanguage: input.preferredLanguage && languages.has(input.preferredLanguage) ? input.preferredLanguage : DEFAULT_APP_SETTINGS.preferredLanguage,
      defaultCodingLanguage: input.defaultCodingLanguage?.trim() || DEFAULT_APP_SETTINGS.defaultCodingLanguage,
      answerVerbosity: input.answerVerbosity && verbosity.has(input.answerVerbosity) ? input.answerVerbosity : DEFAULT_APP_SETTINGS.answerVerbosity,
      activeMode: input.activeMode && modeIds.has(input.activeMode) ? input.activeMode : DEFAULT_APP_SETTINGS.activeMode,
      liveTranscriptionProvider: live.provider,
      liveLatencyPreset: live.latencyPreset,
      liveAudioSource: live.audioSource,
      nativelyApiKeyHint: input.nativelyApiKeyHint?.trim() || DEFAULT_APP_SETTINGS.nativelyApiKeyHint,
      autoAnswerCooldownMs: live.autoAnswerCooldownMs,
      autoAnswerMinConfidence: live.autoAnswerMinConfidence,
    };
  })(),
});
