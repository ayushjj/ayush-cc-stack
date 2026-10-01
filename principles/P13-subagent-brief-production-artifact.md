# P13 (private P64) — Parallel sub-agent briefs are part of the work product

> Externalized 2026-07-04 (S44 Fable-5 audit). CLAUDE.md retains the inline T1 trigger + T2 rule; this file preserves the full pre-audit principle text verbatim.

**Applies to**: every brief handed to a parallel sub-agent that will produce drafts/code meant to integrate with production reality.

## Full text (verbatim from CLAUDE.md as of 2026-07-04)

> Parallel sub-agent briefs are part of the work product — agents reproduce from their input surface, so a brief omitting production-side reference artifacts produces drafts that follow the spec but break against production reality (wrong paths, wrong field names, stale enums). The brief's read-list MUST include ≥1 production-side reference artifact (output sample, runtime config, live schema, an existing adjacent script) alongside specs/plans. Detection: bug-rate divergence between sibling agents with similar complexity but different read-lists; a draft that follows the plan but breaks at integration smoke. Distinct from P43 and P57. Cheap fix: ask "does this read-list show actual production reality, or only intended reality?"
