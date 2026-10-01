---
name: wrapping-session
description: Save session state so the next /catchup starts cold. Updates docs/MEMORY/registry, then commits + pushes project repo (one commit per wrap) and syncs ~/.claude. Triggers on "wrap up", "end session", "done for today", "session complete", "/wrap".
preconditions:
  - Significant work session has occurred
  - Work to preserve for next session
---

# Wrapping Session

**This skill has ONE job**: make sure the next session's `/catchup` + auto-loaded `claudeMd` has everything it needs to start cold. Every step below traces to something `/catchup` or `claudeMd` consumes. Steps that don't serve this goal have been intentionally cut.

If nothing meaningful happened this session, say so and skip — don't create empty artifacts.

**Ordering principle**: write all artifacts first, commit once at the end. The earlier shape (commit-then-document) structurally orphaned the spec/plan/learnings/telemetry every wrap because Steps 2-5 wrote project-repo files AFTER Step 1's commit. One commit per wrap = one grep hit per session for `/catchup` readers.

## Wrap-trigger gate (runtime, not attention-based)

`~/.claude/hooks/context-wrap-trigger.js` (registered as `UserPromptSubmit`) reads token usage from the live transcript every prompt and injects a system-reminder when consumed crosses 35% / 45% / 60%. This converts the historic "Claude should remember to suggest /wrap at 40% consumed" disposition into a deterministic gate — root-cause fix for a prior context-overflow incident where the suggestion never fired, the wrap started past 60% consumed, ran out of context mid-flight, and the wrap-marker hook (correctly) blocked `/compact` while the user couldn't issue commands to override.

When you see a `CONTEXT WRAP-TRIGGER` reminder, the right response is:
- **SOFT (35%+ consumed)**: surface a one-line nudge to the user, finish your current sub-task, then propose wrap.
- **HARD (45%+)**: invoke `/wrapping-session` after at most one tightly-scoped completion (<5 min). No new investigation/refactor/multi-step work past this point.
- **EMERGENCY (60%+)**: invoke `/wrapping-session` immediately and **compress aggressively** — singleton-required updates only (MEMORY.md Current State + session-registry + one commit), skip full implementation.md/decisions.md/learnings narrative. The prior context-overflow deadlock IS the precedent for what happens if you don't.

Override (only when you genuinely need to push past — e.g., a long-running smoke is mid-flight): `CLAUDE_CONTEXT_GATE_QUIET=1`.

## Step 0: Mark wrap-in-progress (auto-compact suppression)

Before writing any artifacts, drop a marker file the `precompact-guard.js` hook checks. While the marker exists AND identifies a live owning Claude process, auto-compaction is blocked — protects multi-step wraps from being silently truncated mid-flight.

```bash
WRAP_MARKER="$HOME/.claude/.wrap-in-progress$(pwd | sed 's|/|-|g')"
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"
```

The marker is per-project (slug derived from cwd) so parallel wraps in different project sessions don't cross-block. Marker contents = `{owner_pid}\t{owner_start_time}` — `$PPID` inside a Bash tool invocation resolves to the parent Claude process; `lstart` is its start time and defeats PID recycling. The hook verifies the owning process is still alive (`ps -p $pid -o lstart=` matches the recorded value) AND mtime <10 min. **Two independent liveness signals**:

1. **PID + start-time fingerprint** — when the owning Claude exits (clean or crashed), the hook detects this on the next /compact and clears the marker immediately. No more 10-minute waits to escape orphan markers.
2. **mtime TTL (10 min)** — backstop for any case the PID check can't decide (e.g., legacy 0-byte markers from earlier wrap versions still in flight during an upgrade). If marker is malformed, behaviour degrades gracefully to the original mtime-only blocking.

**Refresh contract**: prose-heavy wrap steps (1a / 2 / 4 / 5) routinely take >10 min combined; under mtime-only blocking the marker would auto-expire mid-wrap, the precompact-guard would stop blocking, and the next auto-compact trigger would kill the wrap mid-step. Root cause: TTL (10 min) < wrap duration (~15 min). Fix: **every numbered step below begins by re-writing the marker as its first action** (also refreshes mtime). Active wraps stay fresh by writing; crashed wraps are detected by the PID check (no longer require waiting for mtime to age out). If you find yourself skipping the marker write "to save a tool call", you've reintroduced the bug.

**Step 9 (last action) deletes this marker** — see bottom of skill.

## Step 1: Update Implementation Docs

**Spec-primary pattern**: when the session worked on a feature with an active `specs/{feature}/implementation.md`, that file is authoritative for per-feature detail (task boxes, verification checklists, metrics, gate outcomes). The global `docs/IMPLEMENTATION-PLAN.md` is a phase-level dashboard — one-line status + pointer to the active spec. Do NOT duplicate per-session narrative into both files; that produces bloat that Session-N cleanup later has to undo.

### 1a: Spec Files (PRIMARY when active)

```bash
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"  # marker refresh — see Step 0 refresh contract
```

If the session worked on a feature tracked by `specs/{feature}/*.md`, update these FIRST:
- `implementation.md` — task boxes, verification checklists, metrics tables, gate outcomes with specific numbers, session outcome record (see **session-outcome shape** below)
- `decisions.md` — every decision taken this session is a D-entry, written at decision time, not at wrap (a wrap-time D-entry is flagged as such inside the entry)
- `design.md` — update if the session changed what the design doc describes. Where a `design.md` carries a `## Current state on <deploy branch>` section, refresh it: one paragraph per shipped surface, its ref, and a pointer to the plan file that built it.
  - 🔴 **[redacted] only — MANDATORY, not conditional (owner, S381 2026-09-06).** In that repo, refresh `design.md` every wrap and whenever a D-entry lands mid-session, whether or not the session judges its change architectural. The conditional wording that stood here let `specs/18-…/design.md` go 60 decisions stale while every session judged its change page-level — the exact failure line 119 below describes. **Scoped to [redacted] 2026-09-17** (P68): the rule was bought by one repo's incident and was firing in every project from this global skill, forcing a mandatory refresh on specs that had never had the failure.
- `implementation.md` has ONE status surface (the Session Outcome Record at the head). Delete any second `## Status:` line rather than leaving it frozen.
- `inversion-checklist.md` (or feature-specific equivalents) — update if the checklist's premise changed

**Session-outcome shape for `implementation.md`** (mandatory; codified to prevent prepend-bloat after a wrap-bloat compression audit identified multi-paragraph blockquotes as the largest single contributor to wrap-time-bloat; sharpened after a subsequent wrap-time analysis identified D-entry-content-restated-in-bullet as the residual driver):

The current session's outcome record goes UNDER a `## Session Outcome Record (Latest)` heading at the head of `implementation.md`. **Shape: bullet list, NOT multi-paragraph essay.** ≤15 bullets covering "what landed" (D-entries shipped/parked, code paths, gate outcomes, metrics) plus a `→ learnings/path.md` pointer for full narrative.

**Char budget — ≤2500 chars, ENFORCED at Step 7a.** The `verify_wrap_artifacts.py` check runs twice: Step 5.5 (WARN — write-time early warning) and Step 7a (`--strict` — a FAIL blocks the commit). Don't trim in circles to satisfy it: overflow means narrative in a summary slot — route it down. 2500 is the single working limit (there is NO separate 2000/80% target — that duality caused over-trimming). ~14-18 bullets @ ~140 chars. If a draft runs over, the overflow is *narrative in a summary slot* → **route it down to `learnings/{date}-session{N}-*.md` (the canonical, uncapped tier), don't compress it away.** Heavy sessions landing at 2200-2400 are fine.

The full session narrative belongs in `learnings/{date}-session{N}-*.md` — that's the canonical tier; the spec only needs the landed-state summary so spec readers can answer "what's true now?" without wading through prose.

**Bullet shape — headline + pointer, NOT restated D-entry content**:

D-entry bullets are the largest single source of duplication-tax. The D-entry in decisions.md already carries the canonical Why / Why-rejected table / How prose. Repeating any of that in the impl.md bullet is wasted bytes paid every wrap and every catchup-load.

