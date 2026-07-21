def normalize_tasks(tasks):
    normalized = []

    for position, task in enumerate(tasks):
        task_id = task["id"]
        priority = int(task["priority"])
        dependencies = task.get("depends_on", [])

        normalized.append({
            "id": task_id,
            "priority": priority,
            "depends_on": dependencies,
            "position": position,
        })

    return normalized


def schedule_tasks(tasks):
    normalized = normalize_tasks(tasks)
    remaining = [
        (task["position"], task)
        for task in normalized
    ]
    scheduled = []
    scheduled_ids = set()
    blocked = []

    while remaining:
        ready = [
            pair
            for pair in remaining
            if all(
                dependency in scheduled_ids
                for dependency in pair[1]["depends_on"]
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


dirty_tasks = [
    {"id": "network", "priority": "2", "depends_on": []},
    {"priority": 5},
    {"id": "db", "priority": "high", "depends_on": ["network"]},
    {"id": "docs", "priority": 1, "depends_on": "network"},
]

print(schedule_tasks(dirty_tasks))
