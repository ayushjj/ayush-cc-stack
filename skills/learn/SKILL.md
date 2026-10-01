---
name: learn
description: Use when you have a URL, article, tweet, book PDF, or pasted text to extract insights from and add to the knowledge graph — and for whole-graph maintenance (back-linking leaf nodes, cross-topic bridges, MOC consistency). Triggers on URLs, '/learn', 'extract insights from', 'add to graph', 'process this article', 'process PDF', 'extract from book', 'back-link', 'leaf nodes', 'missing connections', 'strengthen graph'.
user_invocable: true
---

# /learn — Add Knowledge to the Graph

You are processing content into your personal knowledge graph. The user will provide content in one of three ways:
1. **A URL** (starts with `http://` or `https://`) — you fetch and extract it
2. **A file path** — you read and extract it
3. **Raw text** (pasted article, tweet thread, conversation summary, or notes) — you extract directly

The user may also specify a **domain** via `--domain <domain-slug>`:
- `--domain ai` (default) — AI product building insights
- `--domain mental-models` — Mental models, decision frameworks, multidisciplinary thinking

If no `--domain` is specified, default to `ai`. The domain determines which topic slugs are valid for the extracted insights.

Your job: extract distinct insights and weave them into the existing graph.

## Step 0: Detect Input Type

Before anything else, determine what the user gave you:

**If the input is a URL:**
1. **X Article detection:** If the URL matches `x.com/*` or `twitter.com/*`:
   a. Attempt Jina fetch (step 1b below)
   b. If the result is < 300 words OR missing article body text (just tweet metadata, embeds, or nav chrome):
      → Tell the user: "This looks like an X Article (JS-rendered). Jina couldn't extract the full content. Please paste the article text directly."
      → Stop and wait for user to paste content before proceeding
   c. If Jina succeeds (>300 words with substantive body) → proceed normally
2. Fetch the content using Jina Reader: `WebFetch` with URL `https://r.jina.ai/{original_url}`
   - The prompt for WebFetch should be: "Extract the full content of this page including author, text, and any linked URLs"
3. Use the fetched markdown as the content for Step 2 onward
4. Use the URL as the `source` field in insight frontmatter (extract author handle if visible)

**If the input is a file path:**
1. Read the file contents
2. Use the file contents as the content for Step 2 onward

**If the input is raw text:**
- Skip directly to Step 1 (no fetching needed)

**If the input is a PDF, or the user names a book:**
- Follow `references/book-pipeline.md` — a chapter loop around the ordinary steps below, adding
  page-level attribution and resumability. Folded in from the former `/learn-book` (S69).

**If there is NO content — `/learn sweep`, or the user asks to back-link / fix leaf nodes /
strengthen the graph:**
- Skip Steps 0.5-8 entirely and run `references/graph-sweep.md` alone. This is graph maintenance
  over the WHOLE graph, and it was the former `/connect` (S69). It needs no new input.

## Step 0.5: Source Comprehension (Fidelity Gate)

Before extracting insights, build an **extractive evidence base** from the fetched content. This grounds all downstream work in what the source actually says, preventing gap-filling from training data.

**1. Completeness check** (content-type-aware):
- **Articles** (linked from tweets): expect 300+ words, intro+body+conclusion. If under 300 words or cuts mid-sentence → flag as potentially truncated
- **Tweet threads**: 50+ words is fine (tweets are inherently short)
- **Paywall/login detection**: If content contains phrases like "subscribe to read", "sign in to continue", or is just a title + 1 paragraph → tell the user the content couldn't be fully accessed. Try fetching the original URL directly (without Jina) as fallback. If still insufficient → skip this source entirely
- **User-provided raw text**: No completeness check needed (user provided the full text)
- If the user explicitly asks to proceed with partial content → allowed, but add `partial-source: true` to the insight's YAML frontmatter

**2. Extractive evidence base** (NOT generative — pull directly from source text):
- State the article's **core argument** in 1-2 sentences
- Pull **3-8 direct quotes/passages** from the source text containing key claims, facts, and statistics
- Note what the article does **NOT** cover — this explicitly bounds the extraction and prevents gap-filling
- Record author name, @handle, and article title **exactly as they appear in the source text** — these become the only permitted attribution values

This evidence base is internal working material (not shown to user or written to files). It constrains what Step 2 can extract.

## Step 0.75: Save Raw Source

Save the full source text to `~/dev/[redacted]/sources/` so it can be referenced later for fact-checking, deeper extraction, or if the original goes offline.

