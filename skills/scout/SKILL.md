---
name: scout
description: Use when you have bookmarked AI workflow tips (URLs, articles, tweets, screenshots) to analyze against your current Claude Code setup and find gaps. Triggers on '/scout', 'workflow tips', 'compare setup', 'what am I missing'.
user_invocable: true
effort: high
---

# /scout — AI Workflow Intelligence Pipeline

You are analyzing AI coding workflow tips and comparing them against your current Claude Code setup. The user provides a batch of inputs (URLs, pasted text, screenshots) and you produce a structured gap analysis report.

**This is NOT automated monitoring.** you run this manually when you have a batch of bookmarked tips to process.

## Input Formats

The user provides a mixed batch inline when invoking the skill:
- **URLs** — tweet URLs, article URLs (fetched via Jina Reader)
- **Pasted text** — raw tweet/article content
- **Screenshots** — image paths (Read tool can view images)

## Step 1: Collect & Fetch

Parse the user's input to identify each item and its type (URL, text, image path).

**For URLs:**
1. Fetch via Jina Reader: `WebFetch` with URL `https://r.jina.ai/{original_url}`
   - Prompt: "Extract the full content of this page including author, text, and any linked URLs"
2. **X/Twitter special case:** If the URL is `x.com/*` or `twitter.com/*` and Jina returns < 300 words → ask the user: "This tweet/thread didn't fetch fully. Please paste the text directly."
3. **Thread handling:** If content mentions "1/", "thread", or appears truncated → ask user to paste the full thread text

**For screenshots:**
1. Use the Read tool to view the image
2. Extract the specific tip/suggestion being shown
3. If the screenshot is too ambiguous to extract a clear actionable tip → skip it and note in the final report as "Skipped: {path} (ambiguous screenshot)"

**For pasted text:**
- Use directly, no fetching needed

Output: an internal working list of `{source, content, type}` items. Present a brief status to the user:
> "Collected N items (X URLs fetched, Y text blocks, Z screenshots)."

## Step 2: Extract Actionable Tips

For each content item, extract structured tips:

- **What**: The specific technique/workflow/tool suggestion (one sentence)
- **How**: Implementation details if provided (configuration, commands, patterns)
- **Category**: One of: `skill`, `hook`, `setting`, `claude-md-rule`, `tool`, `workflow-pattern`, `prompt-technique`, `architecture`
- **Applicability**: `claude-code-specific` | `ai-coding-general` | `agent-design`

**Quality gate — skip items that are:**
- Opinions without actionable suggestions ("AI is amazing" → skip)
- Product announcements without workflow implications ("Company X raised $Y" → skip)
- Content already captured in knowledge graph (check graph-index.yaml titles from Step 3)
- Already analyzed in a previous scout report (check `~/.claude/scout-reports/` for same source URL or near-identical tip text)

**Source fidelity:** Extract only what the source actually says. Do not supplement with training data. If a tip is vague ("use hooks"), extract it as-is — the comparison step will determine if it's actionable enough.

Report to user: "Extracted N actionable tips from M items (K skipped)."

## Step 3: Read Current Setup

Read these files to understand your current Claude Code configuration. **Read all in parallel** where possible:

1. `~/.claude/CLAUDE.md` — current rules, mistake patterns, principles
2. `~/.claude/settings.json` — hooks, permissions, model settings
3. `~/.claude/settings.local.json` — local overrides (if exists; skip if missing)
4. Glob `~/.claude/skills/*/SKILL.md` — list all skills (read only names + descriptions from frontmatter, not full content)
5. `~/.claude/projects/C--Users-User/memory/MEMORY.md` — current memory index
6. `~/desktop/knowledge-graph/graph-index.yaml` — existing insights (for dedup against knowledge graph)
7. Glob `~/.claude/projects/*/memory/*.md` — scan for user workflow details
   (voice input, editor prefs, parallel sessions, tool choices, stated philosophy).

**Build a concise internal summary** of the current setup:
- List of all skills (name: one-line description)
- List of all hooks (trigger → command)
- Key CLAUDE.md rules and patterns (the principles, mistake patterns, command discipline rules)
- Settings: model, permissions mode, any custom config
- User profile: tools in use, workflow patterns, stated philosophy (from memory files)

This summary is internal working material — do not output it to the user.

## Step 4: Compare & Analyze

For each extracted tip, classify it into exactly one bucket:

### Already Implemented
The current setup already does this. Cite the specific evidence:
- For skills: `~/.claude/skills/{name}/SKILL.md` — skill name
- For hooks: `~/.claude/settings.json` — hook description
- For CLAUDE.md rules: `~/.claude/CLAUDE.md:{line}` — the rule text
- For settings: `~/.claude/settings.json` — the setting

### Partially Implemented
The setup has something similar but the tip suggests a meaningful improvement. Explain what's missing or weaker.

### Novel
Completely new to the setup. This is the highest-value bucket — these are genuine gaps.

### Contradicts
The tip conflicts with an existing rule or principle. Explain both sides so the user can decide.

### Not Applicable
The tip requires tools/platforms the user doesn't have (e.g., macOS-only, specific IDE, browser extension). Briefly note why.

