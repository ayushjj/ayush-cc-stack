---
name: level-up
description: Fetch latest Claude Code releases and Anthropic blog updates, diff against last run, and feed novel items into /scout for gap analysis. Weekly recursive self-improvement of your Claude Code setup. Triggers on '/level-up', 'check for updates', 'what did Claude ship', 'what am I missing'.
user_invocable: true
---

# /level-up — Weekly Claude Code Update Scout

Fetch what's new from Anthropic, filter to what you haven't seen, and feed it into `/scout` for gap analysis against your current setup. This is the "recursive self-improvement" loop for your Claude Code operating system.

**Cadence:** Weekly. `/catchup` will nudge you when it's been 7+ days since last run.

## Step 0: Load State

Read `~/.claude/level-up-state.yaml`.

- If the file exists → extract `last_run` date and `processed` lists
- If the file is missing → this is the **first run**. Set `last_run` to 14 days ago from today (to bootstrap with ~2 weeks of history). Create empty processed lists.

Report to user:
> "Level-up: last run was {last_run} ({N} days ago). Fetching updates since then."

## Step 1: Fetch Sources (Parallel)

Fetch from five independent sources. If one fails, continue with the others.

### Source A: CHANGELOG.md (primary — the only complete version list)

```bash
curl -s https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
```

**Why CHANGELOG.md and not the Releases API:** Anthropic does not cut a GitHub Release for every
version. On 2026-08-25 the API returned 404 for v2.1.242/243/244 while CHANGELOG.md carried **~60
items under `## 2.1.243` alone**; the 2026-08-22 run saw only three "Bug fixes" notes and reported
the window clean. platform.claude.com states the canonical pointer itself: *"For updates to Claude
Code, see the complete CHANGELOG.md in the `claude-code` repository."* → `scout-reports/2026-08-25-level-up-report.md`

**Parse:** split on `^## (\d+\.\d+\.\d+)$` headers; each section's bullets are that version's items.
CHANGELOG.md carries no dates, so version-compare against `processed.claude_code_releases` — do NOT
filter by date.

**Filter:**
1. Only versions NOT already in `processed.claude_code_releases`
2. Cap at **10 most recent** versions. If more than 10 are new, process the 10 most recent and note: "({N-10} older versions not processed — run `/level-up` again to catch up)."
3. A version whose only item is "Bug fixes and reliability improvements" is real but content-free — record it as processed, report nothing.

**Fallback:** if the `curl` fails or returns non-markdown, fall back to
`gh api repos/anthropics/claude-code/releases --jq '.[] | {tag_name, published_at, name, body}'`
and **state in the report that coverage is degraded** — the API silently omits whole versions.

**Read EVERY item of every new version — no keyword pre-filter.** Hand the new sections to an
`Agent` (model: opus) with the owner's setup paths (settings.json, hooks/, skills/, output-styles/)
and ask it to check each line against that setup. "Fixed" lines matter as much as "Added": a fix
can make a workaround in a skill or hook removable, and a removable workaround is a quick win.
(2026-10-01: a keyword grep over Added/Changed/Improved read ~1/3 of ~700 lines and the owner
correctly called it a skim.)

Classify each relevant item: FIXES-A-PAIN (cite the workaround file:line) · CHANGES-MY-SETUP
(cite file:line it affects) · NEW-CAPABILITY (before → after for the owner). Mark platform-only
or cosmetic items as low-signal, but count them as read.

### Source B: Anthropic Blog (secondary — announcements)

```
WebFetch https://www.anthropic.com/news
Prompt: "List all news items visible on this page. For each, return: date, title, URL slug (the path after /news/). Return as a structured list."
```

**Filter:**
1. Only items with date after `last_run`
2. Exclude any slug already in `processed.anthropic_news`
3. **Keyword filter:** Only keep items whose title mentions: Claude, Claude Code, API, model, developer, tool, agent, SDK, MCP, coding. Skip pure research/safety/policy posts.

**For each matching blog post:** Fetch the full article via WebFetch and extract the key announcements relevant to Claude Code usage.

**If WebFetch fails:** Log "Anthropic blog fetch failed — continuing with other sources." Do NOT block the pipeline.

### Source C: Platform Release Notes (critical — features that skip /news)

**Why this source exists:** Platform/API features (new beta tools, CLIs, managed-agent infra, advisor tool) often ship on `platform.claude.com` release notes *before or instead of* appearing on `/news` or in GitHub releases. Missing this source caused the 2026-04-14 run to miss advisor tool (Apr 9), Managed Agents + `ant` CLI (Apr 8).

```
WebFetch https://platform.claude.com/docs/en/release-notes/api
Prompt: "List all dated entries newer than {last_run}. For each, return the date header and the full bullet text. Focus on: new beta headers, new tools, new CLIs, SDK changes, managed-agent features, advisor/planner features, permission-mode changes, and anything that looks like a Claude Code-adjacent capability."
```

