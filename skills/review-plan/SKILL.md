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

1. **`~/.claude/evals/mistake-ledger.md`** (relocated from CLAUDE.md 2026-08-06) — does this plan risk repeating any of the documented mistakes?
2. **`~/.claude/principles/INDEX.md`** (relocated 2026-08-06; narratives at `principles/PNN-*.md`) — does this plan align with or violate any numbered principle?
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

### Clean-Room Escalation Gate

Dimensions 1-7 run inside the plan's OWN context — the same frame that produced it. That frame is structurally blind to its own gaps: non-fixes, stale-state claims, silent discards, and verdict asymmetries survive a forward pass and die only under an *independent* adversarial read (P40/P43). Before rendering the verdict, decide whether this plan has earned a clean-room pass.

**Escalate — dispatch ONE fresh-context subagent — if ANY of these three falsifiable triggers fires.** Each is already decided by the dimensions above, so evaluating the gate costs ~0 tokens; only a hit pays for the subagent:

- **T1 — Dimension 5 blast radius = HIGH.** High-blast plans are where a missed edge case costs the most.
- **T2 — the plan scored APPROVE with ZERO flags across all 7 dimensions** — i.e. zero *Unverified* assumptions in Dim 1 **and** no CONCERN / SIMPLER-EXISTS / VIOLATION / HIGH / GAPS / COMPOUND on Dims 2-7 — **OR the current conversation shows this plan has already been through ≥2 REVISE→re-review cycles.** Absence of objections is itself the signal (P40): a non-trivial plan that draws no flags has more likely exhausted the forward frame than achieved perfection; and a plan that keeps looping back through REVISE is re-converging inside that same frame — escalate to break out of it. (Read the cycle count from visible conversation history; if it was compacted and you genuinely cannot tell, treat this branch as not-fired and lean on T1/T3.)
- **T3 — the plan edits the GLOBAL `~/.claude` meta-infrastructure** (its `skills/`, `hooks/`, `governance.md`, the global `CLAUDE.md`, this file). Meta-recursive work is doubly self-review-blind — you are reviewing the reviewing machinery *with* the reviewing machinery. (A *project's* own `CLAUDE.md` is not T3 on its own — it can still escalate via T1 if its blast radius is HIGH.)

If none fire, skip the gate and render the verdict — **no ceremony.** An always-on escalation dilutes the signal (P57) and burns subscription/agent budget (P70); the disjunction above is the line, deliberately falsifiable — there is no vague "does this feel high-stakes?" trigger.

**Run the clean-room pass (P43 — independence is the entire point):**
- **Launch a genuinely separate subagent** (Agent tool, fresh context). Its ENTIRE input = the plan artifact + the specific production files the plan names — nothing else. Do **not** paste the review, your dimension verdicts, or "what I already worried about" into its prompt: a reviewer primed with your hypotheses confirms them instead of breaking them (contaminated inversion).
- Prompt generically and adversarially: *"Find where this plan is wrong — unstated assumptions, non-fixes, stale-state claims, silent discards, verdict asymmetries. Construct concrete failure inputs. Cite your own file:line (P48)."* No hints about specific items you noticed.
- **Guard the findings (P41):** a fresh agent also hallucinates. Before accepting any finding that prescribes a NEW callback / query / state-handler, trace it against the live product — the flow it assumes may not exist.

**Fold, then verdict.** Merge surviving clean-room findings back into the 7 dimensions as new flags, THEN render the binary verdict. The gate runs *before* the verdict — it never replaces it.

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

### 9. Clean-Room Gate: [SKIPPED / ESCALATED]
- Trigger(s): [T1 HIGH-blast / T2 zero-flag-APPROVE / T2 ≥2 re-reviews / T3 meta-recursive `~/.claude` edit / none → SKIPPED]
- Findings folded in: [surviving clean-room findings folded into the dimensions above, or "none survived" / "N/A — skipped"]

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
- Mistake pattern: "Wrote DB code without reading schema first" (20x) — plan does not include a "verify schema" step before implementation.
- Principle 1: "grep ALL callers" — plan modifies tagSearch but doesn't check what else calls it.

### 5. Blast Radius: MEDIUM
- Could break: existing tag search if expansion logic has bugs; detail flow if it depends on exact tag match counts
- Edge cases not covered: empty compound expansion (tag has no compounds listed)

### 6. Completeness: GAPS
- Missing: no step to run existing search tests after changes

### 7. Compound Risk: COMPOUND RISK
- Dim 1 (unverified "existing tests still pass") + Dim 6 (no step to run those tests) reinforce: the plan assumes test safety AND omits the check that would confirm it — one systemic gap, not two small ones.

### 8. Scope Mode: HOLD
- NOT in scope (with rationale):
  - Compound-tag authoring UI — query-time expansion only; out of scope
  - Reindexing historical data — expansion works at read time, no backfill needed

### 9. Clean-Room Gate: SKIPPED
- Trigger(s): none — blast is MEDIUM (not HIGH), verdict is REVISE with flags (not zero-flag APPROVE), not a `~/.claude` edit.
- Findings folded in: N/A — skipped.

### Verdict: REVISE
Add schema verification step, grep callers of tagSearch, and run existing test suite before and after changes.
```

### Example — Clean-Room Gate ESCALATED (compact)

When a trigger fires and the clean-room subagent surfaces a real defect, §9 records it and the finding folds *back* into the dimensions — which can flip a forward APPROVE to REVISE:

```
### 9. Clean-Room Gate: ESCALATED
- Trigger(s): T3 (plan edits ~/.claude/skills/) + T2 (forward pass drew zero flags).
- Findings folded in: clean-room found a prose rule re-deriving a boundary already owned by code (silent drift) → added as Dim 4 VIOLATION (P16) and raised Dim 5 to HIGH.

### Verdict: REVISE
Forward review APPROVED; clean-room caught a source-of-truth duplication it could not see. Move the rule into code, then re-review.
```
A zero-flag forward APPROVE that flips to REVISE here is the gate working exactly as designed (P40).

## Post-Review Action

- If verdict is **APPROVE** → proceed to ExitPlanMode (or present plan if manual invocation)
- If verdict is **REVISE** → update the plan to address flagged issues, then re-run this review on the revised plan before proceeding

## Anti-Patterns (Don't Do These)

- **Rubber-stamping**: Don't mark everything PASS to avoid friction. The whole point is to catch issues BEFORE the user has to push back.
- **Verbose explanations**: Keep each dimension to 2-3 lines max. Flag issues, don't write essays about them.
- **Skipping dimensions**: Every dimension gets a verdict, even if it's "PASS — no concerns."
- **Inventing issues**: Only flag genuine concerns. False alarms erode trust in the review.
