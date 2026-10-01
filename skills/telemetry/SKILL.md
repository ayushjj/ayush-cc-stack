---
name: telemetry
description: Report how often each skill runs and — more importantly — WHY it runs: which mechanism (hook, CLAUDE.md rule, memory file, cadence) causes it, and which skills have no mechanism at all. Use before /skill-audit, when a skill seems never to fire, or when deciding whether to wire, retire, or keep a skill manual. Triggers on '/telemetry', 'skill usage', 'session stats', 'which skills never fire', 'is this skill wired', 'how often do I use'.
---

# Skill Telemetry Reader

Two modes. Mode B is the one that answers "why doesn't this skill ever fire?"

## Mode B: firing-mechanism inventory (default for audit questions)

```bash
node ~/.claude/skills/telemetry/scripts/skill-inventory.js
```

Three usage channels (self-reported wrap logs = long history; `Skill`-tool calls =
model-initiated; slash commands = user-typed) against four mechanism signals. The channels
disagree usefully: `catchup` has 300+ user-typed invocations and **zero** model-initiated ones,
so its description has never once caused a fire.

Present the table, then classify each skill as **wire it** / **retire it** / **keep manual**.
Honour the script's printed caveats — they exist because each one already produced a wrong
verdict on a real run.

## Mode A: session stats

Reads `telemetry/skill-log.jsonl` and produces a summary.

### Steps

1. Read `telemetry/skill-log.jsonl` — if empty or missing, say "No telemetry entries yet. Run `/wrap` after a session to start logging."
2. Parse each line as JSON
3. Present summary:
   - **Total sessions**: count of entries
   - **Date range**: earliest to latest
   - **Skills used**: frequency table (skill → count), sorted descending
   - **Insights added**: total across all sessions
   - **Avg session duration**: mean of `duration_min`
   - **Recent sessions** (last 5): date, skills, outcome (one line each)
