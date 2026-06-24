---
name: prune-memory
description: Deliberate, unhurried archival pass on MEMORY.md and CLAUDE.md. Moves stale entries to archives (move-not-delete). Use when /catchup nudges, or when entries feel accreted. Never runs during /wrap. Triggers on '/prune-memory', 'prune memory', 'compress MEMORY'.
preconditions:
  - MEMORY.md or CLAUDE.md has grown past comfortable size
  - User has time for unhurried archive work (NOT wrap-time)
---

# Pruning Memory

Deliberate compression pass. Archive-not-delete, mirroring the established precedent in `session-registry-archive.yaml`, `archived-principles.md`, `MEMORY-archive.md`.

**This skill does NOT run during `/wrap`.** Wrap is time-pressured; prune is archaeology.

## Step 1: Read Current State (parallel)

Read in one parallel batch:

1. **MEMORY.md** — the project-local one: `~/.claude/projects/*/memory/MEMORY.md`. Full file.
2. **CLAUDE.md Mistake Patterns table** — `~/.claude/CLAUDE.md`, just the section.
3. **CLAUDE.md Principles** — same file, just the section.
4. **Current sizes** — `wc -l` and `wc -c` on both files for before/after baseline.

## Step 2: Identify Candidates

Candidate criteria (conservative — when in doubt, keep):

