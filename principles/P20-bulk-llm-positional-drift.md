# P20 (private P71) — Bulk LLM row-emission drifts out of positional alignment

> Externalized 2026-07-04 (S44 Fable-5 audit). CLAUDE.md retains the inline T1 trigger + T2 rule; this file preserves the full pre-audit principle text verbatim.

**Applies to**: any pipeline where an LLM emits N output rows meant to align 1:1 with N input rows.

## Full text (verbatim from CLAUDE.md as of 2026-07-04)

> **Bulk LLM row-emission drifts out of positional alignment — audit in code, never trust membership counts.** When an LLM emits N output rows meant to align 1:1 with N input rows, it intermittently shifts output by one (row K gets K-1's content) or drops/dupes mid-sequence. Membership/count checks PASS (all ids present, mis-paired); only POSITIONAL comparison catches it — token-overlap of input[K] vs output[K] vs output[K-1]. Detection: a downstream verifier's FIX/mismatch rate spiking in a contiguous range. Fix: re-run the range with explicit per-row alignment self-verify; bake a positional-alignment + 1:1 completeness assertion (output ids == contiguous 1..N) into the pipeline. Intermittent, NOT batch-size-correlated. Distinct from P67 and P48 (e.g. 3 of 11 maker subagents shifted, one full 150-row block — invisible to id-membership checks).
