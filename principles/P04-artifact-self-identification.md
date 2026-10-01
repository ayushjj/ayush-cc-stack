# P04 (private P53): Artifact self-identification — runtime config belongs in the artifact, not in the spec/filename/commit message

## Tightened T3 narrative

Runtime config that must hold across runs (model, prompt version, temperature, seed, schema version) belongs in the artifact schema as a first-class field. Inferring it from spec + filename + commit message turns every future "which config produced this?" into forensic work — stylistic inference, git archaeology, or a decisive re-run — rather than a field read.

Worked example: JSONL outputs from a batch LLM pipeline carried no `model` field. Five sessions later, a model-provenance question (was this batch produced by Sonnet 4.5 or 4.6?) required a decisive re-run to resolve, because:
- Filename did not encode model.
- Spec described intent ("use Sonnet"), not the actual deployed config.
- Commit message described what changed, not what config was active.

The artifact's failure mode was silent — the data was usable, just unidentifiable.

## Corollary — deterministic spine

P53 field-copying is deterministic spine work (per P48): post-process in code from input records rather than relying on the LLM agent to emit. Agents reproducibly half-drop extension fields when an upstream schema document has a stronger "EXACTLY one JSON object" anchor than the task-section schema override (~50% drop rate observed).

## Detection signal

Any pipeline where `git log | grep <config>` is your plan for "what produced X." If reading the artifact alone can't answer the question, the artifact is under-self-identified.

## Applies to

ML eval outputs, API responses written to disk, batch pipeline artifacts, cached LLM verdicts, any pipeline where config evolves faster than artifacts decay.

## Original verbatim text (rollback)

> 53. Artifact self-identification — runtime config that must hold across runs (model, prompt version, temperature, seed, schema version) belongs in the artifact schema, not inferred from spec + filename + commit message. If config doesn't survive in the output file, every future "which config produced this?" becomes forensic (stylistic inference, git archaeology, decisive re-runs) rather than a field read. Example: JSONL outputs carrying no `model` field meant a 5-session-old model-provenance question required a decisive re-run to answer. Detection: any pipeline where `git log | grep <config>` is your plan for "what produced X" — bake config into the output. Applies to: ML eval outputs, API responses to disk, batch pipeline artifacts, cached LLM verdicts, any pipeline where config evolves faster than artifacts decay. Corollary: P53 field-copying is deterministic spine work (per P48) — post-process in code from input records rather than relying on agent to emit; agents reproducibly half-drop extension fields when an upstream schema document has a stronger "EXACTLY one JSON object" anchor than the task-section override.
