---
name: prompt-engineering
description: Structure and tune LLM prompts using battle-tested patterns. Use when writing new prompts, restructuring underperforming ones, or iterating on accuracy. Triggers on "write prompt", "fix prompt", "prompt not working", "LLM wrong", "false positives", "tune prompt", "restructure prompt", "prompt engineering".
preconditions:
  - Have an LLM prompt to write, restructure, or tune
  - Know what the prompt should accomplish
  - Can measure or observe results
---

# Prompt Engineering

Two phases: **Structure** (get the architecture right) then **Tune** (measure and iterate). Use Phase 1 alone for new prompts. Use both phases when an existing prompt underperforms.

<critical_sequence enforce_order="strict">

<step number="0" required="true" blocking="true">
## Phase 1: Structure Audit

Before writing or changing a single word, audit the prompt's architecture against these patterns. For new prompts, use this as a construction checklist.

### Correct Section Order

LLMs attend most to the beginning and end. This ordering is non-negotiable:

```
1. ANCHOR — exact output format first ("Respond with...", "Return JSON with...")
2. HARD CONSTRAINTS — rules that must never be broken (safety, hallucination ban, char limits)
3. ROLE + BOUNDARY — who the LLM is + what to do when data is missing
4. FORMAT OPTIONS — if multiple formats exist, describe them with default bias
5. EXAMPLES — GOOD, GOOD (different case), BOUNDARY, BAD (in that order)
6. CONTEXT — conversation history, retrieved data (in user prompt, not system)
```

**Why this order:** Constraints after examples are "effectively dead" — the LLM has already formed its response pattern from examples and ignores trailing rules. (Brady Long Pattern 2, confirmed by ref-bot Principle 14: position = priority.)

### 7 Structural Rules

| # | Rule | Diagnostic Question |
|---|------|-------------------|
| 1 | **Anchor first** — open with exact output format, not role | Does the prompt open with "You are..." instead of output format? Move format up. |
| 2 | **Constraints before examples** — rules right after anchor | Are any rules listed AFTER the examples section? Move them up. |
| 3 | **7 rules max** — beyond 7, LLMs start ignoring or mis-prioritizing | Count the rules. If >7, combine or move deterministic ones to code. |
| 4 | **Concrete examples > abstract rules** — 2-4 diverse examples outperform 10+ rules | Are there rules that could be replaced by a single example? Replace. |
| 5 | **Every new power needs a boundary example** — "you may reject ALL" needs a companion showing when NOT to reject | Does the prompt grant a new capability without showing its limits? Add boundary example. |
| 6 | **Deterministic rules in code, not prompt** — if it has a deterministic answer, enforce in code | Can any rule be enforced with regex, char count, or code check? Remove from prompt, add to code. |
| 7 | **Explicitly permit zero/empty results** — LLMs default to "pick the best available" | Could the correct answer be "nothing matches"? If yes, the prompt must explicitly allow it. |

### Structure Audit Checklist

<validation_gate name="structure-audited" blocking="true">
Read the prompt (or draft it if new), then check every box:

- [ ] Section order matches the 6-section template above
- [ ] Hard constraints appear BEFORE examples
- [ ] Total rule count is 7 or fewer
- [ ] No rule that could be enforced in code instead
- [ ] Every example uses the SAME FORMAT the LLM sees in real data
- [ ] If prompt grants a power (reject, skip, abbreviate), a boundary example exists
- [ ] If zero/empty is a valid result, explicitly permitted

**Document what you moved or changed.** If the prompt was already well-structured, note that and proceed to Phase 2.
</validation_gate>
</step>

<step number="1" required="true" blocking="true">
## Phase 2: Measure and Tune

Skip this phase when writing a brand-new prompt — there is no baseline to compare against. Come
back when real output exists to evaluate.

**Slimmed S69 2026-08-27.** This phase carried five `<step>`/`<validation_gate>` blocks of
process scaffolding and had run **zero** times since it was merged in from the former
tuning-llm-prompts skill; no `specs/llm-tune-*` exists on disk. The scaffolding was the cost and
none of it was ever paid for. What survives is the part that does the work: measure, try several
things, choose on data, lock it in with tests.

1. **Test cases — at least 10.** Interface in `scripts/measure-accuracy.ts`. Cover 3+ clear
   positives, 3+ clear negatives, 3+ boundary/edge, every case that has failed in production,
   and mixed-language cases if the prompt sees them. Fewer than 10, or missing one of those
   categories, and the measurement below cannot distinguish a real gain from noise.

2. **Baseline.** Run all cases against the CURRENT prompt before changing anything. Record
   accuracy (N/M), each failed case with actual vs expected, and the failure *patterns* — the
   pattern is what tells you which of the four moves below to reach for.

3. **At least 3 approaches**, generated with Phase 1's structural rules. The high-impact ones:
   reorder only (constraints up, same words) · reduce to ≤7 rules · replace 3 abstract rules
   with 1 concrete example · add a boundary example where the limit is. Note each one's
   accuracy, strengths and weaknesses.

4. **Choose on the numbers, not on feel.** Compare approaches on accuracy, robustness, false
   positives and false negatives — the last two separately, because a prompt that trades one for
   the other can hold accuracy flat while getting worse for its actual job. State the trade-off
   you accepted.

5. **Every failed case becomes a regression test** in the project's suite. This is what stops
   the next tuning pass from silently re-breaking what this one fixed.
</step>

</critical_sequence>

## Quick Reference: Anti-Patterns

- **Rules at the bottom** — move constraints before examples
- **>7 rules** — combine or enforce in code
- **"Never do X" without showing what X looks like** — add a BAD example
- **"You may skip/reject" without showing when NOT to** — add boundary example
- **Tweaking words without measuring** — always measure before/after
- **Same example repeated with minor variations** — use 2-4 DIVERSE examples instead
- **Asking LLM to enforce char limits** — enforce in code (deterministic)
- **Context in system prompt** — put retrieved data in user prompt where it gets more attention

## Output Template

For the full output template, see `references/output-template.md`.

<success_criteria>
## Done When ALL Are True

**Phase 1 (Structure):**
- [ ] Section order follows the 6-section template
- [ ] Constraints before examples
- [ ] 7 or fewer rules
- [ ] Boundary examples for every granted power

**Phase 2 (Tune) — if applicable:**
- [ ] Minimum 10 test cases
- [ ] Baseline measured
- [ ] 3+ approaches tested
- [ ] Decision matrix with chosen approach justified
- [ ] Regression tests added
</success_criteria>

<decision_gate wait_for_user="true">
## Prompt Engineering Complete

Structure changes: [list what moved/changed]
Baseline accuracy: [X]% (if tuning)
New accuracy: [Y]% (if tuning)

What's next?
1. Deploy the prompt
2. Test with more cases
3. Try additional approaches
4. Apply to another prompt

Choose (1-4): _
</decision_gate>

<integration_protocol>
## Integration Points

**Invoked by:**
- Manual: `/prompt-engineering`
- Auto-suggest: when user mentions prompt issues, LLM wrong output, or "restructure prompt"

**Complements:**
- The former tuning-llm-prompts skill is merged into this skill (Phase 2)
- Post-deploy verification: executing-batch-operations → Query-correctness validation (expected behavior → real data → precision/recall)

**Handoff:**
Creates decision documentation in `specs/llm-tune-{feature}/`.
Phase 1 can run standalone for new prompts.
Phase 2 produces test cases + regression tests.
</integration_protocol>
