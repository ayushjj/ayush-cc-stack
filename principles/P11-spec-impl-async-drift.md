# P11 (private P62) — Specs and implementation grow on independent timescales

> Externalized 2026-07-04 (S44 Fable-5 audit). CLAUDE.md retains the inline T1 trigger + T2 rule; this file preserves the full pre-audit principle text verbatim.

**Applies to**: any spec/checklist that accretes addenda across sessions while its implementation lives in separately-touched scripts.

## Full text (verbatim from CLAUDE.md as of 2026-07-04)

> Specs and implementation grow on independent timescales — when a spec accretes addenda (status notes, new check IDs) across sessions while implementation grows via separate scripts touched in different sessions, both stay internally consistent and forward review of either alone never catches the gap. Coverage audit (cross-referencing every spec item against actual implementation) is the only thing that surfaces the drift. Detection: a spec with >3 status addenda OR new rule IDs since the last implementation update; an impl script untouched K>5 sessions while its spec moved. Distinct from P51 (within-batch runtime variance) — P62 is asynchronous spec-vs-code drift (e.g. an inversion-checklist accreted 7 addenda + 5 check IDs while the impl covered only 4 of ~46 spine items; 12 uncovered surfaced only when a coverage matrix was built).
