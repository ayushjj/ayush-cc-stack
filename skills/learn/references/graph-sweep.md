# Whole-Graph Sweep (folded in from the former `/connect`, S69 2026-08-27)

**When to run:** `/learn` Step 9 runs this after adding nodes; `/learn sweep` runs it alone as
graph maintenance with no new content.

**Why it is separate from Step 8.** Step 8 back-links only the nodes it just created. This
sweep looks at the ENTIRE graph — insights that went leaf months ago are invisible to Step 8
by construction, because Step 8 never looks at a node it did not just write. Before this file
existed, `/learn` Step 8 claimed to "replace /connect" while doing neither the whole-graph
leaf sweep nor the cross-topic and MOC passes. Do not let that claim reappear.

## 1. Read the graph index — and only the index

Read `~/dev/[redacted]/graph-index.yaml`. It is the **single source of truth** for link
structure. For each node extract: slug (the YAML key), `outgoing`, `topics`, `title`,
`description`.

**Compute the derived reverse index.** Edges are stored one-way in `outgoing:`; incoming is not
stored. Build `reverseIndex: {target_slug: [source_slugs]}` in one O(N) pass over every node's
`outgoing:`.

**Do NOT glob or read individual insight files here.** The index carries everything link
analysis needs. Full files are read only in step 4, on the nodes you actually edit.

## 2. Identify leaf and fragile nodes

- **Leaf** — a slug with no entry in the reverse index. Nothing points to it. Highest priority.
- **Fragile** — exactly one source in the reverse index. One deletion away from becoming a leaf.

List both.

## 3. Find meaningful back-link opportunities

For each leaf, use `title`/`description`/`topics` from the index to find the best existing
insight to link **FROM**. Matching strategies, in priority order:

1. **Shared topic + complementary idea** — two insights that make each other's argument stronger
2. **Cause-effect** — one explains the mechanism behind another's claim
3. **Concrete example of an abstract principle** — link the abstract to the concrete
4. **Reinforcing evidence** — one supplies support for another's claim

Quality bar: the link must read as natural prose, add information rather than "see also", and be
woven into an existing sentence or extend the final paragraph. One back-link per leaf is enough.

## 4. Apply the back-links

1. **Now** read the target insight file — the only step that reads full files
2. Weave the `[[wikilink]]` into the best sentence or paragraph
3. Re-read the full paragraph to confirm it still reads naturally

**Anti-patterns:** a "See also:"/"Related:" section at the bottom · links in YAML frontmatter ·
links carrying no semantic meaning · **editing the leaf node itself** (that creates OUTGOING
links — the leaf stays a leaf).

## 5. Update the graph index

For each back-link added from A → B, add `B` to A's `outgoing:` list. Keep `outgoing:` sorted
alphabetically. There is no `incoming:` field — it is derived at build time from all `outgoing:`
lists. Without this step the next sweep runs on stale data.

## 6. Cross-topic bridges

Beyond leaves, look for missing cross-topic connections using index metadata alone:
- insights sharing 0 topics but with related titles/descriptions
- clusters in one topic with no link to a related cluster in another
- insights from different sources that reinforce each other

Lower priority than leaves, but this is what makes the graph traversable rather than clustered.

## 7. MOC consistency

Read the topic MOC files and check: every insight's YAML `topics` matches the MOCs listing it;
no insight is missing from a MOC it belongs in. Flag inconsistencies.

## 8. Report

```
🔗 Back-links added: X
  - [target] now links to → [leaf] (reason)
🌉 Cross-topic bridges: Y
  - [a] ↔ [b] (topics bridged)
🔍 MOC inconsistencies: Z
  - [insight] missing from [topic] MOC
📊 Graph health: N insights · leaves X (was Y) · fragile F · avg incoming N.N
```

## Gotchas — accumulated from real sweeps, do not relearn these

1. **Slug mismatch.** Always take the exact slug from `graph-index.yaml` before writing a
   wikilink. Title-inferred slugs frequently differ from real ones —
   `building-real-projects-teaches-ai-faster` vs the actual
   `building-beats-following-for-ai-mastery`. Three broken links in one session from this.
2. **Editing the wrong node.** Back-links go FROM an existing node TO the leaf. Editing the leaf
   creates outgoing links and leaves it a leaf.
3. **Index sync.** After adding wikilinks you MUST update the source node's `outgoing:` in
   `graph-index.yaml`. Incoming is derived; there is no second field to maintain.

## Edge cases

- **No leaves:** report health metrics and do the cross-topic pass instead.
- **No natural back-link:** skip and note it. Some insights are legitimately terminal.
- **Target insight doesn't exist yet:** note as a "future node" — it appears when relevant
  content is processed.
- **More than 10 leaves:** oldest first (disconnected longest), then batch.
- **Index missing or stale:** rebuild by reading all insight files (the expensive path) and write
  a fresh `graph-index.yaml` before proceeding.