**Comparison methodology (3 layers — do ALL three, not just keyword search):**

1. **Keyword scan**: Grep CLAUDE.md, settings.json, and skill names for terms directly
   mentioned in the tip. This catches exact matches.

2. **Semantic scan**: For each tip, ask: "What *problem* does this tip solve?" Then scan
   the setup summary (from Step 3) for anything that solves the same problem differently.
   Examples:
   - Tip: "add a pre-commit hook for linting" → check if any existing hook
     (PostToolUse, PreToolUse, Stop) already serves a linting/quality purpose
   - Tip: "use AGENTS.md code standards" → check if CLAUDE.md principles or
     command discipline rules already encode similar coding constraints
   - Tip: "enable extended thinking" → check settings.json for
     `alwaysThinkingEnabled` or similar

3. **Functional scan**: For tips in the `skill` or `workflow-pattern` categories, read
   the full SKILL.md of the 2-3 most likely overlapping skills (not just frontmatter).
   A tip might describe a workflow that an existing skill already implements under a
   different name.

**Output evidence standard**: Every classification MUST cite file:line (or file +
specific setting/hook name). "Not implemented" requires stating: "Searched CLAUDE.md
(N rules, M principles), settings.json (P hooks), Q skills — no match found."

## Step 5: Generate Report

Save a structured report to `~/.claude/scout-reports/{YYYY-MM-DD}-report.md`.

If a report already exists for today's date, append a counter: `{YYYY-MM-DD}-report-2.md`.

**Report format:**

```markdown
# Scout Report — {YYYY-MM-DD}

## Sources Processed
- {count} items from {list of source types/URLs}
- {skipped count} skipped (with reasons)

## Recommendations (by priority)

### Quick Wins (< 5 min each)
| # | Tip | Source | Category | Current State | Action |
|---|-----|--------|----------|---------------|--------|
| 1 | ... | ...    | ...      | Not implemented | Add X to CLAUDE.md |

### Worth Investigating (need research/testing)
| # | Tip | Source | Category | Current State | Action |
|---|-----|--------|----------|---------------|--------|
| 1 | ... | ...    | ...      | Partial — we have Y but not Z | Research Z, test with ... |

### Already Covered
| Tip | Source | How We Already Do This |
|-----|--------|----------------------|
| ... | ...    | CLAUDE.md:{line} — rule text |

### Conflicts / Tradeoffs
| Tip | Source | Conflict With | Analysis |
|-----|--------|---------------|----------|
| ... | ...    | Principle #N  | Tip says X, we do Y because ... |

### Not Applicable
| Tip | Source | Reason |
|-----|--------|--------|
| ... | ...    | Requires macOS / specific tool |

## Knowledge Graph Candidates
Tips that represent **strategic insights or mental models** worth preserving in the knowledge graph (run `/learn` on these).

**Qualification gate — only include tips that are:**
- A reusable mental model or decision framework (not a specific tool/config how-to)
- About *why* something works, not *how* to set it up
- Applicable beyond the specific tool mentioned (generalizable principle)

**Do NOT include:**
- Tool installation/configuration tips (these belong in MEMORY.md or skill docs)
- Workflow tweaks that are already captured by implementing the scout recommendation
- Tips that are fully addressed by the Quick Win or Worth Investigating action

Examples:
| Tip | KG? | Why |
|-----|-----|-----|
| "agent-browser eliminates manual auth flows" | No | Tool-specific how-to; value is captured by installing it |
| "When agents handle auth, the browser becomes another agent interface — not a human one" | Yes | Generalizable insight about agent-native architecture |
| "Single-line code standards in config files improve quality more than elaborate skills" | Yes | Mental model about simplicity vs complexity |
| "Use `--cdp 9222` to connect agent-browser on Windows" | No | Platform-specific how-to; belongs in MEMORY.md |

If no tips qualify, write: "(none — all tips are actionable workflow items, not strategic insights)"

## Review Notes
- {any reclassifications, evidence upgrades, or conflicts caught during self-review}
- {or "Self-review: all recommendations verified"}
```

**Priority ordering within Quick Wins and Worth Investigating:**
1. Claude-code-specific tips first (most directly actionable)
2. Within that: `hook` and `setting` changes before `claude-md-rule` (mechanical > behavioral)
3. Then ai-coding-general tips
4. Agent-design tips last (most speculative)

## Step 5.5: Self-Review (Mandatory)

Before presenting the report, review each recommendation across 4 dimensions:

### R1: Evidence Quality
For each "Already Implemented" or "Partially Implemented" classification:
- Is the cited evidence actually equivalent to the tip, or just superficially similar?
- Could you be missing a meaningful gap by pattern-matching on keywords?

For each "Novel" classification:
- Did you check all three layers (keyword, semantic, functional)?
- State what you searched and didn't find.

### R2: Actionability Check
For each Quick Win:
- Is the action specific enough to execute in < 5 min? (e.g., "Add X to CLAUDE.md"
  is good; "Consider improving Y" is not)
- Would the user know exactly what to type/configure?

