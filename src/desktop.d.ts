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
      listOllamaModels: (input?: { ollamaBaseUrl?: string }) => Promise<OllamaModelListResult>;
      generateAnswer: (input: GenerateAnswerInput) => Promise<GenerateAnswerResult>;
      transcribeAudio: (input: {
        arrayBuffer: ArrayBuffer;
        fileName: string;
        mimeType: string;
        modelName?: string;
        apiKey?: string;
      }) => Promise<AudioTranscriptionResult>;
      getCredentialStatus: () => Promise<CredentialStatus>;
      saveOpenAIKey: (apiKey: string) => Promise<CredentialStatus>;
      clearOpenAIKey: () => Promise<CredentialStatus>;
      exportSessionFile: (session: SavedSession) => Promise<SessionFileResult>;
      importSessionFile: () => Promise<SessionFileResult>;
      getSettings: () => Promise<DesktopSettings>;
      saveSettings: (settings: Partial<DesktopSettings>) => Promise<DesktopSettings>;
      getShortcutHealth: () => Promise<ShortcutHealth[]>;
      onShortcut: (callback: (action: DesktopShortcutAction) => void) => () => void;
      onAnswerHeadline: (callback: (payload: { headline: string; keywords: string[] }) => void) => () => void;
      onAnswerDetailChunk: (callback: (chunk: string) => void) => () => void;
    };
  }
}
