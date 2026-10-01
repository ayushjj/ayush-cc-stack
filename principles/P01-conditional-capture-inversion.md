# P01 (private P36) — Conditional capture near learning loops must be inverted

> Externalized 2026-07-04 (S44 Fable-5 audit). CLAUDE.md retains the inline T1 trigger + T2 rule; this file preserves the full pre-audit principle text verbatim.

**Applies to**: any "capture X only when Y" rule adjacent to a feedback/learning loop (telemetry filters, conditional logging, selective memory capture).

## Full text (verbatim from CLAUDE.md as of 2026-07-04)

> Filter/discard rules near learning loops — any "capture X only when Y" rule adjacent to a feedback loop must be inverted: *would the loop still work with only Y=true cases?* If learning needs Y=false cases too (routine overrides, quiet successes, non-flagged decisions), replace conditional capture with unconditional capture + downstream filtering. Detection: forward review approves the rule as "clean"; inversion catches the silent discard. Distinct from P35 (missed sources) — P36 is discarded signal from *known* sources.
