import type { AssistantModeId, AudioTranscriptionResult, GenerateAnswerInput, GenerateAnswerResult, LiveAudioSource, LiveLatencyPreset, LiveTranscriptionProvider, ModelProvider, OcrLanguage, OcrResult, OllamaModelListResult, PrivacyCheckResult, ProviderModelListResult, SavedSession, StealthState, StructuredAnswerPayload } from "./core";

export type DesktopShortcutAction =
  | { type: "ask" }
  | { type: "clear_context" }
  | { type: "capture_screenshot" }
  | { type: "set_mode"; mode: AssistantModeId }
  | { type: "stealth"; state: StealthState };

export interface DesktopSettings {
  modelProvider: ModelProvider;
  modelName: string;
  ollamaBaseUrl: string;
  transcriptionModelName: string;
  preferredLanguage: "english" | "spanish" | "auto";
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

export interface ScreenshotResult {
  ok: boolean;
  path?: string;
  displayName?: string;
  preferredWindowTitle?: string;
  sourceNames?: string[];
  error?: string;
}

export interface ScreenAnalysisResult {
  ok: boolean;
  text: string;
  error?: string;
}

export interface PublishScreenContextInput {
  screenshotPath?: string;
  visibleText?: string;
  displayName?: string;
  source?: string;
  capturedAt?: number;
}

export interface PublishScreenContextResult {
  ok: boolean;
  error?: string;
}

export interface CredentialStatus {
  ok: boolean;
  hasOpenAIKey: boolean;
  hasNativelyKey: boolean;
  hasDeepgramKey: boolean;
  hasNvidiaKey: boolean;
  hasGroqKey: boolean;
  hasOpenAIStoredKey?: boolean;
  hasNativelyStoredKey?: boolean;
  hasDeepgramStoredKey?: boolean;
  hasNvidiaStoredKey?: boolean;
  hasGroqStoredKey?: boolean;
  hasOpenAIEnvKey?: boolean;
  hasNativelyEnvKey?: boolean;
  hasDeepgramEnvKey?: boolean;
  hasNvidiaEnvKey?: boolean;
  hasGroqEnvKey?: boolean;
  encryptionAvailable: boolean;
  error?: string;
}

export interface SessionFileResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  json?: string;
  error?: string;
}

export interface ShortcutHealth {
  accelerator: string;
  registered: boolean;
}

export type RemoteControlCommand =
  | { type: "stop_answer" | "reset_exercise" | "reset_session" | "screenshot"; timestamp?: number }
  | { type: "scroll"; target?: "chat" | "code" | "reasoning"; delta?: number; timestamp?: number };

export interface RemoteControlStatus {
  enabled: boolean;
  port: number;
  mode?: "technical_interview" | "live_coding" | null;
  urls: string[];
  friendlyUrls: string[];
  error?: string;
}

