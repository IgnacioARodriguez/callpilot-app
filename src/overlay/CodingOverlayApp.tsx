import React from "react";
import { classifyScreenText, normalizeOcrLanguage, ocrConfidenceLabel, type CodingAnswerPayload, type StructuredAnswerPayload } from "../core";

interface StructuredAnswerEvent {
  requestId?: string;
  answer: StructuredAnswerPayload;
  renderedText: string;
  timestamp: number;
}

type ServiceTone = "idle" | "working" | "ready" | "warn" | "error";

interface ServiceChip {
  label: string;
  detail: string;
  tone: ServiceTone;
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

const terminalAnswerStatuses = new Set(["completed", "failed", "cancelled"]);

export default function CodingOverlayApp() {
  const [payload, setPayload] = React.useState<CodingAnswerPayload>(emptyCodingAnswer);
  const [updatedAt, setUpdatedAt] = React.useState<number>(0);
  const [screenStatus, setScreenStatus] = React.useState("No screenshot selected");
  const [captureStatus, setCaptureStatus] = React.useState<ServiceChip>({
    label: "Image",
    detail: "No screenshot yet",
    tone: "idle",
  });
  const [answerStatus, setAnswerStatus] = React.useState<ServiceChip>({
    label: "Answer",
    detail: "Ready when context is ready",
    tone: "idle",
  });
  const [screenshotCount, setScreenshotCount] = React.useState(0);
  const [isCapturingScreen, setIsCapturingScreen] = React.useState(false);
  const [isRequestingAnswer, setIsRequestingAnswer] = React.useState(false);
  const [activeAnswerRequestId, setActiveAnswerRequestId] = React.useState<string | null>(null);
  const captureStartedAtRef = React.useRef<number | null>(null);
  const answerStartedAtRef = React.useRef<number | null>(null);
  const codeRef = React.useRef<HTMLPreElement | null>(null);
  const reasoningRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onStructuredAnswer?.((event: StructuredAnswerEvent) => {
      if (event.answer.kind !== "coding") return;
      setPayload(event.answer.payload);
      setUpdatedAt(event.timestamp);
      setAnswerStatus({ label: "Answer", detail: "Code answer ready", tone: "ready" });
    });
    return () => dispose?.();
  }, []);

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onAnswerStatus?.((event) => {
      if (event.requestId) {
        setActiveAnswerRequestId(terminalAnswerStatuses.has(event.status) ? null : event.requestId);
      }
      if (event.audience === "coding" || event.requestId === activeAnswerRequestId) {
        if (event.status === "busy") {
          answerStartedAtRef.current = answerStartedAtRef.current ?? Date.now();
          setAnswerStatus({ label: "Answer", detail: "Thinking through the code", tone: "working" });
        }
        if (event.status === "completed") {
          answerStartedAtRef.current = null;
          setAnswerStatus({ label: "Answer", detail: "Answer ready", tone: "ready" });
        }
        if (event.status === "failed") {
          answerStartedAtRef.current = null;
          setAnswerStatus({ label: "Answer", detail: event.error ? `Failed: ${event.error}` : "Answer failed", tone: "error" });
        }
        if (event.status === "cancelled") {
          answerStartedAtRef.current = null;
          setAnswerStatus({ label: "Answer", detail: "Stopped", tone: "warn" });
        }
      }
      if (terminalAnswerStatuses.has(event.status)) {
        setIsRequestingAnswer(false);
      }
    });
    return () => dispose?.();
  }, [activeAnswerRequestId]);

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onScreenContextPublished?.((event) => {
      if (event.source !== "coding_overlay") return;
      const classified = classifyScreenText(event.visibleText ?? "");
      const hasCodingSignal = classified.kind === "coding_problem" || classified.kind === "code_editor";
      setScreenshotCount((current) => Math.min(5, current + 1));
      setScreenStatus(hasCodingSignal ? "Screenshots ready for Answer code" : "Screenshot captured; no coding problem detected");
      setCaptureStatus({
        label: "Image",
        detail: hasCodingSignal ? "Ready for Answer code" : "Captured, unclear coding signal",
        tone: hasCodingSignal ? "ready" : "warn",
      });
    });
    return () => dispose?.();
  }, []);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (captureStartedAtRef.current) {
        const elapsed = now - captureStartedAtRef.current;
        if (elapsed > 30000) {
          setCaptureStatus({ label: "Image", detail: "May be stuck; recapture if needed", tone: "error" });
          setScreenStatus("Screenshot is taking too long; try recapturing");
        } else if (elapsed > 12000) {
          setCaptureStatus({ label: "Image", detail: "Still reading screenshot", tone: "warn" });
          setScreenStatus("Still reading screenshot...");
        }
      }
      if (answerStartedAtRef.current) {
        const elapsed = now - answerStartedAtRef.current;
        if (elapsed > 45000) {
          setAnswerStatus({ label: "Answer", detail: "May be stuck; Stop is safe", tone: "error" });
        } else if (elapsed > 15000) {
          setAnswerStatus({ label: "Answer", detail: "Still working", tone: "warn" });
        }
      }
    }, 1000);
    return () => window.clearInterval(timer);
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
    captureStartedAtRef.current = Date.now();
    setScreenStatus("Capturing screen...");
    setCaptureStatus({ label: "Image", detail: "Capturing screen", tone: "working" });
    try {
      const capturedAt = Date.now();
      const screenshot = await window.callpilotDesktop.captureScreenshot({ hideCallPilotWindows: true });
      if (!screenshot.ok || !screenshot.path) {
        setScreenStatus(`Screenshot failed: ${screenshot.error ?? "unknown"}`);
        setCaptureStatus({ label: "Image", detail: `Capture failed: ${screenshot.error ?? "unknown"}`, tone: "error" });
        return;
      }

      setScreenStatus("Reading screenshot...");
      setCaptureStatus({ label: "Image", detail: "Reading text with OCR", tone: "working" });
      const ocr = await window.callpilotDesktop.recognizeScreenText({
        path: screenshot.path,
        language: normalizeOcrLanguage("auto"),
      });
      let visionText = "";
      let visionError = "";
      if ((!ocr.ok || !ocr.text) && window.callpilotDesktop.analyzeScreenshot) {
        setScreenStatus("OCR failed; trying vision...");
        setCaptureStatus({ label: "Image", detail: "OCR failed; trying vision", tone: "warn" });
        const vision = await window.callpilotDesktop.analyzeScreenshot({
          path: screenshot.path,
          provider: "openai",
          modelName: "gpt-5-mini",
          skipOcr: true,
        });
        if (vision.ok && vision.text) {
          visionText = vision.text;
        } else {
          visionError = vision.error ?? "vision_failed";
        }
      }
      const visibleText = [
        ocr.ok && ocr.text ? ocr.text : "",
        ocr.ok
          ? `Local OCR: ${ocr.language} - confidence ${ocrConfidenceLabel(ocr.confidence)}${typeof ocr.confidence === "number" ? ` (${ocr.confidence.toFixed(1)})` : ""}`
          : `Local OCR failed: ${ocr.error ?? "no text found"}`,
        visionText ? `Vision fallback:\n${visionText}` : "",
        visionError ? `Vision fallback failed: ${visionError}` : "",
      ].filter(Boolean).join("\n\n");
      const classified = classifyScreenText([ocr.ok && ocr.text ? ocr.text : "", visionText].filter(Boolean).join("\n"));
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
      setCaptureStatus(published.ok
        ? {
          label: "Image",
          detail: hasCodingSignal ? `${screenshotCount + 1} screenshot${screenshotCount + 1 === 1 ? "" : "s"} ready` : "Captured, but coding text unclear",
          tone: hasCodingSignal ? "ready" : "warn",
        }
        : { label: "Image", detail: `Context failed: ${published.error ?? "unknown"}`, tone: "error" });
    } catch (error) {
      setScreenStatus(error instanceof Error ? error.message : "Screenshot capture failed");
      setCaptureStatus({ label: "Image", detail: error instanceof Error ? error.message : "Screenshot failed", tone: "error" });
    } finally {
      captureStartedAtRef.current = null;
      setIsCapturingScreen(false);
    }
  }, [screenshotCount]);

  const requestAnswer = async () => {
    setIsRequestingAnswer(true);
    answerStartedAtRef.current = Date.now();
    setAnswerStatus({ label: "Answer", detail: screenshotCount > 0 ? "Working with screenshots" : "Working without screenshot", tone: "working" });
    const result = await window.callpilotDesktop?.requestAnswer?.({ audience: "coding" }).catch(() => ({ ok: false }));
    if (!result?.ok) {
      answerStartedAtRef.current = null;
      setIsRequestingAnswer(false);
      setScreenStatus("Answer request failed");
      setAnswerStatus({ label: "Answer", detail: "Request failed", tone: "error" });
    }
  };

  const cancelAnswer = async () => {
    if (!activeAnswerRequestId) return;
    const requestId = activeAnswerRequestId;
    setActiveAnswerRequestId(null);
    setIsRequestingAnswer(false);
    answerStartedAtRef.current = null;
    setAnswerStatus({ label: "Answer", detail: "Stopping", tone: "warn" });
    await window.callpilotDesktop?.cancelAnswer?.(requestId).catch(() => undefined);
  };

  const resetExercise = async () => {
    setPayload(emptyCodingAnswer);
    setUpdatedAt(0);
    setScreenStatus("New exercise ready");
    setCaptureStatus({ label: "Image", detail: "No screenshot for this exercise", tone: "idle" });
    setAnswerStatus({ label: "Answer", detail: "Ready when context is ready", tone: "idle" });
    setScreenshotCount(0);
    setActiveAnswerRequestId(null);
    setIsRequestingAnswer(false);
    captureStartedAtRef.current = null;
    answerStartedAtRef.current = null;
    await window.callpilotDesktop?.dispatchRemoteControlCommand?.({ type: "reset_exercise" }).catch(() => undefined);
  };

  const restartSession = async () => {
    setPayload(emptyCodingAnswer);
    setUpdatedAt(0);
    setScreenStatus("New session ready");
    setCaptureStatus({ label: "Image", detail: "No screenshot yet", tone: "idle" });
    setAnswerStatus({ label: "Answer", detail: "Ready when context is ready", tone: "idle" });
    setScreenshotCount(0);
    setActiveAnswerRequestId(null);
    setIsRequestingAnswer(false);
    captureStartedAtRef.current = null;
    answerStartedAtRef.current = null;
    await window.callpilotDesktop?.dispatchRemoteControlCommand?.({ type: "reset_session" }).catch(() => undefined);
  };

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onRemoteControlCommand?.((command) => {
      if (command.type === "reset_session" || command.type === "reset_exercise") {
        setPayload(emptyCodingAnswer);
        setUpdatedAt(0);
        setScreenStatus(command.type === "reset_session" ? "New session ready" : "New exercise ready");
        setCaptureStatus({ label: "Image", detail: "No screenshot yet", tone: "idle" });
        setAnswerStatus({ label: "Answer", detail: "Ready when context is ready", tone: "idle" });
        setScreenshotCount(0);
        setActiveAnswerRequestId(null);
        setIsRequestingAnswer(false);
        captureStartedAtRef.current = null;
        answerStartedAtRef.current = null;
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
        <div className="cp-coding__actions cp-coding__actions--status">
          <span className={screenshotCount > 0 ? "cp-capture-count ready" : "cp-capture-count"}>
            {screenshotCount > 0 ? `${screenshotCount} ready` : "0 ready"}
          </span>
          <span>{hasContent ? responseTypeLabel(payload.responseType) : "Solution workspace"}</span>
        </div>
      </div>
      <div className="cp-service-strip" aria-label="Live coding service status">
        {[captureStatus, answerStatus].map((status) => (
          <span className={`cp-service-chip cp-service-chip--${status.tone}`} key={status.label}>
            <strong>{status.label}</strong>
            {status.detail}
          </span>
        ))}
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
