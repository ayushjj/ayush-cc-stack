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

Last review: **2026-10-15** — on time. Inventory clean (17 registered; `check-skill-slug.js`
unregistered on purpose in b244f70, `git-sync-lock.js` is a CLI). Baseline had 2 red suites, and both
were stale tests, not broken hooks: override-reachability §9 inherited `CLAUDE_D_ENTRY_TIMING_WARN_ONLY=1`
from settings.json:6 (fix: `env -u`), and session-manifest still tested the inline push warn that b244f70
removed. All 11 suites + check-subagent-restore.test.sh are green after fixes. Read each suite's `RESULT:`
line for its count.

**Fixed this review (red → green, mutant proven):**
- `scanGitSegments` drops shell redirections, so `git add -A 2>/dev/null && git commit` no longer blinds
  the D-entry gate (d-entry §16). The S84 push-only copy of that rule was moved into it.
- `check-subagent-restore`: `stripQuotedRegions` blanks everything from the first `<<` to the end of the
  command, which made the guard FAIL-OPEN for `bash <<EOF`, `cat <<EOF | sh`, and any command after a
  heredoc. It also blocked report prose (11 of 40 live fires). It now blanks only heredoc bodies that are
  data, and treats escaped backticks as literal. Replay of the live fires: 11 prose fires pass, 30 real ones block.
- The ~/.claude push exemption (owner, 10-10) is now tested with a sibling-repo control.
- `allow_large` is pinned as NOT exempting the read-size gate (4n). The one live case was a true positive.

**Step 3: fires 10-01 → 10-15, control OK, every fire classified from its command.**
`check-review-gate` 150 fires after 10-04: **77% FP → TUNE.** Of those, 41 came from `2>&1` (fixed in
96cdfbf), 21 from a flag written in the same cell, 21 from data/media files classed as code
(classify-diff.js:440-455,508), and 14 from quoted text or a cwd fallback.
`check-cd-persistence` **89% FP → TUNE** (33 relative-after-absolute cd, :277-300).
`check-anticheat` **75% FP → TUNE** (`shapeOf` :213-229 needs an exact shape match).
`check-read-size` **97% FP → TUNE**: 34 headless `claude -p` judge workers that have no agent_id. Fix it
in the batch runner that launches them, not in this hook. `check-d-entry-timing` **CLEAN** (2 fires, both before
warn-only). `check-subagent-restore` **TUNE → tuned** (see above). It also produced 20 harmless
Gemfile.lock restores in lane worktrees: correct by rule, so counted as friction.
Latency: every hook's median is ≤160 ms. Max is d-entry at 265 ms, once, on a cold `~/.claude` add-all.
Step 3.5: Bash:Agent **8.4:1** for October (14.3 in Sep).
Step 4: level-up 10-12: `--debug` per-hook timing, `allow_large`, `onFailure:"block"` (not adopted).
Still open: settings.json `timeout` values are in seconds (3000 = 50 min).
Residual: `git push 2>&1 origin feat` (the `&` cuts the segment).

Next review due: **2026-10-29.**

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

Each hook file should have a documented smoke-test pattern. **Smoke via STDIN, never `CLAUDE_TOOL_INPUT` env** — the harness delivers hook input as JSON on stdin (`tool_input.command` / `tool_input.file_path` / `tool_input.skill`); the env var was never set by the harness, and env-injected smokes were exactly how six dead hooks looked "tested" (P72, fixed S45/S46). Env remains a legacy fallback only.

**check-cd-persistence.js** (PreToolUse on Bash):
```bash
for cmd in 'cd scripts/X && cmd' 'cd /abs/path && cmd' 'cd ~ && cmd' 'cd -' '(cd scripts && cmd)' 'git -C scripts log'; do
  printf '{"tool_input":{"command":"%s"}}' "$cmd" | node ~/.claude/hooks/check-cd-persistence.js >/dev/null 2>&1
  echo "$cmd → exit $? (expect: 2,0,0,0,0,0)"
done
```

