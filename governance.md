# CLAUDE.md / MEMORY.md governance (maintainer-only — NOT auto-loaded)

This file is for the human maintainer reasoning about CLAUDE.md/MEMORY.md state, archival, and skill coupling. It is NOT injected into agent context (precedent: `~/.claude/archived-principles.md` lives in the same directory and is also not auto-loaded).

The agent-facing rules live in `~/.claude/CLAUDE.md`. This file holds the governance metadata that supports those rules without paying token rent at every session start.

---

## Table-management policy

**Mistake Patterns table** (`~/.claude/CLAUDE.md` § Mistake Patterns):
- Soft cap ~20 rows.
- Oldest **1x rows** are archived quarterly to `~/.claude/archived-principles.md` via `/prune-memory`.
- Eviction criteria (per `/prune-memory` SKILL.md:50): `1x AND >30 days old`. **Recalibrated 90→30 on 2026-05-31** (velocity adjustment): at the user's session density (hundreds of recurrence-opportunities/month), a 1x pattern quiet for 30 days has had ample chance to recur and hasn't — calendar-30d is a proxy for recurrence-opportunity-density, not a slow-world calendar window. NOTE: this is the eviction *age* only; the prune *cadence* (when the sweep runs) stays 90d per § Quarterly cadences + the `memory-size-gate` hook. First velocity-prune executed same day: 11 Apr-18→27 rows → `learnings/2026-05-31-mistake-table-velocity-prune.md`.
- Quarterly cadence: see § Quarterly cadences below for current last-run / next-due dates. The HTML comment header at line 1 of CLAUDE.md is the canonical timestamp surface — `/prune-memory` SKILL.md:72 reads it; do not remove.

**Principles list** (`~/.claude/CLAUDE.md` § Principles):
- No size cap; principles compress with hindsight at quarterly prune.
- Eviction criteria (per `/prune-memory` SKILL.md:51): not grep-referenced in `learnings/` or commits in 60 days AND not domain-leaking.
- Domain-specific principles should leak DOWN to project-level CLAUDE.md, not stay in global.

**MEMORY.md (per project)**:
- Each project's MEMORY.md at `~/.claude/projects/<slug>/memory/MEMORY.md` — auto-loaded for that project, but separate from agent CLAUDE.md.
- Soft thresholds (per `/catchup` SKILL.md:52): MEMORY.md > 20 KB OR > 200 lines suggests `/prune-memory`.

---

## Quarterly cadences

Maintenance audits that fire every ~90 days. Aligned so both can run in one maintenance pass when the user invokes either.

| Skill | Cadence | Scope | Last run | Next due |
|---|---|---|---|---|
| `/prune-memory` | 90 days | CLAUDE.md mistake table + principles list; per-project MEMORY.md | 2026-05-25 | 2026-08-23 |
| `/skill-audit` | 90 days | `~/.claude/skills/` + `~/.claude/hooks/` — universality binary gate (D1-D4 denylist regexes sourced from `~/.claude/.skill-audit-patterns`, user-private/gitignored) | 2026-05-26 (initial deploy) | 2026-08-23 |
| `/publish-stack` | 90 days | Public stack snapshot (`ayush-cc-stack`) — prepare + leak safety-net; user runs final F-checklist sweep + push (decisions D5/D7). Nudged from `/prune-memory` final step | 2026-05-26 (2026-Q2 snapshot) | 2026-08-23 |

Update both `Last run` and `Next due` columns at each invocation. Each skill's SKILL.md also carries its own last-review timestamp (defense in depth — the in-skill timestamp is what `/catchup` surfaces if this table drifts).

Cross-references: `~/.claude/skills/skill-audit/SKILL.md` (universality gate steps); `~/.claude/principles/P68-skills-universal-by-construction.md` (rule body).

---

## Skill-coupling contracts (P51 paired-semantics — DO NOT BREAK without paired skill update)

Captured 2026-04-26 via Phase 0 grep before the governance restructure. These are the load-bearing contracts that agent CLAUDE.md must preserve:

