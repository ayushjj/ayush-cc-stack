# P58 — Static-set discriminators leak both directions

> **Trigger** (kept inline in `~/.claude/CLAUDE.md` Principles): Static-set discriminators leak both directions — false positives (set members who don't match the underlying intent) AND false negatives (non-members who do). Before defining a rule of shape "if X ∈ {curated list}", ask: *what does membership in the list MEAN, and can I detect that meaning directly?* When the answer is yes, route on the underlying signal — the static set becomes redundant *and* the maintenance burden disappears.

## Detection
Any rule whose precision/recall degrade as the domain shifts, whose maintenance scales with N (curated names, IOC lists, blocked-terms allowlists, role-name allowlists), or whose first false-positive prompts a "we need to add an exception for X" patch.

## Applies to
API auth/role gates, security IOC matching, content moderation blocklists, eval-harness category routing, classifier discriminators, any decision rule that takes "list of names" as primary input.

## Cross-refs (distinguishing class)
- Distinct from P15 (deterministic rule → enforce in code, not prompt) — P58 is about *which signal* the deterministic rule consumes
- Distinct from P50 (right-context discriminator for token-shape) — P58 is about set-membership vs computed-attestation as the discriminator class

## Example (worked incident)
A rule of shape "foreign-key ∈ {curated brand list} = supplier" had FN risk (real suppliers not in the set) AND FP risk (a brand sometimes IS the OEM for its own catalog). Replaced with OEM-canonical-part-no detection (each manufacturer's part-numbers follow a brand-specific pattern — no name list needed); validated zero false positives across a 73-record sample.

→ Full narrative preserved in private OS learnings.

## Migration note
Externalized 2026-04-28 during a CLAUDE.md compression pilot. Original full inline text preserved verbatim above (trigger + detection + applies-to + cross-refs + worked example); CLAUDE.md retains T1 + T2 (detection + applies-to + cross-refs) for reactive firing.