**check-skill-slug.js** (PreToolUse on Skill):
```bash
for name in 'wrapping-session' 'wrap' '/level-up' 'nonexistent' 'compound-engineering:ce-commit'; do
  printf '{"tool_input":{"skill":"%s"}}' "$name" | node ~/.claude/hooks/check-skill-slug.js >/dev/null 2>&1
  echo "$name → exit $? (expect: 0,2,0,2,0)"
done
```

**`hooks/tests/false-positive-canary.sh` — RUN THIS EVERY REVIEW.** 49 bidirectional cases across
`check-cd-persistence`, `check-eval-first` and `branch-guard.sh`. It is the only suite that asserts what
a hook must **NOT** block, which is the half that was unspecified while three guards misfired for months.
Every section pairs MUST-BLOCK cases with MUST-PASS ones so a "fix" that merely weakens a detector fails
here instead of passing. It aborts on a LEAK SENTINEL if any escape valve reaches the child process —
treat that abort as "this suite did not run", never as a pass.

**check-eval-first.js / check-anticheat.js**: harder to smoke-test (need a fake git repo) — `hooks/tests/gate-hooks-canary.sh` (stdin-piped) is the canonical suite; run it whole.

> Case counts deliberately removed from this section 2026-08-07 (P74 — a count is a coordinate in
> time). Both suites grew well past their written figures: "14 cases" measured **119**, "35 cases"
> measured **63**. Let each suite's own `RESULT:` line own its number.

**session-manifest.js + revived stdin readers (S46 stack)**: `hooks/tests/session-manifest-canary.sh` covers record/stage/claim/prune, orphan valve, pathspec-commit index-pollution immunity, and the five revived readers (skill-slug, memory-size-gate, check-destructive, check-freeze, inline git-push warn) incl. mode-off silent-pass. `hooks/tests/wrap-mutex-race-test.sh` covers git-sync-lock.js + check-wrap-collision.js + the three-phase race (RED / GREEN / MANIFEST — co-mingling asserted 0 in MANIFEST). Run both whole; do not hand-roll env-var smokes for these.

**check-read-size.js (2026-09-08)**: `hooks/tests/read-size-canary.sh` — Read/Bash oversized-read gate, positive control + quote trap + valves + telemetry + no-hang. Run whole. Mutation-tested at build (5 mutants killed); re-run a mutant at review if the false-positive rate in `telemetry/read-size-gate.jsonl` looks low enough to be a dead gate.

> **`git-sync-lock.js` is a CLI, not a stdin hook** — `/wrap` Step 8 invokes it as
> `node git-sync-lock.js acquire|status|release`, and the race test drives it the same way. The
> stdin rule above governs PreToolUse hooks that receive `tool_input`; it does not apply here, and
> the race test's single `CLAUDE_TOOL_INPUT` line is a deliberate legacy-fallback assertion run with
> stdin emptied. Verified 2026-08-07 — `gate-hooks-canary.sh` carried a stale note naming this test
> as an env-smoke offender, which made this Step read as self-contradictory. That note is corrected;
> **the coverage claim above stands.** Baseline that day: 22/0 unit-smoke, mutex serialized 30/30.

### Step 3: Audit false-positive incidents in the last 2 weeks

```bash
python3 ~/.claude/evals/audit_hook_fires.py            # last 14 days
python3 ~/.claude/evals/audit_hook_fires.py --all      # whole corpus
```

**Exit 2 = `CONTROL FAILED`. Treat that as "this step did not run", never as "no fires."**

> ⚠️ **This step was PROSE until 2026-08-07 and it could not fail.** It grepped
> `~/.claude/projects/*/sessions/` — a directory that has never existed (transcripts are flat
> `.jsonl` at `~/.claude/projects/<slug>/`). It matched nothing, returned zero, and read as
> "no false-positive complaints" — which is what the 2026-07-04 review recorded as its verdict.
> Second defect in the same four lines: it grepped four marker strings and was therefore blind to
> eight hooks, including `check-review-gate.js`, the most-fired hook in the corpus (259 fires).
> Do not "simplify" this back to a grep. A text grep also counts *discussion* of a hook as a fire,
> so the naive fix trades a false zero for a false number — strictly worse. The script attributes
> fires by the hook path the **harness** emits, and carries a `--control` that exits non-zero when
> the detector is broken (P16: a deterministic rule belongs in code, not in a prompt).

