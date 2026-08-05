def format_user(name):
    cleaned = name.strip()
    if not cleaned:
        return "Anonymous"
    return cleaned.title()
