# ayush-cc-stack

A snapshot of one builder's Claude Code OS — workflow, skills, hooks, principles, and the mistake table that keeps it honest.

---

## Why I published this

I built this for myself first. After about 700 hours of working with Claude Code on real products, the workflow had calcified into a shape I trust: a question cycle, a set of skills that execute each step, a set of hooks that catch failures the moment they happen, a CLAUDE.md that names the rules and the mistakes, and a small set of principles externalized as full case studies.

Publishing it is pay-it-forward, not pitch. The success metric is one beneficiary — if a single reader recognizes one of the mistakes in the table before they make it, that is the win. I have no plans to convert this into a project I run; the snapshot below is what I use, frozen at the moment of publication.

I do not claim this stack is correct for anyone else's workflow. The shape may transfer; the residue — specific skills, the exact hook set — is the residue of failures that happened to me. Adopt the shape; adopt the parts where you have had, or expect to have, the failure they defend against. Skip the rest. A skill adopted prophylactically without a felt failure becomes the kind of dead infrastructure my own quarterly audit evicts.

---

## What's in here

```
ayush-cc-stack/
├── CLAUDE.md                  the durable behavioral spec; auto-loads every session
├── governance.md              meta-rules; how CLAUDE.md and the mistake table maintain themselves
├── settings.json              Claude Code settings; hook wiring + permissions + plugins
├── settings.json.minimal      same minus optional plugin marketplaces
├── statusline.sh              statusline renderer
├── MEMORY.md.template         per-project memory template
├── LICENSE                    MIT
├── THIRD_PARTY_NOTICES.md     credit + licence for vendored skills
├── .gitignore                 excludes runtime state (settings.local.json, projects/, sessions/, etc.)
├── principles/                22 externalized full-case-study principles (P01–P22) + INDEX.md
├── hooks/                     14 hooks + their canary tests
├── skills/                    30 skills (10 vendored — see THIRD_PARTY_NOTICES.md)
└── learnings/                 4 sanitized case studies + curation README
```

The components separate by intent. Six types — skills, hooks, CLAUDE.md, MEMORY.md, specs, learnings — each answer one question and refuse the others. A skill is a named procedure; a hook is a deterministic gate; CLAUDE.md is the durable behavioral spec; MEMORY.md is per-project state; specs are the design-decisions-implementation triad for a non-trivial feature; learnings are full-narrative incident archives. A single artifact that tried to be all of them would either grow unboundedly or compress away exactly the parts that need to survive.

---

## The workflow

A working session has a shape. The shape is a cycle of questions, each gated by the question before it, each guarded by a skill or a hook:

```
premise → research → plan → review → build → verify → commit → wrap → catchup
```

The cycle does not always run end-to-end. A bug fix lands on the build-verify-commit segment with no premise question. A naming refactor may skip everything except review-commit. But every non-trivial change passes through enough of the cycle that the cycle is the right backbone.

| Phase | Question | Primary skill | Defense |
|---|---|---|---|
| premise | Should we build this at all? | `/premise-check` | conversational |
| research | What do I need to know first? | `/research`, `/learn`, `/scout`, `/level-up` | knowledge-graph integrity gates |
| plan | What is the smallest change that ships the value? | plan mode + `/creating-specifications` | Rule 0 (classify-before-acting) |
| review | Would this plan survive contact with reality? | `/review-plan` | Rule 8 (`/review-plan` before ExitPlanMode) |
| build | Does the code do what the plan says? | (no skill — Claude writes) | `/careful` + `/freeze`; commit-time hooks below |
| verify | Does it pass on real data? | `/tdd`, `/harden`, `/executing-batch-operations` | Rule 1 (baseline first), Rule 7 (evaluate before scaling) |
| commit | Is the diff actually what I think it is? | `/review` | review-gate hook + anticheat hook + eval-first hook |
| wrap | What does next session need to know? | `/wrapping-session` | `context-wrap-trigger` at 35/45/60% |
| catchup | What did last session leave for me? | `/catchup` | MEMORY.md + CLAUDE.md auto-load |

Two perpendicular paths cut across the cycle: **debug** when something is unexpectedly broken (routes through `/diagnosing-bugs` — logs first, code second), and **data-first** when a feature touches user behavior (quantify real data before any plan is written — CLAUDE.md § Data-first design).