**Read each fire's TRIGGERING COMMAND — the count alone is worse than useless.** Done for the first
time 2026-08-21, and it inverted the reading of the two busiest guards: `check-cd-persistence` showed
`37 fires (30 sessions)`, which looks like a healthy, load-bearing hook, and 84% of those fires were
wrong. A hook cannot be judged from the table this script prints.

The script attributes fires by hook path; to classify them, map each fire's `tool_use_id` back to the
`tool_use` block that triggered it and read the command. Then, per fire:
- True positive (real violation, hook helped)?
- False positive (legitimate pattern that should have passed)?

Two things that make the classification falsifiable rather than a vibe:
- **Re-derive the verdict from the trigger command, not from the hook's own message.** The message is
  the hook's opinion of what it saw; the command is the fact. Deriving both sides from the hook's
  output is the P72 trap in miniature.
- **Reproduce the suspected false positive directly against the hook**, ideally as a matched pair that
  differs in one character (`cd /abs` vs `cd "/abs"`). A pair that returns opposite exit codes is proof;
  a code read is a hypothesis.

If false-positive rate > 1 per 10 fires for any hook: revise detection logic or downgrade to warn-only.

**Do not feed the script's "on disk but NO fire observed" list into Step 6's RETIRE verdict.**
Observers and env-gated guards succeed silently and cannot appear in the fire table; absence of
evidence is not evidence of absence. Judge those with `hooks/tests/*-canary.sh`.

### Step 3.5: Measure whether the configured behaviour actually HAPPENED

Two standing configuration changes exist purely to alter behaviour, and both are invisible
unless measured. Run both instruments every review:

```bash
# The existence check is NOT ceremony. A missing script makes python3 exit 2 — the SAME
# code these instruments use for CONTROL FAILED — so a rename would be read as "control
# failed, step did not run", recorded as benign, and the instrument would be silently
# unfireable again. That is the exact bug this step exists to fix, reconstituted inside
# the fix. Exit 3 is reserved here for "the contract is broken", never for a bad result.
for f in measure_tool_delegation measure_review_tiers; do
  test -f ~/.claude/evals/$f.py || { echo "INSTRUMENT MISSING: $f.py — CONTRACT BREAK, not a control failure"; exit 3; }
done

python3 ~/.claude/evals/measure_tool_delegation.py --since 2026-08-26   # Bash:Agent, CLEAN window only
python3 ~/.claude/evals/measure_review_tiers.py --canonical-only        # /review tier ladder
```

**Use `--since 2026-08-26`, not `--all`.** The tool buckets by calendar month, so the
`2026-08` row of an `--all` run is disease *and* diagnosis in one number and cannot be
read apart. **Minimum-sessions floor: below ~30 sessions in the window, record
`NOT-YET-MEASURABLE` and compare nothing.** The script's `--control` only checks that the
Bash count is non-zero, so a 3-session window passes control and emits a ratio that reads
like a verdict.

**`measure_tool_delegation.py`** tests the two standing-delegation lines in `CLAUDE.md`
§ Environment. They exist because the harness binary ships `Do not call the AgentTool
unless the user requested it`, which drove the Bash:Agent ratio from 16.9:1 (July) to
31.0:1 (August) — same job, 31x the context. **The clean measurement window BEGINS
2026-08-25**: S66/S67 spent Agent calls studying the problem, so any window straddling
that date mixes the disease with the diagnosis and is uninterpretable. Compare the clean
window against **July's 16.9:1**, the last uncontaminated full month — NOT against August,
which straddles the boundary. If the clean-window ratio has not fallen well below August's
figure once the sample is large enough to read, the CLAUDE.md lines are not working and the
fix is a different mechanism, not stronger wording (P16: third tuning ⇒ escalate to code).

