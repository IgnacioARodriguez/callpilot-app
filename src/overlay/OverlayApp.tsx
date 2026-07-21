import React from "react";
import { hasTranscriptProgress, isDuplicateTranscript, transcriptDelta } from "../core/index.ts";

type OverlayMessageRole = "candidate" | "recruiter" | "assistant";

interface OverlayMessage {
  id: string;
  requestId?: string;
  role: OverlayMessageRole;
  text?: string;
  headline?: string;
  keywords?: string[];
  detail?: string;
  isStreaming?: boolean;
}

interface AnswerHeadlinePayload {
  requestId?: string;
  headline: string;
  keywords: string[];
}

interface AnswerDetailPayload {
  requestId?: string;
  sequence?: number;
  text?: string;
  done?: boolean;
  cancelled?: boolean;
  error?: string;
}

interface AnswerStatusPayload {
  requestId?: string;
  status: "busy" | "completed" | "failed" | "cancelled";
  text?: string;
  error?: string;
  timestamp: number;
}

interface LiveTranscriptState {
  id: string;
  committed: string;
  baseline?: string;
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

const liveTranscriptText = (text = ""): string => {
  const clean = text.trim();
  if (clean.length <= 260) return clean;
  return `...${clean.slice(-260)}`;
};

export default function OverlayApp() {
  const [messages, setMessages] = React.useState<OverlayMessage[]>([]);
  const [isRequestingAnswer, setIsRequestingAnswer] = React.useState(false);
  const [activeAnswerRequestId, setActiveAnswerRequestId] = React.useState<string | null>(null);
  const [activity, setActivity] = React.useState<{ state: "idle" | "listening" | "transcribing"; label: string; updatedAt: number }>({
    state: "idle",
    label: "Waiting",
    updatedAt: 0,
  });
  const activeAssistantId = React.useRef<string | null>(null);
  const assistantIdByRequest = React.useRef<Record<string, string>>({});
  const lastSequenceByRequest = React.useRef<Record<string, number>>({});
  const liveTranscriptByRole = React.useRef<Partial<Record<OverlayMessageRole, LiveTranscriptState>>>({});
  const messagesStateRef = React.useRef<OverlayMessage[]>([]);
  const activeAnswerRequestIdRef = React.useRef<string | null>(null);
  const messagesRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    messagesStateRef.current = messages;
  }, [messages]);

  React.useEffect(() => {
    activeAnswerRequestIdRef.current = activeAnswerRequestId;
  }, [activeAnswerRequestId]);

  React.useEffect(() => {
    const upsertLiveTranscript = (role: OverlayMessageRole, text: string, mode: "partial" | "final") => {
      const clean = text.trim();
      if (!clean) return;
      const now = Date.now();
      const existing = liveTranscriptByRole.current[role];
      const canReuse = Boolean(existing && now - existing.lastUpdatedAt < 8000);
      const id = canReuse && existing ? existing.id : `live-${role}-${now}`;
      const committed = canReuse && existing ? existing.committed : "";
      const baseline = canReuse && existing ? existing.baseline ?? "" : "";
      const existingIndexBeforeUpdate = messagesStateRef.current.findIndex((item) => item.id === id);
      const assistantAfterExistingBeforeUpdate = existingIndexBeforeUpdate >= 0
        && messagesStateRef.current.slice(existingIndexBeforeUpdate + 1).some((item) => item.role === "assistant");
      const nextCommitted = mode === "final"
        ? isDuplicateTranscript(committed, clean)
          ? committed.length >= clean.length ? committed : clean
          : [committed, clean].filter(Boolean).join(" ")
        : committed;
      if (mode === "partial" && committed && !hasTranscriptProgress(committed, clean)) {
        liveTranscriptByRole.current[role] = {
          id,
          committed,
          baseline,
          lastUpdatedAt: now,
        };
        return;
      }
      if (mode === "partial" && committed && isDuplicateTranscript(committed, clean) && !assistantAfterExistingBeforeUpdate) {
        liveTranscriptByRole.current[role] = {
          id,
          committed,
          baseline,
          lastUpdatedAt: now,
        };
        return;
      }
      liveTranscriptByRole.current[role] = {
        id,
        committed: nextCommitted,
        baseline,
        lastUpdatedAt: now,
      };

      setMessages((current) => {
        const existingIndex = current.findIndex((item) => item.id === id);
        const assistantAfterExisting = existingIndex >= 0
          && current.slice(existingIndex + 1).some((item) => item.role === "assistant");
        const targetId = mode === "partial" && assistantAfterExisting ? `live-${role}-${now}` : id;
        const targetBaseline = targetId === id ? baseline : current[existingIndex]?.text ?? "";
        const targetCommitted = targetId === id ? committed : "";
        const targetDisplayText = mode === "partial"
          ? targetBaseline
            ? transcriptDelta(targetBaseline, clean)
            : [targetCommitted, clean].filter(Boolean).join(" ")
          : nextCommitted;
        if (targetId !== id) {
          liveTranscriptByRole.current[role] = {
            id: targetId,
            committed: targetCommitted,
            baseline: targetBaseline,
            lastUpdatedAt: now,
          };
        }
        if (mode === "final" && role !== "assistant") {
          const duplicate = [...current].reverse().find((item) =>
            item.role === role
            && item.text
            && isDuplicateTranscript(item.text, clean)
          );
          if (duplicate) {
            liveTranscriptByRole.current[role] = {
              id: duplicate.id,
              committed: (duplicate.text ?? "").length >= clean.length ? duplicate.text ?? "" : clean,
              baseline: undefined,
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
        const exists = current.some((item) => item.id === targetId);
        if (exists) {
          return current.map((item) =>
            item.id === targetId ? { ...item, role, text: targetDisplayText, isStreaming: mode === "partial" } : item,
          ).filter(hasMessageContent);
        }
        return [...current, { id: targetId, role, text: targetDisplayText, isStreaming: mode === "partial" }]
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
      if (payload.status === "cancelled") {
        setActiveAnswerRequestId(null);
      }
      setActivity({
        state: payload.status === "cancelled" ? "idle" : payload.ok ? "transcribing" : "idle",
        label: payload.status === "cancelled" ? "Stopped" : payload.ok ? "Sent" : "Request failed",
        updatedAt: Date.now(),
      });
    });
    const ensureAssistantMessage = (requestId?: string): string => {
      if (requestId && assistantIdByRequest.current[requestId]) {
        activeAssistantId.current = assistantIdByRequest.current[requestId];
        return assistantIdByRequest.current[requestId];
      }
      const id = `assistant-${requestId || Date.now()}`;
      activeAssistantId.current = id;
      if (requestId) assistantIdByRequest.current[requestId] = id;
      return id;
    };

    const disposeHeadline = window.callpilotDesktop?.onAnswerHeadline?.((payload: AnswerHeadlinePayload) => {
      const keywords = (payload.keywords ?? []).filter((keyword) => keyword.trim());
      if (!payload.headline?.trim() && keywords.length === 0) return;
      const id = ensureAssistantMessage(payload.requestId);
      if (payload.requestId) setActiveAnswerRequestId(payload.requestId);
      const assistantMessage: OverlayMessage = {
        id,
        requestId: payload.requestId,
        role: "assistant",
        headline: payload.headline,
        keywords,
        detail: "",
        isStreaming: true,
      };
      if (!visibleAssistantContent(assistantMessage)) return;
      setMessages((current) => {
        const exists = current.some((message) => message.id === id);
        if (exists) {
          return current.map((message) => message.id === id ? { ...message, ...assistantMessage } : message)
            .filter(hasMessageContent)
            .slice(-80);
        }
        return [...current, assistantMessage].filter(hasMessageContent).slice(-80);
      });
    });
    const disposeChunk = window.callpilotDesktop?.onAnswerDetailChunk?.((payload: AnswerDetailPayload | string) => {
      const normalized: AnswerDetailPayload = typeof payload === "string" ? { text: payload } : payload;
      const chunk = normalized.text ?? "";
      if (normalized.requestId) setActiveAnswerRequestId(normalized.done || normalized.cancelled ? null : normalized.requestId);
      if (normalized.cancelled) {
        setActivity({ state: "idle", label: "Stopped", updatedAt: Date.now() });
      }
      if (normalized.requestId && typeof normalized.sequence === "number") {
        const previous = lastSequenceByRequest.current[normalized.requestId] ?? 0;
        if (normalized.sequence <= previous) return;
        lastSequenceByRequest.current[normalized.requestId] = normalized.sequence;
      }
      let id = normalized.requestId
        ? assistantIdByRequest.current[normalized.requestId]
        : activeAssistantId.current;
      if (!id) {
        const newId = ensureAssistantMessage(normalized.requestId);
        activeAssistantId.current = newId;
        const assistantMessage: OverlayMessage = {
          id: newId,
          requestId: normalized.requestId,
          role: "assistant",
          detail: normalized.error ? `Generation failed: ${normalized.error}` : chunk,
          isStreaming: !normalized.done,
        };
        if (!visibleAssistantContent(assistantMessage)) return;
        setMessages((current) => [
          ...current,
          assistantMessage,
        ].filter(hasMessageContent).slice(-80));
        return;
      }
      if (!chunk.trim() && !normalized.done && !normalized.error) return;
      setMessages((current) => current.map((message) =>
        message.id === id
          ? {
            ...message,
            detail: normalized.error ? `${message.detail ?? ""}\nGeneration failed: ${normalized.error}` : `${message.detail ?? ""}${chunk}`,
            isStreaming: !normalized.done,
          }
          : message,
      ).filter((message) => message.role === "assistant" ? visibleAssistantContent(message) : hasMessageContent(message)));
      if (normalized.done && normalized.requestId) {
        delete assistantIdByRequest.current[normalized.requestId];
        delete lastSequenceByRequest.current[normalized.requestId];
        if (activeAssistantId.current === id) activeAssistantId.current = null;
        setActiveAnswerRequestId(null);
      }
    });
    const disposeAnswerStatus = window.callpilotDesktop?.onAnswerStatus?.((payload: AnswerStatusPayload) => {
      const text = (payload.text ?? (payload.error ? `Generation failed: ${payload.error}` : "")).trim();
      if (!text) return;
      const terminal = payload.status === "completed" || payload.status === "failed" || payload.status === "cancelled";
      if (!payload.requestId && payload.status === "busy") {
        setActivity({ state: "transcribing", label: "Already answering", updatedAt: Date.now() });
        return;
      }
      const id = payload.requestId ? ensureAssistantMessage(payload.requestId) : `assistant-status-${payload.timestamp || Date.now()}`;
      const assistantMessage: OverlayMessage = {
        id,
        requestId: payload.requestId,
        role: "assistant",
        text,
        detail: terminal ? "" : undefined,
        isStreaming: !terminal,
      };
      setMessages((current) => {
        const exists = current.some((message) => message.id === id);
        if (exists) {
          return current.map((message) => message.id === id ? { ...message, ...assistantMessage } : message)
            .filter(hasMessageContent)
            .slice(-80);
        }
        return [...current, assistantMessage].filter(hasMessageContent).slice(-80);
      });
      setActivity({
        state: terminal ? "idle" : "transcribing",
        label: payload.status === "failed"
          ? "Answer failed"
          : payload.status === "cancelled"
            ? "Stopped"
            : payload.status === "busy"
              ? "Already answering"
              : "Ready",
        updatedAt: Date.now(),
      });
      if (terminal && payload.requestId) {
        delete assistantIdByRequest.current[payload.requestId];
        delete lastSequenceByRequest.current[payload.requestId];
        if (activeAssistantId.current === id) activeAssistantId.current = null;
        setActiveAnswerRequestId(null);
      } else if (payload.requestId) {
        setActiveAnswerRequestId(payload.requestId);
      }
    });
    return () => {
      disposeTranscript?.();
      disposeLive?.();
      disposeNativelyStatus?.();
      disposeManualAnswerStatus?.();
      disposeHeadline?.();
      disposeChunk?.();
      disposeAnswerStatus?.();
    };
  }, []);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setActivity((current) => {
        if (current.state !== "transcribing") return current;
        if (activeAnswerRequestIdRef.current) return current;
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

  const cancelAnswer = async () => {
    if (!activeAnswerRequestId) return;
    const requestId = activeAnswerRequestId;
    setActiveAnswerRequestId(null);
    setIsRequestingAnswer(false);
    setActivity({ state: "idle", label: "Stopping", updatedAt: Date.now() });
    const result = await window.callpilotDesktop?.cancelAnswer?.(requestId).catch(() => ({ ok: false }));
    setActivity({ state: "idle", label: result?.ok ? "Stopped" : "Stop failed", updatedAt: Date.now() });
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
          {activeAnswerRequestId && (
            <button className="cp-stop-button" type="button" onClick={cancelAnswer}>
              Stop
            </button>
          )}
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
                {message.isStreaming && (
                  <span className="cp-bubble__typing" aria-label="CallPilot is typing">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </>
            ) : (
              message.text?.trim() ? <p>{message.isStreaming ? liveTranscriptText(message.text) : message.text}</p> : null
            )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
