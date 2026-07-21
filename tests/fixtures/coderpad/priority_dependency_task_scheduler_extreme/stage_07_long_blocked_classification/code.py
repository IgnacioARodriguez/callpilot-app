def normalize_tasks(tasks):
    normalized = []
    seen_ids = set()

    for position, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue

        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id.strip():
            continue

        task_id = task_id.strip()
        if task_id in seen_ids:
            continue

        try:
            priority = int(task.get("priority"))
        except (TypeError, ValueError):
            continue

        dependencies = task.get("depends_on", [])
        if not isinstance(dependencies, list):
            continue

        if any(
            not isinstance(dependency, str) or not dependency.strip()
            for dependency in dependencies
        ):
            continue

        seen_ids.add(task_id)
        normalized.append({
            "id": task_id,
            "priority": priority,
            "depends_on": [
                dependency.strip()
                for dependency in dependencies
            ],
            "position": position,
        })

    return normalized


def classify_blocked_tasks(remaining, known_ids):
    blocked = []

    for _, task in remaining:
        missing = [
            dependency
            for dependency in task["depends_on"]
            if dependency not in known_ids
        ]

        if missing:
            reason = "missing_dependency"
        else:
            reason = "cycle"

        blocked.append({
            "id": task["id"],
            "reason": reason,
        })

    return blocked


def schedule_tasks(tasks):
    normalized = normalize_tasks(tasks)
    known_ids = {
        task["id"]
        for task in normalized
    }
    remaining = [
        (task["position"], task)
        for task in normalized
    ]
    scheduled = []
    scheduled_ids = set()

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
            break

        best_position, best_task = max(
            ready,
            key=lambda pair: (
                pair[1]["priority"],
                -pair[0],
            ),
        )

        scheduled.append({
            "id": best_task["id"],
            "priority": best_task["priority"],
        })
        scheduled_ids.add(best_task["id"])
        remaining.remove((best_position, best_task))

    blocked = classify_blocked_tasks(
        remaining,
        known_ids,
    )

    return {
        "scheduled": scheduled,
        "blocked": blocked,
    }


tasks = [
    {"id": "network", "priority": 3},
    {"id": "db", "priority": 7, "depends_on": ["network"]},
    {"id": "api", "priority": 6, "depends_on": ["db"]},
    {"id": "ghost", "priority": 9, "depends_on": ["missing"]},
    {"id": "cycle-a", "priority": 4, "depends_on": ["cycle-b"]},
    {"id": "cycle-b", "priority": 4, "depends_on": ["cycle-a"]},
]

print(schedule_tasks(tasks))
