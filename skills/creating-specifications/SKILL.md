---
name: creating-specifications
description: Create structured design documentation before implementing features. Use for new features, significant refactoring, or work spanning multiple sessions. Triggers on "new feature", "implement", "build", "design", "spec", "plan the implementation".
preconditions:
  - Feature or change is non-trivial
  - Not a simple bug fix (use /investigate first for bugs)
  - Scope is understood at least at high level
  - Premises validated (run /premise-check if "should we build this?" is unclear)
---

# Creating Specifications

Use this skill BEFORE implementing any non-trivial feature, especially when trade-offs need to be explicit. Creates structured documentation that persists across sessions.

## Usage

```
/spec {feature-name}
```

<critical_sequence enforce_order="strict">

<step number="1" required="true" blocking="true">
## Step 1: Create Folder Structure

Create the spec directory:

```
specs/{feature-name}/
├── design.md        # Problem + proposed solution
├── decisions.md     # Trade-offs documented
└── implementation.md # Execution notes
```

<validation_gate name="folder-created" blocking="true">
**BLOCK if not created:**
- [ ] Directory `specs/{feature-name}/` exists
- [ ] All three files initialized

Do NOT proceed to design until structure exists.
</validation_gate>
</step>

<step number="2" required="true" depends_on="1" blocking="true">
## Step 2: Write Problem Statement

**Prerequisite check:** Before writing the problem statement, assess: is the problem crystal clear?
- If a PREMISE CHECK output already exists in the conversation → proceed
- If the problem is vague or the user said "maybe we should build..." → offer: "The problem isn't crystal clear yet. Want me to run `/premise-check` first? It takes 2-3 minutes and prevents building the wrong thing."
- If the user declines or the problem is already specific → proceed normally

Fill out the problem section of `design.md`:

```markdown
# {Feature Name} Design

## Problem Statement
[What problem are we solving? Why does it matter?]

## Current Behavior
[How does the system work today?]
```

<validation_gate name="problem-defined" blocking="true">
**BLOCK if problem unclear:**
- [ ] Problem statement is one clear sentence
- [ ] Current behavior documented
- [ ] "Why it matters" explained

Do NOT propose solutions until problem is crystal clear.
</validation_gate>
</step>

<step number="3" required="true" depends_on="2">
## Step 3: Document Alternatives

Research and document at least 2 alternative approaches:

```markdown
## Alternatives Considered

### Alternative A: [Name]
- Pros: [benefits]
- Cons: [drawbacks]
- Why rejected: [reason]

### Alternative B: [Name]
- Pros: [benefits]
- Cons: [drawbacks]
- Why rejected: [reason]
```

This forces thinking beyond the first idea.
</step>

<step number="4" required="true" depends_on="3" blocking="true">
## Step 4: Propose Solution

Document the chosen approach:

```markdown
## Proposed Solution

### What Already Exists
[What existing code, flows, or patterns already solve part of this problem? Cite specific files/functions. If greenfield, state "N/A — greenfield, no existing code."]

[High-level approach]

### Key Changes
1. [Change 1]
2. [Change 2]
3. [Change 3]

## Success Metrics (Test Expectations)
Write as plain-language "when/then" statements — these become the test queue.
- [ ] When [action], then [expected outcome]
- [ ] When [action], then [expected outcome]
- [ ] When [action], then [expected outcome]

## Risks
- [Risk 1]: [Mitigation]
- [Risk 2]: [Mitigation]
```

<validation_gate name="solution-proposed" blocking="true">
**BLOCK if incomplete:**
- [ ] Solution clearly described
- [ ] Key changes listed
- [ ] Success metrics defined (measurable!)
- [ ] Risks identified with mitigations
</validation_gate>
</step>

<step number="5" required="true" depends_on="4">
## Step 5: Document Key Decisions

For each non-obvious choice, document in `decisions.md`:

```markdown
# {Feature Name} Decisions

## Decision 1: [Short Name]

**Question**: [What are we deciding?]

**Options**:
| Option | Pros | Cons |
|--------|------|------|
| A | ... | ... |
| B | ... | ... |
| C | ... | ... |

**Chosen**: [Option X]

**Rationale**: [Why this choice?]

**Trade-off accepted**: [What we're giving up]
```

WHY: Future-you needs to understand WHY decisions were made, not just WHAT was decided.
</step>

<step number="6" required="true" depends_on="5">
## Step 6: Initialize Implementation Tracker

Create `implementation.md`:

