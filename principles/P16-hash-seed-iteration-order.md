# P16 (private P67) — Hash-seed iteration order leaks into production writes

> Externalized 2026-07-04 (S44 Fable-5 audit). CLAUDE.md retains the inline T1 trigger + T2 rule; this file preserves the full pre-audit principle text verbatim.

**Applies to**: code serializing a Python `set` (or pre-3.7 `dict.keys()`) into strings / JSON / audit logs / signed payloads.

## Full text (verbatim from CLAUDE.md as of 2026-07-04)

> **Hash-seed iteration order leaks into production writes — invisible to membership-based tests.** Code that serializes a Python `set` (or pre-3.7 `dict.keys()`) to a string / JSON / audit-log / signed-payload produces non-deterministic output across processes (each interpreter gets a different `PYTHONHASHSEED`). Membership tests (`assert "X" in result`) pass and mask it; only byte-wise comparison across processes surfaces it. Detection: run the same code in N fresh processes and compare verbatim. Fix: `sorted(set_var)` before iterate. Distinct from P15 (where the rule lives) — P67 is how set-derived output stabilizes (e.g. a helper returning a set produced 4 orderings across 4 processes; 1 LOC `sorted()` fixed it).