**MEMORY.md Session-delta lines**:
- Sessions older than the two most-recent, IF the `Current State` section already names the currently-active phase/task (i.e., the older session-delta isn't load-bearing for next-session continuity)
- Historical sections (e.g., "AI-Native Blueprint review X", "RFC v1→v2 pass Y") that have full narratives already in `learnings/` files

**CLAUDE.md Mistake rows**:
- Rows with `Times: 1x` AND `Last` date > 30 days ago (recalibrated from 90d on 2026-05-31 — velocity-adjusted; see governance.md § Table-management policy. Eviction *age* only; prune *cadence* stays 90d.)
- Rows whose content is fully subsumed by a Principle (e.g., row says "X" and Principle P{N} says the same with more generality)

**CLAUDE.md Principles**:
- Principles NOT referenced in any `learnings/*.md` in the last 60 days (check: `grep -r "P{N}" ~/.claude/projects/*/memory/learnings/` and `git log --grep="P{N}" --since="60 days ago" --oneline`)
- Principles that are domain-specific leaked into the global file (should be on project-level CLAUDE.md instead)

**When in doubt, keep.** This skill errs on preservation — the whole point of move-not-delete is that "maybe-stale" entries survive in the archive.

## Step 3: Present Candidate List

Show user the candidates as a table:

```
| # | File | Entry (1-line summary) | Why candidate | → Archive destination |
|---|------|------------------------|---------------|----------------------|
| 1 | MEMORY.md | Session N (YYYY-MM-DD) entry | Not in Current State's 2 most-recent window | MEMORY-archive.md |
| 2 | CLAUDE.md Mistake | "Deployed fix without verifying live endpoint" (1x, 2026-03-06) | 1x AND >30 days old | MEMORY-archive.md (new section for mistakes) or archived-principles.md |
| 3 | CLAUDE.md P15 | "Automated tests primary, manual supplementary" | Not grep-referenced in learnings or commits in 60 days | archived-principles.md |
```

Wait for user confirmation. Do NOT auto-execute.

Accept confirmations per-row (`keep 3, prune 1 and 2`) or all (`confirm all`).

## Step 4: Archive (Move, Not Delete)

For each approved candidate:

1. Append to destination archive file with a header stamp:
   ```
   ### Archived 2026-04-23 (pruned from MEMORY.md)
   - **Session N (YYYY-MM-DD)**: {content verbatim from source}
   ```
2. Remove entry from source file (precise Edit — single occurrence).
3. If the destination file doesn't exist yet, create it with a brief header explaining its purpose (mirror the pattern of existing archive files).

## Step 5: Update Prune Timestamp

Update the `Last full first-principles prune: YYYY-MM-DD. Next quarterly review: YYYY-MM-DD.` HTML comment at the top of `~/.claude/CLAUDE.md` to today's date + 90 days out. Keeps "quarterly" from becoming a word instead of a comparable timestamp.

## Step 6: Commit

One commit at the end:

```
Prune {date}: archived N MEMORY.md entries, M CLAUDE.md entries

- MEMORY.md: {before_lines}L/{before_kb}K → {after_lines}L/{after_kb}K
- CLAUDE.md: {before_lines}L/{before_kb}K → {after_lines}L/{after_kb}K
- Archive destinations: MEMORY-archive.md, archived-principles.md
```

## Step 7: Report to User

```
MEMORY.md:   97L/14K → 72L/10K  (-25L, -4K)
CLAUDE.md:  215L/34K → 198L/30K  (-17L, -4K)
Archived:   3 Session-deltas to MEMORY-archive.md
            2 mistake rows to MEMORY-archive.md
            1 principle (P15) to archived-principles.md
```

## What NOT to Do

- **Do NOT delete entries.** Archive files are authoritative history. Cost of archival is ~1-5 KB in a never-auto-loaded file; cost of deletion is losing retrospective analytical value.
- **Do NOT run during `/wrap`.** Wrap's time pressure would force hasty decisions.
- **Do NOT prune entries referenced by recent work.** Grep `learnings/` + `git log --grep=` for the principle/mistake identifier before flagging. If it's been touched in the last 30 days, it's load-bearing.
- **Do NOT compress-by-rewriting** entries you plan to archive. Archive them verbatim — the archive's whole value is that it preserves the original context. Rewriting on archive = silent data loss.
- **Do NOT remove `(last prune)` timestamp** from CLAUDE.md header — update it instead.

## When to Invoke

- `/catchup` State-health line shows MEMORY.md > 20 KB or > 200 lines
- `/catchup` State-health line shows CLAUDE.md > 50 KB or > 400 lines
- Quarterly scheduled review (check `(last prune: YYYY-MM-DD)` comment in CLAUDE.md header — if > 90 days old, run)
- A `memory-size-gate` hook stderr warning surfaced during a session and you want to address it deliberately

## Step 8: Public-stack drift check (P57 trigger — runs at the END, after Step 7)

The public stack snapshot shares this quarterly cadence (governance.md § Quarterly cadences, decisions D5). Its cadence was previously wired to nothing — a P57 silent-lapse. Bake the check in here so it fires by invocation, not memory. **Graceful no-op**: if the publish target isn't configured, this whole block does nothing — `/prune-memory` is load-bearing and must never error on a missing publish config.

```bash
CFG="$HOME/.claude/.publish-stack-target"
if [ -f "$CFG" ]; then
  TGT=$(grep -vE '^#|^[[:space:]]*$' "$CFG" | sed -n 1p)   # first non-comment line = repo path
  if [ -n "$TGT" ] && [ -d "$TGT/.git" ]; then
    SINCE=$(git -C "$TGT" log -1 --format=%cd --date=short 2>/dev/null)
    DRIFT=$(git -C "$HOME/.claude" log --since="$SINCE" --oneline \
              -- CLAUDE.md governance.md principles/ hooks/ skills/ 2>/dev/null | wc -l | tr -d ' ')
    if [ "${DRIFT:-0}" -gt 0 ]; then
      echo "📦 Public stack drift: ${DRIFT} commit(s) to shareable files since last snapshot (${SINCE})."
      echo "   Run /publish-stack to prepare the next quarterly snapshot (decisions D5)."
    else
      echo "Public stack: no shareable drift since ${SINCE} — skip snapshot (D5 forbids no-ops)."
    fi
  fi
fi
```

The nudge is the correct seam (not an auto-run): the publish itself is human-gated (D7 — user runs the final sweep + push). Do NOT invoke `/publish-stack` automatically from here.
