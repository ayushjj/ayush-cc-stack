# LLM Tuning Output Template

Create `specs/llm-tune-{feature}/decisions.md`:

```markdown
# LLM Tuning: {Feature}

## Test Cases
- Total: 50
- Clear positives: 15
- Clear negatives: 15
- Edge cases: 20

## Baseline
- Accuracy: X%
- Main failure patterns: [list]

## Approaches Tested

### Approach A: {name}
- Accuracy: X%
- Strengths: ...
- Weaknesses: ...

### Approach B: {name}
- Accuracy: X%
- Strengths: ...
- Weaknesses: ...

### Approach C: {name}
- Accuracy: X%
- Strengths: ...
- Weaknesses: ...

## Decision
Chosen: Approach {X}
Rationale: [why]
Trade-off accepted: [what we're giving up]

## Regression Tests Added
- [list of test cases added]
```
