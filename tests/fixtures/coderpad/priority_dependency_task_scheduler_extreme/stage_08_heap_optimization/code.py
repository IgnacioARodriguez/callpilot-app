import heapq


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


def schedule_tasks(tasks):
    normalized = normalize_tasks(tasks)
    tasks_by_id = {
        task["id"]: task
        for task in normalized
    }
    known_ids = set(tasks_by_id)
    indegree = {}
    dependents = {
        task_id: []
        for task_id in known_ids
    }
    missing_dependency_ids = set()

    for task in normalized:
        task_id = task["id"]
        valid_dependencies = []

        for dependency in task["depends_on"]:
            if dependency not in known_ids:
                missing_dependency_ids.add(task_id)
                continue

            valid_dependencies.append(dependency)
            dependents[dependency].append(task_id)

        indegree[task_id] = len(valid_dependencies)

    ready = []
    for task in normalized:
        task_id = task["id"]
        if (
            indegree[task_id] == 0
            and task_id not in missing_dependency_ids
        ):
            heapq.heappush(
                ready,
                (
                    -task["priority"],
                    task["position"],
                    task_id,
                ),
            )

    scheduled = []
    scheduled_ids = set()

    while ready:
        negative_priority, position, task_id = heapq.heappop(ready)
        task = tasks_by_id[task_id]

        scheduled.append({
            "id": task_id,
            "priority": task["priority"],
        })
        scheduled_ids.add(task_id)

        for dependent_id in dependents[task_id]:
            indegree[dependent_id] -= 1

            if (
                indegree[dependent_id] == 0
                and dependent_id not in missing_dependency_ids
            ):
                dependent = tasks_by_id[dependent_id]
                heapq.heappush(
                    ready,
                    (
                        -dependent["priority"],
                        dependent["position"],
                        dependent_id,
                    ),
                )

    blocked = []
    for task in normalized:
        task_id = task["id"]
        if task_id in scheduled_ids:
            continue

        reason = (
            "missing_dependency"
            if task_id in missing_dependency_ids
            else "cycle"
        )
        blocked.append({
            "id": task_id,
            "reason": reason,
        })

    return {
        "scheduled": scheduled,
        "blocked": blocked,
    }


tasks = [
    {"id": "network", "priority": 3},
    {"id": "db", "priority": 7, "depends_on": ["network"]},
    {"id": "api", "priority": 6, "depends_on": ["db"]},
    {"id": "docs", "priority": 2},
]

print(schedule_tasks(tasks))
