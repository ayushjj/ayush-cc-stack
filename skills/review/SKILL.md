---
name: review
description: Use before committing code changes to run type checks, structural validation, and parallel review agents. Auto-detects project language (Python, TypeScript, Ruby/Rails). Triggers on '/review', 'code review', 'review before commit', 'check code quality'.
user_invocable: true
---

# /review — Code Review (Project-Aware)

One-command code review that detects project type, runs appropriate checks, and launches specialized review agents. Works across Python, TypeScript/JavaScript, and Ruby/Rails projects.

## Trigger

User runs `/review` before committing code changes. Also enforced by PreToolUse commit gate hook.

## Steps

### 1. Detect project type

Determine the primary language from changed files + project root indicators:

| Signal | Language |
|--------|----------|
| `package.json` at root, changed files are `.ts`/`.tsx`/`.js`/`.jsx` | **TypeScript/JavaScript** |
| `requirements.txt` or `setup.py` or `pyproject.toml` at root, changed files are `.py` | **Python** |
| `Gemfile` at root, changed files are `.rb`/`.erb` | **Ruby/Rails** |
| Mixed or unclear | Use the language with the most changed files |

Check for these in order:
```bash
# What files changed?
git diff --name-only HEAD
git diff --name-only --cached

# What's at the project root?
ls package.json requirements.txt setup.py pyproject.toml Gemfile 2>/dev/null
```

Announce: "Detected project type: **{language}**"

### 1.5. Run project check command

Run the appropriate check command based on detected language:

| Language | Check Command | Fallback |
|----------|--------------|----------|
| TypeScript/JS | `npm run check` or `npx tsc --noEmit` | `npx eslint {changed_files}` |
| Python | `python -m py_compile {changed_files}` | If `ruff` installed: `ruff check {changed_files}` |
| Ruby/Rails | `bundle exec rubocop {changed_files}` | `ruby -c {changed_files}` |
| Unknown | Skip — proceed to agents | — |

If the check command fails, STOP. Report the errors. No point reviewing code that doesn't compile or pass lint.

**Project-specific override**: If a `CLAUDE.md` in the project root defines a check command (e.g., `npm run check`, `make lint`), use that instead of the defaults above.

### 2. Scope drift check

Before reviewing code quality, verify changes match stated intent:

1. Read recent commit messages: `git log --oneline -5`
2. Check for active spec: `python3 ~/.claude/skills/wrapping-session/resolve_active_spec.py` — prints the DECLARED spec's implementation.md (from MEMORY's **Phase** / the plan's "Active spec:"); if it prints a path, read the current task there. Not `ls specs/*/implementation.md`: in a multi-spec repo that lists every spec and names no active one.
3. Compare stated intent against the actual diff file list

Classify as:
- **CLEAN** — changes match stated intent. Proceed.
- **DRIFT** — changes include files not related to stated intent. Report: "Scope drift detected: {files} are outside the stated intent of {intent}. Intentional?" Then proceed with review.
- **NO INTENT** — no commit messages, no spec, no context. Proceed without scope check.

### 3. Scope guard — unreviewed delta + content-only (Tier 0)

Review only what a prior PASS review has NOT already covered (delta-aware, S256), and classify it by **execution semantics, not file extension** — a `settings.json` hook-command edit is CODE; a model-pin bump is not. The gate script's `--delta` mode is the single source of truth for "unreviewed" (it prints the whole diff when no valid PASS flag exists) and the classifier for "code" (P16/P72 — both rules live in code, not prose):

```bash
repo="$(git rev-parse --show-toplevel)"
green=""   # set to --green ONLY if Step 1.5's check command RAN and PASSED (absence ⇒ fail up)
node ~/.claude/skills/review/scripts/check-review-gate.js --delta --repo "$repo" \
  | node ~/.claude/skills/review/scripts/classify-diff.js --tier $green
# → {"contentOnly":true,...,"tier":"T0","tierReason":"no unreviewed code files — content-only"}
# → {"contentOnly":false,"codeFiles":["src/x.ts"],"execFiles":[],"tier":"T1",...}
# → {"contentOnly":false,...,"execFiles":["settings.json"],"tier":"T2","tierReason":"execution/build surface changed: settings.json","slate":[{"agent":"ce-correctness-reviewer",...},...]}
```

