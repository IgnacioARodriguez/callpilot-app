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

export class TranscriptBuffer {
  private messages: TranscriptMessage[];
  private paused: boolean;
  private updatedAt: number;
  private sequence: number;

  constructor(snapshot = createEmptyTranscriptSnapshot()) {
    this.messages = snapshot.messages.map((message) => ({ ...message }));
    this.paused = snapshot.paused;
    this.updatedAt = snapshot.updatedAt;
    this.sequence = this.messages.length;
  }

  append(text: string, source: TranscriptSource = "manual", timestamp = Date.now(), speaker: TranscriptSpeaker = "interviewer"): TranscriptMessage | null {
    const cleanText = text.trim();
    this.updatedAt = timestamp;
    if (this.paused || cleanText.length === 0) return null;
    this.sequence += 1;
    const message = { id: `tr-${timestamp}-${this.sequence}`, text: cleanText, timestamp, source, speaker };
    this.messages = [...this.messages, message];
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
}
