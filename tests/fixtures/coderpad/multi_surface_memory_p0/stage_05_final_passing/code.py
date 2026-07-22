def format_user(name):
    cleaned = " ".join(name.strip().split())
    if not cleaned:
        return "Anonymous"
    return cleaned.title()
