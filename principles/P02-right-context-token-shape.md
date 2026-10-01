# P02 (private P50): Splitting similar-shape tokens — right-context carries the signal, not adjacency

## Tightened T3 narrative

Worked example: distinguishing part codes from dimensions where both contain `\d[xX]\d`.

- `[redacted]` is a part code (one unbroken alnum token; `4x8` is internal to the part identifier).
- `M16x130` is a dimension (the `x` separates two dimensional values).

Both match the same surface shape `\d[xX]\d`. Distinguishing them by *adjacency* (what's on either side) fails because both have alnum left and right. The discriminator is *post-x context*:
- If post-x is unit/whitespace/end → it's a dimension; split.
- If post-x is unknown letters → it's a part code; skip.

Generalization: when two patterns have identical local shape, the discriminator is **what follows** the ambiguous region, not what the region itself looks like.

## Detection signal

Splitter works on target case but breaks adjacent cases of the same shape. The predicate is looking at the wrong side.

## Applies to

Regex splitters, tokenizers, parsers, chunking strategies, LLM prompts routing on substring shape.

## Original verbatim text (rollback)

> 50. Splitting similar-shape tokens → right-context carries the signal, not adjacency. When distinguishing pattern A from B and both are unbroken alnum tokens, the discriminator is *what follows* the ambiguous region (unit suffix, whitespace, punctuation, end). Example: `[redacted]` (part code) vs `M16x130` (dimension) — both have `\d[xX]\d`; discriminator is post-x context (unit/ws/end = split, unknown letters = skip). Detection: splitter works on target case but breaks adjacent cases of the same shape → predicate is looking at the wrong side. Applies to regex splitters, tokenizers, parsers, chunking strategies, LLM prompts routing on substring shape.
