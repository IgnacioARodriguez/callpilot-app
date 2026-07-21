import React from "react";
import ReactDOM from "react-dom/client";
import { BriefcaseBusiness, Eye, EyeOff, FileText, Mic, MonitorUp, MousePointer2, Radar, RefreshCw, RotateCcw, ScanText, Shield, ShieldCheck, Sparkles, Square, Trash2 } from "lucide-react";
import {
  CURRENT_SESSION_KEY,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_TRANSCRIPTION_MODEL,
  MODES,
  SESSION_LIBRARY_KEY,
  TranscriptBuffer,
  assessAnswerGrounding,
  assessPlainInterviewAnswerGrounding,
  assembleTurn,
  appendSegmentChunk,
  browserRecognitionLanguage,
  buildLiveCodingCompletenessRetryPrompt,
  buildLiveCodingFollowUpPrompt,
  buildPrompt,
  buildPromptWithEvidence,
  classifyScreenText,
  consumeSegmentChunks,
  createGlobalContext,
  createLatencyMetricRun,
  createSessionSnapshot,
  createTurnAssemblerState,
  defaultStealthState,
  formatConversationWindow,
  flushTurnDrafts,
  assessPrivacyState,
  assessPartialTurnStability,
  detectQuestionIntent,
  extractLatestQuestionFocus,
  formatAnswerForDisplay,
  compactLiveSpokenAnswer,
  liveTranscriptionPlan,
  markLatencyStage,
  formatFactualTranscriptText,
  normalizeTechnicalTranscript,
  normalizeLiveTranscriptionSettings,
  normalizeOcrLanguage,
  ocrConfidenceLabel,
  modeById,
  parseSessionJson,
  pickEvidenceWithEmbeddings,
  parseStructuredAnswerPayload,
  pruneRecentSpeech,
  reduceStealthState,
  repairLiveCodingAnswerCoverage,
  shouldRetryLiveCodingCompleteness,
  violatesVisibleCodeContinuity,
  shouldDropCandidateEcho,
  shouldDrainTranscriptionQueue,
  shouldSendNativelyFrame,
  shouldAutoAnswer,
  speechSimilarity,
  serializeSession,
  upsertSession,
  withNoAnswerForUngroundedDrift,
  type AssistantModeId,
  type CodingAnswerPayload,
  type EvidenceEmbedder,
  type EvidenceEmbedding,
  type GlobalContext,
  type LatencyMetricRun,
  type LiveAudioSource,
  type LiveLatencyPreset,
  type LiveTranscriptionProvider,
  type ModelProvider,
  type PrivacyCheckResult,
  type RecentSpeech,
  type SavedSession,
  type ScreenContext,
  type StealthState,
  type TranscriptSpeaker,
  type TranscriptSnapshot,
  type TurnAssemblerState,
} from "./core";
import OverlayApp from "./overlay/OverlayApp";
import CodingOverlayApp from "./overlay/CodingOverlayApp";
import "./styles.css";

type InterviewSetupId = "interview" | "live_coding";

const INTERVIEW_SETUPS: Array<{
  id: InterviewSetupId;
  title: string;
  description: string;
  mode: AssistantModeId;
  answerVerbosity: "short" | "medium" | "detailed";
  latencyPreset: LiveLatencyPreset;
}> = [
  {
    id: "interview",
    title: "Technical Interview",
    description: "Background-aware technical answers for your experience, tradeoffs, and general knowledge questions.",
    mode: "technical_qa",
    answerVerbosity: "short",
    latencyPreset: "fast",
  },
  {
    id: "live_coding",
    title: "Live Coding",
    description: "Problem solving, complexity, edge cases, and what to say while coding.",
    mode: "live_coding",
    answerVerbosity: "medium",
    latencyPreset: "balanced",
  },
];

const NVIDIA_MODEL_PRESETS = [
  "meta/llama-3.1-8b-instruct",
  "nvidia/llama-3.1-nemotron-nano-8b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "nvidia/nemotron-mini-4b-instruct",
  "meta/llama-3.3-70b-instruct",
  "meta/llama-3.1-70b-instruct",
];

const createEmptyCodingPayload = (): CodingAnswerPayload => ({
  version: "1",
  answerNeeded: true,
  responseType: "clarification",
  problem: {
    title: "Waiting for coding exercise",
    summary: "Press Answer when the interviewer gives the exercise or asks for a change.",
    language: "Python",
    functionSignature: null,
    constraints: [],
  },
  solution: {
    approachSteps: [],
    code: "",
    complexity: { time: "", space: "", rationale: "" },
    edgeCases: [],
    invariants: [],
  },
  narration: {
    spokenAnswer: "",
    currentStep: "Listening for the exercise",
  },
  tests: [],
  patch: { kind: "none", code: null },
});

