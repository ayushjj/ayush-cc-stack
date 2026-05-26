# P55 — Mature prompts exhibit non-locality

> **Trigger** (kept inline in `~/.claude/CLAUDE.md` Principles): Mature prompts exhibit non-locality — narrow edits produce broad aggregate regressions across unrelated categories. In a 500+ line prompt with many exemplars and tuning history, a single-exemplar revision + 1-line header note can ripple through the model's behavior on categories the edit never touched. The target edit lands correctly on its target records AND the aggregate regresses.

## Detection
Run a full-sample re-eval after any prompt edit (target-case test is necessary but not sufficient per P50); aggregate regression exceeding P20 noise with category shifts on non-target categories is the signature.

## Corollary — saturation point
At some point in prompt maturation, further in-prompt iteration has negative expected value — marginal surgical edits have upside of healing N target records and downside of regressing M-unrelated; beyond a saturation point M > N.

## Structural fix
Move declarative content (vocabulary, codebooks, routing tables) OUT of the prompt into modular retrievable stores where edits compose.

## Applies to
Any mature LLM prompt under active tuning, RAG system prompts, classifier prompts at scale, agent-system prompts that evolved over many sessions.

## Example (first incident)
A routing exemplar revision designed to reduce a target metric instead INCREASED it while also regressing two unrelated metrics — 16pp aggregate drop from a narrow edit that verified correct behavior on its target records.

## Second incident
A structural-only top-of-prompt clause for a new input field (33 lines, no exemplar/rule changes) regressed −3.8pp aggregate with 18 cell departures on records where the new clause shouldn't have applied — confirms "structural-only" extensions to mature prompts also exhibit non-locality, not just exemplar edits.

→ Full narrative preserved in private OS learnings.

## Cross-refs
- Complement to P50 (target-case test necessary but not sufficient)
- A project-side decisions log codifies the structural-fix corollary as the "Code → Codebook → Prompt" refit-layer policy.

## Migration note
Externalized 2026-04-28 during a CLAUDE.md compression pilot. Original full inline text preserved verbatim above (both incidents + corollary + structural-fix + applies-to); CLAUDE.md retains T1 + T2 (detection + corollary + structural-fix + applies-to) for reactive firing.
