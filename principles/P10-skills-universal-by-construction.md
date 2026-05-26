# P68 — Skills and hooks are universal by construction

> **Trigger** (kept inline in `~/.claude/CLAUDE.md` Principles): Skills and hooks are universal by construction; project-specific incidents live in `learnings/<date>-<topic>.md`, not in `skills/<skill>/SKILL.md` or `hooks/<hook>.js`. If you find yourself adding a session number, decision ID, record ID, business name, or project path to a skill or hook, you are editing the wrong file.

## The structural distinction

`~/.claude/` has four layers with intentionally different universality contracts:

| Layer | Holds | Universality posture |
|---|---|---|
| `skills/<name>/SKILL.md`, `hooks/<name>.js`, inline `settings.json` hooks | Procedure: how to do X. | **Universal by construction.** Zero project-specific tokens. Synthetic archetypes only. |
| `CLAUDE.md`, `principles/PNN-*.md`, `governance.md` | Provenance: firing counts, dates, incident-class headlines. | **Sanitized.** Provenance *shape* preserved; identifying *content* stripped. |
| `learnings/YYYY-MM-DD-topic.md` (user-global) | Full incident narratives, sub-incident archives. | Project-grounded by design. Forensic detail lives here. |
| `projects/<slug>/memory/` | Per-project memory + project-grounded learnings. | Per-project by design; auto-loaded only for that project. |

The bug is layer confusion: project-specific incidents accumulating in skills via organic inline-capture from `/wrap`. The capture habit that built CLAUDE.md (write findings to the right place as they emerge) is *correct* for CLAUDE.md / MEMORY.md / learnings/ and *wrong* for skills/hooks.

## Detection

A skill or hook FAILS universality iff a grep over the file matches any of:

- **D1** — project names (the user's active project slug set)
- **D2** — session/record/rule ID tokens of the form `\bS[0-9]{2,3}\b`, `b_[0-9]{4}`, project-numbered `\bD[0-9]{1,3}\b` / `\bR[0-9]{1,3}\b`, or other project-specific prefixes
- **D3** — production schema fragments (table names, column names from production)
- **D4** — absolute user paths (`/Users/<name>/...`); prefer `$HOME` or `~`

`/skill-audit` runs these as four denylist regexes (sourced from `~/.claude/.skill-audit-patterns`, user-private). Quarterly cadence catches recurrence before it accretes.

### Known structural carve-outs

Two regex-collision cases are intentional and excluded from contamination count:

- `scout/SKILL.md` uses `R1`–`R7` as its own self-review rule labels. `level-up/SKILL.md` references `Run self-review R1-R7 (scout Step 5.5)` as a cross-skill pointer. Both are skill-internal nomenclature, NOT project-coupled rule IDs.
- `\bS[0-9]{2,3}\b` correctly catches session IDs (3-digit-anchored in practice); single-digit session IDs would collide with unrelated codes but that pattern is rare.

When a D-grep fires on these lines, count them as carve-outs (effective contamination unchanged).

## Fix

When the gate fails on a skill or hook:

1. **Read the contaminated file fully** (Rule 4 — never edit unread).
2. **Extract the identifying detail** to `~/.claude/learnings/<date>-skill-<name>-refactor.md` (or `hook-<name>-genesis.md`), preserving the worked example verbatim. The incident has forensic value, just not in the universal layer.
3. **Replace the example in the skill/hook** with either (a) a synthetic shape (generic archetype like "a part code", "an auth flow", "a session ID token"), or (b) a pointer to the learning (`see learnings/<date>-...md for the original incident`).
4. **Verify diff shape** (Behavioral Preservation Contract §1): only example-block / comment / docstring removals + learnings-file additions. No procedural changes, no validation-gate changes, no frontmatter changes, no skill-coupling-phrase changes.
5. **Smoke-test the skill** in its natural trigger context before declaring done (Behavioral Preservation Contract §2, class-specific method).
6. **Commit per skill** for clean rollback (Behavioral Preservation Contract §4). One refactor = one commit.

## Applies to

- Every skill in `~/.claude/skills/`.
- Every hook in `~/.claude/hooks/` (standalone, skill-attached, and inline `settings.json` hooks).
- The `/skill-audit` skill ITSELF must pass its own gate — recursive bootstrap. Achieved by externalizing the project-specific denylist patterns to `~/.claude/.skill-audit-patterns` (gitignored; user-private; outside the audited scope).

**Out of scope:**
- `learnings/` (project-grounded by design — auditing learnings for universality is a category error).
- `projects/<slug>/memory/` (auto-loaded only for that project; per-project by design).
- `CLAUDE.md` mistake table (sanitization, not universalization — preserves provenance shape with firing counts + dates; strips identifying content). Audited under different criteria in audit-spec Block E.
- `specs/` and runtime state directories (`level-up-state.yaml`, `session-registry.yaml`, etc.) — runtime artifacts, not behavioral code.

## Example: the wrap-skill refactor

The system audit caught dozens of project-specific references in a single skill — session IDs, decision IDs, record IDs, and one production schema fragment in anti-shape examples. The refactor extracted every verbatim historical anti-shape to a learning file and replaced them with synthetic placeholders preserving the teaching contrast. Diff shape was substitution-only: zero changes to Bash, regex, char caps, decision matrices, verification logic, or skill-coupling contract phrases. Natural smoke fired correctly on the next session's `/wrap`.

Full incident detail: `~/.claude/learnings/2026-05-26-skill-wrapping-session-refactor.md`.

## Anti-pattern: `/wrap` writing past its layer

`/wrap`'s "Persist findings inline — don't batch" rule (a skill-coupling contract phrase frozen per governance.md) is correct for the provenance layers and wrong for the universal layers. The same `/wrap` step writing to CLAUDE.md should NEVER write to a skill file. If a session-end capture lands in a skill, the routing logic is the bug — not the capture habit.

## Distinct from

- **P42** (unverified state claims): P42 is about source-of-truth grounding ("read the file before claiming it says X"). P68 is about layer routing ("X belongs in file A, not file B"). Verifying that "the file says X" doesn't tell you whether X belongs there.
- **P55** (mature-prompt non-locality): P55 is about narrow edits in *prompts* causing broad regressions. P68 is about *what content belongs in which file*. Both apply during refactor but at different layers.
- **P51** (paired-semantics drift): P51 forbids changing skill-coupling literal phrases without a paired update. P68's refactor MUST preserve those phrases verbatim — the Behavioral Preservation Contract intersects with P51 at frozen contract phrases.

## Cadence

Quarterly `/skill-audit` (aligned with `/prune-memory`'s 90-day cycle) runs the four denylist regexes and reports new failures since last run. Next due: ~2026-08-23. After any refactor touching multiple skills or hooks (event-driven), invoke ahead of schedule.

## Migration note

Authored 2026-05-26 during the system audit's P5 meta-layer phase. New paragraph-form principle; per the probation clause in governance.md admission rule #4, T3 narrative externalizes to this file from day 1 (no inline firing-evidence yet). Promotes from probation when firing evidence accumulates (cited in ≥2 sessions). CLAUDE.md retains T1 (trigger) + T2 (detection + fix + applies-to + enforcement) for reactive firing.
