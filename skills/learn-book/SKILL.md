---
name: learn-book
description: Use when you have a book PDF to extract insights from chapter by chapter. Processes each chapter through the /learn pipeline incrementally. Triggers on '/learn-book', 'extract from book', 'process PDF', 'book insights'.
user_invocable: true
---

# /learn-book — Extract Knowledge from a Book PDF

You are processing a book PDF into your personal knowledge graph, chapter by chapter. This skill orchestrates the extraction pipeline — reading the PDF in manageable chunks and feeding each chapter through `/learn` for insight extraction.

## Usage

```
/learn-book <pdf-path> --domain <domain-slug>
```

**Required:**
- `<pdf-path>` — absolute path to the PDF file on disk

**Optional:**
- `--domain <domain-slug>` — domain for extracted insights (default: `mental-models`)
- `--chapters <range>` — specific chapters to process (e.g., `1-5`, `3`, `7-12`). Defaults to all.
- `--dry-run` — read table of contents only, show chapter list without extracting

## Step 0: Read Table of Contents

1. Read the first 5-10 pages of the PDF using the Read tool with `pages: "1-10"`
2. Identify the table of contents, chapter structure, and page ranges
   - If the TOC is not found in pages 1-10 (common with long forewords/praise sections), try `pages: "1-20"` or ask the user which page the TOC starts on
3. Present the chapter list to the user:

```
Found N chapters in "Book Title":
  Ch 1: Chapter Title (pp. X-Y)
  Ch 2: Chapter Title (pp. X-Y)
  ...

Domain: mental-models
Estimated insights: ~3-5 per chapter, ~N-M total

Proceed with all chapters? Or specify --chapters range.
```

4. If `--dry-run` was specified, stop here
5. Wait for user confirmation before proceeding

## Step 1: Read Current Graph State

Before extracting anything:
1. Read `~/desktop/knowledge-graph/graph-index.yaml` — know every existing node
2. This prevents creating duplicates and maximizes cross-linking opportunities

## Step 2: Process Chapter by Chapter

For each chapter in the specified range:

### 2a: Read the Chapter
- Use the Read tool with `pages` parameter to read up to 20 pages at a time
- For chapters longer than 20 pages, read in sequential 20-page chunks
- Build the full chapter text before extracting

### 2b: Source Comprehension (Per Chapter)
Before extracting insights from this chapter:
1. State the chapter's **core argument** in 1-2 sentences
2. Pull **key passages** — direct quotes containing the chapter's main claims
3. Note what the chapter does NOT cover — this bounds extraction
4. Record the exact chapter title, number, and page range for attribution

### 2c: Extract via /learn Pipeline
Run `/learn` Steps **2, 2.5, 3, 5, 6, 7** on the chapter content. Explicitly **skip Step 4** (topic MOCs — deferred to post-processing) and **Step 8** (auto-connect — run once at end, not per chapter).

Additional overrides:

- **Source attribution format:** `"Author Name — Book Title, Chapter N: Chapter Title"`
- **Domain:** Use the `--domain` parameter value
- **Quality bar — books are denser:** Aim for 3-8 insights per chapter (books have more substance per chapter than a tweet thread)
- **Cross-domain linking:** Actively look for connections to existing insights from OTHER domains. A mental model chapter about "inversion" should link to AI insights about "declarative beats imperative" if the connection is genuine.

### 2d: Report Per-Chapter Progress
After each chapter, show:
```
Chapter N: "Chapter Title" — extracted X insights
  - insight-title-1
  - insight-title-2
  Progress: N/M chapters complete
  Completed chapters: 1, 2, ..., N (use --chapters to resume from next)
```

This resumability note ensures that if processing is interrupted (context limit, error, user pause), the user knows exactly which chapters are done and can restart with `--chapters` for the remaining ones.

## Step 3: Post-Processing (After All Chapters)

Once all chapters are processed:

1. **Update topic MOCs** — for each mental-model topic that received insights, create or update the topic file in `~/desktop/knowledge-graph/topics/`
2. **Update index.md** — add a summary entry for the book in Recent Additions
3. **Run /connect** — scan for missing back-links, especially cross-domain connections
4. **Run validation** — `bash validate-graph.sh`

## Step 4: Final Report

```
Book processing complete: "Book Title"

Chapters processed: N
Insights extracted: M
  - psychology: X
  - economics: Y
  - decision-making: Z
  ...

Cross-domain connections: N links to existing AI insights
Graph total: N insights across M topics

Next: Run `npm run build` to verify, then push to deploy.
```

## Source Fidelity Rules (Critical for Books)

Books are especially prone to LLM gap-filling because training data often contains summaries, reviews, and commentary about famous books. The source fidelity rules from `/learn` apply with extra strictness:

1. **Only extract what's on the pages you read.** If you "know" the book says something but didn't read it in the PDF pages, do not include it.
2. **Page-level attribution.** Each insight should be traceable to specific pages. Include page references in the source field when possible.
3. **Author's words, not commentary.** Extract what the author argues, not what reviewers or summaries say about the book. The PDF is the source, not your training data about the book.
4. **Quantity < Quality.** 20 verified insights from a book beats 50 with fabricated examples. When in doubt, leave it out.

## Gotchas

These are accumulated failure points from real book extraction sessions.

1. **Context exhaustion on long chapters:** 130-page chapters exhaust context before extraction begins. Extract incrementally — read ~40 pages, extract 2-3 insights, repeat. Don't re-read the whole chapter.
2. **Training data contamination:** Books like "Poor Charlie's Almanack" are heavily discussed in training data. You will "know" things about the book that aren't on the pages you read. Only extract from the actual PDF pages — if you didn't read it in the PDF, it doesn't exist.
3. **Chapter resumability:** If processing is interrupted, the user needs to know exactly which chapters are done. Always include `Completed chapters: 1, 2, ..., N (use --chapters to resume from next)` in per-chapter reports.
4. **Appendices aren't insight sources:** Skip bibliographies, indices, and praise sections. Only substantive content chapters yield insights.

*(Update this section when new failure patterns emerge.)*

## Edge Cases

- **Scanned PDF (image-based):** The Read tool can't extract text from image PDFs. Tell the user: "This appears to be a scanned PDF without text layer. You'll need to run OCR first (e.g., `ocrmypdf input.pdf output.pdf`)."
- **Very long chapters (40+ pages):** Read in 20-page chunks, build comprehension notes across chunks, then extract insights from the full chapter understanding.
- **Appendices/indices:** Skip unless they contain substantive content. Bibliographies and indices are not insight sources.
- **Previously processed chapters:** If insights from specific chapters already exist in graph-index.yaml, skip those chapters and inform the user.
