import type { AssistantModeId } from "./modes.ts";
import type { ScreenContext } from "./screenContext.ts";
import type { TranscriptMessage, TranscriptSnapshot, TranscriptSpeaker } from "./transcriptBuffer.ts";

export type ConversationRole = "interviewer" | "candidate" | "assistant";
export type ConversationSource = "stt" | "manual" | "generated";
export type ConversationStatus = "partial" | "final";

export interface ConversationTurn {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: number;
  source: ConversationSource;
  status?: ConversationStatus;
}

export interface AnswerContextTrace {
  event: "answer_context_built";
  sessionId: string;
  mode: AssistantModeId;
  currentQuestionId: string;
  includedTurnIds: string[];
  excludedTurnIds: string[];
  transcriptCharacterCount: number;
  finalPromptCharacterCount: number;
  compactionApplied: boolean;
  previousAnswerIncluded: boolean;
}

export interface AnswerContext {
  sessionId: string;
  mode: AssistantModeId;
  currentQuestion: ConversationTurn;
  recentTurns: ConversationTurn[];
  previousAssistantAnswers: ConversationTurn[];
  excludedTurns: ConversationTurn[];
  compactionApplied: boolean;
  trace: AnswerContextTrace;
}

const MAX_RECENT_TURNS = 18;
const MAX_PREVIOUS_ASSISTANT_ANSWERS = 4;
const MAX_CONTEXT_CHARS = 8_000;
const LIVE_CODING_SCREEN_FRESHNESS_WINDOW_MS = 3 * 60 * 1000;

const roleFromSpeaker = (speaker: TranscriptSpeaker): ConversationRole | null => {
  if (speaker === "interviewer" || speaker === "candidate" || speaker === "assistant") return speaker;
  return null;
};

const sourceFromMessage = (message: TranscriptMessage): ConversationSource =>
  message.speaker === "assistant" ? "generated" : message.source === "stt" ? "stt" : "manual";

const normalizeContent = (value: string): string => value.replace(/\s+/g, " ").trim();

const normalizeComparable = (value: string): string =>
  normalizeContent(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.。…]+/g, "")
    .toLowerCase();

const isFiller = (turn: ConversationTurn): boolean =>
  /^(ok|okay|right|vale|bien|perfecto|gracias|thanks|thank you)[.!?]?$/i.test(normalizeContent(turn.content));

const isCumulativeDuplicate = (previous: ConversationTurn, next: ConversationTurn): boolean => {
  if (previous.role !== next.role) return false;
  const left = normalizeComparable(previous.content);
  const right = normalizeComparable(next.content);
  if (!left || !right) return false;
  return right.startsWith(left) && right.length > left.length + 3;
};

const toConversationTurns = (snapshot: TranscriptSnapshot): ConversationTurn[] => {
  const turns: ConversationTurn[] = [];
  for (const message of snapshot.messages) {
    const role = roleFromSpeaker(message.speaker);
    const content = normalizeContent(message.text);
    if (!role || !content) continue;
    turns.push({
      id: message.id,
      role,
      content,
      createdAt: message.timestamp,
      source: sourceFromMessage(message),
      status: "final",
    });
  }
  return turns;
};

export const dedupeCumulativeTurns = (turns: ConversationTurn[]): ConversationTurn[] => {
  const next: ConversationTurn[] = [];
  for (const turn of turns) {
    const previous = next.at(-1);
    if (previous && isCumulativeDuplicate(previous, turn)) {
      next[next.length - 1] = turn;
    } else if (!previous || normalizeComparable(previous.content) !== normalizeComparable(turn.content) || previous.role !== turn.role) {
      next.push(turn);
    }
  }
  return next;
};

const manualQuestionTurn = (content: string, now: number): ConversationTurn | null => {
  const clean = normalizeContent(content);
  if (!clean) return null;
  return {
    id: `manual-question-${now}`,
    role: "interviewer",
    content: clean.replace(/^interviewer\s*:\s*/i, ""),
    createdAt: now,
    source: "manual",
    status: "final",
  };
};

const hasFreshCodingScreen = (mode: AssistantModeId, screenContext?: ScreenContext): boolean =>
  mode === "live_coding"
  && Boolean(screenContext?.visibleText.trim());

const freshnessCutoffForScreen = (mode: AssistantModeId, screenContext?: ScreenContext): number | null => {
  if (!hasFreshCodingScreen(mode, screenContext) || typeof screenContext?.capturedAt !== "number") return null;
  return Math.max(0, screenContext.capturedAt - LIVE_CODING_SCREEN_FRESHNESS_WINDOW_MS);
};

const previousAssistantCutoffForScreen = (mode: AssistantModeId, screenContext?: ScreenContext): number | null => {
  if (!hasFreshCodingScreen(mode, screenContext) || typeof screenContext?.capturedAt !== "number") return null;
  return screenContext.capturedAt;
};

