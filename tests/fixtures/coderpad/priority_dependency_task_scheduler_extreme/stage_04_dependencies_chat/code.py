def schedule_tasks(tasks):
    remaining = list(enumerate(tasks))
    scheduled = []
    seen_ids = set()

    while remaining:
        best_position, best_task = max(
            remaining,
            key=lambda pair: (pair[1]["priority"], -pair[0]),
        )

        if best_task["id"] in seen_ids:
            remaining.remove((best_position, best_task))
            continue

        seen_ids.add(best_task["id"])
        scheduled.append(best_task["id"])
        remaining.remove((best_position, best_task))

    return scheduled
