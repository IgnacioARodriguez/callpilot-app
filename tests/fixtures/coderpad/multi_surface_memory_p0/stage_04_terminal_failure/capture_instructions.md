# Stage 04 Capture

Create two screenshots:

1. `terminal.png`: show a failing test output similar to:

```text
FAILED tests/test_formatter.py::test_formats_display_name
AssertionError: assert 'ADA   LOVELACE' == 'Ada Lovelace'
```

2. `implementation.png`: show `src/formatter.py` with the bug:

```python
def format_user(name):
    cleaned = name.strip()
    if not cleaned:
        return "Anonymous"
    return cleaned.upper()
```
