# CallPilot LLM Provider Matrix

Last reviewed: 2026-07-21

This document is the working source of truth for every external model CallPilot uses or may use. Keep it separate from test results: a provider can be wired correctly and still be a poor operational choice for a real interview because of latency, quality, or rate limits.

## Current Product Surfaces

| Surface | Current implementation | Current/default model | Notes |
| --- | --- | --- | --- |
| Live transcript | Deepgram realtime websocket | `nova-3` | Primary STT path. Natively is disabled/migrated to Deepgram in settings. OpenAI chunk transcription still exists but is not the preferred live path. |
| Answer generation | Provider selectable in UI: NVIDIA, OpenAI, Groq, Ollama, mock, Natively | App/live-coding default is OpenAI `gpt-5-mini`; Technical setup defaults to NVIDIA `meta/llama-3.1-8b-instruct` when the user has not manually selected a provider | The default is mode-aware at setup time. Manual provider choices are respected. |
| Live coding answer parsing | Same answer provider path, structured JSON output | Provider-selected answer model | Raw model output, parsed structured output, retries, and final rendered output must remain separately observable. |
| Technical Q&A / behavioral / system design answers | Same answer provider path | Provider-selected answer model | Non-live-coding modes can stream compact spoken output for OpenAI-compatible providers where supported by the app path. |
| Screenshot OCR | Local Tesseract.js | local OCR, no cloud model | First-pass screen text extraction. It is cheap/private but can include noisy overlays. |
| Screenshot vision enrichment | OpenAI or NVIDIA vision path, not auto-triggered | NVIDIA default `meta/llama-3.2-11b-vision-instruct` when NVIDIA vision is selected | Available for explicit experiments only. Auto vision is disabled to avoid unexpected latency and token spend during interview runs. |

## Recommended Routing

| Use case | Recommended provider/model | Why | Backup |
| --- | --- | --- | --- |
| Live transcript | Deepgram `nova-3` realtime | Streaming STT matches the old Natively behavior better than chunked transcription. It supports partial/final events and low-latency audio flow. | OpenAI chunk transcription only as fallback, not primary live mode. |
| Live coding answers | OpenAI `gpt-5-mini` | Passed the first real screenshot/follow-up replay while preserving visible Python continuity. | OpenAI `gpt-4o mini` for lower cost; NVIDIA larger models if credits remain and latency is acceptable. |
| Technical interview Q&A | NVIDIA `meta/llama-3.1-8b-instruct` remains the setup default for now | Technical Q&A has been acceptable in user sessions and is cheaper/free while credits remain. Promote to OpenAI `gpt-4o mini` or `gpt-5-mini` only if we observe drift or weak answers. | OpenAI `gpt-4o mini` for lower cost paid fallback; `gpt-5-mini` for higher-stakes reasoning. |
| System design | OpenAI `gpt-5 mini` | Needs stronger reasoning, tradeoffs, and consistency. Latency is less critical than correctness. | NVIDIA 49B-class model if OpenAI is unavailable. |
| Behavioral/background | OpenAI `gpt-4o mini` | Cost-effective and good enough if grounding guards keep it tied to resume/notes/transcript evidence. | `gpt-5 mini` for high-stakes company-fit answers. |
| Screenshot vision | Disabled by default; re-measure OpenAI vision via `gpt-5 mini`/current OpenAI vision-capable model before enabling | Current documented NVIDIA default is usable, but old measurements were not fresh enough to trust as a product default. | NVIDIA `meta/llama-3.2-11b-vision-instruct`. |

## Provider Findings From Recent Replays

### Deepgram

Keep as the default live transcript provider. The important product property is realtime partial/final delivery, not just transcription accuracy. Transcript loss and partial replacement must be tested at the turn assembler level, not fixed by switching LLMs.

### Groq

Groq is very fast, but the free-tier token-per-minute limit is too fragile for a real interview. A live-coding flow can require multiple calls in one minute: initial answer, structured retry, follow-up, and continuity retry. In replay, `llama-3.3-70b-versatile` produced sub-3-second answer attempts, but hit `429` TPM limits during a follow-up retry.

Decision: keep Groq wired as an experimental/optional provider, but do not rely on Groq free tier for live interviews.

### NVIDIA

NVIDIA is useful while credits are available, but model choice matters:

- `meta/llama-3.1-8b-instruct` is fast but failed live-coding continuity in realistic screenshot/follow-up cases.
- Larger NVIDIA models behaved better but were much slower in prior replay measurements.
- NVIDIA vision currently defaults to `meta/llama-3.2-11b-vision-instruct` when explicitly invoked. It is not auto-triggered from screenshot/OCR capture.

Decision: keep NVIDIA as backup and for comparison, but do not use the 8B default as the quality baseline for live coding.

### OpenAI

OpenAI was under-compared in the first provider discussion. It should be included in the next real replay pass because it is likely the most reliable paid option for live interviews.

Recommended first tests:

- `gpt-5 mini` for live coding and system design.
- `gpt-4o mini` for technical Q&A and behavioral/background answers.

Measured replay result:

- Provider/model: OpenAI `gpt-5-mini`.
- Scenario: real CoderPad screenshot OCR with noisy CallPilot overlay, initial answer, then follow-up asking to read the user's name from input.
- Result: passed.
- Initial turn latency: about 13.4 seconds end-to-end.
- Follow-up latency: about 14.8 seconds end-to-end.
- OCR: about 1,551 chars, confidence 81.
- Vision: not used.
- Continuity: preserved visible `def hello():` in both turns.
- Follow-up: changed code to call `input()` inside `hello()` instead of changing the visible signature.

Next OpenAI evaluation should compare `gpt-4o mini` on the same replay to measure whether lower cost is acceptable for technical Q&A or simple live-coding turns.

## Measurement Requirements

Every real-provider evaluation must report:

- OCR duration.
- Vision duration when used.
- Prompt/context build duration.
- Evidence lookup duration.
- First model call duration.
- Retry model call duration, if any.
- Parse/repair duration.
- Grounding/continuity decision.
- Render/publish duration.
- Raw model output availability.
- Parsed structured output.
- Final rendered output.
- Provider status/rate-limit errors.

Do not compare providers using only final pass/fail. For CallPilot, a provider is viable only if it preserves current screen context, respects visible Python code continuity, stays under interview latency, and does not exhaust rate limits during multi-turn follow-ups.

## Next Decision Gate

Before changing the Technical Interview default away from NVIDIA, run a separate technical-Q&A replay on:

1. Current NVIDIA `meta/llama-3.1-8b-instruct`.
2. OpenAI `gpt-4o mini`.
3. OpenAI `gpt-5-mini`.
4. Current NVIDIA large candidate.

Accept a default only if it passes mode-specific multi-turn cases and has a tolerable p95 latency for that interview mode.