For each Worth Investigating:
- Is the research direction clear? What specific question needs answering?

### R3: Conflict Detection
- Do any recommended tips conflict with EACH OTHER? (Not just with existing setup)
- Would implementing Quick Win #1 make Quick Win #2 redundant or contradictory?

### R4: Priority Accuracy
- Are Quick Wins genuinely quick (< 5 min)? If unsure, move to Worth Investigating
- Are the highest-priority items really the most impactful, or just the easiest?

### R5: Dedup Against Prior Evaluations
- Read `~/.claude/scout-reports/*.md` headers — check if the same CONCEPT was
  previously evaluated (not just same URL — same concept under different tool names).
- Check MEMORY.md benchmarking/gstack/setup-comparison sections for prior assessments.
- If previously evaluated and deferred → reclassify as "Already Evaluated" with citation.

### R6: User Profile Verification
- Cross-check each Novel/Worth Investigating tip against the User Profile (from Step 3).
- Tips about tools/workflows the user already uses won't appear in config files —
  they live in memory files (voice input, parallel sessions, editor preferences).
- If tip matches user's existing workflow → reclassify to "Already Covered" with
  memory file citation.

### R7: First-Principles "Earns Its Place"
For each surviving Novel/Worth Investigating recommendation, ask:
1. Does this serve the user's stated philosophy, or a different operating model?
2. Is this solving a problem the user actually has right now?
3. Would adopting this add complexity that works against the system?
4. **Capability frontier**: Would this meaningfully raise the quality ceiling of the
   engineering pipeline — planning, execution, code quality, security, or review —
   even if the user isn't currently hitting that ceiling? The Scout's core job is not
   just pain relief (fixing friction) but capability maximization (keeping the user at
   the top percentile). A tip that passes Q4 but not Q2 is still valuable — classify
   it as "Worth Investigating (ceiling-raiser)" rather than demoting it.

Demote philosophy-mismatches → "Conflicts / Tradeoffs" with analysis.
Demote solutions for nonexistent problems → "Not Applicable (no current need)" —
BUT only if Q4 also fails. If Q2 fails but Q4 passes, keep it as Worth Investigating.

R5-R7 can reclassify tips from Step 4. When reclassifying, note the original
classification and reason for change in Review Notes.

**After review**: If any recommendation fails a dimension, fix it in the report before
presenting. Note at the bottom of the report:

```
## Review Notes
- {any reclassifications, evidence upgrades, or conflicts caught during self-review}
- {or "Self-review: all recommendations verified"}
```

## Step 6: Present & Offer Next Steps

Show the user a summary of the report (not the full markdown — they can read the file):

```
Scout report saved to ~/.claude/scout-reports/{date}-report.md

Summary:
  - {N} quick wins ready to implement
  - {M} worth investigating further
  - {P} already covered in current setup
  - {Q} conflicts to review
  - {R} not applicable

Top 3 quick wins:
  1. {tip} → {action}
  2. {tip} → {action}
  3. {tip} → {action}
```

Then offer:
> "Want me to implement the quick wins now, or run `/learn` on the knowledge graph candidates?"

**Do NOT implement anything without user approval.** The report is the deliverable — implementation is a separate step.

## Gotchas

These are accumulated failure points from real `/scout` sessions.

1. **Dedup against previous reports:** Always check `~/.claude/scout-reports/` for same source URL or near-identical tips before classifying as "Novel." Multiple scout runs on related sources will surface the same tips.
2. **X/Twitter fetch failures:** Jina Reader cannot reliably parse X Articles (JS-rendered). If URL is `x.com/*` or `twitter.com/*` and fetch returns < 300 words, ask user to paste the text.
3. **Superficial "Already Implemented" matches:** Keyword-matching on CLAUDE.md can falsely classify tips as already covered. Always run all 3 comparison layers (keyword, semantic, functional) — a tip about "hooks for safety" is NOT the same as having a PostToolUse reminder hook.
4. **Context limits on large articles:** Very long source articles can consume significant context before the comparison phase even begins. For articles > 3000 words, extract tips first, then read setup files — don't load both simultaneously.
5. **Missing user profile context:** Tips about voice input, parallel sessions, or
   editor preferences live in memory files, not settings.json. R6 catches these —
   but only if Step 3 reads memory files. If memory files don't exist, R6 has no data.

*(Update this section when new failure patterns emerge.)*

## Edge Cases

- **All tips already implemented:** Report this as a positive signal — "Your setup already covers everything in this batch." Still save the report (useful as an audit trail).
- **No actionable tips extracted:** Tell the user: "None of these items contained actionable workflow tips. They may be opinions, announcements, or too vague." List what was skipped and why.
- **URL fetch fails:** Log the failed URL, continue processing remaining items. Include failed URLs in the report under "Sources Processed" with "(fetch failed)" annotation.
- **Very large batch (10+ items):** Process all of them — this skill is manual and infrequent, so thoroughness matters more than speed.
- **Duplicate tips across sources:** If two sources suggest the same thing, merge into one tip and cite both sources.
- **Screenshot with code:** If a screenshot shows code/config, extract the specific configuration or pattern — don't just describe what you see.