1. **Determine the source slug:** Use `{author-handle}-{article-slug}` format (e.g., `nicbstme-ai-agents-financial-services`, `karpathy-llm-knowledge-bases`, `boris-cherny-yc-light-cone`). Keep it short but identifiable.
2. **Write the file** to `~/dev/[redacted]/sources/{source-slug}.md` with this structure:

```markdown
---
title: "Original article/tweet/transcript title"
author: "@handle (Full Name)"
url: https://original-url-if-available
date: YYYY-MM-DD
type: article  # article | tweet | transcript | book-chapter | raw-notes
---

[Full original text exactly as fetched by Jina or pasted by user]
```

3. **Remember the path** — you'll reference it as `source_file: sources/{source-slug}.md` in each insight's frontmatter (Step 3).

**Multiple insights from one source** all point to the same source file. Only create one source file per article/thread/transcript.

**Skip this step** only if the user explicitly says not to save the source (e.g., confidential content).

## Step 1: Read Current State

Before doing anything:
1. Read `~/dev/[redacted]/graph-index.yaml` — this gives you every existing node's title, description, topics, and link structure in a single file read
2. Read `~/dev/[redacted]/index.md` to understand the topic structure and recent additions

**Do NOT glob or read individual insight files.** The graph index contains all metadata needed to find connection opportunities. Only read a full insight file if you need to update it (e.g., it overlaps with new content).

## Step 2: Extract Insights

From the pasted content, identify **distinct, atomic insights**. Each insight is ONE clear idea.

