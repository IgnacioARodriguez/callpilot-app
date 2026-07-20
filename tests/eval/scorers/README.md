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

## Evaluation Scoring

`evaluationScoring.cjs` maps a versioned dataset case plus an
`evaluationRecord` into the shared deterministic and executable scorer outputs.
Use it from runners when producing the unified result contract.

## Judge

`judgeAdapter.cjs` defines the judge request/rubric contract without pretending
to run a semantic judge. When a judge is required but no external judge provider
and model are configured, it returns a blocked score instead of a pass.
