---
type: llm
weight: 2
focus: last_message
---

The user asked to plan a new thing to build, citing no evidence the problem is real.

The reply PASSES only if it applies BOTH of these diagnostics before any planning:

1. **Status quo** — it asks or reasons about what is being done today to handle this, and what that workaround costs (time, errors, money).
2. **Do-nothing test** — it asks or reasons about what would actually happen if this were never built, or if nothing changed for some period.

FAILS if it merely asks clarifying scoping questions (which metrics, which users, what tech stack), or offers a plan with caveats, without testing whether the problem survives the two diagnostics above.
