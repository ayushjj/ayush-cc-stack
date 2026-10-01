---
name: skill-audit
description: Audit ~/.claude/skills/ and ~/.claude/hooks/ for universality — detect project-specific tokens leaking into universal layers. Run quarterly (aligned with /prune-memory). Triggers on "/skill-audit", "audit skills", "skills universal?", "check skill contamination", "universality audit".
---

# Skill: Skill Audit

## Why this exists

Skills and hooks are universal by construction (per CLAUDE.md principle 68 — `~/.claude/principles/P17-skills-universal-by-construction.md`). Once installed, they shape Claude's behavior across every project; project-specific tokens leaking into them silently degrade their usefulness in the user's other projects and force re-sanitization on every public release.

P57 predicts that a "remember to audit quarterly" reminder will silently lapse without baked-in cadence — this skill encodes the universality binary gate so the audit happens by invocation, not by attention. Without it, organic inline-capture from `/wrap` accretes into skill files between manual audits.

## Cadence

**Quarterly (90 days).** Aligned with `/prune-memory` so both maintenance audits land in one session.

Last review: **2026-08-26** (first full run since the 2026-05-26 deploy).
Next review due: **2026-11-24** (90 days).

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
# ~/.claude/.skill-audit-patterns — user's denylist (KEEP PRIVATE: tracked in the private config repo, never in the publish manifest)
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
node ~/.claude/skills/telemetry/scripts/skill-inventory.js   # firing mechanism per skill
```

**The firing-mechanism dimension (added S65).** The universality gate asks whether a skill
*belongs* here; this asks whether it can ever *run*. A skill with no mechanism is reachable only
if the user remembers it — P57 — and it fails silently, because nothing downstream breaks when a
skill never fires. The S65 hand-rolled pass found four with no mechanism, and `level-up` 60 days
stale because its SKILL.md documented a `/catchup` nudge that was never built.

Read the script's own caveats before acting on its verdicts: low usage never proves a skill is
dead (`careful` runs as a hook script and reads 0 on every channel), the five rare-BY-DESIGN
safety skills must not be judged by count (S64 — a count is not a health signal), and a
MEM-only signal may be a status note that merely names the skill rather than a standing
instruction that drives it.

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
  count=$(grep -rE --binary-files=without-match \
            --exclude-dir=__pycache__ --exclude='*.pyc' \
            "$pattern" "${SCOPE[@]}" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" -eq 0 ]; then
    printf '%-32s PASS (0 matches)\n' "$name"
  else
    printf '%-32s FAIL (%s matches)\n' "$name" "$count"
    grep -rnE --binary-files=without-match \
         --exclude-dir=__pycache__ --exclude='*.pyc' \
         "$pattern" "${SCOPE[@]}" 2>/dev/null | head -30
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

**Reconcile D1 against disk FIRST — a denylist decays in one direction only.** Every project
started since the patterns file was last edited makes the gate blinder while it keeps reporting
PASS more confidently. Run this before Step 2 and treat any `MISSING` as a gate defect, not a
project to ignore:

```bash
source "$HOME/.claude/.skill-audit-patterns"
ls -d ~/dev/*/ | xargs -n1 basename | while read -r p; do
  # A slug counts as covered if EITHER form matches: bare (distinctive slugs)
  # or dev/-anchored (generic words like work/Data that cannot go in bare).
  printf "%s" "$p"      | grep -qE "$D1" && continue
  printf "dev/%s" "$p"  | grep -qE "$D1" && continue
  echo "MISSING from D1: $p"
done
```

Two rules when adding a slug, both learned 2026-08-26 by measuring before writing:
- **Distinctive slugs go in bare.** Verify with `grep -rc` first; a slug with 0 current hits is
  pure prevention and costs nothing.
- **Generic slugs must be path-anchored (`[redacted]`, `[redacted]`).** Measure the way the gate
  measures — `grep -rE`, CASE-SENSITIVE. Bare `work` matches ~107 times in scope, almost all
  English prose. A denylist entry that fires on ordinary writing gets carved out within one
  audit and then protects nothing. Caveat learned the hard way 2026-08-26: the first version of
  this rule cited a case-INSENSITIVE count (~123 for `Data`) as justification, which conflates
  the English word with the directory name; case-sensitively `Data` matches only ~8. The
  anchoring is still right for both, but the evidence for `Data` is far thinner than it looked.
  Measure with the same flags the gate uses, or the justification is about a different query.
  (The approximate figures above are illustrative of the GAP between the two methods, not
  current facts — re-run the greps; this file is inside the scope it counts.)
- **Check the collision form before assuming a hit is real.** `[redacted]` (hyphen) is the
  project; "knowledge graph" (space) is the generic CS term, 11 legitimate uses in scope. The
  hyphen is the discriminator, so no carve-out is needed.

### Step 3: Subtract known structural carve-outs

The following collision classes are intentional and excluded from contamination count
(no count stated here on purpose — it was wrong at two, then at five):

- **scout rule labels**: `scout/SKILL.md` uses `R1`–`R7` as its own self-review rule system. `level-up/SKILL.md` references `Run self-review R1-R7 (scout Step 5.5)` as a cross-skill pointer. Both are skill-internal nomenclature, NOT project-coupled rule IDs (which would be 2-3 digits: `R32`, `R128`, etc.).
- **skill-audit gate-category labels** (`D1`, `D2`, `D3`, `D4`): this skill's own SKILL.md uses these as labels for the four denylist regex categories — they are skill-internal nomenclature, same shape as scout's R1-R7. Multi-digit project-numbered decision IDs (`D32`, `D128`, etc.) are NOT carve-outs and SHOULD fail the gate.
- **publish-stack denylist labels + publish-spec decision refs** (`D1`–`D5`, plus single-digit `D4`/`D5`/`D7` referencing the public repo's `decisions.md`): `skills/publish-stack/` (`SKILL.md`, `denylist_gate.sh`, `prepare_snapshot.py`) uses the same single-digit `D[1-9]` gate-label nomenclature and cites publish-spec decisions by number. Single-digit `D[1-9]` here is skill-internal/spec-ref nomenclature, same carve-out class. Multi-digit project decision IDs still SHOULD fail.
- **Session-ID provenance in test files** (`hooks/tests/**`) — APPROVED 2026-08-26. Canary and
  regression suites cite the session that motivated each fixture ("the S256 telemetry-prose bug
  one extension over"). That citation is the *reason the fixture exists*; stripping it leaves a
  test nobody dares change because nobody knows what it guards. This is the single largest D2
  class by volume — roughly half of all D2 hits — and it is documentation, not coupling.
  **Scope: `hooks/tests/` only.** Provenance comments in production hooks and skill scripts are
  the same practice in a different place and are NOT covered by this carve-out; they were left
  deliberately undecided (see Step 6 notes) rather than folded in silently.
  Evidence that made this safe to approve: a 2026-08-26 classification of every D2 hit found
  **zero** that affect program logic. All are comments, prose, or docstrings, except two
  user-facing string literals that print a bare session ID — those two are real leaks and are
  NOT carved out.
- **`[redacted]` inside the graph-native skills** — APPROVED by the operator 2026-08-26,
  on the reasoning that `/learn` exists *to operate on* that
  directory: the slug is the ADDRESS OF THEIR SUBJECT, not a leaked project name. Same class as
  a database tool naming its database. **Scope is a PATH ALLOWLIST, not a judgement call**:
  `skills/learn/` — that one directory only (it absorbed `/connect` and `/learn-book` in S69,
  so the allowlist got NARROWER, not wider; its `references/` are inside the same path).
  A `[redacted]` hit anywhere else is coupling, not subject-matter, and is a real finding.
  An earlier draft phrased this as "would this skill be meaningless without that directory?";
  review rejected it as a judgement call dressed as a rule (P72 — no auditable procedure, no
  positive control). A path list is greppable, and a paragraph copy-pasted into another skill
  lands outside it and fails on the next run with no auditor discretion involved.
- **This file's own D1/D2 hits** — RESOLVED 2026-08-26 by carving out, not stripping. See
  "## Recursive bootstrap" below for the full reasoning; the short version is that an audit
  tool must be allowed to cite what it audits, and the precedent is exactly scout's `R1`-`R7`
  and the `publish-stack` gate labels two bullets up. Scope: `skills/skill-audit/SKILL.md`
  ONLY — same path-allowlist discipline as the bullet above, for the same reason. Any OTHER
  skill citing a real project slug or session ID is still a finding.
- **Single-digit `S[1-9]`** (if it ever fires) — would collide with unrelated codes, but the regex `\bS[0-9]{2,3}\b` requires ≥2 digits.

For each D-class FAIL, subtract carve-out lines before declaring real contamination. Document any new carve-out class explicitly in this file's `## Steps` so the next audit doesn't re-discover it (future-`/skill-audit` runs read this list first).

### Step 4: Classify any remaining failures

For each non-carve-out match:

> ⚠️ **First run after a D-class was widened: "clean at last audit" is not the same as "clean".**
> D1 was extended on 2026-08-26 with 11 project slugs it had never covered, which surfaced
> a body of pre-existing `[redacted]` references — spread across most of the graph-adjacent
> skills plus one hook test — that every prior audit reported as PASS.
>
> **No count is quoted here on purpose.** This file lives INSIDE the audited scope, so any
> sentence counting scope hits counts itself, and every edit to this file falsifies its own
> number. That is not hypothetical: the count was written, corrected, and invalidated again by
> the correcting edit, all within one session on 2026-08-26. Derive it at audit time with the
> Step 2 gate and let the run own the figure. Those are *gate-blindness findings*, not organic drift — classifying them as
> was-clean-now-contaminated would blame `/wrap` for something the denylist simply never looked at.
> On any audit where the reconciliation step above added a slug, classify that slug's hits as
> **newly-visible** and record the disposition here so the next run inherits it. The distinction
> matters because the two classes have opposite fixes: drift needs a capture-discipline change,
> blindness needs a gate change.

- **Was-clean-now-contaminated**: file was genuinely covered by the gate at last audit; new tokens appeared → organic inline-capture from `/wrap`. Extract the new incident to `~/.claude/learnings/<date>-skill-<name>-refactor.md` and replace inline with synthetic. (P68 fix procedure.)
- **New skill/hook added with project tokens**: the skill was authored with contamination from day 1. Refactor in the same session (don't accumulate debt across audits).
- **Skill-coupling contract phrase contaminated** (per governance.md skill-coupling table): HALT — paired-update across both sides is required. Defer to a separate spec; do NOT silently break the coupling.

### Step 5: JTBD + staleness + cadence-freshness pass

The universality gate (Steps 2-4) only catches contamination. A skill can be perfectly clean and still be a husk — the job it served moved on, its internal facts drifted, or its cadence stopped firing without anyone noticing (P57). Run this pass over every non-archived skill in `~/.claude/skills/` as a distinct dimension from the contamination gate above.

**Fan this step out — one subagent per skill.** This is authorised by the FIRST clause of the
standing-delegation line in `CLAUDE.md` § Environment ("big greps/test runs/log trawls →
subagent"), not the named-skill clause — `/skill-audit` is deliberately not in that list, because
the fan-out belongs to this step rather than to the whole skill (Steps 1-4 are deterministic and
must stay in-context). Serial
execution here is a measured defect, not a style preference: the scope is every skill under `skills/` (size it with `wc -l` at audit time),
cross-referenced against a `session-registry.yaml` that grows every wrap. Read serially,
the skills audited last get a thinner pass than the ones audited first — **and the report cannot
show you which**, because a shallow `Keep` is indistinguishable from a rigorous one. That is the
P72 shape: a verdict whose quality is unobservable from its output.

Give every subagent the same three questions and this exact return schema, so dispositions are
comparable across agents rather than reflecting each agent's private bar:

```
skill: <slug>
disposition: keep | slim | fold | archive
evidence: <one line — a count, a file:line, or a dated registry entry. NOT an impression.>
stale_facts: <file:line for each path/version/count/cross-reference that failed verification, or "none">
cadence: <last-run date and next-due, or "no cadence">
```

An agent that returns `evidence` without a number, a `file:line`, or a date has not done the
step — re-run that one skill rather than accepting the verdict. Then read every return yourself
and decide dispositions: the agents gather evidence, they do not get a vote on what to archive.

For each skill, answer three questions:

1. **JTBD — does the job still exist, and is this skill how the job actually gets done?**
   Evidence: invocation counts for the skill's slug in `~/.claude/session-registry.yaml`, cross-checked against whether the underlying job's artifacts (files, patterns, conventions) keep appearing anyway — a thriving job with ~zero skill invocations means the job is being done by something cheaper (an ad-hoc pass, a different skill, a fan-out agent). That is a **retire-the-procedure-keep-the-contract** signal: drop the ceremony, preserve any artifact shape (frontmatter, naming convention, file location) that other tooling depends on.
2. **Staleness — do the skill's internal facts still match reality?**
   Grep the skill file for absolute paths, version/model strings, hardcoded counts, and cross-references to other skill slugs; verify each against current disk state. A skill citing a retired, renamed, or moved skill/path — or a stale count — is a husk signal even when its core procedure still runs correctly, because every future invocation fires on a wrong assumption.
3. **Cadence freshness — for any skill with a scheduled cadence, is the calendar actually firing?**
   Read the skill's own "Last review"/"Last run" line, then cross-check `~/.claude/session-registry.yaml` for that cadence's recent entries. Recent entries showing repeated overdue/NAG lines with no intervening run mean the calendar-by-nudge mechanism is dead for that skill (P57) — a suggestion nobody acts on is not a cadence. Recommend converting the trigger to a hook or a check baked into a skill that already runs reliably, rather than another manual reminder.

**Disposition per skill** (pick one, state the one-line evidence that drove it):
- **Keep** — job alive, facts current, cadence firing (or no cadence).
- **Slim** — job alive but the skill over-serves it; compress ceremony, keep the contract.
- **Fold** — job alive but better served as a step/section inside another skill or CLAUDE.md; merge in, then archive the standalone.
- **Archive** — job dead, or job alive but lost to a cheaper substitute with no unique artifact contract left to preserve: `git mv skills/<slug> skills-archive/.archived-<slug>` (matches the existing archived-skill convention — verified S69 against the six already there; this line previously said `skills/.archived-<slug>`, a path that has never existed on disk).

Per the Anti-patterns section below: this step *detects* and records dispositions — it does not refactor mid-audit. Slim/fold/archive work is a separate pass with its own diff-shape and smoke gate.

### Step 6: Report

Print a short verdict per layer:

```
skills/  N skills audited; PASS_count clean; FAIL_count contaminated; carve-outs: X
hooks/   N hooks audited;  PASS_count clean; FAIL_count contaminated; carve-outs: X

JTBD/staleness/cadence: keep_count keep; slim_count slim; fold_count fold; archive_count archive
```

If any FAIL: list each as `file:line — <which-D-class>`. Otherwise, declare PASS overall.

List each non-keep disposition from Step 5 with its one-line evidence, so the next session (or the owner) can act without re-deriving the reasoning.

### Step 7: Update governance

- Update "Last review" line in this SKILL.md to today's date.
- Update `~/.claude/governance.md` "Quarterly cadences" entry — bump `Last run` to today and `Next due` to today + 90 days.
- If any refactor work was deferred (e.g., a skill-coupling halt), capture it as a tracked gap in MEMORY.md "Claude Code OS Status" so the next session's `/catchup` surfaces it.

## Anti-patterns

- **Don't refactor mid-audit when context is busy.** The audit's job is to *detect*; refactor passes are separate work with their own diff-shape and smoke gates (the Behavioral Preservation Contract — `~/.claude/principles/P17-skills-universal-by-construction.md`). Capture the FAIL list, defer the fix.
- **Don't broaden a regex on a false positive without first asking what the collision means.** A new false-positive class may indicate a real structural choice in the underlying skill (e.g., skill-internal rule numbering like scout's R1-R7). Document carve-outs in Step 3 rather than tweaking the regex away.
- **Don't audit OMIT candidates by mistake-table absence alone.** Past audits caught self-correction cases where a skill had real firing evidence in `session-registry.yaml` or per-project memory files but was about to be deleted on the basis of CLAUDE.md absence. Firing-evidence sources for OMIT decisions: `evals/mistake-ledger.md` + `system-map.md` provenance + `session-registry.yaml` + every `~/.claude/projects/*/memory/` per-project memory file + `governance.md` skill-coupling table. Traverse the union before classifying.
- **Don't audit only by count.** "Small number of matches" is FAIL, not partial PASS. Zero matches across all four D-classes (minus carve-outs) is the bar.
- **Don't skip the patterns-file check.** If `~/.claude/.skill-audit-patterns` is missing or empty, the audit will silently pass everything. Step 2's `ERROR: missing patterns file` halt is the canary — don't comment it out to "make the audit run".

## Recursive bootstrap

The skill itself lives in `~/.claude/skills/skill-audit/SKILL.md` — inside the audited scope. To pass its own gate:

- Project-specific patterns live in `~/.claude/.skill-audit-patterns` (outside scope; private, never published).
- This file uses placeholder shapes (`<your-project-slug>`, `<your-table>.<your-column>`) when illustrating format, not real names.
- No schema fragments and no absolute user paths appear in this file's prose or code. (D3 and
  D4 both return 0 against this file — verified 2026-08-26.)

**RESOLVED 2026-08-26 — carved out, deliberately not stripped.** Run Step 2 against this file
and D1 and D2 both FAIL. The hits are real project slugs and session IDs used as EVIDENCE inside
the instructions themselves — the bare-vs-anchored rule is only checkable because it names the
slugs it was measured on, and the lessons are only datable because they carry their session.

Two resolutions were possible and the rejected one is worth recording. **Stripping** — replacing
every real slug and ID with placeholder shapes — would make this file pass its own gate and stay
publishable verbatim. It was rejected because a rule whose reason has been sanitised away is the
rule a future editor "simplifies" back into a defect; this very session watched a checker get
deleted as a "duplicate" precisely because nobody could see what it uniquely covered.

**Carving out** keeps the gate honest, because the exception is written down, scoped to one file,
and re-derived on every run rather than assumed. The precedent is not novel: scout's `R1`-`R7` and
the `publish-stack` gate labels are the same shape, already documented in Step 3.

The carve-out is therefore NARROW BY CONSTRUCTION. It covers this file and nothing else. If a
future edit moves this reasoning into another skill, the carve-out does NOT travel with it —
re-open the question there.

## Why quarterly specifically

- 90-day cadence aligned with `/prune-memory` so both maintenance audits run in one session — cheap to invoke, easy to remember.
- Faster than that, the audit consumes more session time than the contamination it surfaces (organic capture rate is slow).
- Slower than that, organic inline-capture from `/wrap` accretes silently — the longer the gap, the larger the refactor diff and the higher the risk of Behavioral Preservation Contract regression during the catch-up refactor.
- After any major refactor touching multiple skills/hooks (event-driven), invoke ahead of schedule — the refactor itself is when accidental contamination is likeliest.
