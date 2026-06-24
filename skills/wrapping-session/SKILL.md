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
- `design.md` / `decisions.md` / `inversion-checklist.md` (or feature-specific equivalents) — update if architectural-class change landed this session (see walkthrough below)

**Session-outcome shape for `implementation.md`** (mandatory; codified to prevent prepend-bloat after a wrap-bloat compression audit identified multi-paragraph blockquotes as the largest single contributor to wrap-time-bloat; sharpened after a subsequent wrap-time analysis identified D-entry-content-restated-in-bullet as the residual driver):

The current session's outcome record goes UNDER a `## Session Outcome Record (Latest)` heading at the head of `implementation.md`. **Shape: bullet list, NOT multi-paragraph essay.** ≤15 bullets covering "what landed" (D-entries shipped/parked, code paths, gate outcomes, metrics) plus a `→ learnings/path.md` pointer for full narrative.

**Char budget**: hard cap ≤2500 chars (enforced by `verify_wrap_artifacts.py` at Step 7a + Step 5.5). **Draft to ≤2000 chars (80% of cap) on first attempt — the verifier is BACKSTOP, not GUIDE.** 2000 chars ≈ 14 bullets @ ~140 chars each. Heavy sessions (3+ D-entries + paired fixes) may legitimately need 2200-2400; the cap is the floor, the first-attempt target is the aim.

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

Skip for routine sessions. Use the standard format:

```markdown
# Session: {date} - {Topic}

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
- **No D-entry duplication**: if the session shipped a D-entry in `decisions.md`, the learnings file REFERENCES it (`→ See decisions.md D{N} for Why/How/Detection-if-wrong`) instead of restating that content. The D-entry is canonical for architectural decisions; the learnings file is for non-D-entry insights — process surprises, failed approaches, metrics, what-future-you-should-do-differently.
- No `## Forward Concerns` section by default — that content belongs in the session-registry `next` field (which `/catchup` reads verbatim). Add Forward Concerns only when the session leaves >3 things to watch AND they don't all fit in `next`.

If your draft exceeds the cap, you've drifted into prose. Compress to bullets; the skill template's structure is the budget, not a starting point.

**Why**: `/catchup deep` reads learnings/. Also linked from MEMORY.md session-delta pointers.

## Step 3: CLAUDE.md Fallback (expected default: skip)

Per CLAUDE.md's own policy: *"Persist findings inline — don't batch."* Mistake rows and principles belong in CLAUDE.md at the moment they emerge, not batched here.

At wrap time, walk through the session mentally and ask, **verbatim**:

> *"Did any mistake, principle candidate, or non-obvious insight emerge this session that is NOT already in CLAUDE.md or `learnings/`? Walk through the session's major moves before answering — don't answer by reflex."*

- **If NO** (expected default): **skip silently.** Do NOT narrate the walk-through to the user ("I considered Step 3 and skipped" is wasted output tokens × every wrap). The walk-through is a private internal check; only its OUTPUT matters to the wrap log.
- **If YES**: add using the templates in `~/.claude/governance.md` § Entry templates (relocated from CLAUDE.md 2026-05-04). If the thought doesn't fit a template, route to `learnings/{date}-{topic}.md` instead. State briefly what was added.

The walk-through requirement exists because Step 3 is the safety net for the rare inline-capture escape. A yes/no reflex defeats the net.

**Global CLAUDE.md filter** (when adding): the Principles table loads on EVERY project. Ask BOTH:
1. *"Would this help on a completely different project (billing API, mobile app, CLI tool)?"* If understanding requires this project's domain → add to project-level CLAUDE.md or `learnings/` instead.
2. *"Would this row change Claude's reflex on a project where this domain doesn't apply?"* If no — the row is dead weight in 99% of sessions and belongs in project memory or `learnings/`, not the always-loaded global table.

**Length gate** (when adding): every row/principle MUST fit the three-tier shape (recognition trigger → rule body → ≤1 inline example). If your draft exceeds ~350 chars or 2 sentences, you're writing narrative, not a rule — compress to template shape and route the overflow to `learnings/{date}-{topic}.md` with a one-line back-ref. The CLAUDE.md table is read by an agent under context pressure, not a human reading documentation.

