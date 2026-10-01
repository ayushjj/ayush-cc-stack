---
name: catchup
description: Load prior session context to continue work seamlessly. Reads git log, last-session-registry entry, and IMPLEMENTATION-PLAN.md (if present). Does NOT re-read MEMORY.md or CLAUDE.md — those are auto-loaded via claudeMd injection. Also settles which branch the session works on: gathers branch/PR facts up front, then after the user states intent, proposes staying or cutting a fresh branch off the integration base. Triggers on "catch up", "catch me up", "continue where we left off", "/catchup".
preconditions:
  - Starting a new session that continues prior work
  - MEMORY.md auto-loaded via claudeMd (the harness handles this before the skill runs)
effort: low
---

# Catching Up

**Design principle**: COMPLEMENT, don't REPEAT. MEMORY.md and CLAUDE.md are already injected into every session's context as `claudeMd`. Re-reading them in this skill is pure duplication — the skill's job is to surface what's NOT already loaded.

What's auto-loaded (don't re-read): MEMORY.md, CLAUDE.md, git branch/status, current date. The mistake ledger and principles index are NOT auto-loaded (they live in `~/.claude/evals/mistake-ledger.md` and `~/.claude/principles/INDEX.md`).
What's NOT auto-loaded (this skill's job): recent commit messages, latest session-registry entry, IMPLEMENTATION-PLAN.md, and the learning file linked from MEMORY.md's most-recent session-delta line (the path auto-loads as text; the file's content does not).

## Flags

- **default `/catchup`** — intra-project only. Minimal delta reads, ~5-8K tokens. Use every session start.
- **`/catchup all`** — adds cross-project session-registry table. Use when explicitly switching between projects or suspecting an upstream blocker elsewhere.
- **`/catchup deep`** — adds [redacted] index scan + learnings/ glob enrichment. Use when starting work in unfamiliar territory or after a long absence from the project.

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

7. **PR-status drift check** (closes the "memory says awaiting, PR is actually merged" gap — P42 resolved-status-pointer-drift). MEMORY.md is auto-loaded, so its text is already in context; the failure mode is *trusting* a status word instead of *verifying* it. From the auto-loaded MEMORY.md, extract every PR number (`#\d+`) sitting near a live-status word (`awaiting|pending|open|in review|in-review|review|blocked|WIP`). For each such number, verify against the tracker by key — works even when the PR was merged in a *different worktree/branch* this repo's `git log` never sees:
   ```bash
   for n in 580 581; do gh pr view "$n" --json number,state,mergedAt,baseRefName 2>/dev/null; done
   ```
   (Substitute the actual extracted numbers; if `gh` is unavailable/offline, skip silently.) Flag any whose real `state` is `MERGED`/`CLOSED` while memory calls them live — that's drift to surface in Step 3 and, if found, to **fix in MEMORY.md before presenting** (the stale pointer otherwise wins in-context next session too). Bounded: a handful of `gh` calls keyed on PR number, no full-repo scan. Skip the whole step if MEMORY.md names no live-status PRs.

8. **Branch facts** (feeds the Step 6 branch decision — gather only, decide nothing here). The branch is a property of the *folder*, not the session: a finished branch stays checked out until something switches it, so every new session in that folder silently inherits it. These four facts are what make the inheritance visible:
   ```bash
   git rev-parse --git-dir >/dev/null 2>&1 || { echo 'not-a-git-repo'; exit 0; }
   b=$(git branch --show-current 2>/dev/null)
   printf 'branch: %s\n' "${b:-DETACHED-HEAD}"
   printf 'dirty_tracked: %s\n' "$(git status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')"
   printf 'ahead: %s\n' "$(git rev-list --count '@{u}'..HEAD 2>/dev/null || echo no-upstream)"
   printf 'track: %s\n' "$(git for-each-ref --format='%(upstream:track)' "refs/heads/$b" 2>/dev/null)"
   printf 'pr: %s\n' "$(gh pr list --head "$b" --state all --json number,state --limit 1 2>/dev/null || echo gh-unavailable)"
   ```
   - `track: [gone]` means the remote branch was deleted — the branch is dead even if `gh` is offline. Verified 2026-08-12: a merged branch reports `[gone]` + `MERGED`, a live one reports empty + `OPEN`, so the two cases are genuinely distinguishable (not a check that returns the same answer either way).
   - `--untracked-files=no` deliberately ignores stray untracked files (screenshots, scratch files). Untracked junk is not work-in-progress and must not pin you to a finished branch.
   - If `gh` is unavailable, fall back to `track` alone. If the output is `not-a-git-repo`, omit the Step 3 **Branch** line and skip Step 6b entirely — do not guess, and do not report a branch that does not exist.

