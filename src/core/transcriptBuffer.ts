export type TranscriptSource = "manual" | "stt" | "imported";
export type TranscriptSpeaker = "interviewer" | "candidate" | "assistant" | "unknown";

export interface TranscriptMessage {
  id: string;
  text: string;
  timestamp: number;
  source: TranscriptSource;
  speaker: TranscriptSpeaker;
}

export interface TranscriptSnapshot {
  messages: TranscriptMessage[];
  paused: boolean;
  updatedAt: number;
}

export const DEFAULT_MAX_TRANSCRIPT_MESSAGES = 800;

export const createEmptyTranscriptSnapshot = (now = Date.now()): TranscriptSnapshot => ({
  messages: [],
  paused: false,
  updatedAt: now,
});

export const compactTranscript = (
  snapshot: TranscriptSnapshot,
  maxChars = 6000,
  maxMessages = snapshot.messages.length,
): string => {
  const selected = snapshot.messages.slice(-Math.max(0, maxMessages));
  const lines: string[] = [];
  let used = 0;

  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const message = selected[index];
    const speaker = message.speaker ?? "unknown";
    const line = `[${new Date(message.timestamp).toISOString()}] ${speaker}: ${message.text.trim()}`;
    const nextUsed = used + line.length + (lines.length > 0 ? 1 : 0);
    if (nextUsed > maxChars) break;
    lines.unshift(line);
    used = nextUsed;
  }

  return lines.join("\n");
};

export const formatConversationWindow = (
  snapshot: TranscriptSnapshot,
  liveInterviewerText = "",
  maxMessages = 8,
  options: { minTimestamp?: number } = {},
): string => {
  const recent = snapshot.messages
    .filter((message) => message.speaker === "interviewer" || message.speaker === "candidate")
    .filter((message) => typeof options.minTimestamp !== "number" || message.timestamp >= options.minTimestamp)
    .slice(-Math.max(0, maxMessages));
  const lines = recent.map((message) => `${message.speaker}: ${message.text.trim()}`);
  const liveText = liveInterviewerText.trim();
  if (liveText && !recent.some((message) => message.speaker === "interviewer" && message.text.trim() === liveText)) {
    lines.push(`interviewer_partial: ${liveText}`);
  }
  return lines.join("\n");
};

export const formatFactualTranscriptText = (snapshot: TranscriptSnapshot): string =>
  snapshot.messages
    .filter((message) => message.speaker !== "assistant")
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join(" ");

export class TranscriptBuffer {
  private messages: TranscriptMessage[];
  private paused: boolean;
  private updatedAt: number;
  private sequence: number;
  private maxMessages: number;

  constructor(snapshot = createEmptyTranscriptSnapshot(), maxMessages = DEFAULT_MAX_TRANSCRIPT_MESSAGES) {
    this.maxMessages = Number.isFinite(maxMessages)
      ? Math.max(0, Math.floor(maxMessages))
      : DEFAULT_MAX_TRANSCRIPT_MESSAGES;
    this.messages = this.takeRecent(snapshot.messages).map((message) => ({ ...message }));
    this.paused = snapshot.paused;
    this.updatedAt = snapshot.updatedAt;
    this.sequence = snapshot.messages.length;
  }

  append(text: string, source: TranscriptSource = "manual", timestamp = Date.now(), speaker: TranscriptSpeaker = "interviewer"): TranscriptMessage | null {
    const cleanText = text.trim();
    this.updatedAt = timestamp;
    if (this.paused || cleanText.length === 0) return null;
    this.sequence += 1;
    const message = { id: `tr-${timestamp}-${this.sequence}`, text: cleanText, timestamp, source, speaker };
    this.messages = [...this.messages, message];
    this.trimToMaxMessages();
    return { ...message };
  }

  pause(timestamp = Date.now()): TranscriptSnapshot {
    this.paused = true;
    this.updatedAt = timestamp;
    return this.snapshot();
  }

  resume(timestamp = Date.now()): TranscriptSnapshot {
    this.paused = false;
    this.updatedAt = timestamp;
    return this.snapshot();
  }

  clear(timestamp = Date.now()): TranscriptSnapshot {
    this.messages = [];
    this.updatedAt = timestamp;
    return this.snapshot();
  }

  compact(maxChars = 6000, maxMessages = this.messages.length): string {
    return compactTranscript(this.snapshot(), maxChars, maxMessages);
  }

  snapshot(): TranscriptSnapshot {
    return {
      messages: this.messages.map((message) => ({ ...message })),
      paused: this.paused,
      updatedAt: this.updatedAt,
    };
  }

  private trimToMaxMessages(): void {
    if (this.messages.length <= this.maxMessages) return;
    this.messages = this.takeRecent(this.messages);
  }

  private takeRecent(messages: TranscriptMessage[]): TranscriptMessage[] {
    if (this.maxMessages <= 0) return [];
    return messages.slice(-this.maxMessages);
  }
}
