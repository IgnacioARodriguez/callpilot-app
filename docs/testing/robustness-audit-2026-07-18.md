# CallPilot Robustness Audit - 2026-07-18

This audit turns the external review notes into an actionable repo-local record.
It focuses on interview robustness, not proctoring, anti-cheat, or detection
evasion. "Anti-LLM" here means adversarial interview behavior: false premises,
scope changes, pressure, contradictions, ambiguity, and requests for unsupported
specifics.

## Current Coverage

| Area | Coverage level | Evidence | Current check depth |
|---|---|---|---|
| Technical interview | Strong fixture coverage | `tests/fixtures/text/batch1.json` technical interview, `batch2-adversarial.json` technical adversarial, `scripts/run-llm-scenarios.mjs` technical scenarios | Mostly deterministic schema, keyword/topic, forbidden-claim, language, length, and grounding-style checks. Some semantic behavior is encoded in prompt/core unit tests, but real LLM gates are still largely surface/heuristic. |
| Live coding | Strong fixture coverage | `live_coding_evolutivo`, `live_coding_adversarial`, real coding runner, executable Python assertions | Strongest when executable assertions exist. Non-code turns still rely on structure/keyword/heuristic checks. |
| Audio / long session | Strong infrastructure coverage | Track D chunk boundary/race cutoff fixtures, Track H long sessions with noise, overlap, reformulation, latest-question focus | Good deterministic STT/session checks. Answer quality still relies on topic/forbidden terms and broad checks. |
| System design | Partial | Six static text fixtures in `batch1.json` | Weakest area. Static single-turn fixtures cannot prove long-range design memory, prior-decision consistency, or scope-change handling. Checks are topic coverage oriented. |
| Background / CV grounding | Moderate | Background adversarial scenarios and grounding guards | Good no-invention intent, but exact unsupported-claim detection should remain a hard gate when profile facts are unavailable. |
| Vision | Moderate for extraction, less for interview robustness | Track G vision fixtures and runner | Exact text / forbidden mention checks exist, but system-design/coding multi-window reasoning needs more semantic gates. |

## Important Distinction

The fixtures are richer than many of the gates. A scenario may contain a real
adversarial behavior, but the pass condition may still be keyword-based. That
means "covered" does not always mean "semantically proven."

For technical interview and live coding, this does not invalidate the suite:
there are many useful deterministic checks and live coding can execute code.
It does mean the next improvement should upgrade judges for high-value flows,
not only add more scenarios.

## P0 Findings

1. System design needs a versioned semantic rubric before adding expensive real
   long-session assets. The rubric must make `contradicts_prior_turn` and
   `hallucinated_constraint` hard, separate fields.

2. Technical interview and live coding should be audited with the same suspicion
   as system design. They are stronger, but many real-LLM checks still use
   keyword/regex/topic gates.

3. Track H should get a system-design session, but fixture/audio assets are
   protected. Do not add or mutate `tests/fixtures`, `tests/rubrics`, or
   `tests/baselines` without explicit human approval.

4. Deep quality routing should wait until a rubric can prove quality improved.
   Otherwise we can only test that deep mode activated, not that it helped.

## Current Check Classification

### Semantic / Stronger

- Executable live-coding assertions via `runPythonAssertions`.
- Structured schema validation for published answers.
- Core prompt/context unit tests that assert stale topics, role separation, and
  grounding behavior.
- Track D transcript survival checks for chunk boundaries and stop races.
- Track H latest-question and stale-topic checks across long sessions.
- Answer latency breakdown by local prep vs provider/API.

### Heuristic / Surface

- `hasAnyTerm`, expected topics, expected coverage, and forbidden-term checks.
- Language detection via likely Spanish/English heuristics.
- `wordCount` max length gates.
- Many acceptance tests that assert implementation wiring via source regex.
- System design static coverage checks, because they only prove topic presence.

### Mixed

- Background no-invention gates: useful, but still need exact profile-grounding
  evidence for stronger guarantees.
- Technical forbidden claims: strong for known failure patterns, incomplete for
  unseen hallucinations.
- Vision exact-text/forbidden checks: strong for OCR leakage and visible text,
  less strong for reasoning quality.

## Recommended P0 Work

1. Adopt `docs/testing/system-design-semantic-rubric-v1.json` as the draft
   contract for a future protected rubric.

2. Add a Track H System Design fixture only after human approval. The session
   should include:
   - Initial design: URL shortener at 10M requests/day.
   - Scale change: 500M requests/day.
   - New consistency constraint: strong click-count consistency.
   - Interviewer pushback: "why not Redis atomic counter?"
   - Multi-region requirement.
   - Final executive summary.

3. Add a real runner path that evaluates each system-design answer with the
   rubric. The first implementation may be manual/offline, but the JSON output
   must match the rubric schema.

4. Add a keyword-vs-semantic summary into E2E reports once the rubric is active:
   each check should be marked as `deterministic`, `execution`, `heuristic`, or
   `semantic_judge`.

## Recommended P1 Work

1. Deep quality routing tests:
   - Simple definitions and behavioral prompts must stay fast.
   - System design, complex coding, contradictions, and major requirement
     changes may route to quality mode.
   - The quality-mode answer must score higher on the semantic rubric, not only
     use more tokens or latency.

2. Second judge for system design long sessions:
   - Use a different provider/model from the answer model.
   - Require evidence per dimension.
   - Treat empty/generic rationale as judge failure.

3. Expand adversarial interviewing cases:
   - False dilemma.
   - Social-authority pushback.
   - "Ignore previous" but keep still-valid constraints.
   - Silence then abrupt topic shift.
   - Unsupported precise numbers from CV/profile.

## Recommended P2 Work

1. Multi-interviewer role shifts during long sessions.
2. Executive-summary tests independent from system design.
3. Semantic rubrics for technical interview and non-executable live-coding turns.

## Acceptance Bar Before Claiming "Real Interview Ready"

CallPilot should not claim full real-world robustness for system design until:

- A long-session system-design fixture exists and is protected.
- At least one semantic judge rubric is versioned and calibrated.
- The runner reports hard failures for prior-turn contradiction and invented
  constraints.
- The suite demonstrates that quality mode improves semantic score on complex
  design/coding turns while staying off for simple turns.

