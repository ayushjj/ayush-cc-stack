---
name: creating-specifications
description: Create structured design documentation before implementing features. Use for new features, significant refactoring, or work spanning multiple sessions. Triggers on "new feature", "implement", "build", "design", "spec", "plan the implementation".
preconditions:
  - Feature or change is non-trivial
  - Not a simple bug fix (for bugs: Rule 0 INVESTIGATE — one concrete example + root cause first)
  - Scope is understood at least at high level
  - Premises validated (run /premise-check if "should we build this?" is unclear)
---

# Creating Specifications

Use this skill BEFORE implementing any non-trivial feature, especially when trade-offs need to be explicit. Creates structured documentation that persists across sessions.

## Usage

```
/creating-specifications {feature-name}
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

Fill the **Problem Statement + Current Behavior** section of `design.md` (full template: `references/templates.md`).

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

Research and document at least 2 alternative approaches. Fill the **Alternatives Considered** section of `design.md` (`references/templates.md`).

This forces thinking beyond the first idea.
</step>

<step number="4" required="true" depends_on="3" blocking="true">
## Step 4: Propose Solution

Document the chosen approach. Fill the **Proposed Solution** section of `design.md` — including *What Already Exists*, *Key Changes*, *Success Metrics (Test Expectations)* written as when/then statements, and *Risks* (`references/templates.md`).

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

For each non-obvious choice, document in `decisions.md` using the **Decision** block (`references/templates.md`).

WHY: Future-you needs to understand WHY decisions were made, not just WHAT was decided.
</step>

<step number="6" required="true" depends_on="5">
## Step 6: Initialize Implementation Tracker

Create `implementation.md` from the template (`references/templates.md`) — initialize **Status**, seed the **Test Queue (Beck's plan.md)** from design.md's Success Metrics, and set up the **Execution Log**, **Files to Change**, and **Verification** sections.
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
4. Run /executing-batch-operations if this involves bulk data changes
5. Other

Choose (1-5): _
</decision_gate>

<implementation_protocol trigger="user-chooses-1">
## Implementation Pre-Flight (MANDATORY before any code changes)

If the user chooses **(1) Begin implementation** → this is MANDATORY: read and execute the gates in `references/implementation-protocol.md` **IN ORDER** before touching any code (Gate 1 Read Plan → Gate 2 Read Targets → Gate 3 Baseline → Gate 4 Scope Gut-Check, then the Beck test-queue loop + post-task checklist).
</implementation_protocol>

## Templates

- File templates (design.md, decisions.md, implementation.md) → `references/templates.md`
- Implementation pre-flight gates → `references/implementation-protocol.md`

<integration_protocol>
## Integration Points

**Invoked by:**
- Investigation flow (Rule 0 INVESTIGATE — after root cause identified, if fix is non-trivial)
- Manual invocation for new features
- Auto-suggested when user describes feature requirements

**Invokes:**
- `/executing-batch-operations` skill (if implementation involves bulk data changes; its Step 6 query-correctness validation verifies the implementation)
- Implementation pre-flight gates (when user chooses "Begin implementation")

**Handoff expectations:**
Creates `specs/{feature}/` directory with full documentation.
Implementation phase uses `implementation.md` to track progress.
</integration_protocol>
