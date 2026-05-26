---
name: audit-project
description: Use when auditing a project's AI product maturity or pre-flighting a new feature against completeness dimensions. Triggers on '/audit-project', 'completeness check', 'project audit', 'pre-flight', 'ready to ship?'.
user_invocable: true
---

# /audit-project — AI Product Completeness Audit

Evaluate a project against 9 dimensions of AI product completeness, citing file evidence from the actual project.

## Modes

- **Whole-project audit**: `/audit-project` — evaluate all 9 dimensions
- **Feature pre-flight**: `/audit-project --feature "description"` — check a specific feature against relevant dimensions

## Step 1: Read Checklist + Graph

1. Read `~/desktop/knowledge-graph/checklists/ai-product-completeness.yaml` — the checklist definition
2. Read `~/desktop/knowledge-graph/graph-index.yaml` — for insight references and cross-links

## Step 2: Determine Mode

**If `--feature` is provided:**
- Parse the feature description
- Select the 3-5 most relevant dimensions for that feature type:
  - Code changes → Quality & Verification, Safety & Guardrails, Observability
  - New agent capability → Agent Runtime, Context & Memory, Safety & Guardrails
  - Data pipeline → Data & Learning, Observability, Quality & Verification
  - User-facing feature → Product & Market, Architecture Patterns, Team & Process
  - Infrastructure → Agent Runtime, Architecture Patterns, Observability
- Skip irrelevant dimensions entirely (don't evaluate all 9 for a focused feature)

**If no `--feature`:**
- Evaluate all 9 dimensions

## Step 3: Scan Project Evidence

Scan the target project for evidence. Read these files (if they exist):

| File/Pattern | What to look for |
|---|---|
| `CLAUDE.md` | Agent instructions, routing, skills references |
| `.claude/` directory | Memory files, skill definitions, settings |
| `package.json` / `Gemfile` / `requirements.txt` | Dependencies, scripts, test commands |
| CI config (`.github/workflows/`, `.gitlab-ci.yml`) | Quality gates, automated checks |
| Test files (`*test*`, `*spec*`, `*.test.*`) | Test coverage, test patterns |
| README.md | Architecture description, setup instructions |
| Source structure (top-level `ls`) | Project organization |

Use Glob to find files, Read to examine them. Do NOT read every file — scan strategically based on which dimensions you're evaluating.

## Step 4: Evaluate Each Dimension

For each dimension being evaluated, go through every item and assess:

**Present** — Clear evidence in the project files. Cite the file and relevant content.
**Partial** — Some evidence but incomplete. Explain what's there and what's missing.
**Missing** — No evidence found. State what would need to be added.
**N/A** — Not applicable to this project type. Briefly explain why.

For each item, reference the `check` question from the YAML and answer it with evidence.

## Step 5: Score and Report

### For whole-project audit:

```
# AI Product Completeness Audit
**Project:** {project name}
**Date:** {date}

## Scorecard

| Dimension | Score | Verdict |
|-----------|-------|---------|
| Agent Runtime | X/Y | {Strong / Adequate / Weak / N/A} |
| Context & Memory | X/Y | ... |
| Quality & Verification | X/Y | ... |
| Safety & Guardrails | X/Y | ... |
| Observability | X/Y | ... |
| Data & Learning | X/Y | ... |
| Product & Market | X/Y | ... |
| Architecture Patterns | X/Y | ... |
| Team & Process | X/Y | ... |

**Overall:** X/Y items present ({percentage}%)

## Dimension Details

### 1. Agent Runtime (X/Y)
- [Present] **Agent harness**: Evidence in CLAUDE.md:3 — skills routing table...
- [Missing] **Sandbox / isolation**: No containment boundaries found...
...

## Top 3 Gaps (Highest Impact)
1. **{gap}** — Why it matters, what to do
2. ...
3. ...

## Recommendations
- ...
```

### For feature pre-flight:

```
# Feature Pre-Flight: {feature description}
**Relevant dimensions:** {list}

## Checklist

### {Dimension 1}
- [x] **{term}**: {evidence}
- [ ] **{term}**: Missing — {what to add}
...

## Before Shipping
1. {specific action item}
2. ...
```

## Scoring Rules

- **Present** = 1 point
- **Partial** = 0.5 points
- **Missing** = 0 points
- **N/A** = excluded from denominator

Verdicts:
- **Strong**: >= 80% of applicable items present
- **Adequate**: 50-79%
- **Weak**: < 50%

## Important Constraints

- This skill is **purely evaluative** — it does NOT create or modify files
- Always cite specific files and line numbers as evidence
- If a project has no AI/agent components, say so upfront — the checklist may not apply
- For feature pre-flight, keep the output focused — don't pad with irrelevant dimensions
- When an insight slug is referenced in the checklist, you may mention it as context for WHY an item matters, but the evaluation is about the project, not the graph
