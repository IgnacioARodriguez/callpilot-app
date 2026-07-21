def schedule_tasks(tasks):
    remaining = list(enumerate(tasks))
    scheduled = []
    seen_ids = set()

    while remaining:
        best_position, best_task = max(
            remaining,
            key=lambda pair: (pair[1]["priority"], -pair[0]),
        )

        seen_ids.add(best_task["id"])
        if best_task["id"] in seen_ids:
            remaining.remove((best_position, best_task))
            continue

        scheduled.append(best_task["id"])
        remaining.remove((best_position, best_task))

    return scheduled


sample_tasks = [
    {"id": "fix-login", "priority": 5},
    {"id": "write-docs", "priority": 2},
    {"id": "fix-login", "priority": 1},
]

print(schedule_tasks(sample_tasks))
# expected: ['fix-login', 'write-docs']
