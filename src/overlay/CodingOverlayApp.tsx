import React from "react";
import { Camera } from "lucide-react";
import { classifyScreenText, normalizeOcrLanguage, ocrConfidenceLabel, type CodingAnswerPayload, type StructuredAnswerPayload } from "../core";

interface StructuredAnswerEvent {
  requestId?: string;
  answer: StructuredAnswerPayload;
  renderedText: string;
  timestamp: number;
}

const emptyCodingAnswer: CodingAnswerPayload = {
  version: "1",
  answerNeeded: true,
  responseType: "clarification",
  problem: {
    title: "Waiting for coding exercise",
    summary: "When CallPilot detects or generates a live coding answer, the solution will appear here.",
    language: "Python",
    functionSignature: null,
    constraints: [],
  },
  solution: {
    approachSteps: [],
    code: "",
    complexity: { time: "", space: "", rationale: "" },
    edgeCases: [],
    invariants: [],
  },
  narration: {
    spokenAnswer: "",
    currentStep: "Listening for the exercise",
  },
  tests: [],
  patch: { kind: "none", code: null },
};

const responseTypeLabel = (type: CodingAnswerPayload["responseType"]) => ({
  initial_solution: "Initial solution",
  explanation: "Explanation",
  follow_up_change: "Requested change",
  debug_fix: "Debug fix",
  clarification: "Clarification",
}[type]);

const displayCode = (payload: CodingAnswerPayload): string =>
  payload.patch.kind === "replace" && payload.patch.code
    ? payload.patch.code
    : payload.solution.code;

const pythonKeywords = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

const builtinNames = new Set([
  "bool", "dict", "enumerate", "float", "input", "int", "len", "list", "max", "min", "print", "range", "set",
  "str", "sum", "tuple", "zip",
]);

