# P61 — LLM-judge run-to-run disagreement is escalation signal, not noise

> Externalized from `~/.claude/CLAUDE.md` on 2026-04-29 as part of Phase 1 of the CLAUDE.md compression arc (background: `~/.claude/meta/claude-md-compression-arc.md`).
> T1 (recognition trigger) + T2 (rule body + architecture + detection + applies-to) remain inline in CLAUDE.md. T3 (worked-example narrative) lives here.
> Reversal: if the principle fails to fire on a real situation in a future session, copy the **Original verbatim text** section back inline into CLAUDE.md, delete this file, and append a one-line note to the compression-arc append-only log.

## Tier 3 — Worked example (externalized)

**Worked incident**: A semantic-equivalence LLM judge was run on 64 strict-mismatch cells from a prior session's eval — the goal was to convert "did the extracted value strictly equal the GT?" into "is the extracted value semantically equivalent to the GT, accounting for canonical-form variation?"

Three-tier methodology that emerged from the run:

| Tier | Operation | Result |
|---|---|---|
| **Single run** | First independent pass | 90.1% semantic-equivalence (would have been the headline) |
| **Self-consistency hardening (P61)** | Second independent pass with same prompt + model + inputs | 87.7% — verdict agreement only 62.5%, **21-cell run-to-run swing** |
| **Stage 4.5 web-search escalation** | On the 24-cell disagreement residual, run web-search against manufacturer catalogs / standards datasheets | 16/24 resolved with citations; 8 INCONCLUSIVE = bounded human-review surface |

Final tiered headline: **89.1% confidently-correct / 91.1% upper bound / 1.9% needs-FLAG**.

The single-run 90.1% headline would have been overstated by ~1pp (not catastrophic) but more importantly would have hidden the structural finding: 21 cells out of 64 had genuine LLM-judgment instability, not noise to average away. Those exact cells are the ones where the LLM doesn't have enough context inside its own weights to resolve the equivalence question — and they map almost 1:1 onto the cohort that needs **external evidence** (manufacturer catalog, MIL-STD spec, regional naming convention). The disagreement residual IS the escalation queue.

Architecture takeaway: **spine (deterministic Python checks) + crown (LLM with self-consistency hardening) + escalation (web-search OR human review on the disagreement residual)** is the right shape for any LLM-judge measurement gate. Single-run aggregate is the pre-discipline shape and cannot be trusted at temperature 0 — the same prompt + model + inputs can swing 20pp+ on a single load-bearing prompt clause (e.g., "prefer X over Y in close calls" rewriting vs absent).

Full session writeup preserved in private OS learnings.

## Original verbatim text (rollback source — do not edit)

> 61. Drift between independent LLM-judge runs is signal mapping onto external-evidence-resolution candidates, not noise. For any LLM-as-judge measurement gate: run two independent passes (same prompt, same model, same inputs); cells where both runs agree are trustworthy verdicts; cells where they disagree are not "judge noise to average away" — they are exactly the cells the LLM legitimately can't resolve alone, mapping onto the external-evidence-required (catalog/standards/datasheet) cohort. Architecture: spine (deterministic) + crown (LLM with self-consistency hardening) + escalation (web-search or human review on the disagreement residual). Single-run aggregate cannot be trusted — run-to-run distribution can swing 20pp+ at temperature 0 from a single load-bearing prompt clause (e.g., "prefer X over Y in close calls"). Detection: any LLM-judge headline reported from a single run; aggregate verdict distribution that shifts >10pp on re-run. Complement to P52 (verdict drift exists) + P56 (LLM-vs-LLM strict ceiling) + P48 (spine + crown split). Applies to: LLM-as-judge measurement gates, any classifier with semantic-judgment slots, eval harnesses that depend on judge verdicts. Example: a single-run semantic-equivalence judge gave 90.1% on 64 strict-mismatches; a second independent run gave hardened 87.7% (62.5% verdict agreement, 21-cell run-to-run swing); web-search escalation on the 24-cell disagreement residual resolved 16/24 with manufacturer catalog citations and 8 INCONCLUSIVE = bounded human-review surface — final tiered headline 89.1% confidently-correct / 91.1% upper bound / 1.9% needs-FLAG.
