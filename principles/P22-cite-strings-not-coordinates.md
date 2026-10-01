# P22 (private P74) — Cite a searchable string, never a coordinate

> Authored 2026-08-06 (S57) under the **probation clause** (governance.md admission rule #4): novel
> pattern, no prior firing history, so T3 externalizes here from day 1 and only T1+T2 land in
> `principles/INDEX.md`. Promotes off probation when cited in ≥2 sessions.

**Applies to**: any durable document that points into code or another document — CLAUDE.md files,
specs, decision records, MEMORY.md, learnings, commit messages, agent briefs.

## The rule

A `file:NNN` citation is **not falsifiable**. Follow it after the file has shifted and you land on
*a* line — always plausible, never self-evidently wrong. The reader has no signal distinguishing
"this pointer is stale" from "this rule was always nonsense," so the cost lands on a rule that is
usually still true.

A grep anchor is falsifiable by construction:

| | Rule still present, file shifted | Rule genuinely deleted |
|---|---|---|
| `design.md:44` | returns a wrong line, silently | returns a wrong line, silently |
| `grep 'Sonnet 4.6' design.md` | returns the right line | **returns nothing** |

The grep form self-verifies. The coordinate can only be checked by hand, which means in practice it
is never checked.

**Corollaries**

1. **Qualify the path when basenames repeat.** Two `design.md` files make a bare coordinate not just
   wrong but *coincidentally plausible* — it resolves cleanly against the wrong file, which reads as
   a near-miss rather than a broken link.
2. **Counts age identically.** "1,356 lines", "40,045 POI", "Session 53" are coordinates in time.
   Date-stamp them, mark them unverifiable, or drop them.
3. **Cross-repo citations are the worst class.** This repo's history cannot warn you when the other
   repo moves, and the other repo may sit on a non-default branch.
4. **Never duplicate live state into a file nobody edits per-session.** That is what makes an index
   rot; point at whatever already owns the state.

This is P72 (falsifiable checks) applied to documentation pointers — same test, different surface:
*can you construct a state in which this pointer visibly fails?*

## Evidence (S57, 2026-08-06)

Audited the six layered `CLAUDE.md` files in `[redacted]`, split from a single 45 KB
root the previous session. Every claim classified as **structure** (describes what/where things are)
or **convention** (describes how we decided to work). Then every structural claim was executed
against the repo.

| Claim type | Checked | Wrong |
|---|---|---|
| Convention / rule | ~40 | **0** |
| File-path assertion | 15 | 1 |
| Script existence | 7 | 0 |
| Line-number anchor | 4 | **3** |
| Count assertion | 2 | **1** (1 unverifiable) |

**Zero conventions were wrong.** All rot sat in pointers carrying a coordinate. The two files that
needed no edits at all (`pitch/`, `scripts/meetings/`) were the two that never described the repo —
only how to think inside it.

**The sharpest instance**: `data/CLAUDE.md` cited `design.md:84` for the `[redacted]`
fixture-seeding limit. There are two `design.md` files. The sentence lives in
`specs/[redacted]/design.md:84`; the root file puts `specs/cleaning-extraction/` in scope,
where line 84 is a diagram arrow. **The line number was correct — for the other file.** A session
following it lands on `▼` and concludes the rule was hallucinated, discarding a true, load-bearing
constraint (it is the S268 fix).

**Consistent-offset instance**: `design.md:44, :152` → actual `:35, :82, :143, :411`. Both off by ~9,
i.e. content inserted above. The rule never changed; only the coordinates did.

**The counter-example worth copying**: `~lines 366-1040 as of S229` — start exactly right, end 1047
vs 1040. It aged well *because it was hedged and dated*. It was the only structural claim in the set
that told the reader how much to trust it.

**Same disease one level up**: chasing a cross-repo `[redacted]:184` revealed MEMORY.md's project index
had 4 of 6 directory paths wrong — [redacted] recorded at `Desktop/` when it lives at `~/dev/`,
and two entries pointing at projects deleted months earlier. (`[redacted]:184` itself was exactly
correct, which is the point: the coordinate's correctness is unknowable without checking.)

Fixed in `[redacted]@de8c94d`.