| Skill | File:Line | Contract | Risk if broken |
|---|---|---|---|
| `/wrap` | `~/.claude/skills/wrapping-session/SKILL.md:222` | Heading literal "§ Entry templates" must exist | Step 4 capture path fails |
| `/wrap` | wrapping-session/SKILL.md:215 | Verbatim phrase "Persist findings inline — don't batch" | Skill quotes for filter logic |
| `/catchup` | catchup/SKILL.md:83 | Mistake table `Last` date column present | "Watch out: ≤3 days ago" surface fails |
| `/prune-memory` | prune-memory/SKILL.md:33 | Mistake table `Times` count column | "1x AND >90 days" eviction fails |
| `/prune-memory` | prune-memory/SKILL.md:34 | Principle IDs `P{N}` exist | Grep-based eviction fails |
| `/prune-memory` | prune-memory/SKILL.md:72 | HTML comment "Last full first-principles prune: YYYY-MM-DD" at file head | Quarterly cadence becomes opaque |
| `/prune-memory` | prune-memory/SKILL.md:102 | "(last prune)" timestamp preserved on update, not removed | Schedule loss |
| `/review-plan` | review-plan/SKILL.md:68-69 | Section names "Mistake Patterns table", "Principles list" | Dim 4 cross-reference fails |

**Implication for future audience-split work**: removing `Times` or `Last` columns, or renaming the "Mistake Patterns" / "Principles" sections, requires SIMULTANEOUS skill updates. See "Move 4 (deferred)" below.

---

## Learnings index (`~/.claude/learnings/`)

User-global cross-project archive. Project-specific learnings live at `~/.claude/projects/<slug>/memory/learnings/` (auto-loaded scope).

| Date | Topic | File |
|---|---|---|
| 2026-04-26 | Unverified state claims (P42) — 14 sub-incidents from line 157 + 2 from row 174 (P53 variant) | [`2026-04-26-unverified-state-claims-archive.md`](learnings/2026-04-26-unverified-state-claims-archive.md) |

---

## Move 4 (deferred — full audience split with skill updates)

This restructure (2026-04-26, plan `~/.claude/plans/sleepy-plotting-flame.md`) executed the **reduced** Move 3 scope. The full audience-split was deferred because of P51 skill coupling — it requires paired updates to `/prune-memory`, `/catchup`, and `/wrap`.

Move 4 scope (NOT executed; flagged for future):
- Remove `Times` and `Last` columns from agent CLAUDE.md mistake table.
- Migrate recurrence-count and last-incident-date data into governance.md.
- Update `/prune-memory` SKILL.md to read eviction criteria (1x, ≥90-day) from governance.md.
- Update `/catchup` SKILL.md to read "≤3 days ago" Watch Out surface from governance.md.
- Validate `/wrap` Step 4 still works with the new heading structure.

Trigger to revisit: when agent CLAUDE.md exceeds 60 KB OR a maintainer sweep at quarterly prune surfaces token-tax measurement showing >5% session overhead from these columns.

Estimated cost: 4-skill update + plan + review-plan + smoke-test in 3 environments. Plan separately.

---

## Phase D follow-ups (this restructure)

Out-of-scope items recorded for later:

1. **`/catchup` "missing project CLAUDE.md" check** — when entering a project directory, `/catchup` should detect if project-level CLAUDE.md exists and surface as a state-health flag if absent. Procurement-intelligence drifted for 53 sessions without one before this was caught manually. Adds recurrence prevention so the next greenfield project is auto-prompted.

2. **MEMORY.md audience-split conversation** — same agent-vs-maintainer separation might apply to per-project MEMORY.md. Not investigated here.

3. **Quarterly prune scheduling on this restructure** — next prune due **2026-07-25**. Update HTML comment header in CLAUDE.md when next prune executes.

---

## Why this file is markdown, not YAML/JSON