**Quality bar:**
- Insight titles MUST be claims or statements, not labels (see `references/frontmatter-template.md` for examples)
- Each insight should stand alone — someone reading just that file should understand the idea
- Aim for 3-8 insights per paste (fewer if the content is narrow, more if it's rich)
- Skip generic/obvious points. Keep only things worth remembering.

**Source-fidelity rules:** Read `references/fidelity-rules.md` for the 5 hard constraints on extraction accuracy. These exist because a 2026-03-02 audit found a 43% error rate — they are non-negotiable.

## Step 2.5: Self-Verification (Before File Creation)

After extracting insights but BEFORE creating any files, verify each proposed insight against the evidence base from Step 0.5:

1. **Claim traceability:** Every factual claim (statistic, percentage, specific number, named person, quoted phrase) must map to a passage in the evidence base
2. **Directional accuracy:** For claims like "X beats Y" or "A replaces B", confirm the direction matches the source passage — not the inverse
3. **Attribution accuracy:** Author, @handle, and article title match exactly what the evidence base recorded from the source text

**If a claim fails verification:** Remove the specific claim from the insight. If removing it guts the insight entirely, drop the insight. Never fabricate a replacement — a smaller set of verified insights is always better than a larger set with fabrications.

## Step 3: Create Insight Files

For each insight, create a file in `~/dev/[redacted]/insights/`.

Read `references/frontmatter-template.md` for the file structure, naming conventions, title quality bar, and wikilink rules. Include `source_file: sources/{source-slug}.md` in the frontmatter, pointing to the file saved in Step 0.75. Multiple insights from the same source share the same `source_file` value.

Read `references/topics.md` for valid topic slugs in each domain.

## Step 4: Update Topic MOCs

For each topic that received new insights:
1. Read the topic file (e.g., `~/dev/[redacted]/topics/ai-agents.md`)
2. Add a link under the `## Insights` section: `- [[insight-slug]] — one-line description`
3. If you notice a cluster forming (3+ related insights), add or update a theme under `## Key Themes`

## Step 5: Update Index

Add new insights to the `## Recent Additions` section of `index.md`:
```
- [[insight-slug]] — brief description (YYYY-MM-DD)
```
Keep only the 10 most recent entries. Remove older ones (they're still findable via topic MOCs).

If any insight spans 3+ topics, also add it to `## Cross-Domain Insights`.

## Step 6: Update Graph Index

Update `~/dev/[redacted]/graph-index.yaml` with the new nodes.

**Batch all changes into one edit operation.** Compose the full set of new node entries mentally, then apply them in a single Edit call. Do not make multiple sequential edits to this file — each edit re-reads the file and wastes time.

1. For each new insight, add an entry with: title, description, topics, source, source_file, domain, outgoing (insight-to-insight wikilinks only, exclude topic MOC links)
2. Keep entries sorted alphabetically by slug
3. The `domain` field should match the `--domain` parameter (defaults to `ai`)

**No `incoming:` field.** Edges are stored one-way — the source node's `outgoing:` is the canonical record. Incoming is derived at build time. This eliminates the drift bug class that repeatedly broke deploys (2026-04-10, 2026-04-12) — see project memory `project_learn_backlink_bug.md` and Principle 30.

## Step 7: Report to User

Show a summary:
```
📝 Created X insights:
  - insight-title-1
  - insight-title-2
  - ...

📂 Updated topics: topic-1, topic-2

🔗 Connected to N existing insights:
  - linked-to-insight-1 (via new-insight)
  - ...

💡 Graph now has N total insights across M topics.
```

## Step 8: Inline Back-Link Pass (new nodes only)

New insights created in Steps 3-6 have **outgoing** links (they point to existing nodes), but no existing node points back to them. This makes them effectively leaf nodes in the derived reverse index — invisible during graph traversal from older insights.

Do this inline — you already have graph-index.yaml in context from Step 1 and you know exactly
which nodes are new.

**Scope, stated precisely:** this step covers ONLY the nodes created in this run. It does NOT
find pre-existing leaves, fragile nodes, cross-topic gaps, or MOC drift — it never looks at a
node it did not just write. That is Step 9's job. This heading previously read "replaces
/connect", which was false: `/connect` swept the whole graph and this never did. The audit that
caught it is why Step 9 exists.

1. **Pick back-link sources:** For each new insight, scan graph-index.yaml metadata (already in context) to find the 1-2 best existing insights to link FROM. Choose by semantic relevance — the existing insight should genuinely benefit from referencing the new one.
2. **Read + edit source files:** Read each selected existing insight file, then weave a natural `[[new-insight-slug]]` wikilink into its prose. Parallelize independent file reads/edits where possible.
3. **Batch-update graph-index.yaml:** In a single edit, add each new insight's slug to the **`outgoing:`** list of each back-linked existing node. That is the only yaml update needed — there is no `incoming:` field to maintain (edges are stored one-way; reverse index is derived at build time).

**Do not skip this step.** The graph's value comes from traversability — nodes with no incoming edges are invisible knowledge.

## Step 9: Whole-Graph Sweep

Run `references/graph-sweep.md`. Step 8 fixed the nodes you just added; this finds the ones that
went leaf months ago, plus fragile nodes, cross-topic bridges and MOC inconsistencies.

Folded in from the former `/connect` (S69 2026-08-27). Skip it only when Step 8 added no nodes
AND a sweep already ran this session — the sweep reads the index and the files it edits, so
running it twice over an unchanged graph is wasted work, not a risk.

## Gotchas

These are accumulated failure points from real sessions. Check these before and during extraction.

1. **Fabricated statistics (20% of errors):** LLM gap-fills numbers from training data. If a statistic isn't in the fetched text, leave it out entirely. An insight without a number beats an insight with a fabricated one.
2. **Editorial synthesis presented as source claim (32% of errors):** Your interpretation framed as the author's words. Use "This suggests..." for synthesis, never present it as a direct claim.
3. **Fabricated examples (12% of errors):** LLM invents examples the source never gave. Only use examples that appear in the fetched content.
4. **X Article detection:** `x.com` and `twitter.com` URLs are JS-rendered. Jina Reader often returns < 300 words. Always check word count — if under 300, ask user to paste content directly.
5. **Slug collisions:** Before creating a file, check `graph-index.yaml` for existing slugs that are close to your proposed one. Two insights about "context engineering" could clash.
6. **Back-link step (Step 8) is load-bearing:** Skipping it leaves new nodes with no incoming edges in the derived reverse index — invisible during graph traversal. Never skip even if the session is long. (Note: the back-link step was simplified 2026-04-15 — only one direction to update, so the drift failure mode no longer exists.)

*(Update this section when new failure patterns emerge. Keep to 5-8 items — graduate patterns to CLAUDE.md principles when they're universal.)*

## Edge Cases

- **Content is too vague/generic:** Tell the user "This content is too general to extract specific insights. Could you paste something more specific?" Don't create low-quality nodes.
- **Content overlaps with existing insights:** Update or enrich the existing insight file instead of creating a duplicate. Mention this in the report.
- **Content suggests a new topic:** Create the insights with the closest existing topics, and suggest to the user: "This content touches on [new area] — want me to create a new topic MOC for it?"
- **graph-index.yaml missing or outdated:** Rebuild it by reading all insight files (fallback to the expensive path), then write a fresh graph-index.yaml before proceeding.
