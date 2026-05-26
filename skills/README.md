# Skills

26 named procedures, invoked via `/<slug>` in a Claude Code session. The agent reads the skill's `SKILL.md` and executes the procedure inside the same conversation.

## Firing cadence

Skills group into classes by firing rate. Class determines smoke-test method whenever a skill is refactored — always-fires skills smoke-test in the next session; quarterly skills need a manual dry-run.

| Class | Skills |
|---|---|
| **Always-fires** (per-session) | `catchup`, `wrapping-session` |
| **Common** (multi-per-week) | `review`, `review-plan`, `freeze`, `careful` |
| **On-demand** (situation-triggered) | `premise-check`, `creating-specifications`, `investigating-problems`, `researching-before-planning`, `validating-queries`, `auditing-data`, `executing-batch-operations`, `audit-project`, `data-analysis`, `prompt-engineering`, `extract-from-senior`, `grill-me` |
| **Knowledge-graph satellites** | `learn`, `learn-book`, `scout`, `connect`, `level-up` |
| **Low** (quarterly+) | `prune-memory`, `hook-review` |
| **Pipeline utility** | `telemetry` |

## One line per skill

| Slug | Purpose |
|---|---|
| `catchup` | Cold-start orientation: recent commits, registry entry, plan, linked learning |
| `wrapping-session` | End-of-session: update MEMORY.md, capture learnings, run check command, commit + push |
| `premise-check` | "Should we build this at all?" before any spec or plan |
| `researching-before-planning` | Codebase + external research artifact before entering plan mode |
| `creating-specifications` | Multi-session design doc (design + decisions + implementation triad) |
| `review-plan` | Self-adversarial review of a plan before `ExitPlanMode` |
| `review` | Multi-agent parallel review of the staged diff before commit |
| `investigating-problems` | Logs-first, hypothesis-driven debug protocol |
| `freeze` | Block edits outside a specific directory during scoped debugging |
| `careful` | Block destructive Bash commands (`rm -rf`, `DROP TABLE`, force push, etc.) |
| `prune-memory` | Quarterly archive of stale mistake-table rows and MEMORY.md entries |
| `hook-review` | Fortnightly audit of hook firing rates and coverage gaps |
| `learn` | Extract insights from a URL / article / tweet into the knowledge graph |
| `learn-book` | Multi-pass extraction from a PDF or book |
| `level-up` | Weekly scout of Claude Code + Anthropic release notes + community sources |
| `scout` | Dated topic report into `scout-reports/` |
| `connect` | Find back-links between knowledge-graph insights |
| `prompt-engineering` | Structure and tune LLM prompts using battle-tested patterns |
| `data-analysis` | Quantified analysis of user data BEFORE proposing solutions |
| `telemetry` | Per-session metrics log (skills used, duration, files changed) |
| `audit-project` | Universal-by-construction completeness audit against a 9-dimension checklist |
| `auditing-data` | Orphan / duplicate / business-rule integrity sweep after batch operations |
| `executing-batch-operations` | Dry-run → sample → execute → verify protocol for bulk DB work |
| `validating-queries` | Run test queries against real data before declaring done |
| `extract-from-senior` | Source-fidelity pass when synthesizing external content (guards principle P42) |
| `grill-me` | Anti-sycophancy: actively challenge a decision rather than accept it |

## Install

Copy `skills/` into `~/.claude/skills/`. Each skill is a directory with at minimum a `SKILL.md`; some carry a `scripts/` subdirectory for skill-attached hooks (co-located per the paired-semantics contract — see `../hooks/README.md` § Hook system union).

Invoke a skill by typing `/<slug>` in a Claude Code session. The agent will also invoke a skill automatically when the trigger conditions in the skill's `description:` frontmatter match what the user is asking.

## Universal-by-construction

Per principle `P10-skills-universal-by-construction.md`, every skill in this directory must work for any project. Project-grounded incidents — the failure that motivated the skill, the worked example with real names — do NOT belong in `SKILL.md`. They belong in `learnings/`. The skill describes shape; the learning preserves story.

Adopt-and-adapt: a skill that has been adapted to add a project-specific code path is fine, but the adaptation belongs in a project-scoped overlay (`.claude/skills/<slug>/` at the project root), not in the global skill at `~/.claude/skills/<slug>/`. The global one stays universal so it works in every project.

## What's NOT in here (and why)

Three skills from the private OS are intentionally omitted (the top-level `README.md` § What's NOT in here names them and the rationale): `ingest`, `finding-techdebt`, and the private `skill-audit` skill (maintainer-only — the cross-project version is `/audit-project`).

If you need a skill that does not exist in this stack, write it as a one-page `SKILL.md` and drop it into the directory. The frontmatter pattern is consistent across the 26 skills here; copy any one as a template.
