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

const toRole = (speaker: string): OverlayMessageRole =>
  speaker === "candidate" ? "candidate" : speaker === "assistant" ? "assistant" : "recruiter";

export default function OverlayApp() {
  const [messages, setMessages] = React.useState<OverlayMessage[]>([]);
  const activeAssistantId = React.useRef<string | null>(null);

  React.useEffect(() => {
    const disposeTranscript = window.callpilotDesktop?.onTranscriptMessage?.((message) => {
      setMessages((current) => [
        ...current,
        {
          id: message.id,
          role: toRole(message.speaker),
          text: message.text,
        },
      ].slice(-80));
    });
    const disposeHeadline = window.callpilotDesktop?.onAnswerHeadline?.((payload) => {
      const id = `assistant-${Date.now()}`;
      activeAssistantId.current = id;
      const assistantMessage: OverlayMessage = {
        id,
        role: "assistant",
        headline: payload.headline,
        keywords: payload.keywords,
        detail: "",
        isStreaming: true,
      };
      setMessages((current) => [...current, assistantMessage].slice(-80));
    });
    const disposeChunk = window.callpilotDesktop?.onAnswerDetailChunk?.((chunk) => {
      const id = activeAssistantId.current;
      if (!id) return;
      setMessages((current) => current.map((message) =>
        message.id === id
          ? { ...message, detail: `${message.detail ?? ""}${chunk}`, isStreaming: true }
          : message,
      ));
    });
    return () => {
      disposeTranscript?.();
      disposeHeadline?.();
      disposeChunk?.();
    };
  }, []);

  return (
    <div className="cp-overlay">
      <div className="cp-overlay__bar">
        <strong>CallPilot</strong>
        <button type="button" onClick={() => window.callpilotDesktop?.endSession?.()}>End</button>
      </div>
      <div className="cp-overlay__messages">
        {messages.map((message) => (
          <div key={message.id} className={`cp-bubble cp-bubble--${message.role}`}>
            {message.role === "assistant" ? (
              <>
                {message.headline && <p className="cp-bubble__headline">{message.headline}</p>}
                {message.keywords && message.keywords.length > 0 && (
                  <div className="cp-bubble__keywords">
                    {message.keywords.map((keyword) => <span key={keyword} className="cp-keyword">{keyword}</span>)}
                  </div>
                )}
                {message.detail && <p className="cp-bubble__detail">{message.detail}</p>}
              </>
            ) : (
              <p>{message.text}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