A few skills sit outside the cycle entirely — they exist to keep the OS itself healthy: `/prune-memory` and `/hook-review` and `/skill-audit` run on calendars, not as steps in a feature cycle. See the maintenance section below.

This is my workflow. Yours does not have to match it. The point is that having a named cycle, with skills wired into each phase, beats invoking tools by reflex.

---

## The hooks

Hooks are deterministic gates that run on agent-harness events (PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, Stop). Skills run when invoked; hooks run automatically. They beat attention-based suggestions because attention fails silently when context is busy.

The seven standalone hooks shipped here:

| Hook | What it catches | Why it exists |
|---|---|---|
| `check-anticheat` | Edits that delete or weaken tests | Agents optimize toward visible metrics; "tests pass" gets cheapest-path solved by deleting the failing test. Beck's #1 AI failure mode. Make the metric un-cheatable. |
| `check-eval-first` | Source-code commits with no corresponding tests | Evals are infrastructure, not optional. Write 3-5 automated assertions before the first feature — Hamel's gate. |
| `check-cd-persistence` | `cd <relative-path>` in Bash calls that should use `git -C` or absolute paths | Bash's working directory persists across the agent's tool calls — silent corruption class. Escalated after five fires. |
| `check-skill-slug` | `Skill` invocations using shorthand instead of the actual slug | Wrong slug fails silently. Catch at the call site, not 20 minutes later when the skill never ran. |
| `memory-size-gate` | CLAUDE.md / MEMORY.md / governance files growing past thresholds | Every line is loaded into every session's context. Bloat is paid forever; the governor must live at write-time, not retrospective prune. |
| `context-wrap-trigger` | Session context approaching limits with unfinished work | Hitting the context cap mid-task loses progress. Pre-empt: at 35% / 45% / 60% inject an escalating system-reminder so the wrap happens before exhaustion. |
| `precompact-guard` | Auto-compaction about to fire with a wrap marker live | Compaction is invisible and irreversible. Make the state transition visible before it happens; allow recovery if the marker is stale (dead PID). |

The hook system is the union of three sub-types: **standalone hooks** (this directory), **skill-attached hooks** co-located with their owner skill via paired-semantics contracts (`/careful` + check-destructive, `/freeze` + check-freeze, `/review` + check-review-gate), and **inline hooks** in `settings.json` (short shell commands for audio notifications and similar). Audit work that walks only the standalone directory is incomplete. See `skills/hook-review/` for the universal-by-construction sweep across all three.

Every hook honors a per-hook env variable to disable it individually; see the head of each file for the exact variable name.

---

## The mistake table

CLAUDE.md carries a mistake-pattern table. Every row has a firing count, a date, and a rule or principle reference. Ten representative rows from the live table:

| Pattern | Times | Rule | Last fired |
|---|---|---|---|
| Asserted current state without verifying — claim from memory rather than reading source-of-truth | 37x | P42 | 2026-05-26 |
| Wrote database code without reading the schema first | 20x | Rule 5 | 2026-04-14 |
| Skipped log check, went straight to expensive code exploration | 7x | P10 | 2026-04-02 |
| Bash tool `cd` persists across calls — used `cd` instead of `git -C` | 5x | P34 | 2026-05-19 |
| Substituted approach without checking the plan | 5x | Rule 6/8 | 2026-04-14 |
| Fought platform conventions instead of studying the working example | 5x | — | 2026-04-28 |
| Ignored explicit user request and jumped to implementation | 3x | Rule 0 | 2026-04-15 |
| Declared victory on insufficient evidence | 3x | Rule 7 | 2026-03-14 |
| Negative-assertion test satisfied by unrelated upstream exception | 2x | Rule 7 | 2026-05-26 |
| Agent deleted/weakened tests to make code pass — Beck's #1 AI failure mode | 0x | P15 / Beck | preventive (`check-anticheat` hook) |

Mistakes are not reported here as moral failures. They are captured as data, then escalated by recurrence. N times: a row in the mistake table, with firing count and last-fired date. N+K times across sessions: escalates to a principle, P-numbered, added to the Principles list. Dense or load-bearing enough to need narrative: the T3 narrative gets externalized to `principles/PNN-<slug>.md`. Keeps firing in the same shape across components: operationalized as a rule, a skill, or a hook (or all three). Defense lands; the firing rate drops; the row eventually evicts at quarterly `/prune-memory`.