**Filter:**
1. Only entries with date after `last_run`
2. Exclude any date+slug already in `processed.platform_api` (use `{YYYY-MM-DD}-{short-slug}` as the key, e.g. `2026-04-09-advisor-tool`)
3. **Relevance filter:** Keep entries about: tools, agents, CLIs, SDKs, beta headers, permission/safety features, model-routing features (advisor, executor), managed infra. Skip pure pricing/deprecation notices unless they affect Claude Code usage.

**If WebFetch returns a redirect:** Follow it. The canonical URL may change; follow any 301/307 to completion before treating as failure.

**If WebFetch fails:** Log "Platform release notes fetch failed — continuing with other sources. Note: this source contains platform features that may be missed." Do NOT block.

### Source D: Anthropic Engineering Blog (critical — postmortems & deep-dives)

**Why this source exists:** Engineering posts (capability deep-dives, architectural launches, postmortems) ship at `anthropic.com/engineering`, NOT at `anthropic.com/news`. Missing this source caused the 2026-05-09 run to miss the April 23 Claude Code quality postmortem (3 silent regressions affecting Sonnet 4.6 / Opus 4.6 batch users between Mar 4 → Apr 20) and the April 8 Managed Agents architecture deep-dive. Postmortems in particular have asymmetric value: a missed feature is annoying, a missed postmortem means user artifacts produced during a regression window may need re-evaluation.

```
WebFetch https://www.anthropic.com/engineering
Prompt: "List all blog posts visible on this page with date, title, and full URL slug. Focus on posts dated after {last_run}."
```

**Filter:**
1. Only items with date after `last_run`
2. Exclude any slug already in `processed.engineering_blog`
3. **Keyword filter:** Keep posts mentioning Claude Code, agent, harness, model, prompt, eval, skill, plugin, MCP, hook, postmortem, quality, performance, regression. Skip pure research papers and safety/policy posts.

**For each matching post:** Fetch the full article via WebFetch and extract: behavioral changes that affect users, settings recommendations, known regressions WITH dated windows, postmortem findings.

**Special handling for postmortems:** Surface the affected window prominently in the report — quote `Affected: {model} from {start_date} to {end_date}. Symptoms: {observable behaviors}.` Cross-reference the user's session activity in that window if possible, so re-evaluation candidates are obvious.

**If WebFetch fails:** Log "Engineering blog fetch failed — continuing with other sources. Note: this source contains postmortems and deep-dives that may be missed." Do NOT block.

### Source E: The owner's X bookmarks (what practitioners are doing)

**Why this source exists:** Anthropic's pages say what shipped; the owner's bookmarks say how
people are actually using it, and they are pre-filtered by his own interest. Until 2026-10-01
they fed only `/brief`, never this skill.

```bash
cd ~/dev/[redacted] && python3 harvest.py && python3 harvest.py --status
```
(Pay-per-read, cents per run — this is the owner's routine weekly harvest. If it fails or the
repo is missing, say so in the report and continue.)

New items = ids in `data/index.jsonl` not in `data/catalog.jsonl`. Hand them to an `Agent`
(model: opus) that (1) appends catalog lines per the repo README contract and verifies counts,
(2) scores every new item against the owner's setup and current projects, returning the top 5
as idea · before → after · file it would change (or "new") · effort · confidence, and never
recommending something that already exists (name the existing file instead).

Merge Source E ideas into Step 3 alongside the release items; attribute each to its bookmark.

### Remaining acknowledged gaps (not in scope)

- **`@AnthropicAI` / `@claudeai` X accounts directly** — partly covered by Source E when the owner bookmarks their posts; unbookmarked posts are still missed.
- **Anthropic Discord** — community discussion, no scrape path.
- **Anthropic SDK release notes** (anthropic-sdk-python, anthropic-sdk-typescript GitHub) — useful only for SDK code authors.
- **MCP protocol / server repos** — useful only for MCP-server builders.
- **Compound-engineering plugin GitHub** (`EveryInc/compound-engineering-plugin`) — could add via `gh api repos/EveryInc/compound-engineering-plugin/releases` if plugin-feature drift becomes a tracked stream.

Coverage *claims* without coverage *maps* are just confidence — keep this gap list visible in every run summary so the user knows the territory boundary.

## Step 2: Compile Delta

Merge results from all successful sources into a single update digest:

```markdown
## Claude Code Updates Since {last_run}

### New Versions ({count})
For each CHANGELOG.md version (it carries no dates):
- **{version}**
  - {feature 1}
  - {feature 2}
  - ...

### Anthropic News Blog ({count} relevant posts)
For each post:
- **{title}** ({date})
  - {key announcement 1}
  - {key announcement 2}

### Anthropic Engineering Blog ({count} relevant posts)
For each post:
- **{title}** ({date}) — [postmortem | deep-dive | launch]
  - {key finding 1}
  - {affected window if postmortem: model + dates + symptoms}

### Platform Release Notes ({count} relevant entries)
For each entry:
- **{date}** — {entry summary}
```