❌ **Anti-shape** — 150+ chars, restates D-entry body:
> - **D{N} SHIPPED**: {rule-name} {full implementation summary}. `_internal_helper_name` {behavior detail copied from decisions.md How section} (generalized from {prior shape} per {recent user request}). {Acceptance metric}/{total} smoke pass; retroactive replay catches {N} flagged FPs ({record-id-a}, {record-id-b}; {record-id-c}) with {N} false-suppressions on {batch-id-a}/{batch-id-b} genuine fires.

✅ **Target shape** — ≤80 chars headline + pointer, defers prose to canonical D-entry:
> - **D{N} SHIPPED** — {3-8 word outcome headline}. {metric}/{total} smoke pass. → see decisions.md D{N} (Why/How/Acceptance).

The headline+outcome stays load-bearing for `/catchup` (which reads this file as Step 1.4a); the architectural rationale paragraphs live ONLY in decisions.md where they belong. **Never restate** Why-rejected tables, alternative options, or paragraph-form How prose in this bullet — pointer them.

Code-path bullets / gate outcomes / metrics follow the same headline+pointer discipline:
> - **{script_name}.py**: {consumer-or-feature} wired ({input-shape} ↔ {output-shape}). {metric}/{total} deterministic on {batch-id}.
> - **{Gate-name} trajectory**: {b-N} {pct%} → {b-N+1} {pct%} → {b-N+2} {pct%}. Dip = {1-line cause summary}. → see learnings/ for analysis.

```
## Session Outcome Record (Latest)

> **Session N (YYYY-MM-DD) — {3-12 word headline}**:
> - **D{N} SHIPPED** — {≤60 char what-landed}. → see decisions.md D{N}.
> - **{Code path or gate}** — {≤60 char outcome + metric}.
> - ...
> - **Read first**: `learnings/YYYY-MM-DD-sessionN-{topic}.md` (full narrative).
```

**Before writing**, demote the previously-current entry to `### Prior Sessions (compact pointers; full narrative in learnings/)` by compacting it to ONE LINE with `→ learnings/` pointer:

```
> **Session N (YYYY-MM-DD)**: 3-12 word headline + 1-3 key metrics. → `learnings/YYYY-MM-DD-sessionN-{topic}.md`
```

If the head has 2+ session blockquotes (or one >2500-char blockquote) when this wrap starts, that's a regression — compact ALL but the most recent before writing the new entry. Detection: project-local `scripts/verify_implementation_singleton.py` (asserts exactly 1 blockquote in head + exactly 1 Prior Sessions header) AND `verify_wrap_artifacts.py` (asserts head blockquote ≤2500 chars / ≤30 lines). Both invoked as hard gate at Step 7a.

**MUST-PRESERVE invariants** (the bullet shape preserves these structurally; do not omit):
- `## Session Outcome Record (Latest)` header line stays verbatim (singleton verifier anchors on it).
- `### Prior Sessions` header line stays verbatim (singleton verifier anchors on it).
- Latest blockquote contains a `→ learnings/path.md` link line (catchup default mode follows this for narrative).

Section-level outcomes (§3.4b smoke outcome, Gate 1 v5 outcome, etc.) live UNDER their section in the body, NOT prepended to the head.

Progressive disclosure rationale: load surface = Status block + latest session detail; navigation tier = one-line entries with click-through; deep tier = `learnings/`. Implementation.md must read as a plan, not a session journal.

Signal that a spec is "active" = `specs/{feature}/implementation.md` exists AND the session's code changes touch files referenced by that spec (scripts, data paths, prompts the spec describes).

Skip this sub-step only if no feature spec covers the session's work.

⚠️ **When you skip it, decisions still have to land somewhere.** Sessions with no feature spec — global/`~/.claude` OS-meta work, tooling evaluations, cross-project research — take real decisions that produce no diff and therefore no D-entry. For those, the `## Decisions` section of the Step 2 learnings file is the canonical home, and Step 2 is **not optional** for them. (Codified 2026-08-06 after S55's entire tooling decision set — Exa adopted, lumen withdrawn on evidence, Greptile dropped, context7 approved-not-installed, Copper's pricing left open — survived in neither the registry nor the learnings file, because this walkthrough was correctly skipped and nothing downstream covered the gap.)

#### Decisions-migration walkthrough (mandatory yes/no per item)

Implementation.md is the path of least resistance — every wrap touches it. Architectural decisions silently accumulate as session-narrative there instead of being promoted to first-class entries in decisions.md / design.md, leaving spec files stale for many sessions while implementation.md becomes a kitchen sink.

Before completing Step 1a, walk through this session's changes and answer **explicitly yes or no** for each — not by reflex, by recalling specific moves:

1. **Architectural / structural decision landed?** (e.g., a new pipeline stage, a new layer-policy, a fundamental approach choice, a supersession of a prior decision) → if YES, **VERIFY** the D-entry already exists in `decisions.md` with full shape (follow the project's D-entry template: `## D{N}: {name}` heading + Why prose + `| Option | Why rejected |` table + How section + acceptance criteria/source URL when applicable). If the D-entry is **NOT yet authored**, that is an **in-session-authoring violation** per the project's D-entry authoring rule (D-entries authored at decision-time, not batched to wrap) — author the D-entry NOW under wrap-time pressure (acknowledged as worse-prose-at-higher-cost than at-decision-time authoring) AND add today's mistake-table entry citing the violation. Detection mechanism: `git log --diff-filter=A -p specs/<feature>/decisions.md` against this commit's parent — D-entries appearing only in wrap commit = violation. Do NOT just write the decision into implementation.md narrative.
2. **Pipeline-shape, schema, or interface change landed?** (e.g., new artifact field, new stage in the diagram, new dataflow, schema deltas) → if YES, update `design.md` — either inline if the change is small and locked-design-compatible, or via a Status Addendum section if the change extends/conflicts with locked design and a re-lock is deferred.
3. **Checker rule, contract amendment, or new check added?** (for projects with an `inversion-checklist.md` or equivalent verification spec) → if YES, update that spec — add the rule with proper category/spine/crown markers; do not let it live only in implementation.md or commit messages.
4. **Otherwise** (execution narrative, metric tables, gate outcomes, session-tied tactical outputs) → implementation.md as session outcome record (default).
5. **Open question being PARKED (not decided this session)?** → if YES, use **stub shape only** in `decisions.md`'s `## Open Questions` section; do NOT author full alternatives/decision-inputs/forward-action prose at park time. (Sharpened after a parked open-question received ~700 chars of full prose at park-time, then the next session's NEXT field re-summarized it — wrong-tier authoring.)
   - **Stub shape** (≤80 chars total at park-time):
     ```
     ## OQ-NNN-N: {short name describing the question}
     → See S{N+1} for structural decision when surfaced.
     ```
   - **Full shape** (structure with `### What`, `### Alternatives`, `### Decision Inputs`, `### Forward Action` subsections) is authored ONLY in the session that actually decides — the live context for tradeoff analysis exists then, not at park-time.
   - Detection if violated: any new `## OQ-NNN-N:` heading at this wrap with > 1 subsection beneath it AND no D-entry promotion in this same commit. That's park-time over-documentation.

The yes/no must be answered specifically, not generically — name the decision/change/rule. If the answer is yes for items 1–3, the spec file update is part of THIS wrap, not deferred to "next session." Deferring is what produced the freeze.

**If you find a multi-session backlog** (the spec files have not been updated in N sessions while implementation.md has): do not retroactively rewrite the locked-design body — instead, add a "Status Addendum" section to each frozen file pointing to (a) what's still accurate, (b) what's been superseded since the freeze, (c) where authoritative current-state lives. Promote durable past-session decisions to first-class D-entries in decisions.md with explicit "(decision of Session N, added retroactively)" markers. The integrity-pass shape: addendum + cross-refs, not silent rewrite.

### 1b: IMPLEMENTATION-PLAN.md (dashboard)

```bash
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"  # marker refresh
```

