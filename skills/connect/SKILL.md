---
name: connect
description: Use when the graph has leaf nodes or after adding new insights that need back-linking to older nodes. Triggers on '/connect', 'back-link', 'leaf nodes', 'missing connections', 'strengthen graph'.
user_invocable: true
---

# /connect — Strengthen the Knowledge Graph

You are scanning Ayush's knowledge graph for missing connections between existing insights. The graph grows by adding new nodes (/learn), but older nodes never get updated to link to newer ones. Your job: find and fix these gaps.

## Step 1: Read Graph Index

1. Read `~/desktop/knowledge-graph/graph-index.yaml` — this is the **single source of truth** for the graph's link structure
2. From the index, extract for each node:
   - Its slug (the YAML key)
   - Its `outgoing` list (insight-to-insight links)
   - Its `topics` list
   - Its `title` and `description` (for semantic matching)
3. **Compute the derived reverse index.** Edges are stored one-way in `outgoing:`; incoming is not stored. Build a dict `reverseIndex: {target_slug: [source_slugs]}` by iterating every node's `outgoing:`. This takes one O(N) pass and gives you "who points to each node."

**Do NOT glob or read individual insight files at this step.** The graph index contains all metadata needed for link analysis. Only read full insight files in Step 4 when you need to edit them.

## Step 2: Identify Leaf Nodes

A **leaf node** is a slug with no entry in the derived reverse index — no other insight's `outgoing:` contains it.

List all leaf nodes. These are the highest-priority connection targets.

Also flag any insights with exactly 1 source in the reverse index as "fragile" — they depend on a single connection.

## Step 3: Find Meaningful Back-Link Opportunities

For each leaf node, use the `title`, `description`, and `topics` from the graph index to find the best existing insight to add a back-link FROM. The connection must be **semantically meaningful** — don't just link for the sake of linking.

**Matching strategies (in priority order):**
1. **Shared topic + complementary idea** — two insights in the same topic that make each other's argument stronger
2. **Cause-effect relationship** — one insight explains the mechanism behind another's claim
3. **Concrete example of an abstract principle** — link the abstract to the concrete
4. **Reinforcing evidence** — one insight provides supporting evidence for another's claim

**Quality bar:**
- The back-link must read as natural prose, not a forced reference
- It should add information or context, not just "see also"
- It should be woven into an existing sentence or extend the final paragraph naturally
- One back-link per leaf node is sufficient; don't over-link

## Step 4: Apply Back-Links

For each identified opportunity:
1. **Now** read the target insight file (the one you're editing) — this is the only step that reads full files
2. Find the best sentence or paragraph to weave the link into
3. Edit with a natural extension — either:
   - Modify an existing sentence to include the `[[wikilink]]`
   - Add a clause or sentence that extends the paragraph's argument
4. Verify the edit reads naturally by re-reading the full paragraph

**Anti-patterns to avoid:**
- Adding a "See also:" or "Related:" section at the bottom
- Linking in YAML frontmatter
- Creating links that don't carry semantic meaning
- Editing the leaf node itself (that creates outgoing links, not incoming ones)

## Step 5: Update Graph Index

After applying back-links, update `graph-index.yaml` to reflect the new connections:
1. For each back-link added from insight-A → insight-B:
   - Add `insight-B` to insight-A's `outgoing` list
   - (No `incoming:` update — that field no longer exists; incoming is derived at build time from all `outgoing:` lists.)
2. Keep `outgoing:` sorted alphabetically for consistency

This keeps the index in sync with the actual file contents so the next /connect run has accurate data.

## Step 6: Check for Cross-Topic Bridges

Beyond leaf nodes, look for **missing cross-topic connections** using the graph index metadata:
- Insights that share 0 topics but have related titles/descriptions
- Clusters within a topic that don't link to related clusters in another topic
- Insights from different sources that reinforce each other

These are lower priority than leaf nodes but strengthen the graph's traversability.

## Step 7: Verify MOC Consistency

Read the topic MOC files and check:
- Every insight's YAML topics match the MOC files that list it
- No insight is missing from a MOC it should appear in
- Flag any inconsistencies for fixing

## Step 8: Report to User

Show a summary:
```
🔗 Back-links added: X
  - [target-insight] now links to → [leaf-node] (reason)
  - ...

🌉 Cross-topic bridges added: Y (if any)
  - [insight-a] ↔ [insight-b] (topics bridged)
  - ...

🔍 MOC inconsistencies found: Z (if any)
  - [insight] missing from [topic] MOC
  - ...

📊 Graph health:
  - Total insights: N
  - Leaf nodes remaining: X (was Y)
  - Avg incoming links: N.N
  - Connectivity improvement: +X links
```

## Gotchas

These are accumulated failure points from real `/connect` sessions.

1. **Slug mismatch:** Always look up the exact slug from `graph-index.yaml` before adding wikilinks. Title-inferred slugs frequently don't match actual file slugs. Example: `building-real-projects-teaches-ai-faster` vs actual slug `building-beats-following-for-ai-mastery`. 3 broken links in one session from this error.
2. **Editing the wrong node:** Back-links go FROM an existing node TO the leaf node. If you edit the leaf node itself, you're creating outgoing links, not incoming ones — the leaf stays a leaf.
3. **graph-index.yaml sync:** After adding wikilinks to insight files, you MUST update the `outgoing` list on the source node in graph-index.yaml. Incoming is derived — no longer a separate field to maintain.

*(Update this section when new failure patterns emerge.)*

## Edge Cases

- **No leaf nodes found:** Great — report graph health metrics and look for cross-topic bridges instead.
- **No natural back-link possible:** Skip the leaf node and note it in the report. Not every insight needs to be linked from everywhere — some are naturally terminal.
- **Insight references a concept but the target insight doesn't exist yet:** Note as a "future node" — it will be created when relevant content is processed via /learn.
- **Too many leaf nodes (>10):** Prioritize the oldest ones first (they've been disconnected longest), then process in batches.
- **graph-index.yaml missing or outdated:** Rebuild it by reading all insight files (fallback to the expensive path), then write a fresh graph-index.yaml before proceeding.
