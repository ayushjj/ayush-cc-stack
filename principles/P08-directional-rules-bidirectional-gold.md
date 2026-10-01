# P08 (private P59) — Directional rules need bidirectional gold evidence before authoring

> Externalized 2026-07-04 (S44 Fable-5 audit). CLAUDE.md retains the inline T1 trigger + T2 rule; this file preserves the full pre-audit principle text verbatim.

**Applies to**: rules of shape "X should be Y" / "X ↔ Y" — LLM judge predicates, eval gate rules, lint policies, taxonomies, schema validators.

## Full text (verbatim from CLAUDE.md as of 2026-07-04)

> Directional rules need bidirectional gold evidence before authoring — for rules of shape "X should be Y" / "X ↔ Y" (LLM judge predicates, eval gate rules, lint policies, taxonomies, schema validators), sample gold in BOTH directions BEFORE drafting; single-direction justification is insufficient even when intuitively obvious. Detection: an example list showing transitions in only one direction. Distinct from P51 (cross-component drift): in P59 the paired components agree on the rule text, but the text is wrong on *direction* — caught only by gold cross-check (e.g. a substitution rule authored from expansion-direction compounds was wrong on the acronym→expansion direction gold actually preferred).