This single invocation answers Steps 3, 4, **and 4.5** — `--tier` adds `tier`, `tierReason`, `signals`, and `slate` to the same JSON. Run it **once** and carry the result forward; do not re-derive any of it by hand.

If `contentOnly` is `true` (the unreviewed code-file set is empty — everything standing was reviewed, or only docs, model-pins, lockfiles, `.gitignore`, timestamps, pure-data JSON/JSONL changed — none of them RENAMED from a code/exec path, and none granted an executable file mode):
- Report: "Nothing unreviewed with execution semantics. No code review needed. Ready to commit."
- Skip to Step 8 (set flag, verdict PASS). **This is Tier 0** of the reviewer ladder (Step 4.5).

Two things to know about the classifier: it **fails toward code** — anything ambiguous, unparseable, or error-ing comes back as CODE and falls through to review; and the delta reads `git diff HEAD`, so **`git add` any NEW files first** (untracked files are invisible to `git diff HEAD`, hence to the classifier and to the Step-8 flag alike).

### 4. Identify changed code files

The `codeFiles` array from Step 3's classifier **is** the review set — every UNREVIEWED file needing a look (code already covered by a prior PASS flag does not come back), i.e. application source plus execution/build/CI surfaces (the latter also listed in `execFiles`, used by Step 4.5). An inert-looking path can appear here when its ORIGIN was code/exec (`git mv deploy.sh notes.txt`) or when the diff grants it an executable mode — `tierReason` names the origin as `notes.txt (from deploy.sh)` in that case. Everything else is `config-only` (defined here as: model-pins, version/dependency bumps, lockfiles, `.gitignore`/`.editorconfig`, timestamps, and pure-data JSON with no exec key or shell-shaped value) and is excluded from review. Read the full content of each `codeFiles` entry before launching agents.

(If Step 3 reported `contentOnly:true`, you never reach here.)

### 4.5. Read the reviewer slate (P65 · review router P1, 2026-09-15)

Don't launch a fixed crew on every diff — **hire reviewers by job**. The Step-3 JSON already carries both answers: `tier` (the published ladder, unchanged) and `slate` — an array of `{agent, job, because}`, one entry per reviewer the diff's signals hire:

| `job` | Hired when | Agent |
|---|---|---|
| `correctness` | any code file (tier ≥ T1) | `ce-correctness-reviewer` |
| `language` | code in that language (≤ 2, by changed lines; path OR rename origin) | `ce-kieran-{rails,python,typescript}-reviewer` |
| `security` | tier T2 (EXEC or CONTRACT) | `ce-security-sentinel` |
| `contract` | `CONTRACT` signal | `ce-api-contract-reviewer` |
| `schema` | `db/migrate/`, `db/schema.rb`, `migrations/*.{py,sql}`, `.sql` | `ce-data-migrations-reviewer` |
| `gate-machinery` | root `hooks/`, `skills/*/scripts/`, `.githooks/`, root `settings*.json` | `ce-adversarial-reviewer` |
| `fail-up` | diff unreadable/unparseable, or the slate computation threw | legacy full slate (correctness + 5 universal) ∪ path-rule hires |

That table describes the classifier; it is **not** a second source of truth — the rules live in `computeSlate()` and are pinned both ways by canary §6.8. Launch the `slate` array, never this table.

- **Empty `slate` (T0)** → skip to Step 8, verdict PASS.
- **`slate` key missing** while `tier` is present (stale classifier) → fail UP: launch the legacy full slate and say so.
- Otherwise announce verbatim: **"Reviewer slate: {tier} — {tierReason}. Hiring {N}: {agent} ({because}), …"** — then launch **exactly** those agents in Step 5. No additions, no drops. The size is part of the announcement so an unusually large slate is visible and overrulable by the user.

**Do not recompute, second-guess, or override the tier or the slate.** The signals (`EXEC`, `CONTRACT`, `N`, `GREEN`, `net-additive`, `MEDIA`, `RENAME`), and the gate-first evaluation order, live in `classify-diff.js` and are asserted **in both directions per signal** by canary §6.5–§6.7 (tier) and §6.8 (slate). They lived here as prose through S165 and S256 and were measured failing: across 149 runs, **71% spawned ≥5 agents, T0 fired once, and 63% never announced a tier at all**. That is why this is a tool result and not an instruction (P16: 3rd tuning ⇒ escalate to code). If a tier looks wrong, the fix is a canary assertion plus a classifier change — never a judgement call here. *(That is the BEFORE number — do not cite it as current. For the current distribution run `python3 ~/.claude/evals/measure_review_tiers.py --canonical-only`; the instrument owns the figure, deliberately not repeated here.)*

