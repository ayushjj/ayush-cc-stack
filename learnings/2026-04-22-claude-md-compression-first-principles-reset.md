# Case Study: CLAUDE.md Compression — First-Principles Reset

## Context

A review of `~/.claude/CLAUDE.md` from first principles after observing verbosity in recent sessions. Prior work established a 4-test admission framework (in an earlier prune) and a tightening pass (a few days later), but +170% byte growth in the 9 days following the prune meant the framework wasn't self-enforcing. Session goal evolved through two user pullbacks from "delete + compress" to "compress only + derive everything from first principles."

## What Worked

- **Delta accounting before any edit.** 178 → 209 lines (+17%) vs 15.3KB → 41.4KB (+170%). The disparity localized the problem: growth happened *inside* existing lines, not by adding lines. Compression target narrowed to two places — one mistake row (~50% of growth) + 11 un-tightened post-prune principles (~60% of growth) — instead of scanning all 209 lines.
- **Sample-first execution after two pullbacks.** Compressed one principle (220 → 92 words, −58%) + one sub-incident inside a heavily-loaded row (20 → 13 words) for the user to verify the pattern before batching the rest. File went from 41,410 → 40,778 bytes on just those two edits.
- **Backup before any edit** at `~/.claude/backups/CLAUDE.md.pre-prune-<date>`. Rollback = `cp` restore.
- **First-principles re-derivation when the user pulled back.** Named what CLAUDE.md *is* (attention prior loaded every session; two costs — token × session length, and attention × salience-dilution-of-neighbors), what it's *for* (necessary + operationalizable + minimal content), and from those, how to compress (keep agent-used elements, cut agent-unused decoration).

## What Didn't Work

- **Initial framing optimized for symptoms, not root cause.** Proposed "cap at 80 words / 60 words" without deriving from what the artifact is supposed to contain. User pulled back: *"deleting is easy, but understanding the root cause and fixing things are difficult."*
- **Applied "operationalizable" too narrowly.** Read it as "has a trigger → action pair," which flagged the Quality Posture quote and "What Frustrates Me" as deletable. Missed that **dispositional frames** are operationalizable too — they tilt value-weighting across many small decisions the user hasn't individually codified. User corrected: those are philosophical reminders of what matters.
- **Two aborted attempts** before grounding in first principles. Both interrupted mid-tool-call. Cost was context tax without forward progress.

## Key Insight

**Compression ≠ deletion.** Hard-earned content sits inside prose even when the prose looks narrative. The compression rule, derived from the objective:

- **Keep** what the agent uses at point-of-use: recognition trigger + action + one concrete example stripped of temporal metadata + detection pattern + applies-to scope.
- **Cut** what it doesn't: dates, "Session N", "Phase X", metrics about the original catch ("caught 5 self-distortions"), narrative connective tissue ("fourth recurrence same day"), meta-navigation ("extends P47") unless the connection changes the action.

**Dispositional frames are operationalizable through value-weighting, not triggers** — they're load-bearing by a different mechanism than if-then rules. Quality Posture quotes, "What Frustrates Me", Diagnostic Posture's ban list — all shape many small decisions without firing on specific triggers. Never propose their deletion on "no trigger-action pair" grounds.

**Corollary: the governor must live at write-path, not retrospective prune.** An earlier learning already predicted this ("compression without a governor guarantees regrowth at the same rate"). Addition rate outpaces compression rate whenever the three-test isn't applied at the moment of writing. Fix = shape-check in `wrapping-session` Step 2b. Not installed this session — deferred to the next-session batch.

## Files Changed

- `~/.claude/CLAUDE.md` — 2 sample compressions (one principle + one sub-incident inside a heavily-loaded mistake row)
- A project-level feedback memory documenting the rule: never delete, derive from first principles, dispositional frames count as operationalizable
- `~/.claude/backups/CLAUDE.md.pre-prune-<date>` — rollback snapshot (byte-identical to pre-session state)

## Metrics

- **Before**: 209 lines / 41,410 bytes / ~6,370 words (estimated)
- **After samples (this session)**: 209 lines / 40,778 bytes (−632 bytes from 2 small edits)
- **Projected after full batch**: ~205 lines / ~25,000 bytes (−40% from the bloated state, ~+60% vs the earlier baseline — correct, because most of the post-prune principles earn their space; the bloat is in *how* they were written, not *that* they exist)

## Applies To Future Sessions

- Any prune or compression pass on attention-prior documents (CLAUDE.md, MEMORY.md, global rules, skill SKILL.md files).
- Any time a user says "review from first principles" — **always derive what the artifact is supposed to contain before applying any rule about what it shouldn't.** Don't start from symptom caps.
- Any deletion proposal from a hard-earned document — name the specific agent behavior that would change without the line. "Nothing at point-of-use" → compression candidate. "Shapes many decisions through disposition / provides recognition cue" → keep; compress only narrative wrapping.

## Maps to public CLAUDE.md

- Mistake-table row: "Compressed growth-prone persistent file without growth-rate governor — caught only in user post-review."
- The "Adding to This File" four-test admission framework (necessary + operationalizable + minimal + firing-evidence)
- The three-tier shape (T1 trigger / T2 body / T3 detail externalization) referenced throughout the Principles section
- Quality Posture quote at the head of CLAUDE.md — defended as dispositional-and-operationalizable in this learning
