def count_event_types(lines):
    counts = {}
    seen_ids = set()
    recent_events = []
    for line in lines:
        parts = line.split("|")
        if len(parts) != 3:
            continue
        timestamp_raw, event_id, event_type = parts
        if not event_id or not event_type:
            continue
        try:
            timestamp = int(timestamp_raw)
        except ValueError:
            continue

        while recent_events and timestamp - recent_events[0][0] > 300:
            old_timestamp, old_id = recent_events.pop(0)
            seen_ids.discard(old_id)

        if event_id in seen_ids:
            continue

        seen_ids.add(event_id)
        recent_events.append((timestamp, event_id))
        counts[event_type] = counts.get(event_type, 0) + 1

    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))

events = [
    "0|a1|click",
    "bad line",
    "120|a2|view",
    "301|a1|purchase",
]
print(count_event_types(events))
