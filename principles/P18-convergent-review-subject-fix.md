# P18 (private P69) — Convergent /review = subject-level fix signal

> Externalized 2026-07-04 (S44 Fable-5 audit). CLAUDE.md retains the inline T1 trigger + T2 rule; this file preserves the full pre-audit principle text verbatim.

**Applies to**: multi-reviewer review results where two reviewers independently flag the same file:line from different attack angles.

## Full text (verbatim from CLAUDE.md as of 2026-07-04)

> **Convergent /review = subject-level fix signal.** When two reviewers independently flag the SAME file:line from opposite attack angles, the SUBJECT is brittle — reach for a one-line strategy-level fix BEFORE comparing reviewer-specific cures; a single subject-level pin usually resolves both simultaneously AND tightens regression-detection beyond either specific cure. Detection: MUST + SHOULD on the same file:line; mutually-exclusive specific fixes; one strategy fix resolves both. Crystallized fix shape (codebase-stable over a 5-session streak): **replace count/set assertions with per-bucket positive bindings** (`find_by(key).quantity == N`) AND/OR **pair negative outcomes with positive call-site expectations** (`should_receive(:m).and_call_original`). Distinct from P40 (single-reviewer scope) — P69 is multi-reviewer convergence as the inversion signal.
