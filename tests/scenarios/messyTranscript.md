# Messy Transcript Scenario

Active mode: `meeting_notes`

Input context:

```text
10:32 Alice: We need Redis for hot redirects.
10:33 Ben: Queue analytics, do not block redirects.
10:34 Alice: Action item: draft schema by Friday.
```

Expected prompt sections:

- active_mode
- output_format
- transcript
- user_input

Expected answer shape:

- Summary
- Decisions
- Action items
- Risks
- Requirements
- Assumptions

Known limitations:

- V0 transcript is speaker-agnostic for manual capture, but pasted labels are preserved as text.
