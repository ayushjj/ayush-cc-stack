#!/usr/bin/env python3
"""Both-directions tests for verify_claude_md.py.

A compression governor whose failure mode is "allow everything" must be proven to
BLOCK the bad case and PERMIT the good one. Every assertion here comes in that pair.

Coverage is NOT total, and saying otherwise would be the very claim-without-evidence
this file exists to prevent: `check_size`, `check_mistake_rows`, `_split_cells`, the
exit codes, and (since 2026-08-06) both relocation paths of `check_principle_count`
and `check_mistake_rows` are covered. Still NOT covered: the principle COUNT CAP
branch, and `check_paragraph_principles` entirely.

Run: python3 test_verify_claude_md.py
"""
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("v", HERE / "verify_claude_md.py")
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

HEADER = "## Mistake Patterns (Don't Repeat)\n\n| Pattern | Times | Rule | Last |\n|---|---|---|---|\n"
FOOTER = "\n## Next Section\n"


def table(pattern_cell: str, n: int = 1) -> str:
    rows = "".join(f"| {pattern_cell} | 1x | P1 | 2026-01-01 |\n" for _ in range(n))
    return HEADER + rows + FOOTER


def fails(issues):
    return [i for i in issues if i.startswith("FAIL:")]


results = []


def check(name, cond):
    results.append((name, bool(cond)))


# ── row cap: BLOCKS the bad case (ratchet 0 = cap fully enforced) ───────────
long_no_ptr = "x" * (v.MISTAKE_ROW_CAP_CHARS + 50)
check("oversized row without pointer FAILS",
      fails(v.check_mistake_rows(table(long_no_ptr), 0)))

# The mutation test. A pointer must not buy exemption from the length cap.
long_with_ptr = "y" * (v.MISTAKE_ROW_CAP_CHARS + 50) + " → learnings/2026-01-01-x-archive.md"
check("oversized row WITH pointer FAILS (no exemption)",
      fails(v.check_mistake_rows(table(long_with_ptr), 0)))

# ── row cap: PERMITS the good case ──────────────────────────────────────────
check("row under cap passes",
      not fails(v.check_mistake_rows(table("z" * 100), 0)))
check("row under cap with pointer passes",
      not fails(v.check_mistake_rows(table("z" * 100 + " → learnings/a-archive.md"), 0)))

# ── the ratchet: tolerates the seeded backlog, blocks one more ──────────────
check("oversized rows at the ratchet do NOT fail (WARN only)",
      not fails(v.check_mistake_rows(table(long_no_ptr, n=5), 5)))
check("one row past the ratchet FAILS",
      fails(v.check_mistake_rows(table(long_no_ptr, n=6), 5)))
check("ratchet WARN names the count",
      any("5 mistake-table rows" in i for i in v.check_mistake_rows(table(long_no_ptr, n=5), 5)))
check("under the ratchet suggests lowering it",
      any(i.startswith("INFO: ratchet can be lowered")
          for i in v.check_mistake_rows(table(long_no_ptr, n=2), 5)))

# ── fail CLOSED when the heading is renamed away ────────────────────────────
# Renaming the heading is the cheapest way to silence this gate. It must not pass.
check("missing '## Mistake Patterns' heading FAILs",
      fails(v.check_mistake_rows("# nothing here\n", 99)))
# ── relocation guard (2026-08-06 ablation) ─────────────────────────────────
# The entries moved to principles/INDEX.md and evals/mistake-ledger.md, but the
# HEADINGS stayed in CLAUDE.md. That combination made both gates unfalsifiable:
# the section is empty, the count reads 0 <= cap, and the ledger is never opened.
# Proven 2026-08-06 by pointing PRINCIPLES_LEDGER at /nonexistent and still
# getting a clean pass. Each case below asserts BOTH directions.
_real_pl, _real_ml = v.PRINCIPLES_LEDGER, v.MISTAKE_LEDGER
_tmp = Path(tempfile.mkdtemp())


