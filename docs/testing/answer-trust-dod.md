# CallPilot Answer Trust Definition of Done

Last updated: 2026-07-18

## North Star

The product is trusted when the candidate can enter a technical interview,
live-coding interview, or system-design interview, press `Answer`, and trust
that the response is correct, relevant, sayable, and non-invented.

This DoD is about answer trust after a manual `Answer` press. It is not about
auto-triggering.

## Readiness Levels

| Level | Meaning |
| --- | --- |
| Not ready | Useful as a drafting aid only. Candidate must inspect and correct the answer. |
| Beta | Useful in real interviews with candidate judgment. Known edge cases remain. |
| Trusted | Candidate can rely on the answer under interview pressure. No known P0 failure class remains for that mode. |

## Failure Severity

| Severity | Definition | Examples |
| --- | --- | --- |
| P0 | Could directly harm the candidate if spoken aloud. | Wrong answer, stale-topic answer, invented experience/metric/SLA, ignores explicit constraint, unsafe code, hallucinated API/file/screen content. |
| P1 | Answer is directionally useful but incomplete or weak. | Omits a named part of the question, too generic, misses an important tradeoff, lacks edge cases, latency above target but still usable. |
| P2 | Polish or ergonomics issue. | Awkward wording, too long, minor formatting issue, redundant section. |

Trusted status requires zero known P0 classes in the scenario corpus and very
low P1 recurrence across repeated real-LLM runs.

## Global DoD

Applies to all interview modes.

### Quality

- The latest explicit interviewer request is the highest-priority task.
- Useful context is preserved:
  - prior constraints,
  - candidate partial answers,
  - corrections,
  - reformulations,
  - references such as "that", "it", "the previous design", "your last answer".
- Trash context is ignored:
  - stale topics,
  - casual/logistical chatter,
  - unrelated older questions,
  - assistant's previous answers unless the user asks to build on them.
- The answer never invents:
  - personal experience,
  - employers,
  - metrics,
  - outages,
  - timelines,
  - SLAs,
  - region counts,
  - code/files/errors not visible in context.
- If context is ambiguous or insufficient, the answer gives a safe clarification
  or a bounded assumption instead of guessing.
- The response is short enough to say aloud under pressure.
- The answer can include a small correction when the candidate said something
  incomplete or wrong.
- The answer is evaluated over multiple real-LLM runs, not one lucky run.

### Latency

Measure both:

- `first_usable_ms`: time until the first answer fragment that the candidate can
  start saying.
- `complete_ms`: time until the answer is complete.

If streaming is unavailable, `first_usable_ms` equals complete answer latency.
Trusted mode should use streaming for perceived latency whenever possible.

### Required Observability

Every answer attempt must record:

- transcription/input snapshot timing,
- latest actionable input preview,
- prompt build timing,
- evidence lookup timing,
- provider/model name,
- provider headers/first-chunk/stream-complete timings when available,
- parse/format/repair timing,
- final rendered answer excerpt,
- classified bottleneck.

## Technical Interview DoD

### Scope

Definitions, tradeoffs, debugging, architecture concepts, database/cache/queue
questions, reformulations, and candidate corrections.

### Quality Bar

Trusted when:

- Answers direct technical questions correctly and compactly.
- Does not include code unless code is requested.
- Does not pull in candidate background unless the interviewer asks for
  experience or project context.
- Handles topic switches, for example Redis to SQL, Kafka to HTTP retry, or
  caching to database indexes.
- Uses useful prior context for follow-ups, for example "what are the
  tradeoffs of that approach?"
- Corrects incomplete candidate answers without sounding adversarial.
- Handles noisy STT without changing the subject.

### Latency Bar

| Metric | Trusted target |
| --- | --- |
| First usable answer, P95 | <= 2.0s |
| Complete answer, P95 | <= 3.5s |
| Hard fail | > 6.0s without a usable fragment |

### Evaluation Bar

- At least 20 scenarios.
- At least 3 real-LLM runs per scenario.
- Zero P0 failures.
- P1 failures in <= 5% of runs.
- Median complete latency <= 2.5s.

## Live Coding DoD

### Scope

Problem extraction, approach, code, edge cases, complexity, bug fixes,
follow-up changes, and screen/context-aware code help.

### Quality Bar

Trusted when:

- Extracts problem, constraints, examples, and requested function from
  transcript and visible screen.
- Gives a short approach before full code.
- Produces code that is syntactically valid for the intended language.
- Handles follow-up changes:
  - duplicates,
  - null/empty inputs,
  - performance constraints,
  - "do not crash",
  - changed return type,
  - added edge case,
  - debugging an existing solution.
- Does not invent files, APIs, code, errors, tests, or function signatures not
  present in transcript/screen.
- If the screen/context is insufficient, asks for the missing constraint instead
  of fabricating implementation details.
