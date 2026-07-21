# priority_dependency_task_scheduler_extreme

## Problema

Scheduler de tareas con prioridad, estabilidad, deduplicación, dependencias,
bloqueos, input sucio, clasificación de bloqueos y optimización con heap.

## Ejecución

- Una sola sesión durante los 10 stages.
- Transcript incremental sin duplicar turnos.
- En stages con `image`, enviar el PNG actual.
- En stages con `images`, enviar todos los PNG juntos y en orden.
- `code.py` reproduce la fixture; no sustituye OCR/visión.

## Stages

| Orden | Stage | Answer |
|---:|---|---|
| 0 | oral_problem_intro | chat |
| 1 | initial_simple_implementation | both |
| 2 | duplicate_id_clarification | chat |
| 3 | visible_duplicate_order_bug | coding |
| 4 | dependency_requirement_discussion | chat |
| 5 | dependency_contract_change | both |
| 6 | dirty_input_handling | coding |
| 7 | long_blocked_classification | both |
| 8 | heap_graph_optimization | both |
| 9 | final_assertions_and_complexity | both |

## Multi-screenshot

Stages 7, 8 y 9 usan top/middle/bottom del mismo estado actual.

## Comando sugerido

```bash
pytest -k priority_dependency_task_scheduler_extreme
```

Adaptar al runner real del proyecto.

## Capturas

Seguir `screenshot_manifest.json` y cada `capture_instructions.md`.
No generar PNGs sintéticos.
