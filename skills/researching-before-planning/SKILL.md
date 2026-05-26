---
name: researching-before-planning
description: Explore codebase architecture OR external landscape BEFORE entering plan mode. Auto-detects codebase vs external vs hybrid mode. Produces a standalone research artifact with evidence (file:line for codebase, source URLs for external). Use before any non-trivial implementation. Triggers on "research", "explore first", "understand before planning", "what does the codebase do", "how does X work", "what are people doing about X", "codebase architecture".
preconditions:
  - Non-trivial task ahead (not a one-line fix)
  - Not yet in plan mode (research comes BEFORE planning)
---

# Researching Before Planning

Research is a documentary exercise: document what exists, don't evaluate it. Research produces facts. Planning produces decisions. Don't mix them.

**The RPI workflow**: Research -> Plan -> Implement. This skill handles the R.

## Usage

```
/research {topic or question}
```

## When to Use Which Skill

| Situation | Skill |
|-----------|-------|
| Bug/error to diagnose | `/investigate` |
| Understand codebase before building | `/research` |
| Analyze user data patterns | `/data-analysis` |
| Design feature with trade-offs | `/spec` |

If the user's request is a bug report, redirect to `/investigate`. If it involves studying dataset patterns with percentages, redirect to `/data-analysis`.

<critical_sequence enforce_order="strict">

<step number="1" required="true" blocking="true">
## Step 1: Define Research Questions

Write 3-5 specific questions this research must answer. Each question becomes a heading in the output artifact.

**Each question MUST be:**
- Answerable from code, docs, or data (not speculation)
- Scoped to answer in <10 min via grep + read
- Specific enough to have a concrete answer with file:line references

Bad questions (too vague, too broad):
- "How does search work?" -> Too broad, would take 30+ min
- "What's the architecture?" -> Not answerable concretely

Good questions (specific, scoped, answerable):
- "What are the three search layers and how does RRF combine them?" (~3 files)
- "Which files handle query-to-tag translation and what's the mapping?" (~2 files)
- "What embedding model and dimensions does the vector layer use?" (~1 file)

<validation_gate name="questions-defined" blocking="true">
**BLOCK if:**
- [ ] Fewer than 3 questions defined
- [ ] Any question requires speculation (not answerable from code/docs)
- [ ] Any question would take >10 min to answer (too broad — split it)
- [ ] Questions overlap significantly (deduplicate)

Do NOT start exploring until questions are written down.
</validation_gate>
</step>

<step number="2" required="true" depends_on="1" blocking="true">
## Step 1.5: Detect Research Mode

Auto-detect based on the research questions from Step 1:

- **Codebase mode** (default): Questions answerable from project files (e.g., "How does our search pipeline work?")
- **External mode**: Questions about external tools, community practices, or industry trends (e.g., "What are people doing about agent memory?")
- **Hybrid mode**: Mix of both (e.g., "How does our auth compare to industry best practices?")

The mode determines which tools to use and which validation gates apply. You do NOT need to ask the user — infer from the questions.

## Step 2: Explore

Answer each question with evidence. Match the tool to the question scope:

| Question scope | Tool |
|----------------|------|
| Answerable from 1-3 project files | Grep/Glob/Read directly |
| Spans 5+ files or unclear location | Task (Explore agent), ONE question per agent |
| External docs or best practices | WebSearch / WebFetch |
| Community opinions (HN, forums) | WebFetch with `https://hn.algolia.com/api/v1/search?query={query}&tags=story&hitsPerPage=20` |
| Specific article deep-dive | WebFetch with `https://r.jina.ai/{url}` |

**Parallelization rules:**
- Launch max 2-3 Task agents simultaneously, each with ONE specific question
- Use Grep/Glob/Read directly for focused questions (faster than spawning agents)
- For external research: fire multiple WebSearch + HN Algolia queries in parallel with different phrasings
- Do NOT serialize independent questions

**Stop condition (mode-dependent)**:
- **Codebase mode**: A question is answered when you have **2+ file:line references** supporting the answer
- **External mode**: A question is answered when you have **2+ source URLs with extracted evidence** supporting the answer
- **Hybrid mode**: At least 1 file:line reference AND 1 source URL per question

You don't need to "fully understand the system" — you need evidence.

**Time guard**: If any single question takes >10 min, STOP. The question is too broad. Split it into two narrower questions, or mark it as an open question and move on.

<validation_gate name="evidence-gathered" blocking="true">
**BLOCK if (codebase mode):**
- [ ] Any answered question has <2 file:line references
- [ ] Evidence is paraphrased without actual paths (e.g., "the search module does X")
- [ ] Only looked at happy path (check error handling, edge cases too)
- [ ] Explored files not mapped to any question (aimless exploration)

**BLOCK if (external mode):**
- [ ] Any answered question has <2 source URLs with extracted quotes/evidence
- [ ] Evidence is paraphrased without source attribution (e.g., "people generally think X")
- [ ] Only searched one platform (use WebSearch + HN Algolia at minimum)
- [ ] Fetched articles not mapped to any question (aimless browsing)

**BLOCK if (hybrid mode):**
- [ ] Any question lacks at least 1 file:line AND 1 source URL
</validation_gate>
</step>

<step number="3" required="true" depends_on="2" blocking="true">
## Step 3: Write Research Artifact

Write findings to `research/{topic}.md`. Target **100-200 lines** (not an essay). If it exceeds 200 lines, you're including too much — cut to essentials.

