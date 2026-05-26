---
name: hook-review
description: Audit ~/.claude/hooks/*.js for correctness, false-positive rate, and harness-version compatibility. Run fortnightly (every 2 weeks) — the cadence matches Claude Code's release pace, not the calendar. Triggers on "/hook-review", "audit hooks", "hooks healthy?", "review hooks".
---

# Skill: Hook Review

## Why this exists

Hooks layered on `~/.claude/settings.json` shape Claude's behavior silently — once installed, they fire on every relevant tool call across every session. Wrong-firing hooks compound: one false positive per session × 10 sessions/fortnight = 10 wasted overrides and a slow trust decay.

`/level-up` already audits upstream (what Claude Code shipped). **This skill audits downstream** (does our setup still work given what shipped).

## Cadence

**Every 2 weeks.** Not weekly (overkill — hooks themselves don't change session-to-session), not monthly (too slow given Claude Code releases 5x/week).

Last review: [update this line each run, e.g. "2026-05-18 — initial deploy of cd-persistence + skill-slug hooks"].
Next review due: [today + 14 days].

## Trigger
- Manual: user invokes `/hook-review`
- Calendar: every 2 weeks (track in MEMORY.md under "Claude Code OS Status")
- After-event: any `/level-up` report that flags a hook-system release note

## Steps

### Step 1: Inventory

List every active hook:
```bash
ls -la ~/.claude/hooks/*.js
```

Cross-reference against `~/.claude/settings.json` `hooks` block. Flag any hook file that is NOT registered (orphan) or any registration that points to a missing file.

### Step 2: Smoke-test each hook against known cases

Each hook file should have a documented smoke-test pattern. For the hooks shipped 2026-05-18:

**check-cd-persistence.js** (PreToolUse on Bash):
```bash
for cmd in 'cd scripts/X && cmd' 'cd /abs/path && cmd' 'cd ~ && cmd' 'cd -' '(cd scripts && cmd)' 'git -C scripts log'; do
  CLAUDE_TOOL_INPUT="{\"command\":\"$cmd\"}" node ~/.claude/hooks/check-cd-persistence.js >/dev/null 2>&1
  echo "$cmd → exit $? (expect: 2,0,0,0,0,0)"
done
```

**check-skill-slug.js** (PreToolUse on Skill):
```bash
for name in 'wrapping-session' 'wrap' '/level-up' 'nonexistent' 'compound-engineering:ce-commit'; do
  CLAUDE_TOOL_INPUT="{\"skill\":\"$name\"}" node ~/.claude/hooks/check-skill-slug.js >/dev/null 2>&1
  echo "$name → exit $? (expect: 0,2,0,2,0)"
done
```

**check-eval-first.js / check-anticheat.js**: harder to smoke-test (need a fake git repo). At minimum, sanity-check that the test-file glob doesn't false-match Rails view templates or other `*latest*` substrings.

### Step 3: Audit false-positive incidents in the last 2 weeks

Search session transcripts for hook fires:
```bash
# Adjust path to wherever transcripts live
grep -r "CD-PERSISTENCE\|SKILL-SLUG\|ANTI-CHEAT\|EVAL-FIRST" \
  ~/.claude/projects/*/sessions/ 2>/dev/null | head -50
```

For each fire:
- Was it a true positive (real violation, hook helped)?
- Or a false positive (legitimate pattern that should pass)?

If false-positive rate > 1 per 10 fires for any hook: revise detection logic or downgrade to warn-only.

### Step 4: Cross-reference with /level-up

Read the last 2 weeks of `~/.claude/scout-reports/*-level-up-report.md`. Look for:
- New hook event types (e.g. SessionEnd, SubagentStop) that existing hooks should adopt
- Permission-mode changes that affect when hooks fire
- New `continueOnBlock`-style options
- Postmortems naming hooks specifically

### Step 5: Update the mistake table

After the audit, if a hook is genuinely catching mistakes, increment that mistake row's "Last" date in CLAUDE.md without bumping the count (the hook prevented it). If a hook is silently passing things it shouldn't, that's a hidden recurrence — increment the count.

### Step 6: Report

Short verdict per hook:
- **CLEAN** — fired N times, all true positives, no changes needed
- **TUNE** — fire rate or false-positive rate suggests adjusting detection
- **RETIRE** — hook hasn't fired in 2 reviews; either the mistake is extinct or the detection is broken

Update the "Last review" line in this SKILL.md.

## Anti-patterns

- **Don't audit only by file count.** A hook that never fires is suspicious (either the mistake was extinct or the detector is broken). Investigate before assuming clean.
- **Don't add hooks during review.** The review is for what already exists. New hook proposals go to a separate session.
- **Don't skip transcript audit.** Hook code can pass syntax check and still be misfiring in production. Real session evidence is the only verification.

## Why fortnightly specifically

- Claude Code shipped 5 releases in 7 days (e.g. v2.1.139→v2.1.143, week of 2026-05-11). At that pace, hook semantics can drift within 2 weeks.
- User runs ~5 sessions/week. Fortnightly = ~10 sessions between audits — enough to surface patterns without burning weekly effort.
- `/level-up` covers harness upstream weekly; hook-review covers our downstream config every other week. Staggering avoids audit fatigue.
