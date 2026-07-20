# Scorers

## Deterministic

`deterministicScorers.cjs` scores a unified `evaluationRecord` without calling a
model. It covers:

- schema validity;
- expected response type;
- forbidden facts;
- language;
- length;
- expected function name;
- required patch presence;
- stale topic terms;
- future leakage terms and timestamp guard;
- retry count;
- repair policy;
- complete latency.

These checks are objective gates. They can supplement executable or judge
scorers, but they should not replace execution when code can be run.

## Executable

`executableScorers.cjs` runs coding answers against local, deterministic
assertions. Python is supported first because CallPilot's live-coding contract
defaults to Python. It covers:

- syntax and import-time execution;
- public assertion blocks;
- hidden assertion blocks;
- previous-turn regression assertions for follow-up turns;
- expected callable entrypoint/function shape;
- timeout handling.

Executable scorers must not encode expected prose answers. They should validate
observable behavior from external validation or holdout datasets.

## Pending

- judge adapter.
