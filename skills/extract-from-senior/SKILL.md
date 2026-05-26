---
name: extract-from-senior
description: Use when extracting wisdom from a senior engineer's writing (Simon Willison, Hamel Husain, Kent Beck, Geoffrey Litt, etc.) to find adoption candidates for your Claude Code OS or active project. Triggers on '/extract-from-senior', 'learn from {engineer}', 'distill {author}', 'what can we borrow from'.
user_invocable: true
effort: high
---

# /extract-from-senior — Senior Engineer Wisdom Extraction Pipeline

You are distilling a senior engineer's writing into adoption candidates for Ayush's Claude Code OS — and, if a project is active, into project-specific deltas. The user provides an engineer name plus one or more canonical URLs (blog posts, essays, gists, podcast transcripts). You produce a single structured extraction report with Pass C source-fidelity + Pass B concrete-reality inversion baked in as mandatory steps.

**This skill exists because forward synthesis drifts toward narrative coherence.** The 2026-04-15 Simon/Hamel/Beck/Litt extraction shipped 5 over-claims in its first draft — softened Beck's "control mechanism" to "superpower", extended Litt's end-user scope to enterprise SaaS, claimed a 20-phrase library Simon never supported. All 5 were caught only by re-reading verbatim quotes against the synthesis. **This skill makes that re-reading mandatory (Step 5), not optional.** Without Pass C, every future extraction re-incurs the same drift risk. See CLAUDE.md Principle 42 for the full pattern.

## Input Formats

The user invokes with:
- **Engineer name** (required): `/extract-from-senior Simon Willison`
- **Canonical URL(s)** (required): 1-5 URLs pasted inline or on follow-up lines
- **Optional flags**:
  - `--project {name}`: bias adoption analysis toward a named active project (e.g., `--project my-active-project`). If omitted, adoption analysis stays at Claude Code OS level only.
  - `--deep`: fetch linked deeper pieces from the canonical page (up to 5). Default: fetch only URLs the user provided.

If the user invokes the skill with only an engineer name and no URLs, ask:
> "Which canonical piece(s) should I distill? Paste 1-5 URLs. Example: `https://simonwillison.net/guides/agentic-engineering-patterns/`"

Do NOT guess URLs. Wait for user input.

## Step 1: Fetch

Fetch each URL via Jina Reader in parallel (single message, multiple `WebFetch` calls):
- URL pattern: `https://r.jina.ai/{original_url}`
- WebFetch prompt: "Extract the full content of this page including author name, publication date, full body text, and any linked URLs. Preserve verbatim quotes and prescriptive statements exactly as written."

**Special cases:**
- **X/Twitter URLs** (`x.com/*`, `twitter.com/*`): if Jina returns < 300 words → ask user to paste the thread text directly. JS-rendered content often truncates.
- **Gist URLs** (`gist.github.com/*`): Jina usually works; if the gist is a full system prompt or code block, preserve the raw structure — these are the single highest-value artifacts.
- **Podcast transcripts**: fetch succeeds but quality varies. Flag any podcast quote as "podcast-summary attribution" in the evidence base — you may be quoting the host's paraphrase, not the guest's actual words.
- **Paywalled / login-gated**: if fetch returns a login page → ask user to paste text directly. Do not fabricate content from training data.

After fetching, report to user:
> "Fetched N pages from {engineer}. Total ~K words. Proceeding to evidence base."

If `--deep` is set: scan the canonical piece for outbound links to the same engineer's other writing (own-domain links usually — not external citations). Fetch up to 5 additional linked pieces in a second parallel batch. Show the user which links were selected and fetched.

## Step 2: Build Verbatim Evidence Base (Fidelity Gate — NON-NEGOTIABLE)

Before any synthesis, extract structured verbatim evidence. This is the ground truth that Pass C (Step 5) will check your synthesis against. **If this step is skipped or thin, Pass C becomes non-functional.**

For each fetched piece, record:

1. **Author attribution (exact)**: name as it appears in the byline, @handle if shown, publication date, article title. These are the *only* permitted attribution values downstream.

2. **Core thesis (1-2 sentences, verbatim where possible)**: pull the author's own framing of the central argument. Do not paraphrase into your own words.

3. **Prescriptive statements (verbatim, 3-8 per piece)**: sentences where the author tells the reader what to do. Quote with quotation marks. Example: `"Don't file pull requests with code you haven't reviewed yourself." — Simon Willison`

4. **Named patterns + mechanisms**: each named concept (e.g., "red/green TDD", "Betty-Buzz", "L1/L2/L3 eval pyramid") with a 1-2 sentence verbatim or near-verbatim definition from the source.

