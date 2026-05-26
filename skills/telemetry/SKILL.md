---
name: telemetry
description: Use when you want to see skill usage patterns, session frequency, or identify which skills are undertriggering. Triggers on '/telemetry', 'skill usage', 'session stats', 'how often do I use'.
---

# Skill Telemetry Reader

Reads `telemetry/skill-log.jsonl` and produces a summary.

## Steps

1. Read `telemetry/skill-log.jsonl` — if empty or missing, say "No telemetry entries yet. Run `/wrap` after a session to start logging."
2. Parse each line as JSON
3. Present summary:
   - **Total sessions**: count of entries
   - **Date range**: earliest to latest
   - **Skills used**: frequency table (skill → count), sorted descending
   - **Insights added**: total across all sessions
   - **Avg session duration**: mean of `duration_min`
   - **Recent sessions** (last 5): date, skills, outcome (one line each)
