export { createGlobalContext, type GlobalContext, type PreferredLanguage } from "./context.ts";
export { MODES, modeById, type AssistantModeId, type ModeDefinition } from "./modes.ts";
export { buildEvidenceCandidates, formatEvidenceForPrompt, pickEvidence, pickEvidenceWithEmbeddings, type EvidenceCandidate, type EvidenceEmbedder, type EvidenceEmbedding, type EvidenceItem, type EvidenceSelection, type EvidenceSource } from "./evidencePicker.ts";
export { buildPrompt, buildPromptWithEvidence, type BuiltPrompt } from "./promptBuilder.ts";
export {
  buildAnswerContext,
  dedupeCumulativeTurns,
  formatAnswerContextSection,
  type AnswerContext,
  type AnswerContextTrace,
  type ConversationRole,
  type ConversationSource,
  type ConversationStatus,
  type ConversationTurn,
} from "./conversationContext.ts";
export {
  formatStructuredAnswerPayload,
  formatAnswerForDisplay,
  normalizeInterviewAnswerText,
  parseCodingAnswerPayload,
  parseInterviewAnswerPayload,
  parseStructuredAnswerPayload,
  STRUCTURED_ANSWER_PAYLOAD_JSON_SCHEMA,
  type CodingAnswerPayload,
  type InterviewAnswerPayload,
  type StructuredAnswerPayload,
} from "./answerPayload.ts";
export {
  assessAnswerGrounding,
  assessPlainInterviewAnswerGrounding,
  withNoAnswerForUngroundedDrift,
  type AnswerGroundingAssessment,
} from "./answerGrounding.ts";
export {
  buildLiveCodingCompletenessRetryPrompt,
  extractVisibleCodeSymbols,
  repairLiveCodingAnswerCoverage,
  repairSystemDesignAnswerCoverage,
  repairTechnicalDebuggingAnswerCoverage,
  shouldRetryLiveCodingCompleteness,
  violatesVisibleCodeContinuity,
} from "./answerRepair.ts";
export {
  buildLiveCodingFollowUpPrompt,
  compactLiveSpokenAnswer,
} from "./liveCodingInteraction.ts";
export { classifyScreenText, createEmptyScreenContext, extractTechnicalScreenFocus, type ScreenContext, type ScreenKind } from "./screenContext.ts";
export {
  cleanOcrText,
  normalizeOcrLanguage,
  ocrConfidenceLabel,
  type OcrLanguage,
  type OcrResult,
} from "./ocr.ts";
export { DEFAULT_MAX_TRANSCRIPT_MESSAGES, TranscriptBuffer, compactTranscript, createEmptyTranscriptSnapshot, formatConversationWindow, formatFactualTranscriptText, type TranscriptSnapshot, type TranscriptSpeaker } from "./transcriptBuffer.ts";
export { normalizeTechnicalTranscript } from "./transcriptNormalize.ts";
export {
  assessPartialTurnStability,
  detectQuestionIntent,
  extractLatestQuestionFocus,
  shouldAutoAnswer,
  type PartialTurnStability,
  type QuestionDetection,
} from "./liveConversation.ts";
export {
  pruneRecentSpeech,
  shouldDropCandidateEcho,
  speechSimilarity,
  type RecentSpeech,
} from "./conversationDedupe.ts";
export {
  assembleTurn,
  createTurnAssemblerState,
  isFinalFragmentOfDraft,
  mergeTurnDraft,
  type TurnAssemblerState,
  type TurnAssemblyDecision,
} from "./turnAssembler.ts";
export {
  DEFAULT_LIVE_TRANSCRIPTION_SETTINGS,
  browserRecognitionLanguage,
  buildRealtimeTranscriptionSessionUpdate,
  liveTranscriptionPlan,
  normalizeLiveTranscriptionSettings,
  realtimeDelayForPreset,
  type LiveAudioSource,
  type LiveLatencyPreset,
  type LiveTranscriptionPlan,
  type LiveTranscriptionProvider,
  type LiveTranscriptionSettings,
} from "./liveTranscription.ts";
export {
  appendSegmentChunk,
  consumeSegmentChunks,
  shouldDrainTranscriptionQueue,
  shouldSendNativelyFrame,
} from "./liveAudioSegments.ts";
export {
  hasTranscriptProgress,
  isDuplicateTranscript,
  transcriptDelta,
} from "./overlayTranscript.ts";
export {
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_NVIDIA_VISION_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  OPENAI_TRANSCRIPTION_MAX_BYTES,
  buildOllamaChatRequest,
  buildOpenAIImageAnalysisRequest,
  buildOpenAICompatibleImageAnalysisRequest,
  buildOpenAIResponsesRequest,
  createMockAnswer,
  extractOllamaModels,
  extractOllamaResponseText,
  extractOpenAICompatibleModels,
  extractOpenAICompatibleChatText,
  extractOpenAIResponseText,
  extractOpenAITranscriptionText,
  buildOpenAICompatibleChatRequest,
  isSupportedAudioMimeType,
  normalizeOllamaBaseUrl,
  normalizeTranscriptionModelName,
  validateAudioTranscriptionInput,
  type AudioTranscriptionInput,
  type AudioTranscriptionModel,
  type AudioTranscriptionResult,
  type GenerateAnswerInput,
  type GenerateAnswerResult,
  type ModelProvider,
  type OllamaModelInfo,
  type OllamaModelListResult,
  type ProviderModelInfo,
  type ProviderModelListResult,
} from "./modelClient.ts";
export {
  CURRENT_SESSION_KEY,
  SESSION_LIBRARY_KEY,
  createSessionSnapshot,
  makeSessionTitle,
  parseSessionJson,
  sanitizeSessionImport,
  serializeSession,
  upsertSession,
  type SavedSession,
  type SessionDraft,
} from "./sessions.ts";
export {
  DEFAULT_APP_SETTINGS,
  mergeAppSettings,
  type AppSettings,
} from "./settings.ts";
export {
  DEFAULT_RETRY_POLICY,
  isAbortError,
  isTransientStatus,
  retryDelayMs,
  shouldRetryProviderFailure,
  waitForRetry,
  withRetry,
  type RetryDecision,
  type RetryPolicy,
} from "./providerRetry.ts";
export {
  createSseParseState,
  parseSseChunk,
  type SseParseResult,
  type SseParseState,
} from "./sseStream.ts";
export {
  createLatencyMetricRun,
  markLatencyStage,
  type LatencyMetricRun,
  type LatencyStage,
} from "./latencyMetrics.ts";
export {
  defaultStealthState,
  applyShareSafeState,
  assessPrivacyState,
  normalizeStealthState,
  reduceStealthState,
  resetPrivacyState,
  resetStealthState,
  type FocusMode,
  type PrivacyCheckResult,
  type PrivacyCheckStatus,
  type StealthAction,
  type StealthState,
} from "./stealth.ts";
