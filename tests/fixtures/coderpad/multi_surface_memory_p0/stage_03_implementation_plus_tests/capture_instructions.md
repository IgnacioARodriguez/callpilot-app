# Stage 03 Capture

Create two screenshots from the same checkpoint:

1. `implementation.png`: show `src/formatter.py` with:

```python
def format_user(name):
    cleaned = name.strip()
    if not cleaned:
        return "Anonymous"
    return cleaned.title()
```

2. `tests.png`: show the tests from stage 02.

The stage intentionally has both surfaces so the model can use tests as
contract while modifying only implementation.
