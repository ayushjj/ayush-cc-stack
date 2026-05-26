---
name: catchup
description: Load prior session context to continue work seamlessly. Reads git log, last-session-registry entry, and IMPLEMENTATION-PLAN.md (if present). Does NOT re-read MEMORY.md or CLAUDE.md — those are auto-loaded via claudeMd injection. Triggers on "catch up", "catch me up", "continue where we left off", "/catchup".
preconditions:
  - Starting a new session that continues prior work
  - MEMORY.md auto-loaded via claudeMd (the harness handles this before the skill runs)
effort: low
---

# Catching Up

**Design principle**: COMPLEMENT, don't REPEAT. MEMORY.md and CLAUDE.md are already injected into every session's context as `claudeMd`. Re-reading them in this skill is pure duplication — the skill's job is to surface what's NOT already loaded.

What's auto-loaded (don't re-read): MEMORY.md, CLAUDE.md (principles + mistake table), git branch/status, current date.
What's NOT auto-loaded (this skill's job): recent commit messages, latest session-registry entry, IMPLEMENTATION-PLAN.md, and the learning file linked from MEMORY.md's most-recent session-delta line (the path auto-loads as text; the file's content does not).

## Flags

- **default `/catchup`** — intra-project only. Minimal delta reads, ~5-8K tokens. Use every session start.
- **`/catchup all`** — adds cross-project session-registry table. Use when explicitly switching between projects or suspecting an upstream blocker elsewhere.
- **`/catchup deep`** — adds knowledge-graph index scan + learnings/ glob enrichment. Use when starting work in unfamiliar territory or after a long absence from the project.

If the user's invocation includes `all` or `deep` as the sole argument, enable the corresponding section. Multiple flags allowed (`/catchup all deep`).

## Step 1: Delta Reads (parallel)

Run these in a single parallel tool-call batch:

0. **Sync remote refs**: `git fetch origin 2>/dev/null || true` — downloads the latest of EVERY branch from the remote and refreshes all `origin/*` tracking refs (`origin/production`, `origin/production-test`, `origin/master`, …), so the staleness check (Step 2) and `git status -sb`'s ahead/behind line reflect what teammates pushed since last session. SAFE: `git fetch` writes only to `.git` (object DB + `origin/*` refs) — it never touches the working tree, local branches, or staged changes, so it cannot lose uncommitted work. Non-fatal if offline. **Note**: fetch updates the `origin/*` mirrors, NOT your local branch pointers — to start new work from current code, cut the branch off the mirror directly (`git checkout -b <new-branch> origin/<base>`, e.g. `origin/production-test` for a test branch).
1. **Recent commits**: `git log --oneline -8` — last 8 commits for context depth
2. **Uncommitted state**: `git status -sb` — any WIP to flag; the `-b` branch line also shows ahead/behind vs the upstream (surfaces teammate pushes since last session)
3. **Latest session entry (this project only)**: parse session-registry.yaml for the current project's top entry:
   ```bash
   proj=$(basename "$PWD")
   sed -n '/^  '"$proj"':/,/^  [a-z-]\+:$/p' ~/.claude/session-registry.yaml | \
     grep -A 3 '^    - label:' | head -4
   ```
   Reads only the first session entry's label/date/status/next — not the entire 200KB file.

   **Why sed+grep, not awk**: skill-markdown injection expands `$N` tokens (positional shell params) to empty before bash sees the command, so an awk script with `$0` arrives as ` ~ "..."` and bombs with "syntax error... context is `>>> ~ <<<`". sed/grep avoid `$N` entirely.

   **Why `head -4`, not `grep -m 1`**: BSD grep on macOS stops reading after `-m 1` matches, suppressing `-A 3` trailing context. Piping to `head -4` is portable across BSD/GNU grep.

   **Why `^    - label:` (4 spaces)**: YAML registry indents session list items at 4 spaces (`projects:` 0 → `<project-name>:` 2 → `- label:` 4 → `date:`/`status:`/`next:` 6). Verify if registry indentation changes.
4. **Implementation plan** (spec-primary resolution):
   - **a. Active-spec detection**: MEMORY.md's Current State names the active spec if one exists (e.g., "Phase 12.5 — cleaning+extraction pre-flight" → `specs/cleaning-extraction/`). If Current State points to a feature with `specs/{feature}/implementation.md`, read that file FIRST — it carries authoritative per-feature task state, gate outcomes, metrics.
   - **b. Global dashboard fallback**: ALSO read `docs/IMPLEMENTATION-PLAN.md` if it exists — but ONLY the Status line + active-spec pointer (first ~20 lines). The global plan is a phase-level dashboard, not per-session narrative; deeper read wastes context on content the active spec already carries.
   - **c. Unscoped work**: if MEMORY.md Current State doesn't name an active spec (general infra, cross-feature refactor, tooling), read `docs/IMPLEMENTATION-PLAN.md` in full as the primary source.
   - Skip silently if neither spec nor global plan exists.