If `docs/IMPLEMENTATION-PLAN.md` exists, update with a **phase-level summary only**:
- Status line (line 3, `> **Status**:`) — one sentence: current phase + headline state + next decision point. **Char cap: ≤400 chars.** Sharpened after a status line ran ~1500 chars restating D-entry content (P57 — "one sentence" was attention-only).
- Active-spec pointer — one line: which `specs/{feature}/` is authoritative for detail
- `Last Updated` date
- Blockers — add or resolve (cross-feature blockers only; feature-specific blockers live in the spec)

**Headline + pointer discipline (same as Step 1a / Step 4)**:

❌ **Anti-shape (~1500 chars)**:
> **Status**: Phase {N} — S{N} LANDED; {M}/{total} units done. {batch-id-a} + {batch-id-b} dispatched ({domain}; {acceptance} OK across both). **D{N}/D{N+1}/D{N+2} + {codebook} v{X.Y} shipped**: D{N} {full rule restatement} (generalized from {prior shape}); D{N+1} {policy restatement} (...); D{N+2} {coverage restatement} (...). [...]

✅ **Target shape (~280 chars)**:
> **Status**: Phase {N} — {M}/{total} units done. S{N} shipped D{N}/D{N+1}/D{N+2} + {codebook} v{X.Y}. Next decision: S{N+1} {batch-id-next} dispatch ({gate} trajectory check). Last Updated: YYYY-MM-DD. Active spec: `specs/<feature>/` (impl.md S{N} entry; `learnings/YYYY-MM-DD-sessionN-{topic}.md`).

