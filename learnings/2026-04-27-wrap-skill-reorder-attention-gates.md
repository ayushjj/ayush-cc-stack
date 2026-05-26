# Case Study: Wrap-Skill Reorder + Attention-Gate Failure Mode

## What Worked

- **Empirical detection beats post-hoc reasoning**: the bug surfaced not from skill-design review but from `git rev-list @{u}..HEAD` showing 4 unpushed commits across several recent sessions. The artifact (unpushed commits) made the failure undeniable in a way that "the proactive nudge sometimes doesn't fire" never would have. When evaluating a workflow gate's reliability, look for state that piles up when the gate fails — the pile is the diagnostic.
- **Cross-checking the skill against its own asymmetry**: the wrap skill auto-pushed `~/.claude` (multi-machine, secrets-adjacent — higher risk profile) but deferred the project repo (single-developer pilot — lower risk profile). The asymmetry was the design smell. Generalizable diagnostic: when a skill applies a gate to one branch of behavior but not another, ask what risk-profile difference justifies the asymmetry — if you can't articulate one, the gate is misplaced.

## What Didn't Work

- **Suggestion-based gates that depend on agent attention**: CLAUDE.md's "post-commit, no push, session ending → suggest push" is a proactive-suggestion rule that only fires if the agent notices the trigger. Across several recent sessions, four commits sat unpushed because the suggestion never fired — context was busy with substantive work, the heuristic-pattern-match step got skipped. The failure is silent (no error, no warning, just absence of the suggestion).

- **Commit-then-document ordering in the wrap skill**: Step 1 committed code/data, then Steps 2-5 wrote spec/plan/learnings/telemetry. Every wrap structurally orphaned the documentation files (uncommitted in the working tree until next session's `/catchup` happened to surface them). A recent commit message advertised plan + decisions updates that didn't actually land in that commit — a documentation-vs-reality drift baked into the skill's ordering.

## Key Insight

**Suggestion-based workflow gates fail silently under cognitive load.** Any rule of the form "Claude should remind the user to X when Y" relies on the agent's attention to fire — and attention is the first thing to go when context is busy with substantive work. The reliable patterns are:

1. **Bake the action into a skill that's already running** (e.g., `/wrap` itself does the push, instead of CLAUDE.md suggesting "you should push at session-end"). Zero attention required; the skill's checklist enforces it.
2. **Make it auto-fire** (hook, cron, file-system trigger). Even better — no agent in the loop.

Suggestion-based gates can supplement these but should not be the primary enforcement.

**Detection metric**: count how often the gate actually fired across the last N sessions vs. how often the trigger condition was true. A large gap = the suggestion-based mechanism is failing.

**Generalizable corollary**: the same applies to mistake-table updates, learning-file captures, and any "Claude should notice X and do Y" pattern. When the failure mode is silent, the only protection is hardening the trigger (move it from heuristic-attention to deterministic-execution).

## Files Changed

- `~/.claude/skills/wrapping-session/SKILL.md` — Steps 1-7 reordered (docs → commit), Step 7b push gate added (branch in `{main, master}` + upstream set + ahead-not-diverged).
- Downstream project repo: backlog of orphaned docs caught up in a follow-up commit.

## Metrics

- **Before**: 4 commits unpushed across several recent sessions (silent failure of "session-end push" CLAUDE.md suggestion).
- **After**: wrap skill commits + pushes project repo automatically, gated narrowly on branch + upstream + ahead-not-diverged.
- **Push-gate false-positive risk**: low — `git rev-list --left-right --count @{u}...HEAD` returning `0\tN` means no remote divergence; on diverged state the wrap reports and stops without force-pushing.

## Maps to public CLAUDE.md

- Principle 57 (suggestion-based workflow gates fail silently under cognitive load) — this is the founding incident
- Mistake-table row "Wrap past safe-context window → /compact blocked by wrap-marker → user couldn't escape" — same class of structural-vs-suggestion-gate fix family
- Workflow Gates table row "Context consumed ≥ 35% / 45% / 60% → Run `/wrapping-session`" — P57 fix lineage (hardened from CLAUDE.md suggestion to runtime hook)
