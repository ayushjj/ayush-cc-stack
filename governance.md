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
| `/prune-memory` | 90 days | CLAUDE.md mistake table + principles list; per-project MEMORY.md | 2026-10-04 | 2027-01-02 |
| `/skill-audit` | 90 days | `~/.claude/skills/` + `~/.claude/hooks/` — universality binary gate (D1-D4 denylist regexes sourced from `~/.claude/.skill-audit-patterns`, user-private, tracked in the private repo, never published) | 2026-08-26 | 2026-11-24 |
| `/publish-stack` | 90 days | Public stack snapshot (`[redacted]`) — prepare + leak safety-net; user runs final F-checklist sweep + push (decisions D5/D7). Nudged from `/prune-memory` final step | 2026-10-01 (2026-Q4 snapshot, `401039e`) | 2026-12-30 |

Update both `Last run` and `Next due` columns at each invocation. Each skill's SKILL.md also carries its own last-review timestamp (defense in depth — the in-skill timestamp is what `/catchup` surfaces if this table drifts).

Cross-references: `~/.claude/skills/skill-audit/SKILL.md` (universality gate steps); `~/.claude/principles/P17-skills-universal-by-construction.md` (rule body).

---

## Skill-coupling contracts (P51 paired-semantics — DO NOT BREAK without paired skill update)

Captured 2026-04-26 via Phase 0 grep before the governance restructure. These are the load-bearing contracts that agent CLAUDE.md must preserve:

| Skill | File:Line | Contract | Risk if broken |
|---|---|---|---|
| `/wrap` | `wrapping-session/SKILL.md` — grep `§ Entry templates` | Heading literal "§ Entry templates" must exist | Step 4 capture path fails |
| `/wrap` | `wrapping-session/SKILL.md` — grep `Persist findings inline` | Verbatim phrase "Persist findings inline — don't batch" | Skill quotes for filter logic |
| `/catchup` | catchup/SKILL.md:83 | Mistake table `Last` date column present | "Watch out: ≤3 days ago" surface fails |
| `/prune-memory` | prune-memory/SKILL.md:33 | Mistake table `Times` count column | "1x AND >90 days" eviction fails |
| `/prune-memory` | prune-memory/SKILL.md:34 | Principle IDs `P{N}` exist | Grep-based eviction fails |
| `/prune-memory` | prune-memory/SKILL.md:72 | HTML comment "Last full first-principles prune: YYYY-MM-DD" at file head | Quarterly cadence becomes opaque |
| `/prune-memory` | prune-memory/SKILL.md:102 | "Last full first-principles prune:" comment preserved on update, not removed | Schedule loss |
| `/review-plan` | `review-plan/SKILL.md` — grep `evals/mistake-ledger.md` / `principles/INDEX.md` | Dim 4 reads both by path; the files must exist at those paths | Dim 4 cross-reference fails |
| `/review` | review/scripts/write-review-flag.js ↔ review/scripts/check-review-gate.js (shared `scripts/diff-chunks.js`) | Flag JSON `{repo, verdict, ts, fileHashes}` at per-repo `$TMPDIR/.claude-review-done-<sha256(repo)[0:12]>`: writer hashes per-file chunks of `git diff <branch-base>` (base → working tree); gate fires on `git push` / `gh pr create` (S81, was commit), re-derives `<branch-base> → HEAD` via the SAME module and blocks only on an unreviewed CODE delta (S256 delta-aware; supersedes S47 full-diff hash) | Writer/reader drift → gate silently always-blocks (never matches) or always-passes (never checks) |