## Step 4: Update MEMORY.md

```bash
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"  # marker refresh
```

Read `~/.claude/projects/.../memory/MEMORY.md` and update **Current State**.

**Shape (mandatory; tightened after a wrap-bloat compression audit — Current State narrative paragraphs were the second-largest contributor to wrap-time-bloat AND auto-load every session as `claudeMd`, so bytes-tax compounds; sharpened after a subsequent wrap-time analysis identified D-entry restated content in Phase line as the residual driver).** The Current State block is bullets + pointers, NOT prose.

**Char budget**: hard cap ≤2500 chars (enforced by `verify_wrap_artifacts.py` at Step 7a + Step 5.5). **Draft to ≤2000 chars (80% of cap) on first attempt — verifier is BACKSTOP, not GUIDE.** This file auto-loads as `claudeMd` on EVERY session — every byte is paid forever. Compress aggressively.

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
2. **Identify project**: use current working directory basename. Special case: if `C:\Users\User`, use `"global"`.
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

**Label cap (mandatory; tightened after a wrap-bloat compression audit — labels had drifted to 1.5-5KB multi-paragraph paragraphs over many sessions despite "3-8 word summary" instruction)**: hard cap ≤300 chars (enforced by `verify_wrap_artifacts.py` at Step 7a + Step 5.5). **Draft to ≤240 chars (80% of cap) on first attempt — verifier is BACKSTOP, not GUIDE.** The label is grep-fodder for finding past sessions, NOT a place for prose. Add `→ learnings/path.md` pointer when this session created a learnings file.

**Headline + pointer discipline** (consistent with Step 1a / 1b / 4): the label states what landed + pointer; D-entry body content lives in decisions.md and is never restated here. ✅ "S{N} — {batch-id-a}+{batch-id-b} dispatched; D{N}/D{N+1}/D{N+2} + {codebook} v{X.Y} → learnings/YYYY-MM-DD-sessionN-{topic}.md" (~140 chars). ❌ A drifted label running 600+ chars restating each D-entry's purpose.

**`next` field stays verbose** — this is the load-bearing field that `/catchup` reads verbatim, and the user gets re-specified context next session if it's vague. No cap on `next`.

If your draft label exceeds 300 chars, you've drifted into duplication — full session narrative belongs in `learnings/{date}-sessionN-{topic}.md`, the label is a pointer, not a copy.

### 5.5: Inline cap-check (early warning)

After Step 5's session-registry write — BEFORE moving to Step 6 — run the wrap-artifact verifier once. This catches any prose-write overshoot from Steps 1a / 4 / 5 immediately, while the artifacts are still fresh in your context. Deferring to Step 7a's gate adds a ~3 min compress-then-rerun-gate round-trip per overshoot (empirically: 3 cap failures × ~1 min compression each + verifier re-run); catching at write-time is ~30s per FAIL.

```bash
IMPL_PATH=""
for f in specs/*/implementation.md; do
  [ -f "$f" ] && IMPL_PATH="$f" && break
done
if [ -n "$IMPL_PATH" ]; then
  python3 "$HOME/.claude/skills/wrapping-session/verify_wrap_artifacts.py" --implementation "$IMPL_PATH" 2>&1 || true
else
  python3 "$HOME/.claude/skills/wrapping-session/verify_wrap_artifacts.py" 2>&1 || true
fi
```

If the output shows `FAIL` for session-registry / MEMORY / implementation: compress the affected artifact NOW (re-edit the relevant Step 1a/4/5 file), then re-run this check. Loop until OK. Do NOT proceed to Step 6 with FAIL outstanding.