## Step 2: Staleness Check

Compare:
- Latest `git log` commit date vs the Current State date in auto-loaded MEMORY.md
- The `git status -sb` branch line (Step 1 item 2): if it shows `[behind N]`, the upstream moved since last session — warn: "Local branch is N commits behind {upstream} — teammates pushed. Integrate (after committing/stashing your own work) before starting new work; branch any new feature branches off the fresh upstream."

If git is >1 day ahead of MEMORY.md's stated date, warn: "MEMORY.md may be stale — last wrap was {date} but commits exist from {date}. Relying on git log and implementation plan instead."

**Cadence nudge** (advisory, never blocks — include in the Step 1 parallel batch): checks all six
maintenance skills — `/automate-me`, `/level-up`, `/hook-review`, `/skill-audit`, `/prune-memory`,
`/publish-stack` — plus **model-config drift** (the CLAUDE.md `Model allocation` rule vs effective
settings, S76). Prints nothing when everything is current.
```bash
node "$HOME/.claude/skills/catchup/scripts/cadence-check.js"
```
Each skill keeps the date surface it already owns (state YAML / its own `Next review due:` line /
the `governance.md` cadence table) — deliberately NOT a central date file, because recording one
date twice is what cost 20 days of drift in S62. A source that cannot be read prints
`CANNOT CHECK` rather than going quiet: silence must mean "nothing due", never "reader broken"
(S64, `check-eval-first` fail-open). Canary: `scripts/cadence-check.test.sh` (19 bidirectional
cases + leak sentinel; t18 runs the LIVE CLAUDE.md rule line through the parser).

Surface every line it prints in the Step 3 summary (see **Cadence** line). Advisory only.

## Step 3: Present Summary