There is deliberately **no blast-radius/FANOUT signal**. One was built (grep the repo for the module name, count "importers") and deleted after measurement: over the last 120 commits here it fired 9 times and returned T2 all 9, with counts that were word-mentions rather than imports (7 "importers" of a file with 0 real ones). See the comment block in `classify-diff.js` before proposing its return.

`signals` is there to make the verdict auditable — quote `N` when a reader would otherwise take the tier on faith. It is `null` when the diff could not be read or parsed; report it as unknown rather than inventing values.

(**T3 / ~13 two-tier** is checkpoint-only — `/review --deep`, pre-batch or pre-prod — **never** diff-triggered, so it is not in the classifier's range.)

`tierReason` already names what T2 is protecting — the actual surface at risk ("execution/build surface changed: …"), never "multi-file change". Breadth is not a reason; blast radius is. Announcing it verbatim is what makes the tier overrulable by the user; that invisibility — not the ladder itself — is what let the expensive tier become the silent default twice (S256, S165).

**Project roster override (owner D-F).** This file owns the *mechanism* — tiers, slate, escalation gate, delta contract. It does NOT own which agents are worth running in a given codebase. A project may declare its own tier→agent roster in its `CLAUDE.md` or review checklist (e.g. `[redacted]/CLAUDE.md` rider (c)); **when one exists, it WINS over the router slate:**
- Staff the tier from the project roster. Announce **"Reviewer slate: {tier} — {tierReason}. Project roster: {agents}."**
- Do **NOT** announce or launch the router `slate`. Running both is the S166 double slate (~10 reviewers on one diff). The `slate` stays in the Step-3 JSON output unchanged — that is its only record, read by `measure_review_tiers.py` for the re-measure; do not copy it anywhere else.
- Check for a roster by reading the project `CLAUDE.md` for a tier→agent mapping. A mention of `/review` alone is not a roster.

Downstream rubrics must not restate tier *definitions* (divergent copies are how two slates end up firing at once), but naming their own agents is the point, not a violation.

Size the roster on evidence, not on the default: count how often each candidate agent appears in that project's `docs/` + `learnings/`, and which ones have *attributed catches*. In [redacted] that count was 51 vs 1 in favour of the project's own four (correctness/races/contract/reliability) over this file's five — and the two sets were fully disjoint, so adopting the default silently dropped every reviewer with a track record there. Check the overlap before consolidating any two slates; "they're redundant" is a claim about rosters that must be measured, never assumed (S166).

### 5. Run the review slate IN PARALLEL

Launch every `slate[].agent` from Step 4.5 (or the project roster, if one won) using the Agent tool in a **single message** — one launch per entry, the count must equal the announced N. Put each entry's `job` and `because` in that agent's prompt: it tells the reviewer *why it was hired*, which is the question it should answer first. (An empty slate already jumped to Step 8.)

**Agent names.** The review briefs are user-scoped in `~/.claude/agents/` and launch by bare name (`ce-correctness-reviewer`, not `compound-engineering:review:ce-correctness-reviewer` — the plugin went agentless, so the prefixed names no longer resolve). They are frozen copies — maintained here, not upstream. Use names from the live "Available agents" list. If a name genuinely fails to resolve, do not retry the string and do not skip the slate: launch a `general-purpose` agent with that entry's "prompt focus" row below as its lens, asking for MUST FIX / SHOULD FIX / CONSIDER with a re-grepped `file:line`, a concrete failure scenario, and the change that would falsify each finding. A slate that launches nothing still writes a PASS flag, so a silent skip is indistinguishable from a clean review.

**Prompt focus per agent** — the lens to write INTO the prompt (and the only brief, if the fallback above applies). Look an agent up here by the `agent` name the slate printed; this table does not decide who runs.

| Slate `agent` | Prompt focus |
|---|---|
| `ce-correctness-reviewer` | Logic errors, edge cases, state bugs, error propagation, intent vs implementation |
| `ce-kieran-typescript-reviewer` | TS conventions, type safety, idiomatic patterns |
| `ce-kieran-python-reviewer` | Python conventions, type hints, Pythonic patterns |
| `ce-kieran-rails-reviewer` | Rails conventions, ActiveRecord patterns, view components |
| `ce-security-sentinel` | Injection, secrets, OWASP. **Confidence gate: >= 8/10 only.** Every finding needs a concrete exploit scenario. Filter false positives: framework-safe patterns (React XSS, Django CSRF), env vars as trusted input, test-only files. |
| `ce-api-contract-reviewer` | The changed exported interface: every existing caller, breaking signature/shape/serialization changes |
| `ce-data-migrations-reviewer` | Migration safety, reversibility, locks on large tables, data loss, backfill correctness |
| `ce-adversarial-reviewer` | Construct the input that gets past this gate/hook/classifier: fail-open paths, bypasses, a check that cannot fail |
| *fail-up only:* `ce-code-simplicity-reviewer` | Unnecessary complexity, over-engineering, premature abstractions |
| *fail-up only:* `ce-performance-oracle` | Slow paths, memory issues, N+1 queries, inefficient data loading |
| *fail-up only:* `ce-architecture-strategist` | Component boundaries, coupling, design consistency |
| *fail-up only:* `ce-pattern-recognition-specialist` | Duplication, anti-patterns, naming inconsistencies |

The last four were retired from the normal slate by owner decision D-D (research: never the sole source of an applied fix; re-aim, don't delete). They run only on `fail-up`, or when the user asks for them by name.

For each agent, include:
- The list of changed code files
- The full content of each changed file (read them before launching agents)
- Project context: brief description from CLAUDE.md or auto-detected (e.g., "Python ETL pipeline for log analytics" or "Astro static site with React islands")
- **Review checklist**: Read `~/.claude/skills/review/checklist.md` and include its contents in every agent prompt. Instruct agents: "Flag any finding that matches a checklist item. Cite the checklist item number."

### 6. Synthesize results

Collect all agent findings and categorize:

**Must fix** — Bugs, security vulnerabilities, broken functionality, type/compile errors
**Should fix** — Code smells, duplication, performance concerns, maintainability issues
**Consider** — Style preferences, minor improvements, optional enhancements

### 7. Verdict

- If zero **must fix** items: "Ready to commit."
- Otherwise: List what needs to be addressed before committing.

### 7.5. Apply findings BEFORE writing the flag

If findings are being applied (must-fix always; should-fix/consider per user), apply them **now** — the Step-8 flag hashes the POST-apply diff, so applying the review's own findings never invalidates the review that produced them (the pre-S256 re-review loop). Edits made AFTER Step 8 are what the gate treats as unreviewed delta.

### 8. Set review gate flag (delta contract)

After the verdict (and Step 7.5 applies), write the flag via the paired writer — it stores per-file chunk hashes of `git diff HEAD` at a per-repo path (P51 paired contract with `scripts/check-review-gate.js` via shared `scripts/diff-chunks.js`; contract row in governance.md "Skill-coupling contracts" — change both sides in lockstep):

```bash
node ~/.claude/skills/review/scripts/write-review-flag.js \
  --verdict PASS \
  --repo "$(git rev-parse --show-toplevel)"
# ← --verdict REVISE instead if must-fix items remain unapplied
```

The commit gate then blocks ONLY on unreviewed CODE: new/changed code chunks since this flag block (and re-running /review scopes to just that delta); docs/telemetry/pure-data edits after the flag pass silently; a REVISE flag blocks all commits in the repo until must-fix items are addressed and /review re-runs. If NEW files are part of the change, `git add` them BEFORE running /review — untracked files enter `git diff HEAD` only once staged, and both the delta and the flag hash that diff.

## Agent Selection Reference

| Skipped Agent | When to include |
|---------------|----------------|
| `ce-dhh-rails-reviewer` | Only if user explicitly requests Rails-philosophy review |
| `ce-julik-frontend-races-reviewer` | Only if changed files include Stimulus controllers or async JS |
| `ce-agent-native-reviewer` | Only if project has an agent API surface |
| `ce-data-migration-expert` | Only if the user asks for a production backfill / ID-mapping check beyond what `ce-data-migrations-reviewer` (router `schema` job) covers |

Launch by bare name (see the Step-5 note). These are NOT router-hired: trust-boundary content, async-UI races, performance and new-module structure have no measured fire rate yet (router plan §2.2), so a user request is the only trigger.
