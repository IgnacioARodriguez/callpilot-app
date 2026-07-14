export interface SseParseState {
  buffer: string;
  done: boolean;
  malformedCount: number;
}

export interface SseParseResult {
  state: SseParseState;
  events: unknown[];
  textDelta: string;
}

export const createSseParseState = (): SseParseState => ({
  buffer: "",
  done: false,
  malformedCount: 0,
});

const parseDataLine = (line: string): { event?: unknown; done?: boolean; malformed?: boolean; textDelta?: string } => {
  const clean = line.trim();
  if (!clean) return {};
  if (clean === "[DONE]") return { done: true };
  try {
    const event = JSON.parse(clean);
    const textDelta = event?.type === "response.output_text.delta" && typeof event?.delta === "string"
      ? event.delta
      : "";
    return { event, textDelta };
  } catch {
    return { malformed: true };
  }
};

const parseRawEvent = (rawEvent: string): { events: unknown[]; textDelta: string; done: boolean; malformedCount: number } => {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  const events: unknown[] = [];
  let textDelta = "";
  let done = false;
  let malformedCount = 0;

  for (const line of dataLines) {
    const parsed = parseDataLine(line);
    if (parsed.done) done = true;
    if (parsed.malformed) malformedCount += 1;
    if (parsed.event) events.push(parsed.event);
    if (parsed.textDelta) textDelta += parsed.textDelta;
  }

  return { events, textDelta, done, malformedCount };
};

export const parseSseChunk = (
  state: SseParseState,
  chunk: string,
  options: { flush?: boolean } = {},
): SseParseResult => {
  const nextState = { ...state, buffer: `${state.buffer}${chunk}` };
  const events: unknown[] = [];
  let textDelta = "";
  const parts = nextState.buffer.split(/\r?\n\r?\n/);
  nextState.buffer = options.flush ? "" : parts.pop() ?? "";
  const completeEvents = options.flush ? parts.filter(Boolean) : parts;

  for (const rawEvent of completeEvents) {
    const parsed = parseRawEvent(rawEvent);
    events.push(...parsed.events);
    textDelta += parsed.textDelta;
    nextState.done = nextState.done || parsed.done;
    nextState.malformedCount += parsed.malformedCount;
  }

  return { state: nextState, events, textDelta };
};
