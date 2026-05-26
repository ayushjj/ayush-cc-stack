# P65: Right-size `/review` (and any multi-reviewer slate) to diff *shape*, not workflow-gate heuristic firing

## Tightened T3 narrative

Workflow gates ("touches core logic" / ">3 files changed") trigger *consideration* of `/review`; they don't specify slate size. Reaching for the full 6-agent slate by reflex on a templated single-file addition contradicts simplicity-first project policy and burns context for no review-quality gain.

### Calibration table

| Diff shape | Reviewer count |
|---|---|
| Templated single-file addition with green tests (e.g., adding rule N+1 to existing P1-PN family) | **0 reviewers** |
| ≤2 files touching core logic with established patterns | **1 targeted reviewer** (correctness or language-specific) |
| Multi-consumer contract changes / new architectural surface | **Full /review slate** |
| Major checkpoints (pre-batch-1, pre-production, pre-customer-handoff) | **Full ~13-agent two-tier sweep** |

### Cost asymmetry

- Unneeded review costs: context burn + agent runtime.
- Missed review on a tiny templated change costs: ~zero (the pattern was already reviewed when its predecessor landed).

The asymmetry is the reason calibration matters — over-reviewing a templated diff isn't "safer," it's pure cost.

## Worked example

User pushback on launching 5 review agents for a 44-line rule addition following an existing rule-family template. Later the same session, a contract-bearing patch (2 files, core logic) also skipped formal `/review`, with an in-session hygiene assertion as the regression gate.

Both decisions held: zero reviewers for the templated rule (the rule family was the prior art), one in-session check for the contract-bearing patch.

Full narrative preserved in private OS learnings.

## Detection signal

Reaching for `/review` by reflex on a +50 LOC pattern-template diff with green smokes — pause and assess shape first.

## Applies to

Any project using `/review` or equivalent multi-reviewer skills, code-review pipelines, doc-review pipelines, any slate-of-agents pattern.

## Distinct from P40

P40 is about review *quality* (forward review can't see its own blind spots; inversion is required complement). **P65 is about review *quantity sizing*** — when to launch zero / one / full slate / two-tier sweep.

## Original verbatim text (rollback)

> 65. Right-size `/review` (and any multi-reviewer slate) to diff *shape*, not workflow-gate heuristic firing. Workflow gates ("touches core logic" / ">3 files changed") trigger consideration; they don't specify slate size. For a small templated addition (e.g., adding the next rule to an existing rule-family in one file with green inline smokes + green project-pattern smoke fixture + trace-cohort idempotency confirmed), launching the full 6-agent /review slate is reflexive over-application that contradicts simplicity-first project policy. Calibration: zero reviewers for templated single-file additions with green tests; one targeted reviewer (correctness or language-specific) for ≤2 files touching core logic with established patterns; full /review slate for multi-consumer contract changes / new architectural surface; full ~13-agent two-tier sweep only at major checkpoints (pre-batch-1, pre-production, pre-customer-handoff). Detection: reaching for /review by reflex on a +50 LOC pattern-template diff with green smokes — pause and assess shape first. Cost asymmetry: unneeded review costs context burn + agent runtime; missed review on a tiny templated change costs ~zero (the pattern was already reviewed when it landed). Applies to: any project using `/review` or equivalent multi-reviewer skills, code-review pipelines, doc-review pipelines, any slate-of-agents pattern. Distinct from P40 (review can't see its own blind spots — about review *quality*) — P65 is about review *quantity sizing*. Example: user pushback on launching 5 review agents for a templated rule addition following an existing rule-family template; later the same session, a contract-bearing patch (2 files, core logic) also skipped formal /review with an in-session hygiene assertion as the regression gate.