def _ledger(name: str, body: str) -> Path:
    p = _tmp / name
    p.write_text(body, encoding="utf-8")
    return p


EMPTY_PRINCIPLES = "## Principles (Hard-won)\n\nRelocated. Not loaded.\n\n## Next\n"
EMPTY_MISTAKES = "## Mistake Patterns (Don't Repeat)\n\nRelocated. Not loaded.\n\n## Next\n"
MISSING = _tmp / "does_not_exist.md"

healthy_p = _ledger("INDEX.md", "".join(f"{i}. principle {i}\n" for i in range(1, 61)))
gutted_p = _ledger("INDEX_gutted.md", "1. only one left\n")

v.PRINCIPLES_LEDGER = healthy_p
check("empty '## Principles' section + healthy ledger PERMITS",
      not fails(v.check_principle_count(EMPTY_PRINCIPLES)))
v.PRINCIPLES_LEDGER = gutted_p
check("empty '## Principles' section + gutted ledger FAILS (the regression)",
      fails(v.check_principle_count(EMPTY_PRINCIPLES)))
v.PRINCIPLES_LEDGER = MISSING
check("empty '## Principles' section + missing ledger FAILS",
      fails(v.check_principle_count(EMPTY_PRINCIPLES)))
v.PRINCIPLES_LEDGER = healthy_p
check("missing '## Principles' heading + healthy ledger PERMITS (relocation is legal)",
      not fails(v.check_principle_count("# nothing here\n")))
v.PRINCIPLES_LEDGER = MISSING
check("missing '## Principles' heading + missing ledger FAILS",
      fails(v.check_principle_count("# nothing here\n")))
v.PRINCIPLES_LEDGER = _real_pl

healthy_m = _ledger(
    "mistake-ledger.md",
    "| Pattern | Times | Rule | Last |\n|---|---|---|---|\n"
    + "".join(f"| pattern {i} | 1x | P1 | 2026-01-01 |\n" for i in range(1, 41)))
gutted_m = _ledger(
    "mistake-gutted.md",
    "| Pattern | Times | Rule | Last |\n|---|---|---|---|\n"
    "| only one left | 1x | P1 | 2026-01-01 |\n")

v.MISTAKE_LEDGER = healthy_m
check("empty mistake table + healthy ledger PERMITS",
      not fails(v.check_mistake_rows(EMPTY_MISTAKES, 0)))
v.MISTAKE_LEDGER = gutted_m
check("empty mistake table + gutted ledger FAILS (the regression)",
      fails(v.check_mistake_rows(EMPTY_MISTAKES, 0)))
v.MISTAKE_LEDGER = MISSING
check("empty mistake table + missing ledger FAILS",
      fails(v.check_mistake_rows(EMPTY_MISTAKES, 0)))

# Separator-row exclusion. A GFM separator written WITH a space (`| --- |`) matches
# `^\| ` and pre-fix counted as a data row. The only way that defect can HIDE is by
# inflating the count PAST the floor, so pin exactly that: one row below the minimum
# plus a padded separator summed to the floor and passed. It must fail.
padded_m = _ledger(
    "mistake-padded.md",
    "| Pattern | Times | Rule | Last |\n| --- | --- | --- | --- |\n"
    + "".join(f"| pattern {i} | 1x | P1 | 2026-01-01 |\n"
              for i in range(1, v.MISTAKE_LEDGER_MIN)))
v.MISTAKE_LEDGER = padded_m
check("padded separator row is not counted as data (min-1 rows + sep still FAILS)",
      fails(v.check_mistake_rows(EMPTY_MISTAKES, 0)))
v.MISTAKE_LEDGER = _real_ml

check("missing '## Mistake Patterns' heading still FAILs (no relocation claim)",
      fails(v.check_mistake_rows("# nothing here\n", 0)))
check("present heading with a clean row still passes",
      not fails(v.check_mistake_rows(table("z" * 100), 0)))

