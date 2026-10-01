---
name: premise-check
description: Establish that a problem is real and worth solving before any plan is written. Use when the request names a thing to build that does not yet exist and no evidence of the problem has been cited — before /creating-specifications, before entering plan mode, and before the confirm-approach bullets. Triggers on '/premise-check', 'should we build', 'is this worth it', 'validate the premise', 'do we need this'.
effort: high
---

# /premise-check — Premise Validation Before Planning

Challenge whether the problem is real, specific, and worth solving BEFORE entering plan mode.
This is NOT brainstorming (generating options). This is diagnosis (challenging assumptions).

## When to Use

- Before `/creating-specifications` for any non-trivial feature
- When you have an idea but aren't sure it's worth the effort
- When Rule 0 classifies work as PLAN and the problem isn't crystal clear
- When someone suggests "we should build X" and the response is enthusiasm rather than evidence

## Steps

### 1. Problem Statement

Ask (via conversation, not AskUserQuestion — keep it lightweight):
- "What problem are you solving?"
- "Who has this problem?" (be specific — a name, a role, a project)

If the answer is vague ("it would be nice to have..."), push: "Can you name a specific time this caused a real problem?"

### 2. Status Quo Challenge

- "What are you doing right now to handle this?" (even badly)
- "What does the workaround cost?" (time, complexity, errors)
- If the answer is "nothing" — that's a signal. Either the problem isn't painful enough, or the pain is invisible. Ask: "If this problem disappeared tomorrow, what would change in your day-to-day?"

### 3. Do-Nothing Test

- "What happens if we do nothing for 30 days?"
- If the answer is "nothing bad" — the premise fails. Document why and stop.
- If the answer is concrete pain — proceed.
- If the answer is "we miss an opportunity" — that's weaker than pain but can still pass. Ask: "What's the opportunity cost in concrete terms?"

### 4. Existing Code Check

Before proposing anything new, search for partial solutions:
- "Has someone already built this?" — check for existing tools, libraries, SaaS products, or adjacent codebases that already solve it before building from scratch.

```bash
# Search for related functionality already in the codebase
grep -r "{relevant_keywords}" --include="*.ts" --include="*.md" --include="*.js" -l
```

Surface what already exists. Often the answer is "extend X" not "build Y from scratch."

### 5. Premise Statement

Output explicit premises the user must agree with:

```
PREMISES:
1. [Problem X exists and costs Y]  — agree/disagree?
2. [Current workaround Z is insufficient because W] — agree/disagree?
3. [Building this is worth the complexity it adds] — agree/disagree?
```

If any premise is rejected → STOP. The feature doesn't earn its place. Document:
```
PREMISE CHECK: FAILED
Rejected premise: [which one]
Reason: [user's explanation]
Recommendation: [do nothing / revisit when X changes / alternative approach]
```

If all premises pass → proceed to `/creating-specifications`.
```
PREMISE CHECK: PASSED
Proceed to /creating-specifications with validated premises as input to the Problem Statement.
```

## Anti-Sycophancy (enforced during this skill)

- Take a position on every answer. Don't just ask questions — assess.
- If the premise is weak, say so directly: "This doesn't pass the do-nothing test because..."
- Don't soften: "This is wrong because..." not "You might want to consider..."
- Challenge the strongest version of the user's claim, not a strawman.
- It's OK to say: "I think this isn't worth building. Here's why."

## Gotchas

1. **"But it's easy to build" is not a premise.** Easy-to-build features still add maintenance burden, cognitive load, and surface area. The question isn't "can we?" but "should we?"
2. **Enthusiasm ≠ evidence.** Multiple people saying "that would be cool" is weaker than one person saying "I wasted 2 hours on this yesterday."
3. **Don't over-apply.** Quick bug fixes, config changes, and clearly-scoped improvements don't need premise validation. This skill is for features and new capabilities where "should we build this?" is genuinely uncertain.
