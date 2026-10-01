#!/usr/bin/env python3
r"""Verify global CLAUDE.md compression invariants (wrap-bloat audit follow-up).

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
  1. File size may not GROW: bytes ≤ SIZE_RATCHET_BYTES (seeded at the size on
     the day enforcement was switched on; lowered whenever the file shrinks;
     never raised). Being above the softer SIZE_CAP_BYTES target only WARNs.
     A static cap is a ceiling and licenses growth up to it; the invariant is
     that always-loaded tokens go DOWN, which is a ratchet.
  2. Principles count ≤ 70 (current ~60; budget 10 more before forced
     externalization).
  3. Mistake-table rows ≤ 250 chars — UNCONDITIONALLY. An archive pointer
     no longer exempts a row from the cap; it only changes the failure
     message. An "≤ cap OR has a pointer" rule is unreachable for exactly
     the rows that need it, because every oversized row acquires a pointer.
     Compress per governance.md's mistake-row template: T1 trigger + T2 fix
     stay inline, the T3 narrative goes to the archive (append it there BEFORE
     trimming the row — archives drift stale behind the rows that point at them).
     Pre-existing oversized rows are tolerated up to MISTAKE_ROW_MAX_VIOLATIONS
     (a ratchet, seeded at the COUNT on the day enforcement was switched on,
     lowered as rows are compressed, never raised).

     Precisely what the ratchet enforces: **the number of oversized rows may not
     increase.** It is a count, not an identity set — it does not fingerprint
     WHICH rows are grandfathered, so retiring one oversized row and adding a
     different oversized row in the same wrap passes. Do not read this as "no new
     oversized rows"; it is "no net-new oversized rows". Stating the stronger
     claim would be a guarantee the code does not make (P72).

     Seeding at today's count is what makes --strict reachable on day one instead
     of "after the backlog is cleared" — the condition under which a gate is never
     switched on at all.
  3b. Mistake-table rows must have exactly 4 columns. A literal `|` inside a
     cell must be escaped `\|` — GFM requires it even inside code spans, and
     an unescaped pipe silently starts a new column, hiding both the row's
     true length and its archive pointer from check 3.
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
SIZE_CAP_BYTES = 50_000  # the target; being above it WARNs, it does not block
# Ratchet: the file's size on the day enforcement was switched on. It may only ever
# DECREASE. Growth past it FAILs, so adding a line now requires removing one — which
# is the governance rule ("authored within budget from keystroke one") made mechanical.
# A static cap is a ceiling and permits growth up to it; the stated invariant is that
# always-loaded tokens go DOWN. Lower this each time the file shrinks.
SIZE_RATCHET_BYTES = 10_041  # lowered 2026-08-26 (S230: mistake-ledger row count DROPPED from the router — three definitions disagree (37 active / +8 post-ablation / 51 by this file's own counter), so no canonical quantity to state; same call as the checklist rule count. Mutation-proven to still bite at +45 bytes); 2026-08-25 (S67: research-artifact template + the mistake-heading rename-protection relocated to governance.md, paying the skill-mandated fan-out authorization AND netting 92 bytes); 2026-08-25 (S66: P42/P72 firing dates relocated to governance.md, paying the subagent-delegation line); 2026-08-22 (tool-routing + browser-testing rationale relocated to governance.md, paying a sibling session's unpaid expansion); 2026-08-22 from 10_170; 2026-08-21 from 10_174; 2026-08-12 from 10_433; 2026-08-06 from 37_110 by the ablation
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
MISTAKE_TABLE_COLUMNS = 4  # | Pattern | Times | Rule | Last |
# Ratchet: rows already over the cap when enforcement was switched on. This number
# may only ever DECREASE — lower it each time a row is compressed. Adding a new
# oversized row pushes the count past the ratchet and fails the wrap. Seeding it at
# the current count is what makes --strict reachable today; a gate that can only be
# switched on after the backlog is cleared never gets switched on.
MISTAKE_ROW_MAX_VIOLATIONS = 0

# --- Relocation ledgers (ablation 2026-08-06) -----------------------------
# The Principles and Mistake-Patterns sections were moved OUT of the always-loaded
# CLAUDE.md into these non-loaded stores. The entry caps existed to protect
# always-loaded tokens; content that is never loaded needs no cap, so the ledgers
# are uncapped by design. What still needs protection is CLAUDE.md RE-growth —
# that is SIZE_RATCHET_BYTES, which is the real gate now.
#
# P72 falsifiability: a missing heading no longer SKIPS the check, it REDIRECTS it.
# Deleting the heading was the old cheapest way to silence the gate; now doing so
# requires the entries to genuinely exist in the ledger. This check still FAILs on
# the exact input the old one guarded against (heading gone AND content gone), and
# PASSes only on a real relocation.
_CLAUDE_DIR = Path(__file__).resolve().parents[2]
PRINCIPLES_LEDGER = _CLAUDE_DIR / "principles" / "INDEX.md"
MISTAKE_LEDGER = _CLAUDE_DIR / "evals" / "mistake-ledger.md"
PRINCIPLE_LEDGER_MIN = 55   # 60 relocated on 2026-08-06; a ratchet, never raised
MISTAKE_LEDGER_MIN = 30     # 36 relocated on 2026-08-06


def _check_relocated(ledger: Path, entry_re: str, minimum: int,
                     label: str, heading: str) -> list[str]:
    """CLAUDE.md carries no entries (heading missing, or present but empty) —
    verify the content was MOVED to the ledger, not deleted."""
    if not ledger.exists():
        return [f"FAIL: {heading} and the relocation ledger {ledger} does not exist. "
                f"The {label} were deleted, not relocated. Restore the entries or "
                f"create the ledger."]
    try:
        entries = re.findall(entry_re, ledger.read_text(encoding="utf-8"), re.M)
    except OSError as e:                                    # pragma: no cover
        return [f"FAIL: cannot read relocation ledger {ledger}: {e}"]
    if len(entries) < minimum:
        return [f"FAIL: {heading} and {ledger.name} holds only {len(entries)} {label} "
                f"(expected >= {minimum}). Content was lost in relocation."]
    return [f"INFO: {label} relocated to {ledger.name} ({len(entries)} entries) — "
            f"not loaded into context by design."]


def check_size(text: str, ratchet: int | None = None, cap: int | None = None) -> list[str]:
    """Growth past the ratchet FAILs. Being above the target cap only WARNs."""
    if ratchet is None:
        ratchet = SIZE_RATCHET_BYTES
    if cap is None:
        cap = SIZE_CAP_BYTES
    n = len(text.encode("utf-8"))
    issues: list[str] = []
    how = ("Compression options: route project-specific principles to project "
           "CLAUDE.md, externalize T3 narratives to ~/.claude/principles/, "
           "compress mistake-table rows to T1 + archive pointer (append the "
           "narrative to the archive BEFORE trimming the row).")
    if n > ratchet:
        issues.append(
            f"FAIL: CLAUDE.md is {n} bytes ({n - ratchet:+d} past the ratchet of "
            f"{ratchet}). The file may not grow. To add a line, remove one. {how}"
        )
    elif n > cap:
        issues.append(
            f"WARN: CLAUDE.md is {n} bytes ({n - cap:+d} over the {cap} target, but "
            f"within the {ratchet} ratchet). {how}"
        )
    if n < ratchet:
        issues.append(f"INFO: ratchet can be lowered — set SIZE_RATCHET_BYTES = {n}.")
    return issues


def check_principle_count(text: str) -> list[str]:
    """Count numbered principles under the Principles heading."""
    m = re.search(r"^## Principles\b", text, re.M)
    if not m:
        # Fail CLOSED unless the entries provably moved. A silent skip would mean
        # renaming the heading disables the check forever while --strict still
        # reports a clean pass; redirecting to the ledger keeps it falsifiable.
        return _check_relocated(PRINCIPLES_LEDGER, r"^(\d+)\.\s",
                                PRINCIPLE_LEDGER_MIN, "principles",
                                "'## Principles' heading is missing")
    section = text[m.end():]
    nxt = re.search(r"^## ", section, re.M)
    body = section[:nxt.start()] if nxt else section
    # Match lines like "1. ..." through "999. ..." at column 0.
    nums = re.findall(r"^(\d+)\.\s", body, re.M)
    count = len(nums)
    if count == 0:
        # The 2026-08-06 ablation moved the entries to principles/INDEX.md but LEFT
        # the heading in place. Without this branch the check reads 0 <= cap and
        # passes while the ledger is never opened — a gate that is green for the
        # wrong reason and cannot fail (P72). An empty section is a relocation
        # claim; verify it like one.
        return _check_relocated(PRINCIPLES_LEDGER, r"^(\d+)\.\s",
                                PRINCIPLE_LEDGER_MIN, "principles",
                                "'## Principles' section is empty")
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


def _split_cells(line: str) -> list[str] | None:
    """Split a GFM table row on UNESCAPED pipes; return its interior cells.

    A literal '|' inside a cell must be written '\\|'. An unescaped one opens a
    new column, so a naive line.split("|") reads a truncated first cell — which
    under-reports the row's length and loses any pointer sitting past the pipe.
    Returns None when the line is not a table row.
    """
    s = line.strip()
    if not s.startswith("|"):
        return None
    cells: list[str] = []
    buf: list[str] = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            buf.append("|")
            i += 2
            continue
        if ch == "|":
            cells.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    cells.append("".join(buf).strip())
    # A well-formed row opens and closes with '|', producing empty edge cells.
    if cells and cells[0] == "":
        cells.pop(0)
    if cells and cells[-1] == "":
        cells.pop()
    return cells


def check_mistake_rows(text: str, max_violations: int | None = None) -> list[str]:
    """Rows must be ≤ cap (pointer grants no exemption) and have 4 columns.

    Oversized rows are tolerated up to `max_violations` (the ratchet) and reported
    as WARN; exceeding it is a FAIL. Malformed rows always FAIL.
    """
    if max_violations is None:
        max_violations = MISTAKE_ROW_MAX_VIOLATIONS
    m = re.search(r"^## Mistake Patterns\b", text, re.M)
    if not m:
        # Fail CLOSED — see check_principle_count. A renamed heading is the single
        # highest-leverage way to silence this gate; it must not pass --strict.
        return ["FAIL: '## Mistake Patterns' heading not found — the row cap and "
                "column checks cannot run. Restore the heading verbatim."]
    section = text[m.end():]
    nxt = re.search(r"^## ", section, re.M)
    body = section[:nxt.start()] if nxt else section
    heading_line = text[:m.start()].count("\n") + 1
    issues: list[str] = []
    violators: list[tuple[int, str, bool]] = []
    malformed: list[tuple[int, int, str]] = []
    data_rows = 0
    for offset, line in enumerate(body.splitlines(), start=1):
        if not line.startswith("| "):
            continue
        if line.startswith("| Pattern ") or line.startswith("|---") or line.startswith("| ---"):
            continue
        cells = _split_cells(line)
        if cells is None:
            continue
        data_rows += 1
        if len(cells) != MISTAKE_TABLE_COLUMNS:
            malformed.append((heading_line + offset, len(cells),
                              line.strip()[2:62].replace("\n", " ")))
            continue
        pattern_cell = cells[0]
        n = len(pattern_cell)
        if n > MISTAKE_ROW_CAP_CHARS:
            has_pointer = any(p in pattern_cell for p in ARCHIVE_POINTER_PATTERNS)
            violators.append((n, pattern_cell[:60].replace("\n", " "), has_pointer))
    if data_rows == 0:
        # Same hole as check_principle_count: the 2026-08-06 ablation moved the rows
        # to evals/mistake-ledger.md but left the heading, so every row-level check
        # below iterates an empty table and reports clean. MISTAKE_LEDGER was defined
        # for this and never wired. Exclude both tables' header rows from the count;
        # this is a deletion floor, not an exact census.
        # The `-{2,}` alternative excludes GFM separator rows written WITH a space
        # after the pipe (`| --- | --- |`). The live ledger happens to use `|---|`,
        # which never matches `^\| ` at all — but that is a formatting accident, and
        # one auto-formatter pass would silently inflate the count and weaken the
        # very floor this branch exists to enforce. Mirrors the sibling loop above,
        # which already excludes both `|---` and `| ---`.
        return _check_relocated(
            MISTAKE_LEDGER, r"^\| (?!-{2,}|Pattern \| Times|Row \| Enforcing)",
            MISTAKE_LEDGER_MIN, "mistake rows",
            "'## Mistake Patterns' table is empty")
    if malformed:
        sample = "; ".join(f"CLAUDE.md:{ln} ({c} cols): {s!r}..." for ln, c, s in malformed[:3])
        issues.append(
            f"FAIL: {len(malformed)} mistake-table row(s) without exactly "
            f"{MISTAKE_TABLE_COLUMNS} columns — an unescaped '|' inside a cell "
            f"(a pipe in a URL, regex, or shell example counts). Escape it as '\\|' "
            f"(GFM requires this even inside `code spans`); an unescaped pipe hides "
            f"the row's real length from the cap check. Offenders: {sample}"
        )
    if violators:
        violators.sort(reverse=True)
        sample = "; ".join(f"{n}c: {s!r}..." for n, s, _ in violators[:3])
        more = f" (+{len(violators) - 3} more)" if len(violators) > 3 else ""
        n_ptr = sum(1 for _, _, p in violators if p)
        detail = (
            f"{len(violators)} mistake-table rows over {MISTAKE_ROW_CAP_CHARS} chars "
            f"({n_ptr} already carry an archive pointer — a pointer does NOT exempt a row "
            f"from the cap). Compress per governance.md's row template: T1 trigger + "
            f"T2 fix inline, T3 narrative to '→ learnings/YYYY-MM-DD-{{slug}}-archive.md' "
            f"(append it to the archive BEFORE trimming the row — archives drift stale). "
            f"Top offenders: {sample}{more}"
        )
        if len(violators) > max_violations:
            issues.append(
                f"FAIL: {detail} This exceeds the ratchet of {max_violations} — compress a "
                f"row, or you are adding sediment faster than you drain it."
            )
        else:
            issues.append(f"WARN: {detail}")
            if len(violators) < max_violations:
                issues.append(
                    f"INFO: ratchet can be lowered — set MISTAKE_ROW_MAX_VIOLATIONS "
                    f"= {len(violators)} (currently {max_violations})."
                )
    elif max_violations > 0:
        issues.append(
            f"INFO: no oversized rows — set MISTAKE_ROW_MAX_VIOLATIONS = 0 to lock it in."
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

    # Explicit encoding: the byte ratchet counts UTF-8 bytes, so a locale-dependent
    # decode here would silently miscount the multi-byte glyphs (— → ≠ ∩) this file
    # is full of.
    text = args.claude_md.read_text(encoding="utf-8")

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
