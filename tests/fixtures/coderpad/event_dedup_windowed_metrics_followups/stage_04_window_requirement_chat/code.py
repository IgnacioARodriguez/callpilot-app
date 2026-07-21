def count_event_types(lines):
    counts = {}
    seen_ids = set()
    for line in lines:
        timestamp, event_id, event_type = line.split("|")
        if event_id in seen_ids:
            continue
        seen_ids.add(event_id)
        counts[event_type] = counts.get(event_type, 0) + 1
    return counts

events = [
    "0|a1|click",
    "120|a2|view",
    "301|a1|purchase",
]
print(count_event_types(events))
