def schedule_tasks(tasks):
    remaining = list(enumerate(tasks))
    scheduled = []
    scheduled_ids = set()
    blocked = []

    while remaining:
        ready = [
            pair
            for pair in remaining
            if all(
                dependency in scheduled_ids
                for dependency in pair[1].get("depends_on", [])
            )
        ]

        if not ready:
            blocked.extend(task["id"] for _, task in remaining)
            break

        best_position, best_task = max(
            ready,
            key=lambda pair: (pair[1]["priority"], -pair[0]),
        )

        scheduled.append(best_task["id"])
        scheduled_ids.add(best_task["id"])
        remaining.remove((best_position, best_task))

    return {
        "scheduled": scheduled,
        "blocked": blocked,
    }


tasks = [
    {"id": "db", "priority": 5, "depends_on": ["network"]},
    {"id": "network", "priority": 2, "depends_on": []},
    {"id": "docs", "priority": 1},
]

print(schedule_tasks(tasks))