**Do NOT write**:
- Multi-paragraph session-delta narrative (that belongs in the spec's implementation.md or `learnings/`)
- Task-level detail that duplicates the active spec's implementation.md
- Metrics tables (those live in the spec)
- D-entry body content (Why/Why-rejected/How prose) — pointer to decisions.md

**Prior-session Status entries**: when this wrap's status line replaces the prior session's, **demote the prior entry** to a single-line pointer in a `### Prior Status Entries (compact)` section if you want to keep it; do NOT leave multi-paragraph blockquotes accumulating at the top of IMPLEMENTATION-PLAN.md (a prior accumulation pattern left ~12 such blockquotes before being caught; a separate cleanup pass should compress them).

The dashboard answers "what phase are we in, what's the decision point, where is detail?" — nothing more.

**Why**: `/catchup` prefers the active spec when present, falls through to global plan only for unscoped work. Bloating the global plan with session narrative forces re-reading old sessions' detail at every catchup and eventually requires manual cleanup (see Session-37-style deferred review).

## Step 2: Capture Learnings (gated)

```bash
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"  # marker refresh
```

Create `<project-root>/learnings/{date}-{topic}.md` (project-root-relative; not under the auto-memory dir) ONLY if the session produced a **non-obvious discovery** worth capturing:
- A pattern that worked that wouldn't be obvious from the code
- A failed approach that future-you might retry
- A metric or insight that changes how we think about the problem
- **A decision that changed what we will or won't do — even if it produced no file.** Tool adopted/rejected, approach withdrawn on evidence, option ruled out. These leave no diff, so nothing else in this wrap captures them.

Skip for routine sessions. Use the standard format:

```markdown
# Session: {date} - {Topic}

## Decisions
<!-- MANDATORY section. Write "None this session." if there were none — silence is not an answer. -->
- **{thing}** — {ADOPTED | REJECTED | WITHDRAWN | OPEN}: [one line of why] · Evidence: [source] · Acted on: [yes / no — not installed / n/a]

## What Worked
- [Specific pattern with data]

## What Didn't Work
- [Approach]: [Why it failed]

## Key Insight
[Non-obvious, actionable advice to future-self]

## Files Changed
- `path/to/file:line` - [What and why]

## Metrics
- Before: [state]
- After: [state]
```

**Budget caps for the learnings file (mandatory; codified after a wrap-time analysis surfaced learnings as the largest single time sink at ~5 min for 280 lines / 12KB)**:
- ≤150 lines / ≤8KB total. The template above produces ~50-80 lines for most sessions; 150+ means you've drifted into prose.
- ≤3 entries under `## Key Insight` (rename heading to `## Key Insights` if more than one). Pick the three MOST non-obvious; the tail of "5 insights" is usually obvious-in-retrospect or restating the architecture.
- **`## Decisions` is one line per decision, and is never dropped for length.** It is the cheapest section in the file and the one that vanishes everywhere else — cut prose from What Worked before cutting here. Decisions with no D-entry and no diff (tool adopted/rejected, approach withdrawn) are exactly what it exists for.
- **No D-entry duplication**: this constrains the Why/How *prose*, not the `## Decisions` one-liner — a shipped D-entry still gets its line there, pointing at `decisions.md D{N}`. If the session shipped a D-entry in `decisions.md`, the learnings file REFERENCES it (`→ See decisions.md D{N} for Why/How/Detection-if-wrong`) instead of restating that content. The D-entry is canonical for architectural decisions; the learnings file is for non-D-entry insights — process surprises, failed approaches, metrics, what-future-you-should-do-differently.
- No `## Forward Concerns` section by default — that content belongs in the session-registry `next` field (which `/catchup` reads verbatim). Add Forward Concerns only when the session leaves >3 things to watch AND they don't all fit in `next`.

If your draft exceeds the cap, you've drifted into prose. Compress to bullets; the skill template's structure is the budget, not a starting point.

### 2a: Append the index row — in THIS step, never a separate one

If `<project-root>/learnings/INDEX.md` exists, append its row **as part of writing the learning
file above**, before moving on. Projects without an INDEX.md skip this silently — it is opt-in per
repo, not a new universal requirement.

```
| {N} | {YYYY-MM-DD} | `tag` `tag` `tag` | {one line, drawn from the file you just wrote} |
```

**Why it lives inside Step 2 and not in its own step**: a row written by the same act that writes
the file cannot drift from it. A separate step is a second surface that can be skipped, which is
the exact failure the index exists to fix — it would become drift surface #7 instead of the read
path for the previous six. Tags must come from the vocabulary declared at the head of INDEX.md; a
free-form tag is unsearchable by anyone who did not write it.

**Do not backfill old sessions here.** Rows are written by the session that lived them. Summarising
a session you were not present for is inference that then gets trusted — see
`docs/plans/2026-08-26-compounding-process.md` §3B.

**Why**: `/catchup deep` reads learnings/. Also linked from MEMORY.md session-delta pointers.

## Step 3: CLAUDE.md Fallback (expected default: skip)

Policy: *"Persist findings inline — don't batch."* Mistake rows (`~/.claude/evals/mistake-ledger.md`) and principles (`~/.claude/principles/INDEX.md`) are written at the moment they emerge, not batched here.

At wrap time, walk through the session mentally and ask, **verbatim**:

> *"Did any mistake, principle candidate, or non-obvious insight emerge this session that is NOT already in CLAUDE.md or `learnings/`? Walk through the session's major moves before answering — don't answer by reflex."*

- **If NO** (expected default): **skip silently.** Do NOT narrate the walk-through to the user ("I considered Step 3 and skipped" is wasted output tokens × every wrap). The walk-through is a private internal check; only its OUTPUT matters to the wrap log.
- **If YES**: add using the templates in `~/.claude/governance.md` § Entry templates (relocated from CLAUDE.md 2026-05-04). If the thought doesn't fit a template, route to `learnings/{date}-{topic}.md` instead. State briefly what was added.

The walk-through requirement exists because Step 3 is the safety net for the rare inline-capture escape. A yes/no reflex defeats the net.

**Global filter** (when adding to the ledger, principles index, or global CLAUDE.md — all cross-project). Ask BOTH:
1. *"Would this help on a completely different project (billing API, mobile app, CLI tool)?"* If understanding requires this project's domain → add to project-level CLAUDE.md or `learnings/` instead.
2. *"Would this row change Claude's reflex on a project where this domain doesn't apply?"* If no — the row is dead weight in 99% of sessions and belongs in project memory or `learnings/`, not the always-loaded global table.

**Length gate** (when adding): every row/principle MUST fit the three-tier shape (recognition trigger → rule body → ≤1 inline example). If your draft exceeds ~350 chars or 2 sentences, you're writing narrative, not a rule — compress to template shape and route the overflow to `learnings/{date}-{topic}.md` with a one-line back-ref.

## Step 4: Update MEMORY.md

```bash
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"  # marker refresh
```

Read `~/.claude/projects/.../memory/MEMORY.md` and update **Current State**.

**Shape (mandatory; tightened after a wrap-bloat compression audit — Current State narrative paragraphs were the second-largest contributor to wrap-time-bloat AND auto-load every session as `claudeMd`, so bytes-tax compounds; sharpened after a subsequent wrap-time analysis identified D-entry restated content in Phase line as the residual driver).** The Current State block is bullets + pointers, NOT prose.

**Char budget — ≤2500 chars and ≤30 non-blank lines, ENFORCED at Step 7a** (`verify_wrap_artifacts.py` `check_memory` emits FAIL, and `--strict` aborts the commit; Step 5.5 is the WARN-mode early check). Don't trim in circles to satisfy it. 2500 is the single working limit (NO separate 2000/80% target — that duality caused over-trimming). If a draft runs over, the overflow is *narrative in an index slot* → **route it down to `learnings/{date}-session{N}-*.md` (uncapped), don't compress it away.** Why the budget exists: this file auto-loads as `claudeMd` every session, so bytes are paid on every future run — the cap guards always-loaded context, not tidiness. Bullets + pointers from the first line land under it without a second pass.

**Phase line discipline — reference D-entries, don't restate them** (closes the residual wrap-bloat driver for the auto-loaded surface):

❌ **Anti-shape (~1100 chars)**:
> - **Phase**: {N} / `specs/<feature>/`. S{N} dispatched {batch-id-a} ({units} {domain} / OK={M} / {N} FLAGs all RESOLVED_OK / {pct%} deterministic {Gate}) + {batch-id-b} ({units} {domain} / OK={M} / {N} FLAGs all RESOLVED_OK / {pct%} deterministic {Gate}). **D{N}/D{N+1}/D{N+2} shipped**: D{N} {full rule restatement} (generalized from {prior shape} per user "{quote}" framing); D{N+1} {policy restatement} ({condition} → {value}; {operational constraint}); D{N+2} {coverage restatement} ({references prior D-entry} in {schema-field}). [...]

✅ **Target shape (~250 chars, same load-bearing info)**:
> - **Phase**: {N} / `specs/<feature>/`. {M}/{total} done; {batch-id-a}+{batch-id-b} dispatched. D{N}/D{N+1}/D{N+2} + {codebook} v{X.Y} shipped → see decisions.md + impl.md S{N}. {N-session streak / standing context} preserved.

The headline metric (units done, batches dispatched, streak) stays load-bearing for `/catchup` Step 3 5-line summary. The architectural rationale (what D{N} does, what D{N+1} codified) lives ONLY in decisions.md — `/catchup` follows the impl.md pointer if it needs the depth.

```
## Current State (YYYY-MM-DD / S{N} / {one-line headline incl. active spec name + headline metric})
- **Phase**: {phase + active-spec name}. {batch/gate counts}. {D-entries shipped → pointer}. {streak / standing context}. (≤300 chars total)
- **Next (Session N+1)**: {primary action + 1-2 bullets of secondary work + read-first pointer}.

- **Session N   (YYYY-MM-DD)**: {3-8 word summary}. {1-2 key numbers}. → `learnings/YYYY-MM-DD-sessionN-{topic}.md`
- **Session N-1 (YYYY-MM-DD)**: {3-8 word summary}. → `learnings/...md`
- **Session N-2 (YYYY-MM-DD)**: {3-8 word summary}. → `learnings/...md`
```

Keep last-3 session-delta lines only; older sessions already have learnings/ pointers and shouldn't accumulate in MEMORY.md.

**MUST-PRESERVE invariants** (catchup skill consumers — verifying these structural fields lets us compress freely without breaking the load-bearing readers):
- `## Current State (YYYY-MM-DD ...)` header parses as date for `/catchup` Step 2 staleness check.
- Phase line names the active spec when one exists — `/catchup` Step 1.4a reads this for active-spec detection.
- Session-delta lines match `/catchup` Step 1.5 regex verbatim: `^- \*\*Session \d+ \([0-9-]+\)\*\*:.*→\s*\`?([^\s\`]+\.md)\`?\s*$`. The `→` arrow + the `learnings/path.md` pointer are both required for the regex to capture the path.
- Memory Files index (the bullet list further down MEMORY.md) is OUTSIDE Current State — its size is governed by `/prune-memory`, not this verifier. Only add entries here for NEW non-session-tied memory files (`feedback_*.md`, `project_*.md`, `reference_*.md`, `domain_*.md`). Do NOT add entries for session-tied learnings — those have pointers via Step 4 session-delta lines.

**This is the most load-bearing write** — MEMORY.md auto-loads into every session's context as `claudeMd`. Every byte here is paid on every Claude run forever; full narrative belongs in `learnings/{date}-session{N}-*.md` (one click away via `/catchup` default-mode learnings link). Historical narrative ("Session X highlight", "RFC v1→v2 pass Y") belongs in `learnings/` or `MEMORY-archive.md`, never inline.

Archival of stale entries → `/prune-memory` (separate skill, deliberate, never runs during wrap).

## Step 5: Update Session Registry

```bash
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"  # marker refresh
```

Write an entry to `~/.claude/session-registry.yaml`. `/catchup` parses the top entry.

1. **Read** the file (create with header if missing).
2. **Identify project**: use current working directory basename. Special case: if cwd is `$HOME` or inside `~/.claude`, use `"global"` (same rule as `verify_wrap_artifacts.py` `is_global`).
3. **Build entry** — six fields only:
   ```yaml
   - label: '{3-12 word summary} → learnings/{date}-sessionN-{topic}.md'
     date: YYYY-MM-DD
     status: done | paused | blocked
     next: {exact next action — source verbatim from MEMORY.md's Next line; /catchup reads this}
     duration_min: {estimated minutes}
     files_changed: {integer from git diff --stat | tail -1}
   ```
4. **Prepend** entry to this project's `sessions` list (newest first). **CRITICAL — INSERT, do NOT REPLACE** the existing top entry. The single most common wrap-time bug (empirically the dominant wrap regression): operator does `Edit` with `old_string` matching only the existing top `- label: '...'` line, replacing it with the new label. This strands the prior entry's `date / status / next / duration_min / files_changed` fields under the new label, producing a YAML structure where one `- label:` block has TWO `date` / TWO `status` / TWO `next` keys (last-key-wins overrides the new entry's `next` with the old). Correct shape:
   - `old_string` matches `    sessions:\n    - label: '<EXISTING TOP>'` (the `sessions:` header line PLUS the existing first label line, joined by newline).
   - `new_string` is `    sessions:\n    - label: '<NEW S{N+1}>'\n      date: ...\n      status: ...\n      next: '<NEW>'\n      duration_min: <NEW>\n      files_changed: <NEW>\n    - label: '<EXISTING TOP>'` — preserves the old top entry's label line as the second `- label:` in the file, with its existing date/status/next/duration_min/files_changed naturally falling under it.
   - **Verify post-edit**: `grep -c "^    - label:" ~/.claude/session-registry.yaml | head -3` should show `count_after = count_before + 1`. If equal, you replaced instead of inserted — the old entry's fields are now orphaned under your new label.
5. **Do not archive in /wrap.** /catchup reads only the top entry per project (O(1) regardless of file size). Mirrors the MEMORY.md "loading-budget vs persistence" lesson.
6. **Write** the file.

**Label cap — ≤300 chars, ENFORCED at Step 7a** (tightened after a wrap-bloat audit found labels drifting to 1.5-5KB despite the "3-8 word summary" instruction; `--strict` since 2026-07-09 — a FAIL blocks the commit until routed down). 300 is the single working limit (NO separate 240/80% target). The label is grep-fodder, NOT prose: a 3-12 word summary + `→ learnings/path.md` pointer. If you're over, you're writing narrative → it belongs in the learnings file, not the label — route it down, don't trim in circles. The `next` field below is uncapped (verbose is fine; /catchup reads it verbatim).

**Headline + pointer discipline** (consistent with Step 1a / 1b / 4): the label states what landed + pointer; D-entry body content lives in decisions.md and is never restated here. ✅ "S{N} — {batch-id-a}+{batch-id-b} dispatched; D{N}/D{N+1}/D{N+2} + {codebook} v{X.Y} → learnings/YYYY-MM-DD-sessionN-{topic}.md" (~140 chars). ❌ A drifted label running 600+ chars restating each D-entry's purpose.

**`next` field stays verbose** — this is the load-bearing field that `/catchup` reads verbatim, and the user gets re-specified context next session if it's vague. No cap on `next`.

If your draft label exceeds 300 chars, you've drifted into duplication — full session narrative belongs in `learnings/{date}-sessionN-{topic}.md`, the label is a pointer, not a copy.

### 5.5: Inline cap-check (early warning)

> **Registry pruning is NOT wired here — deliberately.** `prune_registry.py` exists in this
> directory but is **not invoked by any step**. On 2026-07-27 it corrupted the registry: it
> removed `next: |` block-scalar KEY lines while orphaning their 8-space bodies (36 block
> scalars live; 33 entries / 639 lines orphaned; the file stopped parsing as YAML, silently,
> because every consumer reads it line-based). Recovered from a pre-prune backup. Before
> wiring it, it needs span-aware parsing, a test file, and a `--registry` flag — see the S54
> `next` in session-registry.yaml. **Do not add an invocation here until those land.**

BEFORE moving to Step 6 — run the wrap-artifact verifier once. This catches any prose-write overshoot from Steps 1a / 4 / 5 immediately, while the artifacts are still fresh in your context. Deferring to Step 7a's gate adds a ~3 min compress-then-rerun-gate round-trip per overshoot (empirically: 3 cap failures × ~1 min compression each + verifier re-run); catching at write-time is ~30s per FAIL.

```bash
# Active spec = what MEMORY's **Phase** / IMPLEMENTATION-PLAN's "Active spec:" DECLARES
# (resolve_active_spec.py; exit 3 = none declared, 4 = declared but unresolvable — both
# print why on stderr and leave IMPL_PATH empty). Never `specs/*/implementation.md | break`:
# that picked the first ALPHABETICAL spec, usually a dormant one, and the gates passed on it.
IMPL_PATH=$(python3 "$HOME/.claude/skills/wrapping-session/resolve_active_spec.py")
if [ -n "$IMPL_PATH" ]; then
  python3 "$HOME/.claude/skills/wrapping-session/verify_wrap_artifacts.py" --implementation "$IMPL_PATH" 2>&1 || true
else
  python3 "$HOME/.claude/skills/wrapping-session/verify_wrap_artifacts.py" 2>&1 || true
fi
```

If the output shows `FAIL` for session-registry / MEMORY / implementation: compress the affected artifact NOW (re-edit the relevant Step 1a/4/5 file), then re-run this check. Loop until OK. Do NOT proceed to Step 6 with FAIL outstanding.


**Project-local drift checks — ADVISORY, never blocking.** If the project root has
`scripts/check-wrap-drift.sh`, run it and surface its output. It reports router-count and
learnings-index staleness; each sub-check exits 0 current / 1 drifted / 2 cannot-check.

```bash
R=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$R" ] && [ -x "$R/scripts/check-wrap-drift.sh" ]; then
  "$R/scripts/check-wrap-drift.sh" || true
else
  echo "drift checks: NOT RUN (no scripts/check-wrap-drift.sh in ${R:-non-repo cwd})"
fi
```

**The else-branch is load-bearing.** The first version was `[ -x scripts/… ] && ./scripts/… || true`
with a path relative to cwd: run a wrap from a subdirectory or a worktree where the exec bit did not
survive, and it printed **nothing** — byte-identical to "this project has no drift checks", which is
byte-identical to "checks ran and everything is clean". Silence must never mean two things.

**Advisory is the contract, not a stage on the way to blocking.** Two checks in this class have
already been wrong in both directions, and this project has two documented cases of a gate whose
first false reds trained the operator to bypass it. Graduate on logged evidence from real wraps —
never on an "after N clean runs" condition, which has twice proved unreachable here (`verify_claude_md.py`
sat dead for 66 days on exactly that shape). A red here is information for the wrap summary; fix it
if it is real, record it if it is a false positive, and do not stop the wrap either way.

Step 7a re-runs the verifier with `--strict` — a FAIL there BLOCKS the commit. The early-warning here is the time-saving primary (WARN mode, catch it while the artifacts are fresh); the Step 7a gate is the enforcing backstop.

## Step 6: Append Telemetry (conditional)

```bash
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"  # marker refresh
```

If the project has a `telemetry/` directory, append a JSONL entry to `telemetry/skill-log.jsonl`:

```json
{"date":"YYYY-MM-DD","skills_used":["/skill1","/skill2"],"duration_min":N,"files_changed":N,"insights_added":N,"outcome":"One-line summary","d_entries_authored_in_session":N,"d_entries_authored_at_wrap":N}
```

Append, don't overwrite: `echo '{...}' >> telemetry/skill-log.jsonl`.

Skip silently if no `telemetry/` directory exists. Do NOT auto-create the directory.

**Authoring-discipline tracking** (added 2026-05-06 with Phase B1 in-session D-entry rule). The `d_entries_authored_in_session` and `d_entries_authored_at_wrap` fields enable adoption monitoring for the project CLAUDE.md § Authoring Discipline rule. Detection at wrap-time:

```bash
# Every register, every heading shape (same pattern as hooks/check-d-entry-timing.js D_HEADING).
# NO --diff-filter=A: that filter keeps only newly ADDED FILES, so an entry appended to an
# existing decisions.md always counted 0 — the field read 0 for every wrap it was meant to watch.
W='([^0-9A-Za-z_]|$)'   # word end, spelled out: BSD grep has no \\b
D_RE='^\+[[:space:]]{0,3}#{1,6}[[:space:]]+(\*\*|`)?(D[0-9]+'$W'|D-[A-Z]{1,3}[0-9]+'$W'|D-[A-Z]{1,3}[[:space:]]*(:|\(|—|–|-|$)|DP[0-9]+'$W'|VR-[0-9]+'$W'|Decision [0-9]+'$W')'
# This step runs BEFORE the wrap commit (Step 7). The quoted pathspec '*decisions.md' matches at any depth — no
# unquoted file-list variable (zsh does not word-split one).
# Previous wrap = newest commit whose SUBJECT is titled as a wrap (`Session N wrap …` /
# `Wrap YYYY-MM-DD …`). Not `--grep` (searches bodies), not any subject containing "wrap"
# ("wrap-trigger", "the pager had wrapped" matched), not "last commit touching learnings/"
# (learnings are captured inline mid-session). A project titling wraps otherwise -> unknown.
PREV=$(git log --format='%H %s' -300 | grep -E '^[0-9a-f]+ (Session [0-9]+ wrap|Wrap [0-9]{4}-)' | head -1 | cut -d' ' -f1)
# d_entries_authored_in_session: committed since the previous wrap ("unknown" if none found)
if [ -n "$PREV" ]; then git diff -U0 "$PREV" HEAD -- '*decisions.md' 2>/dev/null | grep -cE "$D_RE"; else echo unknown; fi
# d_entries_authored_at_wrap: still uncommitted now, i.e. about to ride the wrap commit.
# `git diff HEAD` cannot see an UNTRACKED decisions.md (a register created this session),
# so its lines are appended as additions — the same fallback the timing hook uses.
{ git diff -U0 HEAD -- '*decisions.md' 2>/dev/null
  git ls-files --others --exclude-standard -- '*decisions.md' | while IFS= read -r f; do sed 's/^/+/' "$f"; done
} | grep -cE "$D_RE"
```

(Skip both fields if the project has no `decisions.md`. `grep -c` prints `0` on no match; no `|| echo 0`, which printed a second `0`. POSIX classes instead of `\s`/`\b` so BSD and GNU grep agree.)

**Threshold escalation**: 3 wraps with `d_entries_authored_at_wrap > 0` triggers escalation to a hard hook (block decisions.md adds in the wrap commit unless paired with prior session-commit signature). P57 standard escalation chain (WARN → STRICT; never gate the upgrade on "N clean uses" — that activation condition proved unreachable and left `verify_claude_md.py` dead 66 days). To check: `tail -10 telemetry/skill-log.jsonl | grep -c '"d_entries_authored_at_wrap":[1-9]'`.

## Step 7: Commit + Push Project Repo (single commit)

By this step, all project-repo writes from Steps 1, 2, 6 (and any session code/data work) are on disk. One commit captures everything; one push lands it.

### 7a: Commit

```bash
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"  # marker refresh
```

**Pre-commit gate — wrap-artifact compression** (added after a wrap-bloat compression audit found wrap-time bloat from cross-artifact narrative duplication). Verifies session-registry label, MEMORY.md Current State, and implementation.md latest blockquote stay within compression caps. **ENFORCING since 2026-07-09 (`--strict` — a FAIL blocks the commit).** It sat in WARN mode (`|| true`) for weeks under an "after 3 consecutive clean wraps" upgrade condition — the same unreachable activation that left `verify_claude_md.py` dead for 66 days. On FAIL: the message names the artifact and the routing fix (move narrative DOWN to learnings/, don't trim in circles — typically ~3 min), fix and re-run, then proceed. Do NOT re-add `\|\| true` or drop `--strict` to get past it. Known backlog at enforcement time: two projects' MEMORY Current State blocks were over-cap; their next wraps pay the one-time compression.

```bash
if [ -f "$HOME/.claude/skills/wrapping-session/verify_wrap_artifacts.py" ]; then
  IMPL_PATH=$(python3 "$HOME/.claude/skills/wrapping-session/resolve_active_spec.py")  # see Step 5.5
  # if/else form (not ${VAR:+--flag "$VAR"}) — zsh collapses the conditional
  # expansion into a single argv element with embedded space; bash word-splits it.
  if [ -n "$IMPL_PATH" ]; then
    python3 "$HOME/.claude/skills/wrapping-session/verify_wrap_artifacts.py" --strict \
      --implementation "$IMPL_PATH" || { echo "ABORTING wrap — fix the wrap-artifact compression FAIL(s) above (route narrative down to learnings/), then re-run this gate."; exit 1; }
  else
    python3 "$HOME/.claude/skills/wrapping-session/verify_wrap_artifacts.py" --strict || { echo "ABORTING wrap — fix the wrap-artifact compression FAIL(s) above (route narrative down to learnings/), then re-run this gate."; exit 1; }
  fi
fi
```

**Pre-commit gate — company ledger freshness (G3)** (added 2026-09-16, [redacted] spec-restructure slice 5; a no-op in every repo without the script). A live ledger page states counts that live in a gitignored DB — audited N/M, per-family batch counts, and a content-based fingerprint per family. Those are exactly the numbers that go stale silently: T9's ledger sat wrong for sessions because a missing row read as "nothing to check". This gate recomputes all of them. **Both non-zero codes abort**, unlike an advisory drift check: exit 1 is a mismatch, exit 2 means an input could not be read, and a ledger that cannot be checked is not a ledger that is fine. A ledger file that does not exist yet exits 0 with a printed SKIPPED line.

```bash
if [ -f "scripts/specs/check_ledger_fresh.py" ]; then
  PY=".venv/bin/python"; [ -x "$PY" ] || PY="python3"
  "$PY" scripts/specs/check_ledger_fresh.py || { echo "ABORTING wrap — the company ledger disagrees with run_state or the identity outputs (see above). Fix the ledger, then re-run this gate."; exit 1; }
fi
```

**Pre-commit step — regenerate committed spec indexes** (added 2026-09-16, [redacted] spec-restructure slice 1; a no-op in every repo without the script). A repo may keep GENERATED index files under `specs/` that are committed and checked by a pytest gate (G1). A session that appends a decision entry leaves that index stale, and the staleness surfaces as a red test in the NEXT session, not this one. Regenerating here puts the index in the same commit as the entry that changed it. The families card additionally reads a gitignored DuckDB: absent, the script exits 3 and prints a SKIPPED line — a loud skip, never a silent one (the slice-7 resolver rule).

```bash
if [ -f "scripts/specs/build_spec_indexes.py" ]; then
  PY=".venv/bin/python"; [ -x "$PY" ] || PY="python3"
  "$PY" scripts/specs/build_spec_indexes.py --write || { echo "ABORTING wrap — the decisions index could not be generated (see the error above)."; exit 1; }
  "$PY" scripts/specs/build_spec_indexes.py --families --write   # exit 3 = data absent, prints SKIPPED; not fatal
fi
```

**Pre-commit gate — CLAUDE.md compression** (added 2026-05-04 after first-principles audit found global CLAUDE.md at 58.6KB / 258 lines, with the Phase-1 standing convention failing to propagate to newer paragraph principles — same P57 manifestation as wrap-artifacts case). Verifies file size, principles count, paragraph-principle externalization compliance, and mistake-row T3 cap. **ENFORCING since 2026-07-09 — but at Step 8, not here.** This invocation is a non-blocking early warning; CLAUDE.md lives in `~/.claude`, so the `--strict` gate runs in Step 8 against the commit that actually ships it. Two ratchets: `SIZE_RATCHET_BYTES` (the file may not grow — to add a line, remove one) and `MISTAKE_ROW_MAX_VIOLATIONS` (the COUNT of oversized rows may not increase — it is a count, not an identity set, so swapping one oversized row for another passes; do not read it as "no new oversized rows"). Both may only be lowered. Being above the softer 50KB target WARNs. A missing `## Mistake Patterns` / `## Principles` heading fails CLOSED. Covered by `test_verify_claude_md.py` (run it for the count — `python3 skills/wrapping-session/test_verify_claude_md.py`; `check_size`, `check_mistake_rows`, `_split_cells` and exit codes are tested in both directions — `check_paragraph_principles` is NOT covered). Prior state, worth remembering: seeded 2026-05-04 in WARN mode pending "3 clean wraps", it printed FAIL and exited 0 for 66 days, because its activation condition required the backlog it existed to prevent to already be cleared. **Paired with `hooks/memory-size-gate.js` (write-time nudge) — P51: change one, change both.**

```bash
# Early WARNING only — this is the PROJECT repo's commit step, and CLAUDE.md lives
# in ~/.claude. Enforcement happens in Step 8, before the commit that ships it.
if [ -f "$HOME/.claude/skills/wrapping-session/verify_claude_md.py" ]; then
  python3 "$HOME/.claude/skills/wrapping-session/verify_claude_md.py" || true
fi
```

**Pre-commit gate — MEMORY link integrity** (added 2026-06-28 after a repo relocation (Desktop→dev) left a whole session's worth of stale `../../../../desktop/<proj>/...` pointers across MEMORY.md + MEMORY-archive.md, plus a learnings file orphaned between the memory-dir and repo-root `learnings/` — none caught by wrap or /catchup for weeks; same P57 silent-drift class as the gates above). Verifies every slash-path `.md` pointer in the CURRENT project's MEMORY.md + MEMORY-archive.md resolves at some plausible base (catches relocation drift + missing-prefix typos) and that `learnings/` isn't split across the memory-dir and repo-root (orphans). Per-project scope (a wrap never fails for another project's drift); bare-name / shorthand / `{}`/`*`/`…` tokens are skipped to stay low-false-positive. **ENFORCING since 2026-07-09 (`--strict` — a dangling pointer or learnings/ SPLIT blocks the commit; fix the path or retire the link, then re-run).** UNTRACKED pointers stay WARN-only by design — the wrap's own commit below may stage them. Global/OS-meta sessions: the verifier anchors root to `~/.claude` and memory to the HOME slug itself (is_global, mirroring `verify_wrap_artifacts.py` — P51 pair), and skips the SPLIT check there (both learnings/ locations are canonical for global). Never link `~/.claude/plans/*` artifacts from MEMORY files — plan-mode files are ephemeral.

```bash
if [ -f "$HOME/.claude/skills/wrapping-session/verify_memory_links.py" ]; then
  python3 "$HOME/.claude/skills/wrapping-session/verify_memory_links.py" --strict || { echo "ABORTING wrap — fix the dangling MEMORY pointer(s) above (correct the path or retire the link), then re-run this gate."; exit 1; }
fi
```

**Pre-commit gate — implementation.md singleton invariant** (added after a recurring "demote-prior-session" attention failure in session prose handling): if the project ships a singleton verifier, run it BEFORE staging. Fails loudly when the prior session's verbose blockquote was not demoted to a compact pointer.

```bash
# Pass the RESOLVED active spec. With no argument the verifier falls back to its own
# hard-coded default, which can be a frozen file — it then passes forever while the live
# spec is never checked. No resolved spec (resolver exit 3/4) → skip, and say so.
IMPL_PATH=$(python3 "$HOME/.claude/skills/wrapping-session/resolve_active_spec.py")   # stderr kept: a skip must say why HERE
if [ -f "scripts/verify_implementation_singleton.py" ] && [ -z "$IMPL_PATH" ]; then
  echo "singleton gate SKIPPED — no active spec resolved (reason above)"
elif [ -f "scripts/verify_implementation_singleton.py" ]; then
  PY=python3; [ -x ".venv/bin/python" ] && PY=.venv/bin/python
  "$PY" scripts/verify_implementation_singleton.py "$IMPL_PATH" || { echo "ABORTING wrap — fix the implementation.md singleton invariant in $IMPL_PATH before committing."; exit 1; }
fi
```

If the project has no verifier, skip silently (no friction for projects with different spec layouts). When the verifier fails, do NOT stage or commit — read the diagnostic, demote the duplicate blockquote, re-run.

```bash
git status --short
git diff --stat
```

Stage **specific files only** (NOT `git add -A` — avoids secrets/large data). Skip ephemeral files (audit batches, temp data) and files pre-existing from prior sessions.

Build the commit message to cover the full session: code/data outcome + the spec/plan/learnings/telemetry deltas. Pattern:

```
Session N — {one-line outcome}

{2-4 bullets covering architectural decisions (D-entries), data/code work,
 spec deltas, learnings file. /catchup readers grep this commit message
 for the session's content.}

{attribution trailer(s) exactly as given in this session's system reminder}
```

Run a final `git status --short` after the commit to verify the working tree is clean (or only ephemeral files remain).

### 7b: Push (gated)

Push only when ALL of these hold — otherwise skip silently and report the reason:

0. **The repo has not opted OUT of auto-push.** Skip the push entirely (commit only, then report "pushed: no — repo opts out") if EITHER holds:
   - a `.claude-no-auto-push` file exists at the repo root, or
   - `git config --bool claude.autoPush` returns `false`.

   **Why this condition is first**: some repos deploy on push (Railway/Vercel/Fly auto-deploy), so a push is a *production deploy*, not a save. In those repos the owner gates every push individually. A project-specific "never auto-push" rule stored in MEMORY.md is a **passive** instruction; Step 7b below is an **active** one, and the active instruction wins — that is P6 ("competing general instructions override specific rules — fix the general one's scope"). This condition IS that scope fix. Precedent: 2026-07-09, a wrap auto-pushed a deploy-on-push repo and redeployed a live service with real users, despite a standing owner rule and a (silently dead) PreToolUse hook.

1. **Branch is `main`** (or another branch the user has explicitly designated as auto-pushable; `master` is also acceptable). Detect: `git branch --show-current`.
2. **Upstream is configured**: `git rev-parse --abbrev-ref @{u}` succeeds.
3. **Local is ahead, not diverged**: `git rev-list --left-right --count @{u}...HEAD` shows `0\tN` (zero behind, N ahead). If behind > 0, the remote has new commits; report and let the user resolve.

If all three hold:

```bash
git push
```

If push fails (auth, hook rejection, race condition), report the failure verbatim — do NOT retry, do NOT force-push.

**Why a push gate at all**: feature-branch wraps shouldn't auto-publish; diverged branches need manual rebase/merge. The gate is narrow on purpose — `main` + clean-ahead is the >95% case for a single-developer pilot, and that case should be one wrap = one push.

**Why push project repo at all** (was previously deferred to user): the prior "user's call" framing relied on agent-attention nudges that failed silently across a multi-session sequence, leaving multiple commits unpushed. The skill already auto-pushes `~/.claude` (Step 8) which has a stricter risk profile (multi-machine sync, secrets-adjacent); the asymmetry was backwards.

### 7c: Sync external backup targets (conditional)

Some sessions touch notes/specs/research that live in a git repo *outside* the current project — e.g. a personal notes folder nested inside another checkout, gitignored there so it's pushed nowhere on its own. The wrap is the reliable trigger to back these up; a "remember to run it manually" command never gets run.

```bash
bash "$HOME/.claude/skills/wrapping-session/sync_external_backups.sh"
```

The helper reads `$HOME/.claude/.wrap-backup-targets` (machine-local, gitignored — one absolute repo path per line). For each listed path that is a git work-tree with an `origin` remote, it stages all, and if anything changed, commits with a timestamp and pushes. Missing config, missing paths, and non-repos are skipped silently — a safe no-op on any machine/project with no targets configured. To add a target: append its absolute path to `.wrap-backup-targets`. Report the helper's per-target output line(s); on a `FAILED` line, surface it but do not block the rest of the wrap.

### 7d: Remove finished worktrees (every wrap, advisory)

Owner, 2026-09-26: cleaning worktrees was a thing he had to remember every session; it belongs to the wrap.

```bash
bash "$HOME/.claude/skills/wrapping-session/cleanup_merged_worktrees.sh"
```

Removes a worktree only when its branch's PR is MERGED, it has no modified tracked files and no unpushed commits, no running process sits inside it, and plain `git worktree remove` (never `--force`) accepts it. Branches are never deleted. Every other worktree prints a `kept … — reason` line. Report the summary line in the wrap output; the script always exits 0 and never blocks the wrap. `NOT RUN` (no repo, no `gh`) is reported as such, never as "nothing to clean".

## Step 8: Sync ~/.claude to GitHub

```bash
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"  # marker refresh
```

`~/.claude/` is a git repo synced to your own private remote. (Some users run a multi-machine setup — a primary OS plus a fallback.)

```bash
# git -C, NOT `cd ~/.claude` — the Bash tool's cwd persists across calls (P34).
# A `cd` here poisons Step 9's $(pwd)-derived marker path, silently no-opping the
# marker delete.
if [ -n "$(git -C ~/.claude status --porcelain)" ]; then
  # Concurrent-wrap mutex (hooks/git-sync-lock.js) — serialize this stage→commit→push
  # against any other session's Step 8 on the ONE shared ~/.claude index. Records
  # $PPID — the long-lived Claude Code process, stable across separate Bash calls.
  # FAIL-OPEN after 60s: a wrap must never hang. Escape: CLAUDE_GIT_SYNC_LOCK_SKIP=1.
  LOCK="$HOME/.claude/hooks/git-sync-lock.js"
  node "$LOCK" acquire "$PPID" "$(ps -p $PPID -o lstart=)"
  # Per-session staging (hooks/session-manifest.js) — NEVER `git add -A` here: it
  # sweeps OTHER live sessions' unstaged ~/.claude edits into this commit
  # (co-mingling, 8 fires 2026-05-26→2026-07-04). The PostToolUse `record` hook
  # tracked every file THIS session edited (subagents carry the parent session id);
  # `stage` stages exactly that set and prints an annotated leftover report.
  SM="$HOME/.claude/hooks/session-manifest.js"
  node "$SM" stage
  # >>> REVIEW the leftover report before committing. DEFAULT IS LEAVE — leftovers
  # are siblings' in-flight work. Claim ONLY paths you created via Bash or deleted
  # via rm THIS session (the two capture gaps):  node "$SM" claim <repo-rel-path>...
  # Review gate is DELTA-aware + per-repo (S256): wrap doc/learning/telemetry
  # edits are content-only delta and pass with NO /review round-trip, even on
  # top of session code a /review already covered. It blocks only if UNREVIEWED
  # CODE sits in the diff — then run /review (it scopes to that delta, small
  # slate) before the commit line. Other repos' flags can no longer clobber.
  #
  # ~/.claude ALWAYS CARRIES SIBLING SESSIONS' DIRTY FILES, so this gate fires here
  # far more than in a project repo (S182: a terminated session's automate-me-state.yaml
  # blocked the whole sync; the classifier rated a pure-state YAML T2/EXEC because it
  # fails toward code on YAML). The gate is repo-wide while this commit is
  # PATHSPEC-scoped, so it objects to files the commit excludes — two scopes that
  # cannot agree. Do NOT reach for CLAUDE_REVIEW_GATE_SKIP (a permission classifier
  # blocks the inline form anyway, correctly). RESOLUTION, in order:
  #   1. `node .../classify-diff.js --tier < <(check-review-gate.js --delta --repo ~/.claude)`
  #      to see WHICH file blocks and why.
  #   2. READ that file's diff. In ~/.claude it is nearly always state/config/docs.
  #   3. If it is genuinely content, you have now reviewed it — write the flag
  #      (`write-review-flag.js --verdict PASS --repo ~/.claude`) and commit. Adopt the
  #      file into the commit with a body note saying you reviewed before adopting.
  #   4. If it IS code you did not write, leave it and say so — do not commit it.
  # Steps 1-3 are ~30s and make the sync land every wrap, which is the expectation.
  # ENFORCING gate — CLAUDE.md compression. It lives in THIS repo, so it blocks THIS
  # commit, not the project's. Two ratchets: the file may not grow; the count of
  # oversized mistake rows may not increase. A FAIL here is recoverable: every wrap
  # artifact is already on disk (Steps 1-7), so compress a row, append its narrative
  # to the archive, lower the constant, re-run. Never `|| true` this line.
  python3 "$HOME/.claude/skills/wrapping-session/verify_claude_md.py" --strict
  # Commit ONLY the pathspec set — immune to index pollution from crashed wraps.
  # NOTE: --pathspec-from-file commits WORKING-TREE content, not the index (verified),
  # which is the same bytes the gate above just checked.
  git -C ~/.claude commit --pathspec-from-file="$HOME/.claude/.session-manifests/${CLAUDE_CODE_SESSION_ID}.commit-pathspec" -m "Wrap <YYYY-MM-DD>: <1-line session outcome>"
  git -C ~/.claude push
  node "$SM" prune     # drop committed entries; mid-wrap appends survive
  node "$LOCK" release # idempotent; safe even if commit/push errored above
else
  # Nothing dirty — but push any stranded commits (e.g. a prior wrap's push failed).
  if git -C ~/.claude status -sb | head -1 | grep -q '\[ahead'; then git -C ~/.claude push; fi
  echo "~/.claude/ has no changes to sync."
fi
```

**Flow rules (read the stage report BEFORE the commit line):**
- **"Dirty but nothing mine" is a normal outcome** — if `stage` staged 0 paths and you claim none, SKIP the commit (empty pathspec → git errors) but STILL push if `git -C ~/.claude status -sb` shows `[ahead N]`, then `release`. Never leave commits stranded because staging was empty, and never widen staging to make a commit happen.
- **If `stage` exits non-zero**: do NOT skip and do NOT `git add -A`. Degrade to careful manual staging — pick YOUR files from `git -C ~/.claude status --porcelain` (leave-by-default), commit with an explicit pathspec (`git -C ~/.claude commit -m "..." -- <paths>`), release the lock, and surface the crash to the user.
- **If `stage` WARNs "manifest EMPTY but repo dirty"** and you DID edit ~/.claude files this session: the record hook may be dead (precedent: six hooks sat silently dead on a stale env var, 2026-05→07). `claim` your files explicitly and flag the PostToolUse registration for investigation.
- **ORPHAN-ADOPTED paths** (dead-session adoption or the 7-day unclaimed valve): name them in the commit message body — git archaeology must distinguish adopted from authored.

**Attribution model + accepted residuals** (decision `ship-manifest-staging`, 2026-07-04, in `learnings/2026-05-30-concurrent-wrap-collision.md`): file-level attribution is the ceiling — same-FILE co-edits (session-registry.yaml, shared MEMORY.md) still co-mingle by construction. Durability shape changed deliberately: siblings' wraps no longer accidentally push your uncommitted work within hours; your work rides YOUR wrap or the orphan valve.

If push fails with a conflict, report the conflict file list to the user — do NOT force-push. User resolves manually.

Skip this step entirely only when `git -C ~/.claude status --porcelain` is empty AND the branch shows no `[ahead]` — both checks are deterministic; never skip from memory of "I didn't touch ~/.claude".

## Step 9: Clear wrap-in-progress marker

Final action of every wrap (success path). Removes the auto-compact suppression marker so the next compaction trigger is allowed to fire normally.

```bash
WRAP_MARKER="$HOME/.claude/.wrap-in-progress$(pwd | sed 's|/|-|g')"
rm -f "$WRAP_MARKER"
```

Even if this step is missed (e.g., wrap aborts before Step 9), the `precompact-guard.js` hook auto-deletes markers older than 10 minutes — no permanent block.

## Success Criteria — All True When Wrap Complete

- [ ] Spec / IMPLEMENTATION-PLAN reflects session changes (if applicable)
- [ ] Learnings created only if non-obvious finding exists
- [ ] CLAUDE.md Step 3 walk-through completed (expected outcome: skip)
- [ ] MEMORY.md Current State reflects next session's starting context (Step 4 shape)
- [ ] Session-registry 6-field entry written
- [ ] Telemetry appended (if `telemetry/` exists)
- [ ] Project repo committed in one commit; pushed if Step 7b gate passed
- [ ] Finished worktrees removed (Step 7d summary line reported)
- [ ] `~/.claude/` synced to GitHub

## What NOT to Do

- **Don't commit before docs are written** — Step 7's whole point is one commit per wrap covering all artifacts; committing earlier orphans Steps 1/2/6
- **Don't `git add -A` anywhere** — project repo: secrets/large-data risk; `~/.claude`: sweeps sibling sessions' in-flight work (co-mingling, 8 fires — Step 8 stages via the per-session manifest instead)
- **Don't force-push** on a Step 7b push failure — report and stop; the user resolves divergence
- **Don't push from a feature branch** unless explicitly designated — Step 7b's branch gate is the safety
- **Don't batch CLAUDE.md captures** — inline capture is the policy; Step 3 is the safety net, not the default path
- **Don't render a handoff block** — `/catchup` reads session-registry + MEMORY.md directly; a display-only handoff is pure context waste
- **Don't run `/automate-me`** — that's weekly analysis, not session-end
- **Don't create empty learnings files** for routine sessions
- **Don't duplicate info** across MEMORY.md and IMPLEMENTATION-PLAN.md — MEMORY.md's Current State indexes; IMPLEMENTATION-PLAN carries task-level detail

## Integration Points

**Replaces running separately:**
- a separate learnings-capture pass (Step 2 writes `learnings/` inline)
- Manual IMPLEMENTATION-PLAN.md updates

**Does NOT replace:**
- `/automate-me` (weekly pattern analysis)
- `/prune-memory` (deliberate archival — run when `/catchup` nudges)

**Writes to (cross-session):**
- `~/.claude/session-registry.yaml` — read by `/catchup`

**Invokes:** None (terminal skill).