Step 7a still runs the verifier as the final pre-commit safety net — that's defense-in-depth. The early-warning here is the time-saving primary; the Step 7a gate is the correctness backstop.

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
# Count D-entries added in commits BEFORE this wrap commit (in-session authoring)
git log --diff-filter=A --since-as-filter -p specs/cleaning-extraction/decisions.md ^HEAD HEAD~1 2>/dev/null | grep -c '^+## D[0-9]\+:' || echo 0
# Count D-entries added in this wrap commit specifically (at-wrap authoring = violation)
git diff --diff-filter=A HEAD~1 HEAD -- specs/cleaning-extraction/decisions.md 2>/dev/null | grep -c '^+## D[0-9]\+:' || echo 0
```

(Adjust `specs/cleaning-extraction/decisions.md` path for projects where decisions.md lives elsewhere; skip the field entirely if no decisions.md.)

**Threshold escalation**: 3 wraps with `d_entries_authored_at_wrap > 0` triggers escalation to a hard hook (block decisions.md adds in the wrap commit unless paired with prior session-commit signature). P57 standard escalation chain — same as `verify_wrap_artifacts.py` adoption pattern (WARN → STRICT after 3 clean uses). To check: `tail -10 telemetry/skill-log.jsonl | grep -c '"d_entries_authored_at_wrap":[1-9]'`.

## Step 7: Commit + Push Project Repo (single commit)

By this step, all project-repo writes from Steps 1, 2, 6 (and any session code/data work) are on disk. One commit captures everything; one push lands it.

### 7a: Commit

```bash
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"  # marker refresh
```

**Pre-commit gate — wrap-artifact compression** (added after a wrap-bloat compression audit found wrap-time bloat from cross-artifact narrative duplication). Verifies session-registry label, MEMORY.md Current State, and implementation.md latest blockquote stay within compression caps. **Default WARN mode** (exit 0 with stderr diagnostic) for incremental adoption; upgrade to `--strict` (exit 1 on FAIL) after 3 consecutive clean wraps prove the shapes are stable.

```bash
if [ -f "$HOME/.claude/skills/wrapping-session/verify_wrap_artifacts.py" ]; then
  IMPL_PATH=""
  for f in specs/*/implementation.md; do
    [ -f "$f" ] && IMPL_PATH="$f" && break
  done
  # if/else form (not ${VAR:+--flag "$VAR"}) — zsh collapses the conditional
  # expansion into a single argv element with embedded space; bash word-splits it.
  if [ -n "$IMPL_PATH" ]; then
    python3 "$HOME/.claude/skills/wrapping-session/verify_wrap_artifacts.py" \
      --implementation "$IMPL_PATH" || true
  else
    python3 "$HOME/.claude/skills/wrapping-session/verify_wrap_artifacts.py" || true
  fi
fi
```

The `|| true` is intentional during the WARN-mode adoption window — diagnostics print to stderr but the wrap continues. To upgrade: drop the `|| true`, add `--strict`, and remove this comment block.

**Pre-commit gate — CLAUDE.md compression** (added 2026-05-04 after first-principles audit found global CLAUDE.md at 58.6KB / 258 lines, with the Phase-1 standing convention failing to propagate to newer paragraph principles — same P57 manifestation as wrap-artifacts case). Verifies file size, principles count, paragraph-principle externalization compliance, and mistake-row T3 cap. Default WARN mode; upgrade to `--strict` after compression deltas land + 3 clean wraps.

```bash
if [ -f "$HOME/.claude/skills/wrapping-session/verify_claude_md.py" ]; then
  python3 "$HOME/.claude/skills/wrapping-session/verify_claude_md.py" || true
fi
```

**Pre-commit gate — implementation.md singleton invariant** (added after a recurring "demote-prior-session" attention failure in session prose handling): if the project ships a singleton verifier, run it BEFORE staging. Fails loudly when the prior session's verbose blockquote was not demoted to a compact pointer.

```bash
if [ -x "scripts/verify_implementation_singleton.py" ] || [ -f "scripts/verify_implementation_singleton.py" ]; then
  if [ -x ".venv/bin/python" ]; then
    .venv/bin/python scripts/verify_implementation_singleton.py || { echo "ABORTING wrap — fix the implementation.md singleton invariant before committing."; exit 1; }
  else
    python3 scripts/verify_implementation_singleton.py || { echo "ABORTING wrap — fix the implementation.md singleton invariant before committing."; exit 1; }
  fi
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

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Run a final `git status --short` after the commit to verify the working tree is clean (or only ephemeral files remain).

### 7b: Push (gated)

Push only when ALL of these hold — otherwise skip silently and report the reason:

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

## Step 8: Sync ~/.claude to GitHub

```bash
printf '%s\t%s\n' "$PPID" "$(ps -p $PPID -o lstart=)" > "$WRAP_MARKER"  # marker refresh
```

`~/.claude/` is a git repo synced to your own private remote. (Some users run a multi-machine setup — a primary OS plus a fallback.)

```bash
cd ~/.claude
if [ -n "$(git status --porcelain)" ]; then
  # Concurrent-wrap mutex (hooks/git-sync-lock.js) — serialize this add→commit→push
  # against any other session's Step 8 on the ONE shared ~/.claude index. Without
  # it, a second session's `git add -A` sweeps this session's unstaged files into
  # its commit (collision 6× as of 2026-05-31). Records $PPID — the long-lived
  # Claude Code process, stable across separate Bash calls, so `release` may even
  # run in a later call. FAIL-OPEN: if the lock isn't free within 60s it warns and
  # proceeds anyway — a wrap must never hang. (check-wrap-collision.js warns if the
  # mutex ever has a hole. Escape valve: CLAUDE_GIT_SYNC_LOCK_SKIP=1.)
  LOCK="$HOME/.claude/hooks/git-sync-lock.js"
  node "$LOCK" acquire "$PPID" "$(ps -p $PPID -o lstart=)"
  git add -A  # strict .gitignore protects secrets/ephemeral data
  git commit -m "Wrap <YYYY-MM-DD>: <1-line session outcome>"
  git push
  node "$LOCK" release   # idempotent; safe even if commit/push errored above
else
  echo "~/.claude/ has no changes to sync."
fi
```

**Known limitation (accepted):** the mutex serializes wraps and prevents index corruption + lost work, but `git add -A` is still spatially greedy — the wrap that holds the lock first sweeps any *other* live session's unstaged ~/.claude edits into its own commit (co-mingling / mis-attribution). Work is never lost, only possibly committed under a sibling session's wrap commit. Fully closing this needs per-session `git worktree` isolation or per-session file manifests — both out of scope for the mutex. See decision `ship-mutex-accept-co-mingling` (2026-05-31).

If push fails with a conflict, report the conflict file list to the user — do NOT force-push. User resolves manually.

Skip this step entirely if the user is working in a project directory other than `~/.claude/` AND no `~/.claude/` files were modified this session.

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
- [ ] MEMORY.md reflects next session's starting context in ≤1 line
- [ ] Session-registry 6-field entry written
- [ ] Telemetry appended (if `telemetry/` exists)
- [ ] Project repo committed in one commit; pushed if Step 7b gate passed
- [ ] `~/.claude/` synced to GitHub

## What NOT to Do

- **Don't commit before docs are written** — Step 7's whole point is one commit per wrap covering all artifacts; committing earlier orphans Steps 1/2/6
- **Don't `git add -A` on the project repo** — secrets/large data risk; use specific paths (Step 8's `-A` is scoped to `~/.claude` only because that repo's `.gitignore` is hardened)
- **Don't force-push** on a Step 7b push failure — report and stop; the user resolves divergence
- **Don't push from a feature branch** unless explicitly designated — Step 7b's branch gate is the safety
- **Don't batch CLAUDE.md captures** — inline capture is the policy; Step 3 is the safety net, not the default path
- **Don't measure byte counts or enforce ceilings** — governance lives outside `/wrap` (templates at write-time + hook at commission time + `/catchup` visibility at session-start + `/prune-memory` deliberate archival)
- **Don't render a handoff block** — `/catchup` reads session-registry + MEMORY.md directly; a display-only handoff is pure context waste
- **Don't run `/insights`** — that's weekly analysis, not session-end
- **Don't create empty learnings files** for routine sessions
- **Don't duplicate info** across MEMORY.md and IMPLEMENTATION-PLAN.md — MEMORY.md's Current State indexes; IMPLEMENTATION-PLAN carries task-level detail

## Integration Points

**Replaces running separately:**
- `/learnings` (capturing-learnings skill)
- Manual IMPLEMENTATION-PLAN.md updates

**Does NOT replace:**
- `/insights` (weekly pattern analysis)
- `/prune-memory` (deliberate archival — run when `/catchup` nudges)

**Writes to (cross-session):**
- `~/.claude/session-registry.yaml` — read by `/catchup`

**Invokes:** None (terminal skill).
