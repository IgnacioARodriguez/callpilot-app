import { speechSimilarity } from "./conversationDedupe.ts";
import type { TranscriptSpeaker } from "./transcriptBuffer.ts";

export interface TurnDraft {
  text: string;
  timestamp: number;
}

export interface TurnAssemblerState {
  draftsBySpeaker: Partial<Record<TranscriptSpeaker, TurnDraft>>;
}

export type TurnAssemblyDecision =
  | { action: "ignore"; reason: "empty" }
  | { action: "publish_live"; reason: "partial"; text: string }
  | { action: "fold_final"; reason: "final_fragment"; text: string; draftText: string }
  | { action: "commit"; reason: "final" | "final_replaces_draft"; text: string };

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export const createTurnAssemblerState = (): TurnAssemblerState => ({
  draftsBySpeaker: {},
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
  return clean.length < draft.length * 0.75
    && (draft.toLowerCase().includes(clean.toLowerCase()) || speechSimilarity(draft, clean) >= 0.72);
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
  const previous = state.draftsBySpeaker[input.speaker];

  if (!input.isFinal) {
    const next = mergeTurnDraft(previous?.text ?? "", clean);
    state.draftsBySpeaker[input.speaker] = { text: next, timestamp: now };
    return { action: "publish_live", reason: "partial", text: next };
  }

  if (previous?.text && isFinalFragmentOfDraft(previous.text, clean)) {
    state.draftsBySpeaker[input.speaker] = { text: previous.text, timestamp: now };
    return { action: "fold_final", reason: "final_fragment", text: clean, draftText: previous.text };
  }

  const finalText = previous?.text ? mergeTurnDraft(previous.text, clean) : clean;
  delete state.draftsBySpeaker[input.speaker];
  return {
    action: "commit",
    reason: previous?.text && finalText !== clean ? "final_replaces_draft" : "final",
    text: finalText,
  };
};
