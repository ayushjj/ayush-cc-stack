---
name: skill-audit
description: Audit ~/.claude/skills/ and ~/.claude/hooks/ for universality — detect project-specific tokens leaking into universal layers. Run quarterly (aligned with /prune-memory). Triggers on "/skill-audit", "audit skills", "skills universal?", "check skill contamination", "universality audit".
---

# Skill: Skill Audit

## Why this exists

Skills and hooks are universal by construction (per CLAUDE.md principle 68 — `~/.claude/principles/P68-skills-universal-by-construction.md`). Once installed, they shape Claude's behavior across every project; project-specific tokens leaking into them silently degrade their usefulness in the user's other projects and force re-sanitization on every public release.

P57 predicts that a "remember to audit quarterly" reminder will silently lapse without baked-in cadence — this skill encodes the universality binary gate so the audit happens by invocation, not by attention. Without it, organic inline-capture from `/wrap` accretes into skill files between manual audits.

## Cadence

**Quarterly (90 days).** Aligned with `/prune-memory` so both maintenance audits land in one session.

Last review: [update this line each run].
Next review due: ~2026-08-23 (initial deploy 2026-05-26).

## Trigger

- Manual: user invokes `/skill-audit`.
- Calendar: every 90 days (track in MEMORY.md under "Claude Code OS Status").
- After-event: after any refactor touching multiple files in `~/.claude/skills/` or `~/.claude/hooks/` (ahead-of-schedule check).

## Inputs

The skill reads denylist patterns from a user-private file:

```
~/.claude/.skill-audit-patterns
```

This file lives OUTSIDE the audited scope (not under `skills/` or `hooks/`), so it can carry the user's actual project names, session-ID prefixes, schema fragments, etc. without making the skill itself non-universal. It is gitignored — the published skill ships without it; each adopter creates their own.

**File format** (one D-class per line, shell-sourceable):

```bash
# ~/.claude/.skill-audit-patterns — user's denylist (KEEP PRIVATE, gitignored)
# Edit when adding a new active project, session-ID format, or production schema.

D1='<your-project-slug-1>|<your-project-slug-2>|<your-project-slug-3>'
D2='\bS[0-9]{2,3}\b|<your-record-prefix>_[0-9]{4}|\bD[0-9]{1,3}\b|\bR[0-9]{1,3}\b'
D3='<your-schema-prefix>\.|<your-table>\.<your-column>|<other-table-fragment>'
D4='/Users/[a-zA-Z]+/'
```

If the file is missing, the skill exits with a one-line message pointing the user here. Empty values for any D-class skip that gate (useful for adopters with no production schema, for example).

## Steps

### Step 1: Inventory

```bash
ls -d ~/.claude/skills/*/ 2>/dev/null | wc -l   # active skill count
ls ~/.claude/hooks/*.js 2>/dev/null | wc -l     # standalone hook count
```

Cross-reference standalone hooks against `~/.claude/settings.json` `hooks` block. Flag any orphan file (hook with no registration) or stale registration (registration pointing at a missing file).

Also list paired skill-attached hooks (`~/.claude/skills/*/scripts/*.js`) and inline `settings.json` hooks (read the `hooks` block directly). All three classes are in scope.

### Step 2: Run the universality binary gate

Source the patterns file, then run each D-class as a `grep -rE` over the audited scope. Report PASS (0 matches) or FAIL (N matches with `file:line` evidence).

```bash
#!/bin/bash
PATTERNS_FILE="${SKILL_AUDIT_PATTERNS:-$HOME/.claude/.skill-audit-patterns}"

if [ ! -f "$PATTERNS_FILE" ]; then
  echo "ERROR: missing patterns file at $PATTERNS_FILE"
  echo "Create it with one D-class per line (see SKILL.md § Inputs for format)."
  exit 1
fi

# shellcheck disable=SC1090
source "$PATTERNS_FILE"

SCOPE=( "$HOME/.claude/skills/" "$HOME/.claude/hooks/" )

run_d_class() {
  local name="$1" pattern="$2"
  if [ -z "$pattern" ]; then
    printf '%-32s SKIP (no pattern defined)\n' "$name"
    return 0
  fi
  local count
  count=$(grep -rE "$pattern" "${SCOPE[@]}" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" -eq 0 ]; then
    printf '%-32s PASS (0 matches)\n' "$name"
  else
    printf '%-32s FAIL (%s matches)\n' "$name" "$count"
    grep -rnE "$pattern" "${SCOPE[@]}" 2>/dev/null | head -30
    echo ""
  fi
}

echo "Skill-Audit Universality Gate — $(date +%Y-%m-%d)"
echo "Scope: ${SCOPE[*]}"
echo ""
run_d_class "D1 (project names)"        "${D1-}"
run_d_class "D2 (session/record IDs)"   "${D2-}"
run_d_class "D3 (production schema)"    "${D3-}"
run_d_class "D4 (absolute user paths)"  "${D4-}"
```

Run this directly in a Bash tool call. PASS criterion: zero matches across all four D-classes (carve-outs subtracted per Step 3).

### Step 3: Subtract known structural carve-outs

Two collision classes are intentional and excluded from contamination count:

- **scout rule labels**: `scout/SKILL.md` uses `R1`–`R7` as its own self-review rule system. `level-up/SKILL.md` references `Run self-review R1-R7 (scout Step 5.5)` as a cross-skill pointer. Both are skill-internal nomenclature, NOT project-coupled rule IDs (which would be 2-3 digits: `R32`, `R128`, etc.).
- **skill-audit gate-category labels** (`D1`, `D2`, `D3`, `D4`): this skill's own SKILL.md uses these as labels for the four denylist regex categories — they are skill-internal nomenclature, same shape as scout's R1-R7. Multi-digit project-numbered decision IDs (`D32`, `D128`, etc.) are NOT carve-outs and SHOULD fail the gate.
- **publish-stack denylist labels + publish-spec decision refs** (`D1`–`D5`, plus single-digit `D4`/`D5`/`D7` referencing the public repo's `decisions.md`): `skills/publish-stack/` (`SKILL.md`, `denylist_gate.sh`, `prepare_snapshot.py`) uses the same single-digit `D[1-9]` gate-label nomenclature and cites publish-spec decisions by number. Single-digit `D[1-9]` here is skill-internal/spec-ref nomenclature, same carve-out class. Multi-digit project decision IDs still SHOULD fail.
- **Single-digit `S[1-9]`** (if it ever fires) — would collide with unrelated codes, but the regex `\bS[0-9]{2,3}\b` requires ≥2 digits.

For each D-class FAIL, subtract carve-out lines before declaring real contamination. Document any new carve-out class explicitly in this file's `## Steps` so the next audit doesn't re-discover it (future-`/skill-audit` runs read this list first).

### Step 4: Classify any remaining failures

For each non-carve-out match:

- **Was-clean-now-contaminated**: file was clean at last audit; new tokens appeared → organic inline-capture from `/wrap`. Extract the new incident to `~/.claude/learnings/<date>-skill-<name>-refactor.md` and replace inline with synthetic. (P68 fix procedure.)
- **New skill/hook added with project tokens**: the skill was authored with contamination from day 1. Refactor in the same session (don't accumulate debt across audits).
- **Skill-coupling contract phrase contaminated** (per governance.md skill-coupling table): HALT — paired-update across both sides is required. Defer to a separate spec; do NOT silently break the coupling.

### Step 5: Report

Print a short verdict per layer:

```
skills/  N skills audited; PASS_count clean; FAIL_count contaminated; carve-outs: X
hooks/   N hooks audited;  PASS_count clean; FAIL_count contaminated; carve-outs: X
```

If any FAIL: list each as `file:line — <which-D-class>`. Otherwise, declare PASS overall.

### Step 6: Update governance

- Update "Last review" line in this SKILL.md to today's date.
- Update `~/.claude/governance.md` "Quarterly cadences" entry — bump `Last run` to today and `Next due` to today + 90 days.
- If any refactor work was deferred (e.g., a skill-coupling halt), capture it as a tracked gap in MEMORY.md "Claude Code OS Status" so the next session's `/catchup` surfaces it.

## Anti-patterns

- **Don't refactor mid-audit when context is busy.** The audit's job is to *detect*; refactor passes are separate work with their own diff-shape and smoke gates (the Behavioral Preservation Contract — `~/.claude/principles/P68-skills-universal-by-construction.md`). Capture the FAIL list, defer the fix.
- **Don't broaden a regex on a false positive without first asking what the collision means.** A new false-positive class may indicate a real structural choice in the underlying skill (e.g., skill-internal rule numbering like scout's R1-R7). Document carve-outs in Step 3 rather than tweaking the regex away.
- **Don't audit OMIT candidates by mistake-table absence alone.** Past audits caught self-correction cases where a skill had real firing evidence in `session-registry.yaml` or per-project memory files but was about to be deleted on the basis of CLAUDE.md absence. Firing-evidence sources for OMIT decisions: `CLAUDE.md` mistake table + `system-map.md` provenance + `session-registry.yaml` + every `~/.claude/projects/*/memory/` per-project memory file + `governance.md` skill-coupling table. Traverse the union before classifying.
- **Don't audit only by count.** "Small number of matches" is FAIL, not partial PASS. Zero matches across all four D-classes (minus carve-outs) is the bar.
- **Don't skip the patterns-file check.** If `~/.claude/.skill-audit-patterns` is missing or empty, the audit will silently pass everything. Step 2's `ERROR: missing patterns file` halt is the canary — don't comment it out to "make the audit run".

## Recursive bootstrap

The skill itself lives in `~/.claude/skills/skill-audit/SKILL.md` — inside the audited scope. To pass its own gate:

- Project-specific patterns live in `~/.claude/.skill-audit-patterns` (outside scope; gitignored).
- This file uses placeholder shapes (`<your-project-slug>`, `<your-table>.<your-column>`) when illustrating format, not real names.
- No session IDs, decision/rule IDs, business names, schema fragments, or absolute user paths appear in this file's prose or code.

Verify by running Step 2 against the new skill file itself — D1-D4 should all PASS.

## Why quarterly specifically

- 90-day cadence aligned with `/prune-memory` so both maintenance audits run in one session — cheap to invoke, easy to remember.
- Faster than that, the audit consumes more session time than the contamination it surfaces (organic capture rate is slow).
- Slower than that, organic inline-capture from `/wrap` accretes silently — the longer the gap, the larger the refactor diff and the higher the risk of Behavioral Preservation Contract regression during the catch-up refactor.
- After any major refactor touching multiple skills/hooks (event-driven), invoke ahead of schedule — the refactor itself is when accidental contamination is likeliest.