**`measure_review_tiers.py`** owns the `/review` tier distribution. The rule, stated as it
is actually enforced: **a CURRENT-STATE claim must be a digit-free pointer to this script; a
DATED HISTORICAL snapshot used to justify a code decision may carry its digits, and must
carry its date and source.** Several sites legitimately do the latter — they are frozen
evidence for why a branch exists, and stripping them is the "rules whose reasons were
sanitised away" hazard. The earlier phrasing here ("sole owner… do not copy its output into
any other file") was stricter than the practice shipped alongside it, and a literal reader
would either delete load-bearing justification or learn to ignore the rule. Historical rows are a record of what HAPPENED;
current classifier behaviour is asserted by `hooks/tests/gate-hooks-canary.sh` §6/§6.5.

**Both scripts exit 2 on `CONTROL FAILED`. Treat that as "this step did not run", never as
"nothing changed"** — the same rule as Step 3.

> ⚠️ **Why this step exists.** Until 2026-08-26 neither instrument was wired to any cadence,
> while `audit_hook_fires.py` at least had a caller — Step 3 of this file. (An earlier draft of
> this note also credited it with a dated row in `governance.md`; that was wrong and is corrected
> here — the governance cadence table is quarterly-only and holds no hook-review row. The date
> for this review lives in exactly one place, the `Next review due:` line above, and that
> single-sourcing is deliberate.)
> A configuration change made in order to be measured, with nothing that re-runs the
> measurement, is unfalsifiable by construction (P72) — the S65/S66 "unfireable gate" shape.
> **This step SHRINKS that hole; it does not close it.** Zero callers became one caller with
> a date, but that caller is a manually-invoked fortnightly skill, so this is still a check
> someone must remember to run. `evals/measure_review_tiers.py` carries the same admission in
> its own docstring about the canary it defers to — keep both honest, or the next reader
> inherits a false sense of coverage.
> If either script is ever deleted or renamed, delete this step in the same commit rather
> than leaving an instruction pointing at nothing.

### Step 4: Cross-reference with /level-up

Read the last 2 weeks of `~/.claude/scout-reports/*-level-up-report.md`. Look for:
- New hook event types (e.g. SessionEnd, SubagentStop) that existing hooks should adopt
- Permission-mode changes that affect when hooks fire
- New `continueOnBlock`-style options
- Postmortems naming hooks specifically

### Step 5: Update the mistake table

After the audit, if a hook is genuinely catching mistakes, update that row's `Last` date in `~/.claude/evals/mistake-ledger.md` without bumping `Times` (the hook prevented it). If a hook is silently passing things it shouldn't, that's a hidden recurrence — increment the count.

### Step 6: Report

Short verdict per hook:
- **CLEAN** — fired N times, all true positives, no changes needed
- **TUNE** — fire rate or false-positive rate suggests adjusting detection
- **RETIRE** — no fire in 2 reviews AND its canary proves it can still fire (the mistake is extinct). If the canary cannot make it fire, the detector is broken: that is TUNE, not RETIRE. Observers and env-gated guards never appear in the fire table — judge them by canary only (Step 3).

Update the "Last review" line in this SKILL.md.

## Anti-patterns

- **Don't audit only by file count.** A hook that never fires is suspicious (either the mistake was extinct or the detector is broken). Investigate before assuming clean.
- **Don't add hooks during review.** The review is for what already exists. New hook proposals go to a separate session.
- **Don't skip transcript audit.** Hook code can pass syntax check and still be misfiring in production. Real session evidence is the only verification.

## Why fortnightly specifically

- Claude Code shipped 5 releases in 7 days (e.g. v2.1.139→v2.1.143, week of 2026-05-11). At that pace, hook semantics can drift within 2 weeks.
- User runs ~5 sessions/week. Fortnightly = ~10 sessions between audits — enough to surface patterns without burning weekly effort.
- `/level-up` covers harness upstream weekly; hook-review covers our downstream config every other week. Staggering avoids audit fatigue.
