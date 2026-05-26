---
name: validating-queries
description: Run test queries against real data to verify changes work correctly. Use after implementing search/query changes, to verify LLM behavior, or to compare before/after results. Triggers on "validate", "test query", "verify search", "check results", "compare before after".
preconditions:
  - Have implementation to validate
  - Access to run queries against real data
  - Unit tests pass but want real-world verification
---

# Validating Queries

Use this skill to run specific test queries and analyze output. Especially valuable when unit tests pass but you want real-world validation with actual data.

## Usage

```
/validate {query or test case}
```

<critical_sequence enforce_order="strict">

<step number="1" required="true" blocking="true">
## Step 1: Define Expected Behavior

Before running, write down:

```markdown
### Expected
- What should this query return?
- How many results expected?
- What should NOT appear in results?
```

<validation_gate name="expectations-defined" blocking="true">
**BLOCK if expectations unclear:**
- [ ] Expected results documented
- [ ] Expected count range defined
- [ ] Exclusions documented (what should NOT appear)

Don't run queries without knowing what success looks like.
</validation_gate>
</step>

<step number="2" required="true" depends_on="1">
## Step 2: Run the Query

Execute the actual query against real data:

```typescript
// For search queries
const results = await search("real estate broker thane");
console.log(`Found ${results.length} results`);
results.forEach((r, i) => {
  console.log(`${i+1}. ${r.name} - ${r.category} (score: ${r.score})`);
});
```

Save results to file for comparison.
</step>

<step number="3" required="true" depends_on="2" blocking="true">
## Step 3: Analyze Output

For each result, ask:
- Is this result correct? (Should it be here?)
- Is the ranking correct? (Should it be higher/lower?)
- Are there missing results? (What should be here but isn't?)

```markdown
### Actual
- Results: 7 total
  1. ✓ Broker A - Real Estate - Thane (correct)
  2. ✓ Broker B - Real Estate - Thane (correct)
  3. ✗ Caterer C - Catering - Thane (WRONG - different industry)
  4. ...
```

<validation_gate name="results-analyzed" blocking="true">
**BLOCK if analysis incomplete:**
- [ ] Each result marked as correct/incorrect
- [ ] Wrong results explained (why they shouldn't be there)
- [ ] Missing results identified (if any)
- [ ] Precision calculated

Analyze results before declaring success or failure.
</validation_gate>
</step>

<step number="4" required="true" depends_on="3">
## Step 4: Calculate Metrics

```markdown
### Analysis
- Precision: 5/7 (71%) - 2 wrong results
- Recall: 5/6 (83%) - missing Broker F
- Issue: Industry filter not working correctly
```

Metrics to track:
- **Precision**: Correct results / Total results
- **Recall**: Correct results / Expected results
- **Ranking**: Are top results the best matches?
</step>

<step number="5" required="true" depends_on="4">
## Step 5: Document Findings

Create validation report:

```markdown
## Validation: {query}

### Expected
- Results: ~5 real estate brokers in Thane
- No results from: other cities, other industries

### Actual
- Results: 7 total
  1. ✓ Broker A - Real Estate - Thane (correct)
  2. ✓ Broker B - Real Estate - Thane (correct)
  3. ✗ Caterer C - Catering - Thane (WRONG - different industry)
  4. ...

### Analysis
- Precision: 5/7 (71%) - 2 wrong results
- Recall: 5/6 (83%) - missing Broker F
- Issue: Industry filter not working correctly
```
</step>

</critical_sequence>

## Validation Script Template

For the full validation script with `ValidationCase` interface and before/after comparison, read `scripts/validate-template.ts`.

## Output Format

```
=== Query: "real estate broker thane" ===

Count: 7 ✓ (expected 3-10)

✓ Broker A - Real Estate - Thane
✓ Broker B - Real Estate - Thane
✗ Caterer C - Catering - Thane [WRONG INDUSTRY]
✓ Broker D - Real Estate - Thane
✓ Broker E - Real Estate - Thane
✗ Broker F - Real Estate - Mumbai [WRONG LOCATION]
✓ Broker G - Real Estate - Thane

Precision: 5/7 (71%)

=== ISSUES FOUND ===
1. Industry filter allowing cross-industry results
2. Location filter not strict enough
```

<success_criteria>
## Validation Complete When ALL Are True

- [ ] Expected behavior documented before running
- [ ] All test queries executed
- [ ] Each result analyzed for correctness
- [ ] Precision/recall calculated
- [ ] Issues documented with specifics
- [ ] Before/after comparison done (if change validation)
</success_criteria>

<decision_gate wait_for_user="true">
## Validation Complete

Status: [PASSED / FAILED]

Metrics:
- Precision: [X]%
- Recall: [Y]%
- Issues found: [count]

What's next?
1. Ship the change (validation passed)
2. Fix issues and re-validate
3. Add test cases for edge cases found
4. Document learnings
5. Other

Choose (1-5): _
</decision_gate>

## When Validation Fails

1. DO NOT ship the change
2. Identify pattern in failures
3. Fix root cause
4. Re-run validation
5. Document the fix in implementation.md

<integration_protocol>
## Integration Points

**Invoked by:**
- `/spec` skill (to verify implementation)
- `/batch` skill (to verify data changes)
- Manual invocation for ad-hoc testing

**Invokes:** None (terminal skill — insights captured via `/wrap` at session end)

**Handoff expectations:**
Receives query/test case to validate.
Produces validation report with metrics.
</integration_protocol>
