# Case Study: CLAUDE.md Governance Restructure (3 Moves)

## What Worked

- **Phase 0 pre-flight grep against skill files (read-only, in plan mode) caught a P51 violation before any edit.** Original Move 3 proposed removing `Times` and `Last` columns from the mistake table. Grepping `~/.claude/skills/{wrapping-session,catchup,prune-memory,review-plan}/SKILL.md` surfaced 8 contract dependencies — including `/prune-memory` SKILL.md ("1x AND >90 days old" eviction reads `Times`) and `/catchup` SKILL.md ("entries with Last date ≤3 days ago" surface reads `Last`). Removing those columns silently breaks two skills. Caught by `/review-plan` Dim 4, but only AFTER the plan was drafted; running the grep BEFORE drafting would have shaped Move 3 differently from the start.

- **First `/review-plan` verdict was REVISE — and it was right.** The first plan accumulated 7 unverified assumptions across Dims 1-2-4-5-6 that compounded into two systemic risk clusters. Revising with verified Phase 0 findings closed all 7. Re-review on the revised plan: APPROVE. Time investment in `/review-plan`: ~3 min. Damage prevented: silent skill breakage + mis-archived sub-incidents.

- **HTML-comment alternative considered and explicitly rejected with rationale, not silently dropped.** Line 1 of `~/.claude/CLAUDE.md` already uses `<!-- ... -->` for governance metadata explicitly noted as "stripped before injection into context." Could have been a one-file alternative to the governance.md split. Rejected because: discipline burden on writer (must remember to wrap each addition); separate file enforces separation by structure. Documented in plan + governance.md so the next restructure doesn't re-derive.

- **Sub-incident routing by project of origin.** Re-reading the 14 sub-incidents in a heavily-loaded mistake row carefully: 8 from one project, 2 from another, 4 meta. Original plan assumed all 14 were from the primary project and would have mis-filed cross-project content. Re-classification routed everything to `~/.claude/learnings/` (cross-project archive). Hard-won content preserved verbatim per "Compression ≠ deletion."

## What Didn't Work

- **Initial plan asserted skill non-coupling from inference, not from grep.** The first plan said "skill files MAY parse CLAUDE.md by section heading" but didn't verify. Forward review approved. `/review-plan` Dim 4 flagged it as a P42 violation (asserting state without reading). The fix was simply: actually grep the skill files. 5 seconds of work that the original plan skipped because it felt like setup, not core work.

- **Line-count target in plan was miscalibrated.** Forecast: "global drops from 241 toward 170-190 lines after collapse." Actual: 241 → 252 lines (+11). Why: the heavily-loaded mistake row was a single markdown table row (~3,800 words, 1 line); collapsing reduced word count ~98% but line count by 0. The +11 came from inserting the three-tier shape table (legitimate structural addition). Token tax dropped dramatically; the line-count metric was the wrong proxy. Aggregate-metric forecast in restructure plans must decompose to the unit being changed (line vs row vs token vs word).

## Key Insight

**Governance changes to auto-loaded files (`~/.claude/CLAUDE.md`, per-project MEMORY.md, anything in the `claudeMd` injection set) need a Phase 0 step that reads the consuming skill files BEFORE the plan is drafted.** P51 (paired-semantics drift) is invisible to forward review — both sides look internally consistent; the gap carries the bug. The recognition trigger is: any plan that proposes touching the *structure* (not just content) of `~/.claude/CLAUDE.md` — column changes, heading renames, section-removals — is a P51 candidate by default. Pre-flight grep targets: section-name literals, column-name parses, principle-ID grep, HTML-comment timestamp updates, verbatim phrase quotes.

This is a specific operationalization of P40 (forward review can't see blind spots) for the governance-restructure case. The recipe lives in `~/.claude/governance.md` § Skill-coupling contracts as a maintained artifact — future restructure plans should READ from it, not re-derive.

**Secondary insight**: the audience-split fix (agent-facing vs maintainer-facing files) is a deeper structural improvement than any compression cap. Compression caps treat the SYMPTOM (file getting too long) by limiting growth. Audience splits treat the CAUSE (mixed-purpose content) by giving each purpose its own surface. The agent file paid token tax on maintainer-only content (`Times`, `Last`, learnings cross-refs, archival cadence); the maintainer file paid clarity tax on agent-only content (recognition triggers buried among governance metadata). One file, mixed audiences = both lose. Two files, single audiences = both win. The compression-cap question (~25 words for Tier 1, no cap for Tier 2, ≤2 sentences for Tier 3) is now what determines *individual entry shape* within the agent file; it's NOT what controls overall file health. File health comes from audience separation.

## Files Changed

- `~/.claude/CLAUDE.md` — three-tier shape rewrite; routing rule + escape valve added; heavily-loaded mistake row collapsed ~3,800 → ~50 words; secondary loaded row collapsed ~280 → ~50 words; governance metadata replaced with HTML-comment pointer to `governance.md`.
- `~/.claude/governance.md` (NEW, ~90L) — table-management policy, skill-coupling contracts (8 contracts × 4 skills), learnings index, deferred Move 4 scope.
- A cross-project learnings archive (NEW) — 16 sub-incidents preserved verbatim, organized by project of origin.
- A project-level CLAUDE.md (NEW, ~108L) — project-level governance file matching other projects' patterns.

## Metrics

| Metric | Before | After | Delta |
|---|---|---|---|
| Heavily-loaded mistake row word count | ~3,800 | ~50 | −98% |
| Secondary loaded row word count | ~280 | ~50 | −82% |
| `~/.claude/CLAUDE.md` line count | 241 | 252 | +11 (three-tier shape table inserted; net positive on token tax) |
| Sub-incident archive content | 0 files | 1 file (16 incidents preserved verbatim) | NEW |
| Project-level CLAUDE.md | absent | ~108L | NEW |
| Skill-coupling contracts documented | 0 (implicit) | 8 contracts × 4 skills (governance.md table) | NEW |
| `/review-plan` cycles to APPROVE | — | 2 (REVISE → APPROVE) | — |

## Process notes (for next governance restructure)

1. **Phase 0 first.** For any plan that changes structure of `~/.claude/CLAUDE.md` or per-project MEMORY.md: read consuming skill files BEFORE drafting. This session, that step caught a P51 violation in original Move 3.
2. **Read governance.md § Skill-coupling contracts** as the first step. Future-self doesn't need to re-derive what was learned this session.
3. **Reduce scope when paired-semantics block ambition.** Move 3's full audience-split (column removal) was reduced to non-coupled-only because column removal requires paired skill updates (deferred). Better to ship the safe portion than over-couple.
4. **Distinguish "what loads every session" from "what's load-bearing for the rule."** Tier 1 (recognition trigger) loads every session and must be ruthless; Tier 2 (rule body) is unbounded but every word earning; Tier 3 (evidence) caps at 1 inline + migration to learnings. Different parts have different constraints.
5. **Recurrence trigger as upstream defense.** New Recurrence trigger added to "Adding to This File" — on the 4th sub-incident of any mistake row, STOP appending and abstract the rule. Prevents the next heavily-loaded row from forming.

## Maps to public CLAUDE.md

- Principle 51 (paired-semantics components drift silently — maker/checker, generator/validator, producer/consumer)
- Principle 40 (forward review cannot see its own blind spots)
- `governance.md` § Skill-coupling contracts (the artifact this restructure produced)
- Mistake-table row "Compressed growth-prone persistent file without growth-rate governor" (the upstream-defense answer to the symptom this row tracks)
