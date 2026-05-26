# Source Fidelity Rules

These are **hard constraints**, not soft preferences. They exist because the 2026-03-02 audit found a 43% error rate in LLM-extracted insights.

## 1. Verbatim-or-Omit

Statistics, percentages, ratios, specific numbers, and direct quotes MUST appear in the fetched source text. If you cannot point to where in the fetched content a number comes from, **leave it out entirely** — an insight without a statistic is better than an insight with a fabricated one.

## 2. Single-Source Isolation

Only use information from the currently-being-processed source. Do not supplement with knowledge from other articles processed earlier in this session, prior conversations, or your training data. If you "know" something about this topic that isn't in the source text, do not include it.

## 3. Attribution from Source Text Only

Author name, @handle, role/title, and article title must come from what appears in the fetched content. If the source text doesn't clearly state the author's name, use exactly what you see (e.g., `@handle` alone). Do not look up or infer identities.

## 4. Directional Claim Check

For any insight that says X beats/replaces/outperforms/handles Y, re-read the specific source passage to confirm the direction. Inversions are the hardest errors to catch later because they sound equally plausible.

## 5. Editorial vs. Source Distinction

If you're adding interpretation beyond what the source explicitly states (which is fine for insight synthesis), frame it as interpretation: "This suggests..." or "The implication is..." — never present your synthesis as if the source said it directly.
