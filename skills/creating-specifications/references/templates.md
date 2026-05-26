# Specification Templates

## design.md Template

```markdown
# {Feature Name} Design

## Problem Statement
[What problem are we solving? Why does it matter?]

## Current Behavior
[How does the system work today?]

## Proposed Solution
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

## Success Metrics
- [ ] [Measurable outcome 1]
- [ ] [Measurable outcome 2]
- [ ] [Measurable outcome 3]

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

## Execution Log

### Session N - [Date]
- [x] [What was done]
- [x] [What was done]
- [ ] [What remains]

### Session N+1 - [Date]
- ...

## Files Changed
- `path/to/file.ts:123` - [what and why]
- `path/to/file.ts:456` - [what and why]

## Verification
- [ ] Dry-run completed
- [ ] Sample reviewed
- [ ] Full execution done
- [ ] Audit passed

## Learnings
- [What worked well]
- [What didn't work]
- [Key insight for future]
```
