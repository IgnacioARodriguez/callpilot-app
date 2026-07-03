import React from "react";
import ReactDOM from "react-dom/client";
import { BriefcaseBusiness, Copy, Eye, EyeOff, FileText, Mic, MousePointer2, Pause, Play, Radar, RefreshCw, RotateCcw, ScanText, Send, Shield, ShieldCheck, Sparkles, Square, Trash2 } from "lucide-react";
import {
  CURRENT_SESSION_KEY,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_TRANSCRIPTION_MODEL,
  MODES,
  SESSION_LIBRARY_KEY,
  TranscriptBuffer,
  browserRecognitionLanguage,
  buildPrompt,
  classifyScreenText,
  createGlobalContext,
  createSessionSnapshot,
  defaultStealthState,
  assessPrivacyState,
  detectQuestionIntent,
  liveTranscriptionPlan,
  normalizeLiveTranscriptionSettings,
  normalizeOcrLanguage,
  ocrConfidenceLabel,
  modeById,
  parseSessionJson,
  pruneRecentSpeech,
  reduceStealthState,
  shouldDropCandidateEcho,
  shouldAutoAnswer,
  serializeSession,
  upsertSession,
  type AssistantModeId,
  type GlobalContext,
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
} from "./core";
import "./styles.css";

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
  const [activeTab, setActiveTab] = React.useState<"meeting" | "context" | "config">("meeting");
  const [activeMode, setActiveMode] = React.useState<AssistantModeId>(savedSession.activeMode ?? "live_coding");
  const [transcript, setTranscript] = React.useState<TranscriptSnapshot>(() => savedSession.transcript ?? new TranscriptBuffer().snapshot());
  const [screenText, setScreenText] = React.useState(savedSession.screenText ?? "");
  const [screenContext, setScreenContext] = React.useState<ScreenContext>(() => classifyScreenText(savedSession.screenText ?? ""));
  const [transcriptDraft, setTranscriptDraft] = React.useState("");
  const [isDictating, setIsDictating] = React.useState(false);
  const [autoAnswerEnabled, setAutoAnswerEnabled] = React.useState(false);
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
  const [modelName, setModelName] = React.useState(savedSession.modelName ?? "gpt-5.5");
  const [ollamaBaseUrl, setOllamaBaseUrl] = React.useState(DEFAULT_OLLAMA_BASE_URL);
  const [ollamaModels, setOllamaModels] = React.useState<string[]>([]);
  const [ollamaStatus, setOllamaStatus] = React.useState("Ollama models not checked yet");
  const [transcriptionModelName, setTranscriptionModelName] = React.useState<string>(DEFAULT_TRANSCRIPTION_MODEL);
  const [liveTranscriptionProvider, setLiveTranscriptionProvider] = React.useState<LiveTranscriptionProvider>("local");
  const [liveLatencyPreset, setLiveLatencyPreset] = React.useState<LiveLatencyPreset>("balanced");
  const [liveAudioSource, setLiveAudioSource] = React.useState<LiveAudioSource>("both");
  const [autoAnswerCooldownMs, setAutoAnswerCooldownMs] = React.useState(12000);
  const [autoAnswerMinConfidence, setAutoAnswerMinConfidence] = React.useState(0.45);
  const [sessionApiKey, setSessionApiKey] = React.useState("");
  const [hasStoredOpenAIKey, setHasStoredOpenAIKey] = React.useState(false);
  const [credentialMessage, setCredentialMessage] = React.useState("");
  const [isRecordingMic, setIsRecordingMic] = React.useState(false);
  const [recordingStatus, setRecordingStatus] = React.useState("");
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [question, setQuestion] = React.useState(savedSession.question ?? "");
  const [answer, setAnswer] = React.useState(savedSession.answer ?? "");
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
  const recentSpeechRef = React.useRef<RecentSpeech[]>([]);
  const liveChunkBusyRef = React.useRef(false);
  const liveContinueRef = React.useRef(false);
  const localSegmentChunksRef = React.useRef<BlobPart[]>([]);
  const localSegmentTimerRef = React.useRef<number | null>(null);
  const autoCheckRanRef = React.useRef(false);
  const localSttPipelineRef = React.useRef<Promise<unknown> | null>(null);

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

  const providerLabel = modelProvider === "ollama" ? "Local" : modelProvider === "openai" ? "OpenAI" : "Demo";
  const languageLabel = preferredLanguage === "spanish" ? "Spanish" : preferredLanguage === "english" ? "English" : "Auto";
  const listeningLabel = isDictating ? "Listening" : "Stopped";
  const privacyLabel = stealth.callPrivacyAllowed ? "Approved" : "Not approved";
  const hasOpenAITranscriptionKey = hasStoredOpenAIKey || Boolean(sessionApiKey.trim());
  const speakerLabel = (speaker?: TranscriptSpeaker) => {
    if (speaker === "candidate") return "Me";
    if (speaker === "assistant") return "CallPilot";
    if (speaker === "interviewer") return "Interviewer";
    return "Unknown";
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
      const next = new TranscriptBuffer(current);
      next.append(text, source, Date.now(), speaker);
      return next.snapshot();
    });
  }, []);

  const appendAssistantTranscriptLine = React.useCallback((text: string) => {
    if (!text.trim()) return;
    setTranscript((current) => {
      const next = new TranscriptBuffer(current);
      next.append(text, "manual", Date.now(), "assistant");
      return next.snapshot();
    });
  }, []);

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
        const savedProvider = settings.liveTranscriptionProvider ?? "local";
        const savedAudioSource = settings.liveAudioSource ?? "both";
        const shouldUpgradeOldLiveDefaults = savedProvider === "browser" && savedAudioSource === "microphone";
        setLiveTranscriptionProvider(shouldUpgradeOldLiveDefaults ? "local" : savedProvider);
        setLiveLatencyPreset(settings.liveLatencyPreset ?? "balanced");
        setLiveAudioSource(shouldUpgradeOldLiveDefaults ? "both" : savedAudioSource);
        setAutoAnswerCooldownMs(settings.autoAnswerCooldownMs ?? 12000);
        setAutoAnswerMinConfidence(settings.autoAnswerMinConfidence ?? 0.45);
      })
      .catch(() => {});

    window.callpilotDesktop?.getCredentialStatus()
      .then((status) => {
        setHasStoredOpenAIKey(status.hasOpenAIKey);
        setCredentialMessage(status.encryptionAvailable ? "Encrypted key storage ready" : "Encrypted key storage unavailable");
      })
      .catch(() => {});

    window.callpilotDesktop?.getShortcutHealth()
      .then((health) => {
        const failed = health.filter((item) => !item.registered);
        setShortcutStatus(failed.length === 0 ? `${health.length} shortcuts registered` : `${failed.length} shortcuts failed`);
      })
      .catch(() => {});
  }, []);

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
      setLiveTranscriptionProvider("browser");
      setLiveAssistStatus("OpenAI live chunks disabled because no OpenAI key is saved");
    }
  }, [hasOpenAITranscriptionKey, liveTranscriptionProvider]);

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
    liveRecorderRef.current?.stop();
    liveStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  React.useEffect(() => {
    const session = createSessionSnapshot({
      id: savedSession.id,
      title: savedSession.title,
      createdAt: savedSession.createdAt,
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
    });
    window.localStorage.setItem(CURRENT_SESSION_KEY, JSON.stringify(session));
  }, [
    activeMode,
    answer,
    answerVerbosity,
    codingLanguage,
    companyName,
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
    starStories,
    targetUseCase,
    transcript,
  ]);

  const ask = React.useCallback(async (questionOverride?: string) => {
    const effectiveQuestion = questionOverride ?? question;
    if (questionOverride !== undefined) setQuestion(questionOverride);
    const builtPrompt = buildPrompt(context, effectiveQuestion);
    setLastPrompt(builtPrompt);
    setIsGenerating(true);

    try {
      if (modelProvider === "mock") {
        const text = formatMockAnswer(context, effectiveQuestion);
        setAnswer(text);
        appendAssistantTranscriptLine(text);
        return;
      }

      if (!window.callpilotDesktop?.generateAnswer) {
        const text = "Desktop generation requires the desktop app so provider calls stay outside the browser sandbox.";
        setAnswer(text);
        appendAssistantTranscriptLine(text);
        return;
      }

      const result = await window.callpilotDesktop.generateAnswer({
        provider: modelProvider,
        modelName,
        prompt: builtPrompt,
        apiKey: sessionApiKey,
        ollamaBaseUrl,
      });
      const text = result.ok ? result.text : `Generation failed: ${result.error ?? "unknown error"}`;
      setAnswer(text);
      appendAssistantTranscriptLine(text);
    } finally {
      setIsGenerating(false);
    }
  }, [appendAssistantTranscriptLine, context, modelName, modelProvider, ollamaBaseUrl, question, sessionApiKey]);

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
    setTranscriptDraft("");
    window.localStorage.removeItem(CURRENT_SESSION_KEY);
  }, [transcript]);

  const handleFinalTranscript = React.useCallback((text: string, source: "manual" | "stt" = "stt", speaker: TranscriptSpeaker = "interviewer") => {
    const normalized = text.trim();
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
    if (!autoAnswerEnabled) {
      setLiveAssistStatus(detection.shouldAnswer ? `Question detected (${detection.confidence.toFixed(2)})` : "Listening");
      return;
    }
    if (shouldAutoAnswer(detection, now, lastAutoAnsweredAtRef.current, liveSettings.autoAnswerCooldownMs, liveSettings.autoAnswerMinConfidence)) {
      lastAutoAnsweredAtRef.current = now;
      setLiveAssistStatus(`Auto answering (${detection.confidence.toFixed(2)})`);
      void ask(detection.normalizedText);
      return;
    }
    setLiveAssistStatus(detection.shouldAnswer ? "Question detected, cooldown active" : "Listening");
  }, [appendTranscriptLine, ask, autoAnswerEnabled, liveSettings.autoAnswerCooldownMs, liveSettings.autoAnswerMinConfidence, preferredLanguage]);

  const stopLiveRecording = () => {
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
    localSegmentChunksByIdRef.current.clear();
    localSttBusyByIdRef.current.clear();
    liveRecorderRef.current?.stop();
    liveRecorderRef.current = null;
    liveStreamRef.current?.getTracks().forEach((track) => track.stop());
    liveStreamRef.current = null;
    liveChunkBusyRef.current = false;
    localSegmentChunksRef.current = [];
    setIsDictating(false);
    setLiveAssistStatus("Live assist idle");
  };

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
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const audioTracks = displayStream.getAudioTracks();
      displayStream.getVideoTracks().forEach((track) => track.stop());
      if (audioTracks.length === 0) {
        displayStream.getTracks().forEach((track) => track.stop());
        throw new Error("system_audio_not_shared");
      }
      return new MediaStream(audioTracks);
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

  const transcribeLocalBlob = async (blob: Blob, speaker: TranscriptSpeaker = "interviewer", channelId = "default") => {
    if (!blob.size || localSttBusyByIdRef.current.has(channelId)) return;
    localSttBusyByIdRef.current.add(channelId);
    try {
      const audio = await decodeAudioBlobToMono16k(blob);
      if (audio.length < 1600) return;
      const energy = audioEnergy(audio);
      if (energy.rms < 0.0035 && energy.peak < 0.035) {
        setDesktopStatus("Local Whisper ignored silence");
        return;
      }
      const recognizer = await getLocalSttPipeline() as (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string }>;
      const language = preferredLanguage === "spanish" ? "spanish" : preferredLanguage === "english" ? "english" : undefined;
      const result = await recognizer(audio, {
        chunk_length_s: 20,
        stride_length_s: 4,
        task: "transcribe",
        ...(language ? { language } : {}),
      });
      const text = typeof result?.text === "string" ? result.text.trim() : "";
      if (shouldKeepTranscriptText(text)) {
        handleFinalTranscript(text, "stt", speaker);
        setDesktopStatus("Local Whisper transcribed audio");
      } else if (text) {
        setDesktopStatus("Local Whisper ignored non-speech noise");
      }
    } catch (error) {
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
            const chunks = localSegmentChunksByIdRef.current.get(channelId) ?? [];
            chunks.push(event.data);
            localSegmentChunksByIdRef.current.set(channelId, chunks);
          }
        };
        recorder.onerror = () => {
          setDesktopStatus(`Local ${channel.label} recording error`);
          stopLiveRecording();
        };
        recorder.onstop = () => {
          const chunks = localSegmentChunksByIdRef.current.get(channelId) ?? [];
          localSegmentChunksByIdRef.current.delete(channelId);
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

  const transcribeLiveBlob = async (blob: Blob, speaker: TranscriptSpeaker = "interviewer") => {
    if (!blob.size || liveChunkBusyRef.current) return;
    liveChunkBusyRef.current = true;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const result = await window.callpilotDesktop?.transcribeAudio({
        arrayBuffer,
        fileName: `callpilot-live-${Date.now()}.webm`,
        mimeType: blob.type || "audio/webm",
        modelName: transcriptionModelName,
        apiKey: sessionApiKey,
      });
      if (result?.ok && result.text) {
        handleFinalTranscript(result.text, "stt", speaker);
        setDesktopStatus(`Live chunk transcribed with ${result.modelName}`);
        return;
      }
      if (result && !result.ok) setDesktopStatus(`Live transcription failed: ${result.error ?? "unknown"}`);
    } finally {
      liveChunkBusyRef.current = false;
    }
  };

  const startOpenAIChunkListening = async (reason = "OpenAI live chunks") => {
    if (!window.callpilotDesktop?.transcribeAudio) {
      setDesktopStatus("Desktop transcription bridge is unavailable");
      setLiveAssistStatus("OpenAI live chunks require desktop mode");
      return false;
    }
    if (!hasOpenAITranscriptionKey) {
      setDesktopStatus("OpenAI live chunks need an OpenAI API key. Switch Live transcription to Browser live for keyless mode.");
      setLiveAssistStatus("No OpenAI key for live chunks");
      setLiveTranscriptionProvider("browser");
      return false;
    }
    if (typeof MediaRecorder === "undefined") {
      setDesktopStatus("Audio recording is not available in this runtime");
      return false;
    }

    try {
      const channels = await requestLiveAudioStreams();
      const stream = channels[0]?.stream;
      if (!stream) throw new Error("audio_capture_unavailable");
      channels.slice(1).forEach((channel) => channel.stream.getTracks().forEach((track) => track.stop()));
      const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: preferredMimeType });
      liveStreamRef.current = stream;
      liveRecorderRef.current = recorder;
      const speaker = channels[0]?.speaker ?? "interviewer";
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) void transcribeLiveBlob(event.data, speaker);
      };
      recorder.onerror = () => {
        setDesktopStatus("Live microphone recording error");
        stopLiveRecording();
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        liveStreamRef.current = null;
        liveRecorderRef.current = null;
      };
      recorder.start(liveChunkMs());
      setIsDictating(true);
      setDesktopStatus(reason);
      const sourceLabel = liveAudioSource === "both" ? "computer audio" : liveAudioSource === "system" ? "computer audio" : "microphone";
      setLiveAssistStatus(autoAnswerEnabled ? `Listening to ${sourceLabel} with OpenAI: auto answer on` : `Listening to ${sourceLabel} with OpenAI: auto answer off`);
      return true;
    } catch (error) {
      setDesktopStatus(error instanceof Error ? `Audio capture failed: ${error.message}` : "Audio capture failed");
      setIsDictating(false);
      return false;
    }
  };

  const toggleDictation = async () => {
    if (isDictating) {
      stopLiveRecording();
      return;
    }

    if (liveTranscriptionProvider === "browser" && (liveAudioSource === "system" || liveAudioSource === "both")) {
      setLiveTranscriptionProvider("local");
      await startLocalWhisperListening("Browser live cannot read computer audio; using Local Whisper");
      return;
    }

    if (liveTranscriptionProvider === "openai_realtime") {
      await startOpenAIChunkListening();
      return;
    }

    if (liveTranscriptionProvider === "local") {
      await startLocalWhisperListening();
      return;
    }

    if (liveTranscriptionProvider === "browser" && browserSpeechRuntimeError) {
      setDesktopStatus(`Browser live STT is unavailable: ${browserSpeechRuntimeError}`);
      setLiveAssistStatus("Trying Local Whisper instead of browser speech.");
      setLiveTranscriptionProvider("local");
      await startLocalWhisperListening(`Browser live unavailable (${browserSpeechRuntimeError}); using Local Whisper`);
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
        setLiveAssistStatus("Browser live unavailable; using Local Whisper");
        setLiveTranscriptionProvider("local");
        await startLocalWhisperListening("Browser speech unavailable; using Local Whisper");
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
        setLiveAssistStatus("Browser speech failed; using Local Whisper.");
        setLiveTranscriptionProvider("local");
        void startLocalWhisperListening(`Browser speech failed (${reason}); using Local Whisper`);
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
        setLiveAssistStatus("Browser speech failed; using Local Whisper.");
        setLiveTranscriptionProvider("local");
        await startLocalWhisperListening("Browser speech failed at startup; using Local Whisper");
      }
    }
  };

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
    if (modelProvider !== "openai") {
      setRecordingStatus("Select OpenAI provider before recording mic audio");
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
    id: savedSession.id,
    title: savedSession.title,
    createdAt: savedSession.createdAt,
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
  }), [
    activeMode,
    answer,
    answerVerbosity,
    codingLanguage,
    companyName,
    jobDescription,
    modelName,
    modelProvider,
    notes,
    preferredLanguage,
    profile,
    question,
    resumeText,
    roleTitle,
    savedSession.createdAt,
    savedSession.id,
    savedSession.title,
    screenText,
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
    if (credential) {
      setHasStoredOpenAIKey(credential.hasOpenAIKey);
      setCredentialMessage(credential.encryptionAvailable ? "Encrypted key storage ready" : "Encrypted key storage unavailable");
    }
    checks.push({
      label: "OpenAI transcription",
      status: hasKey ? "ok" : "warn",
      detail: hasKey ? "OpenAI live chunks can be used." : "No OpenAI key found. OpenAI live chunks will stay disabled.",
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

    const recommendation = hasKey
      ? "Recommended: OpenAI live chunks for transcription, Ollama or OpenAI for answers."
      : liveAudioSource === "system" || liveAudioSource === "both"
        ? "Recommended: Local Whisper with computer audio + microphone for live interview conversations."
        : hasBrowserSpeech && !browserSpeechRuntimeError
        ? "Recommended: Browser live for transcription and Ollama local for answers."
        : "Recommended: Local Whisper for transcription and Ollama local for answers.";
    checks.push({ label: "Recommendation", status: "ok", detail: recommendation });

    setAutoChecks(checks);
    setAutoCheckStatus("Checks complete");
  }, [browserSpeechRuntimeError, liveAudioSource, liveTranscriptionProvider, modelName, modelProvider, ollamaBaseUrl, sessionApiKey]);

  React.useEffect(() => {
    if (modelProvider === "ollama") {
      void refreshOllamaModels();
    }
  }, [modelProvider, refreshOllamaModels]);

  React.useEffect(() => {
    if (autoCheckRanRef.current) return;
    autoCheckRanRef.current = true;
    void runAutoChecks();
  }, [runAutoChecks]);

  const updateModelProvider = (provider: ModelProvider) => {
    setModelProvider(provider);
    if (provider === "ollama") {
      if (liveTranscriptionProvider === "openai_realtime" && !hasOpenAITranscriptionKey) {
        setLiveTranscriptionProvider("browser");
      }
      void refreshOllamaModels({ selectFirst: modelName === "gpt-5.5" || modelName === "mock-local" });
    }
    if (provider === "openai" && modelName === "llama3.1") {
      setModelName("gpt-5.5");
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

    if (modelProvider === "openai" && window.callpilotDesktop?.analyzeScreenshot) {
      setDesktopStatus("Analyzing screenshot...");
      const analysis = await window.callpilotDesktop.analyzeScreenshot({
        path: result.path,
        modelName,
        apiKey: sessionApiKey,
      });
      if (analysis.ok && analysis.text) {
        updateScreenContext(`${analysis.text}\n\nScreenshot: ${result.path}`);
        setDesktopStatus("Screenshot analyzed");
      } else {
        setDesktopStatus(`Screenshot captured, analysis failed: ${analysis.error ?? "unknown"}`);
      }
    }
  }, [modelName, modelProvider, sessionApiKey]);

  const captureLocalOcr = React.useCallback(async () => {
    if (!window.callpilotDesktop?.captureScreenshot || !window.callpilotDesktop?.recognizeScreenText) {
      setDesktopStatus("Local OCR requires desktop mode");
      return;
    }

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

    updateScreenContext([
      ocr.text,
      "",
      `Local OCR: ${ocr.language} - confidence ${ocrConfidenceLabel(ocr.confidence)}${typeof ocr.confidence === "number" ? ` (${ocr.confidence.toFixed(1)})` : ""}`,
      `Screenshot: ${result.path}`,
      result.displayName ? `Display: ${result.displayName}` : "",
    ].filter(Boolean).join("\n"));
    setDesktopStatus("Local OCR complete");
  }, [preferredLanguage]);

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onShortcut((action) => {
      if (action.type === "ask") ask();
      if (action.type === "clear_context") clearContext();
      if (action.type === "capture_screenshot") captureScreenshot();
      if (action.type === "set_mode") setActiveMode(action.mode);
      if (action.type === "stealth") setStealth(action.state);
    });
    return () => dispose?.();
  }, [ask, captureScreenshot, clearContext]);

  const updateScreenContext = (value: string) => {
    setScreenText(value);
    setScreenContext(classifyScreenText(value));
  };

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
    setHasStoredOpenAIKey(status.hasOpenAIKey);
    setCredentialMessage(status.ok ? "OpenAI key saved encrypted on this device" : `Could not save key: ${status.error ?? "unknown"}`);
    if (status.ok) setSessionApiKey("");
  };

  const clearStoredKey = async () => {
    if (!window.callpilotDesktop?.clearOpenAIKey) return;
    const status = await window.callpilotDesktop.clearOpenAIKey();
    setHasStoredOpenAIKey(status.hasOpenAIKey);
    setCredentialMessage(status.ok ? "Stored OpenAI key cleared" : `Could not clear key: ${status.error ?? "unknown"}`);
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
        <section className="tab-page meeting-layout">
          <section className="panel call-panel">
            <div className="section-head">
              <div>
                <span className="eyebrow">Live call</span>
                <h2>Listen and answer</h2>
              </div>
              <span className={briefStats.ready ? "ready-pill ready" : "ready-pill"}>
                {briefStats.ready ? "Context ready" : `${briefStats.filled}/5 context fields`}
              </span>
            </div>
            <div className="primary-actions">
              <button className={isDictating ? "primary danger" : "primary"} onClick={toggleDictation}>
                {isDictating ? <Square size={18} /> : <Mic size={18} />}
                {isDictating ? "Stop listening" : "Start listening"}
              </button>
              <button className={autoAnswerEnabled ? "status active" : "status"} onClick={() => setAutoAnswerEnabled((current) => !current)}>
                <Sparkles size={16} />
                Auto answer
              </button>
              <button onClick={captureLocalOcr}>
                <ScanText size={16} />
                Read screen
              </button>
            </div>
            <div className="quick-status">
              <span>{liveAssistStatus}</span>
              <span>{livePlan.engineLabel}: {livePlan.implemented ? `${livePlan.expectedLatency}, ${livePlan.quality}` : "configured, not connected"}</span>
              <span>{desktopStatus}</span>
            </div>
            <label>
              Question
              <small>Use this when you want to ask manually or edit what was detected from the call.</small>
              <textarea className="question-box" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Example: Why did you choose SQL instead of NoSQL?" />
            </label>
            <div className="button-row">
              <button className="primary" onClick={() => ask()} disabled={isGenerating}>
                <Send size={16} />
                {isGenerating ? "Thinking..." : "Answer now"}
              </button>
              <button onClick={() => setQuestion("")}>Clear question</button>
            </div>
          </section>

          <section className="panel answer-panel">
            <div className="section-head">
              <div>
                <span className="eyebrow">Suggested answer</span>
                <h2>Say this in your words</h2>
              </div>
              <button onClick={() => navigator.clipboard?.writeText(answer)} disabled={!answer}>
                <Copy size={16} />
                Copy
              </button>
            </div>
            <div className="answer-output large">
              {answer ? <pre>{answer}</pre> : <span>Your answer will appear here after a question is detected or sent manually.</span>}
            </div>
            <div className="evidence-preview">
              <div className="mini-title">Context used</div>
              {lastPrompt.debug.selectedEvidence.length === 0 ? (
                <span>No matched CV or STAR evidence yet.</span>
              ) : (
                lastPrompt.debug.selectedEvidence.map((item, index) => (
                  <div className="evidence-item" key={`${item.source}-${index}`}>
                    <strong>{item.label}</strong>
                    <p>{item.text}</p>
                    <span>{item.source} - score {item.score}</span>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel transcript-panel">
            <div className="section-head">
              <div>
                <span className="eyebrow">Transcript</span>
                <h2>{transcript.messages.length} lines</h2>
              </div>
              <div className="button-row compact">
                <button onClick={() => setTranscript(transcript.paused ? transcriptBuffer.resume() : transcriptBuffer.pause())}>
                  {transcript.paused ? <Play size={16} /> : <Pause size={16} />}
                  {transcript.paused ? "Resume" : "Pause"}
                </button>
                <button onClick={() => setTranscript(transcriptBuffer.clear())}>
                  <Trash2 size={16} />
                  Clear
                </button>
              </div>
            </div>
            {recordingStatus && <span className="helper good">{recordingStatus}</span>}
            <div className="transcript-entry">
              <textarea value={transcriptDraft} onChange={(event) => setTranscriptDraft(event.target.value)} placeholder="Add something the interviewer said..." />
              <button onClick={appendTranscript}>
                <Send size={16} />
                Add
              </button>
            </div>
            <div className="transcript-box">
              {transcript.messages.length === 0 ? <span>No transcript yet.</span> : transcript.messages.map((message) => (
                <p key={message.id} className={`transcript-line speaker-${message.speaker ?? "unknown"}`}>
                  <strong>{speakerLabel(message.speaker)}</strong>
                  <span>{message.text}</span>
                </p>
              ))}
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

          <section className="panel screen-panel">
            <div className="section-head">
              <div>
                <span className="eyebrow">Screen context</span>
                <h2>{screenContext.kind.replaceAll("_", " ")}</h2>
              </div>
              <div className="button-row compact">
                <button onClick={captureLocalOcr}>
                  <ScanText size={16} />
                  Read screen
                </button>
                <button onClick={() => updateScreenContext(screenText)}>
                  <RefreshCw size={16} />
                  Refresh
                </button>
              </div>
            </div>
            <p className="muted">Confidence {screenContext.confidence.toFixed(2)}. Paste text or use local OCR in the desktop app.</p>
            <textarea className="screen-input" value={screenText} onChange={(event) => updateScreenContext(event.target.value)} placeholder="Paste visible screen text, coding prompt, docs, transcript, or system design notes..." />
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
                <small>Demo is safe for testing. OpenAI is cloud. Ollama runs locally if installed.</small>
                <select value={modelProvider} onChange={(event) => updateModelProvider(event.target.value as ModelProvider)}>
                  <option value="mock">Demo</option>
                  <option value="openai">OpenAI</option>
                  <option value="ollama">Ollama local</option>
                </select>
              </label>
              <label>
                Model
                <small>{modelProvider === "ollama" ? "Choose one of your installed local Ollama models." : "The model that writes the answer."}</small>
                {modelProvider === "ollama" && ollamaModels.length > 0 ? (
                  <select value={modelName} onChange={(event) => setModelName(event.target.value)}>
                    {ollamaModels.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                ) : (
                  <input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder={modelProvider === "ollama" ? "Example: llama3.1:8b" : undefined} />
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
                  <option value="local">Local Whisper</option>
                </select>
              </label>
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
                  <span>OpenAI live chunks is disabled because no OpenAI key is saved. Browser live can work without a key if this runtime supports speech recognition.</span>
                </div>
              )}
              {browserSpeechRuntimeError && (
                <div className="setting-note">
                  <span>Browser live failed with: {browserSpeechRuntimeError}. Use Local Whisper for keyless live transcription.</span>
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
                <span className="eyebrow">Privacy controls</span>
                <h2>Use only with consent</h2>
              </div>
            </div>
            <p className="muted">These controls are for approved calls and local presentation privacy. They do not guarantee invisibility on every platform.</p>
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
                Share Safe
              </button>
              <button className={privacyCheck?.status === "safe" ? "status active" : "status"} onClick={runPrivacyCheck}>
                <Radar size={16} />
                Check
              </button>
              <button className="status" onClick={resetPrivacy}>
                <RotateCcw size={16} />
                Reset
              </button>
            </div>
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
              <span className={hasStoredOpenAIKey ? "helper good" : "helper"}>{hasStoredOpenAIKey ? "Stored OpenAI key available" : credentialMessage || "No stored key"}</span>
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
    <App />
  </React.StrictMode>,
);