| `/review` | review/scripts/classify-diff.js ↔ review/SKILL.md Steps 3/4/4.5 ↔ hooks/tests/gate-hooks-canary.sh §6.5–§6.7 | Tier ladder: classifier owns `computeTier()` (gate = `EXEC \|\| CONTRACT`; `N`/`GREEN`/`net-additive` de-escalate only) and emits `tier`/`tierReason`/`signals` under `--tier`; SKILL Step 4.5 READS them and must not re-derive any signal in prose; §6.5 asserts every signal in BOTH directions. `--green` absent ⇒ not-green (T0 unreachable). Deliberately NO blast-radius/FANOUT signal — one was built and deleted after measuring 9/9 T2 with word-mention counts (S54) | Tier arithmetic drifts back into prose → the S165/S256 failure returns (71% full-slate, 63% unannounced — BEFORE only; current figure is owned by evals/measure_review_tiers.py --canonical-only, never restated here); or a signal ships with only escalation cases and over-fires green | **+ MEDIA_EXT presence ⇒ T0 unreachable (2026-08-26 text-bodied-media bypass; `MEDIA` is its own signal, netAdditive stays truthful).** **+ 2026-08-27: a file's identity is the UNION of both `diff --git` sides — the b-side alone let `git mv deploy.sh notes.txt` score T0. `RENAME` ⇒ T0 unreachable (a rename deletes its source). A 1007xx/120000 file mode ⇒ code+exec (metadata, so it survives prose where a shebang test cannot). A json-family rename fails up (its inert verdict is hunk-derived, and a rename empties the hunk). §6.6–§6.7 assert each in both directions.**
| `/review` | review/scripts/classify-diff.js `DATA_YAML_PATHS` / `DATA_JSON_PATHS` ↔ hooks/tests/gate-hooks-canary.sh §5 (↔ the owning repo's own validator, where one exists) | **Data allowlist.** Repo-relative PATH-anchored (never basename — S256) set of files that bypass the exec/injection nets. Ordering is load-bearing: `EXEC_KEY` runs BEFORE the allowlist, `SHELL_VALUE` after — the incidents (S256, kg S2) were all `SHELL_VALUE` on PROSE, and none justified exempting a hook key. **Admission bar: data BY CONSTRUCTION** — the schema must have no exec surface that can *grow*, enforced by a mechanism, not asserted in a comment (precedent: `graph-index.yaml` earned its entry only once `validate-graph.js` Check 8 + `lib/schema-keys.js` closed the key set, 2026-08-22). Every added path owes 3 paired canary cases: an `inert` fixture using REAL blocking-diff bytes; a `code` POSITIVE CONTROL holding the BASENAME FIXED and varying the DIRECTORY (a different-filename control cannot see a basename-anywhere regression — two mutants passed 135/135 against one, 2026-08-22); and a mutation-verify that empties the set and asserts inert→CODE | A wrong entry silently skips the review gate for that path in EVERY repo — the classifier has no repo identity (`check-review-gate.js` pipes the delta in with no `--repo`), so a root `graph-index.yaml` anywhere inherits it. Fails OPEN, the one direction the P11/P72 asymmetry forbids. Scope to `(repo, path)` pairs if the set ever exceeds ~5 entries or admits a name as generic as `data.json` |

| `check-router-counts` ([redacted]) | `scripts/check-router-counts.sh:60-92` ↔ `[redacted]/CLAUDE.md:87` ↔ `~/.claude/CLAUDE.md:25,27` ↔ `[redacted]/docs/code-review-checklist.md:1` + its `- **vN.N` changelog bullets | Four literal prose forms must survive verbatim: ``` `docs/code-review-checklist.md` (**vN.N** ``` in the project router; ``` `learnings/` (N files) ``` and ``` PNN-*.md` (N narratives) ``` in the global router; and a `vN.N` on line 1 of the checklist. Backticks, parentheses and the `**` are load-bearing. Reads come from each repo's INDEX, so an unstaged edit reads as absent — by design. | A rephrase prints `UNPARSED … THIS CHECK is stale, not the router` (deliberately NOT the fix-the-router message). Added S230 after a 4-reviewer slate found the first version certified the wrong quantity; `scripts/check-router-counts.test.sh` is its positive control — 11 cases on throwaway fixtures, no live file touched. ⚠️ Note the cross-repo hazard: `~/.claude` is a separate repo edited from EVERY project, so this check can go red with no commit in the mobile repo. |
| CLAUDE.md | `## Mistake Patterns` heading | `hooks/memory-size-gate.js`, `/review-plan`, `/prune-memory`, `/review`, `/extract-from-senior` locate the section BY NAME — renaming it silently breaks all five. (Moved out of CLAUDE.md 2026-08-25 under the size ratchet; it is maintainer metadata, and this table is where maintainer metadata belongs.) | Five consumers fail to find the section |

**Implication for future audience-split work**: removing `Times` or `Last` columns, or renaming the "Mistake Patterns" / "Principles" sections, requires SIMULTANEOUS skill updates. See "Move 4 (deferred)" below.

---

## Research artifact template

Externalized from `CLAUDE.md` 2026-08-25 (size ratchet). CLAUDE.md keeps the trigger and the
path; the shape lives here because it is a template consulted while writing one, not a reflex
that must fire on every session.

`research/YYYY-MM-DD-topic.md` at project root, 100-200 lines.
- **Frontmatter**: `date, commit, branch, topic, status`
- **Sections**: Goal - Verdict (1 sentence) - per-question Answer + Evidence - Constraints
  Discovered - Open Questions - Recommended Next Step
- **Evidence minimums**: codebase >=2 `file:line`; external >=2 URLs + quotes; hybrid >=1 each
- Documents what IS, not what SHOULD BE.

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

1. **`/catchup` "missing project CLAUDE.md" check** — when entering a project directory, `/catchup` should detect if project-level CLAUDE.md exists and surface as a state-health flag if absent. One project drifted for dozens of sessions without a project-level CLAUDE.md before this was caught manually. Adds recurrence prevention so the next greenfield project is auto-prompted.

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

`~/.claude/skills/wrapping-session/verify_claude_md.py` enforces compression invariants. It runs twice per wrap: a non-blocking early warning at Step 7a, and an **enforcing `--strict` gate at Step 8**, immediately before the `~/.claude` commit that ships `CLAUDE.md`. Invariants:
- **Size ratchet** (`SIZE_RATCHET_BYTES`): the file may not GROW. To add a line, remove one. Lower it whenever the file shrinks. **Raise it only by recorded decision** (owner, 2026-09-08 — it is a budget that forces prioritisation, not a wall): an addition may raise the ratchet when it passes all three tests — (1) it must fire on every session, not on a trigger; (2) it cannot be a hook; (3) it cannot be a one-line trigger pointing at a skill, `governance.md`, or a rules file. Record the decision and the new number in the `SIZE_RATCHET_BYTES` comment. Everything failing a test goes to its proper home; that is what happened to all three 2026-09-08 additions. The 50 KB `SIZE_CAP_BYTES` is a softer target — above it WARNs, it does not block.
- **Mistake-row ratchet** (`MISTAKE_ROW_MAX_VIOLATIONS`): the COUNT of rows over 250 chars may not increase. It is a count, not an identity set — retiring one oversized row and adding another passes. It is "no net-new oversized rows", not "no new oversized rows".
- **Mistake rows ≤250 chars, unconditionally.** An archive pointer does NOT exempt a row (a pointer-exempt rule is unreachable for exactly the rows that need it, since every oversized row acquires one). Compress per the row template above: T1 + T2 inline, T3 to the archive — **append the narrative to the archive before trimming the row**; archives drift stale behind the rows pointing at them.
- **Mistake rows must have exactly 4 columns.** A literal `|` in a cell must be escaped `\|`, even inside `` `code spans` `` (GFM requires it); an unescaped pipe silently truncates the measured cell.
- Principles count budget (70).
- Paragraph-principle externalization compliance (>600-char entries must have `→ Full case detail` pointer).
- A missing `## Mistake Patterns` or `## Principles` heading **fails closed** — a renamed heading must not silently disable the check.

**ENFORCING since 2026-07-09.** It previously sat in WARN mode (`|| true`, no `--strict`) pending "3 consecutive clean wraps" — an activation condition that required the backlog it existed to prevent to already be cleared, so it printed FAIL and exited 0 for 66 days. Any gate installed against an existing backlog needs a ratchet, or it never turns on. → `learnings/2026-07-09-claude-md-governor-dead-66-days.md`

**Paired artifact (P51):** `~/.claude/hooks/memory-size-gate.js` is the write-time nudge for the same caps and must agree with the verifier. Change one, change both; a parity check is owed.

### Compression requires independent substance-loss verification (2026-07-04, S44)

No CLAUDE.md compression/rewrite ships without an INDEPENDENT adversarial verification pass (a reader who did not author the compression) checking: (1) every rule/trigger/pointer/count in the original exists in the new file OR a relocation ledger, (2) pointer integrity on disk, (3) skill-coupling contracts (§3), (4) fact-checks on any enforcement claims. Evidence: S44 round-1 draft passed ALL deterministic spine checks (headings, keyword presence, number sets) while silently dropping 9 complete items, detection criteria on ~15 principles, and 1 pointer — the maker's compression drifts toward coherence over fidelity at ~15-entry scale, and grep-able checks catch structure, not meaning. Verifier findings restored at +9KB. → `learnings/2026-07-04-S44-fable5-stack-audit-session.md`

### Tool-routing rationale (relocated from CLAUDE.md)

- **`claude-api` is routed away from PRICING on relevance, not cost.** The original reason was
  token load (~40K). That is retired: the skill's load dropped ~200K→~25K in v2.1.221 when it
  moved reference docs to on-demand. The routing still holds — that skill is for SDK code, and
  pricing belongs on openrouter.ai / provider pages. Relocated here 2026-08-22 to pay the
  CLAUDE.md size ratchet for the line's own expansion.
- **The Chrome-extension MCP is routed away from browser testing** because it dead-ends on
  "extension not connected". Use `agent-browser` or `/ce-test-browser` instead.

### Core Disposition firing dates (relocated from CLAUDE.md)

Relocated 2026-08-25 (S66) to pay the size ratchet for the subagent-delegation line in
§ Environment. The inline counts stay in CLAUDE.md; only the `most recent` dates move here.

| Disposition | Count at relocation | Most recent incident |
|---|---|---|
| P42 — Verify before asserting state | 102x | 2026-08-12 |
| P72 — Checks must be falsifiable | 71x | 2026-08-12 |

Update this table when either date advances; CLAUDE.md carries the count only.

### Retired Command Discipline rules

Historical metadata, relocated out of the always-loaded CLAUDE.md on 2026-08-22 to pay the
size ratchet for the `/grill-me` Gates row. The rule numbers stay skipped — Rule numbering is
stable because skills and learnings cross-reference it.

| Rule | Retired | Why |
|---|---|---|
| Rule 2 | 2026-07-04 | Model-capability crutch — the behaviour it enforced is now default. |
| Rule 4 | 2026-07-04 | Harness-enforced; the rule restated what a hook already blocks (P16). |

### Cross-references

- **Append-only history**: `~/.claude/meta/claude-md-compression-arc.md` (Phase 1, Phase 2 logs, lessons, future-work backlog).
- **Routing rationale**: `feedback_claude_md_compression_first_principles.md` (compression-vs-deletion debate; user direction 2026-04-22).
- **Externalized principle T3 narratives**: `~/.claude/principles/P*.md`.
- **Verifier**: `~/.claude/skills/wrapping-session/verify_claude_md.py`.

## Model allocation — history (relocated from CLAUDE.md 2026-09-11, paying the size ratchet)

Owner ruling 2026-09-09 supersedes the 2026-09-04 "default Opus" rule, which `settings.json` never matched. `advisorModel` stays `fable`: from an Opus/Sonnet subagent it is a real escalation; from the main session it is a fresh full-transcript read, kept for decision-vs-implementation drift. The rule itself lives in CLAUDE.md § Environment. **Superseded 2026-09-23** (owner): main → Opus 5.5, **advisor OFF**. The advisor removal in `74d5aca` (09-14) was DELIBERATE — owner disabled it because it fired on every small step and burned tokens (S76 misread it as drift and re-enabled it for a few hours; reverted same day). Background: Anthropic's guidance is Opus 5.5 first, Fable only if xhigh/max fall short, and Fable-main could only take a Fable advisor (advisor.md pairing rule), i.e. self-review.



### CLAUDE.md ablation header (relocated from CLAUDE.md 2026-10-23, paying the size ratchet)
```
<!-- Ablation 2026-08-06: 5,181 → ~1,700 words. Full mistake table → evals/mistake-ledger.md;
     full 60 principles → principles/INDEX.md (both byte-exact, nothing deleted from disk).
     Re-add criterion: a rule returns here only after it fires 2+ times on the CURRENT model
     generation, logged in the ledger. Revert: git checkout <pre-2026-08-06> -- CLAUDE.md
     Backup: backups/CLAUDE.md.pre-ablation-2026-08-06. Next review: 2026-09-06. -->
```
