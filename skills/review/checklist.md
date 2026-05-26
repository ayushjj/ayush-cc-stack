# Review Checklist

Derived from documented failures in CLAUDE.md Mistake Patterns and Principles.
Each item traces to a real incident. Keep under 15 items total.

## CRITICAL (blocks shipping)

1. **Schema before query** — Any new DB query must reference verified column names, not assumed ones. [Mistake: 12x "Wrote DB code without reading schema first"]
2. **Grep all callers** — Before changing a function signature or behavior, grep all call sites. [Principle 1]
3. **No untested LLM prompt changes** — LLM prompt modifications must be validated by eval harness or live query test before shipping. [Mistake: 1x "Deployed LLM prompt change without testing on live query"]
4. **Early returns audit downstream** — Adding an early return? Audit what downstream logic it skips. [Principle 17]
5. **Deterministic validation for LLM extraction** — If LLM extracts structured data (IDs, phones, emails), add post-validation that characters exist in source text. [Principle 22]
6. **Identity guard user-flow test** — Guards on identity flags (fromMe, isOwner) must be tested with actual user flow, not just code inspection. [Principle 26, Mistake: 1x "Deployed guard without testing actual user flow"]
7. **max_tokens budget for structured output** — Structured output calls need 2x expected content tokens. Use fail-closed defaults (keep-sets not reject-sets). [Principle 21]

## INFORMATIONAL (noted, not blocking)

8. **Fix root cause, not symptom** — Is this change addressing the actual cause or patching around it? [Mistake: 2x, Principle 2]
9. **LLM prompt: examples over rules** — Prefer concrete examples in prompts over abstract rule paragraphs. [Principle 5]
10. **LLM prompt position = priority** — Restrictive rules after permissive anchors are effectively dead. Hard overrides must appear before the default decision point. [Principle 14]
11. **Competing general instructions** — If a general instruction overrides a specific rule, fix the general one's scope. [Principle 6]
12. **Study working examples first** — Before building something new, check if a working example already exists in the codebase or reference projects. [Mistake: 2x "Fought platform conventions"]
