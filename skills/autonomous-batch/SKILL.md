---
name: autonomous-batch
description: Orchestrate a queue of N similar tasks across fresh-context subagents, sequentially dispatched, each running end-to-end (branch → work → review → commit → push → PR) without per-step user permission. Use when one template + per-task variables can describe all N items, and items are independent. Triggers on '/autonomous-batch', 'run all N batches', 'dispatch the queue', or any multi-item plan where the user has explicitly authorized autonomous flow.
---

# Autonomous Batch Orchestration

## Design principle

This skill exists because *some* multi-item work is well-described by **one template + a list of variables**, where each item runs to completion before the next starts, and the parent session's only job is to dispatch + track. When that shape fits, this pattern delivers 4–6× the throughput of per-session manual flow while keeping the parent session's context light (each subagent runs in fresh 200K context; only the structured result returns to the parent).

The skill is **WHAT to do mechanically** — the project decides the variables (which items, which review criteria, which branch convention, which hooks need workarounds).

## When to use

A batch fits this pattern when ALL of these hold:

- **Template-able**: a single brief structure with named variables describes every item. If item-N requires a fundamentally different prompt than item-(N-1), they aren't batch-able.
- **Independent**: items share no in-flight state. Item-N can't depend on the runtime decisions of item-(N-1) (post-hoc anchoring via `git show origin/<branch>:<path>` IS allowed; runtime coupling is not).
- **Bounded per-item effort**: each item completes in ~5–30 min of subagent work. Items >30 min often surface ambiguity that needs user judgment and don't fit the autonomous flow.
- **User-authorized for autonomy**: the user has explicitly said "run all N", "dispatch the queue", or equivalent. This skill is never invoked from a cold start without authorization.
- **No per-item user judgment expected**: ambiguity discovered mid-item should be flagged via the blocked-reason return shape, not solved by the subagent guessing.

## When NOT to use

- **Single tasks**: just run them directly. The orchestrator overhead isn't worth it for N=1.
- **Tasks needing user judgment per item**: if you'd want to review each output before moving on, use sequential single-task dispatch instead.
- **Tasks with cross-batch runtime dependencies**: e.g., item-N's branch base depends on item-(N-1)'s exact commit hash. Post-hoc anchoring via merged refs works; live cross-batch state doesn't.
- **Tasks where the success criteria can't be encoded in code or a structured return shape**: if "good" is a vibes-check, the parent session needs to see the work, defeating the point.

## Cost model — CRITICAL

This skill uses the **Agent tool** for subagent dispatch.

- **Agent tool subagents bill against the parent session's subscription quota**, just like any other Claude Code work. No separate API charges.
- **Do NOT use `claude -p` headless invocations from Bash** to fan out work. Those bill per-token against the Anthropic API, separately from any Claude Code subscription. Many users do not have an API account configured and the spend will be invisible until the bill arrives.

If the user has said "subscription only" or "no API cost", `claude -p` is OFF THE TABLE. Use the Agent tool.

## Nesting + the self-review fallback (P70, updated 2026-06-16)

**Subagents CAN now spawn sub-Agents, up to 5 levels deep** (v2.1.172, 2026-06-10; verified empirically 2026-06-16). So a fan-out skill (`/review`, `/code-review`, parallel-research) dispatched inside a subagent now actually fans out instead of degrading. *(This reverses the old "leaf-node" claim — subagents were never leaf nodes after v2.1.172.)*

Still pre-bake a self-review checklist into the brief as a **graceful fallback** — for older harness versions, nesting-disabled configs, or when the depth cap is hit. **Generic "review carefully" instructions are not sufficient** — they produce plausible but shallow output that masks the missing rigor.

The checklist works only when it:
1. Names specific principles (by number or label) that the project considers load-bearing
2. Includes 1–2 worked examples per principle so the subagent can recognize the shape
3. Maps each principle to the concrete artifacts it should produce (assertion shape, test layout, naming convention)

The project's D-entry should enumerate which principles belong in this checklist.

## Architecture

```
Parent session (orchestrator)
├─ Queue all N items upfront (visible checklist)
├─ Agent dispatch (item 1, fresh 200K context)
│   └─ Subagent: read sources → write code → review → commit → push → PR
│      └─ Returns: { status, pr_url, structured fields }
├─ Mark item 1 completed in the queue
├─ Agent dispatch (item 2)
│   └─ ...
└─ Final report to user (PR list + any blocked items)
```

Key properties:

- **Sequential, not parallel**: each subagent gets fresh context but the parent waits for each return before dispatching the next. Parallel dispatch is possible but contention on shared resources (working tree, branch refs) makes it risky.
- **Light parent context**: each subagent returns ~1–3K tokens of structured summary. N=12 batches adds ~15–30K to parent context — manageable inside a single session.
- **Fresh subagent context per item**: each subagent reads the project sources fresh, so anchor reads scale by item count rather than amortizing. This is intentional — a stale parent context across N items is a worse failure mode than re-reading the anchor N times.

