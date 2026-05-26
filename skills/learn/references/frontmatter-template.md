# Insight File Template

## Filename

`{slug}.md` — lowercase, hyphens, descriptive (e.g., `agents-need-external-structures.md`)

## Structure

```markdown
---
title: "The insight as a claim/statement"
description: "One sentence expanding on what this means"
topics: [topic-slug-1, topic-slug-2]
source: "attribution — @handle, article title, or conversation"
source_file: "sources/author-slug-article-slug.md"
date: YYYY-MM-DD
domain: "ai"
---

2-4 sentences of prose explaining the insight. Weave [[wikilinks]] naturally into
the sentences — they should read as normal text that happens to link to related concepts.

Connect to other ideas: how this relates to [[other-insight-slug]] or implications
for [[yet-another-insight]]. If no existing insights connect, link to topic MOCs
like [[ai-agents]] or [[knowledge-systems]].
```

## Title Quality Bar

- GOOD: "Agents need external structures to think effectively" (claim)
- BAD: "Agent architecture" (label)
- GOOD: "Context engineering replaces prompt engineering" (statement)
- BAD: "Context engineering overview" (description)

Each insight should stand alone — someone reading just that file should understand the idea.

## Wikilink Rules

- Links go to other insight slugs (filenames without .md) or topic slugs
- Weave links INTO prose naturally: "This connects to [[context-engineering-replaces-prompt-engineering]] because..."
- Do NOT put a links section at the bottom. Links live in the sentences.
- Link to EXISTING insights when possible (you know them from graph-index.yaml in Step 1)
- For new concepts that don't exist yet, still create the wikilink — it becomes a future node
- Each insight should have 2-5 wikilinks
