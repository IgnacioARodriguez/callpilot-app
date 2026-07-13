import React from "react";

type OverlayMessageRole = "candidate" | "recruiter" | "assistant";

interface OverlayMessage {
  id: string;
  role: OverlayMessageRole;
  text?: string;
  headline?: string;
  keywords?: string[];
  detail?: string;
  isStreaming?: boolean;
}

interface LiveTranscriptState {
  id: string;
  committed: string;
  lastUpdatedAt: number;
}

const toRole = (speaker: string): OverlayMessageRole =>
  speaker === "candidate" ? "candidate" : speaker === "assistant" ? "assistant" : "recruiter";

const roleLabel = (role: OverlayMessageRole) => {
  if (role === "candidate") return "Me";
  if (role === "assistant") return "CallPilot";
  return "Interviewer";
};

const hasMessageContent = (message: OverlayMessage): boolean =>
  Boolean(
    message.text?.trim()
    || message.headline?.trim()
    || message.detail?.trim()
    || (message.keywords && message.keywords.some((keyword) => keyword.trim())),
  );

const normalizeText = (text = "") => text.toLowerCase().replace(/\s+/g, " ").trim();

const isDuplicateTranscript = (left: string, right: string): boolean => {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
};

const visibleAssistantContent = (message: OverlayMessage): boolean =>
  Boolean(
    message.text?.trim()
    || message.headline?.trim()
    || message.detail?.trim()
    || (message.keywords && message.keywords.some((keyword) => keyword.trim())),
  );

