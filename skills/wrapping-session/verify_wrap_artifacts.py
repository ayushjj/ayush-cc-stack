#!/usr/bin/env python3
"""Verify wrap-artifact compression invariants (structural fix for wrap-bloat).

Background: an earlier wrap-bloat compression audit found that every wrap
rewrote the same session narrative across 4 artifacts (learnings/,
MEMORY.md, implementation.md, session-registry.yaml) with ~80% content
overlap. Wraps were taking ~15 min. Root cause: 3 of those 4 places had
drifted from "load-bearing summary + pointer" to "multi-paragraph essay",
duplicating what learnings/ already canonically owns. The skill specified
shapes (e.g., session-registry label = "3-8 word summary") that were
attention-based and consistently ignored across multiple consecutive
sessions.

This verifier is the mechanical enforcement that the skill text alone
couldn't sustain (P57: suggestion-based gates fail silently). It also
addresses the precedent failure mode flagged in CLAUDE.md mistakes table:
"Compressed a growth-prone persistent file (MEMORY.md) without installing
a growth-rate governor — forward review blind to the bloat pattern."

Modes: --strict exits 1 on any FAIL; default is WARN (exit 0, diagnostics only).
ENFORCING since 2026-07-09: wrap Step 7a invokes --strict before the project
commit; the Step 5.5 inline cap-check keeps the WARN default as a write-time
early warning. (The prior "wire in after 3 consecutive clean wraps" activation
was the same unreachable condition that left verify_claude_md.py dead for 66
days — a gate can't wait for the backlog it exists to prevent to clear itself.)

Checks:
  0. session-registry is VALID YAML (S331). Not a compression check — a validity
     one — but it lives here because this is the only thing that reads the registry
     at wrap time. The file had not parsed for 60+ wrap commits and nothing noticed,
     because every consumer reads it line-based. Fails CLOSED on a parse error;
     prints CANNOT CHECK, never silence, when no parser is reachable.
  1. session-registry top label ≤300 chars (cap: lenient initial; tighten
     to ≤200 if drift returns).
  2. MEMORY.md Current State block ≤30 non-blank lines (everything between
     '## Current State' and the next '## ' heading).
  3. implementation.md latest session blockquote ≤30 lines (between
     '## Session Outcome Record (Latest)' and '### Prior Sessions').
  4. implementation.md coverage-freshness (opt-in): if a
     '<!-- coverage-synced: S<N> -->' marker exists, WARN when it lags the
     latest Session Outcome Record session. Absence-tolerant — no marker,
     no check (so marker-less projects are unaffected). This is the one
     FRESHNESS check (vs. the size checks 1-3); added after a coverage/plan
     surface froze ~49 sessions behind the outcome-record head (P62/P57).

MUST-PRESERVE invariants (NOT enforced here — the verifier checks size,
not structure; structural correctness still relies on skill discipline):
  - MEMORY.md header: parseable as `(YYYY-MM-DD ...)` for /catchup
    staleness check (catchup SKILL.md Step 2).
  - MEMORY.md Phase line: names active spec when one exists (catchup
    SKILL.md Step 1.4a).
  - Session-delta lines match `^- \\*\\*Session \\d+ \\([0-9-]+\\)\\*\\*:.*→\\s*`
    (catchup SKILL.md Step 1.5 regex, verbatim).
  - implementation.md latest blockquote contains a `→ learnings/path.md`
    link.
  - session-registry `next` field stays verbose (catchup reads verbatim).

Usage:
  python verify_wrap_artifacts.py [--strict]
      [--registry PATH] [--memory PATH] [--implementation PATH]
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

# Caps (tunable; see header docstring for tightening trigger).
# Both line-cap and char-cap are checked because verbose drift takes two forms:
# (1) many physical lines (paragraph-spaced essay) — line cap catches this;
# (2) one giant line (multi-paragraph collapsed into a single soft-wrapped string,
# observed in a real implementation.md blockquote regression) — char cap catches this.
# A drift escapes only if BOTH caps allow it, which forces genuine compression.
LABEL_CAP_CHARS = 300
MEMORY_CAP_LINES = 30
MEMORY_CAP_CHARS = 2500   # ~15 bullets @ ~150 chars each
IMPL_CAP_LINES = 30
IMPL_CAP_CHARS = 2500     # same budget — bullet form, not paragraph essay


# Ruby is the CANONICAL parser for this check, with PyYAML only as a fallback when ruby
# is unreachable. Not arbitrary: the two disagree about the same file (psych rejects
# anchors unless `aliases: true`; `yaml.safe_load` resolves them silently), and a
# BLOCKING gate whose verdict depends on which parser a machine happens to have is worse
# than no gate. One parser decides; the other only prevents a silent CANNOT CHECK.
#
# `safe_load(File.read(...))`, NOT `load_file(path, permitted_classes:)` — the keyword
# form is psych >= 3.3 (Ruby 3.0+) only. This box carries TWO rubies: rbenv's 3.4.7 and
# /usr/bin/ruby 2.6.10, and PATH decides which one a wrap gets. Under 2.6.10 the keyword
# form raises `ArgumentError: unknown keyword: permitted_classes` — a NON-ZERO exit that
# the first draft of this check reported as "registry is not valid YAML", i.e. it blocked
# every wrap on every project and blamed an apostrophe that did not exist. Measured on
# both rubies: the form below returns PARSE_OK on a valid file and a Psych error on a
# broken one, identically. `permitted_classes` covers the unquoted `date:` values.
_RUBY_PROBE = (
    "require 'yaml'; require 'date'; "
    "YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time]); "
    "STDOUT.puts 'PARSE_OK'"
)

# Only these mean "the FILE is bad". Anything else on stderr means the PARSER is bad,
# which must degrade to CANNOT CHECK rather than accuse the registry.
_PARSER_FAULT_MARKERS = ("Psych::SyntaxError", "Psych::DisallowedClass",
                         "Psych::AliasesNotEnabled", "Psych::BadAlias")

# The apostrophe remedy is the right hint for a SYNTAX fault and wrong for everything
# else. It is the operator's primary debugging artifact — the gate blocks the wrap — so
# it is gated on the error actually being a syntax error rather than appended blindly.
_APOSTROPHE_HINT = ("Almost always an unescaped apostrophe inside a single-quoted "
                    "label/next scalar: double it ('' not '). ")


def _one_line(value: object) -> str:
    """First non-empty line of an error, trimmed — the rest is a backtrace."""
    for line in str(value).strip().split("\n"):
        if line.strip():
            return line if len(line) <= 200 else line[:197] + "..."
    return "(no diagnostic)"


def _fail(detail: str, *, syntax: bool) -> list[str]:
    hint = _APOSTROPHE_HINT if syntax else ""
    return [f"FAIL: session-registry is not valid YAML — {detail}. "
            f"{hint}Fix before committing."]


def check_registry_parses(registry_path: Path) -> list[str]:
    """The registry must be VALID YAML — not merely greppable.

    Why this exists (S331, 2026-08-22): the file had not parsed for at least 60 wrap
    commits and nothing noticed, because every consumer reads it line-based (`/catchup`
    uses sed+grep; Step 5 writes with Edit). An invalid file therefore behaves perfectly
    right up until something parses it properly — and `prune_registry.py` already
    corrupted this file once (2026-07-27) for a related reason. The single fault was
    three unescaped apostrophes inside a single-quoted `next:` scalar, which one wrap
    typed and every later wrap inherited.

    ⚠️ DO NOT re-implement this with a regex. The S331 session first "detected" the
    problem with a single-line pattern flagging any `next: '...` that did not close on
    the same line; that is exactly what a legal MULTI-LINE single-quoted scalar looks
    like, so it produced two confident false positives that were reported to the owner
    and acted on. A real parser is available — use it. (§13J: a counting/validity method
    is itself a check and needs a positive control.)

    Fails CLOSED only when a parser says the FILE is bad. A parser that is missing, too
    old, or broken yields CANNOT CHECK — never silence, never an accusation against the
    registry (`cadence-check.js`: silence must mean "nothing wrong", not "reader broke").
    """
    if not registry_path.exists():
        return [f"INFO: registry not found at {registry_path} (skipping parse check)"]

    try:
        proc = subprocess.run(
            ["ruby", "-e", _RUBY_PROBE, str(registry_path)],
            capture_output=True, text=True, timeout=30,
        )
    except Exception as exc:  # noqa: BLE001 — any failure to RUN ruby is CANNOT CHECK
        ruby_note = f"ruby unusable ({_one_line(exc)})"
    else:
        if proc.returncode == 0 and "PARSE_OK" in proc.stdout:
            return []
        stderr = proc.stderr or ""
        if any(marker in stderr for marker in _PARSER_FAULT_MARKERS):
            return _fail(_one_line(stderr), syntax="Psych::SyntaxError" in stderr)
        # Non-zero, but nothing says the FILE is at fault — e.g. the psych-version
        # ArgumentError above. Do not accuse the registry.
        ruby_note = f"ruby exited {proc.returncode} without a Psych error ({_one_line(stderr)})"

    try:
        import yaml  # noqa: PLC0415 — optional fallback, absent on this machine
    except Exception as exc:  # noqa: BLE001 — a broken/shadowed yaml module is not ImportError
        return [f"INFO: CANNOT CHECK registry YAML validity — {ruby_note}; "
                f"PyYAML unusable ({_one_line(exc)}). Not a pass."]

    try:
        yaml.safe_load(registry_path.read_text())
    except yaml.YAMLError as exc:
        return _fail(_one_line(exc), syntax=True)
    except Exception as exc:  # noqa: BLE001 — e.g. UnicodeDecodeError on a non-UTF8 file
        return [f"INFO: CANNOT CHECK registry YAML validity — {ruby_note}; "
                f"PyYAML raised {type(exc).__name__} ({_one_line(exc)}). Not a pass."]
    return []


def find_first_label(registry_path: Path, project_basename: str) -> str | None:
    """Return the first `- label: ...` value under the project section,
    or None if not found. Robust to single/double-quoted values; assumes
    the skill writes labels as one physical line (current convention)."""
    if not registry_path.exists():
        return None
    text = registry_path.read_text()
    proj_re = re.compile(rf"^  {re.escape(project_basename)}:\s*$", re.M)
    pm = proj_re.search(text)
    if not pm:
        return None
    rest = text[pm.end():]
    label_re = re.compile(r"^    - label:\s+(.*?)$", re.M)
    lm = label_re.search(rest)
    if not lm:
        return None
    val = lm.group(1).strip()
    # Strip outer YAML quotes if present.
    if (val.startswith("'") and val.endswith("'")) or (val.startswith('"') and val.endswith('"')):
        val = val[1:-1]
    return val


def check_label(registry_path: Path, project_basename: str) -> list[str]:
    label = find_first_label(registry_path, project_basename)
    if label is None:
        return [f"INFO: no session-registry entry found for project '{project_basename}' (skipping label check)"]
    issues: list[str] = []
    if len(label) > LABEL_CAP_CHARS:
        issues.append(
            f"FAIL: session-registry label is {len(label)} chars (cap: {LABEL_CAP_CHARS}). "
            f"Routing signal, NOT a trim order: keep the label a 3-12 word summary + '→ learnings/path.md' "
            f"pointer and move the narrative DOWN to learnings/ — don't compress in circles. "
            f"Verbose `next` field is fine; that one /catchup reads verbatim."
        )
    if "learnings/" not in label:
        issues.append(
            f"INFO: session-registry label has no 'learnings/' pointer — if this session created "
            f"a learnings file, add '→ learnings/path.md' to the label so /catchup readers can "
            f"navigate. Routine sessions with no learnings file can ignore this."
        )
    return issues


def check_memory(memory_path: Path) -> list[str]:
    if not memory_path.exists():
        return [f"INFO: MEMORY.md not found at {memory_path} (skipping memory check)"]
    text = memory_path.read_text()
    lines = text.splitlines()
    start = end = None
    for i, line in enumerate(lines):
        if line.startswith("## Current State"):
            start = i
        elif start is not None and line.startswith("## ") and i > start:
            end = i
            break
    if start is None:
        return [f"INFO: MEMORY.md '## Current State' header not found at {memory_path} (skipping memory check)"]
    end = end if end is not None else len(lines)
    block_lines = lines[start + 1:end]
    non_blank = [ln for ln in block_lines if ln.strip()]
    block_text = "\n".join(non_blank)
    issues: list[str] = []
    if len(non_blank) > MEMORY_CAP_LINES:
        issues.append(
            f"FAIL: MEMORY.md Current State block is {len(non_blank)} non-blank lines "
            f"(cap: {MEMORY_CAP_LINES}). "
            f"Replace narrative paragraph with: 1 Phase line + 1 Next line + last-3 "
            f"session-delta lines + Memory Files index; route the detail DOWN to learnings/."
        )
    if len(block_text) > MEMORY_CAP_CHARS:
        issues.append(
            f"FAIL: MEMORY.md Current State block is {len(block_text)} chars "
            f"(cap: {MEMORY_CAP_CHARS}). "
            f"Routing signal, NOT a trim order: move the overflow DOWN to "
            f"learnings/{{date}}-session{{N}}-*.md (uncapped, auto-loaded via /catchup default "
            f"mode) and keep Current State as bullets + pointers — don't compress in circles. "
            f"MEMORY.md auto-loads as `claudeMd` every session, so the cap guards always-loaded context."
        )
    return issues


def check_implementation(impl_path: Path) -> list[str]:
    if not impl_path.exists():
        return [f"INFO: implementation.md not found at {impl_path} (skipping spec check)"]
    text = impl_path.read_text()
    lines = text.splitlines()
    start = end = None
    for i, line in enumerate(lines):
        if line.startswith("## Session Outcome Record (Latest)"):
            start = i
        elif start is not None and line.startswith("### Prior Sessions") and i > start:
            end = i
            break
    if start is None:
        return [f"INFO: implementation.md 'Session Outcome Record (Latest)' header not found (skipping spec check)"]
    end = end if end is not None else len(lines)
    block_lines = lines[start + 1:end]
    non_blank = [ln for ln in block_lines if ln.strip()]
    block_text = "\n".join(non_blank)
    issues: list[str] = []
    if len(non_blank) > IMPL_CAP_LINES:
        issues.append(
            f"FAIL: implementation.md latest session blockquote is {len(non_blank)} non-blank lines "
            f"(cap: {IMPL_CAP_LINES}). Replace multi-paragraph essay with bullet list of 'what "
            f"landed' (≤15 bullets) + '→ learnings/path.md' pointer."
        )
    if len(block_text) > IMPL_CAP_CHARS:
        issues.append(
            f"FAIL: implementation.md latest session blockquote is {len(block_text)} chars "
            f"(cap: {IMPL_CAP_CHARS}). Even one physical line can violate the budget if it's a "
            f"multi-paragraph essay collapsed; compress to bullet form. Full narrative belongs in "
            f"learnings/, not the spec — spec readers want decisions/rules/landed-state, not prose."
        )
    return issues


def check_coverage_freshness(impl_path: Path) -> list[str]:
    """Warn when an implementation.md coverage matrix has gone stale relative
    to the latest Session Outcome Record.

    ABSENCE-TOLERANT BY DESIGN (P68 / cross-project blast radius): a project
    opts in by placing a `<!-- coverage-synced: S<N> -->` marker in its
    implementation.md. No marker → INFO-skip (every marker-less project's wrap
    is unaffected). Only when the marker EXISTS do we parse the latest session
    from the '## Session Outcome Record (Latest)' block and flag a lag.

    This is the one freshness (vs. size) check in this verifier — added after a
    spec's coverage/plan surface froze for ~49 sessions while the outcome-record
    head stayed current (P62 spec/impl drift; P57 silent-gate). A revise-surface
    with no forcing function rots silently; this makes the lag loud, not absent."""
    if not impl_path.exists():
        return []  # already INFO-reported by check_implementation
    text = impl_path.read_text()
    sync_m = re.search(r"<!--\s*coverage-synced:\s*S(\d+)\s*-->", text)
    if not sync_m:
        return [
            "INFO: implementation.md has no '<!-- coverage-synced: S<N> -->' marker "
            "(skipping coverage-freshness check). Add one beside a coverage/plan matrix "
            "to opt this project in."
        ]
    synced = int(sync_m.group(1))
    # Parse the latest session from the outcome-record block's first session ref.
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.startswith("## Session Outcome Record (Latest)"):
            start = i
            break
    if start is None:
        return [
            "INFO: coverage-synced marker present but no '## Session Outcome Record "
            "(Latest)' header to compare against (skipping coverage-freshness check)."
        ]
    block = "\n".join(lines[start + 1:start + 12])
    sess_m = re.search(r"Session\s+(\d+)|(?<![A-Za-z])S(\d+)\b", block)
    if not sess_m:
        return [
            "INFO: coverage-synced marker present but could not parse a session number "
            "from the latest Session Outcome Record (skipping coverage-freshness check)."
        ]
    current = int(sess_m.group(1) or sess_m.group(2))
    if current > synced:
        return [
            f"FAIL: implementation.md coverage matrix is stale — coverage-synced=S{synced} "
            f"but latest Session Outcome Record=S{current} (lag {current - synced}). "
            f"Reconcile the coverage/build-state matrix and bump the marker to S{current}. "
            f"A perpetually-fresh outcome-record head masks a frozen plan body (P62)."
        ]
    return []


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--strict", action="store_true",
                   help="Exit 1 on any FAIL (default: WARN, exit 0 — incremental adoption).")
    p.add_argument("--registry", type=Path,
                   default=Path.home() / ".claude" / "session-registry.yaml")
    p.add_argument("--project", type=str, default=None,
                   help="Registry project key override (default: derive from cwd; "
                        "'global' for home / OS-meta sessions run from ~ or ~/.claude).")
    p.add_argument("--memory", type=Path, default=None,
                   help="Path to project's MEMORY.md (default: derive from cwd slug, "
                        "or the HOME-dir slug for home / OS-meta sessions).")
    p.add_argument("--implementation", type=Path, default=None,
                   help="Path to active implementation.md (skip if absent).")
    args = p.parse_args()

    cwd = Path.cwd().resolve()
    home = Path.home().resolve()
    claude_dir = home / ".claude"

    # The home / OS-meta "project" is keyed `global` in the registry and its auto-memory
    # lives under the HOME-dir slug — NOT the cwd slug. A home session may run from ~ or
    # from ~/.claude (or a subdir), so cwd.name would otherwise derive the wrong registry
    # key (.claude / <user>, never matching `global`) and, from ~/.claude, the wrong memory
    # slug (…-.claude instead of the HOME slug). Mirror the skill's Step 5 `global`
    # convention, anchored on ~/.claude where OS-meta work definitively happens.
    is_global = cwd == home or cwd == claude_dir or claude_dir in cwd.parents

    if args.project is not None:
        project_basename = args.project
    elif is_global:
        project_basename = "global"
    else:
        project_basename = cwd.name

    if args.memory is None:
        # Slug starts with leading dash because absolute path starts with '/';
        # harness convention preserves the leading dash.
        slug = str(home if is_global else cwd).replace("/", "-")
        args.memory = (
            claude_dir / "projects" / slug / "memory" / "MEMORY.md"
        )

    issues: list[str] = []
    issues += check_registry_parses(args.registry)
    issues += check_label(args.registry, project_basename)
    issues += check_memory(args.memory)
    if args.implementation is not None:
        issues += check_implementation(args.implementation)
        issues += check_coverage_freshness(args.implementation)

    fails = [m for m in issues if m.startswith("FAIL:")]
    for msg in issues:
        prefix = "  ⚠  " if msg.startswith("FAIL:") else "  ·  "
        print(prefix + msg, file=sys.stderr)

    if fails:
        if args.strict:
            print(
                f"\n  → {len(fails)} compression FAIL(s) — wrap aborted (--strict mode).",
                file=sys.stderr,
            )
            return 1
        print(
            f"\n  → {len(fails)} compression FAIL(s) — WARN mode, wrap continues. "
            f"Re-run wrap with --strict (or upgrade Step 7a invocation) to enforce.",
            file=sys.stderr,
        )
        return 0

    targets = ["registry-yaml", "registry-label", "memory"]
    if args.implementation is not None:
        targets.append("implementation.md")
    print(f"OK: wrap-artifact compression invariants hold ({', '.join(targets)}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
