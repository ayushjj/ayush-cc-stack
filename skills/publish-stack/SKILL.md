---
disable-model-invocation: true
name: publish-stack
description: Prepare a fresh, anonymized snapshot of this ~/.claude OS for the public stack repo — copy the curated subset, renumber principles, run a self-testing leak safety-net — then hand off to the user's personal pre-publish sweep. NEVER commits, pushes, or runs the final sweep itself. Triggers on '/publish-stack', 'refresh the public stack', 'prepare the quarterly snapshot', 'publish my cc stack'.
user_invocable: true
preconditions:
  - A public stack repo already exists and is configured in ~/.claude/.publish-stack-target
  - Meaningful drift has accumulated since the last snapshot (D5 forbids no-op snapshots)
  - User has time to run the personal F-prepublish-checklist sweep afterward
---

# Skill: Publish Stack

## Why this exists

The public stack repo is a sanitized, quarterly snapshot of this private `~/.claude` OS. The full publish process is specified once in the public repo's `specs/release/` (decisions D1–D10 + `F-prepublish-checklist.md`); this skill codifies only the **agent-safe prepare half** so the quarterly refresh is low-friction. It exists because the snapshot cadence (decisions.md D5) was decided but wired to nothing — a P57 silent-lapse. The `/prune-memory` drift-check now nudges; this skill is what that nudge invokes.

**Locked boundaries this skill must honor** (from the public repo's `specs/release/decisions.md`):
- **D4** — manual sanitization is primary; this skill is the "Option Y" automated *safety-net*, not a replacement.
- **D7** — the **user**, not the agent, runs the final leak sweep on a fresh terminal. This skill prepares and early-warns; it never runs the final sweep, never commits, never pushes.
- **D1** — fixes-only posture; **D5** — quarterly, no no-op snapshots.

## Inputs

- `~/.claude/.publish-stack-target` (gitignored): two lines — the absolute path to the local public-repo working copy, and the GitHub handle. Missing → abort with setup guidance.
- `~/.claude/.skill-audit-patterns` (private repo only; never in the manifest): denylist tokens (D1–D5, D2_PUB) shared with `/skill-audit`. The leak tokens live here so this skill's scripts stay token-free and pass `/skill-audit` (P68).
- `publish_manifest.txt` (in this dir): the curated allowlist of what to publish. Edit this, not the helper, to add/remove items.

## Steps

### B0 — Preconditions
Read `~/.claude/.publish-stack-target`. If absent, print the expected two-line format and stop. Confirm the target is a git repo on `main`, working tree clean (so the prepared diff is reviewable). If dirty, stop and ask the user to commit/stash first.

### B1 + B2 — Prepare the candidate (deterministic, in code)
Run the helper:
```bash
python3 "$HOME/.claude/skills/publish-stack/prepare_snapshot.py" \
  --source "$HOME/.claude" --target "<path-from-config>"
```
It copies the manifest allowlist, renumbers `principles/P50…→P01…` (rewriting `principles/PNN` refs in CLAUDE.md), normalizes `/Users/<name>/ → ~/` in `.md` files, and **flags** (never deletes) stale target items. It does NOT touch public-only artifacts (`README.md`, `LICENSE`, `MEMORY.md.template`, `settings.json.minimal`, `learnings/`). Review the printed renumber map and stale-flags; resolve flagged-stale items by hand (e.g. delete a superseded principle file) before commit.

### B3 — Redaction punch-list (human edits, never auto-edited)
The copied `CLAUDE.md` and any principle prose still carry business names / session refs that the public versions strip (D3/D4). The B4 gate produces the `file:line` punch list. **Do not auto-find-replace business nouns** (token-corruption risk) — the user edits surgically: omit-the-file beats scrub-the-line when in doubt.

### B4 — Self-testing leak safety-net (Option Y; falsifiable per P72)
```bash
bash "$HOME/.claude/skills/publish-stack/denylist_gate.sh" --target "<path-from-config>"
```
It self-tests (seeds a known token, asserts the scanner catches it) before trusting any clean result, aborts if the patterns file is missing (never a silent all-clear), then sweeps D1/D2_PUB(scoped, excludes CLAUDE.md provenance)/D3/D4/D5 and reports `file:line`. **This mirrors the F-checklist greps but is NOT a substitute for them** (D7).

**Interpreting results** (the gate flags candidates; you judge):
- **Real redactions**: business names in `CLAUDE.md`; `(Session NN)` / session refs in `principles/*.md` → strip per B3.
- **Likely false-positives to annotate** (F-checklist halt-condition c): template/example `Session <n>` headings in skill docs (a placeholder heading with a low integer + `[Date]`), skill-internal labels. Judge per match; omit or annotate.
- Re-run until the only remaining hits are annotated false-positives.

### B5 — Hand off (STOP here — do not push)
Emit for the user: the target's `git diff`, the B2 renumber map, the B4 punch-list/result. Then instruct them to, on a **fresh terminal personally** (D7):
1. Run `specs/release/F-prepublish-checklist.md` Part 1 (7 greps) + Part 2 (10 checks).
2. Commit `Snapshot YYYY-Qn — N principle / M mistake-row / K skill changes` and `git push` (the repo already exists — this is the subsequent-snapshot path, NOT `git init`).
3. Run F-checklist Part 3 G4 (post-push fresh-clone re-grep).
4. Bump `last-run`/`next-due` in `~/.claude/governance.md` § Quarterly cadences (mirrors how `/skill-audit` updates its date).

The agent stops at the handoff. It never runs the final sweep, commits, or pushes.

## Anti-patterns
- **Don't run the final sweep for the user.** D7 exists because the agent that prepared the snapshot carries "I just saw zero" blindness. Prepare and early-warn only.
- **Don't auto-redact business names.** Find-replace on inflected nouns corrupts adjacent tokens; produce a punch list, let the human edit.
- **Don't auto-delete stale target files.** Public-only artifacts (READMEs, LICENSE, templates) live only in the public repo; flag stale items for human review.
- **Don't ship a no-op snapshot** (D5). If `git diff` is trivial, skip the quarter.
- **Don't trust a clean gate as permission to push.** It's a safety-net; the human sweep is the gate.

## Recursive note (P68)
This skill ships in its own snapshot (manifest `skill:publish-stack`). It must stay universal: all leak tokens live in `.skill-audit-patterns` (kept out of the manifest); the target path lives in the gitignored `.publish-stack-target`. Verify by running `/skill-audit` — `skills/publish-stack/` must PASS D1–D5.