const splitReadableBlocks = (text: string): string[] =>
  text
    .replace(/\s+(?=\*\*[^*]{1,32}:\*\*)/g, "\n")
    .replace(/\.\s+(?=(Observacion|Observación|Recomendacion|Recomendación|Aclaracion|Aclaración|Respuesta|Idea|Tradeoff|Nota):)/gi, ".\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

const renderInlineFormat = (text: string) => {
  const parts: React.ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(<strong key={`${match.index}-${match[1]}`}>{match[1]}</strong>);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : text;
};

const renderFormattedText = (text: string) => (
  <div className="cp-rich-text">
    {splitReadableBlocks(text).map((block, index) => (
      <p key={`${index}-${block.slice(0, 24)}`}>{renderInlineFormat(block)}</p>
    ))}
  </div>
);

export default function OverlayApp() {
  const [messages, setMessages] = React.useState<OverlayMessage[]>([]);
  const [isRequestingAnswer, setIsRequestingAnswer] = React.useState(false);
  const [activity, setActivity] = React.useState<{ state: "idle" | "listening" | "transcribing"; label: string; updatedAt: number }>({
    state: "idle",
    label: "Waiting",
    updatedAt: 0,
  });
  const activeAssistantId = React.useRef<string | null>(null);
  const liveTranscriptByRole = React.useRef<Partial<Record<OverlayMessageRole, LiveTranscriptState>>>({});
  const messagesRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const upsertLiveTranscript = (role: OverlayMessageRole, text: string, mode: "partial" | "final") => {
      const clean = text.trim();
      if (!clean) return;
      const now = Date.now();
      const existing = liveTranscriptByRole.current[role];
      const canReuse = Boolean(existing && now - existing.lastUpdatedAt < 8000);
      const id = canReuse && existing ? existing.id : `live-${role}-${now}`;
      const committed = canReuse && existing ? existing.committed : "";
      const nextCommitted = mode === "final"
        ? isDuplicateTranscript(committed, clean)
          ? committed.length >= clean.length ? committed : clean
          : [committed, clean].filter(Boolean).join(" ")
        : committed;
      if (mode === "partial" && committed && isDuplicateTranscript(committed, clean)) {
        liveTranscriptByRole.current[role] = {
          id,
          committed,
          lastUpdatedAt: now,
        };
        return;
      }
      const displayText = mode === "partial"
        ? [committed, clean].filter(Boolean).join(" ")
        : nextCommitted;

      liveTranscriptByRole.current[role] = {
        id,
        committed: nextCommitted,
        lastUpdatedAt: now,
      };

      setMessages((current) => {
        if (mode === "final") {
          const duplicate = [...current].reverse().find((item) =>
            item.role === role
            && item.text
            && isDuplicateTranscript(item.text, clean)
          );
          if (duplicate) {
            liveTranscriptByRole.current[role] = {
              id: duplicate.id,
              committed: (duplicate.text ?? "").length >= clean.length ? duplicate.text ?? "" : clean,
              lastUpdatedAt: now,
            };
            return current.map((item) =>
              item.id === duplicate.id
                ? {
                  ...item,
                  text: (item.text ?? "").length >= clean.length ? item.text : clean,
                  isStreaming: false,
                }
                : item,
            ).filter(hasMessageContent);
          }
        }
        const exists = current.some((item) => item.id === id);
        if (exists) {
          return current.map((item) =>
            item.id === id ? { ...item, role, text: displayText, isStreaming: mode === "partial" } : item,
          ).filter(hasMessageContent);
        }
        return [...current, { id, role, text: displayText, isStreaming: mode === "partial" }]
          .filter(hasMessageContent)
          .slice(-80);
      });
    };

    const disposeTranscript = window.callpilotDesktop?.onTranscriptMessage?.((message) => {
      const role = toRole(message.speaker);
      setActivity({ state: "transcribing", label: role === "candidate" ? "Me" : "Transcribing", updatedAt: Date.now() });
      upsertLiveTranscript(role, message.text, "final");
    });
    const disposeLive = window.callpilotDesktop?.onLiveTranscript?.((message) => {
      const role = toRole(message.speaker);
      setActivity({ state: "transcribing", label: role === "candidate" ? "Me" : "Transcribing", updatedAt: Date.now() });
      upsertLiveTranscript(role, message.text, "partial");
    });
    const disposeNativelyStatus = window.callpilotDesktop?.onNativelyStatus?.((payload) => {
      const detail = payload.detail?.toLowerCase() ?? "";
      if (payload.status === "connected" || detail.includes("connected")) {
        setActivity({ state: "listening", label: "Listening", updatedAt: Date.now() });
      }
      if (payload.status === "closed" || detail.includes("closed") || detail.includes("ended")) {
        setActivity({ state: "idle", label: "Stopped", updatedAt: Date.now() });
      }
      if (payload.status === "error") {
        setActivity({ state: "idle", label: "Check audio", updatedAt: Date.now() });
      }
    });
    const disposeManualAnswerStatus = window.callpilotDesktop?.onManualAnswerStatus?.((payload) => {
      setActivity({
        state: payload.ok ? "transcribing" : "idle",
        label: payload.ok ? "Sent" : "Request failed",
        updatedAt: Date.now(),
      });
    });
    const disposeHeadline = window.callpilotDesktop?.onAnswerHeadline?.((payload) => {
      const keywords = (payload.keywords ?? []).filter((keyword) => keyword.trim());
      if (!payload.headline?.trim() && keywords.length === 0) return;
      const id = `assistant-${Date.now()}`;
      activeAssistantId.current = id;
      const assistantMessage: OverlayMessage = {
        id,
        role: "assistant",
        headline: payload.headline,
        keywords,
        detail: "",
        isStreaming: true,
      };
      if (!visibleAssistantContent(assistantMessage)) return;
      setMessages((current) => [...current, assistantMessage].filter(hasMessageContent).slice(-80));
    });
    const disposeChunk = window.callpilotDesktop?.onAnswerDetailChunk?.((chunk) => {
      if (!chunk.trim()) return;
      let id = activeAssistantId.current;
      if (!id) {
        const newId = `assistant-${Date.now()}`;
        activeAssistantId.current = newId;
        const assistantMessage: OverlayMessage = { id: newId, role: "assistant", detail: chunk, isStreaming: true };
        if (!visibleAssistantContent(assistantMessage)) return;
        setMessages((current) => [
          ...current,
          assistantMessage,
        ].filter(hasMessageContent).slice(-80));
        return;
      }
      setMessages((current) => current.map((message) =>
        message.id === id
          ? { ...message, detail: `${message.detail ?? ""}${chunk}`, isStreaming: true }
          : message,
      ).filter((message) => message.role === "assistant" ? visibleAssistantContent(message) : hasMessageContent(message)));
    });
    return () => {
      disposeTranscript?.();
      disposeLive?.();
      disposeNativelyStatus?.();
      disposeManualAnswerStatus?.();
      disposeHeadline?.();
      disposeChunk?.();
    };
  }, []);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setActivity((current) => {
        if (current.state !== "transcribing") return current;
        return Date.now() - current.updatedAt > 2500
          ? { state: "listening", label: "Listening", updatedAt: current.updatedAt }
          : current;
      });
    }, 700);
    return () => window.clearInterval(timer);
  }, []);

  React.useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const requestAnswer = async () => {
    setIsRequestingAnswer(true);
    setActivity({ state: "transcribing", label: "Answering", updatedAt: Date.now() });
    try {
      if (!window.callpilotDesktop?.requestAnswer) {
        setActivity({ state: "idle", label: "Restart app", updatedAt: Date.now() });
        return;
      }
      const result = await window.callpilotDesktop.requestAnswer();
      if (!result.ok) {
        setActivity({ state: "idle", label: "Request failed", updatedAt: Date.now() });
      }
    } finally {
      window.setTimeout(() => setIsRequestingAnswer(false), 500);
    }
  };

  return (
    <div className="cp-overlay">
      <div className="cp-overlay__bar">
        <div className="cp-overlay__title">
          <strong>CallPilot</strong>
          <span>Live interview chat</span>
        </div>
        <div className={`cp-listening cp-listening--${activity.state}`} aria-label={activity.label}>
          <span className="cp-listening__dot" />
          <span className="cp-listening__text">{activity.label}</span>
          {activity.state === "transcribing" && (
            <span className="cp-typing" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
        <div className="cp-overlay__actions">
          <button className="cp-answer-button" type="button" onClick={requestAnswer} disabled={isRequestingAnswer}>
            {isRequestingAnswer ? "..." : "Answer"}
          </button>
          <button type="button" onClick={() => window.callpilotDesktop?.endSession?.()}>End</button>
        </div>
      </div>
      <div className="cp-overlay__messages" ref={messagesRef}>
        {messages.length === 0 ? (
          <div className="cp-empty">
            <strong>Waiting for the call</strong>
            <span>Interviewer, your voice, and CallPilot suggestions will appear here as a three-person chat.</span>
          </div>
        ) : messages
          .filter((message) => message.role === "assistant" ? visibleAssistantContent(message) : hasMessageContent(message))
          .map((message) => (
          <div key={message.id} className={`cp-message cp-message--${message.role}`}>
            <span className="cp-message__label">{roleLabel(message.role)}</span>
            <div className={`cp-bubble cp-bubble--${message.role}`}>
            {message.role === "assistant" ? (
              <>
                {message.text && renderFormattedText(message.text)}
                {message.headline && <p className="cp-bubble__headline">{message.headline}</p>}
                {message.keywords && message.keywords.some((keyword) => keyword.trim()) && (
                  <div className="cp-bubble__keywords">
                    {message.keywords.filter((keyword) => keyword.trim()).map((keyword) => <span key={keyword} className="cp-keyword">{keyword}</span>)}
                  </div>
                )}
                {message.detail && <div className="cp-bubble__detail">{renderFormattedText(message.detail)}</div>}
              </>
            ) : (
              message.text?.trim() ? <p>{message.text}</p> : null
            )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
