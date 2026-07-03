# Spanish English Scenario

Active mode: `technical_qa`

Input context:

```text
Puedes explicar rate limiting with token bucket?
```

Expected prompt sections:

- active_mode
- preferred_language
- output_format
- user_input

Expected answer shape:

- Concise answer in the user's likely language preference.
- Example.
- Tradeoff.

Known limitations:

- Language preference is represented in context; model behavior is still mock-only.