declare global {
  interface SpeechRecognitionAlternative {
    transcript: string;
  }

  interface SpeechRecognitionResult {
    readonly isFinal: boolean;
    readonly 0: SpeechRecognitionAlternative;
  }

  interface SpeechRecognitionResultList {
    readonly length: number;
    item(index: number): SpeechRecognitionResult;
    [index: number]: SpeechRecognitionResult;
  }

  interface SpeechRecognitionEvent extends Event {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultList;
  }

  interface SpeechRecognitionErrorEvent extends Event {
    readonly error?: string;
    readonly message?: string;
  }

  interface SpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
  }

  interface SpeechRecognitionConstructor {
    new (): SpeechRecognition;
  }

  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    callpilotDesktop?: {
      getStealthState: () => Promise<StealthState>;
      setCallPrivacyAllowed: (allowed: boolean) => Promise<StealthState>;
      setOverlayVisible: (visible: boolean) => Promise<StealthState>;
      setContentProtection: (enabled: boolean) => Promise<StealthState>;
      setMousePassthrough: (enabled: boolean) => Promise<StealthState>;
      applyShareSafe: () => Promise<StealthState>;
      resetPrivacy: () => Promise<StealthState>;
      runPrivacyCheck: () => Promise<PrivacyCheckResult>;
      captureScreenshot: (input?: { preferWindowTitle?: string; strictWindowTitle?: boolean; hideCallPilotWindows?: boolean }) => Promise<ScreenshotResult>;
      recognizeScreenText: (input: { path: string; language?: OcrLanguage | "auto" | "english" | "spanish" }) => Promise<OcrResult>;
      analyzeScreenshot: (input: { path: string; modelName: string; provider?: "openai" | "nvidia"; apiKey?: string; nvidiaApiKey?: string }) => Promise<ScreenAnalysisResult>;
      publishScreenContext: (payload: PublishScreenContextInput) => Promise<PublishScreenContextResult>;
      startSession: (options?: {
        mode?: AssistantModeId;
        modelProvider?: string;
        modelName?: string;
        liveTranscriptionProvider?: LiveTranscriptionProvider;
        liveLatencyPreset?: LiveLatencyPreset;
        liveAudioSource?: LiveAudioSource;
        preferredLanguage?: "english" | "spanish" | "auto";
        activeMode?: AssistantModeId;
      }) => Promise<{ ok: boolean; error?: string }>;
      endSession: () => Promise<{ ok: boolean; error?: string; tracePath?: string }>;
      getSessionTraceStatus: () => Promise<{ ok: boolean; active: boolean; id?: string; path?: string; eventCount?: number; startedAt?: string; updatedAt?: string }>;
      recordSessionEvent: (type: string, payload?: Record<string, unknown>) => Promise<{ ok: boolean }>;
      requestAnswer: (questionOverride?: string) => Promise<{ ok: boolean; error?: string; requestId?: string }>;
      cancelAnswer: (requestId: string) => Promise<{ ok: boolean; status?: string; requestId?: string; error?: string }>;
      publishTranscriptMessage: (message: { id: string; speaker: TranscriptSpeaker; text: string; timestamp: number }) => Promise<{ ok: boolean }>;
      publishLiveTranscript: (message: { id: string; speaker: TranscriptSpeaker; text: string; timestamp: number }) => Promise<{ ok: boolean }>;
      publishStructuredAnswer: (payload: { requestId?: string; answer: StructuredAnswerPayload; renderedText: string; timestamp: number }) => Promise<{ ok: boolean }>;
      publishRawModelOutput: (payload: { requestId?: string; stage: string; provider?: string; modelName?: string; ok: boolean; error?: string; text: string; timestamp: number }) => Promise<{ ok: boolean }>;
      publishAnswerStatus: (payload: { requestId?: string; status: "busy" | "completed" | "failed" | "cancelled"; text?: string; error?: string; timestamp: number }) => Promise<{ ok: boolean }>;
      listOllamaModels: (input?: { ollamaBaseUrl?: string }) => Promise<OllamaModelListResult>;
      listNvidiaModels: () => Promise<ProviderModelListResult>;
      listGroqModels: () => Promise<ProviderModelListResult>;
      generateAnswer: (input: GenerateAnswerInput) => Promise<GenerateAnswerResult>;
      transcribeAudio: (input: {
        arrayBuffer: ArrayBuffer;
        fileName: string;
        mimeType: string;
        modelName?: string;
        apiKey?: string;
        provider?: "openai" | "natively";
        nativelyApiKey?: string;
      }) => Promise<AudioTranscriptionResult>;
      startNativelyTranscription: (input: {
        streamId: string;
        channel: "system" | "mic";
        sampleRate: number;
        language: "english" | "spanish" | "auto";
        apiKey?: string;
      }) => Promise<{ ok: boolean; streamId?: string; error?: string }>;
      sendNativelyAudio: (input: { streamId: string; arrayBuffer: ArrayBuffer }) => Promise<{ ok: boolean; error?: string }>;
      stopNativelyTranscription: (input?: { streamId?: string }) => Promise<{ ok: boolean; error?: string }>;
      startDeepgramTranscription: (input: {
        streamId: string;
        channel: "system" | "mic";
        sampleRate: number;
        language: "english" | "spanish" | "auto";
        latencyPreset?: LiveLatencyPreset;
        modelName?: string;
        apiKey?: string;
        endpointingMs?: number;
        utteranceEndMs?: number;
      }) => Promise<{ ok: boolean; streamId?: string; error?: string }>;
      sendDeepgramAudio: (input: { streamId: string; arrayBuffer: ArrayBuffer }) => Promise<{ ok: boolean; error?: string }>;
      stopDeepgramTranscription: (input?: { streamId?: string }) => Promise<{ ok: boolean; error?: string }>;
      getCredentialStatus: () => Promise<CredentialStatus>;
      saveOpenAIKey: (apiKey: string) => Promise<CredentialStatus>;
      saveNativelyKey: (apiKey: string) => Promise<CredentialStatus>;
      saveDeepgramKey: (apiKey: string) => Promise<CredentialStatus>;
      saveNvidiaKey: (apiKey: string) => Promise<CredentialStatus>;
      saveGroqKey: (apiKey: string) => Promise<CredentialStatus>;
      clearOpenAIKey: () => Promise<CredentialStatus>;
      clearNativelyKey: () => Promise<CredentialStatus>;
      clearDeepgramKey: () => Promise<CredentialStatus>;
      clearNvidiaKey: () => Promise<CredentialStatus>;
      clearGroqKey: () => Promise<CredentialStatus>;
      exportSessionFile: (session: SavedSession) => Promise<SessionFileResult>;
      importSessionFile: () => Promise<SessionFileResult>;
      getSettings: () => Promise<DesktopSettings>;
      saveSettings: (settings: Partial<DesktopSettings>) => Promise<DesktopSettings>;
      getShortcutHealth: () => Promise<ShortcutHealth[]>;
      getRemoteControlStatus: () => Promise<RemoteControlStatus>;
      dispatchRemoteControlCommand: (command: RemoteControlCommand) => Promise<{ ok: boolean; error?: string }>;
      onShortcut: (callback: (action: DesktopShortcutAction) => void) => () => void;
      onRemoteControlCommand: (callback: (command: RemoteControlCommand) => void) => () => void;
      onRemoteControlStatus: (callback: (status: RemoteControlStatus) => void) => () => void;
      onManualAnswerRequest: (callback: (payload?: { questionOverride?: string }) => void) => () => void;
      onSessionEnded: (callback: () => void) => () => void;
      onManualAnswerStatus: (callback: (payload: { ok: boolean; status: string; error?: string }) => void) => () => void;
      onAnswerHeadline: (callback: (payload: { requestId?: string; headline: string; keywords: string[] }) => void) => () => void;
      onAnswerDetailChunk: (callback: (payload: { requestId?: string; sequence?: number; text?: string; done?: boolean; error?: string } | string) => void) => () => void;
      onStructuredAnswer: (callback: (payload: { requestId?: string; answer: StructuredAnswerPayload; renderedText: string; timestamp: number }) => void) => () => void;
      onRawModelOutput: (callback: (payload: { requestId?: string; stage: string; provider?: string; modelName?: string; ok: boolean; error?: string; text: string; timestamp: number }) => void) => () => void;
      onAnswerStatus: (callback: (payload: { requestId?: string; status: "busy" | "completed" | "failed" | "cancelled"; text?: string; error?: string; timestamp: number }) => void) => () => void;
      onTranscriptMessage: (callback: (message: { id: string; speaker: TranscriptSpeaker; text: string; timestamp: number }) => void) => () => void;
      onLiveTranscript: (callback: (message: { id: string; speaker: TranscriptSpeaker; text: string; timestamp: number }) => void) => () => void;
      onNativelyTranscript: (callback: (payload: { streamId: string; text: string; isFinal: boolean; confidence: number }) => void) => () => void;
      onNativelyStatus: (callback: (payload: { streamId: string; status: string; detail?: string }) => void) => () => void;
      onDeepgramTranscript: (callback: (payload: { streamId: string; text: string; isFinal: boolean; confidence: number }) => void) => () => void;
      onDeepgramStatus: (callback: (payload: { streamId: string; status: string; detail?: string }) => void) => () => void;
      onScreenContextPublished: (callback: (payload: PublishScreenContextInput) => void) => () => void;
    };
  }
}