- Includes complexity only when useful and accurate.
- Generated code passes fixture tests where executable tests are available.

### Latency Bar

Live coding can tolerate more latency than technical Q&A, but the candidate
needs something useful quickly.

| Metric | Trusted target |
| --- | --- |
| First usable approach, P95 | <= 2.5s |
| Small fix/change complete, P95 | <= 6.0s |
| Full solution complete, P95 | <= 12.0s |
| Hard fail | > 15.0s without a usable fragment |

### Evaluation Bar

- At least 20 scenarios.
- At least 3 real-LLM runs per scenario.
- Zero P0 failures.
- P1 failures in <= 8% of runs.
- Executable fixtures must pass generated or expected tests in >= 95% of runs.
- Any hallucinated screen/code/file content is P0.

## System Design DoD

### Scope

Open-ended design, scope changes, scale changes, consistency tradeoffs,
pushback, ambiguous requirements, executive summaries, and interviewer traps.

### Quality Bar

Trusted when:

- Uses a strong reasoning model or equivalent quality route for non-trivial
  system-design questions.
- Preserves all late constraints and reformulations.
- Uses useful context from prior turns, but does not let old topics override the
  final request.
- Explicitly covers every named item in the interviewer request.
- Does not invent:
  - SLAs,
  - exact region counts,
  - traffic ratios,
  - business facts,
  - product requirements not stated.
- Pushes back on simplistic premises, for example "why not just Redis?"
- Explains tradeoffs instead of listing components.
- Keeps answers sayable in 30 to 60 seconds unless the interviewer asks for more
  detail.
- Can produce a final executive summary that reflects the final design, not the
  initial prompt.

### Latency Bar

System design tolerates more thinking time. Quality is more important than raw
speed, but the user still needs a usable starting point quickly.

| Metric | Trusted target |
| --- | --- |
| First usable structure, P95 | <= 4.0s |
| Complete concise answer, P95 | <= 12.0s |
| Complex deep-quality answer, P95 | <= 18.0s |
| Hard fail | > 20.0s without a usable fragment |

### Evaluation Bar

- At least 20 scenarios.
- At least 5 real-LLM runs per scenario because model variance is higher.
- Zero P0 failures.
- P1 failures in <= 8% of runs.
- No repeated pattern of overusing a single component as source of truth, for
  example Redis as durable counter store.
- All scenarios with explicit named items must satisfy item coverage checks.

## Context Differentiation DoD

This is required for all modes.

### Must Use Context

The answer must use prior context when the latest request depends on it:

- "what about that approach?"
- "now change the scale..."
- "given what I said before..."
- "correct your previous answer..."
- "same problem, now allow duplicates..."
- "why not simply use X?"
- "give me a summary of the final design..."

### Must Ignore Context

The answer must ignore prior context when the latest request is standalone or
switches topic:

- old Redis question followed by new SQL question,
- behavioral story followed by algorithm question,
- live-coding problem followed by system-design question,
- casual/logistical chatter before technical question,
- stale assistant answer that conflicts with latest interviewer request.

### Evaluation Bar

- At least 10 dedicated context-mixing scenarios per mode.
- Each scenario includes both useful context and irrelevant/noisy context.
- Zero stale-topic P0 failures.
- For follow-up questions, answer must reference the correct antecedent in >=
  95% of real-LLM runs.

## Model Routing DoD

Trusted mode cannot depend on a single small model for all tasks.

### Fast Lane

Use for:

- simple definitions,
- short technical Q&A,
- low-risk clarifications,
- simple response rewrites.

Required target:

- P95 complete <= 3.5s.
- No P0 failures in technical-simple corpus.

### Deep Quality Lane

Use for:

- system design,
- live coding with code generation,
- debugging,
- multi-turn context,
- explicit tradeoff analysis,
- contradictory constraints,
- interviewer pushback,
- any answer repair trigger.

Required target:

- Better quality than fast lane on the same hard corpus.
- P95 within the mode latency bar.
- Streaming enabled or equivalent first-fragment behavior.

## Trusted Release Gate

A mode can be labeled `Trusted` only when:

- Its mode-specific scenario corpus exists.
- Required real-LLM multicorrida runs pass.
- Latency targets pass at P95.
- No P0 class is known and unfixed.
- Failures are classified by root cause:
  - STT,
  - latest prompt extraction,
  - context selection,
  - model reasoning,
  - formatting/parsing,
  - repair/guardrail,
  - provider latency.
- The pass/fail report is saved under `tests/e2e/reports`.

## Current Interpretation

As of this DoD, the intended path is:

1. Technical Interview: nearest to Trusted. Needs broader multicorrida.
2. System Design: requires strong-model routing and multicorrida Track H.
3. Live Coding: requires executable validation and stronger code-focused
   scenarios before Trusted.

