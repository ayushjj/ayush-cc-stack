---
name: review-plan
description: Use after writing a plan in plan mode to self-adversarially review it before presenting to the user. Challenges across 7 dimensions + scope mode. Triggers on '/review-plan', invoked automatically by Command Discipline Rule 8.
user_invocable: true
effort: high
---

# Skill: Review Plan

## Description
Self-adversarial review of any plan before presenting to user. Systematically challenges the plan across 7 dimensions derived from documented patterns of user pushback.

## Trigger
- **Automatic**: After writing any plan in plan mode, before calling ExitPlanMode
- **Manual**: User invokes `/review-plan`

## Instructions

After a plan is written (either in a plan file or in conversation):

### Step 0: Scope Mode Selection

Determine the scope mode for this plan:

- **EXPAND** — Challenge whether the plan is ambitious enough. Ask "what would make this 10x better for 2x effort?" Surface expansion opportunities.
- **HOLD** (default) — The plan's scope is accepted. Make it bulletproof. Don't silently expand or reduce.
- **REDUCE** — Find the minimum viable version. Cut everything non-essential.

If the user specified a mode, use it. Otherwise, default to HOLD.

### Triviality Gate

**Triviality gate**: If the plan is a single-file change, a rename, a config tweak, or under ~10 lines of planned changes, skip the full review. Instead output:
```
### Verdict: APPROVE — trivial change, full review not warranted
[1 sentence explaining why this is trivial]
```

For all non-trivial plans, review across all 7 dimensions below. Do NOT skip dimensions — even if a dimension seems obviously fine, state that explicitly.

### Dimension 1: Assumptions Audit

List every assumption the plan makes (minimum 3). For each:
- State the assumption clearly
- Is it **verified** (you read code/data confirming it) or **unverified** (you're inferring)?
- What's the impact if this assumption is wrong?

Flag any unverified assumption as a risk.

### Dimension 2: Root Cause Check

- Is this plan fixing a **root cause** or a **symptom**?
- Ask: "Why does this problem exist?" — trace one level deeper than the plan does
- Would a different framing of the problem lead to a simpler solution?
- **Invert the plan**: What must be true for this to succeed? List each precondition and mark as **verified** (you read code/data confirming it) or **unverified**. Any unverified precondition is a risk — it's the thing most likely to make this plan fail.

### Dimension 3: Alternatives & Simplicity

- **What already exists?** What existing code, flows, or patterns already solve part of this problem? Cite specific files/functions. If greenfield with no existing code, state "N/A — greenfield."
- Is **"do nothing"** viable? What's the actual cost of inaction?
- Is there a **simpler approach**? Apply the "couldn't you just...?" test
- For the chosen approach vs alternatives: compare effort, risk, and maintenance burden

### Dimension 4: Learnings Cross-Reference

Read these files and cross-reference against the plan:

1. **CLAUDE.md Mistake Patterns table** — does this plan risk repeating any of the documented mistakes?
2. **CLAUDE.md Principles list** — does this plan align with or violate any numbered principle?
3. **MEMORY.md** — are there project-specific learnings relevant to this plan?

Cite specific entries (e.g., "Mistake pattern: 'Fixed symptom instead of root cause' (2x)") when relevant.

### Dimension 5: Blast Radius & Edge Cases

- What **existing working functionality** could this break?
- What happens at **boundaries** (empty input, max load, concurrent access, partial failure)?
- What's the **rollback plan** if this goes wrong?

### Dimension 6: Completeness

- Does the plan have a **verification step** that would catch failures?
- Are there steps that **assume success** without verification?
- Is anything **deferred** that should be addressed now?

### Dimension 7: Compound Risk

Before rendering a verdict, look across Dimensions 1-6 for **reinforcing concerns**. Two minor flags that push in the same direction are more dangerous than one major flag in isolation. Ask: "Do any flagged concerns compound?" — e.g., an unverified assumption (Dim 1) in a plan that also lacks a verification step (Dim 6) is not two small risks, it's one systemic risk.

## Output Format

Produce a concise review — verdicts, not essays:

```
## Plan Review: {Plan Name}

### 1. Assumptions ({count} found)
- [{assumption}]: [Verified/Unverified] — [risk if wrong]
- ...

### 2. Root Cause: [PASS / CONCERN]
[1-2 sentences]
- Preconditions for success: [{precondition}]: [Verified/Unverified]

### 3. Alternatives: [PASS / SIMPLER EXISTS]
- What already exists: [existing code/flows that partially solve this, with file:line references, or "N/A — greenfield"]
- "Do nothing" cost: [assessment]
- Simpler alternative: [if any]

### 4. Learnings Check: [PASS / VIOLATION]
- Relevant mistake pattern: [if any]
- Relevant principle: [if any]

### 5. Blast Radius: [LOW / MEDIUM / HIGH]
- Could break: [list or "nothing identified"]
- Edge cases not covered: [list or "none"]

### 6. Completeness: [PASS / GAPS]
- Missing: [list or "none"]

### 7. Compound Risk: [NONE / COMPOUND RISK]
- [Which dimensions reinforce each other and why, or "No compounding concerns"]

### 8. Scope Mode: [EXPAND / HOLD / REDUCE]
- NOT in scope (with rationale):
  - [excluded item 1] — [why excluded]
  - [excluded item 2] — [why excluded]
  - [or "none documented"]

### Verdict: [APPROVE / REVISE]
[1-2 sentences: either "plan is solid" or "revise X, Y, Z before proceeding"]
```

### Example (Filled-In)

```
## Plan Review: Add Compound Tag Expansion to Search

### 1. Assumptions (3 found)
- [Tags table has a `compounds` column]: Verified (read schema at src/db/schema.sql:45) — low risk
- [Expanding compounds won't exceed Supabase query limits]: Unverified — if a query expands to 50+ tags, the IN clause may hit limits
- [Existing tag search tests still pass after expansion]: Unverified — no tests read yet this session

### 2. Root Cause: PASS
Problem is correctly identified: compound tags like "ball bearing" don't match atomic tags "ball" + "bearing" in the search index.

### 3. Alternatives: PASS
- "Do nothing" cost: ~15% of real queries return zero results due to compound mismatch. Not viable.
- Simpler alternative: None found — expansion at query time is already the minimal approach.

### 4. Learnings Check: VIOLATION
- Mistake pattern: "Wrote DB code without reading schema first" (6x) — plan does not include a "verify schema" step before implementation.
- Principle 1: "grep ALL callers" — plan modifies tagSearch but doesn't check what else calls it.

### 5. Blast Radius: MEDIUM
- Could break: existing tag search if expansion logic has bugs; detail flow if it depends on exact tag match counts
- Edge cases not covered: empty compound expansion (tag has no compounds listed)

### 6. Completeness: GAPS
- Missing: no step to run existing search tests after changes

### Verdict: REVISE
Add schema verification step, grep callers of tagSearch, and run existing test suite before and after changes.
```

## Post-Review Action

- If verdict is **APPROVE** → proceed to ExitPlanMode (or present plan if manual invocation)
- If verdict is **REVISE** → update the plan to address flagged issues, then re-run this review on the revised plan before proceeding

## Anti-Patterns (Don't Do These)

- **Rubber-stamping**: Don't mark everything PASS to avoid friction. The whole point is to catch issues BEFORE the user has to push back.
- **Verbose explanations**: Keep each dimension to 2-3 lines max. Flag issues, don't write essays about them.
- **Skipping dimensions**: Every dimension gets a verdict, even if it's "PASS — no concerns."
- **Inventing issues**: Only flag genuine concerns. False alarms erode trust in the review.
