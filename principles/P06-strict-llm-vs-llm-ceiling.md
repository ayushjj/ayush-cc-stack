# P06 (private P56) — Strict LLM-vs-LLM ceiling (~80-85% bound by labeler schema compliance)

> Externalized from `~/.claude/CLAUDE.md` on 2026-04-29 as part of Phase 1 of the CLAUDE.md compression arc (background: `~/.claude/meta/claude-md-compression-arc.md`).
> T1 (recognition trigger) + T2 (rule body) remain inline in CLAUDE.md. T3 (worked-example evidence) lives here.
> Reversal: if the principle fails to fire on a real situation in a future session, copy the **Original verbatim text** section back inline into CLAUDE.md, delete this file, and append a one-line note to the compression-arc append-only log.

## Tier 3 — Evidence (externalized)

Three independent GT runs (web-aided / strict-textual / explicit-rules-with-itemgroup-routing-table) on the same 50-record 9-slot sample converged within ±5pp around 72-82% strict per-attribute; spec list-equality alone fixed at 16-44% regardless of GT methodology. When an "improve labeler/rules" hypothesis predicts headline movement and three labeler iterations move the headline <5pp on the same sample, the gate is bounded by labeler schema compliance, not extraction quality.

Implication operating consequences when this fires: ≥90% strict-per-attribute gates against LLM-as-GT are unachievable by tightening rules — either reframe to factual-coverage (slot-routing-blind Jaccard token overlap ≥85% on the union of all attribute slots), OR introduce human-validated holdout (10-15 carefully labeled records) as the actual reference, OR accept the ~82% bound as the gate.

Corollary: factual-coverage Jaccard (union of all extracted tokens, slot-routing-blind) is the right primary metric for extraction quality; strict per-slot is informational secondary.

Full session writeup preserved in private OS learnings.

## Original verbatim text (rollback source — do not edit)

> 56. Strict per-attribute LLM-vs-LLM is bounded ~80-85% by labeler schema compliance, not extraction quality. When evaluating an LLM extractor against an LLM-as-GT on per-field strict equality, two LLMs at temp 0 cannot produce schema-identical outputs reliably for free-form list fields (spec lists), range-vs-point dimension values, modifier/primary-noun routing, or any slot where multiple defensible representations exist. Evidence: three independent GT runs (web-aided / strict-textual / explicit-rules-with-itemgroup-routing-table) on the same 50-record 9-slot sample converged within ±5pp around 72-82% strict per-attribute; spec list-equality alone fixed at 16-44% regardless of GT methodology. Implication: ≥90% strict-per-attribute gates against LLM-as-GT are unachievable by tightening rules — either reframe to factual-coverage (slot-routing-blind Jaccard token overlap ≥85% on the union of all attribute slots), OR introduce human-validated holdout (10-15 carefully labeled records) as the actual reference, OR accept the ~82% bound as the gate. Detection: when an "improve labeler/rules" hypothesis predicts headline movement and three labeler iterations move the headline <5pp on the same sample, the gate is bounded by labeler schema compliance, not extraction quality. Applies to: ML eval harnesses with LLM-as-judge, classifier evaluation pipelines, batch extraction gates, RAG output verification, anywhere strict per-field equality is evaluated LLM-vs-LLM. Corollary: factual-coverage Jaccard (union of all extracted tokens, slot-routing-blind) is the right primary metric for extraction quality; strict per-slot is informational secondary.