5. **Named failure modes**: each thing the author explicitly flags as a danger (e.g., Beck's "any indication the genie was cheating, for example by disabling or deleting tests"). Verbatim.

6. **Scope boundaries (what they DO NOT cover)**: explicit gaps. If Hamel says "I don't address multi-tenant scaling" or Litt's scope is "end-user tools only" — record these verbatim. These are the guardrails that prevent your synthesis from extending their claims.

7. **Referenced other engineers**: names the author cites approvingly. These are candidates for future extractions (seed the next `/extract-from-senior` run).

Write the evidence base to a working file at `~/.claude/scout-reports/.evidence-{date}-{engineer-slug}.md` — leading dot marks it as internal scratch. You will reference this file in Step 5.

Report to user:
> "Evidence base built: {N} prescriptive statements, {M} named patterns, {K} failure modes, {L} scope boundaries. Proceeding to synthesis."

## Step 3: Read Current Setup (Parallel)

Read these to understand Ayush's current Claude Code OS and, if `--project` was set, the project's state. **Read all in parallel.**

Always:
1. `~/.claude/CLAUDE.md` — rules, mistake patterns, principles table
2. `~/.claude/projects/<your-home-slug>/memory/MEMORY.md` — cross-project memory index (Claude Code derives `<your-home-slug>` from `$HOME` by replacing `/` with `-` — e.g., `-Users-<name>` on macOS, `C--Users-<name>` on Windows)
3. Glob `~/.claude/skills/*/SKILL.md` — skill names + descriptions (frontmatter only, not full bodies)
4. `~/.claude/settings.json` — hooks, permissions, model

If `--project {name}` was set:
5. Project's `CLAUDE.md` (if exists)
6. Project's MEMORY section from MEMORY.md (Ayush's cross-project memory keys project state under `# Memory — {Project}`)
7. Project's implementation plan (commonly `docs/IMPLEMENTATION-PLAN.md` or `~/.claude/plans/{project-slug}.md`)

Build a concise internal summary (do not show full content to user):
- Current skills (name → one-line description)
- Current rules (Command Discipline Rules 0-8, Mistake Patterns count, Principle count)
- Project phase and active blockers (if project specified)

## Step 4: Synthesize Adoption Candidates (Forward Pass)

For each named pattern / prescriptive statement / failure mode from the evidence base, classify against current setup:

| Classification | Meaning | Action |
|---|---|---|
| `already-have` | We implement this (name the skill/rule/principle) | Skip — do not list as adoption |
| `weak-version` | We have a shape-similar thing but not purpose-identical | List as "consider strengthening" with explicit shape-vs-purpose distinction |
| `genuine-gap` | No current equivalent | List as adoption candidate — requires genuine-improvement filter (below) |
| `not-relevant` | Depends on tool/context we don't use (e.g., advice for a specific language/framework we're not using) | Skip with one-line reason |

**Genuine-improvement filter (MANDATORY for every `genuine-gap` candidate)**:

