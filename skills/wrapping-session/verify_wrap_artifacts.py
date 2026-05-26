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

Default mode: WARN — print diagnostic to stderr, exit 0. Allows
incremental adoption: first wraps may have legitimate reasons to exceed
caps if a session was unusually complex; the WARN gives diagnostic without
blocking the wrap.

Strict mode (--strict): exit 1 on any FAIL. Wire in once shapes prove
stable (target: 3 consecutive clean wraps).

Checks:
  1. session-registry top label ≤300 chars (cap: lenient initial; tighten
     to ≤200 if drift returns).
  2. MEMORY.md Current State block ≤30 non-blank lines (everything between
     '## Current State' and the next '## ' heading).
  3. implementation.md latest session blockquote ≤30 lines (between
     '## Session Outcome Record (Latest)' and '### Prior Sessions').

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
            f"Compress to a 3-12 word summary + '→ learnings/path.md' pointer when a learnings "
            f"file exists. Full session narrative belongs in learnings/, not the label — "
            f"label is read for grep-fodder, not as prose. Verbose `next` field is fine; "
            f"that one /catchup reads verbatim."
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
            f"(cap: {MEMORY_CAP_LINES}). Replace narrative paragraph with: 1 Phase line + 1 Next "
            f"line + last-3 session-delta lines + Memory Files index."
        )
    if len(block_text) > MEMORY_CAP_CHARS:
        issues.append(
            f"FAIL: MEMORY.md Current State block is {len(block_text)} chars "
            f"(cap: {MEMORY_CAP_CHARS}). Even one physical line can violate the budget if it's a "
            f"multi-paragraph essay collapsed; compress to bullet form. Full narrative belongs "
            f"in learnings/{{date}}-session{{N}}-*.md (auto-loaded via /catchup default mode). "
            f"MEMORY.md auto-loads as `claudeMd` every session — bytes-tax compounds."
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


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--strict", action="store_true",
                   help="Exit 1 on any FAIL (default: WARN, exit 0 — incremental adoption).")
    p.add_argument("--registry", type=Path,
                   default=Path.home() / ".claude" / "session-registry.yaml")
    p.add_argument("--memory", type=Path, default=None,
                   help="Path to project's MEMORY.md (default: derive from cwd slug).")
    p.add_argument("--implementation", type=Path, default=None,
                   help="Path to active implementation.md (skip if absent).")
    args = p.parse_args()

    cwd = Path.cwd().resolve()
    project_basename = cwd.name
    project_slug = str(cwd).replace("/", "-")

    if args.memory is None:
        # Slug starts with leading dash because absolute path starts with '/';
        # harness convention preserves the leading dash.
        args.memory = (
            Path.home() / ".claude" / "projects" / project_slug
            / "memory" / "MEMORY.md"
        )

    issues: list[str] = []
    issues += check_label(args.registry, project_basename)
    issues += check_memory(args.memory)
    if args.implementation is not None:
        issues += check_implementation(args.implementation)

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

    targets = ["registry-label", "memory"]
    if args.implementation is not None:
        targets.append("implementation.md")
    print(f"OK: wrap-artifact compression invariants hold ({', '.join(targets)}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