Someone reading this file cold should understand findings without re-exploring.

```markdown
---
date: {YYYY-MM-DD}
commit: {short hash from git rev-parse --short HEAD}
branch: {current branch}
topic: {research topic}
status: draft | validated
---

# Research: {Topic}

**Goal**: {one sentence — what we need to understand and why}
**Verdict**: {one sentence — the key finding or recommendation}

## Q1: {specific question}

**Answer**: {1-3 sentences, direct answer}

**Evidence** (codebase mode):
- `path/to/file.ts:42` — {what this code does}
- `path/to/other.ts:88` — {relevant detail}

**Evidence** (external mode):
- [Source Title](https://url) — "{direct quote from article}"
- [HN Discussion](https://hn.algolia.com/...) — {N points, M comments, key takeaway}

```typescript
// Key code snippet (keep short — 5-10 lines max, codebase mode only)
```

## Q2: ...

## Constraints Discovered
- {thing that limits options} — `file:line` or `source URL`
- {another constraint} — `file:line` or `source URL`

## Open Questions
- {anything still unclear that needs user input or deeper research}

## Recommended Next Step
{Usually "enter plan mode" or "need more research on X"}
```

<validation_gate name="artifact-quality" blocking="true">
**BLOCK if ANY of these fail (all modes):**
- [ ] File not written to `research/{topic}.md`
- [ ] Missing YAML frontmatter (date, commit, branch, topic, status)
- [ ] Any answered question exceeds 3 sentences
- [ ] Missing "Constraints Discovered" section (or it has 0 items)
- [ ] Verdict is missing or longer than one sentence
- [ ] Artifact exceeds 200 lines

**Additional checks (codebase mode):**
- [ ] Any answered question has <2 file:line references
- [ ] No code snippet in entire artifact (need at least one)

**Additional checks (external mode):**
- [ ] Any answered question has <2 source URLs with extracted evidence
- [ ] No direct quotes from sources in entire artifact (need at least one)

**Additional checks (hybrid mode):**
- [ ] Any question lacks at least 1 file:line AND 1 source URL

If artifact fails validation, fix it before presenting. If research quality is poor (vague answers, weak evidence), **discard and re-research** — don't patch bad research.
</validation_gate>
</step>

<step number="4" required="true" depends_on="3">
## Step 4: Present to User

Summarize concisely (the user can read the full file). Highlight:
1. **Verdict** (one sentence)
2. **Surprises** (things that weren't expected)
3. **Constraints** (things that limit options)
4. **Open questions** (things that need user input)
</step>

</critical_sequence>

<decision_gate wait_for_user="true">
## Research Complete

Findings written to `research/{topic}.md`.

What's next?
1. Enter plan mode (research is sufficient)
2. Re-research with different focus (missed the mark)
3. Explore a specific area deeper (partial gap)
4. Abandon (wrong direction entirely)
</decision_gate>

## Red Flags (You're Doing It Wrong)

Stop and course-correct if you catch yourself:

- **Exploring without mapping to a question** — Every file you read must answer a defined question
- **Paraphrasing code instead of citing file:line** — "The search module combines results" is useless
- **Only looking at happy path** — Check error handling, edge cases, config limits
- **Artifact exceeding 200 lines** — You're documenting, not writing a textbook
- **Spending >20 min total** — Questions are too broad, split them
- **Proposing solutions** — Research documents what IS, not what SHOULD BE. Save opinions for plan mode.

## Example Output (Abbreviated)

```markdown
---
date: 2026-02-06
commit: 4e5e4c8
branch: main
topic: search-pipeline
status: validated
---

# Research: Search Pipeline Architecture

**Goal**: Understand the three-layer search pipeline before improving recall.
**Verdict**: RRF correctly merges three independent layers, but qualifier recall (50%) is bottlenecked by a 40-entry lookup table that needs hundreds of entries.

## Q1: What are the three search layers and how does RRF combine them?

**Answer**: Tag search (exact compound match), vector search (cosine similarity on embeddings), and fuzzy search (trigram). RRF merges with k=60, no weights.

**Evidence**:
- `src/search/index.ts:45` — RRF merge function, k=60
- `src/search/tagSearch.ts:12` — Tag layer entry point

## Q2: Where is the qualifier-to-tag mapping and how large is it?

**Answer**: `expandQueryToCompounds()` maps qualifier phrases to compound tags. Currently ~40 entries covering common MRO terms. Needs hundreds to reach 90% qualifier recall.

**Evidence**:
- `src/search/tagSearch.ts:89` — qualifierMap definition (~40 entries)
- `data/search-quality-report.md:34` — 50.1% qualifier recall

## Constraints Discovered
- Qualifier map is hand-maintained — `src/search/tagSearch.ts:89`
- Embeddings use text-embedding-3-small (768 dims) — `src/indexing/embeddings.ts:8`

## Open Questions
- Should qualifier map be auto-generated from LLM tags instead of hand-maintained?

## Recommended Next Step
Enter plan mode to design qualifier map expansion strategy.
```

<integration_protocol>
## Integration Points

**Invoked by:**
- Manual invocation before starting non-trivial work
- Auto-suggested when user describes a feature that needs exploration

**Invokes:**
- Plan mode (after user validates research)
- `/spec` skill (if research reveals need for formal specification)

**Handoff expectations:**
Creates `research/{topic}.md` with validated findings.
Plan mode reads this file to inform design decisions.
</integration_protocol>
