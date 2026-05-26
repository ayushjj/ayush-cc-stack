---
name: data-analysis
description: Analyze user data systematically before proposing solutions. Use when designing features for users, working with datasets, or when patterns in data need to be understood before implementation. Triggers on "analyze data", "user patterns", "design for users", "data-first", "before proposing".
preconditions:
  - Dataset or user data available to analyze
  - Not in middle of implementation (analyze BEFORE designing)
---

# Data-First Analysis

Use this skill BEFORE proposing ANY solution involving user data — including tag extraction, classification, or search strategies. Real data reflects how users think - you cannot design delightful experiences without studying it.

<critical_sequence enforce_order="strict">

<step number="1" required="true" blocking="true">
## Step 1: Study Data Exhaustively

Not 10 examples. Hundreds. Look for what's common, rare, and unexpected.

- Get total record count
- Sample across different segments (not just first N rows)
- Look for patterns AND anti-patterns

<validation_gate name="sufficient-sample" blocking="true">
**BLOCK if:**
- [ ] Looked at fewer than 50 examples from a large dataset
- [ ] Only sampled from one segment/category
- [ ] Haven't seen edge cases yet

Do NOT proceed until you've seen representative breadth.
</validation_gate>
</step>

<step number="2" required="true" depends_on="1">
## Step 2: Quantify Everything

"Most users do X" means nothing. "73% do X, 18% do Y, 9% edge cases" means something.

Must answer:
- Total record count and key breakdowns
- Top patterns WITH percentages (not just examples)
- What's messy, inconsistent, or doesn't fit?
- Distribution across categories/segments
</step>

<step number="3" required="true" depends_on="2" blocking="true">
## Step 3: Surface Findings FIRST

Present what you learned about user patterns BEFORE proposing solutions.
Let the user validate your understanding.

<validation_gate name="findings-surfaced" blocking="true">
**BLOCK if proposing solutions without first presenting:**
- [ ] Quantified breakdown (with percentages)
- [ ] Pattern analysis (what's common vs rare)
- [ ] Edge case identification (what doesn't fit)
- [ ] User intent inference (what patterns reveal about how users think)

Do NOT propose solutions until findings are validated.
</validation_gate>
</step>

<step number="4" required="true" depends_on="3">
## Step 4: Design FROM the Data

Solutions should emerge from patterns you observed, not assumptions you made.

- Reference specific findings when proposing approaches
- Explain how the solution handles the quantified edge cases
- Show which user patterns informed each design decision
</step>

</critical_sequence>

## Red Flags (You're Doing It Wrong)

Stop and restart if you catch yourself:

- Proposing solutions after looking at <50 examples from a large dataset
- Using words like "typically", "usually", "most" without percentages
- Designing for the clean/happy path without quantifying edge cases
- Making assumptions about user intent without behavioral data
- Jumping to implementation before presenting data findings

## Examples of This Failure

Learn from past mistakes:

- **37K item list**: Proposed tag extraction without analyzing what patterns actually exist in item names, what % have codes, what % are messy descriptions
- **Enquiry data**: Designed flows without analyzing how users actually phrase enquiries, how they share contacts, distribution of enquiry counts per user

## Output

Create analysis document with this structure:

```markdown
## Data Analysis: [Topic]

### Dataset Overview
- Total records: N
- Key segments: [breakdown with counts]

### Pattern Analysis
| Pattern | Count | % of Total | Notes |
|---------|-------|------------|-------|
| [Most common] | X | Y% | |
| [Second most] | X | Y% | |
| ...edge cases... | X | Y% | |

### What the Data Reveals
- [Insight about user behavior/intent]
- [Insight about edge cases]
- [Insight about what's messy]

### Implications for Design
- [How findings should shape the solution]
```

<success_criteria>
## Analysis Complete When ALL Are True

- [ ] Total count and breakdowns quantified
- [ ] Top patterns identified with percentages
- [ ] Edge cases identified and quantified
- [ ] Findings presented BEFORE solution proposed
- [ ] User validated understanding before design phase
</success_criteria>

<decision_gate wait_for_user="true">
## Analysis Complete

Findings: [summary of key patterns and percentages]

What's next?
1. Proceed to design phase (recommended if findings validated)
2. Dig deeper into specific segment
3. Document findings for future reference
4. Other

Choose (1-4): _
</decision_gate>

<integration_protocol>
## Integration Points

**Invoked by:**
- Manual invocation before feature design
- Auto-suggested when user asks about designing for users

**Invokes:**
- `/spec` skill (after analysis informs design)

**Handoff expectations:**
Creates analysis document with quantified findings.
Next skill receives data-informed context.
</integration_protocol>
