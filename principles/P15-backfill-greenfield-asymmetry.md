# P15 (private P66) — Backfill-vs-greenfield asymmetry

> Externalized 2026-07-04 (S44 Fable-5 audit). CLAUDE.md retains the inline T1 trigger + T2 rule; this file preserves the full pre-audit principle text verbatim.

**Applies to**: rule changes / migrations / backfills applied to data with accumulated state (manual fixes, prior pipeline outputs, cached signals).

## Full text (verbatim from CLAUDE.md as of 2026-07-04)

> **Backfill-vs-greenfield asymmetry** — rule changes / migrations tested on fresh greenfield input may regress on data with accumulated state (manual fixes, prior pipeline outputs, cached signals). Greenfield unit tests are necessary but insufficient. Mitigation: dry-run probe against actual current state before any backfill; verify per-record diffs show no regression class. Detection: post-deploy regression that "couldn't happen because tests are green" → test inputs lacked accumulated-state shapes. Distinct from P63 (output-branch gap) — P66 is *input-state* gap (e.g. a fix passing 188 unit tests; dry-run on accumulated state surfaced 1 wiped manual-override + 2 duplications).