5. **Recent linked learning**: in auto-loaded MEMORY.md context, find the FIRST session-delta line under "## Current State" matching `^- \*\*Session \d+ \([0-9-]+\)\*\*:.*→\s*\`?([^\s\`]+\.md)\`?\s*$`. Resolve the captured path:
   - Tilde-prefixed (`~/.claude/learnings/foo.md` or `~/...`): expand `~` to `$HOME`.
   - Relative (`learnings/foo.md`): resolve against project root computed as `$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")`. The relative-path branch handles /catchup invoked from a subdirectory; /wrap writes the link from project root, consumer must match.
   - Absolute (`/...`): use as-is.

   Read the resolved file in the parallel batch alongside the other Step 1 reads. Skip silently if the regex doesn't match (greenfield project — no session-delta yet) or the resolved file doesn't exist (broken link — don't error /catchup).

   **Why this is in the default**: MEMORY.md's session-delta line auto-loads as TEXT (the path), not as content. Without this read, default /catchup knows the recent-session learning EXISTS but doesn't know what's IN it. Following the link is bounded (one file Read, parallel-batched) and closes the most common "I forgot to call /catchup deep" gap.

6. **State health**: measure MEMORY.md + CLAUDE.md current size. Shell one-liner (include in the parallel batch):
   ```bash
   MEM="$HOME/.claude/projects/$(pwd | sed 's|/|-|g')/memory/MEMORY.md"; \
   { [ -f "$MEM" ] && printf "MEMORY.md %sL/%sK " "$(wc -l < "$MEM")" "$(( $(wc -c < "$MEM") / 1024 ))"; } 2>/dev/null; \
   printf "CLAUDE.md %sL/%sK\n" "$(wc -l < ~/.claude/CLAUDE.md)" "$(( $(wc -c < ~/.claude/CLAUDE.md) / 1024 ))" 2>/dev/null || echo "State health: unavailable"
   ```
   - Slug construction: `pwd | sed 's|/|-|g'` produces the harness's projects-directory slug from the current working directory. This targets the LIVE MEMORY.md exactly — avoids the P42 "multiple slugs" mistake where `find ... -path "*basename*"` can match archived or cross-machine variants.
   - Soft thresholds (append "— consider `/prune-memory`" suffix if exceeded): MEMORY.md > 20 KB OR > 200 lines; CLAUDE.md > 50 KB OR > 400 lines. Advisory only — no action required.

## Step 2: Staleness Check

Compare:
- Latest `git log` commit date vs the Current State date in auto-loaded MEMORY.md
- The `git status -sb` branch line (Step 1 item 2): if it shows `[behind N]`, the upstream moved since last session — warn: "Local branch is N commits behind {upstream} — teammates pushed. Integrate (after committing/stashing your own work) before starting new work; branch any new feature branches off the fresh upstream."

If git is >1 day ahead of MEMORY.md's stated date, warn: "MEMORY.md may be stale — last wrap was {date} but commits exist from {date}. Relying on git log and implementation plan instead."

## Step 3: Present 5-line Summary

```
**Last session**: [1 sentence from session-registry `label` + `status`]
**Current state**: [Phase/task from MEMORY.md Current State + IMPLEMENTATION-PLAN]
**Next pending**: [session-registry `next` field verbatim]
**Recent files**: [2-3 most-changed files from git log]
**Watch out**: [CLAUDE.md mistake-table entries with Last date ≤3 days ago, or "None"]
**State health**: [from Step 1 item 5 — e.g., "MEMORY.md 97L/14K, CLAUDE.md 215L/35K" or "State health: unavailable"; append "— consider `/prune-memory`" if over soft threshold]
```

## Step 4 (only if `/catchup all`): Cross-project Table

Read session-registry.yaml once; for EACH project, grab only the top (most recent) session entry. Render:

```
**Other projects (last session only):**
| Project | Last Session | Date | Status |
|---------|-------------|------|--------|
| project-a | Intent filter tuning | 03-14 | done |
| project-b | Cloudflare deploy | 03-14 | blocked |
```

Flag any `blocked` status with a one-line blocker note. Max 5 projects.

## Step 5 (only if `/catchup deep`): Knowledge Enrichment

1. **Knowledge graph index**: read `~/desktop/knowledge-graph/graph-index.yaml` titles only. Surface 3-5 matches relevant to current task.
2. **Session learnings glob**: `ls ~/Desktop/*/learnings/*.md 2>/dev/null | tail -10` + `ls ~/.claude/projects/*/memory/learnings/*.md 2>/dev/null | tail -10` + `ls ~/.claude/learnings/*.md 2>/dev/null | tail -10` (third path covers user-global cross-project archives created by meta-sessions like CLAUDE.md/skill restructures). Read filenames only (dates + topics). Read the 2-3 most relevant file contents.

Skip either sub-step if the index is missing (no error — just move on).

## Step 6: Ask Direction

```
Continue from **{next pending task}**, or starting something new?
```

Wait for user confirmation. Do NOT start implementing.

## What NOT to Do

- Don't re-read MEMORY.md — it's auto-loaded via claudeMd. If you find yourself needing MEMORY.md detail that's NOT in the auto-loaded block, that means MEMORY.md was truncated (>200 lines) — fix MEMORY.md instead of reading it here.
- Don't re-read CLAUDE.md mistake table / principles — also auto-loaded. Cite them from context.
- Don't read the full session-registry.yaml — only the top entry for this project (and all projects' top entries if `all` flag).
- Don't create or modify any files — this is a read-only skill.
- Don't run `/wrapping-session` or any other skill — this is session START, not session END.
- Don't start coding or investigating before the user confirms direction.
- Don't add knowledge-graph or learnings enrichment without the `deep` flag — they're load-heavy and only needed in unfamiliar territory.
