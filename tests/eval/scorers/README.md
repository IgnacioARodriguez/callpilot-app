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

## Pending

- executable scorers;
- judge adapter.
