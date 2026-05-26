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
2. Check for active spec: `ls specs/*/implementation.md` — if exists, read current task
3. Compare stated intent against the actual diff file list

Classify as:
- **CLEAN** — changes match stated intent. Proceed.
- **DRIFT** — changes include files not related to stated intent. Report: "Scope drift detected: {files} are outside the stated intent of {intent}. Intentional?" Then proceed with review.
- **NO INTENT** — no commit messages, no spec, no context. Proceed without scope check.

### 3. Scope guard — content-only changes

If ALL changed files are documentation (`.md` files only, no code):
- Report: "Content-only changes. No code review needed. Ready to commit."
- Skip to Step 7 (set flag).

### 4. Identify changed code files

From the combined diff list, collect code files (not `.md`, not config-only). These are the files to review.

### 5. Run review agents IN PARALLEL

Launch agents using the Agent tool in a single message.

**Universal agents (always included):**

| Agent (`subagent_type`) | Prompt focus |
|------------------------|--------------|
| `compound-engineering:review:code-simplicity-reviewer` | Unnecessary complexity, over-engineering, premature abstractions |
| `compound-engineering:review:security-sentinel` | Injection, secrets, OWASP. **Confidence gate: >= 8/10 only.** Every finding needs a concrete exploit scenario. Filter false positives: framework-safe patterns (React XSS, Django CSRF), env vars as trusted input, test-only files. |
| `compound-engineering:review:performance-oracle` | Slow paths, memory issues, N+1 queries, inefficient data loading |
| `compound-engineering:review:architecture-strategist` | Component boundaries, coupling, design consistency |
| `compound-engineering:review:pattern-recognition-specialist` | Duplication, anti-patterns, naming inconsistencies |

**Language-specific agent (pick ONE based on Step 1):**

| Language | Agent | Focus |
|----------|-------|-------|
| TypeScript/JS | `compound-engineering:review:kieran-typescript-reviewer` | TS conventions, type safety, idiomatic patterns |
| Python | `compound-engineering:review:kieran-python-reviewer` | Python conventions, type hints, Pythonic patterns |
| Ruby/Rails | `compound-engineering:review:kieran-rails-reviewer` | Rails conventions, ActiveRecord patterns, view components |

Total: **6 agents** (5 universal + 1 language-specific), all launched in parallel.

For each agent, include:
- The list of changed code files
- The full content of each changed file (read them before launching agents)
- Project context: brief description from CLAUDE.md or auto-detected (e.g., "Python data pipeline for procurement intelligence" or "Astro static site with React islands")
- **Review checklist**: Read `~/.claude/skills/review/checklist.md` and include its contents in every agent prompt. Instruct agents: "Flag any finding that matches a checklist item. Cite the checklist item number."

### 6. Synthesize results

Collect all agent findings and categorize:

**Must fix** — Bugs, security vulnerabilities, broken functionality, type/compile errors
**Should fix** — Code smells, duplication, performance concerns, maintainability issues
**Consider** — Style preferences, minor improvements, optional enhancements

### 7. Verdict

- If zero **must fix** items: "Ready to commit."
- Otherwise: List what needs to be addressed before committing.

### 8. Set review gate flag

After delivering the verdict (regardless of outcome), create the flag so commits are unblocked:

```bash
touch "$TMPDIR/.claude-review-done"
```

This flag is checked by the PreToolUse commit gate hook. It persists until the session ends or system reboot.

## Agent Selection Reference

| Skipped Agent | When to include |
|---------------|----------------|
| `dhh-rails-reviewer` | Only if user explicitly requests Rails-philosophy review |
| `julik-frontend-races-reviewer` | Only if changed files include Stimulus controllers or async JS |
| `agent-native-reviewer` | Only if project has an agent API surface |
| `data-integrity-guardian` | Only if changed files include database migrations |
| `data-migration-expert` | Only if changed files include data migration scripts |
