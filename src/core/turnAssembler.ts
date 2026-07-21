import { speechSimilarity } from "./conversationDedupe.ts";
import type { TranscriptSpeaker } from "./transcriptBuffer.ts";

export interface TurnDraft {
  text: string;
  timestamp: number;
}

export interface TurnAssemblerState {
  draftsBySpeaker: Partial<Record<TranscriptSpeaker, TurnDraft>>;
  committedBySpeaker: Partial<Record<TranscriptSpeaker, string>>;
}

export type TurnAssemblyDecision =
  | { action: "ignore"; reason: "empty" }
  | { action: "ignore"; reason: "short_final_fragment"; text: string }
  | { action: "publish_live"; reason: "partial"; text: string }
  | { action: "fold_final"; reason: "final_fragment"; text: string; draftText: string }
  | { action: "commit"; reason: "final" | "final_replaces_draft"; text: string };

export interface FlushedTurnDraft {
  speaker: TranscriptSpeaker;
  text: string;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

const normalizeRepeatedPrefix = (text: string): string =>
  normalize(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .trim();

const isDanglingRepeatedPrefix = (committedText: string, nextText: string): boolean => {
  const cleanNext = normalize(nextText);
  if (!cleanNext || /[?!.]$/.test(cleanNext)) return false;
  const committedKey = normalizeRepeatedPrefix(committedText);
  const nextKey = normalizeRepeatedPrefix(cleanNext);
  return nextKey.length >= 6 && committedKey.startsWith(nextKey);
};

export const createTurnAssemblerState = (): TurnAssemblerState => ({
  draftsBySpeaker: {},
  committedBySpeaker: {},
});

export const mergeTurnDraft = (
  previousText: string,
  currentText: string,
): string => {
  const prev = normalize(previousText);
  const clean = normalize(currentText);
  if (!prev) return clean;
  if (!clean) return prev;

  const prevLower = prev.toLowerCase();
  const cleanLower = clean.toLowerCase();
  if (cleanLower.startsWith(prevLower)) return clean;
  if (prevLower.includes(cleanLower)) return prev;
  const minOverlap = 8;
  for (let length = Math.min(prev.length, clean.length); length >= minOverlap; length -= 1) {
    if (prevLower.slice(-length) === cleanLower.slice(0, length)) {
      return `${prev}${clean.slice(length)}`.trim();
    }
  }
  if (clean.length > prev.length && speechSimilarity(prev, clean) >= 0.55) return clean;
  if (clean.length < prev.length * 0.55 && !/[?¿.!]$/.test(prev)) return `${prev} ${clean}`;
  return clean;
};

export const isFinalFragmentOfDraft = (
  draftText: string,
  finalText: string,
): boolean => {
  const draft = normalize(draftText);
  const clean = normalize(finalText);
  if (!draft || !clean) return false;
  const draftLower = draft.toLowerCase();
  const cleanLower = clean.toLowerCase();
  const hasUsefulOverlap = Array.from({ length: draft.length }, (_, index) => draft.slice(index))
    .some((tail) => tail.length >= 16 && cleanLower.startsWith(tail.toLowerCase()));
  if (hasUsefulOverlap && clean.length < draft.length * 0.9) return true;
  return clean.length < draft.length * 0.75
    && (draftLower.includes(cleanLower) || speechSimilarity(draft, clean) >= 0.72);
};

const mergeOverlappingFinalFragment = (draftText: string, finalText: string): string => {
  const draft = normalize(draftText);
  const fragment = normalize(finalText);
  if (!draft || !fragment) return draft || fragment;

  const draftLower = draft.toLowerCase();
  const fragmentLower = fragment.toLowerCase();
  if (draftLower.includes(fragmentLower)) return draft;
  if (fragmentLower.startsWith(draftLower)) return fragment;

  for (let index = 0; index < draft.length; index += 1) {
    const tail = draft.slice(index);
    if (tail.length < 16) continue;
    if (fragmentLower.startsWith(tail.toLowerCase())) {
      return `${draft.slice(0, index)}${fragment}`.trim();
    }
  }

  return mergeTurnDraft(draft, fragment);
};

const hasQuestionSignal = (text: string): boolean =>
  /[?¿]$/.test(text.trim())
  || /\b(what|why|how|when|where|which|who|que|por que|como|cuando|donde|cual|quien)\b/i.test(text);

const isShortNonQuestionFinal = (text: string): boolean => {
  const clean = normalize(text);
  return clean.length < 24 && !hasQuestionSignal(clean);
};

const stripCommittedPrefix = (committedText: string | undefined, text: string): string => {
  const committed = normalize(committedText ?? "");
  const clean = normalize(text);
  if (!committed || !clean) return clean;

  const committedLower = committed.toLowerCase();
  const cleanLower = clean.toLowerCase();
  if (cleanLower.startsWith(committedLower)) {
    if (isDanglingRepeatedPrefix(committed, clean.slice(committed.length))) return "";
    return clean.slice(committed.length).replace(/^[\s.,;:!?Â¿Â¡"'`-]+/, "").trim();
  }
  if (committedLower.includes(cleanLower)) return "";
  let commonPrefixLength = 0;
  const maxPrefixLength = Math.min(committed.length, clean.length);
  while (
    commonPrefixLength < maxPrefixLength
    && committedLower.charCodeAt(commonPrefixLength) === cleanLower.charCodeAt(commonPrefixLength)
  ) {
    commonPrefixLength += 1;
  }
  if (commonPrefixLength >= Math.min(40, Math.floor(committed.length * 0.35))) {
    if (isDanglingRepeatedPrefix(committed, clean.slice(commonPrefixLength))) return "";
    return clean.slice(commonPrefixLength).replace(/^[\s.,;:!?Â¿Â¡"'`-]+/, "").trim();
  }
  return clean;
};

const appendCommitted = (committedText: string | undefined, text: string): string => {
  const committed = normalize(committedText ?? "");
  const clean = normalize(text);
  if (!clean) return committed;
  if (!committed) return clean;
  const committedLower = committed.toLowerCase();
  const cleanLower = clean.toLowerCase();
  if (committedLower.includes(cleanLower)) return committed;
  if (cleanLower.startsWith(committedLower)) return clean;
  return `${committed} ${clean}`;
};

export const assembleTurn = (
  state: TurnAssemblerState,
  input: {
    speaker: TranscriptSpeaker;
    text: string;
    isFinal: boolean;
    timestamp?: number;
  },
): TurnAssemblyDecision => {
  const clean = normalize(input.text);
  if (!clean) return { action: "ignore", reason: "empty" };

  const now = input.timestamp ?? Date.now();
  const incrementalClean = stripCommittedPrefix(state.committedBySpeaker[input.speaker], clean);
  if (!incrementalClean) return { action: "ignore", reason: "empty" };
  const previous = state.draftsBySpeaker[input.speaker];

  if (!input.isFinal) {
    const next = mergeTurnDraft(previous?.text ?? "", incrementalClean);
    state.draftsBySpeaker[input.speaker] = { text: next, timestamp: now };
    return { action: "publish_live", reason: "partial", text: next };
  }

  if (previous?.text && isFinalFragmentOfDraft(previous.text, incrementalClean)) {
    const next = mergeOverlappingFinalFragment(previous.text, incrementalClean);
    state.draftsBySpeaker[input.speaker] = { text: next, timestamp: now };
    return { action: "fold_final", reason: "final_fragment", text: incrementalClean, draftText: next };
  }
  if (previous?.text && isShortNonQuestionFinal(incrementalClean)) {
    const next = mergeTurnDraft(previous.text, incrementalClean);
    state.draftsBySpeaker[input.speaker] = { text: next, timestamp: now };
    return { action: "fold_final", reason: "final_fragment", text: incrementalClean, draftText: next };
  }
  if (!previous?.text && isShortNonQuestionFinal(incrementalClean)) {
    return { action: "ignore", reason: "short_final_fragment", text: incrementalClean };
  }

  const finalText = previous?.text ? mergeTurnDraft(previous.text, incrementalClean) : incrementalClean;
  delete state.draftsBySpeaker[input.speaker];
  state.committedBySpeaker[input.speaker] = appendCommitted(state.committedBySpeaker[input.speaker], finalText);
  return {
    action: "commit",
    reason: previous?.text && finalText !== incrementalClean ? "final_replaces_draft" : "final",
    text: finalText,
  };
};

export const flushTurnDrafts = (state: TurnAssemblerState): FlushedTurnDraft[] => {
  const flushed: FlushedTurnDraft[] = [];
  for (const [speaker, draft] of Object.entries(state.draftsBySpeaker) as Array<[TranscriptSpeaker, TurnDraft | undefined]>) {
    const text = normalize(draft?.text ?? "");
    if (!text || isShortNonQuestionFinal(text)) continue;
    state.committedBySpeaker[speaker] = appendCommitted(state.committedBySpeaker[speaker], text);
    flushed.push({ speaker, text });
  }
  state.draftsBySpeaker = {};
  return flushed;
};
