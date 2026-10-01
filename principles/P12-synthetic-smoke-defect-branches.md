# P12 (private P63) — Synthetic smoke tests miss defect-rendering branches

> Externalized 2026-07-04 (S44 Fable-5 audit). CLAUDE.md retains the inline T1 trigger + T2 rule; this file preserves the full pre-audit principle text verbatim.

**Applies to**: any system rendering OK-vs-defect cases differently — audit summaries, error UI, alert templates, eval gates, formatters.

## Full text (verbatim from CLAUDE.md as of 2026-07-04)

> Synthetic smoke tests miss defect-rendering branches. When a system renders OK-vs-defect cases differently (audit summaries, error UI, alert templates, eval gates, formatters), a 0-defect synthetic input never executes the defect branch — the first real-data dispatch is the implicit smoke for it, and real data ALWAYS has defects. Cure: synthetic smoke MUST include ≥1 defect-class record per renderer branch (one OK + one FIX + one FLAG, not just one OK). Distinct from P40 (review-side) and P49 (input sampling) — P63 is test-coverage blindness for *output* branches (e.g. a 0-flagged synthetic batch passed; the first real 9-flagged batch surfaced an audit renderer leaving every flagged record's source-text empty).
