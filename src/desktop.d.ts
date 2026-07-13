import type { AssistantModeId, AudioTranscriptionResult, GenerateAnswerInput, GenerateAnswerResult, LiveAudioSource, LiveLatencyPreset, LiveTranscriptionProvider, ModelProvider, OcrLanguage, OcrResult, OllamaModelListResult, PrivacyCheckResult, SavedSession, StealthState } from "./core";

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
  error?: string;
}

export interface ScreenAnalysisResult {
  ok: boolean;
  text: string;
  error?: string;
}

export interface CredentialStatus {
  ok: boolean;
  hasOpenAIKey: boolean;
  hasNativelyKey: boolean;
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
      captureScreenshot: () => Promise<ScreenshotResult>;
      recognizeScreenText: (input: { path: string; language?: OcrLanguage | "auto" | "english" | "spanish" }) => Promise<OcrResult>;
      analyzeScreenshot: (input: { path: string; modelName: string; apiKey?: string }) => Promise<ScreenAnalysisResult>;
      startSession: (options?: { mode?: AssistantModeId }) => Promise<{ ok: boolean; error?: string }>;
      endSession: () => Promise<{ ok: boolean; error?: string }>;
      requestAnswer: () => Promise<{ ok: boolean; error?: string }>;
      publishTranscriptMessage: (message: { id: string; speaker: TranscriptSpeaker; text: string; timestamp: number }) => Promise<{ ok: boolean }>;
      publishLiveTranscript: (message: { id: string; speaker: TranscriptSpeaker; text: string; timestamp: number }) => Promise<{ ok: boolean }>;
      listOllamaModels: (input?: { ollamaBaseUrl?: string }) => Promise<OllamaModelListResult>;
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
      getCredentialStatus: () => Promise<CredentialStatus>;
      saveOpenAIKey: (apiKey: string) => Promise<CredentialStatus>;
      saveNativelyKey: (apiKey: string) => Promise<CredentialStatus>;
      clearOpenAIKey: () => Promise<CredentialStatus>;
      clearNativelyKey: () => Promise<CredentialStatus>;
      exportSessionFile: (session: SavedSession) => Promise<SessionFileResult>;
      importSessionFile: () => Promise<SessionFileResult>;
      getSettings: () => Promise<DesktopSettings>;
      saveSettings: (settings: Partial<DesktopSettings>) => Promise<DesktopSettings>;
      getShortcutHealth: () => Promise<ShortcutHealth[]>;
      onShortcut: (callback: (action: DesktopShortcutAction) => void) => () => void;
      onManualAnswerRequest: (callback: () => void) => () => void;
      onManualAnswerStatus: (callback: (payload: { ok: boolean; status: string; error?: string }) => void) => () => void;
      onAnswerHeadline: (callback: (payload: { requestId?: string; headline: string; keywords: string[] }) => void) => () => void;
      onAnswerDetailChunk: (callback: (payload: { requestId?: string; sequence?: number; text?: string; done?: boolean; error?: string } | string) => void) => () => void;
      onTranscriptMessage: (callback: (message: { id: string; speaker: TranscriptSpeaker; text: string; timestamp: number }) => void) => () => void;
      onLiveTranscript: (callback: (message: { id: string; speaker: TranscriptSpeaker; text: string; timestamp: number }) => void) => () => void;
      onNativelyTranscript: (callback: (payload: { streamId: string; text: string; isFinal: boolean; confidence: number }) => void) => () => void;
      onNativelyStatus: (callback: (payload: { streamId: string; status: string; detail?: string }) => void) => () => void;
    };
  }
}