The 0x row exists because the hook caught the class before it ever fired against me. That row is the value proposition for the whole stack — most rules in most other people's setups are generative ("here are best practices"); these are evidential, every one tied to a specific recurrence or a specific class the hook prevents from recurring.

---

## Quick-start

```bash
# 1. Clone into ~/.claude (or a directory of your choice; adapt the paths).
#    If you have an existing ~/.claude, back it up first — this overwrites.
git clone https://github.com/<your-handle>/ayush-cc-stack.git ~/.claude

# 2. Inspect what loaded.
ls ~/.claude/skills ~/.claude/hooks ~/.claude/principles

# 3. Review CLAUDE.md. The mistake table is mine — replace it with your own
#    incidents as they accumulate. The Principles section, the Command
#    Discipline rules, and the LLM Failure Modes section are reusable as-is.

# 4. Pick a settings file: settings.json wires this stack's hooks + the
#    optional plugin marketplaces I use; settings.json.minimal is the same
#    minus the plugins. Symlink or copy whichever fits your setup.

# 5. Start Claude Code in a project directory and run /catchup to orient.
```

MEMORY.md is per-project state and is not shipped live. Use `MEMORY.md.template` as the starting structure for any project you wrap.

The stack assumes macOS / Linux / WSL. The hooks are Node.js; `settings.json` references a few inline `if/elif/fi` shell guards for cross-platform audio. Windows-native (non-WSL) is untested.

---

## Maintenance posture

**Fixes-only.** I'll merge fixes; I won't add features here. The repo is a snapshot that updates roughly quarterly, aligned with my own `/prune-memory` cycle. PRs that fix something concrete I'll triage in the same cycle. Feature PRs I'll close politely.

This is the only posture honest with the publishing motivation. I publish this because the work was already done for myself, not because I am running an open-source project. If you want a feature, fork it — that is what the MIT license is for.

If you find a sharper version of any skill or hook, send the diff. That is the compounding part — what one builder learned in 700 hours, the next builder does not have to re-learn.

---

## What's NOT in here (and why)

**Omitted skills.** Several sit in the private OS but are not published: personal writing/content skills, data-pipeline skills tightly bound to one codebase, and a handful of project-grounded experiments whose utility cannot be conveyed without dataset-specific context. The audit found their cross-project value did not justify the per-file sanitization cost.

**Private files.** `settings.local.json` (per-machine overrides), `projects/` and `sessions/` (per-project runtime state), `history.jsonl` and the various caches, the full `learnings/` archive (the shipped subset is 4 sanitized case studies that map to public principles).

**No vendor-specific reviewers; no autonomous agentic loops; no badges; no roadmap.** This stack is workflow infrastructure. Rails-specific reviewers, Figma-sync skills, language-specific linters — install those from the relevant plugin marketplaces alongside this stack. Autonomous loops are a different problem class; look at Anthropic's Claude Code Agent SDK or community frameworks if you want them.

**No marketing creep.** The premise-check that preceded this publication established the success metric as one beneficiary. Stars, PRs, and issue volume are not goalposts. If issue volume spikes, that is a signal to raise the fix-acceptance bar, not to expand engagement.

---

## Maintaining your own version

If you adopt this and want it to keep working over time:

- **Capture mistakes inline; do not batch.** When a non-obvious lesson surfaces, write it into the mistake table the moment it emerges. Context compaction is silent and irreversible — inline capture is the only defense.
- **Run `/prune-memory` quarterly.** Stale rows compound; loaded context is paid every session. The skill moves rows to archive rather than deleting them, so provenance survives.
- **Run `/hook-review` fortnightly.** Hooks that have not fired in N sessions are candidates for tightening or removal. Hooks misfiring are candidates for a broader matcher.
- **Run `/skill-audit` quarterly** (aligned with `/prune-memory`). Skills and hooks are universal-by-construction (principle P17). Audit detects drift back into project-grounded language and routes the incident to a learning rather than into the skill itself.
- **Do not trust yourself to maintain by remembering.** Schedule it. Governance you do not automate is not governance.

The maintenance skills above are deliberately minimal. They are what keeps the surface honest as the OS evolves; they are also the first thing that breaks if you adopt the stack but skip the calendar.

---

## License + authorship

MIT. Use it, fork it, adapt it, sell what you build with it.

Authored by Ayush Jhunjhunwala (2026). The work behind it is real; the residue is mine. If a single mistake in the table here saves you from making it yourself, that is the only metric I care about.