## Parent-orchestrator pattern

Mechanical steps for the parent session:

1. **Queue every item upfront** — write the numbered queue into the plan/progress file (or use `TaskCreate` only if it is offered; since 2.1.268 it is absent on current models unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`). This makes the runway visible to the user and to subagents in subsequent batches.
2. **Dispatch item 1 via Agent tool** with the full subagent brief (see template below). Mark it `in_progress` in the queue.
3. **On subagent return**:
   - Parse the structured return (success or blocked).
   - If `status: success`, mark Task completed, log the PR URL, dispatch item 2.
   - If `status: blocked`, mark Task in_progress (NOT completed), surface the blocked reason to the user, stop dispatching. Wait for user input.
4. **On final item return**: produce a summary block for the user with PR list, total exercises/files/whatever, and any deferred items.

## Subagent brief template

Every section is required unless marked OPTIONAL. The project's D-entry should provide example values for each variable.

```markdown
# GOAL

[1-paragraph statement of what this item ships. Include item number/name, scope, estimated effort.
End with: "Autonomous — no user to ask."]

Working directory: `<absolute path>`
Estimated effort: ~<N> min, ~<M> units of output

# CRITICAL — Environment & hook constraint

Parent session env does NOT have `<HOOK_OVERRIDE_VAR_1>=1` or `<HOOK_OVERRIDE_VAR_2>=1` set.
You inherit that env. You MUST inline these env vars on every relevant git command,
or the project's safety hooks will block you and you have no user to ask for override.

- `<HOOK_OVERRIDE_VAR_1>=1 git checkout -b <branch> <base>`
- `<HOOK_OVERRIDE_VAR_2>=1 git push -u origin <branch>`

Do NOT try `export <VAR>` — env exports don't persist across Bash tool calls in subagents.
Inline per-command is the only way.

[Project-specific: explain which hooks document this as the intended override path.
This is NOT a security bypass — the hook source explicitly instructs callers to use
this form. Pre-commit hooks for absolute prohibitions stay structurally enforced.]

# WORK ITEM

[The unit of work for this batch. File paths, function names, behavior to implement.]

# ANCHOR — read in full first

[Cross-batch references the subagent should read before writing. Use
`git show origin/<branch>:<path>` for not-yet-merged anchors. Mark each anchor as
behavioral reference vs style reference.]

# PIPELINE

1. git fetch origin
2. <HOOK_OVERRIDE_VAR_1>=1 git checkout -b <branch> origin/<base>
3. Read anchor files in full
4. Read target files in full
5. Draft the work
6. **Apply named-principle checklist FROM THE START** (do NOT draft then refactor):
   - P<N>: <named principle 1> — <one-line shape>
   - P<N>: <named principle 2> — <one-line shape>
   [Project-specific list — see D-entry]
7. Run the project's check command
8. Iterate to clean
9. Review: run the project's review skill (subagents can nest fan-out). If nesting is
   unavailable or the depth cap is hit, self-review against the checklist below.
10. Commit (format: <project's convention>)
11. <HOOK_OVERRIDE_VAR_2>=1 git push -u origin <branch>
12. gh pr create --base <target> --title <T> --body <see template>

# PR BODY TEMPLATE

[Project-specific. MUST include a "Reviewer attention" or "Findings surfaced"
section, even if empty. Forces the subagent to consider whether anything
upstream of the work-item itself deserves the reviewer's attention.]

# HARD CONSTRAINTS

ABSOLUTE PROHIBITIONS (pre-commit hook blocks, no override):
- <list project's absolute-prohibition paths>

Other:
- <list project's secondary restrictions: protected files, no new deps, etc.>

# Self-review checklist (when fan-out skills aren't available)

[Project provides the list. Each item must include:
 - the named principle (P<N>: <label>)
 - what the subagent should check for
 - a worked example or anti-pattern

Generic "review carefully" entries are NOT acceptable.]

# STOP AND RETURN blocked_reason WHEN

- <list project's blocking conditions: missing deps, undefined models, design judgment needed,
  hook fires despite inline-env override, push rejected for non-rebase reason, etc.>

In blocked-reason returns: which pipeline step, what specifically blocked, what was tried,
what user needs to decide.

# SUCCESS RETURN SHAPE

```json
{
  "status": "success",
  "pr_url": "<URL>",
  "branch": "<branch>",
  "<project-specific fields>": "...",
  "review_findings": {"must": N, "should": N, "nit": N, "deferred": []},
  "blocked_reason": null
}
```

# OPERATING MODE

- Run end-to-end autonomously. No user to ask.
- The user has explicitly directed autonomous flow for this batch type.
- If genuinely blocked, return `status: blocked` with diagnosis.
- Do not invoke wrap/memory/registry skills — parent's responsibility.
- Do not push to any branch except `<this-batch's-branch>`.
- Do not switch to any other branch except as documented in pipeline.
```

## Hook workaround pattern

Many projects have safety hooks (branch-mutation guards, push blocks) that fail-closed by default with a documented override-by-env mechanism. Three properties to verify in the project's hooks before using this skill:

1. **Override is documented in the hook's own error message**, not a workaround. If the hook error tells callers to use `OVERRIDE_VAR=1 git checkout ...`, that's the legitimate path.
2. **Override applies via inline-env prefix**, not exported var. Subagents inherit parent env (which usually lacks the override), and Bash tool calls don't preserve exports across calls. Inline-per-command is the only working form.
3. **Pre-commit absolute prohibitions remain enforced**. The hook override should apply to mutation-class hooks (branch, push), not to structural prohibitions (protected paths). If the project doesn't have this separation, the skill doesn't apply safely — escalate to the user.

If any of these don't hold, autonomous flow is not safe; route to manual dispatch.

## Per-batch decision tree (for shared-contract decisions)

When designing a batch that COULD share infrastructure (shared contracts, helpers, fixtures) with prior batches, the subagent chooses among:

```
reuse:    identical contract from prior batch; just instantiate it
extend:   contract grows by N axes; modify shared file + extend prior tests
sibling:  parallel contract with different shape; new shared file
solo:     divergence cost > sharing cost; no shared infra, inline everything
```

**Default is `solo`.** Earn shared contracts empirically across ≥3 confirming batches with aligned arity + source + scope. Speculative shared contracts anticipating future extension usually get rejected by subsequent batches and waste design effort.

The brief should let the subagent make this call, not pre-prescribe it. Subagents tend to make the right call when given the four-option vocabulary; they tend to over-share when only offered "reuse vs new".

## Failure modes seen in practice

- **Brief omits a production-reference artifact** → subagent writes code that follows the spec but breaks against runtime reality. Mitigation: every brief read-list MUST include ≥1 production-side reference (an existing test using the patterns, the runtime config, a live schema), not just specs/plans. (P64 in the user's principle library.)
- **Self-review checklist is generic** → subagent emits plausible self-review with no actual rigor; bugs the parallel reviewers would have caught land in production. Mitigation: enumerate principles by number/label with worked examples.
- **Subagent tries `export VAR=1` then runs git command** → second Bash call has fresh env, override doesn't apply, hook fires. Mitigation: brief explicitly forbids `export`; mandates inline prefix.
- **Parent dispatches item 2 before reading item 1's structured return** → race on branch refs and PR creation. Mitigation: parent ALWAYS awaits return before next dispatch.
- **Speculative shared contract** → batch N designs a 6-option shared contract anticipating batches N+1 through N+5 will extend it; N+1 through N+5 all reject it after measuring per-item divergence. Mitigation: default to solo; earn sharing empirically.
- **Subagent interrupted mid-pipeline (transient API error)** → a long subagent run hits a transient server error after reaching green-but-uncommitted; the structured return is lost (`subagent_tokens: 0` despite many tool_uses) and `SendMessage`-style resume may be unavailable. The work is NOT lost — it's uncommitted on disk in the shared worktree. Parent recovery: (1) `git status -s` to find the uncommitted work; (2) verify the diff is in-scope only (`git status -s | grep -v '^<expected-dir>/'` must be empty — the safety classifier may have been unavailable for the subagent, so verify manually); (3) re-run the check command yourself to confirm green; (4) reconstruct the subagent's findings by grepping its output files for the markers the brief told it to leave; (5) commit/push/finish from the parent. Faster than re-dispatching from scratch. Mitigation for the next dispatch: keep briefs idempotent (fresh branch off base) so a re-dispatch is also safe if recovery isn't worth it.

## Project setup checklist

Before invoking this skill for the first time in a project, the project must define:

- [ ] Branch naming convention for batch work (`<prefix>/<batch>-<n>`)
- [ ] PR target branch (NOT main; usually an integration branch)
- [ ] Hook override env-var names (and confirmation that hooks document them)
- [ ] Absolute prohibitions list (paths the subagent must never touch)
- [ ] Named-principle checklist for self-review (project's load-bearing patterns)
- [ ] PR body template (with mandatory "Reviewer attention" section)
- [ ] Success criteria expressible as a structured return shape

These belong in a project D-entry (decisions log) referenced from the project's CLAUDE.md. The skill points at *how*; the D-entry points at *what for this project*.

## Stop conditions for the parent

The parent stops dispatching and surfaces to the user when:

- Any subagent returns `status: blocked` (don't dispatch next — surface the blocked reason)
- Any subagent's PR fails to create (auth, branch protection, conflict)
- The cumulative review-queue depth exceeds what the human reviewer can absorb (project-specific; usually 10–20 PRs)
- The user explicitly says "stop" / "pause"

The parent does NOT stop on:

- A subagent returning `should` findings (those are acceptable signals, not blockers)
- A subagent flagging a worker bug (that's the *point* — pinning bugs is value, not failure)
- A subagent taking longer than estimated (estimates are nominal; the watchdog is per-step blocked-reason, not wall-clock)