```
**Last session**: [1 sentence from session-registry `label` + `status`]
**Current state**: [Phase/task from MEMORY.md Current State + IMPLEMENTATION-PLAN]
**Next pending**: [session-registry `next` field verbatim]
**Branch**: [from Step 1 item 8 — `{branch}` + state in plain words, e.g. "`fix/exports-stock-compact-columns` — PR #787 open, clean tree" or "`add-brand-spec` — PR #490 MERGED, remote deleted (dead branch)"]
**Recent files**: [2-3 most-changed files from git log]
**Watch out**: [rows in `~/.claude/evals/mistake-ledger.md` whose `Last` date is ≤3 days ago (read the file — it is not auto-loaded), or "None"]
**State health**: [from Step 1 item 5 — e.g., "MEMORY.md 97L/14K, CLAUDE.md 215L/35K" or "State health: unavailable"; append "— consider `/prune-memory`" if over soft threshold]
**Cadence**: [every line the Step 2 cadence-check printed, one per row; omit this line entirely if it printed nothing]
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

1. **Knowledge graph index**: read `~/dev/[redacted]/graph-index.yaml` titles only. Surface 3-5 matches relevant to current task.
2. **Session learnings glob**: `ls ~/Desktop/*/learnings/*.md 2>/dev/null | tail -10` + `ls ~/dev/*/learnings/*.md 2>/dev/null | tail -10` + `ls ~/.claude/projects/*/memory/learnings/*.md 2>/dev/null | tail -10` + `ls ~/.claude/learnings/*.md 2>/dev/null | tail -10` (covers both legacy `~/Desktop/*` and migrated `~/dev/*` projects, plus user-global cross-project archives from meta-sessions like CLAUDE.md/skill restructures). Read filenames only (dates + topics). Read the 2-3 most relevant file contents.

If a sub-step's source is missing, emit one line — `skipped: [redacted] index (path missing)` — do NOT skip silently (a silently-missing path hid a dead `~/desktop` reference for weeks; P57).

## Step 6: Ask Direction, Then Settle the Branch

```
Recommended: **{next pending task}** — {one-line reason: why this is the highest-leverage move now}.
Name something else to redirect.
```

State a recommendation, not a menu (S76: a yes/no ending produced a bare "yes" in 41 sessions — the question carried no information the recommendation did not). Then wait for the user's reply. Do NOT start implementing.

### Step 6b: Branch decision (after intent is known, before any work)

The branch decision is impossible before this point — it requires comparing the branch against *intent*, and intent does not exist until the user answers Step 6. Apply the Step 1 item 8 facts against this table, in order. First match wins:

| Condition | Action | Ask? |
|---|---|---|
| `dirty_tracked > 0` OR `ahead > 0` | **Stay.** Uncommitted or unpushed work always pins the branch — never move the user off work in progress. | No |
| `track: [gone]` OR PR state is `MERGED`/`CLOSED` | **Cut fresh.** The branch is finished; continuing on it is always wrong. | Confirm name only |
| PR `OPEN` **and** stated intent is the same work | **Stay.** This is the multi-session feature case — silent by design. | No |
| PR `OPEN` **but** stated intent is different work | **Cut fresh.** The open PR keeps its branch; new work does not belong on it. | Confirm name only |
| No PR, no upstream, clean tree | **Cut fresh** if intent is new work; stay if intent continues this branch. | No |
| Facts unavailable (`gh-unavailable` + empty `track`), or intent genuinely ambiguous | **Ask**, two options, one line. Do not guess. | Yes |

Rows 1, 3 and 5 are silent — the common cases cost the user nothing.

**Cutting fresh** ([redacted] and any repo whose integration branch is `master`):

```bash
git checkout -b <new-branch> origin/master
```

Cut from `origin/master`, never local `master` — the Step 1.0 fetch refreshed the mirror, so this starts from what is actually on the server. Substitute the repo's real base if it is not `master`.

**Propose, do not switch.** State the branch you intend to create and the base, then wait for a yes. Two reasons: it keeps the user aware of which branch they are on (the awareness is the point — automating it away recreates the original problem in a new form), and `git checkout` touches the working tree, which is otherwise outside this skill's remit.

**Never** switch branches while `dirty_tracked > 0` — row 1 already prevents this, and it is the one row with a data-loss failure mode. If the user overrides and asks to switch anyway, commit or stash first and say which you did.

## What NOT to Do

- Don't re-read MEMORY.md — it's auto-loaded via claudeMd. If you find yourself needing MEMORY.md detail that's NOT in the auto-loaded block, that means MEMORY.md was truncated (>200 lines) — fix MEMORY.md instead of reading it here.
- Don't re-read CLAUDE.md — also auto-loaded. Cite it from context.
- Don't read the full session-registry.yaml — only the top entry for this project (and all projects' top entries if `all` flag).
- Don't create or modify files beyond three named exceptions: fixing a drifted PR status in MEMORY.md (Step 1 item 7), creating a missing `telemetry/` directory (CLAUDE.md § Environment), and the Step 6b branch checkout — which needs the user's yes. Reading facts is unconditional; changing the working tree needs a yes.
- Don't switch branches silently, and don't switch at all with uncommitted tracked changes (Step 6b row 1).
- Don't run `/wrapping-session` or any other skill — this is session START, not session END.
- Don't start coding or investigating before the user confirms direction.
- Don't add [redacted] or learnings enrichment without the `deep` flag — they're load-heavy and only needed in unfamiliar territory.
