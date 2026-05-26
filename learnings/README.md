# Curated Case Studies

These 4 learnings are sanitized case studies from the author's working notes, selected as illustrative of patterns documented in the top-level `CLAUDE.md`. **This is NOT a full archive** — the author's complete `learnings/` directory has hundreds of entries; what's published here is the subset that survives sanitization without losing its lesson.

## Selection criteria

Each shipped learning satisfies all three:

1. The universal lesson survives removing identifying detail.
2. The lesson maps to a principle or mistake-table row in published `CLAUDE.md` (so adopters can trace provenance).
3. The story shape is illustrative — a structural lesson with detection patterns and a fix — not just "I fixed a bug."

## What's shipped

| File | Maps to | Class of lesson |
|---|---|---|
| [`2026-04-25-claude-md-governance-restructure.md`](2026-04-25-claude-md-governance-restructure.md) | Principle 51 (paired-semantics drift), `governance.md` § skill-coupling contracts | Structural restructure of an auto-loaded attention-prior document; how paired-component contracts surface only via pre-flight grep |
| [`2026-04-27-wrap-skill-reorder-attention-gates.md`](2026-04-27-wrap-skill-reorder-attention-gates.md) | Principle 57 (suggestion-based gates fail silently) | The founding incident: 4 unpushed commits across sessions because the proactive nudge depended on agent attention. Fix: bake the action into the skill. |
| [`2026-05-18-hook-migration-phase-0-1.md`](2026-05-18-hook-migration-phase-0-1.md) | Principle 57 deepening + Workflow Gates table | Migration from suggestion-based gates to hard hooks. Smoke-test-before-wire workflow; the latent eval-first glob false-negative caught after 30 days. |
| [`2026-04-22-claude-md-compression-first-principles-reset.md`](2026-04-22-claude-md-compression-first-principles-reset.md) | Mistake row "Compressed growth-prone persistent file without growth-rate governor" + Adding to This File framework | Compression ≠ deletion. Dispositional frames are operationalizable. The governor must live at write-path, not retrospective prune. |

## Why so few?

The publishing premise: "1 beneficiary = win." A small, hand-curated set of stories with clear lessons beats a 100-entry archive with mixed signal/noise. Adopters who want more depth should read the principles themselves (`../principles/`) — those are where the patterns live, with shorter T1 + T2 inline in CLAUDE.md and full T3 worked examples in the 10 externalized files.

## How to read these

These are not tutorials. They are post-mortems written for the author's own future reference, lightly sanitized for public release. Sections like "What Worked", "What Didn't Work", "Key Insight", "Files Changed", "Metrics" follow a consistent shape — borrowed from blameless-post-mortem practice and adapted for solo-developer reflection.

If a section feels too project-specific to be useful, the **Key Insight** section is the highest-leverage part. The rest is supporting evidence.

## What's NOT here

- All "Session N" / "Phase X" project-specific incident archives — these stay private (the lessons are abstracted into principles instead).
- Recent multi-session meta-work (audits, refactors of the OS itself) — too self-referential to land for adopters.
- Anything where sanitization would gut the structural lesson — explicitly omitted rather than published as a hollow shell.

Adopters maintaining their own version should follow the same pattern: capture liberally in private; ship sparingly.

## Cross-references

- `../CLAUDE.md` § Principles — the abstracted patterns
- `../CLAUDE.md` § Mistake Patterns — the firing ledger
- `../governance.md` § Skill-coupling contracts — the maintainer-side artifact spawned by the governance-restructure learning
- `../principles/P01` through `P10` — the 10 externalized worked-example files