const loadSavedSession = (): Partial<SavedSession> => {
  try {
    const raw = window.localStorage.getItem(CURRENT_SESSION_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const loadSessionLibrary = (): SavedSession[] => {
  try {
    const raw = window.localStorage.getItem(SESSION_LIBRARY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
};

const formatMockAnswer = (context: GlobalContext, userInput: string): string => {
  const prompt = buildPrompt(context, userInput);
  const mode = modeById(context.activeMode);
  const screenHint = context.screenContext.kind !== "unknown" ? `Detected ${context.screenContext.kind.replaceAll("_", " ")}.` : "No strong screen type detected.";
  return [
    `Mode: ${mode.label}`,
    "",
    screenHint,
    context.resumeText || context.starStories || context.jobDescription
      ? "Interview brief detected. Ground the answer in the provided CV, STAR stories, and role requirements."
      : "No interview brief yet. Add CV, STAR stories, and job description for grounded answers.",
    "",
    ...mode.defaultOutputFormat.map((section) => `## ${section}\n${section === "Solution" ? "Start with the simplest correct path, then refine only if constraints require it." : "Use the visible context and transcript evidence here."}`),
    "",
    `Debug: ${prompt.debug.includedSections.length} sections included, ${prompt.debug.omittedSections.length} omitted.`,
  ].join("\n");
};

function App() {
  const savedSession = React.useMemo(loadSavedSession, []);
  type AutoCheck = { label: string; status: "ok" | "warn" | "fail"; detail: string };
  type AnswerWarmupHealth = {
    status: "checking" | "warming" | "ready" | "failed" | "unavailable";
    label: string;
    detail: string;
    updatedAt: number;
  };

  type EvidenceEmbedderWarmupStatus = {
    status: "idle" | "warming" | "ready" | "failed";
    reason?: "startup";
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    error?: string;
  };
  const [sessionIdentity, setSessionIdentity] = React.useState(() => ({
    id: savedSession.id,
    title: savedSession.title,
    createdAt: savedSession.createdAt,
  }));
  const [activeTab, setActiveTab] = React.useState<"meeting" | "context" | "config">("meeting");
  const [selectedSetup, setSelectedSetup] = React.useState<InterviewSetupId>("interview");
  const [activeMode, setActiveMode] = React.useState<AssistantModeId>(savedSession.activeMode ?? "live_coding");
  const answerProviderTouchedRef = React.useRef(false);
  const [transcript, setTranscript] = React.useState<TranscriptSnapshot>(() => savedSession.transcript ?? new TranscriptBuffer().snapshot());
  const [screenText, setScreenText] = React.useState(savedSession.screenText ?? "");
  const [screenContext, setScreenContext] = React.useState<ScreenContext>(() => classifyScreenText(savedSession.screenText ?? ""));
  const [transcriptDraft, setTranscriptDraft] = React.useState("");
  const [isDictating, setIsDictating] = React.useState(false);
  const [autoAnswerEnabled, setAutoAnswerEnabled] = React.useState(false);
  const autoAnswerEnabledRef = React.useRef(false);
  const [liveAssistStatus, setLiveAssistStatus] = React.useState("Live assist idle");
  const recognitionRef = React.useRef<SpeechRecognition | null>(null);
  const lastAutoAnsweredAtRef = React.useRef(0);
  const [companyName, setCompanyName] = React.useState(savedSession.companyName ?? "");
  const [roleTitle, setRoleTitle] = React.useState(savedSession.roleTitle ?? "");
  const [resumeText, setResumeText] = React.useState(savedSession.resumeText ?? savedSession.profile ?? "");
  const [starStories, setStarStories] = React.useState(savedSession.starStories ?? "");
  const [jobDescription, setJobDescription] = React.useState(savedSession.jobDescription ?? "");
  const [notes, setNotes] = React.useState(savedSession.notes ?? "");
  const [profile, setProfile] = React.useState(savedSession.profile ?? "");
  const [targetUseCase, setTargetUseCase] = React.useState(savedSession.targetUseCase ?? "technical interview preparation");
  const [preferredLanguage, setPreferredLanguage] = React.useState<"english" | "spanish" | "auto">(savedSession.preferredLanguage ?? "auto");
  const [codingLanguage, setCodingLanguage] = React.useState(savedSession.codingLanguage ?? "Python");
  const [answerVerbosity, setAnswerVerbosity] = React.useState<"short" | "medium" | "detailed">(savedSession.answerVerbosity ?? "medium");
  const [modelProvider, setModelProvider] = React.useState<ModelProvider>(savedSession.modelProvider ?? "mock");
  const [modelName, setModelName] = React.useState(savedSession.modelName ?? "");
  const [ollamaBaseUrl, setOllamaBaseUrl] = React.useState(DEFAULT_OLLAMA_BASE_URL);
  const [ollamaModels, setOllamaModels] = React.useState<string[]>([]);
  const [ollamaStatus, setOllamaStatus] = React.useState("Ollama models not checked yet");
  const [nvidiaModels, setNvidiaModels] = React.useState<string[]>([]);
  const [nvidiaStatus, setNvidiaStatus] = React.useState("NVIDIA models not checked yet");
  const [transcriptionModelName, setTranscriptionModelName] = React.useState<string>(DEFAULT_TRANSCRIPTION_MODEL);
  const [liveTranscriptionProvider, setLiveTranscriptionProvider] = React.useState<LiveTranscriptionProvider>("deepgram");
  const [liveLatencyPreset, setLiveLatencyPreset] = React.useState<LiveLatencyPreset>("balanced");
  const [liveAudioSource, setLiveAudioSource] = React.useState<LiveAudioSource>("both");
  const [autoAnswerCooldownMs, setAutoAnswerCooldownMs] = React.useState(12000);
  const [autoAnswerMinConfidence, setAutoAnswerMinConfidence] = React.useState(0.45);
  const [sessionApiKey, setSessionApiKey] = React.useState("");
  const [nativelyApiKey, setNativelyApiKey] = React.useState("");
  const [deepgramApiKey, setDeepgramApiKey] = React.useState("");
  const [nvidiaApiKey, setNvidiaApiKey] = React.useState("");
  const [hasStoredOpenAIKey, setHasStoredOpenAIKey] = React.useState(false);
  const [hasStoredNativelyKey, setHasStoredNativelyKey] = React.useState(false);
  const [hasStoredDeepgramKey, setHasStoredDeepgramKey] = React.useState(false);
  const [hasStoredNvidiaKey, setHasStoredNvidiaKey] = React.useState(false);
  const [hasEnvOpenAIKey, setHasEnvOpenAIKey] = React.useState(false);
  const [hasEnvNativelyKey, setHasEnvNativelyKey] = React.useState(false);
  const [hasEnvDeepgramKey, setHasEnvDeepgramKey] = React.useState(false);
  const [hasEnvNvidiaKey, setHasEnvNvidiaKey] = React.useState(false);
  const [settingsLoaded, setSettingsLoaded] = React.useState(false);
  const [credentialStatusLoaded, setCredentialStatusLoaded] = React.useState(false);
  const [credentialMessage, setCredentialMessage] = React.useState("");
  const [answerWarmupHealth, setAnswerWarmupHealth] = React.useState<AnswerWarmupHealth>({
    status: "checking",
    label: "Provider checking",
    detail: "Loading settings and credentials",
    updatedAt: Date.now(),
  });
  const [isRecordingMic, setIsRecordingMic] = React.useState(false);
  const [recordingStatus, setRecordingStatus] = React.useState("");
  const [isGenerating, setIsGenerating] = React.useState(false);
  const isGeneratingRef = React.useRef(false);
  const [latencyRuns, setLatencyRuns] = React.useState<LatencyMetricRun[]>([]);
  const [question, setQuestion] = React.useState(savedSession.question ?? "");
  const [answer, setAnswer] = React.useState(savedSession.answer ?? "");
  const [followUpChange, setFollowUpChange] = React.useState("");
  const [currentCodingPayload, setCurrentCodingPayload] = React.useState<CodingAnswerPayload | null>(savedSession.codingPayload ?? null);
  const [sessionLibrary, setSessionLibrary] = React.useState<SavedSession[]>(loadSessionLibrary);
  const [sessionMessage, setSessionMessage] = React.useState("");
  const [desktopStatus, setDesktopStatus] = React.useState("Web preview");
  const [shortcutStatus, setShortcutStatus] = React.useState("Shortcuts unavailable in web preview");
  const [autoChecks, setAutoChecks] = React.useState<AutoCheck[]>([]);
  const [autoCheckStatus, setAutoCheckStatus] = React.useState("Checks not run yet");
  const [browserSpeechRuntimeError, setBrowserSpeechRuntimeError] = React.useState("");
  const [localSttStatus, setLocalSttStatus] = React.useState("Local Whisper not tested yet");
  const [lastPrompt, setLastPrompt] = React.useState(() => buildPrompt(createGlobalContext(), ""));
  const [stealth, setStealth] = React.useState<StealthState>(defaultStealthState);
  const [privacyCheck, setPrivacyCheck] = React.useState<PrivacyCheckResult | null>(null);
  const transcriptBuffer = React.useMemo(() => new TranscriptBuffer(transcript), [transcript]);
  const transcriptRef = React.useRef(transcript);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const recordingChunksRef = React.useRef<BlobPart[]>([]);
  const recordingStreamRef = React.useRef<MediaStream | null>(null);
  const liveRecorderRef = React.useRef<MediaRecorder | null>(null);
  const liveStreamRef = React.useRef<MediaStream | null>(null);
  const liveRecordersRef = React.useRef<MediaRecorder[]>([]);
  const liveStreamsRef = React.useRef<MediaStream[]>([]);
  const localSegmentTimersRef = React.useRef<number[]>([]);
  const localSegmentChunksByIdRef = React.useRef(new Map<string, BlobPart[]>());
  const localSttBusyByIdRef = React.useRef(new Set<string>());
  const localSttQueueByIdRef = React.useRef(new Map<string, Array<{ blob: Blob; speaker: TranscriptSpeaker }>>());
  const recentSpeechRef = React.useRef<RecentSpeech[]>([]);
  const lastNativelyPartialAnswerRef = React.useRef<{ text: string; timestamp: number }>({ text: "", timestamp: 0 });
  const nativelyPartialStabilityRef = React.useRef<Record<string, { text: string; timestamp: number }>>({});
  const turnAssemblerRef = React.useRef<TurnAssemblerState>(createTurnAssemblerState());
  const lastSystemAudioSignalAtRef = React.useRef(0);
  const lastMicAudioSignalAtRef = React.useRef(0);
  const liveChunkBusyByIdRef = React.useRef(new Set<string>());
  const liveChunkQueueByIdRef = React.useRef(new Map<string, Array<{ blob: Blob; speaker: TranscriptSpeaker }>>());
  const liveContinueRef = React.useRef(false);
  const localSegmentChunksRef = React.useRef<BlobPart[]>([]);
  const localSegmentTimerRef = React.useRef<number | null>(null);
  const nativelySessionsRef = React.useRef<Array<{
    streamId: string;
    context: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
  }>>([]);
  const deepgramSessionsRef = React.useRef<Array<{
    streamId: string;
    context: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
  }>>([]);
  const autoCheckRanRef = React.useRef(false);
  const localSttPipelineRef = React.useRef<Promise<unknown> | null>(null);
  const evidenceEmbedderRef = React.useRef<Promise<EvidenceEmbedder> | null>(null);
  const evidenceEmbeddingCacheRef = React.useRef(new Map<string, EvidenceEmbedding>());
  const evidenceEmbedderWarmupRef = React.useRef<EvidenceEmbedderWarmupStatus>({ status: "idle" });
  const activeLatencyRunIdRef = React.useRef<string | null>(null);
  const activeAnswerRequestIdRef = React.useRef<string | null>(null);
  const firstDetailChunkSeenRef = React.useRef(false);
  const warmedAnswerModelKeyRef = React.useRef("");
  const warmingAnswerModelKeyRef = React.useRef("");
  const recentPublishedTranscriptRef = React.useRef<{ speaker: TranscriptSpeaker; text: string; timestamp: number }>({ speaker: "unknown", text: "", timestamp: 0 });

  React.useEffect(() => {
    autoAnswerEnabledRef.current = autoAnswerEnabled;
  }, [autoAnswerEnabled]);

  React.useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  React.useEffect(() => {
    isGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  const context = React.useMemo(
    () =>
      createGlobalContext({
        activeMode,
        companyName,
        roleTitle,
        resumeText,
        starStories,
        jobDescription,
        transcript,
        screenContext,
        userNotes: notes,
        userProfile: profile,
        targetUseCase,
        preferredLanguage,
        codingLanguagePreference: codingLanguage,
        responseConstraints: [`Verbosity: ${answerVerbosity}`, "Be concise", "Separate facts from assumptions"],
      }),
    [activeMode, answerVerbosity, codingLanguage, companyName, jobDescription, notes, preferredLanguage, profile, resumeText, roleTitle, screenContext, starStories, targetUseCase, transcript],
  );

  const briefStats = React.useMemo(() => {
    const filled = [companyName, roleTitle, resumeText, starStories, jobDescription].filter((value) => value.trim()).length;
    return { filled, ready: filled >= 4 };
  }, [companyName, jobDescription, resumeText, roleTitle, starStories]);

  const liveSettings = React.useMemo(() => normalizeLiveTranscriptionSettings({
    provider: liveTranscriptionProvider,
    latencyPreset: liveLatencyPreset,
    audioSource: liveAudioSource,
    language: preferredLanguage,
    autoAnswerCooldownMs,
    autoAnswerMinConfidence,
  }), [autoAnswerCooldownMs, autoAnswerMinConfidence, liveAudioSource, liveLatencyPreset, liveTranscriptionProvider, preferredLanguage]);

  const livePlan = React.useMemo(() => liveTranscriptionPlan(liveSettings), [liveSettings]);

  const providerLabel = modelProvider === "ollama" ? "Local" : modelProvider === "openai" ? "OpenAI" : modelProvider === "natively" ? "Natively" : modelProvider === "nvidia" ? "NVIDIA" : "Demo";
  const languageLabel = preferredLanguage === "spanish" ? "Spanish" : preferredLanguage === "english" ? "English" : "Auto";
  const listeningLabel = isDictating ? "Listening" : "Stopped";
  const privacyLabel = stealth.callPrivacyAllowed ? "Approved" : "Not approved";
  const hasOpenAITranscriptionKey = hasStoredOpenAIKey || hasEnvOpenAIKey || Boolean(sessionApiKey.trim());
  const hasNativelyTranscriptionKey = hasStoredNativelyKey || hasEnvNativelyKey || Boolean(nativelyApiKey.trim());
  const hasDeepgramTranscriptionKey = hasStoredDeepgramKey || hasEnvDeepgramKey || Boolean(deepgramApiKey.trim());
  const hasNvidiaAnswerKey = hasStoredNvidiaKey || hasEnvNvidiaKey || Boolean(nvidiaApiKey.trim());
  const selectedAnswerModelKey = `${modelProvider}:${modelName || "default"}`;
  const answerWarmupChipClass = answerWarmupHealth.status === "ready"
    ? "health-chip good"
    : answerWarmupHealth.status === "failed" || answerWarmupHealth.status === "unavailable"
      ? "health-chip danger"
      : "health-chip warn";
  const speakerLabel = (speaker?: TranscriptSpeaker) => {
    if (speaker === "candidate") return "Me";
    if (speaker === "assistant") return "CallPilot";
    if (speaker === "interviewer") return "Interviewer";
    return "Unknown";
  };

  const applyCredentialStatus = React.useCallback((status: {
    ok?: boolean;
    hasOpenAIKey?: boolean;
    hasNativelyKey?: boolean;
    hasDeepgramKey?: boolean;
    hasNvidiaKey?: boolean;
    hasOpenAIStoredKey?: boolean;
    hasNativelyStoredKey?: boolean;
    hasDeepgramStoredKey?: boolean;
    hasNvidiaStoredKey?: boolean;
    hasOpenAIEnvKey?: boolean;
    hasNativelyEnvKey?: boolean;
    hasDeepgramEnvKey?: boolean;
    hasNvidiaEnvKey?: boolean;
    encryptionAvailable?: boolean;
  }) => {
    setHasStoredOpenAIKey(Boolean(status.hasOpenAIStoredKey ?? status.hasOpenAIKey));
    setHasStoredNativelyKey(Boolean(status.hasNativelyStoredKey ?? status.hasNativelyKey));
    setHasStoredDeepgramKey(Boolean(status.hasDeepgramStoredKey ?? status.hasDeepgramKey));
    setHasStoredNvidiaKey(Boolean(status.hasNvidiaStoredKey ?? status.hasNvidiaKey));
    setHasEnvOpenAIKey(Boolean(status.hasOpenAIEnvKey));
    setHasEnvNativelyKey(Boolean(status.hasNativelyEnvKey));
    setHasEnvDeepgramKey(Boolean(status.hasDeepgramEnvKey));
    setHasEnvNvidiaKey(Boolean(status.hasNvidiaEnvKey));
  }, []);

  const stripKnownTranscriptHistory = (text: string, speaker: TranscriptSpeaker): string => {
    let candidate = text.trim();
    if (!candidate) return "";
    const previous = transcriptRef.current.messages
      .filter((message) => message.speaker === speaker)
      .slice(-6)
      .sort((left, right) => left.timestamp - right.timestamp);
    for (const message of previous) {
      const haystack = candidate.toLowerCase();
      const needle = message.text.trim().toLowerCase();
      if (needle.length < 80) continue;
      const index = haystack.lastIndexOf(needle);
      if (index >= 0) {
        const suffix = candidate.slice(index + needle.length).replace(/^[\s.,;:!?¿¡—-]+/, "").trim();
        if (suffix) candidate = suffix;
      }
    }
    return candidate;
  };


  const appendTranscript = () => {
    if (!transcriptDraft.trim()) return;
    const next = new TranscriptBuffer(transcript);
    next.append(transcriptDraft);
    setTranscript(next.snapshot());
    setTranscriptDraft("");
  };

  const appendTranscriptLine = React.useCallback((text: string, source: "manual" | "stt" = "manual", speaker: TranscriptSpeaker = "interviewer") => {
    if (!text.trim()) return;
    setTranscript((current) => {
      const lastSameSpeaker = [...current.messages].reverse().find((message) => message.speaker === speaker);
      if (lastSameSpeaker && source === "stt" && speechSimilarity(lastSameSpeaker.text, text) >= 0.9) {
        return current;
      }
      const next = new TranscriptBuffer(current);
      const message = next.append(text, source, Date.now(), speaker);
      if (message) {
        const recent = recentPublishedTranscriptRef.current;
        const duplicatePublish = recent.speaker === speaker
          && Date.now() - recent.timestamp < 1500
          && speechSimilarity(recent.text, message.text) >= 0.96;
        if (!duplicatePublish) {
          recentPublishedTranscriptRef.current = { speaker, text: message.text, timestamp: Date.now() };
          void window.callpilotDesktop?.publishTranscriptMessage?.(message);
        }
      }
      return next.snapshot();
    });
  }, []);

  const appendAssistantTranscriptLine = React.useCallback((text: string, options: { publish?: boolean } = {}) => {
    if (!text.trim()) return;
    const shouldPublish = options.publish !== false;
    setTranscript((current) => {
      const next = new TranscriptBuffer(current);
      const message = next.append(text, "manual", Date.now(), "assistant");
      if (message && shouldPublish) {
        const recent = recentPublishedTranscriptRef.current;
        const duplicatePublish = recent.speaker === "assistant"
          && Date.now() - recent.timestamp < 1500
          && speechSimilarity(recent.text, message.text) >= 0.96;
        if (!duplicatePublish) {
          recentPublishedTranscriptRef.current = { speaker: "assistant", text: message.text, timestamp: Date.now() };
          void window.callpilotDesktop?.publishTranscriptMessage?.(message);
        }
      }
      return next.snapshot();
    });
  }, []);

  const applyInterviewSetup = React.useCallback((setupId: InterviewSetupId) => {
    const setup = INTERVIEW_SETUPS.find((item) => item.id === setupId) ?? INTERVIEW_SETUPS[0];
    setSelectedSetup(setup.id);
    setActiveMode(setup.mode);
    setAnswerVerbosity(setup.answerVerbosity);
    setLiveLatencyPreset(setup.latencyPreset);
    setAutoAnswerEnabled(false);
    autoAnswerEnabledRef.current = false;
    setDesktopStatus(`${setup.title} setup ready`);
    void window.callpilotDesktop?.saveSettings?.({
      activeMode: setup.mode,
      answerVerbosity: setup.answerVerbosity,
      liveLatencyPreset: setup.latencyPreset,
      liveAudioSource,
    });
  }, [liveAudioSource]);

  React.useEffect(() => {
    window.callpilotDesktop?.getStealthState()
      .then((state) => {
        setStealth(state);
        setDesktopStatus("Desktop bridge connected");
      })
      .catch(() => setDesktopStatus("Desktop bridge unavailable"));

    window.callpilotDesktop?.getSettings()
      .then((settings) => {
        setActiveMode(settings.activeMode);
        setPreferredLanguage(settings.preferredLanguage);
        setCodingLanguage(settings.defaultCodingLanguage);
        setAnswerVerbosity(settings.answerVerbosity);
        setModelProvider(settings.modelProvider);
        setModelName(settings.modelName);
        setOllamaBaseUrl(settings.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL);
        setTranscriptionModelName(settings.transcriptionModelName ?? DEFAULT_TRANSCRIPTION_MODEL);
        const savedProvider = settings.liveTranscriptionProvider === "natively"
          ? "deepgram"
          : settings.liveTranscriptionProvider ?? "deepgram";
        const savedAudioSource = settings.liveAudioSource ?? "both";
        const shouldUpgradeOldLiveDefaults = savedProvider === "browser" && savedAudioSource === "microphone";
        setLiveTranscriptionProvider(shouldUpgradeOldLiveDefaults ? "deepgram" : savedProvider);
        setLiveLatencyPreset(settings.liveLatencyPreset ?? "balanced");
        setLiveAudioSource(shouldUpgradeOldLiveDefaults ? "both" : savedAudioSource);
        setAutoAnswerCooldownMs(settings.autoAnswerCooldownMs ?? 12000);
        setAutoAnswerMinConfidence(settings.autoAnswerMinConfidence ?? 0.45);
      })
      .catch(() => {})
      .finally(() => setSettingsLoaded(true));

    window.callpilotDesktop?.getCredentialStatus()
      .then((status) => {
        applyCredentialStatus(status);
        setCredentialMessage(status.encryptionAvailable ? "Encrypted key storage ready" : "Encrypted key storage unavailable");
      })
      .catch(() => {})
      .finally(() => setCredentialStatusLoaded(true));

    window.callpilotDesktop?.getShortcutHealth()
      .then((health) => {
        const failed = health.filter((item) => !item.registered);
        setShortcutStatus(failed.length === 0 ? `${health.length} shortcuts registered` : `${failed.length} shortcuts failed`);
      })
      .catch(() => {});
  }, [applyCredentialStatus]);

  React.useEffect(() => {
    window.callpilotDesktop?.saveSettings({
      activeMode,
      preferredLanguage,
      defaultCodingLanguage: codingLanguage,
      answerVerbosity,
      modelProvider,
      modelName,
      ollamaBaseUrl,
      transcriptionModelName,
      liveTranscriptionProvider,
      liveLatencyPreset,
      liveAudioSource,
      autoAnswerCooldownMs,
      autoAnswerMinConfidence,
    }).catch(() => {});
  }, [activeMode, answerVerbosity, autoAnswerCooldownMs, autoAnswerMinConfidence, codingLanguage, liveAudioSource, liveLatencyPreset, liveTranscriptionProvider, modelName, modelProvider, ollamaBaseUrl, preferredLanguage, transcriptionModelName]);

  React.useEffect(() => {
    if (!hasOpenAITranscriptionKey && liveTranscriptionProvider === "openai_realtime") {
      setLiveTranscriptionProvider("deepgram");
      setLiveAssistStatus("OpenAI live chunks disabled because no OpenAI key is saved");
    }
  }, [hasOpenAITranscriptionKey, liveTranscriptionProvider]);

  React.useEffect(() => {
    if (liveTranscriptionProvider === "natively") {
      setLiveTranscriptionProvider("deepgram");
      setLiveAssistStatus("Natively STT is disabled; switched to Deepgram");
    }
  }, [liveTranscriptionProvider]);

  React.useEffect(() => {
    if (!hasDeepgramTranscriptionKey && liveTranscriptionProvider === "deepgram") {
      setLiveAssistStatus("Deepgram selected, but no Deepgram key is saved yet");
    }
  }, [hasDeepgramTranscriptionKey, liveTranscriptionProvider]);

  React.useEffect(() => () => {
    liveContinueRef.current = false;
    if (localSegmentTimerRef.current !== null) window.clearTimeout(localSegmentTimerRef.current);
    mediaRecorderRef.current?.stop();
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    localSegmentTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    liveRecordersRef.current.forEach((recorder) => {
      if (recorder.state === "recording") recorder.stop();
    });
    liveStreamsRef.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    localSttQueueByIdRef.current.clear();
    localSttBusyByIdRef.current.clear();
    liveChunkQueueByIdRef.current.clear();
    liveChunkBusyByIdRef.current.clear();
    liveRecorderRef.current?.stop();
    liveStreamRef.current?.getTracks().forEach((track) => track.stop());
    nativelySessionsRef.current.forEach((session) => {
      session.processor.disconnect();
      session.source.disconnect();
      void session.context.close().catch(() => {});
      void window.callpilotDesktop?.stopNativelyTranscription?.({ streamId: session.streamId });
    });
    nativelySessionsRef.current = [];
    deepgramSessionsRef.current.forEach((session) => {
      session.processor.disconnect();
      session.source.disconnect();
      void session.context.close().catch(() => {});
      void window.callpilotDesktop?.stopDeepgramTranscription?.({ streamId: session.streamId });
    });
    deepgramSessionsRef.current = [];
  }, []);

  React.useEffect(() => {
    const session = createSessionSnapshot({
      id: sessionIdentity.id,
      title: sessionIdentity.title,
      createdAt: sessionIdentity.createdAt,
      activeMode,
      companyName,
      roleTitle,
      resumeText,
      starStories,
      jobDescription,
      transcript,
      screenText,
      notes,
      profile,
      targetUseCase,
      preferredLanguage,
      codingLanguage,
      answerVerbosity,
      modelProvider,
      modelName,
      question,
      answer,
      codingPayload: currentCodingPayload,
    });
    window.localStorage.setItem(CURRENT_SESSION_KEY, JSON.stringify(session));
  }, [
    activeMode,
    answer,
    answerVerbosity,
    codingLanguage,
    companyName,
    currentCodingPayload,
    jobDescription,
    modelName,
    modelProvider,
    notes,
    preferredLanguage,
    profile,
    question,
    resumeText,
    roleTitle,
    screenText,
    sessionIdentity,
    starStories,
    targetUseCase,
    transcript,
  ]);

  const ask = React.useCallback(async (questionOverride?: string) => {
    if (isGeneratingRef.current || activeAnswerRequestIdRef.current) {
      setLiveAssistStatus("Already answering; repeated Answer press ignored");
      void window.callpilotDesktop?.recordSessionEvent?.("manual_answer_ignored", {
        reason: "answer_in_progress",
        activeRequestId: activeAnswerRequestIdRef.current,
      });
      void window.callpilotDesktop?.publishAnswerStatus?.({
        status: "busy",
        text: "Already answering. Wait for the current result or press Stop to cancel.",
        timestamp: Date.now(),
      });
      return;
    }
    const pendingTranscriptDrafts = flushTurnDrafts(turnAssemblerRef.current);
    const flushedTranscript = pendingTranscriptDrafts.length > 0
      ? (() => {
        const next = new TranscriptBuffer(context.transcript);
        const now = Date.now();
        for (const draft of pendingTranscriptDrafts) {
          const message = next.append(draft.text, "stt", now, draft.speaker);
          if (message) void window.callpilotDesktop?.publishTranscriptMessage?.(message);
        }
        return next.snapshot();
      })()
      : context.transcript;
    if (pendingTranscriptDrafts.length > 0) {
      setTranscript(flushedTranscript);
      void window.callpilotDesktop?.recordSessionEvent?.("stt_pending_drafts_flushed_for_answer", {
        count: pendingTranscriptDrafts.length,
        drafts: pendingTranscriptDrafts.map((draft) => ({
          speaker: draft.speaker,
          text: draft.text,
        })),
      });
    }
    const contextForAnswer = pendingTranscriptDrafts.length > 0
      ? { ...context, transcript: flushedTranscript, updatedAt: new Date().toISOString() }
      : context;
    const effectiveQuestion = questionOverride ?? question;
    const requestId = `answer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestStartedAt = Date.now();
    const emitAnswerTiming = (stage: string, payload: Record<string, unknown> = {}) => {
      void window.callpilotDesktop?.recordSessionEvent?.("answer_timing", {
        requestId,
        stage,
        elapsedMs: Date.now() - requestStartedAt,
        ...payload,
      });
    };
    activeAnswerRequestIdRef.current = requestId;
    // Manual/auto Answer overrides are point-in-time prompts. Persisting them as the reusable
    // question makes later follow-ups fall back to stale generated context when STT is quiet.
    setIsGenerating(true);
    isGeneratingRef.current = true;
    const latencyRun = createLatencyMetricRun("answer", requestStartedAt);
    activeLatencyRunIdRef.current = latencyRun.id;
    firstDetailChunkSeenRef.current = false;
    setLatencyRuns((current) => [...current, latencyRun].slice(-12));
    emitAnswerTiming("request_received", {
      provider: modelProvider,
      modelName,
      activeMode: contextForAnswer.activeMode,
      questionChars: effectiveQuestion.length,
      flushedTranscriptDrafts: pendingTranscriptDrafts.length,
    });
    void window.callpilotDesktop?.publishAnswerStatus?.({
      requestId,
      status: "busy",
      text: "Preparing interview context",
      timestamp: Date.now(),
    });
    emitAnswerTiming("context_snapshot_started");
    let builtPrompt = buildPrompt(contextForAnswer, effectiveQuestion);
    emitAnswerTiming("context_snapshot_completed", {
      promptChars: builtPrompt.debug.approximateChars,
      includedSections: builtPrompt.debug.includedSections.length,
    });
    try {
      void window.callpilotDesktop?.publishAnswerStatus?.({
        requestId,
        status: "busy",
        text: "Retrieving relevant background",
        timestamp: Date.now(),
      });
      emitAnswerTiming("evidence_lookup_started");
      const embedder = await getEvidenceEmbedder();
      const evidence = await pickEvidenceWithEmbeddings(contextForAnswer, effectiveQuestion, embedder, 4);
      builtPrompt = buildPromptWithEvidence(contextForAnswer, effectiveQuestion, evidence);
      emitAnswerTiming("evidence_lookup_completed", {
        selectedEvidenceCount: evidence.items.length,
        evidenceStrategy: evidence.debug.strategy,
        promptChars: builtPrompt.debug.approximateChars,
      });
    } catch {
      emitAnswerTiming("evidence_lookup_failed");
      builtPrompt = buildPrompt(contextForAnswer, effectiveQuestion);
    }
    setLastPrompt(builtPrompt);
    if (builtPrompt.debug.answerContextTrace) {
      void window.callpilotDesktop?.recordSessionEvent?.("answer_context_built", { ...builtPrompt.debug.answerContextTrace });
    }
    const liveSpokenOutput = contextForAnswer.activeMode !== "live_coding" && (modelProvider === "openai" || modelProvider === "nvidia");
    emitAnswerTiming("prompt_ready", {
      promptChars: builtPrompt.debug.approximateChars,
      liveSpokenOutput,
      structuredOutput: !liveSpokenOutput,
    });

    try {
      setLiveAssistStatus(`Answering with ${providerLabel}`);
      void window.callpilotDesktop?.publishAnswerStatus?.({
        requestId,
        status: "busy",
        text: `Calling ${providerLabel}`,
        timestamp: Date.now(),
      });
      if (modelProvider === "mock") {
        emitAnswerTiming("mock_answer_started");
        const text = formatMockAnswer(contextForAnswer, effectiveQuestion);
        setAnswer(text);
        void window.callpilotDesktop?.publishAnswerStatus?.({
          requestId,
          status: "completed",
          text,
          timestamp: Date.now(),
        });
        appendAssistantTranscriptLine(text, { publish: false });
        emitAnswerTiming("request_completed", { ok: true, mocked: true, textChars: text.length });
        return;
      }

      if (!window.callpilotDesktop?.generateAnswer) {
        emitAnswerTiming("model_call_skipped", { reason: "desktop_generation_unavailable" });
        const text = "Desktop generation requires the desktop app so provider calls stay outside the browser sandbox.";
        setAnswer(text);
        void window.callpilotDesktop?.publishAnswerStatus?.({
          requestId,
          status: "failed",
          text,
          error: "desktop_generation_unavailable",
          timestamp: Date.now(),
        });
        appendAssistantTranscriptLine(text, { publish: false });
        return;
      }

      const liveMaxTokens = contextForAnswer.activeMode === "live_coding" ? 450 : 320;
      const liveTimeoutMs = contextForAnswer.activeMode === "live_coding" ? 45000 : 35000;
      if (liveSpokenOutput) setAnswer("");
      setLatencyRuns((current) => current.map((run) =>
        run.id === latencyRun.id ? markLatencyStage(run, "model_call_start") : run,
      ));
      emitAnswerTiming("model_call_started", {
        maxTokens: liveSpokenOutput ? liveMaxTokens : contextForAnswer.activeMode === "live_coding" ? 1200 : 700,
        timeoutMs: liveSpokenOutput ? liveTimeoutMs : contextForAnswer.activeMode === "live_coding" ? 120000 : 90000,
      });
      let result = await window.callpilotDesktop.generateAnswer({
        provider: modelProvider,
        modelName,
        requestId,
        structuredOutput: !liveSpokenOutput,
        liveSpokenOutput,
        prompt: builtPrompt,
        apiKey: sessionApiKey,
        nativelyApiKey,
        nvidiaApiKey,
        ollamaBaseUrl,
        maxTokens: liveSpokenOutput ? liveMaxTokens : contextForAnswer.activeMode === "live_coding" ? 1200 : 700,
        timeoutMs: liveSpokenOutput ? liveTimeoutMs : contextForAnswer.activeMode === "live_coding" ? 120000 : 90000,
      });
      emitAnswerTiming("model_call_completed", {
        ok: result.ok,
        cancelled: Boolean(result.cancelled),
        error: result.error,
        textChars: result.text.length,
      });
      void window.callpilotDesktop?.publishAnswerStatus?.({
        requestId,
        status: "busy",
        text: "Formatting answer",
        timestamp: Date.now(),
      });
      emitAnswerTiming("format_started");
      let parsedStructured = result.ok ? parseStructuredAnswerPayload(result.text) : null;
      if (result.ok && contextForAnswer.activeMode === "live_coding" && liveSpokenOutput) {
        emitAnswerTiming("live_coding_structured_code_started");
        const structuredResult = await window.callpilotDesktop.generateAnswer({
          provider: modelProvider,
          modelName,
          requestId,
          structuredOutput: true,
          liveSpokenOutput: false,
          prompt: builtPrompt,
          apiKey: sessionApiKey,
          nativelyApiKey,
          nvidiaApiKey,
          ollamaBaseUrl,
          maxTokens: 1200,
          timeoutMs: 120000,
        });
        emitAnswerTiming("live_coding_structured_code_completed", {
          ok: structuredResult.ok,
          cancelled: Boolean(structuredResult.cancelled),
          error: structuredResult.error,
          textChars: structuredResult.text.length,
        });
        const structuredPayload = structuredResult.ok ? parseStructuredAnswerPayload(structuredResult.text) : null;
        if (structuredPayload?.kind === "coding") {
          result = structuredResult;
          parsedStructured = structuredPayload;
        } else {
          emitAnswerTiming("live_coding_structured_code_unavailable", {
            ok: structuredResult.ok,
            parsedStructured: Boolean(structuredPayload),
            structuredKind: structuredPayload?.kind,
          });
        }
      }
      if (
        result.ok
        && contextForAnswer.activeMode === "live_coding"
        && shouldRetryLiveCodingCompleteness(parsedStructured, builtPrompt.user, result.text)
      ) {
        emitAnswerTiming("live_coding_completeness_retry_started");
        const retryPrompt = buildLiveCodingCompletenessRetryPrompt(builtPrompt);
        const retryResult = await window.callpilotDesktop.generateAnswer({
          provider: modelProvider,
          modelName,
          requestId,
          structuredOutput: true,
          liveSpokenOutput: false,
          prompt: retryPrompt,
          apiKey: sessionApiKey,
          nativelyApiKey,
          nvidiaApiKey,
          ollamaBaseUrl,
          maxTokens: 1200,
          timeoutMs: 120000,
        });
        emitAnswerTiming("live_coding_completeness_retry_completed", {
          ok: retryResult.ok,
          cancelled: Boolean(retryResult.cancelled),
          error: retryResult.error,
          textChars: retryResult.text.length,
        });
        if (retryResult.ok) {
          result = retryResult;
          parsedStructured = parseStructuredAnswerPayload(result.text);
        }
      }
      if (
        result.ok
        && contextForAnswer.activeMode === "live_coding"
        && violatesVisibleCodeContinuity(parsedStructured, builtPrompt.user)
      ) {
        const error = "El modelo cambió la firma Python visible después del reintento.";
        emitAnswerTiming("live_coding_visible_code_continuity_failed", {
          parsedStructured: Boolean(parsedStructured),
        });
        void window.callpilotDesktop?.recordSessionEvent?.("answer_grounding_decision", {
          requestId,
          ok: false,
          reason: "visible_code_continuity_failed",
          overlapCount: 0,
          unsupportedTerms: [],
        });
        result = {
          ...result,
          ok: false,
          text: "",
          error,
        };
        parsedStructured = null;
      }
      emitAnswerTiming("parse_completed", {
        parsedStructured: Boolean(parsedStructured),
        structuredKind: parsedStructured?.kind,
      });
      const grounding = parsedStructured ? assessAnswerGrounding(contextForAnswer, effectiveQuestion, parsedStructured) : null;
      if (grounding) {
        void window.callpilotDesktop?.recordSessionEvent?.("answer_grounding_decision", {
          requestId,
          ok: grounding.ok,
          reason: grounding.reason,
          overlapCount: grounding.overlapCount,
          unsupportedTerms: grounding.unsupportedTerms,
        });
      }
      let structured = parsedStructured && grounding
        ? withNoAnswerForUngroundedDrift(parsedStructured, grounding)
        : parsedStructured;
      let text = result.ok
        ? formatAnswerForDisplay(result.text, structured, {
          mode: contextForAnswer.activeMode === "live_coding" ? "coding" : "interview",
        })
        : `Generation failed: ${result.error ?? "unknown error"}`;
      if (result.ok && liveSpokenOutput) {
        const compacted = compactLiveSpokenAnswer(text, {
          mode: contextForAnswer.activeMode,
          userInput: effectiveQuestion,
        });
        if (compacted.compacted) {
          text = compacted.text;
          emitAnswerTiming("live_spoken_compacted", {
            originalWords: compacted.originalWords,
            finalWords: compacted.finalWords,
          });
        }
      }
      if (result.ok) {
        const repaired = repairLiveCodingAnswerCoverage(text, effectiveQuestion, contextForAnswer.activeMode);
        if (repaired !== text) {
          text = repaired;
          emitAnswerTiming("live_coding_repaired", { textChars: text.length });
        }
      }
      if (result.ok && !parsedStructured && contextForAnswer.activeMode !== "live_coding") {
        const plainGrounding = assessPlainInterviewAnswerGrounding(contextForAnswer, effectiveQuestion, text);
        void window.callpilotDesktop?.recordSessionEvent?.("answer_grounding_decision", {
          requestId,
          ok: plainGrounding.ok,
          reason: plainGrounding.reason,
          overlapCount: plainGrounding.overlapCount,
          unsupportedTerms: plainGrounding.unsupportedTerms,
          source: "plain_text",
        });
        if (!plainGrounding.ok) {
          structured = withNoAnswerForUngroundedDrift({
            kind: "interview",
            payload: {
              version: "1",
              answerNeeded: true,
              intent: contextForAnswer.activeMode === "behavioral" ? "behavioral" : "technical_qa",
              spokenAnswer: text,
              keyPoints: [],
              correction: { needed: false, transition: null, correctedClaim: null },
              assumptions: [],
              evidenceRefs: [],
              followUpHint: null,
            },
          }, plainGrounding);
          text = formatAnswerForDisplay(text, structured, { mode: "interview" });
        }
      }
      emitAnswerTiming("grounding_completed", {
        checked: Boolean(grounding) || (result.ok && !parsedStructured && contextForAnswer.activeMode !== "live_coding"),
        structured: Boolean(structured),
      });
      emitAnswerTiming("format_completed", {
        ok: result.ok,
        textChars: text.length,
      });
      if (activeAnswerRequestIdRef.current === requestId) {
        setAnswer(text);
        if (result.ok && structured) {
          if (structured.kind === "coding") {
            setCurrentCodingPayload(structured.payload);
          }
          void window.callpilotDesktop.publishStructuredAnswer?.({
            requestId,
            answer: structured,
            renderedText: text,
            timestamp: Date.now(),
          });
          void window.callpilotDesktop.publishAnswerStatus?.({
            requestId,
            status: "completed",
            text,
            timestamp: Date.now(),
          });
        } else {
          void window.callpilotDesktop.publishAnswerStatus?.({
            requestId,
            status: result.cancelled ? "cancelled" : result.ok ? "completed" : "failed",
            text,
            error: result.error,
            timestamp: Date.now(),
          });
        }
        if (result.ok) appendAssistantTranscriptLine(text, { publish: false });
        emitAnswerTiming("publish_completed", {
          status: result.cancelled ? "cancelled" : result.ok ? "completed" : "failed",
          textChars: text.length,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "answer_generation_failed";
      const text = `Generation failed: ${message}`;
      emitAnswerTiming("request_failed", { error: message });
      if (activeAnswerRequestIdRef.current === requestId) {
        setAnswer(text);
        void window.callpilotDesktop?.recordSessionEvent?.("answer_render_failed", {
          requestId,
          error: message,
        });
        void window.callpilotDesktop?.publishAnswerStatus?.({
          requestId,
          status: "failed",
          text,
          error: message,
          timestamp: Date.now(),
        });
      }
    } finally {
      emitAnswerTiming("request_completed", {
        activeRequest: activeAnswerRequestIdRef.current === requestId,
      });
      const activeRunId = activeLatencyRunIdRef.current;
      if (activeRunId) {
        setLatencyRuns((current) => current.map((run) =>
          run.id === activeRunId ? markLatencyStage(run, "response_complete") : run,
        ));
      }
      if (activeAnswerRequestIdRef.current === requestId) {
        activeAnswerRequestIdRef.current = null;
        setIsGenerating(false);
        isGeneratingRef.current = false;
      }
    }
  }, [appendAssistantTranscriptLine, context, modelName, modelProvider, nativelyApiKey, nvidiaApiKey, ollamaBaseUrl, providerLabel, question, sessionApiKey]);

  const cancelAnswer = React.useCallback(async () => {
    const requestId = activeAnswerRequestIdRef.current;
    if (!requestId) return;
    activeAnswerRequestIdRef.current = null;
    isGeneratingRef.current = false;
    setIsGenerating(false);
    setLiveAssistStatus("Answer cancelled");
    void window.callpilotDesktop?.recordSessionEvent?.("manual_answer_cancel_requested", { requestId });
    await window.callpilotDesktop?.cancelAnswer?.(requestId).catch(() => undefined);
  }, []);

  const warmAnswerModel = React.useCallback(async (options: { silent?: boolean; reason?: "startup" | "manual" } = {}) => {
    if (modelProvider === "mock" || !window.callpilotDesktop?.generateAnswer) return;
    const warmPrompt = buildPrompt(context, "warmup: responde solo OK");
    const requestId = `warmup-${options.reason ?? "manual"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    try {
      if (!options.silent) setLiveAssistStatus(`Warming ${providerLabel}`);
      setAnswerWarmupHealth({
        status: "warming",
        label: `${providerLabel} warming`,
        detail: modelName ? modelName : "Default model",
        updatedAt: startedAt,
      });
      const result = await window.callpilotDesktop.generateAnswer({
        provider: modelProvider,
        modelName,
        requestId,
        structuredOutput: false,
        prompt: warmPrompt,
        apiKey: sessionApiKey,
        nativelyApiKey,
        nvidiaApiKey,
        ollamaBaseUrl,
        maxTokens: 24,
        timeoutMs: 90000,
      });
      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      setAnswerWarmupHealth({
        status: result.ok ? "ready" : "failed",
        label: result.ok ? `${providerLabel} ready` : `${providerLabel} warmup failed`,
        detail: result.ok ? `Warm in ${elapsedSeconds}s` : result.error ?? "Unknown warmup error",
        updatedAt: Date.now(),
      });
      if (!options.silent) setLiveAssistStatus(result.ok ? "Listening" : `Warmup skipped: ${result.error ?? "unknown"}`);
      return result.ok;
    } catch {
      setAnswerWarmupHealth({
        status: "failed",
        label: `${providerLabel} warmup failed`,
        detail: "Warmup request failed before completion",
        updatedAt: Date.now(),
      });
      if (!options.silent) setLiveAssistStatus("Listening");
      return false;
    }
  }, [context, modelName, modelProvider, nativelyApiKey, nvidiaApiKey, ollamaBaseUrl, providerLabel, sessionApiKey]);

  React.useEffect(() => {
    if (!settingsLoaded || !credentialStatusLoaded) {
      setAnswerWarmupHealth({
        status: "checking",
        label: "Provider checking",
        detail: "Loading settings and credentials",
        updatedAt: Date.now(),
      });
      return;
    }
    if (modelProvider === "mock" || modelProvider === "ollama") {
      warmedAnswerModelKeyRef.current = selectedAnswerModelKey;
      setAnswerWarmupHealth({
        status: "ready",
        label: `${providerLabel} ready`,
        detail: modelProvider === "mock" ? "Demo provider does not need warmup" : "Local provider does not need remote warmup",
        updatedAt: Date.now(),
      });
      return;
    }
    const hasProviderKey = modelProvider === "nvidia"
      ? hasNvidiaAnswerKey
      : modelProvider === "natively"
        ? hasStoredNativelyKey || hasEnvNativelyKey || Boolean(nativelyApiKey.trim())
        : hasOpenAITranscriptionKey;
    if (!hasProviderKey) {
      setAnswerWarmupHealth({
        status: "unavailable",
        label: `${providerLabel} key missing`,
        detail: "Save or load the provider key before starting",
        updatedAt: Date.now(),
      });
      return;
    }

    const warmupKey = selectedAnswerModelKey;
    if (warmedAnswerModelKeyRef.current === warmupKey || warmingAnswerModelKeyRef.current === warmupKey) return;
    warmingAnswerModelKeyRef.current = warmupKey;
    setAnswerWarmupHealth({
      status: "warming",
      label: `${providerLabel} warming`,
      detail: modelName ? modelName : "Default model",
      updatedAt: Date.now(),
    });
    const timer = window.setTimeout(() => {
      void warmAnswerModel({ silent: true, reason: "startup" })
        .then((ok) => {
          if (ok) warmedAnswerModelKeyRef.current = warmupKey;
        })
        .finally(() => {
          if (warmingAnswerModelKeyRef.current === warmupKey) warmingAnswerModelKeyRef.current = "";
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      if (warmingAnswerModelKeyRef.current === warmupKey) warmingAnswerModelKeyRef.current = "";
    };
  }, [
    credentialStatusLoaded,
    hasEnvNativelyKey,
    hasEnvNvidiaKey,
    hasOpenAITranscriptionKey,
    hasNvidiaAnswerKey,
    hasStoredNativelyKey,
    hasStoredNvidiaKey,
    modelName,
    modelProvider,
    nativelyApiKey,
    providerLabel,
    selectedAnswerModelKey,
    settingsLoaded,
    warmAnswerModel,
  ]);

  const liveCodingTranscriptCutoff = React.useCallback(() => {
    if (activeMode !== "live_coding") return undefined;
    if (!screenText.trim()) return undefined;
    if (typeof screenContext.capturedAt !== "number") return undefined;
    return Math.max(0, screenContext.capturedAt - 3 * 60 * 1000);
  }, [activeMode, screenContext.capturedAt, screenContext.kind, screenText]);

  const getLatestInterviewPrompt = React.useCallback(() => {
    const liveInterviewerText = turnAssemblerRef.current.draftsBySpeaker.interviewer?.text.trim();
    const minTimestamp = liveCodingTranscriptCutoff();
    const conversationWindow = formatConversationWindow(transcriptRef.current, liveInterviewerText, 10, { minTimestamp });
    const focusedQuestion = extractLatestQuestionFocus(conversationWindow);
    if (focusedQuestion && focusedQuestion !== conversationWindow) return `interviewer: ${focusedQuestion}`;
    if (conversationWindow) return conversationWindow;
    if (liveInterviewerText) return `interviewer_partial: ${liveInterviewerText}`;
    const lastInterviewerTurn = [...transcriptRef.current.messages]
      .reverse()
      .find((message) => message.speaker === "interviewer" && (typeof minTimestamp !== "number" || message.timestamp >= minTimestamp));
    return lastInterviewerTurn?.text.trim() ? `interviewer: ${lastInterviewerTurn.text.trim()}` : question.trim();
  }, [liveCodingTranscriptCutoff, question]);

  const getManualAnswerPrompt = React.useCallback(() => {
    const latestPrompt = getLatestInterviewPrompt().trim();
    const screen = screenText.trim();
    if (latestPrompt) {
      if (activeMode === "live_coding" && screen) {
        return [
          latestPrompt,
          `visible_screen: ${screen.slice(-1800)}`,
          currentCodingPayload?.solution.code.trim()
            ? [
              "current_live_coding_solution:",
              `title: ${currentCodingPayload.problem.title}`,
              `language: ${currentCodingPayload.problem.language}`,
              "code:",
              currentCodingPayload.solution.code,
            ].join("\n")
            : "",
          "task: Use the latest transcript together with the visible coding context to provide the next useful live-coding answer. If no one explicitly asked to write code or tests, explain the optimal approach, invariant, and complexity without code.",
          currentCodingPayload?.solution.code.trim()
            ? "follow_up_rule: If the latest interviewer request changes requirements, updates tests, reports a bug, or asks for another case, update the full current solution.code without dropping previous valid logic."
            : "",
        ].join("\n");
      }
      return latestPrompt;
    }

    const notesText = notes.trim();
    const fallbackLines = [
      "user_request: The candidate pressed Answer. There may not be a clean question mark in the transcript.",
      activeMode === "live_coding"
        ? "task: Use the latest transcript and visible coding context to provide the next useful coding help, solution, explanation, or correction."
        : "task: Use the latest transcript and interview context to provide the next useful thing to say, or a brief clarification if no answer is needed.",
      screen ? `visible_screen: ${screen.slice(-1800)}` : "",
      activeMode === "live_coding" && currentCodingPayload?.solution.code.trim()
        ? [
          "current_live_coding_solution:",
          `title: ${currentCodingPayload.problem.title}`,
          `language: ${currentCodingPayload.problem.language}`,
          "code:",
          currentCodingPayload.solution.code,
          "follow_up_rule: Preserve the working parts of this solution and return the complete updated solution.code.",
        ].join("\n")
        : "",
      notesText ? `notes: ${notesText.slice(-1200)}` : "",
    ];
    return fallbackLines.filter(Boolean).join("\n");
  }, [activeMode, currentCodingPayload, getLatestInterviewPrompt, notes, screenText]);

  const submitFollowUpChange = React.useCallback(() => {
    const changeRequest = followUpChange.trim();
    if (!changeRequest || activeMode !== "live_coding" || !currentCodingPayload?.solution.code.trim()) return;
    const prompt = buildLiveCodingFollowUpPrompt({
      changeRequest,
      currentSolution: currentCodingPayload,
      problemContext: getManualAnswerPrompt(),
    });
    setFollowUpChange("");
    void ask(prompt);
  }, [activeMode, ask, currentCodingPayload, followUpChange, getManualAnswerPrompt]);

  const clearContext = React.useCallback(() => {
    const next = new TranscriptBuffer(transcript);
    setTranscript(next.clear());
    updateScreenContext("");
    setNotes("");
    setCompanyName("");
    setRoleTitle("");
    setResumeText("");
    setStarStories("");
    setJobDescription("");
    setProfile("");
    setQuestion("");
    setAnswer("");
    setFollowUpChange("");
    setCurrentCodingPayload(null);
    setTranscriptDraft("");
    window.localStorage.removeItem(CURRENT_SESSION_KEY);
  }, [transcript]);

  const resetSessionRuntimeContext = React.useCallback(() => {
    const now = Date.now();
    const emptyTranscript = new TranscriptBuffer().snapshot();
    setSessionIdentity({ id: `session-${now}`, title: undefined, createdAt: new Date(now).toISOString() });
    setTranscript(emptyTranscript);
    transcriptRef.current = emptyTranscript;
    setScreenText("");
    setScreenContext(classifyScreenText(""));
    setProfile("");
    setQuestion("");
    setAnswer("");
    setFollowUpChange("");
    setCurrentCodingPayload(null);
    setTranscriptDraft("");
    setLatencyRuns([]);
    activeLatencyRunIdRef.current = null;
    activeAnswerRequestIdRef.current = null;
    firstDetailChunkSeenRef.current = false;
    recentSpeechRef.current = [];
    recentPublishedTranscriptRef.current = { speaker: "unknown", text: "", timestamp: 0 };
    lastNativelyPartialAnswerRef.current = { text: "", timestamp: 0 };
    nativelyPartialStabilityRef.current = {};
    turnAssemblerRef.current = createTurnAssemblerState();
    setIsGenerating(false);
    isGeneratingRef.current = false;
    window.localStorage.removeItem(CURRENT_SESSION_KEY);
  }, []);

  const resetLiveCodingExercise = React.useCallback(() => {
    const emptyTranscript = new TranscriptBuffer().snapshot();
    setTranscript(emptyTranscript);
    transcriptRef.current = emptyTranscript;
    setScreenText("");
    setScreenContext(classifyScreenText(""));
    setQuestion("");
    setAnswer("");
    setFollowUpChange("");
    setCurrentCodingPayload(null);
    setTranscriptDraft("");
    setLatencyRuns([]);
    activeLatencyRunIdRef.current = null;
    activeAnswerRequestIdRef.current = null;
    firstDetailChunkSeenRef.current = false;
    turnAssemblerRef.current = createTurnAssemblerState();
    setIsGenerating(false);
    isGeneratingRef.current = false;
    const emptyCodingPayload = createEmptyCodingPayload();
    void window.callpilotDesktop?.publishStructuredAnswer?.({
      requestId: `reset-${Date.now()}`,
      answer: { kind: "coding", payload: emptyCodingPayload },
      renderedText: "",
      timestamp: Date.now(),
    });
    window.localStorage.removeItem(CURRENT_SESSION_KEY);
    setLiveAssistStatus("New coding exercise ready");
  }, []);

  const resetFullSession = React.useCallback(() => {
    resetSessionRuntimeContext();
    setNotes("");
    setCompanyName("");
    setRoleTitle("");
    setResumeText("");
    setStarStories("");
    setJobDescription("");
    setProfile("");
    setLiveAssistStatus("New session ready");
    setSessionMessage("New session started with a clean slate");
  }, [resetSessionRuntimeContext]);

  const handleFinalTranscript = React.useCallback((text: string, source: "manual" | "stt" = "stt", speaker: TranscriptSpeaker = "interviewer") => {
    const normalized = normalizeTechnicalTranscript(text).trim();
    if (!normalized) return;
    const now = Date.now();
    recentSpeechRef.current = pruneRecentSpeech(recentSpeechRef.current, now);
    if (source === "stt" && speaker === "candidate" && shouldDropCandidateEcho(normalized, recentSpeechRef.current, now)) {
      setDesktopStatus("Ignored microphone echo from meeting audio");
      setLiveAssistStatus("Listening");
      return;
    }
    appendTranscriptLine(normalized, source, speaker);
    if (source === "stt") {
      recentSpeechRef.current = pruneRecentSpeech([
        ...recentSpeechRef.current,
        { text: normalized, speaker, timestamp: now },
      ], now);
    }
    if (speaker === "candidate" || speaker === "assistant") {
      setLiveAssistStatus("Listening");
      return;
    }
    const detection = detectQuestionIntent(normalized, preferredLanguage);
    void window.callpilotDesktop?.recordSessionEvent?.("autoanswer_decision", {
      source,
      speaker,
      autoAnswerEnabled: autoAnswerEnabledRef.current,
      detection,
      cooldownMs: liveSettings.autoAnswerCooldownMs,
      minConfidence: liveSettings.autoAnswerMinConfidence,
    });
    if (!autoAnswerEnabledRef.current) {
      setLiveAssistStatus(detection.shouldDispatch ? `Turn ready (${detection.reason})` : "Listening");
      return;
    }
    if (shouldAutoAnswer(detection, now, lastAutoAnsweredAtRef.current, liveSettings.autoAnswerCooldownMs, liveSettings.autoAnswerMinConfidence)) {
      lastAutoAnsweredAtRef.current = now;
      setLiveAssistStatus(`Auto answering (${detection.reason})`);
      void ask(detection.normalizedText);
      return;
    }
    setLiveAssistStatus(detection.shouldDispatch ? "Turn ready, cooldown active" : "Listening");
  }, [appendTranscriptLine, ask, autoAnswerEnabled, liveSettings.autoAnswerCooldownMs, liveSettings.autoAnswerMinConfidence, preferredLanguage]);

  React.useEffect(() => {
    const unsubscribeTranscript = window.callpilotDesktop?.onNativelyTranscript?.((payload) => {
      const speaker: TranscriptSpeaker = payload.streamId.startsWith("mic-") ? "candidate" : "interviewer";
      const normalized = stripKnownTranscriptHistory(normalizeTechnicalTranscript(payload.text), speaker);
      if (!normalized) return;
      const assembled = assembleTurn(turnAssemblerRef.current, {
        speaker,
        text: normalized,
        isFinal: payload.isFinal,
        timestamp: Date.now(),
      });
      if (assembled.action === "ignore") {
        if (assembled.reason === "short_final_fragment") {
          void window.callpilotDesktop?.recordSessionEvent?.("stt_short_final_ignored", {
            provider: "natively",
            streamId: payload.streamId,
            speaker,
            text: assembled.text,
          });
        }
        return;
      }
      if (assembled.action === "publish_live") {
        const liveText = assembled.text;
        setDesktopStatus(`Natively partial: ${liveText.slice(0, 80)}`);
        void window.callpilotDesktop?.publishLiveTranscript?.({
          id: `live-${payload.streamId}`,
          speaker,
          text: liveText,
          timestamp: Date.now(),
        });
        if (speaker === "interviewer" && autoAnswerEnabledRef.current) {
          const now = Date.now();
          const previousPartial = nativelyPartialStabilityRef.current[payload.streamId] ?? { text: "", timestamp: 0 };
          const stability = assessPartialTurnStability(liveText, previousPartial.text, previousPartial.timestamp, now);
          nativelyPartialStabilityRef.current[payload.streamId] = { text: liveText, timestamp: now };
          const detection = detectQuestionIntent(liveText, preferredLanguage);
          const previous = lastNativelyPartialAnswerRef.current;
          const isNewEnough = speechSimilarity(previous.text, detection.normalizedText) < 0.82 || now - previous.timestamp > 8000;
          void window.callpilotDesktop?.recordSessionEvent?.("autoanswer_partial_decision", {
            provider: "natively",
            streamId: payload.streamId,
            speaker,
            stability,
            detection,
            isNewEnough,
            cooldownMs: liveSettings.autoAnswerCooldownMs,
            minConfidence: liveSettings.autoAnswerMinConfidence,
          });
          if (
            stability.stable
            && isNewEnough
            && shouldAutoAnswer(detection, now, lastAutoAnsweredAtRef.current, liveSettings.autoAnswerCooldownMs, liveSettings.autoAnswerMinConfidence)
          ) {
            lastAutoAnsweredAtRef.current = now;
            lastNativelyPartialAnswerRef.current = { text: detection.normalizedText, timestamp: now };
            setLiveAssistStatus(`Auto answering stable partial (${detection.reason})`);
            void ask(detection.normalizedText);
          } else if (detection.shouldDispatch) {
            setLiveAssistStatus(`Transcribing (${stability.reason})`);
          }
        }
        return;
      }
      delete nativelyPartialStabilityRef.current[payload.streamId];
      if (assembled.action === "fold_final") {
        void window.callpilotDesktop?.publishLiveTranscript?.({
          id: `live-${payload.streamId}`,
          speaker,
          text: assembled.draftText,
          timestamp: Date.now(),
        });
        void window.callpilotDesktop?.recordSessionEvent?.("stt_final_fragment_folded", {
          provider: "natively",
          streamId: payload.streamId,
          speaker,
          text: assembled.text,
          draftText: assembled.draftText,
        });
        setDesktopStatus("STT final fragment folded and published to live draft");
        return;
      }
      handleFinalTranscript(assembled.text, "stt", speaker);
      setDesktopStatus("Natively STT transcribed audio");
    });
    const unsubscribeStatus = window.callpilotDesktop?.onNativelyStatus?.((payload) => {
      if (payload.detail) setDesktopStatus(payload.detail);
    });
    return () => {
      unsubscribeTranscript?.();
      unsubscribeStatus?.();
    };
  }, [ask, handleFinalTranscript, liveSettings.autoAnswerCooldownMs, liveSettings.autoAnswerMinConfidence, preferredLanguage]);

  React.useEffect(() => {
    const unsubscribeTranscript = window.callpilotDesktop?.onDeepgramTranscript?.((payload) => {
      const speaker: TranscriptSpeaker = payload.streamId.startsWith("mic-") ? "candidate" : "interviewer";
      const normalized = stripKnownTranscriptHistory(normalizeTechnicalTranscript(payload.text), speaker);
      if (!normalized) return;
      const assembled = assembleTurn(turnAssemblerRef.current, {
        speaker,
        text: normalized,
        isFinal: payload.isFinal,
        timestamp: Date.now(),
      });
      if (assembled.action === "ignore") {
        if (assembled.reason === "short_final_fragment") {
          void window.callpilotDesktop?.recordSessionEvent?.("stt_short_final_ignored", {
            provider: "deepgram",
            streamId: payload.streamId,
            speaker,
            text: assembled.text,
          });
        }
        return;
      }
      if (assembled.action === "publish_live") {
        const liveText = assembled.text;
        setDesktopStatus(`Deepgram partial: ${liveText.slice(0, 80)}`);
        void window.callpilotDesktop?.publishLiveTranscript?.({
          id: `live-${payload.streamId}`,
          speaker,
          text: liveText,
          timestamp: Date.now(),
        });
        if (speaker === "interviewer" && autoAnswerEnabledRef.current) {
          const now = Date.now();
          const previousPartial = nativelyPartialStabilityRef.current[payload.streamId] ?? { text: "", timestamp: 0 };
          const stability = assessPartialTurnStability(liveText, previousPartial.text, previousPartial.timestamp, now);
          nativelyPartialStabilityRef.current[payload.streamId] = { text: liveText, timestamp: now };
          const detection = detectQuestionIntent(liveText, preferredLanguage);
          const previous = lastNativelyPartialAnswerRef.current;
          const isNewEnough = speechSimilarity(previous.text, detection.normalizedText) < 0.82 || now - previous.timestamp > 8000;
          void window.callpilotDesktop?.recordSessionEvent?.("autoanswer_partial_decision", {
            provider: "deepgram",
            streamId: payload.streamId,
            speaker,
            stability,
            detection,
            isNewEnough,
            cooldownMs: liveSettings.autoAnswerCooldownMs,
            minConfidence: liveSettings.autoAnswerMinConfidence,
          });
          if (
            stability.stable
            && isNewEnough
            && shouldAutoAnswer(detection, now, lastAutoAnsweredAtRef.current, liveSettings.autoAnswerCooldownMs, liveSettings.autoAnswerMinConfidence)
          ) {
            lastAutoAnsweredAtRef.current = now;
            lastNativelyPartialAnswerRef.current = { text: detection.normalizedText, timestamp: now };
            setLiveAssistStatus(`Auto answering stable partial (${detection.reason})`);
            void ask(detection.normalizedText);
          } else if (detection.shouldDispatch) {
            setLiveAssistStatus(`Transcribing (${stability.reason})`);
          }
        }
        return;
      }
      delete nativelyPartialStabilityRef.current[payload.streamId];
      if (assembled.action === "fold_final") {
        void window.callpilotDesktop?.publishLiveTranscript?.({
          id: `live-${payload.streamId}`,
          speaker,
          text: assembled.draftText,
          timestamp: Date.now(),
        });
        void window.callpilotDesktop?.recordSessionEvent?.("stt_final_fragment_folded", {
          provider: "deepgram",
          streamId: payload.streamId,
          speaker,
          text: assembled.text,
          draftText: assembled.draftText,
        });
        setDesktopStatus("Deepgram final fragment folded and published to live draft");
        return;
      }
      handleFinalTranscript(assembled.text, "stt", speaker);
      setDesktopStatus("Deepgram transcribed audio");
    });
    const unsubscribeStatus = window.callpilotDesktop?.onDeepgramStatus?.((payload) => {
      if (payload.detail) setDesktopStatus(payload.detail);
    });
    return () => {
      unsubscribeTranscript?.();
      unsubscribeStatus?.();
    };
  }, [ask, handleFinalTranscript, liveSettings.autoAnswerCooldownMs, liveSettings.autoAnswerMinConfidence, preferredLanguage]);

  const stopLiveRecording = React.useCallback(() => {
    liveContinueRef.current = false;
    if (localSegmentTimerRef.current !== null) {
      window.clearTimeout(localSegmentTimerRef.current);
      localSegmentTimerRef.current = null;
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    localSegmentTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    localSegmentTimersRef.current = [];
    liveRecordersRef.current.forEach((recorder) => {
      if (recorder.state === "recording") recorder.stop();
    });
    liveRecordersRef.current = [];
    liveStreamsRef.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    liveStreamsRef.current = [];
    liveRecorderRef.current?.stop();
    liveRecorderRef.current = null;
    liveStreamRef.current?.getTracks().forEach((track) => track.stop());
    liveStreamRef.current = null;
    localSegmentChunksRef.current = [];
    turnAssemblerRef.current = createTurnAssemblerState();
    nativelyPartialStabilityRef.current = {};
    nativelySessionsRef.current.forEach((session) => {
      session.processor.disconnect();
      session.source.disconnect();
      void session.context.close().catch(() => {});
      void window.callpilotDesktop?.stopNativelyTranscription?.({ streamId: session.streamId });
    });
    nativelySessionsRef.current = [];
    deepgramSessionsRef.current.forEach((session) => {
      session.processor.disconnect();
      session.source.disconnect();
      void session.context.close().catch(() => {});
      void window.callpilotDesktop?.stopDeepgramTranscription?.({ streamId: session.streamId });
    });
    deepgramSessionsRef.current = [];
    setIsDictating(false);
    setLiveAssistStatus("Live assist idle");
  }, []);

  React.useEffect(() => {
    const unsubscribe = window.callpilotDesktop?.onSessionEnded?.(() => {
      stopLiveRecording();
      setDesktopStatus("Overlay session ended; live transcription stopped");
    });
    return () => unsubscribe?.();
  }, [stopLiveRecording]);

  React.useEffect(() => {
    if (!isDictating) return;
    stopLiveRecording();
    setLiveAssistStatus("Listening stopped after audio setup changed");
    setDesktopStatus("Audio setup changed; start the overlay again to use the new source");
  }, [liveAudioSource, liveTranscriptionProvider]);

  const liveChunkMs = () => {
    if (liveLatencyPreset === "fast") return 4500;
    if (liveLatencyPreset === "accurate") return 9000;
    return 6500;
  };

  const requestMicrophoneStream = async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("microphone_capture_unavailable");
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  };

  const requestSystemAudioStream = async () => {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("system_audio_capture_unavailable");
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: {
          width: 1,
          height: 1,
          frameRate: 1,
        },
      });
      const audioTracks = displayStream.getAudioTracks();
      if (audioTracks.length === 0) {
        displayStream.getTracks().forEach((track) => track.stop());
        throw new Error("system_audio_not_shared");
      }
      audioTracks.forEach((track) => {
        track.onmute = () => setDesktopStatus("Computer audio track is muted by the capture source");
        track.onended = () => setDesktopStatus("Computer audio capture ended");
      });
      setDesktopStatus(`Computer audio capture ready (${audioTracks.length} audio track${audioTracks.length === 1 ? "" : "s"})`);
      return displayStream;
  };

  const requestLiveAudioStreams = async (): Promise<Array<{ stream: MediaStream; speaker: TranscriptSpeaker; label: string }>> => {
    if (liveAudioSource === "system") {
      return [{ stream: await requestSystemAudioStream(), speaker: "interviewer", label: "computer audio" }];
    }
    if (liveAudioSource === "both") {
      let system: MediaStream | null = null;
      let systemError = "";
      try {
        system = await requestSystemAudioStream();
      } catch (error) {
        systemError = error instanceof Error ? error.message : "system_audio_failed";
      }
      try {
        const mic = await requestMicrophoneStream();
        if (!system) {
          setDesktopStatus(`Computer audio unavailable (${systemError}); listening to microphone only`);
          return [{ stream: mic, speaker: "candidate", label: "microphone" }];
        }
        return [
          { stream: system, speaker: "interviewer", label: "computer audio" },
          { stream: mic, speaker: "candidate", label: "microphone" },
        ];
      } catch (error) {
        if (system) {
          setDesktopStatus(`Microphone unavailable (${error instanceof Error ? error.message : "microphone_failed"}); listening to computer audio only`);
          return [{ stream: system, speaker: "interviewer", label: "computer audio" }];
        }
        throw error;
      }
    }
    return [{ stream: await requestMicrophoneStream(), speaker: "candidate", label: "microphone" }];
  };

  const audioEnergy = (audio: Float32Array) => {
    let sum = 0;
    let peak = 0;
    for (const sample of audio) {
      const abs = Math.abs(sample);
      sum += sample * sample;
      if (abs > peak) peak = abs;
    }
    return {
      rms: Math.sqrt(sum / Math.max(1, audio.length)),
      peak,
    };
  };

  const floatToLinear16 = (audio: Float32Array): ArrayBuffer => {
    const buffer = new ArrayBuffer(audio.length * 2);
    const view = new DataView(buffer);
    for (let index = 0; index < audio.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, audio[index] ?? 0));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return buffer;
  };

  const resampleMono = (input: Float32Array, inputSampleRate: number, outputSampleRate = 16000): Float32Array => {
    if (inputSampleRate === outputSampleRate) return input;
    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.max(1, Math.floor(input.length / ratio));
    const output = new Float32Array(outputLength);
    for (let index = 0; index < outputLength; index += 1) {
      const sourceIndex = index * ratio;
      const left = Math.floor(sourceIndex);
      const right = Math.min(input.length - 1, left + 1);
      const weight = sourceIndex - left;
      output[index] = (input[left] ?? 0) * (1 - weight) + (input[right] ?? 0) * weight;
    }
    return output;
  };

  const shouldKeepTranscriptText = (text: string) => {
    const normalized = text.trim();
    if (!normalized) return false;
    const lower = normalized.toLowerCase();
    if (/^\(?\s*(audience|music|applause|laughing|laughter|chattering|sizzling|inaudible|clears throat|silence|noise)\s*\)?\.?$/.test(lower)) return false;
    if (/^\[[^\]]*(inaudible|music|noise|silence)[^\]]*\]$/i.test(normalized)) return false;
    return true;
  };

  const decodeAudioBlobToMono16k = async (blob: Blob): Promise<Float32Array> => {
    const AudioContextCtor = window.AudioContext;
    if (!AudioContextCtor) throw new Error("audio_context_unavailable");
    const context = new AudioContextCtor();
    try {
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const data = decoded.getChannelData(channel);
        for (let index = 0; index < decoded.length; index += 1) {
          mono[index] += data[index] / decoded.numberOfChannels;
        }
      }
      if (decoded.sampleRate === 16000) return mono;

      const offline = new OfflineAudioContext(1, Math.ceil(mono.length * 16000 / decoded.sampleRate), 16000);
      const buffer = offline.createBuffer(1, mono.length, decoded.sampleRate);
      buffer.copyToChannel(mono, 0);
      const source = offline.createBufferSource();
      source.buffer = buffer;
      source.connect(offline.destination);
      source.start(0);
      const rendered = await offline.startRendering();
      return rendered.getChannelData(0);
    } finally {
      await context.close().catch(() => {});
    }
  };

  const getLocalSttPipeline = async () => {
    if (!localSttPipelineRef.current) {
      setDesktopStatus("Loading local Whisper model...");
      localSttPipelineRef.current = import("@huggingface/transformers").then(async ({ env, pipeline }) => {
        env.allowLocalModels = false;
        env.allowRemoteModels = true;
        env.useBrowserCache = false;
        env.useFS = false;
        env.useFSCache = false;
        env.remoteHost = "https://huggingface.co/";
        env.remotePathTemplate = "{model}/resolve/{revision}/";
        return pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny", { dtype: "q8" });
      });
    }
    return localSttPipelineRef.current;
  };

  const getEvidenceEmbedder = React.useCallback(async (): Promise<EvidenceEmbedder> => {
    if (!evidenceEmbedderRef.current) {
      setDesktopStatus("Loading local evidence embeddings...");
      evidenceEmbedderRef.current = import("@huggingface/transformers").then(async ({ env, pipeline }) => {
        env.allowLocalModels = false;
        env.allowRemoteModels = true;
        env.useBrowserCache = true;
        env.useFS = false;
        env.useFSCache = false;
        env.remoteHost = "https://huggingface.co/";
        env.remotePathTemplate = "{model}/resolve/{revision}/";
        const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
        return async (texts: string[]) => {
          const results: EvidenceEmbedding[] = [];
          const missingTexts: string[] = [];
          for (const text of texts) {
            const key = text.replace(/\s+/g, " ").trim();
            const cached = evidenceEmbeddingCacheRef.current.get(key);
            if (cached) {
              results.push(cached);
            } else {
              missingTexts.push(key);
            }
          }
          for (const text of missingTexts) {
            const output = await extractor(text, { pooling: "mean", normalize: true }) as { data?: ArrayLike<number> };
            const embedding = {
              text,
              vector: Array.from(output.data ?? []),
            };
            evidenceEmbeddingCacheRef.current.set(text, embedding);
          }
          return texts.map((text) => {
            const key = text.replace(/\s+/g, " ").trim();
            return evidenceEmbeddingCacheRef.current.get(key) ?? { text: key, vector: [] };
          });
        };
      });
    }
    return evidenceEmbedderRef.current;
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    evidenceEmbedderWarmupRef.current = {
      status: "warming",
      reason: "startup",
      startedAt,
    };
    const timer = window.setTimeout(() => {
      void getEvidenceEmbedder()
        .then(async (embedder) => {
          await embedder(["callpilot startup evidence warmup"]);
          if (cancelled) return;
          evidenceEmbedderWarmupRef.current = {
            status: "ready",
            reason: "startup",
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
          void window.callpilotDesktop?.recordSessionEvent?.("evidence_embedder_warmup_completed", {
            reason: "startup",
            durationMs: evidenceEmbedderWarmupRef.current.durationMs,
          });
        })
        .catch((error) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : "evidence_embedder_warmup_failed";
          evidenceEmbedderRef.current = null;
          evidenceEmbedderWarmupRef.current = {
            status: "failed",
            reason: "startup",
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            error: message,
          };
          void window.callpilotDesktop?.recordSessionEvent?.("evidence_embedder_warmup_failed", {
            reason: "startup",
            durationMs: evidenceEmbedderWarmupRef.current.durationMs,
            error: message,
          });
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [getEvidenceEmbedder]);

  const testLocalWhisper = async () => {
    setLocalSttStatus("Loading Local Whisper test...");
    try {
      const recognizer = await getLocalSttPipeline() as (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string }>;
      const result = await recognizer(new Float32Array(16000), {
        chunk_length_s: 10,
        task: "transcribe",
        language: preferredLanguage === "spanish" ? "spanish" : "english",
      });
      setLocalSttStatus(`Local Whisper test OK${typeof result?.text === "string" && result.text.trim() ? `: ${result.text.trim()}` : ""}`);
      setDesktopStatus("Local Whisper test OK");
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      setLocalSttStatus(`Local Whisper test failed: ${message}`);
      setDesktopStatus(`Local Whisper test failed: ${message}`);
      localSttPipelineRef.current = null;
    }
  };

  const enqueueLocalSttBlob = (channelId: string, blob: Blob, speaker: TranscriptSpeaker) => {
    if (!blob.size) return;
    const queue = localSttQueueByIdRef.current.get(channelId) ?? [];
    queue.push({ blob, speaker });
    if (queue.length > 6) {
      const overflow = queue.splice(0, queue.length - 5);
      const merged = new Blob(overflow.map((item) => item.blob), { type: blob.type || "audio/webm" });
      queue.unshift({ blob: merged, speaker: overflow[overflow.length - 1]?.speaker ?? speaker });
      setDesktopStatus(`Local STT merged ${overflow.length} queued chunks for ${channelId}`);
    }
    localSttQueueByIdRef.current.set(channelId, queue);
  };

  const enqueueLiveChunkBlob = (channelId: string, blob: Blob, speaker: TranscriptSpeaker) => {
    if (!blob.size) return;
    const queue = liveChunkQueueByIdRef.current.get(channelId) ?? [];
    queue.push({ blob, speaker });
    if (queue.length > 6) {
      const overflow = queue.splice(0, queue.length - 5);
      const merged = new Blob(overflow.map((item) => item.blob), { type: blob.type || "audio/webm" });
      queue.unshift({ blob: merged, speaker: overflow[overflow.length - 1]?.speaker ?? speaker });
      setDesktopStatus(`Live STT merged ${overflow.length} queued chunks for ${channelId}`);
    }
    liveChunkQueueByIdRef.current.set(channelId, queue);
  };

  const transcribeLocalBlob = async (blob: Blob, speaker: TranscriptSpeaker = "interviewer", channelId = "default") => {
    if (!blob.size) return;
    void window.callpilotDesktop?.recordSessionEvent?.("local_stt_blob_received", {
      channelId,
      speaker,
      bytes: blob.size,
      mimeType: blob.type || "unknown",
    });
    enqueueLocalSttBlob(channelId, blob, speaker);
    if (localSttBusyByIdRef.current.has(channelId)) return;
    localSttBusyByIdRef.current.add(channelId);
    try {
      while (shouldDrainTranscriptionQueue(liveContinueRef.current, localSttQueueByIdRef.current.get(channelId)?.length ?? 0)) {
        const next = localSttQueueByIdRef.current.get(channelId)?.shift();
        if (!next) break;
        const audio = await decodeAudioBlobToMono16k(next.blob);
        if (audio.length < 1600) continue;
        const energy = audioEnergy(audio);
        if (energy.rms < 0.0035 && energy.peak < 0.035) {
          void window.callpilotDesktop?.recordSessionEvent?.("local_stt_silence_ignored", {
            channelId,
            speaker: next.speaker,
            rms: energy.rms,
            peak: energy.peak,
          });
          setDesktopStatus("Local Whisper ignored silence");
          continue;
        }
        void window.callpilotDesktop?.recordSessionEvent?.("local_stt_transcription_started", {
          channelId,
          speaker: next.speaker,
          samples: audio.length,
          rms: energy.rms,
          peak: energy.peak,
        });
        const recognizer = await getLocalSttPipeline() as (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string }>;
        const language = preferredLanguage === "spanish" ? "spanish" : preferredLanguage === "english" ? "english" : undefined;
        const result = await recognizer(audio, {
          chunk_length_s: 20,
          stride_length_s: 4,
          task: "transcribe",
          ...(language ? { language } : {}),
        });
        const text = typeof result?.text === "string" ? result.text.trim() : "";
        void window.callpilotDesktop?.recordSessionEvent?.("local_stt_transcription_completed", {
          channelId,
          speaker: next.speaker,
          kept: shouldKeepTranscriptText(text),
          text,
        });
        if (shouldKeepTranscriptText(text)) {
          handleFinalTranscript(text, "stt", next.speaker);
          setDesktopStatus("Local Whisper transcribed queued audio");
        } else if (text) {
          setDesktopStatus("Local Whisper ignored non-speech noise");
        }
      }
    } catch (error) {
      void window.callpilotDesktop?.recordSessionEvent?.("local_stt_transcription_failed", {
        channelId,
        error: error instanceof Error ? error.message : "local_stt_failed",
      });
      setDesktopStatus(error instanceof Error ? `Local STT failed: ${error.message}` : "Local STT failed");
    } finally {
      localSttBusyByIdRef.current.delete(channelId);
    }
  };

  const startLocalWhisperListening = async (reason = "Local Whisper") => {
    if (typeof MediaRecorder === "undefined") {
      setDesktopStatus("Audio recording is not available in this runtime");
      return false;
    }
    try {
      const channels = await requestLiveAudioStreams();
      void window.callpilotDesktop?.recordSessionEvent?.("local_stt_started", {
        reason,
        audioSource: liveAudioSource,
        channels: channels.map((channel) => ({ speaker: channel.speaker, label: channel.label })),
        chunkMs: liveChunkMs(),
      });
      liveStreamsRef.current = channels.map((channel) => channel.stream);
      liveContinueRef.current = true;

      const startSegment = (channel: { stream: MediaStream; speaker: TranscriptSpeaker; label: string }, channelId: string) => {
        if (!liveContinueRef.current) return;
        const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
        const recorder = new MediaRecorder(channel.stream, { mimeType: preferredMimeType });
        localSegmentChunksByIdRef.current.set(channelId, []);
        liveRecordersRef.current.push(recorder);
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            appendSegmentChunk(localSegmentChunksByIdRef.current, channelId, event.data);
          }
        };
        recorder.onerror = () => {
          setDesktopStatus(`Local ${channel.label} recording error`);
          stopLiveRecording();
        };
        recorder.onstop = () => {
          const chunks = consumeSegmentChunks(localSegmentChunksByIdRef.current, channelId);
          liveRecordersRef.current = liveRecordersRef.current.filter((item) => item !== recorder);
          if (chunks.length > 0) {
            const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
            void transcribeLocalBlob(blob, channel.speaker, channelId);
          }
          if (liveContinueRef.current) {
            startSegment(channel, channelId);
          }
        };
        recorder.start();
        const timer = window.setTimeout(() => {
          localSegmentTimersRef.current = localSegmentTimersRef.current.filter((item) => item !== timer);
          if (recorder.state === "recording") recorder.stop();
        }, liveChunkMs());
        localSegmentTimersRef.current.push(timer);
      };

      channels.forEach((channel, index) => startSegment(channel, `${channel.speaker}-${index}`));
      setIsDictating(true);
      setDesktopStatus(reason);
      const sourceLabel = liveAudioSource === "both" ? "computer audio + microphone" : liveAudioSource === "system" ? "computer audio" : "microphone";
      setLiveAssistStatus(autoAnswerEnabled ? `Listening to ${sourceLabel}: auto answer on` : `Listening to ${sourceLabel}: auto answer off`);
      return true;
    } catch (error) {
      setDesktopStatus(error instanceof Error ? `Audio capture failed: ${error.message}` : "Audio capture failed");
      setIsDictating(false);
      return false;
    }
  };

  const transcribeLiveBlob = async (blob: Blob, speaker: TranscriptSpeaker = "interviewer", channelId = "default") => {
    if (!blob.size) return;
    enqueueLiveChunkBlob(channelId, blob, speaker);
    if (liveChunkBusyByIdRef.current.has(channelId)) return;
    liveChunkBusyByIdRef.current.add(channelId);
    try {
      while (shouldDrainTranscriptionQueue(liveContinueRef.current, liveChunkQueueByIdRef.current.get(channelId)?.length ?? 0)) {
        const next = liveChunkQueueByIdRef.current.get(channelId)?.shift();
        if (!next) break;
        const arrayBuffer = await next.blob.arrayBuffer();
        const result = await window.callpilotDesktop?.transcribeAudio({
          arrayBuffer,
          fileName: `callpilot-live-${Date.now()}.webm`,
          mimeType: next.blob.type || "audio/webm",
          modelName: transcriptionModelName,
          apiKey: sessionApiKey,
          provider: liveTranscriptionProvider === "natively" ? "natively" : "openai",
          nativelyApiKey,
        });
        if (result?.ok && result.text) {
          handleFinalTranscript(result.text, "stt", next.speaker);
          setDesktopStatus(`Live chunk transcribed with ${result.modelName}`);
          continue;
        }
        if (result && !result.ok) setDesktopStatus(`Live transcription failed: ${result.error ?? "unknown"}`);
      }
    } finally {
      liveChunkBusyByIdRef.current.delete(channelId);
    }
  };

  const startOpenAIChunkListening = async (reason = "OpenAI live chunks") => {
    if (!window.callpilotDesktop?.transcribeAudio) {
      setDesktopStatus("Desktop transcription bridge is unavailable");
      setLiveAssistStatus("OpenAI live chunks require desktop mode");
      return false;
    }
    if (!hasOpenAITranscriptionKey) {
      setDesktopStatus("OpenAI live chunks need an OpenAI API key. Switch Live transcription to Deepgram for realtime STT.");
      setLiveAssistStatus("No OpenAI key for live chunks");
      setLiveTranscriptionProvider("deepgram");
      return false;
    }
    if (typeof MediaRecorder === "undefined") {
      setDesktopStatus("Audio recording is not available in this runtime");
      return false;
    }

    try {
      const channels = await requestLiveAudioStreams();
      if (channels.length === 0) throw new Error("audio_capture_unavailable");
      liveStreamsRef.current = channels.map((channel) => channel.stream);
      liveContinueRef.current = true;
      channels.forEach((channel, index) => {
        const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
        const recorder = new MediaRecorder(channel.stream, { mimeType: preferredMimeType });
        const channelId = `${channel.speaker}-${index}`;
        liveRecordersRef.current.push(recorder);
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) void transcribeLiveBlob(event.data, channel.speaker, channelId);
        };
        recorder.onerror = () => {
          setDesktopStatus(`Live ${channel.label} recording error`);
          stopLiveRecording();
        };
        recorder.onstop = () => {
          channel.stream.getTracks().forEach((track) => track.stop());
          liveRecordersRef.current = liveRecordersRef.current.filter((item) => item !== recorder);
        };
        recorder.start(liveChunkMs());
      });
      setIsDictating(true);
      setDesktopStatus(reason);
      const sourceLabel = liveAudioSource === "both" ? "computer audio + microphone" : liveAudioSource === "system" ? "computer audio" : "microphone";
      setLiveAssistStatus(autoAnswerEnabled ? `Listening to ${sourceLabel} with OpenAI: auto answer on` : `Listening to ${sourceLabel} with OpenAI: auto answer off`);
      return true;
    } catch (error) {
      setDesktopStatus(error instanceof Error ? `Audio capture failed: ${error.message}` : "Audio capture failed");
      setIsDictating(false);
      return false;
    }
  };

  const startNativelyListening = async () => {
    if (!window.callpilotDesktop?.startNativelyTranscription || !window.callpilotDesktop?.sendNativelyAudio) {
      setDesktopStatus("Desktop transcription bridge is unavailable");
      setLiveAssistStatus("Natively STT requires desktop mode");
      return false;
    }
    if (!hasNativelyTranscriptionKey) {
      setDesktopStatus("Natively STT needs a Natively API key saved first");
      setLiveAssistStatus("No Natively key for live transcription");
      return false;
    }
    const AudioContextCtor = window.AudioContext;
    if (!AudioContextCtor) {
      setDesktopStatus("AudioContext is unavailable");
      return false;
    }
    try {
      const channels = await requestLiveAudioStreams();
      liveStreamsRef.current = channels.map((channel) => channel.stream);
      const started: string[] = [];
      for (const [index, channel] of channels.entries()) {
        const context = new AudioContextCtor();
        const source = context.createMediaStreamSource(channel.stream);
        const processor = context.createScriptProcessor(4096, 1, 1);
        const streamId = `${channel.speaker === "candidate" ? "mic" : "system"}-${Date.now()}-${index}`;
        const nativelyChannel = channel.speaker === "candidate" ? "mic" : "system";
        const startResult = await window.callpilotDesktop.startNativelyTranscription({
          streamId,
          channel: nativelyChannel,
          sampleRate: 16000,
          language: preferredLanguage,
          apiKey: nativelyApiKey,
        });
        if (!startResult.ok) {
          throw new Error(startResult.error ?? "natively_start_failed");
        }
        processor.onaudioprocess = (event) => {
          event.outputBuffer.getChannelData(0).fill(0);
          const input = event.inputBuffer.getChannelData(0);
          const resampled = resampleMono(input, context.sampleRate, 16000);
          const energy = audioEnergy(resampled);
          if (channel.speaker === "interviewer" && energy.peak > 0.018 && Date.now() - lastSystemAudioSignalAtRef.current > 3000) {
            lastSystemAudioSignalAtRef.current = Date.now();
            setDesktopStatus("Computer audio signal detected");
          }
          const nativelySpeaker = channel.speaker === "candidate" ? "candidate" : "interviewer";
          if (!shouldSendNativelyFrame(nativelySpeaker, energy)) return;
          const pcm = floatToLinear16(resampled);
          void window.callpilotDesktop?.sendNativelyAudio?.({ streamId, arrayBuffer: pcm });
        };
        source.connect(processor);
        processor.connect(context.destination);
        nativelySessionsRef.current.push({ streamId, context, source, processor });
        started.push(channel.label);
      }
      setIsDictating(true);
      setDesktopStatus("Natively PCM streaming started");
      setLiveAssistStatus(autoAnswerEnabled ? `Listening with Natively STT (${started.join(" + ")}): auto answer on` : `Listening with Natively STT (${started.join(" + ")}): auto answer off`);
      return true;
    } catch (error) {
      stopLiveRecording();
      setDesktopStatus(error instanceof Error ? `Natively STT failed: ${error.message}` : "Natively STT failed");
      setIsDictating(false);
      return false;
    }
  };

  const startDeepgramListening = async () => {
    if (!window.callpilotDesktop?.startDeepgramTranscription || !window.callpilotDesktop?.sendDeepgramAudio) {
      setDesktopStatus("Desktop transcription bridge is unavailable");
      setLiveAssistStatus("Deepgram requires desktop mode");
      return false;
    }
    if (!hasDeepgramTranscriptionKey) {
      setDesktopStatus("Deepgram needs an API key saved first");
      setLiveAssistStatus("No Deepgram key for live transcription");
      return false;
    }
    const AudioContextCtor = window.AudioContext;
    if (!AudioContextCtor) {
      setDesktopStatus("AudioContext is unavailable");
      return false;
    }
    try {
      const channels = await requestLiveAudioStreams();
      liveStreamsRef.current = channels.map((channel) => channel.stream);
      const started: string[] = [];
      for (const [index, channel] of channels.entries()) {
        const context = new AudioContextCtor();
        const source = context.createMediaStreamSource(channel.stream);
        const processor = context.createScriptProcessor(4096, 1, 1);
        const streamId = `${channel.speaker === "candidate" ? "mic" : "system"}-${Date.now()}-${index}`;
        const deepgramChannel = channel.speaker === "candidate" ? "mic" : "system";
        const startResult = await window.callpilotDesktop.startDeepgramTranscription({
          streamId,
          channel: deepgramChannel,
          sampleRate: 16000,
          language: preferredLanguage,
          latencyPreset: liveLatencyPreset,
          modelName: "nova-3",
          apiKey: deepgramApiKey,
        });
        if (!startResult.ok) {
          throw new Error(startResult.error ?? "deepgram_start_failed");
        }
        processor.onaudioprocess = (event) => {
          event.outputBuffer.getChannelData(0).fill(0);
          const input = event.inputBuffer.getChannelData(0);
          const resampled = resampleMono(input, context.sampleRate, 16000);
          const energy = audioEnergy(resampled);
          if (channel.speaker === "interviewer" && energy.peak > 0.018 && Date.now() - lastSystemAudioSignalAtRef.current > 3000) {
            lastSystemAudioSignalAtRef.current = Date.now();
            setDesktopStatus("Computer audio signal detected");
          }
          const speaker = channel.speaker === "candidate" ? "candidate" : "interviewer";
          if (speaker === "candidate" && Date.now() - lastMicAudioSignalAtRef.current > 3000) {
            lastMicAudioSignalAtRef.current = Date.now();
            void window.callpilotDesktop?.recordSessionEvent?.("live_audio_signal", {
              provider: "deepgram",
              speaker,
              streamId,
              rms: Number(energy.rms.toFixed(6)),
              peak: Number(energy.peak.toFixed(6)),
              sent: true,
            });
          }
          const pcm = floatToLinear16(resampled);
          void window.callpilotDesktop?.sendDeepgramAudio?.({ streamId, arrayBuffer: pcm });
        };
        source.connect(processor);
        processor.connect(context.destination);
        deepgramSessionsRef.current.push({ streamId, context, source, processor });
        started.push(channel.label);
      }
      setIsDictating(true);
      setDesktopStatus("Deepgram PCM streaming started");
      setLiveAssistStatus(autoAnswerEnabled ? `Listening with Deepgram (${started.join(" + ")}): auto answer on` : `Listening with Deepgram (${started.join(" + ")}): auto answer off`);
      return true;
    } catch (error) {
      stopLiveRecording();
      setDesktopStatus(error instanceof Error ? `Deepgram failed: ${error.message}` : "Deepgram failed");
      setIsDictating(false);
      return false;
    }
  };

  const toggleDictation = async (forceStart = false) => {
    if (isDictating && !forceStart) {
      stopLiveRecording();
      return;
    }
    if (forceStart) {
      stopLiveRecording();
    }
    void window.callpilotDesktop?.recordSessionEvent?.("live_transcription_start_requested", {
      forceStart,
      provider: liveTranscriptionProvider,
      audioSource: liveAudioSource,
      latencyPreset: liveLatencyPreset,
    });

    if (liveTranscriptionProvider === "browser" && (liveAudioSource === "system" || liveAudioSource === "both")) {
      setLiveTranscriptionProvider("deepgram");
      await startDeepgramListening();
      return;
    }

    if (liveTranscriptionProvider === "openai_realtime") {
      await startOpenAIChunkListening();
      return;
    }
    if (liveTranscriptionProvider === "natively") {
      setLiveTranscriptionProvider("deepgram");
      await startDeepgramListening();
      return;
    }
    if (liveTranscriptionProvider === "deepgram") {
      await startDeepgramListening();
      return;
    }

    if (liveTranscriptionProvider === "local") {
      await startLocalWhisperListening();
      return;
    }

    if (liveTranscriptionProvider === "browser" && browserSpeechRuntimeError) {
      setDesktopStatus(`Browser live STT is unavailable: ${browserSpeechRuntimeError}`);
      setLiveAssistStatus("Trying Deepgram instead of browser speech.");
      setLiveTranscriptionProvider("deepgram");
      await startDeepgramListening();
      return;
    }

    if (!livePlan.implemented) {
      setLiveAssistStatus(`${livePlan.engineLabel} is configured but not connected yet`);
      setDesktopStatus("Live provider not connected");
      return;
    }

    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setDesktopStatus("Browser speech recognition is unavailable");
      if (hasOpenAITranscriptionKey) {
        await startOpenAIChunkListening("Browser speech unavailable; using OpenAI chunks");
      } else {
        setLiveAssistStatus("Browser live unavailable; using Deepgram");
        setLiveTranscriptionProvider("deepgram");
        await startDeepgramListening();
      }
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    const recognitionLanguage = browserRecognitionLanguage(preferredLanguage);
    if (recognitionLanguage) recognition.lang = recognitionLanguage;
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results.item(index);
        if (result.isFinal) handleFinalTranscript(result[0]?.transcript ?? "", "stt");
      }
    };
    recognition.onerror = (event) => {
      const reason = event.error || event.message || "unknown";
      setBrowserSpeechRuntimeError(reason);
      setDesktopStatus(`Speech recognition error: ${reason}`);
      setIsDictating(false);
      if (hasOpenAITranscriptionKey && (reason === "network" || reason === "not-allowed" || reason === "service-not-allowed" || reason === "audio-capture")) {
        void startOpenAIChunkListening(`Browser speech failed (${reason}); using OpenAI chunks`);
      } else if (!hasOpenAITranscriptionKey) {
        setLiveAssistStatus("Browser speech failed; using Deepgram.");
        setLiveTranscriptionProvider("deepgram");
        void startDeepgramListening();
      }
    };
    recognition.onend = () => {
      if (!liveRecorderRef.current) setIsDictating(false);
    };
    recognitionRef.current = recognition;
    try {
      setBrowserSpeechRuntimeError("");
      recognition.start();
      setIsDictating(true);
      setDesktopStatus("Live transcript active");
      setLiveAssistStatus(autoAnswerEnabled ? `${livePlan.engineLabel}: auto answer on` : `${livePlan.engineLabel}: auto answer off`);
    } catch (error) {
      setDesktopStatus(error instanceof Error ? `Speech recognition failed: ${error.message}` : "Speech recognition failed");
      if (hasOpenAITranscriptionKey) {
        await startOpenAIChunkListening("Browser speech failed at startup; using OpenAI chunks");
      } else {
        setLiveAssistStatus("Browser speech failed; using Deepgram.");
        setLiveTranscriptionProvider("deepgram");
        await startDeepgramListening();
      }
    }
  };

  const startSession = React.useCallback(async () => {
    if (!window.callpilotDesktop?.startSession) {
      setDesktopStatus("Overlay requires desktop mode");
      return;
    }
    stopLiveRecording();
    resetSessionRuntimeContext();
    applyInterviewSetup(selectedSetup);
    autoAnswerEnabledRef.current = false;
    setAutoAnswerEnabled(false);
    const sessionMode = selectedSetup === "live_coding" ? "live_coding" : "technical_qa";
    await window.callpilotDesktop.saveSettings?.({
      activeMode: sessionMode,
      preferredLanguage,
      defaultCodingLanguage: codingLanguage,
      answerVerbosity,
      modelProvider,
      modelName,
      ollamaBaseUrl,
      transcriptionModelName,
      liveTranscriptionProvider,
      liveLatencyPreset,
      liveAudioSource,
      autoAnswerCooldownMs,
      autoAnswerMinConfidence,
    }).catch(() => undefined);
    const result = await window.callpilotDesktop.startSession({
      mode: sessionMode,
      activeMode: sessionMode,
      preferredLanguage,
      modelProvider,
      modelName,
      liveTranscriptionProvider,
      liveLatencyPreset,
      liveAudioSource,
    });
    if (result.ok) {
      await window.callpilotDesktop.recordSessionEvent?.("evidence_embedder_warmup_state", evidenceEmbedderWarmupRef.current).catch(() => undefined);
      await toggleDictation(true);
      const traceStatus = await window.callpilotDesktop.getSessionTraceStatus?.();
      setDesktopStatus(traceStatus?.path
        ? `Overlay session started. Metrics trace: ${traceStatus.path}`
        : "Overlay session started with listening and auto-answer off");
    } else {
      setDesktopStatus(`Overlay failed: ${result.error ?? "unknown"}`);
    }
  }, [
    activeMode,
    answerVerbosity,
    applyInterviewSetup,
    autoAnswerCooldownMs,
    autoAnswerMinConfidence,
    codingLanguage,
    liveAudioSource,
    liveLatencyPreset,
    liveTranscriptionProvider,
    modelName,
    modelProvider,
    ollamaBaseUrl,
    preferredLanguage,
    resetSessionRuntimeContext,
    selectedSetup,
    toggleDictation,
    transcriptionModelName,
  ]);

  const stopMicRecording = () => {
    mediaRecorderRef.current?.stop();
  };

  const toggleMicRecording = async () => {
    if (isRecordingMic) {
      stopMicRecording();
      return;
    }

    if (!window.callpilotDesktop?.transcribeAudio) {
      setRecordingStatus("Mic transcription requires desktop mode");
      return;
    }
    if (liveTranscriptionProvider !== "openai_realtime" && liveTranscriptionProvider !== "natively") {
      setRecordingStatus("Select OpenAI live chunks or Natively STT before recording mic audio");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRecordingStatus("Microphone recording is not available in this runtime");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: preferredMimeType });
      recordingChunksRef.current = [];
      recordingStreamRef.current = stream;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setRecordingStatus("Microphone recording error");
        setIsRecordingMic(false);
      };
      recorder.onstop = async () => {
        setIsRecordingMic(false);
        stream.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null;
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        recordingChunksRef.current = [];
        if (!blob.size) {
          setRecordingStatus("No audio captured");
          return;
        }
        setRecordingStatus("Transcribing microphone audio...");
        const arrayBuffer = await blob.arrayBuffer();
        const result = await window.callpilotDesktop?.transcribeAudio({
          arrayBuffer,
          fileName: `callpilot-mic-${Date.now()}.webm`,
          mimeType: blob.type || "audio/webm",
          modelName: transcriptionModelName,
          apiKey: sessionApiKey,
          provider: liveTranscriptionProvider === "natively" ? "natively" : "openai",
          nativelyApiKey,
        });
        if (result?.ok && result.text) {
          appendTranscriptLine(result.text, "stt");
          setRecordingStatus(`Transcribed with ${result.modelName}`);
        } else {
          setRecordingStatus(`Transcription failed: ${result?.error ?? "unknown"}`);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecordingMic(true);
      setRecordingStatus("Recording microphone...");
    } catch (error) {
      setRecordingStatus(error instanceof Error ? error.message : "Microphone permission failed");
      setIsRecordingMic(false);
    }
  };

  const currentSessionSnapshot = React.useCallback(() => createSessionSnapshot({
    id: sessionIdentity.id,
    title: sessionIdentity.title,
    createdAt: sessionIdentity.createdAt,
    activeMode,
    companyName,
    roleTitle,
    resumeText,
    starStories,
    jobDescription,
    transcript,
    screenText,
    notes,
    profile,
    targetUseCase,
    preferredLanguage,
    codingLanguage,
    answerVerbosity,
    modelProvider,
    modelName,
    question,
    answer,
    codingPayload: currentCodingPayload,
  }), [
    activeMode,
    answer,
    answerVerbosity,
    codingLanguage,
    companyName,
    currentCodingPayload,
    jobDescription,
    modelName,
    modelProvider,
    notes,
    preferredLanguage,
    profile,
    question,
    resumeText,
    roleTitle,
    screenText,
    sessionIdentity,
    starStories,
    targetUseCase,
    transcript,
  ]);

  const persistLibrary = (next: SavedSession[]) => {
    setSessionLibrary(next);
    window.localStorage.setItem(SESSION_LIBRARY_KEY, JSON.stringify(next));
  };

  const refreshOllamaModels = React.useCallback(async (options: { selectFirst?: boolean } = {}) => {
    if (!window.callpilotDesktop?.listOllamaModels) {
      setOllamaStatus("Model detection requires the desktop app");
      return;
    }
    setOllamaStatus("Checking installed Ollama models...");
    const result = await window.callpilotDesktop.listOllamaModels({ ollamaBaseUrl });
    if (!result.ok) {
      setOllamaModels([]);
      setOllamaStatus(`Could not reach Ollama: ${result.error ?? "unknown error"}`);
      return;
    }

    const names = result.models.map((model) => model.name).filter(Boolean);
    setOllamaModels(names);
    if (names.length === 0) {
      setOllamaStatus("Ollama is running, but no local models were found");
      return;
    }

    setOllamaStatus(`${names.length} local model${names.length === 1 ? "" : "s"} found`);
    if (options.selectFirst || !names.includes(modelName)) {
      setModelName(names[0] ?? modelName);
    }
  }, [modelName, ollamaBaseUrl]);

  const refreshNvidiaModels = React.useCallback(async (options: { selectFirst?: boolean } = {}) => {
    if (!window.callpilotDesktop?.listNvidiaModels) {
      setNvidiaStatus("NVIDIA model detection requires the desktop app");
      return;
    }
    setNvidiaStatus("Checking NVIDIA models...");
    const result = await window.callpilotDesktop.listNvidiaModels();
    if (!result.ok) {
      setNvidiaModels([]);
      setNvidiaStatus(`Could not list NVIDIA models: ${result.error ?? "unknown error"}`);
      return;
    }

    const names = Array.from(new Set(result.models.map((model) => model.name).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    setNvidiaModels(names);
    if (names.length === 0) {
      setNvidiaStatus("NVIDIA responded, but no models were returned");
      return;
    }

    setNvidiaStatus(`${names.length} NVIDIA model${names.length === 1 ? "" : "s"} available`);
    if (options.selectFirst && !names.includes(modelName)) {
      const preferred = NVIDIA_MODEL_PRESETS.find((preset) => names.includes(preset)) ?? names[0];
      setModelName(preferred ?? modelName);
    }
  }, [modelName]);

  const runAutoChecks = React.useCallback(async () => {
    setAutoCheckStatus("Running checks...");
    const checks: AutoCheck[] = [];

    const hasDesktopBridge = Boolean(window.callpilotDesktop);
    checks.push({
      label: "Desktop app",
      status: hasDesktopBridge ? "ok" : "warn",
      detail: hasDesktopBridge ? "Desktop bridge is connected." : "Running in browser preview. Some local features need the desktop app.",
    });

    const hasMicApi = typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined";
    checks.push({
      label: "Microphone API",
      status: hasMicApi ? "ok" : "fail",
      detail: hasMicApi ? "The app can request microphone access." : "This runtime cannot access microphone recording.",
    });

    const hasSystemAudioApi = typeof navigator.mediaDevices?.getDisplayMedia === "function" && typeof MediaRecorder !== "undefined";
    checks.push({
      label: "Computer audio",
      status: hasSystemAudioApi ? "ok" : "warn",
      detail: hasSystemAudioApi
        ? "The app can request screen, tab, or window audio. Choose a source with audio sharing enabled."
        : "This runtime cannot request computer audio capture.",
    });

    const hasBrowserSpeech = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    checks.push({
      label: "Browser live STT",
      status: browserSpeechRuntimeError ? "fail" : hasBrowserSpeech ? "ok" : "warn",
      detail: browserSpeechRuntimeError
        ? `Browser speech recognition is present, but failed at runtime: ${browserSpeechRuntimeError}.`
        : hasBrowserSpeech ? "Browser speech recognition is available." : "Browser speech recognition is not available here.",
    });

    const credential = await window.callpilotDesktop?.getCredentialStatus?.().catch(() => undefined);
    const hasKey = Boolean(credential?.hasOpenAIKey || sessionApiKey.trim());
    const hasNativelyKey = Boolean(credential?.hasNativelyKey || nativelyApiKey.trim());
    const hasDeepgramKey = Boolean(credential?.hasDeepgramKey || deepgramApiKey.trim());
    const hasNvidiaKey = Boolean(credential?.hasNvidiaKey || nvidiaApiKey.trim());
    if (credential) {
      applyCredentialStatus(credential);
      setCredentialMessage(credential.encryptionAvailable ? "Encrypted key storage ready" : "Encrypted key storage unavailable");
    }
    checks.push({
      label: "OpenAI transcription",
      status: hasKey ? "ok" : "warn",
      detail: hasKey ? "OpenAI live chunks can be used." : "No OpenAI key found. OpenAI live chunks will stay disabled.",
    });
    checks.push({
      label: "Natively STT",
      status: hasNativelyKey ? "warn" : "warn",
      detail: hasNativelyKey
        ? "Natively key is saved. PCM/WebSocket streaming is available for controlled STT testing."
        : "No Natively key found. Add it here only for STT testing.",
    });
    checks.push({
      label: "Deepgram STT",
      status: hasDeepgramKey ? "ok" : "warn",
      detail: hasDeepgramKey
        ? "Deepgram key is available. Nova-3 realtime WebSocket streaming can be used for English, Spanish, or multilingual calls."
        : "No Deepgram key found. Save one or set DEEPGRAM_API_KEY/CALLPILOT_DEEPGRAM_API_KEY before launch.",
    });
    checks.push({
      label: "NVIDIA answers",
      status: hasNvidiaKey ? "ok" : "warn",
      detail: hasNvidiaKey
        ? "NVIDIA key is available for answer generation."
        : "No NVIDIA key found. Save one or set NVIDIA_API_KEY/CALLPILOT_NVIDIA_API_KEY before launch.",
    });

    if (window.callpilotDesktop?.listOllamaModels) {
      const result = await window.callpilotDesktop.listOllamaModels({ ollamaBaseUrl });
      if (result.ok) {
        const names = result.models.map((model) => model.name).filter(Boolean);
        setOllamaModels(names);
        setOllamaStatus(names.length > 0 ? `${names.length} local model${names.length === 1 ? "" : "s"} found` : "Ollama is running, but no local models were found");
        if (names.length > 0 && modelProvider === "ollama" && !names.includes(modelName)) {
          setModelName(names[0] ?? modelName);
        }
        checks.push({
          label: "Ollama",
          status: names.length > 0 ? "ok" : "warn",
          detail: names.length > 0 ? `${names.length} local model${names.length === 1 ? "" : "s"} detected.` : "Ollama responded but no models were installed.",
        });
      } else {
        setOllamaModels([]);
        setOllamaStatus(`Could not reach Ollama: ${result.error ?? "unknown error"}`);
        checks.push({
          label: "Ollama",
          status: "fail",
          detail: `Could not reach Ollama at ${result.baseUrl}: ${result.error ?? "unknown error"}.`,
        });
      }
    } else {
      checks.push({
        label: "Ollama",
        status: "warn",
        detail: "Ollama detection requires the desktop app.",
      });
    }

    if (!hasKey && liveTranscriptionProvider === "openai_realtime") {
      setLiveTranscriptionProvider("browser");
    }

    const recommendation = hasDeepgramKey
      ? "Recommended: Deepgram realtime for transcription, with your selected answer provider for responses."
      : hasNvidiaKey
      ? "Recommended: NVIDIA for answer tests, Deepgram or Local Whisper for transcription."
      : hasNativelyKey
      ? "Recommended: use Natively next as a controlled STT test; keep Local Whisper/OpenAI available as fallback while we compare quality."
      : hasKey
      ? "Recommended: OpenAI live chunks for transcription, Ollama or OpenAI for answers."
      : liveAudioSource === "system" || liveAudioSource === "both"
        ? "Recommended: Local Whisper with computer audio + microphone for live interview conversations."
        : hasBrowserSpeech && !browserSpeechRuntimeError
        ? "Recommended: Browser live for transcription and Ollama local for answers."
        : "Recommended: Local Whisper for transcription and Ollama local for answers.";
    checks.push({ label: "Recommendation", status: "ok", detail: recommendation });

    setAutoChecks(checks);
    setAutoCheckStatus("Checks complete");
  }, [applyCredentialStatus, browserSpeechRuntimeError, deepgramApiKey, liveAudioSource, liveTranscriptionProvider, modelName, modelProvider, nativelyApiKey, nvidiaApiKey, ollamaBaseUrl, sessionApiKey]);

  React.useEffect(() => {
    if (modelProvider === "ollama") {
      void refreshOllamaModels();
    }
  }, [modelProvider, refreshOllamaModels]);

  React.useEffect(() => {
    if (modelProvider === "nvidia" && nvidiaModels.length === 0) {
      void refreshNvidiaModels({ selectFirst: !modelName || modelName === "nvidia-default" });
    }
  }, [modelName, modelProvider, nvidiaModels.length, refreshNvidiaModels]);

  React.useEffect(() => {
    if (autoCheckRanRef.current) return;
    autoCheckRanRef.current = true;
    void runAutoChecks();
  }, [runAutoChecks]);

  const updateModelProvider = (provider: ModelProvider) => {
    answerProviderTouchedRef.current = true;
    setModelProvider(provider);
    if (provider === "ollama") {
      if (liveTranscriptionProvider === "openai_realtime" && !hasOpenAITranscriptionKey) {
        setLiveTranscriptionProvider("browser");
      }
      void refreshOllamaModels({ selectFirst: !modelName || modelName === "mock-local" });
    }
    if (provider === "openai" && modelName === "llama3.1") {
      setModelName("");
    }
    if (provider === "natively" && (modelName === "llama3.1" || modelName.startsWith("llama3.1:"))) {
      setModelName("default");
    }
    if (provider === "nvidia" && (modelName === "llama3.1" || modelName.startsWith("llama3.1:") || modelName === "default" || modelName === "nvidia-default" || modelName === "mock-local" || !modelName.trim())) {
      setModelName(NVIDIA_MODEL_PRESETS[0]);
    }
  };

  const saveToLibrary = () => {
    const session = currentSessionSnapshot();
    persistLibrary(upsertSession(sessionLibrary, session));
    setSessionMessage(`Saved: ${session.title}`);
  };

  const loadFromLibrary = (session: SavedSession) => {
    setActiveMode(session.activeMode);
    setTranscript(session.transcript);
    updateScreenContext(session.screenText);
    setCompanyName(session.companyName ?? "");
    setRoleTitle(session.roleTitle ?? "");
    setResumeText(session.resumeText ?? session.profile ?? "");
    setStarStories(session.starStories ?? "");
    setJobDescription(session.jobDescription ?? "");
    setNotes(session.notes);
    setProfile(session.profile);
    setTargetUseCase(session.targetUseCase);
    setPreferredLanguage(session.preferredLanguage);
    setCodingLanguage(session.codingLanguage);
    setAnswerVerbosity(session.answerVerbosity);
    setModelProvider(session.modelProvider);
    setModelName(session.modelName);
    setQuestion(session.question);
    setAnswer(session.answer);
    setCurrentCodingPayload(session.codingPayload ?? null);
    setSessionMessage(`Loaded: ${session.title}`);
  };

  const deleteFromLibrary = (id: string) => {
    const next = sessionLibrary.filter((session) => session.id !== id);
    persistLibrary(next);
    setSessionMessage("Session deleted");
  };

  const exportSession = async () => {
    const session = currentSessionSnapshot();
    if (window.callpilotDesktop?.exportSessionFile) {
      const result = await window.callpilotDesktop.exportSessionFile(session);
      setSessionMessage(result.ok ? `Exported: ${result.path}` : result.canceled ? "Export canceled" : `Export failed: ${result.error ?? "unknown"}`);
      return;
    }
    navigator.clipboard?.writeText(serializeSession(session));
    setSessionMessage("Session JSON copied");
  };

  const importSession = async () => {
    const fileResult = await window.callpilotDesktop?.importSessionFile?.();
    const raw = fileResult?.ok && fileResult.json
      ? fileResult.json
      : window.prompt("Paste exported CallPilot session JSON");
    if (!raw) return;
    const parsed = parseSessionJson(raw);
    if (!parsed) {
      setSessionMessage("Invalid session JSON");
      return;
    }
    persistLibrary(upsertSession(sessionLibrary, parsed));
    loadFromLibrary(parsed);
  };

  const captureScreenshot = React.useCallback(async () => {
    if (!window.callpilotDesktop?.captureScreenshot) {
      setDesktopStatus("Screenshot capture requires desktop mode");
      return;
    }

    const latencyRun = markLatencyStage(createLatencyMetricRun("screen"), "audio_or_screen_capture");
    setLatencyRuns((current) => [...current, latencyRun].slice(-12));
    const result = await window.callpilotDesktop.captureScreenshot();
    if (!result.ok || !result.path) {
      setDesktopStatus(`Screenshot failed: ${result.error ?? "unknown"}`);
      return;
    }

    const nextText = [`Screenshot captured: ${result.path}`, result.displayName ? `Display: ${result.displayName}` : ""]
      .filter(Boolean)
      .join("\n");
    updateScreenContext(nextText);
    setDesktopStatus("Screenshot captured");

    if ((modelProvider === "openai" || modelProvider === "nvidia") && window.callpilotDesktop?.analyzeScreenshot) {
      setDesktopStatus("Analyzing screenshot...");
      const analysis = await window.callpilotDesktop.analyzeScreenshot({
        path: result.path,
        provider: modelProvider,
        modelName,
        apiKey: sessionApiKey,
        nvidiaApiKey,
      });
      if (analysis.ok && analysis.text) {
        setLatencyRuns((current) => current.map((run) =>
          run.id === latencyRun.id ? markLatencyStage(run, "transcription_or_vision_done") : run,
        ));
        updateScreenContext(`${analysis.text}\n\nScreenshot: ${result.path}`);
        setDesktopStatus("Screenshot analyzed");
      } else {
        setDesktopStatus(`Screenshot captured, analysis failed: ${analysis.error ?? "unknown"}`);
      }
    }
  }, [modelName, modelProvider, nvidiaApiKey, sessionApiKey]);

  const captureLocalOcr = React.useCallback(async () => {
    if (!window.callpilotDesktop?.captureScreenshot || !window.callpilotDesktop?.recognizeScreenText) {
      setDesktopStatus("Local OCR requires desktop mode");
      return;
    }

    const latencyRun = markLatencyStage(createLatencyMetricRun("screen+ocr"), "audio_or_screen_capture");
    setLatencyRuns((current) => [...current, latencyRun].slice(-12));
    setDesktopStatus("Capturing screen for local OCR...");
    const result = await window.callpilotDesktop.captureScreenshot();
    if (!result.ok || !result.path) {
      setDesktopStatus(`Screenshot failed: ${result.error ?? "unknown"}`);
      return;
    }

    setDesktopStatus("Running local OCR...");
    const ocr = await window.callpilotDesktop.recognizeScreenText({
      path: result.path,
      language: normalizeOcrLanguage(preferredLanguage),
    });
    if (!ocr.ok || !ocr.text) {
      setDesktopStatus(`Local OCR failed: ${ocr.error ?? "no text found"}`);
      updateScreenContext([`Screenshot captured: ${result.path}`, result.displayName ? `Display: ${result.displayName}` : ""].filter(Boolean).join("\n"));
      return;
    }
    setLatencyRuns((current) => current.map((run) =>
      run.id === latencyRun.id ? markLatencyStage(run, "transcription_or_vision_done") : run,
    ));

    const localScreenContext = classifyScreenText(ocr.text);
    updateScreenContext([
      ocr.text,
      "",
      `Local OCR: ${ocr.language} - confidence ${ocrConfidenceLabel(ocr.confidence)}${typeof ocr.confidence === "number" ? ` (${ocr.confidence.toFixed(1)})` : ""}`,
      `Screenshot: ${result.path}`,
      result.displayName ? `Display: ${result.displayName}` : "",
    ].filter(Boolean).join("\n"));
    setDesktopStatus("Local OCR complete");

    if (
      (modelProvider === "openai" || modelProvider === "nvidia")
      && window.callpilotDesktop?.analyzeScreenshot
      && (localScreenContext.kind === "coding_problem" || localScreenContext.kind === "code_editor")
    ) {
      setDesktopStatus("Coding screen detected; analyzing screenshot with vision...");
      const analysis = await window.callpilotDesktop.analyzeScreenshot({
        path: result.path,
        provider: modelProvider,
        modelName,
        apiKey: sessionApiKey,
        nvidiaApiKey,
      });
      if (analysis.ok && analysis.text) {
        updateScreenContext(`${analysis.text}\n\nScreenshot: ${result.path}`);
        setDesktopStatus("Coding screenshot analyzed with vision");
      } else {
        setDesktopStatus(`Coding screen detected, vision analysis failed: ${analysis.error ?? "unknown"}`);
      }
    }
  }, [modelName, modelProvider, nvidiaApiKey, preferredLanguage, sessionApiKey]);

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onShortcut((action) => {
      if (action.type === "ask") {
        void ask(getManualAnswerPrompt());
      }
      if (action.type === "clear_context") clearContext();
      if (action.type === "capture_screenshot") captureScreenshot();
      if (action.type === "set_mode") setActiveMode(action.mode);
      if (action.type === "stealth") setStealth(action.state);
    });
    return () => dispose?.();
  }, [ask, captureScreenshot, clearContext, getManualAnswerPrompt]);

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onManualAnswerRequest?.(() => {
      setLiveAssistStatus("Manual answer requested");
      void ask(getManualAnswerPrompt());
    });
    return () => dispose?.();
  }, [ask, getManualAnswerPrompt]);

  React.useEffect(() => {
    const disposeHeadline = window.callpilotDesktop?.onAnswerHeadline?.((payload) => {
      const activeRunId = activeLatencyRunIdRef.current;
      if (activeRunId) {
        setLatencyRuns((current) => current.map((run) =>
          run.id === activeRunId ? markLatencyStage(run, "first_headline") : run,
        ));
      }
      const keywords = payload.keywords.length ? `\n\nKeywords: ${payload.keywords.join(", ")}` : "";
      setAnswer(`${payload.headline}${keywords}`);
    });
    const disposeDetail = window.callpilotDesktop?.onAnswerDetailChunk?.((chunk) => {
      if (typeof chunk === "object" && chunk && "requestId" in chunk) {
        const payload = chunk as { requestId?: string; text?: string; done?: boolean; cancelled?: boolean; error?: string };
        if (payload.cancelled || payload.error === "cancelled") return;
        if (payload.requestId && activeAnswerRequestIdRef.current && payload.requestId !== activeAnswerRequestIdRef.current) return;
        if (payload.done) return;
        if (typeof payload.text === "string") {
          const activeRunId = activeLatencyRunIdRef.current;
          if (activeRunId && !firstDetailChunkSeenRef.current) {
            firstDetailChunkSeenRef.current = true;
            setLatencyRuns((current) => current.map((run) =>
              run.id === activeRunId ? markLatencyStage(run, "first_token") : run,
            ));
          }
          setAnswer((current) => `${current}${payload.text}`);
        }
        return;
      }
      const activeRunId = activeLatencyRunIdRef.current;
      if (activeRunId && !firstDetailChunkSeenRef.current) {
        firstDetailChunkSeenRef.current = true;
        setLatencyRuns((current) => current.map((run) =>
          run.id === activeRunId ? markLatencyStage(run, "first_token") : run,
        ));
      }
      setAnswer((current) => `${current}${chunk}`);
    });
    return () => {
      disposeHeadline?.();
      disposeDetail?.();
    };
  }, []);

  const updateScreenContext = (value: string) => {
    setScreenText(value);
    setScreenContext(classifyScreenText(value));
  };

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onScreenContextPublished?.((payload) => {
      const nextScreenText = [
        payload.visibleText?.trim() ? payload.visibleText.trim() : "",
        payload.screenshotPath ? `Screenshot: ${payload.screenshotPath}` : "",
        payload.displayName ? `Display: ${payload.displayName}` : "",
        payload.source ? `Source: ${payload.source}` : "",
      ].filter(Boolean).join("\n");
      if (!nextScreenText.trim()) return;
      updateScreenContext(nextScreenText);
      setDesktopStatus(payload.screenshotPath
        ? "Live coding screenshot set as active screen context"
        : "Live coding screen context updated");
    });
    return () => dispose?.();
  }, []);

  React.useEffect(() => {
    const e2eEnabled = window.localStorage.getItem("callpilot_e2e_desktop_smoke") === "1";
    if (!e2eEnabled) return;
    const e2eWindow = window as unknown as {
      __callpilotE2ESetScreenText?: (value: string) => boolean;
      __callpilotE2EGetState?: () => {
        answer: string;
        screenText: string;
        transcriptText: string;
      };
    };
    e2eWindow.__callpilotE2ESetScreenText = (value: string) => {
      updateScreenContext(String(value || ""));
      return true;
    };
    e2eWindow.__callpilotE2EGetState = () => ({
      answer,
      screenText,
      transcriptText: formatFactualTranscriptText(transcript),
    });
    return () => {
      delete e2eWindow.__callpilotE2ESetScreenText;
      delete e2eWindow.__callpilotE2EGetState;
    };
  }, [answer, screenText, transcript.messages]);

  const setCallPrivacyAllowed = async (allowed: boolean) => {
    const next = window.callpilotDesktop
      ? await window.callpilotDesktop.setCallPrivacyAllowed(allowed)
      : reduceStealthState(stealth, { type: "set_call_privacy_allowed", allowed });
    setStealth(next);
  };

  const setOverlayVisible = async (visible: boolean) => {
    if (!stealth.callPrivacyAllowed && !visible) return;
    const next = window.callpilotDesktop
      ? await window.callpilotDesktop.setOverlayVisible(visible)
      : reduceStealthState(stealth, { type: "set_overlay_visible", visible });
    setStealth(next);
  };

  const setContentProtection = async (enabled: boolean) => {
    if (!stealth.callPrivacyAllowed && enabled) return;
    const next = window.callpilotDesktop
      ? await window.callpilotDesktop.setContentProtection(enabled)
      : reduceStealthState(stealth, { type: "set_content_protection", enabled });
    setStealth(next);
  };

  const togglePassthrough = async () => {
    if (!stealth.callPrivacyAllowed && !stealth.mousePassthroughEnabled) return;
    const enabled = !stealth.mousePassthroughEnabled;
    if (window.callpilotDesktop) {
      setStealth(await window.callpilotDesktop.setMousePassthrough(enabled));
      return;
    }
    setStealth((current) => reduceStealthState(current, { type: "set_mouse_passthrough", enabled }));
  };

  const applyShareSafe = async () => {
    const next = window.callpilotDesktop
      ? await window.callpilotDesktop.applyShareSafe()
      : reduceStealthState(stealth, { type: "apply_share_safe" });
    setStealth(next);
    setPrivacyCheck(assessPrivacyState(next));
    setDesktopStatus("Share Safe active");
  };

  const resetPrivacy = async () => {
    const next = window.callpilotDesktop
      ? await window.callpilotDesktop.resetPrivacy()
      : reduceStealthState(stealth, { type: "reset_privacy" });
    setStealth(next);
    setPrivacyCheck(assessPrivacyState(next));
    setDesktopStatus("Privacy reset");
  };

  const togglePrivacyPreset = async () => {
    if (stealth.callPrivacyAllowed && stealth.contentProtectionEnabled) {
      await resetPrivacy();
      setDesktopStatus("Standard mode active");
      return;
    }
    const next = window.callpilotDesktop
      ? await window.callpilotDesktop.applyShareSafe()
      : reduceStealthState(stealth, { type: "apply_share_safe" });
    setStealth(next);
    setPrivacyCheck(null);
    setDesktopStatus("Protected sharing mode active");
  };

  const runPrivacyCheck = async () => {
    const result = window.callpilotDesktop?.runPrivacyCheck
      ? await window.callpilotDesktop.runPrivacyCheck()
      : assessPrivacyState(stealth);
    setPrivacyCheck(result);
    setDesktopStatus(`Privacy check: ${result.status}`);
  };

  const saveSessionKey = async () => {
    if (!window.callpilotDesktop?.saveOpenAIKey) {
      setCredentialMessage("Key storage requires desktop mode");
      return;
    }
    const status = await window.callpilotDesktop.saveOpenAIKey(sessionApiKey);
    applyCredentialStatus(status);
    setCredentialMessage(status.ok ? "OpenAI key saved encrypted on this device" : `Could not save key: ${status.error ?? "unknown"}`);
    if (status.ok) setSessionApiKey("");
  };

  const clearStoredKey = async () => {
    if (!window.callpilotDesktop?.clearOpenAIKey) return;
    const status = await window.callpilotDesktop.clearOpenAIKey();
    applyCredentialStatus(status);
    setCredentialMessage(status.ok ? "Stored OpenAI key cleared" : `Could not clear key: ${status.error ?? "unknown"}`);
  };

  const saveNativelySessionKey = async () => {
    if (!window.callpilotDesktop?.saveNativelyKey) {
      setCredentialMessage("Natively key storage requires desktop mode");
      return;
    }
    const status = await window.callpilotDesktop.saveNativelyKey(nativelyApiKey);
    applyCredentialStatus(status);
    setCredentialMessage(status.ok ? "Natively key saved encrypted on this device" : `Could not save Natively key: ${status.error ?? "unknown"}`);
    if (status.ok) {
      setNativelyApiKey("");
      if (liveTranscriptionProvider === "natively" && (modelProvider === "ollama" || modelProvider === "mock")) {
        setModelProvider("natively");
        if (!modelName || modelName === "llama3.1" || modelName.startsWith("llama3.1:") || modelName === "mock-local") {
          setModelName("default");
        }
        setLiveAssistStatus("Answer engine switched to Natively");
      }
    }
  };

  const clearStoredNativelyKey = async () => {
    if (!window.callpilotDesktop?.clearNativelyKey) return;
    const status = await window.callpilotDesktop.clearNativelyKey();
    applyCredentialStatus(status);
    setCredentialMessage(status.ok ? "Stored Natively key cleared" : `Could not clear Natively key: ${status.error ?? "unknown"}`);
  };

  const saveDeepgramSessionKey = async () => {
    if (!window.callpilotDesktop?.saveDeepgramKey) {
      setCredentialMessage("Deepgram key storage requires desktop mode");
      return;
    }
    const status = await window.callpilotDesktop.saveDeepgramKey(deepgramApiKey);
    applyCredentialStatus(status);
    setCredentialMessage(status.ok ? "Deepgram key saved encrypted on this device" : `Could not save Deepgram key: ${status.error ?? "unknown"}`);
    if (status.ok) {
      setDeepgramApiKey("");
      setLiveTranscriptionProvider("deepgram");
      setLiveAssistStatus("Live transcription switched to Deepgram");
    }
  };

  const clearStoredDeepgramKey = async () => {
    if (!window.callpilotDesktop?.clearDeepgramKey) return;
    const status = await window.callpilotDesktop.clearDeepgramKey();
    applyCredentialStatus(status);
    setCredentialMessage(status.ok ? "Stored Deepgram key cleared" : `Could not clear Deepgram key: ${status.error ?? "unknown"}`);
  };

  const saveNvidiaSessionKey = async () => {
    if (!window.callpilotDesktop?.saveNvidiaKey) {
      setCredentialMessage("NVIDIA key storage requires desktop mode");
      return;
    }
    const status = await window.callpilotDesktop.saveNvidiaKey(nvidiaApiKey);
    applyCredentialStatus(status);
    setCredentialMessage(status.ok ? "NVIDIA key saved encrypted on this device" : `Could not save NVIDIA key: ${status.error ?? "unknown"}`);
    if (status.ok) {
      setNvidiaApiKey("");
      setModelProvider("nvidia");
      if (!modelName || modelName === "mock-local" || modelName === "default" || modelName === "nvidia-default" || modelName === "llama3.1" || modelName.startsWith("llama3.1:")) {
        setModelName(NVIDIA_MODEL_PRESETS[0]);
      }
      setLiveAssistStatus("Answer engine switched to NVIDIA");
    }
  };

  const clearStoredNvidiaKey = async () => {
    if (!window.callpilotDesktop?.clearNvidiaKey) return;
    const status = await window.callpilotDesktop.clearNvidiaKey();
    applyCredentialStatus(status);
    setCredentialMessage(status.ok ? "Stored NVIDIA key cleared" : `Could not clear NVIDIA key: ${status.error ?? "unknown"}`);
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="eyebrow">CallPilot V0</span>
          <h1>Interview assistant</h1>
          <p>Paste your context, listen to the call, and get grounded answers when a question appears.</p>
        </div>
        <div className="health-row" aria-label="Current app status">
          <span className={isDictating ? "health-chip good" : "health-chip"}>{listeningLabel}</span>
          <span className="health-chip">{providerLabel}</span>
          <span className={answerWarmupChipClass} title={answerWarmupHealth.detail}>{answerWarmupHealth.label}</span>
          <span className="health-chip">{languageLabel}</span>
          <span className={stealth.callPrivacyAllowed ? "health-chip good" : "health-chip warn"}>{privacyLabel}</span>
        </div>
      </header>

      <nav className="tabs" aria-label="Main sections">
        <button className={activeTab === "meeting" ? "tab active" : "tab"} onClick={() => setActiveTab("meeting")}>
          <Mic size={16} />
          Meeting
        </button>
        <button className={activeTab === "context" ? "tab active" : "tab"} onClick={() => setActiveTab("context")}>
          <BriefcaseBusiness size={16} />
          Context
        </button>
        <button className={activeTab === "config" ? "tab active" : "tab"} onClick={() => setActiveTab("config")}>
          <Shield size={16} />
          Config
        </button>
      </nav>

      {privacyCheck && (
        <section className={`privacy-check privacy-${privacyCheck.status}`}>
          <strong>{privacyCheck.status}</strong>
          <span>{privacyCheck.summary}</span>
        </section>
      )}

      {activeTab === "meeting" && (
        <section className="tab-page interview-layout">
          <section className="panel interview-launch-panel">
            <div className="section-head">
              <div>
                <span className="eyebrow">Interview launch</span>
                <h2>Choose the setup for this call</h2>
              </div>
              <span className={briefStats.ready ? "ready-pill ready" : "ready-pill"}>
                {briefStats.ready ? "Context ready" : `${briefStats.filled}/5 context fields`}
              </span>
            </div>
            <div className="setup-card-list">
              {INTERVIEW_SETUPS.map((setup) => (
                <button
                  key={setup.id}
                  type="button"
                  className={selectedSetup === setup.id ? "setup-card active" : "setup-card"}
                  onClick={() => applyInterviewSetup(setup.id)}
                >
                  <strong>{setup.title}</strong>
                  <span>{setup.description}</span>
                </button>
              ))}
            </div>
            <div className="privacy-preset">
              <div>
                <strong>{stealth.callPrivacyAllowed && stealth.contentProtectionEnabled ? "Private call mode" : "Standard mode"}</strong>
                <span>One click enables the authorized-call preset: protected overlay, always-on-top window, shortcuts, and local capture protection where the OS supports it.</span>
              </div>
              <button className={stealth.callPrivacyAllowed && stealth.contentProtectionEnabled ? "status active" : "status"} onClick={togglePrivacyPreset}>
                <ShieldCheck size={16} />
                {stealth.callPrivacyAllowed && stealth.contentProtectionEnabled ? "Private on" : "Enable private"}
              </button>
            </div>
            <div className="primary-actions">
              <button className="primary" onClick={startSession}>
                <MonitorUp size={18} />
                Start interview overlay
              </button>
              {selectedSetup === "live_coding" && (
                <button className="status" onClick={() => void ask(getManualAnswerPrompt())} disabled={isGenerating}>
                  <Sparkles size={16} />
                  Answer
                </button>
              )}
              {selectedSetup === "live_coding" && (
                <button className="status" onClick={resetLiveCodingExercise}>
                  <RotateCcw size={16} />
                  New exercise
                </button>
              )}
              <button className="status" onClick={resetFullSession}>
                <Trash2 size={16} />
                New session
              </button>
              {isGenerating && (
                <button className="status" onClick={cancelAnswer}>
                  <Square size={16} />
                  Stop answer
                </button>
              )}
            </div>
            {selectedSetup === "live_coding" && (
              <form
                className="follow-up-change"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitFollowUpChange();
                }}
              >
                <input
                  value={followUpChange}
                  onChange={(event) => setFollowUpChange(event.target.value)}
                  placeholder="Request a change to the current solution..."
                  disabled={!currentCodingPayload?.solution.code.trim() || isGenerating}
                />
                <button type="submit" disabled={!followUpChange.trim() || !currentCodingPayload?.solution.code.trim() || isGenerating}>
                  <RefreshCw size={16} />
                  Apply change
                </button>
              </form>
            )}
            <div className="launch-includes">
              <span><Mic size={14} /> Starts listening</span>
              <span><Sparkles size={14} /> Auto-answer off by default</span>
              {selectedSetup === "live_coding" && <span><ScanText size={14} /> Uses screen context for coding</span>}
            </div>
            <div className="quick-status">
              <span>{liveAssistStatus}</span>
              <span>{answerWarmupHealth.label}: {answerWarmupHealth.detail}</span>
              <span>{livePlan.engineLabel}: {livePlan.implemented ? `${livePlan.expectedLatency}, ${livePlan.quality}` : "configured, not connected"}</span>
              <span>{desktopStatus}</span>
            </div>
          </section>

        </section>
      )}

      {activeTab === "context" && (
        <section className="tab-page context-layout">
          <section className="panel brief-panel">
            <div className="section-head">
              <div>
                <span className="eyebrow">Interview context</span>
                <h2>What CallPilot should remember</h2>
              </div>
              <span className={briefStats.ready ? "ready-pill ready" : "ready-pill"}>{briefStats.ready ? "Ready" : `${briefStats.filled}/5 filled`}</span>
            </div>
            <div className="brief-grid">
              <label>
                Company
                <input value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder="Ebury" />
              </label>
              <label>
                Role
                <input value={roleTitle} onChange={(event) => setRoleTitle(event.target.value)} placeholder="Backend Engineer" />
              </label>
            </div>
            <label>
              CV / resume
              <small>Paste your real experience, projects, tools, metrics, and responsibilities.</small>
              <textarea value={resumeText} onChange={(event) => setResumeText(event.target.value)} placeholder="Paste your CV here..." />
            </label>
            <label>
              STAR stories
              <small>Paste examples with Situation, Task, Action, Result. These are used to answer behavioral and tradeoff questions.</small>
              <textarea value={starStories} onChange={(event) => setStarStories(event.target.value)} placeholder="Example: I chose PostgreSQL because consistency and auditability mattered..." />
            </label>
            <label>
              Job description
              <small>Paste the vacancy so answers match the company language and requirements.</small>
              <textarea value={jobDescription} onChange={(event) => setJobDescription(event.target.value)} placeholder="Paste the role description..." />
            </label>
            <label>
              Notes
              <small>Anything extra: interviewer names, topics to emphasize, or constraints.</small>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Extra notes..." />
            </label>
          </section>

          <section className="panel sessions-panel">
            <div className="section-head">
              <div>
                <span className="eyebrow">Saved sessions</span>
                <h2>{sessionLibrary.length} saved</h2>
              </div>
              <div className="button-row compact">
                <button onClick={saveToLibrary}>Save</button>
                <button onClick={exportSession}>Export</button>
                <button onClick={importSession}>Import</button>
              </div>
            </div>
            {sessionMessage && <span className="helper good">{sessionMessage}</span>}
            <div className="session-list">
              {sessionLibrary.length === 0 ? (
                <span>No saved sessions yet.</span>
              ) : (
                sessionLibrary.slice(0, 8).map((session) => (
                  <div className="session-item" key={session.id}>
                    <button onClick={() => loadFromLibrary(session)}>
                      <strong>{session.title}</strong>
                      <span>{session.activeMode.replaceAll("_", " ")} - {new Date(session.updatedAt).toLocaleString()}</span>
                    </button>
                    <button aria-label="Delete session" onClick={() => deleteFromLibrary(session.id)}><Trash2 size={14} /></button>
                  </div>
                ))
              )}
            </div>
          </section>
        </section>
      )}

      {activeTab === "config" && (
        <section className="tab-page config-layout">
          <section className="panel">
            <div className="section-head">
              <div>
                <span className="eyebrow">Auto check</span>
                <h2>What works on this machine</h2>
              </div>
              <button type="button" onClick={runAutoChecks}>
                <RefreshCw size={16} />
                Run checks
              </button>
            </div>
            <p className="muted">{autoCheckStatus}</p>
            <div className="check-list">
              {autoChecks.length === 0 ? (
                <span>No checks have run yet.</span>
              ) : (
                autoChecks.map((check) => (
                  <div className={`check-item check-${check.status}`} key={check.label}>
                    <strong>{check.label}</strong>
                    <span>{check.detail}</span>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel">
            <div className="section-head">
              <div>
                <span className="eyebrow">Simple setup</span>
                <h2>Answer style</h2>
              </div>
            </div>
            <div className="mode-list">
              {MODES.map((mode) => (
                <button key={mode.id} className={activeMode === mode.id ? "mode active" : "mode"} onClick={() => setActiveMode(mode.id)}>
                  <strong>{mode.label}</strong>
                  <span>{mode.description}</span>
                </button>
              ))}
            </div>
            <div className="settings-grid">
              <label>
                Answer engine
                <small>Transcription and answers are separate. Use Natively for testing, or swap to any supported LLM.</small>
                <select value={modelProvider} onChange={(event) => updateModelProvider(event.target.value as ModelProvider)}>
                  <option value="mock">Demo</option>
                  <option value="natively">Natively</option>
                  <option value="nvidia">NVIDIA</option>
                  <option value="openai">OpenAI</option>
                  <option value="ollama">Ollama local</option>
                </select>
              </label>
              <label>
                Model
                <small>{modelProvider === "ollama" ? "Choose one of your installed local Ollama models." : modelProvider === "natively" ? "Natively answer model or default if your account chooses it." : modelProvider === "nvidia" ? "NVIDIA NIM model name. Pick a preset or paste a model id from build.nvidia.com." : "The model that writes the answer."}</small>
                {modelProvider === "ollama" && ollamaModels.length > 0 ? (
                  <select value={modelName} onChange={(event) => setModelName(event.target.value)}>
                    {ollamaModels.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                ) : modelProvider === "nvidia" ? (
                  <>
                    <select
                      value={(nvidiaModels.length > 0 ? nvidiaModels : NVIDIA_MODEL_PRESETS).includes(modelName) ? modelName : "custom"}
                      onChange={(event) => {
                        if (event.target.value !== "custom") setModelName(event.target.value);
                      }}
                    >
                      {(nvidiaModels.length > 0 ? nvidiaModels : NVIDIA_MODEL_PRESETS).map((name) => <option key={name} value={name}>{name}</option>)}
                      <option value="custom">Custom model id</option>
                    </select>
                    <input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder={NVIDIA_MODEL_PRESETS[0]} />
                  </>
                ) : (
                  <input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder={modelProvider === "ollama" ? "Example: llama3.1:8b" : modelProvider === "natively" ? "default" : undefined} />
                )}
              </label>
              {modelProvider === "ollama" && (
                <label>
                  Ollama URL
                  <small>Usually this stays as localhost unless you changed Ollama.</small>
                  <input value={ollamaBaseUrl} onChange={(event) => setOllamaBaseUrl(event.target.value)} placeholder={DEFAULT_OLLAMA_BASE_URL} />
                </label>
              )}
              {modelProvider === "ollama" && (
                <div className="setting-note">
                  <span>{ollamaStatus}</span>
                  <button type="button" onClick={() => refreshOllamaModels({ selectFirst: true })}>
                    <RefreshCw size={16} />
                    Detect models
                  </button>
                </div>
              )}
              {modelProvider === "nvidia" && (
                <div className="setting-note">
                  <span>{nvidiaStatus}</span>
                  <button type="button" onClick={() => refreshNvidiaModels({ selectFirst: true })}>
                    <RefreshCw size={16} />
                    Detect models
                  </button>
                </div>
              )}
              <label>
                Language
                <small>Auto follows the detected interview language.</small>
                <select value={preferredLanguage} onChange={(event) => setPreferredLanguage(event.target.value as "english" | "spanish" | "auto")}>
                  <option value="auto">Auto</option>
                  <option value="english">English</option>
                  <option value="spanish">Spanish</option>
                </select>
              </label>
              <label>
                Answer length
                <small>Short is best while speaking live. Detailed is better for prep.</small>
                <select value={answerVerbosity} onChange={(event) => setAnswerVerbosity(event.target.value as "short" | "medium" | "detailed")}>
                  <option value="short">Short</option>
                  <option value="medium">Medium</option>
                  <option value="detailed">Detailed</option>
                </select>
              </label>
              <label>
                Coding language
                <small>Used for live coding answers and examples.</small>
                <select value={codingLanguage} onChange={(event) => setCodingLanguage(event.target.value)}>
                  <option>Python</option>
                  <option>JavaScript</option>
                  <option>TypeScript</option>
                  <option>Java</option>
                  <option>C++</option>
                </select>
              </label>
            </div>
          </section>

          <section className="panel">
            <div className="section-head">
              <div>
                <span className="eyebrow">Live listening</span>
                <h2>Transcription</h2>
              </div>
            </div>
            <div className="settings-grid">
              <label>
                Live transcription
                <small>Local Whisper works without API keys. Browser live only listens to the microphone.</small>
                <select value={liveTranscriptionProvider} onChange={(event) => setLiveTranscriptionProvider(event.target.value as LiveTranscriptionProvider)}>
                  <option value="browser">Browser live</option>
                  <option value="openai_realtime" disabled={!hasOpenAITranscriptionKey}>OpenAI live chunks</option>
                  <option value="deepgram">Deepgram realtime</option>
                  <option value="local">Local Whisper</option>
                </select>
              </label>
              <label>
                Deepgram API key
                <small>Realtime streaming STT key. Stored encrypted when desktop key storage is available.</small>
                <input type="password" value={deepgramApiKey} onChange={(event) => setDeepgramApiKey(event.target.value)} placeholder="Optional if DEEPGRAM_API_KEY is set before launch" />
              </label>
              <div className="button-row">
                <button onClick={saveDeepgramSessionKey} disabled={!deepgramApiKey.trim()}>Save Deepgram key</button>
                <button onClick={clearStoredDeepgramKey} disabled={!hasStoredDeepgramKey}>Clear Deepgram key</button>
                <span className={hasDeepgramTranscriptionKey ? "helper good" : "helper"}>
                  {hasStoredDeepgramKey ? "Stored Deepgram key available" : hasEnvDeepgramKey ? "Deepgram key loaded from environment" : "No Deepgram key found"}
                </span>
              </div>
              {liveTranscriptionProvider === "deepgram" && (
                <div className="setting-note">
                  <span>Deepgram streams PCM over WebSocket with Nova-3, interim results, and English, Spanish, or multilingual recognition.</span>
                </div>
              )}
              <label>
                Listen to
                <small>Automatic conversation listens to the meeting audio and your microphone.</small>
                <select value={liveAudioSource} onChange={(event) => setLiveAudioSource(event.target.value as LiveAudioSource)}>
                  <option value="both">Automatic conversation</option>
                  <option value="system">Computer audio only</option>
                  <option value="microphone">Microphone only</option>
                </select>
              </label>
              {(liveAudioSource === "system" || liveAudioSource === "both") && (
                <div className="setting-note">
                  <span>CallPilot will try to capture meeting audio automatically. If the system blocks computer audio, it keeps listening to the microphone and shows a warning.</span>
                </div>
              )}
              {!hasOpenAITranscriptionKey && (
                <div className="setting-note">
                  <span>OpenAI live chunks is disabled because no OpenAI key is saved. Deepgram realtime is the recommended streaming transcription provider.</span>
                </div>
              )}
              {browserSpeechRuntimeError && (
                <div className="setting-note">
                  <span>Browser live failed with: {browserSpeechRuntimeError}. Use Deepgram realtime for streaming transcription.</span>
                  <button type="button" onClick={() => setBrowserSpeechRuntimeError("")}>
                    <RefreshCw size={16} />
                    Retry browser live
                  </button>
                </div>
              )}
              <div className="setting-note">
                <span>{localSttStatus}</span>
                <button type="button" onClick={testLocalWhisper}>
                  <RefreshCw size={16} />
                  Test Local Whisper
                </button>
              </div>
              <label>
                Speed preset
                <small>Fast answers sooner. Accurate waits for cleaner speech.</small>
                <select value={liveLatencyPreset} onChange={(event) => setLiveLatencyPreset(event.target.value as LiveLatencyPreset)}>
                  <option value="fast">Fast</option>
                  <option value="balanced">Balanced</option>
                  <option value="accurate">Accurate</option>
                </select>
              </label>
              <label>
                Auto-answer delay
                <small>Minimum seconds between automatic answers.</small>
                <input type="number" min={3} max={60} value={Math.round(autoAnswerCooldownMs / 1000)} onChange={(event) => setAutoAnswerCooldownMs(Number(event.target.value) * 1000)} />
              </label>
              <label>
                Question sensitivity
                <small>Higher means fewer accidental answers.</small>
                <input type="number" min={0.25} max={0.95} step={0.05} value={autoAnswerMinConfidence} onChange={(event) => setAutoAnswerMinConfidence(Number(event.target.value))} />
              </label>
              <label>
                Recording model
                <small>Used by manual microphone recording in desktop mode.</small>
                <input value={transcriptionModelName} onChange={(event) => setTranscriptionModelName(event.target.value)} />
              </label>
              <label>
                Use case
                <small>Plain description of what this session is for.</small>
                <input value={targetUseCase} onChange={(event) => setTargetUseCase(event.target.value)} />
              </label>
            </div>
            <div className="button-row">
              <button className={isRecordingMic ? "status active" : "status"} onClick={toggleMicRecording}>
                {isRecordingMic ? <Square size={16} /> : <Mic size={16} />}
                {isRecordingMic ? "Stop mic recording" : "Record mic once"}
              </button>
              <span className="helper">{shortcutStatus}</span>
            </div>
          </section>

          <section className="panel">
            <div className="section-head">
              <div>
                <span className="eyebrow">Privacy preset</span>
                <h2>One-click call mode</h2>
              </div>
            </div>
            <p className="muted">Enable this only for an authorized call setup. It turns on the local overlay privacy posture without making you manage each switch.</p>
            <div className="privacy-actions">
              <button className={stealth.callPrivacyAllowed && stealth.contentProtectionEnabled ? "status active" : "status"} onClick={togglePrivacyPreset}>
                <ShieldCheck size={16} />
                {stealth.callPrivacyAllowed && stealth.contentProtectionEnabled ? "Private call mode on" : "Enable private call mode"}
              </button>
              <button className="status" onClick={resetPrivacy}>
                <RotateCcw size={16} />
                Standard mode
              </button>
            </div>
            <details className="advanced-inline">
              <summary>Advanced privacy controls</summary>
              <div className="privacy-actions">
                <button className={stealth.callPrivacyAllowed ? "status active" : "status"} onClick={() => setCallPrivacyAllowed(!stealth.callPrivacyAllowed)}>
                  <ShieldCheck size={16} />
                  {stealth.callPrivacyAllowed ? "Approved" : "Not approved"}
                </button>
                <button className={stealth.overlayVisible ? "status active" : "status"} onClick={() => setOverlayVisible(!stealth.overlayVisible)} disabled={!stealth.callPrivacyAllowed}>
                  {stealth.overlayVisible ? <Eye size={16} /> : <EyeOff size={16} />}
                  {stealth.overlayVisible ? "Visible" : "Hidden"}
                </button>
                <button className={stealth.contentProtectionEnabled ? "status active" : "status"} onClick={() => setContentProtection(!stealth.contentProtectionEnabled)} disabled={!stealth.callPrivacyAllowed}>
                  <Shield size={16} />
                  Protected
                </button>
                <button className={stealth.mousePassthroughEnabled ? "status active" : "status"} onClick={togglePassthrough} disabled={!stealth.callPrivacyAllowed}>
                  <MousePointer2 size={16} />
                  Passthrough
                </button>
                <button className={stealth.callPrivacyAllowed && !stealth.overlayVisible && stealth.contentProtectionEnabled ? "status active" : "status"} onClick={applyShareSafe}>
                  <ShieldCheck size={16} />
                  Reapply protected mode
                </button>
                <button className={privacyCheck?.status === "safe" ? "status active" : "status"} onClick={runPrivacyCheck}>
                  <Radar size={16} />
                  Check
                </button>
              </div>
            </details>
          </section>

          {modelProvider === "openai" && (
            <section className="panel">
              <div className="section-head">
                <div>
                  <span className="eyebrow">OpenAI key</span>
                  <h2>Local credential</h2>
                </div>
              </div>
              <label>
                Session API key
                <small>Stored encrypted on this device when desktop key storage is available.</small>
                <input type="password" value={sessionApiKey} onChange={(event) => setSessionApiKey(event.target.value)} placeholder="Optional if OPENAI_API_KEY is set before launch" />
              </label>
              <div className="button-row">
                <button onClick={saveSessionKey} disabled={!sessionApiKey.trim()}>Save encrypted</button>
                <button onClick={clearStoredKey} disabled={!hasStoredOpenAIKey}>Clear saved</button>
              </div>
              <span className={hasOpenAITranscriptionKey ? "helper good" : "helper"}>
                {hasStoredOpenAIKey ? "Stored OpenAI key available" : hasEnvOpenAIKey ? "OpenAI key loaded from .env" : credentialMessage || "No OpenAI key found"}
              </span>
            </section>
          )}

          {modelProvider === "nvidia" && (
            <section className="panel">
              <div className="section-head">
                <div>
                  <span className="eyebrow">NVIDIA key</span>
                  <h2>NIM answer engine</h2>
                </div>
              </div>
              <label>
                NVIDIA API key
                <small>Used only for NVIDIA answer generation. You can also launch with NVIDIA_API_KEY or CALLPILOT_NVIDIA_API_KEY.</small>
                <input type="password" value={nvidiaApiKey} onChange={(event) => setNvidiaApiKey(event.target.value)} placeholder="nvapi-..." />
              </label>
              <div className="button-row">
                <button onClick={saveNvidiaSessionKey} disabled={!nvidiaApiKey.trim()}>Save NVIDIA key</button>
                <button onClick={clearStoredNvidiaKey} disabled={!hasStoredNvidiaKey}>Clear NVIDIA key</button>
              </div>
              <span className={hasNvidiaAnswerKey ? "helper good" : "helper"}>
                {hasStoredNvidiaKey ? "Stored NVIDIA key available" : hasEnvNvidiaKey ? "NVIDIA key loaded from .env" : hasNvidiaAnswerKey ? "NVIDIA key available for answers" : credentialMessage || "No NVIDIA key found"}
              </span>
            </section>
          )}

          <section className="panel debug-panel">
            <details>
              <summary>Advanced details</summary>
              <div className="debug-grid">
                <div>
                  <div className="mini-title"><FileText size={14} /> Context</div>
                  <pre>{JSON.stringify(context, null, 2)}</pre>
                </div>
                <div>
                  <div className="mini-title">Prompt debug</div>
                  <pre>{JSON.stringify(lastPrompt.debug, null, 2)}</pre>
                </div>
                <div>
                  <div className="mini-title">Latency</div>
                  <pre>{JSON.stringify(latencyRuns, null, 2)}</pre>
                </div>
              </div>
            </details>
          </section>
        </section>
      )}
    </main>
  );

}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.hash === "#/overlay" ? <OverlayApp /> : window.location.hash === "#/coding" ? <CodingOverlayApp /> : <App />}
  </React.StrictMode>,
);
