# Case Study: Hook Migration to Block Mode + Latent Glob Bug

## What Worked

- **`/level-up` → `/review-plan` → implement → commit pipeline.** The adversarial review pass between plan and implementation caught two things forward review missed: (1) the load-bearing `exit(2) → Claude sees stderr` assumption, asserted from memory without verifying, (2) a downstream-project managed-dev contract risk that had landed literally that morning. Both would have shipped silently as bugs without the review pass. The four-stage cadence (scout → plan → adversarial → ship) is the right shape for OS-level config changes that affect every project.
- **Smoke-testing hooks BEFORE wiring them.** Two new hooks had bugs surface only when 9 test cases each ran against them — `cd dir && cmd` semantics, subshell handling, plugin-path traversal, namespaced slug parsing. The Write→syntax-check→smoke-suite→wire workflow took 15 min vs. an estimated 1+ hour of debugging-in-production if smoke tests were skipped.
- **Three-tier hook design** (skip env var / warn-only env var / block by default). Every new hook ships with `CLAUDE_<NAME>_SKIP=1` and `CLAUDE_<NAME>_WARN_ONLY=1` env-var escapes. The pattern came from existing block-mode hooks and proved its worth immediately: `CLAUDE_EVAL_FIRST_SKIP=1` was used on the very commit that deployed the hook (no test files exist in `~/.claude` itself, so the new block would have blocked its own commit).

## What Didn't Work

- **Initial recommendation framing equated a new release-note feature with an existing hook's behavior.** A release note suggested both existing hooks would adopt a new `continueOnBlock: true` flag. Reading the actual hook source revealed they were already PreToolUse with `exit(2)` block mode built-in — the migration was a one-line env-var flip, not a feature adoption. Lesson: **never plan a migration without reading the source** the migration touches. The release-note feature was a PostToolUse-only addition; it was for FUTURE hooks, not existing PreToolUse ones.
- **An eval-first `*test_*` glob had been silently passing in projects with `latest_*` files** since the hook landed several weeks prior. Substring match: `latest_e` contains `test_e`. Forward review of the original hook design never caught this; only running the glob against a real Rails-style project ("does this project have tests according to this hook?" → "yes, 220 matches" → "wait, look at the matches: they're view templates") surfaced the bug. ~30 days of false negatives.

## Key Insights

1. **Validation-in-session is the strongest signal a guardrail is well-targeted.** While building the cd-persistence hook, the author ran `cd <project-dir> && git ls-files ...` to investigate — exactly the pattern the hook blocks. The fact that the person who knew the rule best naturally violated it while implementing the guard for it = the rule is correct (the violation is the steady-state behavior) and the guard has real work to do. Stronger than any synthetic test case. **Practical rule**: when designing a new hook/lint/guard, if you complete the design WITHOUT triggering it yourself in the same session, suspect the detection is too narrow.

2. **Self-deploying guards have a ratchet risk: the change you're making can refuse the change.** When the hook deployment landed, the freshly-shipped `CLAUDE_EVAL_FIRST_BLOCK=1` could have blocked the commit (no tests in `~/.claude` itself). Required preemptive `CLAUDE_EVAL_FIRST_SKIP=1` on the commit Bash call. Generalizes to: any guard that fires on the workspace shape of its own host repo needs an opt-out the deploying agent can set. Especially relevant for monorepo or dotfiles repo deployments of CI/CD/lint rules.

3. **Guards that "never fire" should be investigated, not trusted.** The eval-first glob was passing silently for 30 days — looked like "no projects violated the rule" when actually "the rule was matching nonsense and passing everyone." If a hook's fire-rate is zero over many sessions, the steel-manned hypothesis is "the detector is broken," not "the discipline worked." Hook-review skill's "RETIRE candidate" criterion ("hasn't fired in 2 reviews") needs an inversion: a hook that hasn't fired might be broken-pass, not extinct-violation. Both possibilities need triage.

## Files Changed

- `~/.claude/hooks/check-eval-first.js` — tightened glob from loose `*test_*` / `*_test.*` to extension/directory-anchored patterns
- `~/.claude/hooks/check-cd-persistence.js` — NEW
- `~/.claude/hooks/check-skill-slug.js` — NEW
- `~/.claude/settings.json` — added `env` block (BLOCK vars), 2 new PreToolUse hook registrations, hook-review skill override
- `~/.claude/skills/hook-review/SKILL.md` — NEW skill, fortnightly cadence (every 14 days, matched to Claude Code release pace not calendar)

## Metrics

- **Latent bug duration**: ~30 days (eval-first glob hidden false-negative since the hook landed)
- **Hooks deployed**: 2 new + 2 mode-flipped
- **Hooks deferred**: 3 (insufficient detection or unclear failure mode)
- **Smoke tests run before deploy**: 18 (9 per new hook)
- **`/review-plan` findings actioned**: 4 of 5 revisions (1 finding proved unnecessary on actual filesystem check)

## Forward Concerns

- **First fire of new hooks in next session** is the real validation. Watch for false positives, especially on legitimate `(cd dir && cmd)` subshell patterns — smoke tests passed but production traffic may surface edge cases.
- **First hook-review** will confirm fire-rate is non-zero (else investigate for broken-pass per Key Insight 3) and false-positive rate is < 1/10 fires.

## Maps to public CLAUDE.md

- Principle 57 (suggestion-based gates fail silently) — this learning is the *deepening* into hard gates with three-tier design and validation-in-session checks
- Workflow Gates table (anti-cheat, eval-first, cd-persistence, skill-slug, context-wrap-trigger) — direct lineage; this is how that table got populated
- Rule 0 (classify before acting) — the four-stage scout/plan/adversarial/ship cadence operationalizes this
- Rule 8 (review before presenting plan) — `/review-plan` caught two surfaces forward review missed
