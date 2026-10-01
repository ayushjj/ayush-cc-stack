---
name: harden
description: >
  Use to prove a specific check, guard, gate, or test can actually FAIL — by mutating the thing
  it watches and confirming it goes red. For a check that gates a commit, deploy, migration, or
  data write, or one that has been asserted correct but never observed failing. Triggers on
  '/harden', 'prove this check can fail', 'is this guard real', 'mutation test this',
  'does this actually catch anything', 'verify the gate fires', 'surviving mutant'.
user_invocable: true
effort: high
---

# /harden — Prove the Check Can Fail

## Description

A check that cannot fail conveys no information. This skill takes ONE check under suspicion and
attacks it: mutate what it watches, and confirm it goes red. Anything that survives means the
check does not discriminate on that axis — it is decoration.

This is the **negative control**. P72a already requires a *positive* control ("name something
known present"). Both halves are needed; a check with only a positive control can still be
vacuous.

**Scope: one check at a time.** This is not suite-wide mutation coverage. Coverage tooling
answers "how much of the code do tests touch"; this skill answers "can this specific guard
ever say no."

## Trigger

Run this when ANY of the following hold:

- The check gates a **commit, deploy, migration, backfill, or data write**.
- The check has been **asserted correct without ever being observed red**.
- A review flagged a guard, or two reviewers converged on the same file (P69).
- A check reported "clean" / "0 issues" / "all pass" and the result feels **too tidy**.
- A count, coverage number, or pass-rate is about to be quoted as evidence.

**Do NOT run this** on ordinary feature work, templated single-file tests, checks already
observed failing this session, or as a reflex before every commit. Over-gating is a real cost:
a check ritual that takes longer than the work it guards has lost the game.

## Instructions

### Step 0: Safety — this skill edits source code

Mutations modify real files. Before any mutation:

1. Run `git status --porcelain`. **If the tree is dirty, STOP** and tell the user: mutations
   must be distinguishable from their real work. Offer to stash.
2. Record the clean ref: `git rev-parse HEAD`.
3. After EVERY mutation, revert it before applying the next one. One mutation live at a time.
4. At the end, run `git status --porcelain` again and confirm it matches the starting state.
   **Paste the output.** A skill that mutates code and cannot prove it reverted is worse than
   no skill.

If the target is not in a git repo, copy the file to the scratchpad first and restore from
that copy. Never mutate an unbacked file.

### Step 1: State the claim in one sentence

Write down exactly what this check asserts, in the form:

> "This check fails when ______."

**If you cannot complete that sentence crisply, that is Finding #0 — stop.** A check with no
articulable failure condition cannot be hardened; it must first be given a claim. Report this
and stop. Do not proceed to mutation.

Then name the three coordinates (cite grep-able strings, never `file:NNN` — P74):
- **Where the predicate lives** (the condition being evaluated)
- **Where enforcement lives** (what acts on the predicate — often a *different* place)
- **What the caller actually passes** (the real input in production, not the fixture)

### Step 2: Build the mutation set from the catalogue

Pick from this catalogue. Each row is a real failure class from `evals/mistake-ledger.md`, not
an invented one — that provenance is what stops the mutation set from being self-serving.

| # | Mutation | What you actually do | Failure class it reproduces |
|---|---|---|---|
| **M1** | Predicate flip | Invert the condition | classic; cheapest |
| **M2** | Empty search space | Point the grep/glob/query at a path or table that does not exist | a search over a never-existing dir returned 0 and was recorded as "all CLEAN" |
| **M3** | Zero rows | Feed the check an empty result set | `!x?` on 0 rows fails OPEN |
| **M4** | Misnamed guard | Point the guard at a sibling field, or rename the field it guards | "MISNAMED ≠ absent" |
| **M5** | Unreachable branch | Grep what values callers actually pass; check whether this branch is reachable at all | a branch keyed on a value no caller passes ships green |
| **M6** | Constant verifier | Force the thing under test to return a constant / always-pass | "YOUR verifier returning a constant" |
| **M7** | Same-source tautology | Trace whether both sides derive from the same predicate | the core P72 shape |
| **M8** | Upstream recompute | Recompute one side from a source UPSTREAM of the thing under test | P72's prescribed cure |
| **M9** | Positional shuffle | For row-wise or bulk output, shift or drop ONE row mid-sequence | membership checks pass while pairing is wrong |
| **M10** | Wiring cut | Sever the guard from its call site, leaving the predicate intact | "testing the PREDICATE while enforcement sits in an untested handler is decoration — mutate the WIRING" |

**Mandatory core — always attempt these three**, because they are the highest-firing and the
ones reasoning-from-code reliably misses:

- **M2** (empty search space) — if the check searches anything
- **M6** (constant verifier) — if the check consumes another component's verdict
- **M10** (wiring cut) — always; predicate-vs-enforcement is the most common split

Add any others that apply. **Cap at 6 mutations.** If more than 6 seem necessary, the check is
doing too many jobs — that is itself the finding.

### Step 3: Apply, run, observe — one at a time

For each mutation:

1. Apply it.
2. **Run the check.** Actually execute it.
3. Record the verdict: **KILLED** (check went red) or **SURVIVED** (check still passed).
4. Revert.

**The hard rule: reading the code and reasoning "this would fail" does not count.** Existence
is not behaviour; a guard that looks right may never fire. **Paste the actual output** for
every mutation — the red one and the green one. An unpasted verdict is an assertion, not a
result.

If a mutation cannot be run (no harness, no fixture, needs prod data), mark it
**UNTESTED — blocked by {reason}**. Never silently convert it to KILLED.

### Step 4: Judge the surviving mutants

**A surviving mutant means the check does not discriminate on that axis.**

- **Report it. Do NOT silently patch it.** Patching first destroys the evidence of what the
  check was blind to, and that blindness is usually a pattern, not a one-off.
- If the survivor is on the mandatory core (M2/M6/M10), state plainly: **this check is
  decoration on that axis.** Do not soften it.
- Ask the sibling question: **if this check was blind here, what else shares its shape?**
  One surviving mutant usually has siblings elsewhere in the same file or the paired component.

### Step 5: Anti-theatre gate (this skill checking itself)

**A 100% kill rate is a smell, not a victory.** If every mutation was caught, the likely
explanation is that the mutation set was unconsciously chosen from what the check already
catches. Before declaring a clean result:

1. Confirm at least **3 mutations came from the catalogue above**, not invented for this check.
2. Confirm at least one attacked **enforcement/wiring**, not just the predicate.
3. Ask: *what would a mutation that survives look like?* If you cannot imagine one, you have
   not yet found the axis the check is blind on — say so rather than declaring it hardened.

A clean result with only 2 predicate-level mutations is **not** a hardened check. Report it as
**INSUFFICIENTLY PROBED**, which is an honest verdict.

## Output Format

```
## /harden: {check name}

**Claim**: This check fails when ______.
**Predicate**: `{grep-able string}`  ·  **Enforcement**: `{grep-able string}`
**Caller actually passes**: {values found by grep}

| # | Mutation | Verdict | Evidence |
|---|---|---|---|
| M2 | {what was mutated} | KILLED | {pasted output} |
| M10 | {what was mutated} | **SURVIVED** | {pasted output — check still passed} |

**Surviving mutants**: {N}
**Verdict**: HARDENED / DECORATION ON {axis} / INSUFFICIENTLY PROBED
**Siblings to check**: {where else this shape appears}
**Tree restored**: {git status --porcelain output — must match Step 0}
```

If there are zero surviving mutants AND the Step 5 gate passes, say **HARDENED** plainly.
That is a real result and does not need hedging.

## Gotchas

1. **The predicate and the enforcement are usually in different places.** Testing the predicate
   while enforcement sits in an untested handler is the single most common way a check passes
   review and never fires. M10 exists for this and is mandatory for that reason.
2. **A "0 findings" result is a claim about the detector as much as the corpus.** If a check
   returns zero, the first question is whether it *can* return non-zero — not whether the
   corpus is clean.
3. **Do not harden and fix in the same pass.** Hardening produces evidence; fixing consumes it.
   Report first; the user decides what to repair.
4. **Cost discipline.** Six mutations, one check. If this starts running on every commit, it
   has become the thing it was built to prevent — and at that point the right move is to
   promote the specific check into a hook (P16: deterministic rule → enforce in code), not to
   run this skill more often.
5. **Non-deterministic subjects.** For an LLM-scored or judge-based check, mutate the *input*
   (feed it a known-bad record) rather than the model. A judge that scores a deliberately
   broken record as passing is a surviving mutant, and this is often the fastest way to find
   a fail-open eval.
6. **This skill is itself a check.** If it never reports a surviving mutant across several
   runs, it is not proving the codebase is clean — it is failing to discriminate. Escalate the
   mutation set, or stop running it.
