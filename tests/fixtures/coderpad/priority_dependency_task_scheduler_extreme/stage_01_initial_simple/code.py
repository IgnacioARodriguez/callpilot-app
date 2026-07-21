def schedule_tasks(tasks):
    remaining = list(enumerate(tasks))
    scheduled = []

    while remaining:
        best_position, best_task = max(
            remaining,
            key=lambda pair: (pair[1]["priority"], -pair[0]),
        )
        scheduled.append(best_task["id"])
        remaining.remove((best_position, best_task))

    return scheduled


sample_tasks = [
    {"id": "write-docs", "priority": 2},
    {"id": "fix-login", "priority": 5},
    {"id": "add-tests", "priority": 2},
]

print(schedule_tasks(sample_tasks))
