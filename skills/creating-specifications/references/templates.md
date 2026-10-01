# Specification Templates

## design.md Template

```markdown
# {Feature Name} Design

## Problem Statement
[What problem are we solving? Why does it matter?]

## Current Behavior
[How does the system work today?]

## Proposed Solution

### What Already Exists
[What existing code, flows, or patterns already solve part of this problem? Cite specific files/functions. If greenfield, state "N/A — greenfield, no existing code."]

[High-level approach]

### Key Changes
1. [Change 1]
2. [Change 2]
3. [Change 3]

## Alternatives Considered

### Alternative A: [Name]
- Pros: [benefits]
- Cons: [drawbacks]
- Why rejected: [reason]

### Alternative B: [Name]
- Pros: [benefits]
- Cons: [drawbacks]
- Why rejected: [reason]

## Success Metrics (Test Expectations)
Write as plain-language "when/then" statements — these become the test queue.
- [ ] When [action], then [expected outcome]
- [ ] When [action], then [expected outcome]
- [ ] When [action], then [expected outcome]

## Risks
- [Risk 1]: [Mitigation]
- [Risk 2]: [Mitigation]
```

## decisions.md Template

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

---

## Decision 2: [Short Name]
[Same structure...]
```

## implementation.md Template

```markdown
# {Feature Name} Implementation

## Status: [Not Started | In Progress | Complete]

## Test Queue (Beck's plan.md)
Ordered list of test expectations from design.md Success Metrics. Implement ONE at a time — write failing test, write minimum code to pass, then next.
- [ ] [Test expectation 1 — copied from Success Metrics]
- [ ] [Test expectation 2]
- [ ] [Test expectation 3]

## Execution Log

### Session 1 - [Date]
- [x] [What was done]
- [x] [What was done]
- [ ] [What remains]

### Session 2 - [Date]
- ...

## Files to Change
- `path/to/file.ts` - [what and why]        (planned)
- `path/to/file.ts:123` - [what and why]     (changed — add `:line` refs as work lands)

## Verification
- [ ] Dry-run completed (if batch operation)
- [ ] Sample reviewed (if batch operation)
- [ ] Full execution done (if batch operation)
- [ ] Tests written and passing (if code change)
- [ ] Manual verification done
- [ ] Audit passed (if data change)

## Learnings
- [What worked well]
- [What didn't work]
- [Key insight for future]
```