Maintainer reads this prose-style; structured data (skill-coupling table) is rendered as a markdown table for direct readability. No skill or tool consumes this file programmatically — it's deliberately human-only. If a skill begins parsing it in the future, lock the schema then.

---

## Admission rules — every CLAUDE.md addition must pass

Externalized from CLAUDE.md to governance.md on 2026-05-04 during a first-principles audit — the templates and admission machinery don't shape per-session behavior, they shape the wrap process; auto-loading them was a token tax. Tightened with a 4th criterion (firing-evidence test + probation clause) at the same time.

**Four-test admission**:

1. **Necessary** — changes agent behavior. The model's training default would get this wrong (or not enough right) without this entry. If training already handles it, the entry is redundant.

2. **Operationalizable** — has a recognition trigger OR dispositional value-weighting. Dispositional frames (Quality Posture, "What Frustrates Me," Anti-Sycophancy posture) count: they tilt value-weighting across many decisions even without explicit triggers. Reference: `feedback_claude_md_compression_first_principles.md`.

3. **Minimal** — compressed to three-tier shape before written. The template is the filter; length is bounded by shape, not character count.

4. **Firing-evidence (or probation)** — for new entries, ONE of these must hold:
   - **Existing entry**: cited in a session-delta or wrap commit message in the last N sessions (firing evidence accumulating), OR
   - **Dispositional**: explicitly tagged as dispositional value-weighting (frame, posture, anti-sycophancy rule), OR
   - **Probation (paragraph-form principles)**: novel pattern with no firing history yet → externalize T3 narrative to `~/.claude/principles/PNN-{slug}.md` from day 1; only T1 (trigger) + T2 (rule body) lands inline. Promotes from probation when firing evidence accumulates (cited in ≥2 sessions).

**Compression ≠ deletion** for hard-earned content: never delete principles or dispositional frames; re-shape to tighter form, route overflow to `learnings/YYYY-MM-DD-topic.md`. The exception: entries that fail firing-evidence for N+ sessions AND aren't dispositional are externalize-with-pointer candidates at the next `/prune-memory`. The lesson is preserved (in the externalized file); the bytes-tax is removed.

**Inline-capture is the habit** — mistakes / principles / insights land when they emerge, not batched at `/wrap`. Routing:
- **Trans-project rules** → global `~/.claude/CLAUDE.md`.
- **Project-grounded examples** (codebase conventions, dataset specifics, paired-component contracts) → project CLAUDE.md.
- **Full narratives + sub-incident archives** → `learnings/YYYY-MM-DD-topic.md`.
- **Metrics / decisions** → MEMORY.md or spec file.

**Escape valve**: if scope is genuinely unclear, capture in BOTH project + global; let the next `/prune-memory` decide.

---

## Entry templates — three-tier shape

Every entry has three tiers. The shape is the filter; the constraints are mechanical (enforced by `verify_claude_md.py`).

| Tier | Content | Constraint |
|---|---|---|
| **1 — Recognition trigger** | First sentence; the condition that fires the rule. | 1 sentence, ≤25 words. Scannable in one breath. |
| **2 — Rule body** | Imperative action + detection + applies-to scope. | No length cap. Litmus: every word earns its place; deletable sentences = delete. |
| **3 — Evidence** | Worked example. | ≤1 example inline (≤2 sentences). Further sub-incidents migrate to `learnings/` with one-line back-ref. **For paragraph-form principles (>600 chars), T3 externalizes to `~/.claude/principles/PNN-{slug}.md` from day 1** (probation clause; canonical signature is `→ Full case detail (...): \`~/.claude/principles/...\``). On 4th recurrence: abstract the rule, don't accumulate examples. |

**Principle template** (one paragraph; tiers compressed inline):
> `N. {Tier 1 trigger}. {Tier 2 — imperatives, detection, applies-to}. Example: {Tier 3 — ≤2 sentences}. → Full case detail (...): \`~/.claude/principles/PNN-{slug}.md\``