**If delta is empty** (no new releases, no new blog posts):
> "No new updates since {last_run}. Your setup is current."
→ Update `last_run` to today, skip to Step 4.

## Step 3: Feed /scout

This is the core integration. Pass the compiled delta as **pasted text input** to the `/scout` pipeline.

**Critical:** Do NOT invoke `/scout` as a separate skill. Instead, **execute Steps 2-6 of the `/scout` skill inline** within this `/level-up` run. This means:

1. Use the compiled delta from Step 2 as the "collected items" (scout Step 1 output)
2. Extract actionable tips from the delta (scout Step 2)
3. Read current setup — CLAUDE.md, settings.json, skills, memory (scout Step 3)
4. Compare & classify each tip (scout Step 4)
5. Run self-review R1-R7 (scout Step 5.5)
6. Generate report saved to `~/.claude/scout-reports/{YYYY-MM-DD}-level-up-report.md` (scout Step 5)
7. Present summary (scout Step 6)

**Report naming:** Use `{date}-level-up-report.md` (not `{date}-report.md`) to distinguish from manual `/scout` runs.

**Source attribution:** In the report, attribute each tip to its source release version or blog post, not just "level-up fetch."

## Step 4: Update State

After the scout analysis completes (or after empty-delta early exit):

1. Set `last_run` to today's date
2. Append all newly processed release tags to `processed.claude_code_releases`
3. Append all newly processed news blog slugs to `processed.anthropic_news`
4. Append all newly processed engineering blog slugs to `processed.engineering_blog`
5. Append all newly processed platform release-note entry keys to `processed.platform_api` (format: `{YYYY-MM-DD}-{slug}`, e.g. `2026-04-09-advisor-tool`)
6. **Prune:** Keep only the last 50 entries in each processed list
7. Write the updated `~/.claude/level-up-state.yaml`

```yaml
# Level-Up State — auto-maintained by /level-up skill
# Do not edit manually unless bootstrapping
last_run: "{today's date}"
processed:
  claude_code_releases:
    - "{tag_1}"
    - "{tag_2}"
  anthropic_news:
    - "{slug_1}"
  engineering_blog:
    - "{slug_1}"
  platform_api:
    - "{YYYY-MM-DD}-{slug_1}"
```

**Back-compat:** If an older state file is missing `platform_api` or `engineering_blog`, treat the missing bucket as empty `[]` — do not crash.

**Error guard:** If ALL sources failed in Step 1, do NOT update `last_run`. This ensures the next run retries the same date range.

## Step 5: Summary

Present to the user:

```
Level-up complete ({last_run} → today).
Fetched: {N} releases, {M} news posts, {E} engineering posts, {P} platform entries, {X} new bookmarks
Sources covered: CHANGELOG.md, anthropic.com/news, anthropic.com/engineering, platform.claude.com, X bookmarks
Sources NOT covered (acknowledged gaps): unbookmarked X posts, Discord, SDK repos, MCP repos, plugin repos
Report: ~/.claude/scout-reports/{date}-level-up-report.md

  - {X} quick wins ready to implement
  - {Y} worth investigating
  - {Z} already covered
  - {P} postmortem-affected windows flagged

Top quick wins:
  1. {tip} → {action}
  2. {tip} → {action}
  3. {tip} → {action}
```

Then offer:
> "Want me to implement the quick wins now?"

**Do NOT implement anything without user approval.**

## Gotchas

1. **Never trust the Releases API for completeness:** it omits entire versions (v2.1.242/243/244 were 404 on 2026-08-25 while 2.1.243 shipped ~60 changes). CHANGELOG.md is the complete list. If you must use the API fallback, say so in the report.
2. **Blog fetch fragility:** `anthropic.com/news` may change structure. If WebFetch returns unparseable content, skip Source B and note it.
3. **Scout context budget:** Running the full scout comparison (Step 3) consumes significant context. With 10 releases × ~20 line items each, that's 200 items before comparison starts. The scout Step 2 extraction filters this down to genuinely actionable tips.
4. **First run is noisy:** With 14 days of history, the first run may surface many items. This is expected — it establishes the baseline. Subsequent weekly runs will be much leaner.
5. **Don't double-count:** Release notes often mention the same feature across multiple releases (introduced in one, fixed in the next). Dedup by feature, not by release.

## Edge Cases

- **Very long gap (30+ days):** Cap at 10 releases per run. Tell the user to run `/level-up` again to process older ones.
- **All items already covered:** Report this positively — "Your setup already covers everything shipped this week."
- **State file corruption:** If YAML parsing fails, treat as first run (bootstrap). Warn the user.
- **No internet / API auth issues:** If `gh api` fails with auth errors, suggest the user check `gh auth status`.
