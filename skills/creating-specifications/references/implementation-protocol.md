# Implementation Pre-Flight Protocol

**MANDATORY before any code changes** when the user chooses "Begin implementation" from the spec decision gate. Execute these gates IN ORDER before touching any code.

<step name="read-plan" blocking="true">
## Gate 1: Read the Plan
- Read `specs/{feature}/implementation.md` — identify the FIRST uncompleted task
- Read `specs/{feature}/design.md` — refresh the problem statement and solution approach
- Output: "Starting task: {task description} from implementation.md"

**BLOCK**: Do not proceed if implementation.md has no uncompleted tasks.
</step>

<step name="read-targets" blocking="true" depends_on="read-plan">
## Gate 2: Read Target Files
- Read EVERY file listed in "Files to Change" that this task touches
- Output: "Read {file}:{lines} — current state: {brief summary}"

**BLOCK**: Do not edit any file you have not read in this step. (Harness-enforced since 2026: Edit/Write error on files not Read this session — ex-CLAUDE.md Rule 4, retired 2026-07-04.)
</step>

<step name="baseline" depends_on="read-targets">
## Gate 3: Baseline Check
- Run relevant tests or type checks (`npm run check`, `pytest`, etc.) BEFORE making changes
- Record: pass count, fail count
- Output: "Baseline: {X} pass, {Y} fail"

If baseline already has failures, note them so you don't chase pre-existing issues.
</step>

<step name="scope-check" depends_on="read-targets">
## Gate 4: Scope Gut-Check
After reading the target files, assess: is this task roughly as complex as the plan estimated?

- If YES → proceed to implementation
- If SIGNIFICANTLY harder → pause and tell the user: "This task is more complex than the spec estimated because {reason}. Options: (a) push through, (b) revise spec, (c) scale back scope."

This gate prevents the "45min on a 10min task" pattern.
</step>

After all gates pass → pick the next unchecked item from the Test Queue → write a failing test for it → write minimum code to make it pass → run all tests → mark it done in implementation.md → say "ready for next" and wait for user's "go". Do NOT work ahead of the queue. Watch for: functionality not asked for, unnecessary complexity, deleted/weakened tests (Beck's anti-cheat — `~/.claude/evals/mistake-ledger.md`).

## Post-Task Checklist
After EACH completed task:
- [ ] Tests pass (compare to baseline — no new failures)
- [ ] implementation.md updated (task marked complete, deviations noted)
- [ ] If task revealed design flaw → pause, tell user, offer to revise spec
