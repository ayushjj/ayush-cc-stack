# Book / PDF Pipeline (folded in from the former `/learn-book`, S69 2026-08-27)

**When to run:** `/learn` Step 0 routes here when the input is a PDF, or when the user asks to
process a book. Everything below is a wrapper around the ordinary `/learn` steps — it adds a
chapter loop, page-level attribution, and resumability. It does not replace them.

## Usage

```
/learn <pdf-path> --domain <domain-slug> [--chapters 1-5] [--dry-run]
```

- `<pdf-path>` — absolute path to the PDF (required)
- `--domain` — domain for extracted insights (default `mental-models`)
- `--chapters` — range to process, e.g. `1-5`, `3`, `7-12` (default: all)
- `--dry-run` — read the table of contents and show the chapter list, extract nothing

## 1. Table of contents

Read the first 5-10 pages with `pages: "1-10"`. If the TOC is not there — common with long
forewords and praise sections — try `pages: "1-20"` or ask which page it starts on. Present:

```
Found N chapters in "Book Title":
  Ch 1: Chapter Title (pp. X-Y)
  ...
Domain: mental-models
Estimated insights: ~3-5 per chapter, ~N-M total
Proceed with all chapters? Or specify --chapters range.
```

Stop here if `--dry-run`. Otherwise wait for confirmation.

## 2. Read current graph state

Read `~/dev/[redacted]/graph-index.yaml` before extracting anything — it prevents duplicate
nodes and is what makes cross-linking possible.

## 3. Chapter loop

**3a. Read** — `pages` in chunks of at most 20; build the full chapter text before extracting.

**3b. Comprehend, per chapter** — state the chapter's core argument in 1-2 sentences; pull key
passages as direct quotes; note what the chapter does NOT cover (this bounds extraction); record
exact chapter title, number and page range for attribution.

**3c. Extract** — run `/learn` Steps **2, 2.5, 3, 5, 6, 7** on the chapter text. **Skip Step 4**
(topic MOCs — deferred to post-processing) and **Step 8/9** (back-linking and the sweep run ONCE
at the end, not per chapter). Overrides:
- Source attribution: `"Author Name — Book Title, Chapter N: Chapter Title"`
- Domain: the `--domain` value
- Quality bar: 3-8 insights per chapter — a book chapter is denser than a tweet thread
- Actively look for cross-domain links to existing insights, not just within the book's domain

**3d. Report progress** — after each chapter:
```
Chapter N: "Chapter Title" — extracted X insights
  - insight-title-1
  Progress: N/M chapters complete
  Completed chapters: 1, 2, ..., N (use --chapters to resume from next)
```
The completed-chapters line is not decoration: it is the only resumability mechanism if the run
is interrupted by context limits, an error, or the user pausing.

## 4. Post-processing, after all chapters

1. **Topic MOCs** — create/update each topic file in `~/dev/[redacted]/topics/`
2. **index.md** — add a summary entry for the book under Recent Additions
3. **Whole-graph sweep** — run `references/graph-sweep.md` once, looking especially for
   cross-domain connections (this was `/connect`, folded into `/learn` in the same pass)
4. **Validate** — `npm run check` (astro check + build-graph + `node validate-graph.js` + vitest)

## 5. Final report

```
Book processing complete: "Book Title"
Chapters processed: N · Insights extracted: M
  - psychology: X · economics: Y · decision-making: Z
Cross-domain connections: N links to existing insights
Graph total: N insights across M topics
Next: `npm run build` to verify, then push to deploy.
```

## Source fidelity — stricter for books than for anything else

Books are the worst case for LLM gap-filling, because training data is full of summaries,
reviews and commentary about famous ones. You WILL "know" things about the book that are not on
the pages you read.

1. **Only extract what is on the pages you actually read.** If you did not read it in the PDF,
   it does not exist.
2. **Page-level attribution** — each insight traceable to specific pages.
3. **The author's words, not commentary about them.** The PDF is the source, not your training
   data about the book.
4. **Quantity < quality.** 20 verified insights beat 50 with fabricated examples.

## Gotchas — from real book extractions

1. **Context exhaustion on long chapters.** A 130-page chapter exhausts context before
   extraction starts. Read ~40 pages, extract 2-3 insights, repeat — never re-read the whole
   chapter.
2. **Training-data contamination.** Heavily-discussed books (e.g. Poor Charlie's Almanack) are
   the highest risk. See fidelity rule 1.
3. **Resumability.** Always emit the completed-chapters line (3d).
4. **Appendices are not insight sources.** Skip bibliographies, indices, praise sections.

## Edge cases

- **Scanned/image PDF:** the Read tool cannot extract text. Tell the user to OCR first
  (`ocrmypdf input.pdf output.pdf`).
- **Chapters over 40 pages:** read in 20-page chunks, build comprehension notes across chunks,
  extract from the whole-chapter understanding.
- **Already-processed chapters:** if their insights are already in `graph-index.yaml`, skip and
  say so.
