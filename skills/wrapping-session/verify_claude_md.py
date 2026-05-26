#!/usr/bin/env python3
"""Verify global CLAUDE.md compression invariants (wrap-bloat audit follow-up).

Background: by the time the wrap-bloat audit landed, ~/.claude/CLAUDE.md
had grown to ~58KB / ~258 lines despite an earlier compression pilot that
externalized T3 narratives for several paragraph-form principles. The
standing convention ("paragraph-form principles externalize T3 to
~/.claude/principles/") failed to propagate to NEWER principles, which
were added in non-compressed form. Identical P57 manifestation as the
wrap-artifacts case: a rule that lives only as agent-attention-text fails
to fire under context pressure during /wrap.

This verifier is the mechanical enforcement that the convention text
alone couldn't sustain. It also installs a budget governor: the prior
compression mistake row in CLAUDE.md itself flags exactly this risk —
"Compressed a growth-prone persistent file without installing a
growth-rate governor — forward review blind to the bloat pattern." The
wrap-artifacts verifier solved this for MEMORY.md / implementation.md /
session-registry. This verifier solves it for CLAUDE.md.

Default mode: WARN — print diagnostics to stderr, exit 0. Allows a clean
baseline to be established before --strict is wired (target: 3 wraps with
green output).

Strict mode (--strict): exit 1 on any FAIL.

Checks:
  1. File size ≤ 50KB (current cap; tighten after compression deltas land).
  2. Principles count ≤ 70 (current ~60; budget 10 more before forced
     externalization).
  3. Mistake-table rows ≤ 250 chars OR contain a `→ archive` pointer.
     The "→" path admits longer rows when the T3 has been externalized
     to learnings/. The cap targets 1x rows with inline paragraph-T3,
     which is the bloat pattern.
  4. Paragraph-form principles (>600 chars in their entry) MUST contain a
     `→ Full case detail` pointer (the canonical cleavage signature from
     the Phase-1 pilot). Forces the standing convention from day-1 of
     any new entry, not retroactively.

MUST-PRESERVE invariants (NOT enforced — verifier checks size/shape, not
semantics; structural correctness still relies on skill discipline + the
admission rule):
  - The `## Mistake Patterns (Don't Repeat)` heading stays verbatim
    (some hooks may grep for it).
  - The `## Principles (Hard-won — ...)` heading stays verbatim.
  - P-numbers stay stable (cross-references in learnings/ rely on them).
  - The HTML-comment line-1 "Last full first-principles prune: YYYY-MM-DD"
    is consumed by /prune-memory; do not delete or rename.

Usage:
  python verify_claude_md.py [--strict] [--claude-md PATH]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Caps (tunable; tighten as compression lands).
SIZE_CAP_BYTES = 50_000
PRINCIPLE_COUNT_CAP = 70
MISTAKE_ROW_CAP_CHARS = 250
PARAGRAPH_PRINCIPLE_CAP_CHARS = 600  # entries longer than this MUST externalize T3
ARCHIVE_POINTER_PATTERNS = (
    # Any reference to a learnings file (the canonical archive location).
    # Matches "→ `~/.claude/learnings/...", inline `~/.claude/learnings/...`,
    # `~/Desktop/.../learnings/...`, "See learnings/...", etc.
    "learnings/",
    # Externalized T3 worked-example file under principles/.
    "→ `~/.claude/principles/",
    "→ Full case detail",
    # Sub-incident archive references with various punctuation shapes
    # ("Sub-incident archive:", "Sub-incident archive (N incidents):", etc.)
    "Sub-incident archive",
    "Sub-incidents:",
)
EXTERNALIZED_POINTER_PATTERN = "→ Full case detail"  # canonical Phase-1 signature


def check_size(text: str) -> list[str]:
    n = len(text.encode("utf-8"))
    issues: list[str] = []
    if n > SIZE_CAP_BYTES:
        over = n - SIZE_CAP_BYTES
        issues.append(
            f"FAIL: CLAUDE.md is {n} bytes ({over:+d} over {SIZE_CAP_BYTES} cap). "
            f"Compression options: route project-specific principles to project "
            f"CLAUDE.md, externalize T3 narratives to ~/.claude/principles/, "
            f"compress mistake-table 1x rows to T1-only with archive pointers."
        )
    return issues


def check_principle_count(text: str) -> list[str]:
    """Count numbered principles under the Principles heading."""
    m = re.search(r"^## Principles\b", text, re.M)
    if not m:
        return ["INFO: '## Principles' heading not found (skipping count check)"]
    section = text[m.end():]
    nxt = re.search(r"^## ", section, re.M)
    body = section[:nxt.start()] if nxt else section
    # Match lines like "1. ..." through "999. ..." at column 0.
    nums = re.findall(r"^(\d+)\.\s", body, re.M)
    count = len(nums)
    issues: list[str] = []
    if count > PRINCIPLE_COUNT_CAP:
        issues.append(
            f"FAIL: {count} principles in CLAUDE.md (cap: {PRINCIPLE_COUNT_CAP}). "
            f"Budget exceeded — abstract similar-recognition-trigger principles, "
            f"or route domain-specific ones to project CLAUDE.md."
        )
    return issues


def _extract_principles(text: str) -> list[tuple[int, str]]:
    """Return (number, body) for each numbered principle entry."""
    m = re.search(r"^## Principles\b", text, re.M)
    if not m:
        return []
    section = text[m.end():]
    nxt = re.search(r"^## ", section, re.M)
    body = section[:nxt.start()] if nxt else section
    # Split on "^N. " boundaries; capture entry text up to next entry/end.
    entries: list[tuple[int, str]] = []
    matches = list(re.finditer(r"^(\d+)\.\s", body, re.M))
    for i, mm in enumerate(matches):
        start = mm.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        entry_text = body[start:end].rstrip()
        num = int(mm.group(1))
        entries.append((num, entry_text))
    return entries


def check_paragraph_principles(text: str) -> list[str]:
    """Paragraph-form principles with substantial inline T3 narrative MUST
    externalize T3. Heuristic: if entry is >cap chars AND contains
    'Example:' (the canonical T3 marker) AND does NOT have an externalized
    pointer ('→ Full case detail', 'Example: See learnings/'), flag it.

    Phase-1 audit established that not every paragraph-form principle has
    separable T3 — some are T1+T2-only (rule body with multiple detection
    signals / applies-to scopes). Char count alone over-flags those. The
    'Example:' keyword check filters: principles without an inline worked
    example are T1+T2-only and don't need T3 externalization.
    """
    issues: list[str] = []
    violators: list[tuple[int, int]] = []
    for num, body in _extract_principles(text):
        n = len(body)
        if n <= PARAGRAPH_PRINCIPLE_CAP_CHARS:
            continue
        if EXTERNALIZED_POINTER_PATTERN in body:
            continue  # already externalized
        # T3 detection: "Example:" canonical marker, but EXCLUDE "Example: See learnings/"
        # which is the date-grounded fallback shape (T3-by-reference, already externalized).
        idx = body.find("Example:")
        if idx == -1:
            continue  # T1+T2-only paragraph; no T3 to cleave
        post_example = body[idx:]
        if "See learnings/" in post_example or "See `~/" in post_example:
            continue  # date-grounded fallback; already externalized
        # Check whether the inline example is substantial (>100 chars after "Example:").
        if len(post_example) - len("Example:") < 100:
            continue  # micro-example; per Phase-1, micro-examples stay inline
        violators.append((num, n))
    if violators:
        sample = ", ".join(f"P{n}({c}c)" for n, c in violators[:8])
        more = f" (+{len(violators) - 8} more)" if len(violators) > 8 else ""
        issues.append(
            f"FAIL: {len(violators)} paragraph-form principles "
            f"(>{PARAGRAPH_PRINCIPLE_CAP_CHARS} chars + substantial inline T3) lack "
            f"'{EXTERNALIZED_POINTER_PATTERN}' pointer: {sample}{more}. Phase-1 pilot "
            f"convention requires T3 narrative to externalize to ~/.claude/principles/"
            f"PNN-{{slug}}.md when an inline worked example exists; T1+T2 stay inline."
        )
    return issues


def check_mistake_rows(text: str) -> list[str]:
    """Mistake-table rows over char cap must contain an archive pointer."""
    m = re.search(r"^## Mistake Patterns\b", text, re.M)
    if not m:
        return ["INFO: '## Mistake Patterns' heading not found (skipping row check)"]
    section = text[m.end():]
    nxt = re.search(r"^## ", section, re.M)
    body = section[:nxt.start()] if nxt else section
    issues: list[str] = []
    violators: list[tuple[int, int]] = []
    # Match table rows: lines starting with "| " that are NOT header/separator.
    for ln_idx, line in enumerate(body.splitlines(), start=1):
        if not line.startswith("| "):
            continue
        if line.startswith("| Pattern ") or line.startswith("|---") or line.startswith("| ---"):
            continue
        # Pattern column is the first cell after "| ".
        parts = line.split("|")
        if len(parts) < 2:
            continue
        pattern_cell = parts[1].strip()
        n = len(pattern_cell)
        if n > MISTAKE_ROW_CAP_CHARS:
            has_pointer = any(ptn in pattern_cell for ptn in ARCHIVE_POINTER_PATTERNS)
            if not has_pointer:
                # Snippet for diagnostic — first 60 chars.
                snippet = pattern_cell[:60].replace("\n", " ")
                violators.append((n, snippet))
    if violators:
        violators.sort(reverse=True)
        sample = "; ".join(f"{n}c: {s!r}..." for n, s in violators[:5])
        more = f" (+{len(violators) - 5} more)" if len(violators) > 5 else ""
        issues.append(
            f"FAIL: {len(violators)} mistake-table rows over {MISTAKE_ROW_CAP_CHARS} chars "
            f"without archive pointer. Compress to T1+T2 inline + '→ "
            f"learnings/YYYY-MM-DD-{{slug}}-archive.md' pointer (Phase-2 convention). "
            f"Top offenders: {sample}{more}"
        )
    return issues


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--strict", action="store_true",
                   help="Exit 1 on any FAIL (default: WARN, exit 0).")
    p.add_argument("--claude-md", type=Path,
                   default=Path.home() / ".claude" / "CLAUDE.md")
    args = p.parse_args()

    if not args.claude_md.exists():
        print(f"INFO: {args.claude_md} not found — skipping CLAUDE.md check",
              file=sys.stderr)
        return 0

    text = args.claude_md.read_text()

    issues: list[str] = []
    issues += check_size(text)
    issues += check_principle_count(text)
    issues += check_paragraph_principles(text)
    issues += check_mistake_rows(text)

    fails = [m for m in issues if m.startswith("FAIL:")]
    for msg in issues:
        prefix = "  ⚠  " if msg.startswith("FAIL:") else "  ·  "
        print(prefix + msg, file=sys.stderr)

    if fails:
        if args.strict:
            print(
                f"\n  → CLAUDE.md: {len(fails)} compression FAIL(s) — wrap aborted (--strict mode).",
                file=sys.stderr,
            )
            return 1
        print(
            f"\n  → CLAUDE.md: {len(fails)} compression FAIL(s) — WARN mode, wrap continues. "
            f"Re-run with --strict (or upgrade Step 7a invocation) to enforce.",
            file=sys.stderr,
        )
        return 0

    n = len(text.encode("utf-8"))
    m = re.search(r"^## Principles\b", text, re.M)
    pcount = "?"
    if m:
        section = text[m.end():]
        nxt = re.search(r"^## ", section, re.M)
        body = section[:nxt.start()] if nxt else section
        pcount = str(len(re.findall(r"^\d+\.\s", body, re.M)))
    print(f"OK: CLAUDE.md compression invariants hold ({n} bytes, {pcount} principles).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