**Mistake row template** (one table row; tiers compressed inline):
> `| {Tier 1 trigger as opening clause} {Tier 2 generalized fix}. {Tier 3 example or back-ref to archive}. | Nx | Rule/P# or — | YYYY-MM-DD |`

**MEMORY.md session-delta** (one line):
> `- **Session N (YYYY-MM-DD)**: {3-8 word summary}. {1-2 key numbers}. → learnings/YYYY-MM-DD-topic.md`

**Shape admission rule**: if the thought being captured does NOT fit its three-tier shape, it is not that type of entry. Route to `learnings/YYYY-MM-DD-topic.md` (unbounded, structured) instead.

**Recurrence trigger**: on the 4th sub-incident of any mistake row or principle, STOP appending — abstract the rule's Tier 2 body to cover all 4, migrate the sub-incident bodies verbatim to `learnings/YYYY-MM-DD-{topic}-archive.md`, replace inline accumulation with a one-line back-ref. Sub-incidents past 3 add diminishing returns to disposition; bloat compounds linearly.

**Fallback for date-grounded principles**: if a principle's only concrete grounding IS a dated incident that can't be generalized into "Example: {case}", keep the body tight and cite as `Example: See learnings/{date}-{topic}.md — {one-line summary of what the incident taught}.` Dated detail lives in the learning; the principle inherits by reference.

---

## Standing conventions

### CLAUDE.md compression cleavage (2026-04-29, validated; tightened 2026-05-04)

**Rule**: worked-example narratives (T3) for paragraph-form principles externalize to `~/.claude/principles/PNN-{slug}.md`; T1 (recognition trigger) + T2 (rule body / detection / applies-to) stay inline so principles still fire reactively when the trigger pattern arises. New paragraph-form principles externalize T3 from day 1 (probation clause in admission rule #4).

**Pilot validation history**:
- 2026-04-28 / Phase 1 pilot: P51, P55, P58 cleaved. Net reclaim ~600 B.
- 2026-04-29 / Phase 1 expansion: P56, P60, P61 cleaved. Net reclaim ~3 KB.
- Post-pilot sessions: P51 fired 3× (compositional adherence audit, spec-impl drift), seeded P62. P55 fired 1×. P58 trigger not yet observed but compression intact. Zero reversal triggers.
- 2026-05-04 audit: routing pass moved P52, P54, P56, P60, P61 to a project-specific CLAUDE.md (LLM-eval-pipeline-scoped). Phase 3 cleavage on remaining paragraph principles tracked in compression-arc.md.

**Reversal procedure** (if a compressed principle fails to fire on a real situation):
1. `~/.claude/principles/PNN-{slug}.md` has the original verbatim T3 — copy back into CLAUDE.md inline.
2. Delete the externalized file.
3. Append a one-line note to `~/.claude/meta/claude-md-compression-arc.md`: which P, what situation, what context was load-bearing.
4. If three principles fail in a single audit cycle → mechanism is broken; pause cohort expansion.

### Compression governance verifier (2026-05-04)

`~/.claude/skills/wrapping-session/verify_claude_md.py` enforces compression invariants at `/wrap` Step 7a:
- File size cap (50 KB).
- Principles count budget (70).
- Paragraph-principle externalization compliance (>600-char entries must have `→ Full case detail` pointer).
- Mistake-table 1x rows ≤250 chars OR contain archive pointer.

Default WARN mode (exit 0, stderr diagnostic) during adoption window. Upgrade to `--strict` after 3 consecutive clean wraps.

### Cross-references

- **Append-only history**: `~/.claude/meta/claude-md-compression-arc.md` (Phase 1, Phase 2 logs, lessons, future-work backlog).
- **Routing rationale**: `feedback_claude_md_compression_first_principles.md` (compression-vs-deletion debate; user direction 2026-04-22).
- **Externalized principle T3 narratives**: `~/.claude/principles/P*.md`.
- **Verifier**: `~/.claude/skills/wrapping-session/verify_claude_md.py`.