const highlightCodeLine = (line: string, lineNumber: number): React.ReactNode[] => {
  const nodes: React.ReactNode[] = [];
  const pattern = /(#.*$|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b|[()[\]{}.,:+=*/%-])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index));
    }

    const token = match[0];
    let className = "";
    if (token.startsWith("#")) className = "cp-token-comment";
    else if (/^["']/.test(token)) className = "cp-token-string";
    else if (/^\d/.test(token)) className = "cp-token-number";
    else if (/^[A-Za-z_]/.test(token) && line.slice(pattern.lastIndex).trimStart().startsWith("(")) className = "cp-token-function";
    else if (pythonKeywords.has(token)) className = "cp-token-keyword";
    else if (builtinNames.has(token)) className = "cp-token-builtin";
    else if (/^[A-Za-z_]/.test(token)) className = "cp-token-variable";
    else if (/^[()[\]{}.,:+=*/%-]$/.test(token)) className = "cp-token-punctuation";

    nodes.push(className
      ? <span className={className} key={`${lineNumber}-${match.index}`}>{token}</span>
      : token);
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return nodes;
};

const HighlightedCode = React.forwardRef<HTMLPreElement, { code: string }>(function HighlightedCode({ code }, ref) {
  return (
    <pre ref={ref} className="cp-code-block" aria-label="Generated code">
      <code>
        {code.split("\n").map((line, index) => (
          <span className="cp-code-line" key={`${index}-${line}`}>
            <span className="cp-code-line__number">{index + 1}</span>
            <span className="cp-code-line__content">{highlightCodeLine(line, index)}</span>
          </span>
        ))}
      </code>
    </pre>
  );
});

const CodePlaceholder = () => (
  <div className="cp-code-placeholder">
    <strong>No solution yet</strong>
    <span>Press Answer when the interviewer gives the exercise or asks for a change.</span>
  </div>
);

export default function CodingOverlayApp() {
  const [payload, setPayload] = React.useState<CodingAnswerPayload>(emptyCodingAnswer);
  const [updatedAt, setUpdatedAt] = React.useState<number>(0);
  const [screenStatus, setScreenStatus] = React.useState("No screenshot selected");
  const [screenshotCount, setScreenshotCount] = React.useState(0);
  const [isCapturingScreen, setIsCapturingScreen] = React.useState(false);
  const [isRequestingAnswer, setIsRequestingAnswer] = React.useState(false);
  const [activeAnswerRequestId, setActiveAnswerRequestId] = React.useState<string | null>(null);
  const codeRef = React.useRef<HTMLPreElement | null>(null);
  const reasoningRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onStructuredAnswer?.((event: StructuredAnswerEvent) => {
      if (event.answer.kind !== "coding") return;
      setPayload(event.answer.payload);
      setUpdatedAt(event.timestamp);
    });
    return () => dispose?.();
  }, []);

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onAnswerStatus?.((event) => {
      if (event.requestId) {
        setActiveAnswerRequestId(event.status === "completed" || event.status === "failed" || event.status === "cancelled" ? null : event.requestId);
      }
      if (event.status === "completed" || event.status === "failed" || event.status === "cancelled") {
        setIsRequestingAnswer(false);
      }
    });
    return () => dispose?.();
  }, []);

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onScreenContextPublished?.((event) => {
      if (event.source !== "coding_overlay") return;
      const classified = classifyScreenText(event.visibleText ?? "");
      const hasCodingSignal = classified.kind === "coding_problem" || classified.kind === "code_editor";
      setScreenshotCount((current) => Math.min(5, current + 1));
      setScreenStatus(hasCodingSignal ? "Screenshots ready for Answer code" : "Screenshot captured; no coding problem detected");
    });
    return () => dispose?.();
  }, []);

  const captureScreenContext = React.useCallback(async () => {
    if (
      !window.callpilotDesktop?.captureScreenshot
      || !window.callpilotDesktop?.recognizeScreenText
      || !window.callpilotDesktop?.publishScreenContext
    ) {
      setScreenStatus("Desktop screenshot tools unavailable");
      return;
    }

    setIsCapturingScreen(true);
    setScreenStatus("Capturing screen...");
    try {
      const capturedAt = Date.now();
      const screenshot = await window.callpilotDesktop.captureScreenshot({ hideCallPilotWindows: true });
      if (!screenshot.ok || !screenshot.path) {
        setScreenStatus(`Screenshot failed: ${screenshot.error ?? "unknown"}`);
        return;
      }

      setScreenStatus("Reading screenshot...");
      const ocr = await window.callpilotDesktop.recognizeScreenText({
        path: screenshot.path,
        language: normalizeOcrLanguage("auto"),
      });
      const visibleText = [
        ocr.ok && ocr.text ? ocr.text : "",
        ocr.ok
          ? `Local OCR: ${ocr.language} - confidence ${ocrConfidenceLabel(ocr.confidence)}${typeof ocr.confidence === "number" ? ` (${ocr.confidence.toFixed(1)})` : ""}`
          : `Local OCR failed: ${ocr.error ?? "no text found"}`,
      ].filter(Boolean).join("\n\n");
      const classified = classifyScreenText(ocr.ok && ocr.text ? ocr.text : "");
      const hasCodingSignal = classified.kind === "coding_problem" || classified.kind === "code_editor";
      const published = await window.callpilotDesktop.publishScreenContext({
        screenshotPath: screenshot.path,
        visibleText,
        displayName: screenshot.displayName,
        source: "coding_overlay",
        capturedAt,
      });
      setScreenStatus(published.ok
        ? hasCodingSignal ? "Screenshot ready for Answer code" : "No coding problem detected"
        : `Context update failed: ${published.error ?? "unknown"}`);
    } catch (error) {
      setScreenStatus(error instanceof Error ? error.message : "Screenshot capture failed");
    } finally {
      setIsCapturingScreen(false);
    }
  }, []);

  const requestAnswer = async () => {
    setIsRequestingAnswer(true);
    const result = await window.callpilotDesktop?.requestAnswer?.({ audience: "coding" }).catch(() => ({ ok: false }));
    if (!result?.ok) {
      setIsRequestingAnswer(false);
      setScreenStatus("Answer request failed");
    }
  };

  const cancelAnswer = async () => {
    if (!activeAnswerRequestId) return;
    const requestId = activeAnswerRequestId;
    setActiveAnswerRequestId(null);
    setIsRequestingAnswer(false);
    await window.callpilotDesktop?.cancelAnswer?.(requestId).catch(() => undefined);
  };

  const resetExercise = async () => {
    setPayload(emptyCodingAnswer);
    setUpdatedAt(0);
    setScreenStatus("New exercise ready");
    setScreenshotCount(0);
    setActiveAnswerRequestId(null);
    setIsRequestingAnswer(false);
    await window.callpilotDesktop?.dispatchRemoteControlCommand?.({ type: "reset_exercise" }).catch(() => undefined);
  };

  const restartSession = async () => {
    setPayload(emptyCodingAnswer);
    setUpdatedAt(0);
    setScreenStatus("New session ready");
    setScreenshotCount(0);
    setActiveAnswerRequestId(null);
    setIsRequestingAnswer(false);
    await window.callpilotDesktop?.dispatchRemoteControlCommand?.({ type: "reset_session" }).catch(() => undefined);
  };

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onRemoteControlCommand?.((command) => {
      if (command.type === "reset_session" || command.type === "reset_exercise") {
        setPayload(emptyCodingAnswer);
        setUpdatedAt(0);
        setScreenStatus(command.type === "reset_session" ? "New session ready" : "New exercise ready");
        setScreenshotCount(0);
        setActiveAnswerRequestId(null);
        setIsRequestingAnswer(false);
        return;
      }
      if (command.type === "screenshot") {
        void captureScreenContext();
        return;
      }
      if (command.type !== "scroll") return;
      const target = command.target === "code" ? codeRef.current : command.target === "reasoning" ? reasoningRef.current : null;
      target?.scrollBy({ top: command.delta ?? 0, behavior: "smooth" });
    });
    return () => dispose?.();
  }, [captureScreenContext]);

  const code = displayCode(payload);
  const complexity = [
    payload.solution.complexity.time ? `Time ${payload.solution.complexity.time}` : "",
    payload.solution.complexity.space ? `Space ${payload.solution.complexity.space}` : "",
  ].filter(Boolean).join(" | ");
  const hasContent = Boolean(code || payload.narration.spokenAnswer || payload.solution.approachSteps.length);

  return (
    <div className="cp-coding">
      <div className="cp-coding__bar">
        <div>
          <strong>Live Coding</strong>
          <span>{screenStatus}</span>
        </div>
        <div className="cp-coding__actions">
          <button type="button" onClick={requestAnswer} disabled={isRequestingAnswer}>
            {isRequestingAnswer ? "..." : "Answer"}
          </button>
          <button type="button" onClick={cancelAnswer} disabled={!activeAnswerRequestId}>Stop</button>
          <button type="button" onClick={resetExercise}>Reset</button>
          <button type="button" onClick={restartSession}>Restart</button>
          <button type="button" onClick={captureScreenContext} disabled={isCapturingScreen} title="Capture screen for the next Answer">
            <Camera size={14} />
            {isCapturingScreen ? "..." : "Screenshot"}
          </button>
          <span className={screenshotCount > 0 ? "cp-capture-count ready" : "cp-capture-count"}>
            {screenshotCount > 0 ? `${screenshotCount} ready` : "0 ready"}
          </span>
          <span>{hasContent ? responseTypeLabel(payload.responseType) : "Solution workspace"}</span>
        </div>
      </div>
      <div className="cp-coding__body">
        <section className="cp-code-panel">
          <div className="cp-panel-title">
            <strong>{payload.problem.title || "Solution"}</strong>
            <span>{payload.problem.language || "Code"}</span>
          </div>
          {code ? <HighlightedCode ref={codeRef} code={code} /> : <CodePlaceholder />}
        </section>
        <section className="cp-reasoning-panel">
          <div className="cp-panel-title">
            <strong>Reasoning</strong>
            <span>{updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Ready"}</span>
          </div>
          <div className="cp-mini-chat" ref={reasoningRef}>
            {payload.problem.summary && (
              <div>
                <strong>Problem</strong>
                <p>{payload.problem.summary}</p>
              </div>
            )}
            {payload.narration.spokenAnswer && (
              <div>
                <strong>What to say</strong>
                <p>{payload.narration.spokenAnswer}</p>
              </div>
            )}
            {payload.solution.approachSteps.length > 0 && (
              <div>
                <strong>Approach</strong>
                {payload.solution.approachSteps.map((step) => <p key={step}>{step}</p>)}
              </div>
            )}
            {(complexity || payload.solution.complexity.rationale) && (
              <div>
                <strong>Complexity</strong>
                {complexity && <p>{complexity}</p>}
                {payload.solution.complexity.rationale && <p>{payload.solution.complexity.rationale}</p>}
              </div>
            )}
            {payload.solution.edgeCases.length > 0 && (
              <div>
                <strong>Edge cases</strong>
                {payload.solution.edgeCases.map((edgeCase) => <p key={edgeCase}>{edgeCase}</p>)}
              </div>
            )}
            {payload.tests.length > 0 && (
              <div>
                <strong>Tests</strong>
                {payload.tests.map((test) => (
                  <p key={`${test.input}-${test.expected}`}>{test.input} =&gt; {test.expected}{test.rationale ? ` (${test.rationale})` : ""}</p>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
