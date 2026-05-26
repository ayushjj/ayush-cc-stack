---
name: careful
description: >
  Use when running risky operations (database migrations, file cleanup, deploys) to block
  destructive Bash commands. Activates on-demand hooks that block rm -rf, DROP TABLE,
  git push --force, git reset --hard, kubectl delete, and similar. Triggers on '/careful',
  'careful mode', 'block destructive commands', 'safe mode'.
---

# Careful Mode — On-Demand Destructive Command Blocking

Activates a PreToolUse hook that blocks destructive Bash commands for the remainder of this session.

## Activation

Create the flag file to activate blocking:

```bash
touch "$TMPDIR/.claude-careful-mode" 2>/dev/null || touch "$TEMP/.claude-careful-mode" 2>/dev/null || touch "/tmp/.claude-careful-mode"
```

Then confirm: "Careful mode ON — destructive Bash commands are now blocked."

## What Gets Blocked

| Pattern | Example |
|---------|---------|
| `rm -rf` / `rm -f` | `rm -rf /var/data` |
| `DROP TABLE/DATABASE` | `DROP TABLE users;` |
| `git push --force` / `-f` | `git push --force origin main` |
| `git reset --hard` | `git reset --hard HEAD~3` |
| `git clean -f` | `git clean -fd` |
| `git checkout .` | `git checkout .` |
| `kubectl delete` | `kubectl delete pod` |
| `TRUNCATE TABLE` | `TRUNCATE TABLE logs;` |
| `rmdir /s` (Windows) | `rmdir /s /q build` |
| `del /f` (Windows) | `del /f *.bak` |

## Behavior While Active

- Blocked commands return an error message instead of executing
- Non-destructive commands proceed normally
- Read-only commands (git log, ls, cat) are never affected

## Deactivation

When the user says "disable careful mode", "turn off careful", or the risky work is complete:

```bash
rm -f "$TMPDIR/.claude-careful-mode" 2>/dev/null; rm -f "$TEMP/.claude-careful-mode" 2>/dev/null; rm -f "/tmp/.claude-careful-mode" 2>/dev/null
```

Then confirm: "Careful mode OFF — all commands allowed."

## Gotchas

- **Requires session restart** after first install: the PreToolUse hook in settings.json must be loaded at session start
- **Flag file persists across sessions**: if a session crashes without cleanup, careful mode stays active until reboot (temp dir) or manual removal
- **Pattern matching is regex-based**: unusual flag combinations (e.g., `rm -r -f` with a space) may slip through — report missed patterns so they can be added
- **Does not block Edit/Write**: this skill only guards Bash commands. Use `/freeze` to restrict file edits to a specific directory
