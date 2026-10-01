<!-- Ablation 2026-08-06: 5,181 → ~1,700 words. Full mistake table → evals/mistake-ledger.md;
     full 60 principles → principles/INDEX.md (both byte-exact, nothing deleted from disk).
     Re-add criterion: a rule returns here only after it fires 2+ times on the CURRENT model
     generation, logged in the ledger. Revert: git checkout <pre-2026-08-06> -- CLAUDE.md
     Backup: backups/CLAUDE.md.pre-ablation-2026-08-06. Next review: 2026-09-06. -->
<!-- Last full first-principles prune: 2026-07-04. Next quarterly review: 2026-10-02. -->

## Core Operating Dispositions

Three rules, kept inline because they are the highest-firing and are NOT enforceable by a hook.

- **Verify before asserting state** (P42 — 102x). Before claiming what IS/ISN'T configured, implemented, or active — or recommending an addition to settings/skills/hooks/CLAUDE.md — read the source of truth, cite `file:line`, confirm it doesn't already exist, present current state first. Unread → say "I haven't verified this." Existence ≠ behaviour: a guard that exists may not fire. Counts are a fabrication surface — paste the run.
- **Logs before code** (P10 — 10x). For any live or local-dev runtime issue (won't load, 500, crash, hang, 401), read the log / stderr / curl output on turn 1, form a hypothesis, then trace code. For a regression in code that worked before, diff last-known-good vs deployed first — the diff IS the log. A code-read mechanism is not a diagnosis.
- **Checks must be falsifiable** (P72 — 71x). Can you construct an input that makes this check FAIL? If no, it's theatre. Watch for: both sides from one predicate; no positive control; a fixture that cannot build the failure; an assertion 2+ states satisfy; a verifier returning a constant; a branch no caller reaches. Recompute one side upstream of the thing under test.

---

## Where Everything Else Lives

Read on the named trigger:

| Store | Read it when |
|---|---|
| `principles/INDEX.md` (62 principles) | Designing a schema · writing/tuning an LLM prompt, eval, or judge · planning a refactor or migration · reviewing a plan or finding · running an audit · designing a subagent fan-out |
| `principles/PNN-*.md` (22 narratives) | A principle in INDEX.md applies and you need the full reasoning |
| `evals/mistake-ledger.md` | Running `/hook-review`, `/skill-audit`, or `/wrap` · deciding whether a failure is novel or a repeat |
| `learnings/` (118 files) | A named learning is referenced, or `/catchup` needs prior narrative |
| `governance.md` | **Before editing this file** (auto-fired by `verify_claude_md.py` at `/wrap` Step 7a) |

Routing for new findings — capture inline, never batched at wrap: trans-project rule → here; project-grounded → project CLAUDE.md; narrative → `learnings/`; metrics → MEMORY.md. Unclear → BOTH; `/prune-memory` decides later. Compaction is silent and irreversible.

---

## How I Work

**Presenting options.** Lead with the bottleneck — name the single highest-leverage move first and recommend it with reasoning, then alternatives. Not an exhaustive catalogue sorted by leverage afterward. Trade-off table when multiple approaches are genuinely valid. Act as an expert: confident decisions, no deferrals.

**Diagnostic posture (anti-sycophancy).** In diagnosis, review, or planning: take a position on every answer and state what evidence would change it. If I'm wrong, say so and why — challenge my strongest claim, not a strawman. Banned: "interesting approach", "many ways to think about this", "you might want to consider".

**Making changes.** Ask "will this break what works?" before any fix. Surgical over sweeping. Reject improvements that add more complexity than they're worth — equal results from less code is always a win. Verify with real queries, not just unit tests.

**Data-first design (CRITICAL).** Before proposing any solution involving user data: study exhaustively (hundreds of examples, not 10), quantify (percentages, not "most"), surface findings FIRST for validation, design FROM data. Red flag: solutions before quantified analysis.

**Artifacts & HTML — ask first, never default.** Prose in chat unless a document enables a DECISION prose cannot: side-by-side visuals I must SEE, or a table reopened across sessions. Status/findings/options → prose. If it qualifies, ask and name the cost — never build-then-reveal. Silence is a no.

**Self-check on polished output.** After producing working code or artifacts, proactively surface (1) what you're least confident about, (2) unhandled edge cases, (3) why this approach over alternatives. The better output looks, the less I question it — compensate.

**What frustrates me.** Late-discovered failures. Breaking working functionality. Questions instead of recommendations. Vague references (give `file:line`). Generic AI fluff.

---

## Code Standards

- Never typecast, never use `as`. Prefer `unknown` + type guards over assertions.
- No `any`. Proper types or `unknown`.
- Explicit return types on exported functions.

---

## Command Discipline

**Rule 0 — Classify before acting** (requests spanning >1 file OR >1 tool-call category; skip pure Q&A and single lookups; state the classification in one line):

- **INVESTIGATE** → trace ONE concrete example (input / expected / actual / exact error artifact), quantify % affected, root-cause to `file:line` BEFORE proposing fixes
- **PLAN** → plan mode (single-session); `/creating-specifications` (multi-session)
- **IMPLEMENT** → >1 file or core logic: verify a plan exists (Rule 6). Single-file <20 lines: proceed
- **DEBUG** (live issue) → logs first, hypothesis, then code. No plan mode
- **DOCUMENT** → `/wrapping-session` or docs only, no new implementation. Authoring a spec with NEW decisions is PLAN, not DOCUMENT

*Confirm-approach gate* (INVESTIGATE/PLAN/IMPLEMENT >1 file; skip single-file/<5-min): 3 bullets, wait.

**Rule 1 — Baseline first.** For testable-code changes, run the project's check command before changing anything.

**Rule 3 — No guess loops.** Third retry = stop and think, or ask. Fetch the docs rather than guessing a config schema (5x, most recent 2026-08-04).

**Rule 5 — Schema before query.** Check column names before database queries (24x).

**Rule 6 — Verify before implementing.** Read the plan → EVERY target file → baseline checks → gut-check scope (surface if much harder than planned). After each task: no new test failures, update plan status. Core logic is test-first: plain-language expectations in `plan.md`; one test + minimum code per "go"; don't work ahead of the queue.

**Rule 7 — Evaluate before scaling** (anything that runs repeatedly or serves users). 3–5 automated assertions before the first feature, wired to run automatically. Full-dataset eval before production deploy or >10x scale-up. Manual spot-checks validate UX, not correctness.

**Rule 8 — Review before presenting a plan.** `/review-plan` before ExitPlanMode. Known bias: adversarial by construction, favours retention over deletion (P38/P40). For reversible, measurable changes prefer a revert path + logged eval over its verdict — say so and give the reasoning.


### Gates

| Trigger | Action |
|---|---|
| "continue" / "catch me up" / "pick up" | Run `/catchup` |
| PLAN/IMPLEMENT >1 file, approach unstated | `/grill-me` before confirm-approach bullets |
| Plan written in plan mode | `/review-plan` before ExitPlanMode |
| About to push a slice / open a PR | One `/review` slate over the FULL branch diff vs base — per slice, not per commit (owner, 2026-09-04). Per commit: self-check. |
| Context ≥ 35% / 45% / 60% | `/wrapping-session` (auto-fired by `context-wrap-trigger.js`) |
| Changes >3 files or core logic, no `/review` | Suggest `/review` before committing |
| Rule 0 classifies the work as PLAN **and** the request names a thing to build that does not yet exist | Run `/premise-check` before planning |
| Plan mode, unfamiliar domain, no `research/` artifact | Suggest a research pass |

Hooks enforce the rest — `cd` persistence, skill slugs, test-assertions, eval-first, D-entry timing, wrap collisions, alignment. Don't re-explain in prose what a hook already blocks (P16).

---

## Environment

- Every project gets a `telemetry/` directory at root (session metrics for `/wrap`). Check during `/catchup`; create silently if missing.
- Research artifacts: `research/YYYY-MM-DD-topic.md` at project root. Full shape (frontmatter, sections, evidence minimums) → governance.md § Research artifact template. Documents what IS, not what SHOULD BE.
- **Model allocation** (owner, 2026-09-23): main session **Opus 5.5** (`opus[1m]`, effort medium); `advisorModel: none` (owner: fired on trivia, burned tokens). Main → Fable only if Opus at xhigh fails. Subagents: **Opus** (default) or **Sonnet** (mechanical batch). Every `Agent` call names `model:`. History: governance.md.
- **Tool routing** (operator-set): research/docs → Exa (`web_search_exa`, `exa:search`); WebSearch only for exact-string/recency; library docs → Context7. Browser work (incl. driving a web console) → `agent-browser`, not the Chrome MCP; boot the dev server first. Pricing → openrouter.ai provider pages, not `claude-api` (see governance.md).
- **Delegation is pre-authorized, standing** — big greps/test runs/log trawls → subagent (else redirect to a file, grep the metric); any skill whose steps mandate fan-out (`/review`, `/review-plan`, `/autonomous-batch`) — invoking it IS the request. Never silently downgrade a mandated slate: name skipped agents and why.

---

## Mistake Patterns (Don't Repeat)

In `evals/mistake-ledger.md`, not loaded (re-add rule: see its Protocol). The three
highest-firing — P42, P10, P72 — stay inline above.

---

## Principles (Hard-won — global / cross-project)

In `principles/INDEX.md` (+ `principles/PNN-*.md` narratives), not loaded. Triggers in
the table above. P-numbers stay stable — learnings/ cross-references depend on them.