# ── what the ratchet ACTUALLY guarantees: no NET-new oversized rows ─────────
# It is a count, not an identity set. Swapping one oversized row for a different
# oversized row holds the count and passes. This test exists so nobody re-asserts
# the stronger "no new oversized rows" claim the code does not make.
swapped = HEADER + (
    f"| {'old backlog row ' * 20} | 1x | P1 | 2026-01-01 |\n"
    f"| {'BRAND NEW UNRELATED OVERSIZED ROW ' * 10} | 1x | P2 | 2026-01-01 |\n"
) + FOOTER
check("count-ratchet permits swapping one oversized row for another (documented, not a bug)",
      not fails(v.check_mistake_rows(swapped, 2)))
check("...but a third oversized row FAILs",
      fails(v.check_mistake_rows(swapped.replace(FOOTER, f"| {'x' * 300} | 1x | P3 | 2026-01-01 |\n" + FOOTER), 2)))

# ── malformed row: always FAILs, ratchet or not ─────────────────────────────
piped = "a" * 100 + " `git show <ref>:<path> | grep -n` " + "b" * 100
check("unescaped pipe in a cell FAILS (malformed row)",
      fails(v.check_mistake_rows(table(piped), 99)))

escaped = "a" * 100 + r" `git show <ref>:<path> \| grep -n` " + "b" * 100
check("escaped pipe parses as one cell, under cap, passes",
      not fails(v.check_mistake_rows(table(escaped), 0)))

# An escaped pipe must not hide length past the escape point.
escaped_long = "a" * 200 + r" \| " + "b" * 200
check("escaped pipe: full cell length is measured (oversized FAILS)",
      fails(v.check_mistake_rows(table(escaped_long), 0)))

# ── size ratchet: growth FAILs, the grandfathered backlog only WARNs ────────
check("growth past the ratchet FAILS",
      fails(v.check_size("x" * 101, ratchet=100, cap=100)))
check("at the ratchet, over the target, WARNs but does not FAIL",
      not fails(v.check_size("x" * 100, ratchet=100, cap=50)))
check("over-target WARN is emitted",
      any(i.startswith("WARN:") for i in v.check_size("x" * 100, ratchet=100, cap=50)))
check("under the ratchet suggests lowering it",
      any(i.startswith("INFO: ratchet can be lowered")
          for i in v.check_size("x" * 40, ratchet=100, cap=50)))
check("file under both passes", not fails(v.check_size("x" * 40, ratchet=100, cap=50)))

# ── exit codes: strict blocks, warn does not ────────────────────────────────
with tempfile.TemporaryDirectory() as d:
    bad = Path(d) / "CLAUDE.md"
    bad.write_text("x" * (v.SIZE_RATCHET_BYTES + 1))
    script = str(HERE / "verify_claude_md.py")
    warn = subprocess.run([sys.executable, script, "--claude-md", str(bad)],
                          capture_output=True).returncode
    strict = subprocess.run([sys.executable, script, "--strict", "--claude-md", str(bad)],
                            capture_output=True).returncode
    check("warn mode exits 0 on FAIL", warn == 0)
    check("strict mode exits 1 on FAIL", strict == 1)

    # A minimal VALID CLAUDE.md: both MUST-PRESERVE headings present, one clean row.
    # (A heading-less file now fails closed, so "tiny" is not "good".)
    good = Path(d) / "ok.md"
    good.write_text(table("a clean short row")[:-len(FOOTER)]
                    + "\n## Principles (Hard-won)\n\n1. A principle.\n")
    ok = subprocess.run([sys.executable, script, "--strict", "--claude-md", str(good)],
                        capture_output=True).returncode
    check("strict mode exits 0 on a clean file (permits good case)", ok == 0)

# ── report ─────────────────────────────────────────────────────────────────
passed = sum(1 for _, ok in results if ok)
for name, ok in results:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