Each `genuine-gap` adoption must name:
- A specific Mistake Pattern row from CLAUDE.md it would have prevented, OR
- A specific Principle (P#) it would have strengthened, OR
- A specific past session (from MEMORY.md or session registry) where adopting it would have led to measurably different action

**If none of those map, reject the candidate.** Pattern-matches to training-data tropes are not adoption criteria. The filter exists because forward synthesis over-generates plausible-sounding adoptions; past-failure grounding is the anchor.

For each surviving candidate, record:
- Adoption name (short, 3-6 words)
- Concrete implementation (1-3 sentences: what file/skill/rule changes, how)
- Cost estimate (low / medium / high — in terms of your time, not tokens)
- Past failure it would have prevented (cite row or principle #)

Output an internal draft: a bulleted list of surviving adoption candidates. **Do NOT write to the final report yet** — Steps 5 and 6 will revise or kill candidates.

## Step 5: Pass C — Source-Fidelity Re-Read (MANDATORY, DO NOT SKIP)

This is the step that makes this skill worth having. Without it, Step 4's output is free-form synthesis with no drift guard. **The 2026-04-15 session caught 5 over-claims in 5 minutes at this step. Zero were caught by forward synthesis alone.**

Re-read the evidence base file from Step 2 (`~/.claude/scout-reports/.evidence-{date}-{engineer-slug}.md`). For every framing phrase in your Step 4 draft, ask:

**Does this phrase appear verbatim in any fetched quote?**

If the phrase is:
- **In your synthesis but NOT in any verbatim quote** → flag as drift. Either revise to use the author's actual words OR explicitly label the phrase as "your extension of their model, not their claim."
- **Stronger or weaker in tone than the source** → restore the source's tone. (Example failure: softening Beck's "control mechanism" to "superpower" — inverts the message from constraint to amplification.)
- **Extended in scope beyond what the source covers** → pull back to source scope OR flag the extension explicitly. (Example failure: extending Litt's end-user-tool scope to enterprise multi-tenant SaaS.)
- **Inflating counts or examples** → correct to the exact count the source gives. (Example failure: claiming a 20-phrase library when Simon named 2.)
- **Claiming isomorphism when only shape matches** → downgrade to "shape similarity" with explicit purpose-difference note.

Produce a **Pass C findings table** in your working notes:

| Synthesis phrase | Verbatim source says | Verdict |
|---|---|---|
| [your phrasing] | [quote from evidence base, or "not in source"] | [extension / softened / inflated / shape-only / verified] |

**Every synthesis phrase** touching adoption candidate names, strength claims, scope claims, or count claims gets a row. Bias toward too many rows, not too few.

After the table is built, revise adoption candidates:
- Any candidate where the supporting synthesis drifted → rewrite candidate using source-faithful language, OR kill the candidate if the drift was load-bearing.
- Any candidate that only survived via inflated count or extended scope → kill.

Report to user:
> "Pass C: {N} synthesis phrases checked, {K} drift findings. {J} adoption candidates revised, {M} killed. Surviving: {S}."

## Step 6: Pass B — Concrete-Reality Inversion (per Principle 41)

For each surviving adoption candidate, invert: **"What would make this adoption actively harmful?"** Ground the inversion in the user's operational reality, not in abstract flow.

Concretely, for each candidate:

1. **Walk MEMORY.md** (already in context from Step 3) and name 2-3 specific past sessions where adopting this would have led to different action.
2. **Would the different action have been better?** If yes: adoption is live. If no: kill or narrow.
3. **What would make it actively harmful at scale?** (Perfectionism block? Cargo-cult proliferation? Obsolescence on model upgrade?)

Revise candidates with scope caps, evidence gates, or contextual triggers as needed. Example revision patterns from the 2026-04-15 session:
- "A-row anti-cheat" → scoped to TDD-active contexts (plan.md present or `/red-green` invoked), not universal.
- "Activation-phrase layer" → capped at 15-20, each requires before/after evidence of behavior change.
- "CHOICE opener" → paired with "shipping is also a choice" qualifier to prevent perfectionism read.

Report to user:
> "Pass B: {S} candidates inverted. {R} revised with scope/evidence gates, {K} killed. Final surviving: {F}."

## Step 7: Project-Specific Delta (if `--project` was set)

If the user passed `--project {name}`, dedicate a section to the project:

1. **Starting conditions** this extraction would change. Name the specific files (`CLAUDE.md` for the project, eval harness scaffold, plan.md test queue, etc.) that should be created or modified before the project's next milestone.
2. **Explicit multi-tenant / scale flags**: if the senior engineer's framework is validated at smaller scale than the project needs (Hamel's Rechat case study is single-tenant; PI is multi-tenant), flag the gap and seed the next `/extract-from-senior` run with a candidate source that might close it.
3. **Ordered adoption list**: sequence the adoptions. Structural fixes (skill/scaffold additions) before tactical applications (apply the new rule to one module). Prior session's lesson: flipping this order means the structural fix never lands.

If no project was specified, skip this section.

## Step 8: Write the Extraction Report

Output a single markdown file at:

```
~/.claude/scout-reports/{YYYY-MM-DD}-{engineer-slug}-extraction.md
```

Where `{engineer-slug}` is lowercase-kebab of the engineer name (e.g., `simon-willison`, `kent-beck`). If multiple engineers were extracted in one session, use the joined form: `simon-hamel-beck-litt`.

**Report structure** (sections in order):

```markdown
# Extraction: {Engineer Name(s)} — {Date}

## Sources Fetched
[Bulleted list of URLs with titles and word counts]

## Core Theses (verbatim)
[1-2 sentence thesis per piece, in author's own words]

## Prescriptive Statements (verbatim)
[Top 5-10 quotes with attribution]

## Named Patterns + Mechanisms
[Each pattern: name → 1-2 sentence definition from source]

## Scope Boundaries (what source does NOT cover)
[Explicit gaps — these bound the adoption analysis]

## Comparison Against Current Setup
[Table: Capability | What they do | What we do | Classification]

## Adoption Candidates (post-Pass-C + Pass-B)
### Adopt now
[Each: name, concrete change, past failure prevented, cost]
### Consider (weak-version strengthening)
### Reject / defer
[Each with explicit reason]

## Pass C Findings — Source Fidelity
[Table: Synthesis phrase | Verbatim source | Verdict]

## Pass B Findings — Concrete-Reality Inversion
[Per candidate: 2-3 past sessions + harm-at-scale analysis + revision]

## Project Delta — {Project Name}
[Only if --project was set. Starting conditions + ordered adoption list + scale flags]

## Seed for Next Extraction
[Engineers cited approvingly by this source — candidates for next /extract-from-senior run]

## Metrics
- Sources fetched: N
- Prescriptive statements extracted: M
- Adoption candidates surviving all gates: K
- Pass C drift corrections: J
- Pass B candidate kills: R
```

## Step 9: Report to User (Final)

```
📚 Extracted {engineer(s)} into {report-path}

**Adopt now** ({N}):
  - {adoption-1-name} — prevents {past-failure-row}
  - ...

**Consider** ({M}):
  - {weak-version-1-name}

**Rejected / deferred** ({K}): [one-line reasons]

**Project delta** (if applicable):
  - {project}: {ordered-adoption-list-top-3}

**Pass C caught {J} drift findings** — {top-1-example}
**Pass B killed/narrowed {R} candidates** — {top-1-example}

**Seed for next extraction**: {engineer-names-cited-approvingly}

Report: {absolute-path}
Evidence base (internal): {evidence-file-path}
```

Then pause. Do NOT start applying adoptions. The user reviews the report and invokes a follow-up session for application.

## Gotchas

Accumulated failure points — check before and during extraction.

1. **Podcast-summary contamination (2026-04-15)**: words in a podcast host's paraphrase of the guest ≠ the guest's words. Attribute to the host/summary, not the guest. If only the summary is available, label the quote as `[paraphrased in podcast summary]`.
2. **Gist system prompts are single-artifact gold**: when a senior engineer publishes a full system prompt (Beck's verbatim TDD system prompt), preserve it as a raw block in the evidence base — do not summarize. It is the highest-value artifact per fetch.
3. **Pass C skipped = worse than no extraction**: a polished-looking extraction with drift makes worse decisions than no extraction at all, because it carries false authority. If context is running low, skip Step 7 (project delta) before skipping Step 5 (Pass C).
4. **Scope boundary discipline**: every source has topics they explicitly DO NOT cover (Hamel: multi-tenant; Litt: enterprise SaaS). Extract these verbatim in Step 2.6. They are the guardrails that make Step 5 functional.
5. **Genuine-improvement filter rejection bar**: "sounds useful" and "other teams do this" do not pass. Only "X past failure row would have been prevented" passes. Be willing to reject 50%+ of candidates — the filter is where the real filtering happens, not in presentation.
6. **Shape ≠ purpose** (2026-04-15): "our Rules 4/6/8 are shape-similar to Beck's system prompt" ≠ "our rules are Beck's system prompt". Different problems, similar structure. Overclaiming isomorphism was one of the 5 Pass C catches.
7. **Forward-synthesis drift is invisible to forward review** (Principle 42): you will not catch your own softenings/extensions/inflations by re-reading your synthesis alone. Re-read against verbatim source quotes, or the drift ships.

## Edge Cases

- **Engineer writes in multiple formats** (blog + podcast + book + gists): prefer owned-domain writing (their blog, their gists) over third-party summaries. If only a podcast transcript is available, flag attribution as `[podcast, may include host paraphrase]`.
- **Source corpus is thin** (< 500 words total after all fetches): tell the user "Corpus too thin for reliable Pass C — recommend finding 2-3 more primary sources before extraction." Do not force an extraction on inadequate evidence.
- **Engineer contradicts themselves across pieces**: note the contradiction verbatim in Step 2's evidence base. Do not pick a favored side. Adoption candidates touching the contradicted area must flag the inconsistency.
- **All candidates killed by genuine-improvement filter**: valid outcome. Report it as "Extraction yielded {N} patterns, zero adoptions — source's advice is either (a) already in our setup, (b) not grounded in past-failure relevance, or (c) outside our scope. {next action: consider this a successful extraction that validated current state.}"
- **User invokes without `--project` but PI/Katha/etc. context is obviously active** from conversation: ask explicitly: "Run in Claude-Code-OS-only mode, or add `--project {suggested}` delta?" Do not silently assume project relevance.

## Success Criteria (self-check before final report)

- [ ] Step 2 evidence base has ≥3 verbatim prescriptive statements per source
- [ ] Step 2 evidence base has explicit scope boundaries section (what author does NOT cover)
- [ ] Step 4 classifies every pattern (no patterns silently dropped)
- [ ] Step 5 Pass C findings table has ≥1 row per adoption candidate name
- [ ] Step 6 Pass B names 2-3 specific past sessions per surviving candidate (not abstract scenarios)
- [ ] Every "Adopt now" candidate cites a specific Mistake Pattern row or Principle number
- [ ] Report is at `~/.claude/scout-reports/{date}-{engineer-slug}-extraction.md`
- [ ] User is given a summary + path, not dumped the full report in-chat

If any unchecked: fix before declaring done.
