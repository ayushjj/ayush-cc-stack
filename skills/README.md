# Skills

30 named procedures, invoked via `/<slug>` in a Claude Code session. The agent reads the skill's `SKILL.md` and executes the procedure inside the same conversation.

## One line per skill

`*` = vendored from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT) — see `../THIRD_PARTY_NOTICES.md`.

| Slug | Purpose |
|---|---|
| `catchup` | Cold-start orientation: recent commits, registry entry, plan, linked learning |
| `wrapping-session` | End-of-session: update memory, capture learnings, commit + push |
| `premise-check` | "Should we build this at all?" before any spec or plan |
| `creating-specifications` | Multi-session design doc (design + decisions + implementation triad) |
| `grill-me`* | Interview the user branch-by-branch to resolve every open decision in a plan |
| `review-plan` | Self-adversarial review of a plan before `ExitPlanMode` |
| `review` | Type checks + a right-sized slate of parallel review agents before commit |
| `code-review`* | Review changes since a fixed point against repo standards and the originating spec |
| `tdd`* | Red-green-refactor, test-first |
| `harden` | Prove a check can FAIL by mutating what it guards |
| `diagnosing-bugs`* | Diagnosis loop for hard bugs and performance regressions |
| `resolving-merge-conflicts`* | Resolve an in-progress merge/rebase conflict |
| `codebase-design`* | Shared vocabulary for designing deep modules |
| `domain-modeling`* | Build and sharpen a project's domain model (CONTEXT.md, ADRs) |
| `research`* | Investigate against primary sources; capture findings as Markdown |
| `executing-batch-operations` | Dry-run → sample → execute → verify protocol for bulk data work |
| `autonomous-batch` | Run a queue of N similar tasks through fresh-context subagents end-to-end |
| `freeze` | Block edits outside a specific directory during scoped debugging |
| `careful` | Block destructive Bash commands (`rm -rf`, `DROP TABLE`, force push, etc.) |
| `git-guardrails-claude-code`* | Install hooks that block dangerous git commands |
| `setup-pre-commit`* | Husky + lint-staged + type check + tests pre-commit setup |
| `prompt-engineering` | Structure and tune LLM prompts using battle-tested patterns |
| `learn` | Extract insights from a URL / article / book into a knowledge graph |
| `level-up` | Weekly scout of Claude Code + Anthropic release notes |
| `scout` | Compare bookmarked workflow tips against your setup; dated gap report |
| `prune-memory` | Archive stale mistake-table rows and memory entries (move, never delete) |
| `hook-review` | Audit hooks for correctness, false-positive rate, harness compatibility |
| `skill-audit` | Detect project-specific tokens leaking into skills and hooks |
| `telemetry` | How often each skill runs, and which mechanism fired it |
| `publish-stack` | Prepare this public snapshot: copy, renumber, sanitize, leak-gate |

## Install

Copy `skills/` into `~/.claude/skills/`. Each skill is a directory with at minimum a `SKILL.md`; some carry a `scripts/` subdirectory for skill-attached hooks (co-located per the paired-semantics contract — see `../hooks/README.md` § Hook system union).

Invoke a skill by typing `/<slug>` in a Claude Code session. The agent will also invoke a skill automatically when the trigger conditions in the skill's `description:` frontmatter match what the user is asking.

## Universal-by-construction

Per principle `P17-skills-universal-by-construction.md`, every skill in this directory must work for any project. Project-grounded incidents — the failure that motivated the skill, the worked example with real names — do NOT belong in `SKILL.md`. They belong in `learnings/`. The skill describes shape; the learning preserves story.

Adopt-and-adapt: a skill that has been adapted to add a project-specific code path is fine, but the adaptation belongs in a project-scoped overlay (`.claude/skills/<slug>/` at the project root), not in the global skill at `~/.claude/skills/<slug>/`. The global one stays universal so it works in every project.

## What's NOT in here (and why)

Some skills from the private OS are intentionally omitted — the top-level `README.md` § What's NOT in here gives the rationale.

If you need a skill that does not exist in this stack, write it as a one-page `SKILL.md` and drop it into the directory. The frontmatter pattern is consistent across the skills here; copy any one as a template.
