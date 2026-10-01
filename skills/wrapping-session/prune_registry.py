#!/usr/bin/env python3
"""Keep session-registry.yaml bounded. Idempotent; safe to run every wrap.

Invariant: only the newest KEEP_VERBOSE entries per project carry a `next:`
field. /catchup reads the top entry per project verbatim, so historical `next`
values have no reader — in July 2026 they were 68% of a 1.7 MB file.

Archive-not-delete: stripped values are appended to
  ~/.claude/session-registry-next-archive-<today>.yaml
before removal, so nothing is lost and `skill-audit` can still grep history.

Usage:
  python3 prune_registry.py            # prune + archive
  python3 prune_registry.py --check    # exit 1 if pruning is needed, change nothing
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import date

KEEP_VERBOSE = 3
REGISTRY = os.path.expanduser("~/.claude/session-registry.yaml")
PROJECT_RE = re.compile(r"^  ([A-Za-z][\w.-]*):$")
BLOCK_SCALAR_RE = re.compile(r"^      next: *[|>]")


def scan(lines: list[str]) -> tuple[int, list[dict[str, object]]]:
    """Return (kept_count, stripped) without mutating anything.

    Each `stripped` record carries the source line INDEX plus the source lines
    verbatim. Nothing is re-serialized: the registry's own `label:`/`next:`
    lines are already valid YAML scalars, so copying them byte-for-byte is
    both lossless and escaping-free. An earlier version parsed the values out
    and re-encoded them (truncating `label` to 90 chars and wrapping `next` in
    json.dumps), which severed closing quotes on 85% of records and
    double-encoded every `next`. Copy, don't re-encode.
    """
    proj: str | None = None
    n = kept = 0
    stripped: list[dict[str, object]] = []
    label = dt = None
    for i, line in enumerate(lines):
        m = PROJECT_RE.match(line)
        if m:
            proj, n = m.group(1), 0
            continue
        if line.startswith("    - label:"):
            n += 1
            label, dt = line, None          # reset per entry — never inherit
        elif line.startswith("      date:"):
            dt = line
        elif line.startswith("      next:") and proj:
            if n <= KEEP_VERBOSE:
                kept += 1
            else:
                stripped.append({"line": i, "project": proj,
                                 "date": dt, "label": label, "next": line})
    return kept, stripped


def main() -> int:
    # argparse, not `"--check" in sys.argv`: substring membership fails OPEN onto
    # the destructive branch, so `--chek`, `--dry-run` or `-c` would silently
    # rewrite the registry. Unknown flags must be an error on a script whose two
    # modes are "change nothing" and "rewrite the source of truth". Matches the
    # three sibling verifiers in this directory, which all use argparse.
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if pruning is due; change nothing")
    args = ap.parse_args()
    check_only = args.check

    with open(REGISTRY, encoding="utf-8") as f:
        lines = f.read().split("\n")

    # HARD GUARD — refuse to run while block scalars exist. `scan()` is line-based:
    # it records the index of the `next:` KEY line only. A `next: |` block scalar owns
    # every following line indented >6, so removing just the key line orphans the body
    # under `status:` and the registry stops parsing as YAML — silently, because every
    # consumer today reads it line-based. This fired on 2026-07-27: 33 entries / 639
    # lines orphaned, recovered from a backup. Until scan() is span-aware, abort.
    blocks = [i + 1 for i, l in enumerate(lines)
              if BLOCK_SCALAR_RE.match(l)]
    if blocks:
        print(f"ABORT: {len(blocks)} 'next:' block scalars present "
              f"(first at line {blocks[0]}). scan() is line-based and would orphan "
              f"their bodies, breaking YAML. Make scan() span-aware first.",
              file=sys.stderr)
        return 2

    kept, stripped = scan(lines)

    if not stripped:
        print(f"OK: registry bounded — {kept} verbose 'next' fields, "
              f"{os.path.getsize(REGISTRY) // 1024} KB")
        return 0
    if check_only:
        print(f"FAIL: {len(stripped)} historical 'next' fields have no reader. "
              f"Run: python3 {os.path.basename(__file__)}")
        return 1

    archive = os.path.expanduser(
        f"~/.claude/session-registry-next-archive-{date.today()}.yaml")
    new_archive = not os.path.exists(archive)
    # Archive FIRST, and fsync it, so a crash can never leave content stripped
    # from the registry but absent from the archive.
    with open(archive, "a", encoding="utf-8") as f:
        if new_archive:
            f.write(f"# 'next' fields stripped from session-registry.yaml on {date.today()}.\n")
            f.write("# /catchup reads only the top entry per project; these had no reader.\n")
            f.write("# Nothing deleted — source lines copied verbatim, newest-first per project.\n")
            f.write("archived_next:\n")
        for a in stripped:
            f.write(f"  - project: {a['project']}\n")
            for key in ("date", "label", "next"):
                src = a[key]
                if src is not None:                      # verbatim source line
                    f.write(f"    {str(src).strip()}\n")
        f.flush()
        os.fsync(f.fileno())

    before = os.path.getsize(REGISTRY)
    dropped = {a["line"] for a in stripped}
    # Atomic replace — never truncate the live registry in place. A crash or
    # full disk mid-write would otherwise destroy it, and the archive alone
    # cannot rebuild it (kept entries' labels/dates live only in the registry).
    tmp = REGISTRY + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(l for i, l in enumerate(lines) if i not in dropped))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, REGISTRY)
    after = os.path.getsize(REGISTRY)

    print(f"pruned {len(stripped)} 'next' fields -> {os.path.basename(archive)}")
    print(f"registry {before // 1024} KB -> {after // 1024} KB "
          f"({kept} verbose entries kept)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
