# P51 — Paired-semantics components drift silently

> **Trigger** (kept inline in `~/.claude/CLAUDE.md` Principles): Paired-semantics components drift silently — when maker/checker, generator/validator, producer/consumer, or client/server share a two-sided contract and only one side changes, each stays internally consistent while the gap carries the bug. Forward review of either side alone won't catch it.

## Detection
Per-batch OK-rate variance doubles when contracts mismatch, returns to baseline when aligned — variance, not mean, is the signal.

## Fix
Scope `/review-plan` to "this component + any paired component"; watch paired variance as contract-health telemetry.

## Applies to
LLM judge/judged, schema-writer/validator, API client/server, generator/linter, any two-party contract prone to semantic drift.

## Example
Narrowing a maker rule without updating the paired checker row let the checker flag compliant output as violations. Per-batch OK-rate variance doubled while mean moved +1 (mean hid it).

## Cross-refs
- Distinct from P54 (intra-batch rule inconsistency — same component, opposite verdicts on similar items in one call)
- Distinct from P38 (schema asymmetry — single-component justification-required-on-one-branch bias)

## Migration note
Externalized 2026-04-28 as part of CLAUDE.md compression pilot. Original full inline text preserved verbatim above; CLAUDE.md retains T1 + T2 (detection + fix + applies-to) for reactive firing.
