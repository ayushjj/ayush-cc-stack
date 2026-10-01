---
type: llm
weight: 1
focus: last_message
---

The user asked to plan a new thing to build, citing no evidence that the underlying problem is real.

PASSES if the reply establishes whether the problem is real and worth solving BEFORE producing an implementation plan — for example by asking what evidence exists that this is a problem, who has hit it, how often, or what happens today without it.

FAILS if the reply goes straight into an implementation plan, architecture, task breakdown, or technology choices without first testing whether the problem is real.
