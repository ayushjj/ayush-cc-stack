---
name: investigating-problems
description: Diagnose problems systematically before attempting fixes. Use when encountering bugs, unexpected behavior, errors, or when something "doesn't work" but cause is unclear. Triggers on phrases like "not working", "bug", "error", "broken", "investigate", "why is this happening".
preconditions:
  - Problem reported or observed
  - Not currently in middle of implementation (investigate BEFORE fixing)
---

# Investigating Problems

Use this skill BEFORE attempting any fix — before any code changes. Proper diagnosis prevents wasted time on wrong solutions.

<critical_sequence enforce_order="strict">

<step number="1" required="true" blocking="true">
## Step 1: Trace One Concrete Example

Find a specific instance of the problem with actual data:

- What input caused this?
- What was expected vs actual output?
- What's the exact error message or symptom?

<validation_gate name="concrete-example" blocking="true">
**BLOCK if any are missing:**
- [ ] Specific input data identified
- [ ] Expected behavior documented
- [ ] Actual behavior documented
- [ ] Error message/symptom captured
- [ ] **Live/runtime issue (page won't load, 500, crash, hang) → the captured symptom MUST be the actual log / stderr / curl / console artifact, not a paraphrase (P10: logs first, turn-1, before any code exploration). Scoped to live-runtime symptoms only — DB-constraint / static-site / pure-code bugs are exempt.**

Do NOT proceed until you have a concrete, reproducible example.
</validation_gate>
</step>

<step number="2" required="false" depends_on="1">
## Step 2: Domain-Specific Checks (if applicable)

Choose the relevant block based on what you're investigating. Skip entirely for simple, scoped code bugs.

**If investigating a database or data pipeline issue:**
- Check for UNIQUE constraints that could be violated
- Ask: "What timestamp? NOW() or source data?" — mixing causes timeline corruption
- Look for race conditions in check-then-insert patterns
- Consider concurrent request scenarios

**If investigating an LLM prompt or pipeline issue:**
- Check deployment/application logs FIRST — before exploring code
- Run the eval harness to get a baseline metric before changing prompts
- Check if the issue is non-deterministic (run the same input 3x)

**If investigating a static site or content system issue:**
- Run validation commands (`npm run check`, `bash validate-graph.sh`) to establish baseline
- Check build output, not just source files — the bug may be in the build pipeline
- Verify content files match their index entries (e.g., graph-index.yaml)

</step>

<step number="4" required="true" depends_on="1">
## Step 4: Quantify the Problem

- How many records are affected? (X% of total)
- How often does it occur? (frequency)
- What's the impact? (user-visible effect)

<validation_gate name="metrics-gathered" blocking="true">
**BLOCK if metrics incomplete:**
- [ ] Count of affected records (or estimate)
- [ ] Frequency quantified
- [ ] Impact assessed

Quantification prevents over/under-engineering the fix.
</validation_gate>
</step>

<step number="5" required="true" depends_on="4" blocking="true">
## Step 5: Find Root Cause Location

- Identify specific file path and line number
- Distinguish between symptom and cause
- Trace the data flow from input to error

<validation_gate name="root-cause-identified" blocking="true">
**Investigation is NOT complete until:**
- [ ] Root cause file:line identified (not just symptom location)
- [ ] Data flow traced from input to error
- [ ] Cause distinguished from symptom

Do NOT propose fixes until root cause is confirmed.
</validation_gate>
</step>

</critical_sequence>

## Output

Create or update `specs/{problem-name}/design.md`:

```markdown
## Problem Statement
[One sentence describing what's wrong]

## Concrete Example
- Input: [actual data that triggers the bug]
- Expected: [what should happen]
- Actual: [what happens instead]

## Root Cause Analysis
- File: [path:line_number]
- Symptom: [what user sees]
- Cause: [technical reason why]

## Metrics
- Affected: X% of records (N out of M)
- Frequency: [how often it occurs]
- Impact: [user-visible consequence]

## Unique Constraint Check
- [x] Checked for UNIQUE constraints
- [x] Considered race conditions
- [x] Verified timestamp consistency
```

<success_criteria>
## Investigation Complete When ALL Are True

- [ ] Concrete example traced with actual data
- [ ] Root cause identified with file:line reference
- [ ] Metrics quantified (% affected, frequency)
- [ ] Output written to `specs/{problem}/design.md`
- [ ] Symptom vs cause clearly distinguished
</success_criteria>

<decision_gate wait_for_user="true">
## Investigation Complete

Root cause identified: [summary with file:line]

What's next?
1. Create spec for fix (recommended if non-trivial)
2. Implement fix directly (if simple, isolated change)
3. Document as known issue (if won't fix now)
4. Investigate deeper (if root cause unclear)
5. Other

Choose (1-5): _
</decision_gate>

## Gotchas

These are accumulated failure points from real investigation sessions.

1. **Logs first, code second:** Check deployment/application logs BEFORE exploring code. Skipping log check and going straight to expensive code exploration has happened 3x — the logs usually contain the answer directly.
2. **Don't assert state without reading:** Never say "the config is set to X" without reading the actual file. Asserting config/settings state without verification has happened 3x.
3. **Steps 2-3 are domain-specific:** The "Unique Constraint" and "Timestamp Type" checks below are for database/data-pipeline investigations. Skip them for static sites, LLM prompts, or pure code bugs.

*(Update this section when new failure patterns emerge.)*

## Anti-Patterns to Avoid

- Jumping to fix without understanding root cause
- Fixing the symptom instead of the cause
- Changing code without tracing actual data flow
- Assuming the bug is where the error appears
- Proposing fixes before investigation is complete

<integration_protocol>
## Integration Points

**Invoked by:**
- Manual invocation when bugs are reported
- Auto-suggested when user describes problem symptoms

**Invokes:**
- `/spec` skill (if fix requires design work)

**Handoff expectations:**
Creates `specs/{problem}/design.md` with investigation results.
Next skill receives full context from this file.
</integration_protocol>