const chooseCurrentQuestion = (turns: ConversationTurn[], manualInput: string, now: number, cutoffTimestamp: number | null): ConversationTurn => {
  const manual = manualQuestionTurn(manualInput, now);
  if (manual) return manual;
  const currentQuestionCandidates = cutoffTimestamp === null
    ? turns
    : turns.filter((turn) => turn.createdAt >= cutoffTimestamp);
  return [...currentQuestionCandidates].reverse().find((turn) => turn.role === "interviewer" && !isFiller(turn))
    ?? [...currentQuestionCandidates].reverse().find((turn) => turn.role === "interviewer")
    ?? {
      id: `empty-question-${now}`,
      role: "interviewer",
      content: "",
      createdAt: now,
      source: "manual",
      status: "final",
    };
};

const textSize = (turns: ConversationTurn[]): number =>
  turns.reduce((sum, turn) => sum + turn.content.length, 0);

export const buildAnswerContext = (
  input: {
    transcript: TranscriptSnapshot;
    mode: AssistantModeId;
    userInput?: string;
    sessionId?: string;
    now?: number;
    maxRecentTurns?: number;
    maxPreviousAssistantAnswers?: number;
    maxContextChars?: number;
    screenContext?: ScreenContext;
  },
): AnswerContext => {
  const now = input.now ?? Date.now();
  const sessionId = input.sessionId ?? "local-session";
  const maxRecentTurns = input.maxRecentTurns ?? MAX_RECENT_TURNS;
  const maxPreviousAssistantAnswers = input.maxPreviousAssistantAnswers ?? MAX_PREVIOUS_ASSISTANT_ANSWERS;
  const maxContextChars = input.maxContextChars ?? MAX_CONTEXT_CHARS;
  const allTurns = dedupeCumulativeTurns(toConversationTurns(input.transcript));
  const freshnessCutoff = freshnessCutoffForScreen(input.mode, input.screenContext);
  const previousAssistantCutoff = previousAssistantCutoffForScreen(input.mode, input.screenContext);
  const currentQuestion = chooseCurrentQuestion(allTurns, input.userInput ?? "", now, freshnessCutoff);
  const sameCurrentTurnIds = new Set(
    allTurns
      .filter((turn) => turn.role === "interviewer" && normalizeComparable(turn.content) === normalizeComparable(currentQuestion.content))
      .map((turn) => turn.id),
  );
  const conversationTurns = allTurns.filter((turn) => !sameCurrentTurnIds.has(turn.id));
  const previousAssistantAnswers = conversationTurns
    .filter((turn) => turn.role === "assistant" && turn.source === "generated" && !isFiller(turn))
    .filter((turn) => previousAssistantCutoff === null || turn.createdAt >= previousAssistantCutoff)
    .slice(-maxPreviousAssistantAnswers);
  let recentTurns = conversationTurns
    .filter((turn) => turn.role !== "assistant")
    .slice(-maxRecentTurns);

  const requiredIds = new Set<string>([currentQuestion.id, ...previousAssistantAnswers.map((turn) => turn.id)]);
  while (recentTurns.length > 1 && textSize(recentTurns) + textSize(previousAssistantAnswers) + currentQuestion.content.length > maxContextChars) {
    recentTurns = recentTurns.slice(1);
  }

  const includedTurnIds = [...recentTurns.map((turn) => turn.id), ...previousAssistantAnswers.map((turn) => turn.id), currentQuestion.id];
  includedTurnIds.forEach((id) => requiredIds.add(id));
  const included = new Set(includedTurnIds);
  const excludedTurns = allTurns.filter((turn) => !included.has(turn.id));
  const transcriptCharacterCount = textSize(allTurns);
  const compactionApplied = excludedTurns.length > 0 || transcriptCharacterCount > maxContextChars;

  return {
    sessionId,
    mode: input.mode,
    currentQuestion,
    recentTurns,
    previousAssistantAnswers,
    excludedTurns,
    compactionApplied,
    trace: {
      event: "answer_context_built",
      sessionId,
      mode: input.mode,
      currentQuestionId: currentQuestion.id,
      includedTurnIds,
      excludedTurnIds: excludedTurns.map((turn) => turn.id),
      transcriptCharacterCount,
      finalPromptCharacterCount: 0,
      compactionApplied,
      previousAnswerIncluded: previousAssistantAnswers.length > 0,
    },
  };
};

export const formatAnswerContextSection = (turns: ConversationTurn[]): string =>
  turns.map((turn) => {
    const label = turn.role === "assistant" ? "Assistant suggestion" : turn.role === "candidate" ? "Candidate" : "Interviewer";
    return `${label}: ${turn.content}`;
  }).join("\n");
