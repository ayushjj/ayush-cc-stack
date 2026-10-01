# Hooks

Seven standalone hooks. Each is a deterministic gate that runs on a specific Claude Code agent-harness event. Skills run when invoked; hooks run automatically on every matching action.

## What each catches

(For the why-it-exists rationale per hook, see the top-level `README.md` § The hooks.)

| File | Event | Catches |
|---|---|---|
| `check-anticheat.js` | PreToolUse (Edit / Write) | Test deletions or assertion weakening in the staged diff |
| `check-cd-persistence.js` | PreToolUse (Bash) | `cd <relative-path>` outside an explicit subshell |
| `check-eval-first.js` | PreToolUse (Bash `git commit ...`) | Source-code commits with zero corresponding tests |
| `check-skill-slug.js` | PreToolUse (Skill) | Skill invocations using a shorthand name that does not resolve |
| `context-wrap-trigger.js` | UserPromptSubmit | Context usage crossing 35% / 45% / 60% with unfinished work — injects an escalating system-reminder |
| `memory-size-gate.js` | PostToolUse (Edit / Write) | CLAUDE.md / MEMORY.md / governance.md growing past soft size thresholds |
| `precompact-guard.js` | PreCompact | Auto-compaction about to fire with a wrap marker live and a matching PID still running |

## Install

Copy `hooks/` into `~/.claude/hooks/`. The wiring lives in the top-level `settings.json` `hooks:` block — adopt the shipped version of `settings.json`, or merge the hook entries into your existing one.

Each hook honors a per-hook env variable to disable it individually without removing the wiring. The variable names live at the top of each file (search for `process.env.CLAUDE_`). Disable an individual hook by setting its variable to `0` in `settings.json` `env:` or your shell environment, then restart Claude Code.

## Hook system union

This directory is only one of three sub-types in the hook system. The full hook system is the union of:

1. **Standalone hooks** — this directory. Universal cross-skill defenses.
2. **Skill-attached hooks** — `~/.claude/skills/<slug>/scripts/*.js`. Co-located with the skill they pair with under a paired-semantics contract (see principle `P02-paired-semantics-drift.md`). Examples in this stack: `/careful` + `check-destructive`, `/freeze` + `check-freeze`, `/review` + `check-review-gate`. The skill toggles a flag file; the hook reads the flag and enforces the gate.
3. **Inline hooks** — short shell commands in `settings.json` `hooks:` block. Audio notifications, git-push warn-lines, brief reminder strings.

An audit that walks only this directory is incomplete (a false-negative class). The `/hook-review` skill traverses all three sub-types; run it fortnightly per the maintenance cadence in the top-level `README.md`.

## When to add a new hook

Per principle `P17-skills-universal-by-construction.md`, hooks (like skills) must be universal-by-construction. A hook that hardcodes a project name, a session number, a record ID, or an absolute `/Users/<name>/` path is the bug — that incident belongs in a `learnings/` file, not in the hook source.

The pattern for adding a hook: a failure class fires N+K times in the mistake table; the suggestion-based defense fails silently (principle `P04`-class: mature suggestion gates do not survive context busyness); promote to a deterministic gate; smoke-test on at least one real session before flipping to block mode. The `2026-05-18-hook-migration-phase-0-1.md` case study in `../learnings/` walks the canonical workflow including the latent-bug class to watch for.
