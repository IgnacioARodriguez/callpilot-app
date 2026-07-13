import React from "react";
import type { CodingAnswerPayload, StructuredAnswerPayload } from "../core";

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

const CodePlaceholder = () => (
  <div className="cp-code-placeholder">
    <strong>No solution yet</strong>
    <span>Press Answer when the interviewer gives the exercise or asks for a change.</span>
  </div>
);

export default function CodingOverlayApp() {
  const [payload, setPayload] = React.useState<CodingAnswerPayload>(emptyCodingAnswer);
  const [updatedAt, setUpdatedAt] = React.useState<number>(0);

  React.useEffect(() => {
    const dispose = window.callpilotDesktop?.onStructuredAnswer?.((event: StructuredAnswerEvent) => {
      if (event.answer.kind !== "coding") return;
      setPayload(event.answer.payload);
      setUpdatedAt(event.timestamp);
    });
    return () => dispose?.();
  }, []);

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
          <span>{hasContent ? responseTypeLabel(payload.responseType) : "Solution workspace"}</span>
        </div>
        <button type="button" onClick={() => window.callpilotDesktop?.endSession?.()}>End</button>
      </div>
      <div className="cp-coding__body">
        <section className="cp-code-panel">
          <div className="cp-panel-title">
            <strong>{payload.problem.title || "Solution"}</strong>
            <span>{payload.problem.language || "Code"}</span>
          </div>
          {code ? <pre><code>{code}</code></pre> : <CodePlaceholder />}
        </section>
        <section className="cp-reasoning-panel">
          <div className="cp-panel-title">
            <strong>Reasoning</strong>
            <span>{updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Ready"}</span>
          </div>
          <div className="cp-mini-chat">
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