```markdown
# {Feature Name} Implementation

## Status: Not Started

## Test Queue (Beck's plan.md)
Ordered list of test expectations from design.md Success Metrics. Implement ONE at a time — write failing test, write minimum code to pass, then next.
- [ ] [Test expectation 1 — copied from Success Metrics]
- [ ] [Test expectation 2]
- [ ] [Test expectation 3]

## Execution Log

### Session N - [Date]
- [ ] [First task]
- [ ] [Second task]

## Files to Change
- `path/to/file.ts` - [what and why]

## Verification
- [ ] Dry-run completed (if batch operation)
- [ ] Tests written and passing
- [ ] Manual verification done
- [ ] Audit passed (if data change)

## Learnings
[To be filled as work progresses]
```
</step>

</critical_sequence>

<success_criteria>
## Spec Complete When ALL Are True

- [ ] All three files created (design.md, decisions.md, implementation.md)
- [ ] Problem statement is clear and specific
- [ ] At least 2 alternatives documented
- [ ] Solution has measurable success metrics
- [ ] Key decisions documented with rationale
- [ ] Implementation plan initialized
</success_criteria>

<decision_gate wait_for_user="true">
## Spec Created

Files created:
- `specs/{feature}/design.md`
- `specs/{feature}/decisions.md`
- `specs/{feature}/implementation.md`

What's next?
1. Begin implementation (recommended)
2. Review spec with user
3. Add more alternatives to consider
4. Run /batch if this involves bulk data changes
5. Other

Choose (1-5): _
</decision_gate>

<implementation_protocol trigger="user-chooses-1">
## Implementation Pre-Flight (MANDATORY before any code changes)

When user chooses "Begin implementation", execute these gates IN ORDER before touching any code:

<step name="read-plan" blocking="true">
### Gate 1: Read the Plan
- Read `specs/{feature}/implementation.md` — identify the FIRST uncompleted task
- Read `specs/{feature}/design.md` — refresh the problem statement and solution approach
- Output: "Starting task: {task description} from implementation.md"

**BLOCK**: Do not proceed if implementation.md has no uncompleted tasks.
</step>

<step name="read-targets" blocking="true" depends_on="read-plan">
### Gate 2: Read Target Files
- Read EVERY file listed in "Files to Change" that this task touches
- Output: "Read {file}:{lines} — current state: {brief summary}"

**BLOCK**: Do not edit any file you have not read in this step. This is CLAUDE.md Rule 4.
</step>

<step name="baseline" depends_on="read-targets">
### Gate 3: Baseline Check
- Run relevant tests or type checks (`npm run check`, `pytest`, etc.) BEFORE making changes
- Record: pass count, fail count
- Output: "Baseline: {X} pass, {Y} fail"

If baseline already has failures, note them so you don't chase pre-existing issues.
</step>

<step name="scope-check" depends_on="read-targets">
### Gate 4: Scope Gut-Check
After reading the target files, assess: is this task roughly as complex as the plan estimated?

- If YES → proceed to implementation
- If SIGNIFICANTLY harder → pause and tell the user: "This task is more complex than the spec estimated because {reason}. Options: (a) push through, (b) revise spec, (c) scale back scope."

This gate prevents the "45min on a 10min task" pattern.
</step>

After all gates pass → pick the next unchecked item from the Test Queue → write a failing test for it → write minimum code to make it pass → run all tests → mark it done in implementation.md → say "ready for next" and wait for user's "go". Do NOT work ahead of the queue. Watch for: functionality not asked for, unnecessary complexity, deleted/weakened tests (Beck's anti-cheat — CLAUDE.md Mistake Patterns).

### Post-Task Checklist
After EACH completed task:
- [ ] Tests pass (compare to baseline — no new failures)
- [ ] implementation.md updated (task marked complete, deviations noted)
- [ ] If task revealed design flaw → pause, tell user, offer to revise spec
</implementation_protocol>

## Templates

For file templates (design.md, decisions.md, implementation.md), read `references/templates.md`.

<integration_protocol>
## Integration Points

**Invoked by:**
- `/investigate` skill (after root cause identified, if fix is non-trivial)
- Manual invocation for new features
- Auto-suggested when user describes feature requirements

**Invokes:**
- `/batch` skill (if implementation involves bulk data changes)
- `/validate` skill (to verify implementation)
- Implementation pre-flight gates (when user chooses "Begin implementation")

**Handoff expectations:**
Creates `specs/{feature}/` directory with full documentation.
Implementation phase uses `implementation.md` to track progress.
</integration_protocol>
