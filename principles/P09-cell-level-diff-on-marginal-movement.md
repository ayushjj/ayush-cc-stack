# P09 (private P60) — Cell-level right-flip / wrong-flip diff before keep-vs-revert (on marginal aggregate movement)

> Externalized from `~/.claude/CLAUDE.md` on 2026-04-29 as part of Phase 1 of the CLAUDE.md compression arc (background: `~/.claude/meta/claude-md-compression-arc.md`).
> T1 (recognition trigger) + T2 (rule body + detection + applies-to) remain inline in CLAUDE.md. T3 (worked-example narrative) lives here.
> Reversal: if the principle fails to fire on a real situation in a future session, copy the **Original verbatim text** section back inline into CLAUDE.md, delete this file, and append a one-line note to the compression-arc append-only log.

## Tier 3 — Worked example (externalized)

**Worked incident**: Two scalable rule edits to a maker prompt produced **+0.5pp aggregate movement** on the strict-equality eval — a movement size that would routinely be coded as "marginal noise, keep or revert on intuition."

Cell-level diff revealed three distinct things hidden under the +0.5pp surface:
- **+6.5pp dimension structural win**: 10 teeth / 26 rapper / Size 209 — three records where the new emission correctly extracted via the new "Quantitative Identity Principle" rule. Genuine production-relevant gains; will reproduce on full sample.
- **3 P56-noise "regressions"**: Stainless Steel vs SS / [redacted] vs [redacted] / OD vs od — strict-equality reads them as flips, but the new emissions are *better for production retrieval*. P56 ceiling artifacts dressed up as regressions.
- **1 real routing regression**: a single cell where the rule edit caused a genuine wrong route. Real loss — but bounded.

Without the cell-level diff:
- "+0.5pp keep" would have been **premature victory** (no evidence the gain is structural vs scorer noise).
- "Material slot lost gate, revert" would have **forfeited the +6.5pp dimension structural win** by misreading P56-noise as regressions.

The keep-vs-revert decision required reading the actual flips, not the aggregate. This is the canonical small-aggregate-movement case where the diff IS the methodology, not a supplementary check.

Full session writeup preserved in private OS learnings.

## Original verbatim text (rollback source — do not edit)

> 60. On marginal aggregate movement (±1pp) from a prompt edit on strict-equality LLM eval, run cell-level right-flip / wrong-flip diff before keep-vs-revert. Aggregate hides three things: (a) whether gains are *structural* (will reproduce on production) vs scorer-noise; (b) whether regressions are real extraction-quality drops vs P56-ceiling abbreviation/casing/spacing noise where the new emission is *better for production retrieval*; (c) where the edit's actual blast radius landed (which slots, which records, which patterns). Without the diff you'll either declare premature victory or revert structural wins. Detection: any prompt-iteration session where you'd reach revert-vs-keep on aggregate alone — pause and run the diff first. Complement to P40 (forward review can't see blind spots) and P56 (LLM-vs-LLM ceiling exists). Applies to: LLM eval pipelines with strict per-field equality, classifier regression tests, ML eval after model migrations, RAG output verification, any methodology where 1-cell flips can move slot-level gate counts. Example: +0.5pp aggregate from two scalable rule edits can hide a structural-win cohort (dimension extractions via a new rule) + abbreviation/casing P56-noise "regressions" (where the new emission is better for production retrieval) + a small real routing regression. Without the cell-level diff the call would have been "+0.5pp keep" (premature) or "material lost gate revert" (forfeits structural win).
