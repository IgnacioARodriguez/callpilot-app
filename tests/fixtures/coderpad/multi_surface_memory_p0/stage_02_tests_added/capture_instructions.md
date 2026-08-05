# Stage 02 Capture

Open the tests surface only and save it as `tests.png`.

Visible code:

```python
from src.formatter import format_user


def test_formats_display_name():
    assert format_user(" ada   lovelace ") == "Ada Lovelace"
    assert format_user("GRACE hopper") == "Grace Hopper"


def test_empty_name_is_anonymous():
    assert format_user("") == "Anonymous"
    assert format_user("   ") == "Anonymous"
```
