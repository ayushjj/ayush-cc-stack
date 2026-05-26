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

Skip this phase if you're writing a brand-new prompt with no existing baseline to compare against. Come back when you have real output to evaluate.

### Step 2a: Create Test Cases (Minimum 10)

See `scripts/measure-accuracy.ts` for the TestCase interface.

**Required categories:**
- Clear positive cases (3+)
- Clear negative cases (3+)
- Boundary/edge cases (3+)
- Cases that previously failed in production
- Mixed language cases (if applicable)

<validation_gate name="test-cases-created" blocking="true">
- [ ] Minimum 10 test cases created
- [ ] At least 3 positive, 3 negative, 3 edge
- [ ] Failed cases from production included

Do NOT proceed with fewer than 10 diverse test cases.
</validation_gate>
</step>

<step number="2" required="true" depends_on="1" blocking="true">
### Step 2b: Measure Baseline

Run all test cases against the CURRENT prompt. Document:

```markdown
## Baseline
- Accuracy: X% (N/M correct)
- Failed cases: [list with actual vs expected]
- Failure patterns: [what's going wrong]
```

<validation_gate name="baseline-measured" blocking="true">
- [ ] Current prompt tested against all cases
- [ ] Accuracy percentage calculated
- [ ] Failed cases documented with actual output
- [ ] Failure patterns identified
</validation_gate>
</step>

<step number="3" required="true" depends_on="2">
### Step 2c: Try Multiple Approaches (Minimum 3)

Use the structural rules from Phase 1 to generate approaches. Common high-impact changes:

1. **Reorder only** — move constraints up, keep same words
2. **Reduce rules** — combine or cut to stay under 7
3. **Replace rules with examples** — swap 3 abstract rules for 1 concrete example
4. **Add boundary example** — show the LLM where the limit is

Document each approach with accuracy, strengths, weaknesses.
</step>

<step number="4" required="true" depends_on="3" blocking="true">
### Step 2d: Choose Based on Data

Create decision matrix:

| Approach | Accuracy | Robustness | False Positives | False Negatives |
|----------|----------|------------|-----------------|-----------------|
| A | X% | ... | X% | X% |
| B | X% | ... | X% | X% |
| C | X% | ... | X% | X% |

<validation_gate name="decision-made" blocking="true">
- [ ] All approaches tested and measured
- [ ] Decision matrix created
- [ ] Chosen approach has clear rationale
- [ ] Trade-offs documented

Decision must be data-driven, not gut-feel.
</validation_gate>
</step>

<step number="5" required="true" depends_on="4">
### Step 2e: Add Regression Tests

Every failed case becomes a regression test. Add ALL tricky edge cases to the project's test suite.
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
- `/tuning-llm-prompts` is now merged into this skill (Phase 2)
- `/validate` skill (to verify in production after deploying)

**Handoff:**
Creates decision documentation in `specs/llm-tune-{feature}/`.
Phase 1 can run standalone for new prompts.
Phase 2 produces test cases + regression tests.
</integration_protocol>
