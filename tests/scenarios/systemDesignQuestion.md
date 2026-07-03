# System Design Scenario

Active mode: `system_design`

Input context:

```text
Design a URL shortener. Requirements: create short links, redirect quickly, support analytics.
Architecture: clients -> API service -> cache -> database -> analytics queue.
```

Expected prompt sections:

- active_mode
- output_format
- screen_context
- user_input

Expected answer shape:

- Requirements
- Architecture
- Data flow
- Tradeoffs
- Scaling risks
- What to say out loud

Known limitations:

- Diagram parsing is heuristic text classification only.
