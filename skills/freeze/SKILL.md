---
name: freeze
description: >
  Use when debugging or investigating to prevent accidental edits outside a specific directory.
  Blocks Edit/Write/MultiEdit to files outside the frozen directory. Triggers on '/freeze',
  'freeze directory', 'lock scope', 'scope lock', 'only edit files in'.
---

# Freeze Mode — Directory-Scoped Edit Lock

Activates a PreToolUse hook that blocks Edit/Write/MultiEdit to files outside a specified directory.

## Activation

The user specifies which directory to allow edits in. Parse the argument:

- `/freeze src/components` → allow edits only in `src/components`
- `/freeze .` → allow edits only in the current working directory
- `/freeze` (no argument) → ask the user which directory to freeze to

Resolve the directory to an absolute path relative to the current working directory, then write it to the flag file:

```bash
echo "/absolute/path/to/allowed/dir" > "$TMPDIR/.claude-freeze-dir" 2>/dev/null || echo "/absolute/path/to/allowed/dir" > "$TEMP/.claude-freeze-dir" 2>/dev/null || echo "/absolute/path/to/allowed/dir" > "/tmp/.claude-freeze-dir"
```

Then confirm: "Freeze mode ON — edits restricted to `{directory}`. Files outside this directory are read-only."

## Behavior While Active

- **Blocked**: Edit, Write, MultiEdit to any file outside the frozen directory
- **Allowed**: Edit, Write, MultiEdit to files inside the frozen directory (including subdirectories)
- **Allowed**: Read, Glob, Grep everywhere (read-only operations are never blocked)
- **Allowed**: All Bash commands (use `/careful` to block destructive Bash commands)

## Deactivation

When the user says "unfreeze", "disable freeze", "remove scope lock", or the investigation is complete:

```bash
rm -f "$TMPDIR/.claude-freeze-dir" 2>/dev/null; rm -f "$TEMP/.claude-freeze-dir" 2>/dev/null; rm -f "/tmp/.claude-freeze-dir" 2>/dev/null
```

Then confirm: "Freeze mode OFF — all directories are now writable."

## Gotchas

- **Requires session restart** after first install: the PreToolUse hook in settings.json must be loaded at session start
- **Flag file persists across sessions**: if a session crashes, freeze mode stays active until reboot or manual removal of the temp file
- **Path comparison is case-insensitive on Windows**: `C:\Users` matches `c:\users`
- **Skill files are outside project dir**: if you freeze to the project dir, you can still edit skill files in `~/.claude/skills/` — those are outside the freeze scope (blocked by design)
- **Does not block Bash**: `echo "bad" > file.txt` via Bash bypasses freeze. Use `/careful` alongside `/freeze` for full protection
