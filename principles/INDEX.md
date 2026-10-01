# Principles index

Full-case-study principles, numbered P01–P22 in this public snapshot. The private OS numbers them differently, and `CLAUDE.md`, skills and hooks cite principles by that private number (e.g. "P68") — so each file's title carries both, and the table below maps one to the other.

| Public | Private | Principle |
|---|---|---|
| [P01](P01-conditional-capture-inversion.md) | P36 | Conditional capture near learning loops must be inverted |
| [P02](P02-right-context-token-shape.md) | P50 | Splitting similar-shape tokens — right-context carries the signal, not adjacency |
| [P03](P03-paired-semantics-drift.md) | P51 | Paired-semantics components drift silently |
| [P04](P04-artifact-self-identification.md) | P53 | Artifact self-identification — runtime config belongs in the artifact, not in the spec/filename/commit message |
| [P05](P05-mature-prompt-non-locality.md) | P55 | Mature prompts exhibit non-locality |
| [P06](P06-strict-llm-vs-llm-ceiling.md) | P56 | Strict LLM-vs-LLM ceiling (~80-85% bound by labeler schema compliance) |
| [P07](P07-static-set-discriminators.md) | P58 | Static-set discriminators leak both directions |
| [P08](P08-directional-rules-bidirectional-gold.md) | P59 | Directional rules need bidirectional gold evidence before authoring |
| [P09](P09-cell-level-diff-on-marginal-movement.md) | P60 | Cell-level right-flip / wrong-flip diff before keep-vs-revert (on marginal aggregate movement) |
| [P10](P10-llm-judge-run-disagreement-as-escalation-signal.md) | P61 | LLM-judge run-to-run disagreement is escalation signal, not noise |
| [P11](P11-spec-impl-async-drift.md) | P62 | Specs and implementation grow on independent timescales |
| [P12](P12-synthetic-smoke-defect-branches.md) | P63 | Synthetic smoke tests miss defect-rendering branches |
| [P13](P13-subagent-brief-production-artifact.md) | P64 | Parallel sub-agent briefs are part of the work product |
| [P14](P14-right-size-review-slate.md) | P65 | Right-size `/review` (and any multi-reviewer slate) to diff *shape*, not workflow-gate heuristic firing |
| [P15](P15-backfill-greenfield-asymmetry.md) | P66 | Backfill-vs-greenfield asymmetry |
| [P16](P16-hash-seed-iteration-order.md) | P67 | Hash-seed iteration order leaks into production writes |
| [P17](P17-skills-universal-by-construction.md) | P68 | Skills and hooks are universal by construction |
| [P18](P18-convergent-review-subject-fix.md) | P69 | Convergent /review = subject-level fix signal |
| [P19](P19-agent-tool-subscription-nesting.md) | P70 | Agent-tool subagents: subscription billing + nesting (≤5 deep) |
| [P20](P20-bulk-llm-positional-drift.md) | P71 | Bulk LLM row-emission drifts out of positional alignment |
| [P21](P21-falsifiable-independent-checks.md) | P72 | A verification/gate check must be FALSIFIABLE |
| [P22](P22-cite-strings-not-coordinates.md) | P74 | Cite a searchable string, never a coordinate |
