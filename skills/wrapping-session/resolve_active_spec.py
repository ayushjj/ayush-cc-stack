#!/usr/bin/env python3
"""Resolve the project's ACTIVE spec directory from the files that declare it.

Replaces `for f in specs/*/implementation.md; do ...; break` in the wrap and review
skills. That loop took the FIRST alphabetical match, one directory level deep, so in
a repo with several specs every implementation.md gate checked whichever dormant spec
sorted first — and the singleton verifier passes on a dormant file, so the wrong pick
was silent.

Declarations, in order — only the FIRST declaring line of each file counts, because
archives and past-session blockquotes repeat old declarations below the live one:
  1. MEMORY.md: first line carrying `**Phase**` / `**Phase:**` or `Active spec:`
  2. `docs/IMPLEMENTATION-PLAN.md`: first line carrying `Active spec:`
On that line, `specs/...` tokens are tried left to right and the first that resolves is
the active spec; later specs on the line are context (`T9. context in specs/y/…`). A
token resolves to the nearest directory at or above it (never above `specs/`) holding
`implementation.md`, so `specs/x/learnings/` lands on `specs/x/`.

Exit codes — every non-zero case prints one line to stderr naming what happened:
  0  resolved; stdout = the ABSOLUTE implementation.md path (a MEMORY declaration that
     did not resolve, before the plan's did, is warned on stderr)
  3  no declaration names a spec   -> spec gates skipped
  4  declared, but nothing resolves -> spec gates skipped; the declaration is stale or
     abbreviated (`specs/18-…/`) and should be fixed
3 and 4 are not wrap failures (a gate that false-fails other projects' wraps trains the
bypass), but in a repo that HAS `specs/*/implementation.md` the message is a WARNING
naming how many specs went unchecked.

Run: python3 resolve_active_spec.py [--root DIR] [--memory FILE]
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

DECL_MEMORY = re.compile(r"\*\*Phase:?\*\*|Active spec:")
DECL_PLAN = re.compile(r"Active spec:")
# Greedy: a lazy match stops at the first slash and turns `specs/companies/acme/`
# into `specs/companies/` (caught by the two-level test). Trailing slash optional —
# `specs/x` and `specs/x/implementation.md` are declarations too; resolve() walks up.
# Left boundary: `specs/` inside another path (`~/spec-backups/specs/old/`) is not a declaration.
# `docs/` is OPTIONAL and the lookbehind applies BEFORE it. The original pattern excluded `/`
# immediately before `specs/`, which is exactly the character that precedes it in a `docs/specs/...`
# declaration — so that layout could never produce a token and the resolver reported
# "none declared" forever (S258; [redacted] had been skipping every spec gate since the
# spec was created). The lookbehind still rejects `myspecs/` and `~/specs/`, which is what it is for.
TOKEN = re.compile(r"(?<![\w/.~-])(?:docs/)?specs/[^\s`'\"()\[\],;]+")


def git(cwd: Path, *args: str) -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(cwd), *args], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def repo_root(cwd: Path) -> Path:
    out = git(cwd, "rev-parse", "--show-toplevel")
    return Path(out) if out else cwd


def memory_slug(path: Path) -> str:
    # The harness replaces EVERY non-alphanumeric character, not only `/`:
    # `~/.claude` lives under `-Users-<u>--claude` (verified against ~/.claude/projects).
    return re.sub(r"[^A-Za-z0-9]", "-", str(path.resolve()))


def default_memory(root: Path) -> Path:
    projects = Path.home() / ".claude" / "projects"
    mem = projects / memory_slug(root) / "memory" / "MEMORY.md"
    if mem.is_file():
        return mem
    # A linked worktree has its own toplevel but shares the MAIN checkout's memory.
    common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if common:
        main_mem = projects / memory_slug(Path(common).parent) / "memory" / "MEMORY.md"
        if main_mem.is_file():
            return main_mem
    return mem


NO_SPEC = re.compile(r"no active spec", re.I)


def _first_line(path: Path, decl: re.Pattern[str]) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return next((line for line in text.splitlines() if decl.search(line)), "")


def candidates(path: Path, decl: re.Pattern[str]) -> list[str]:
    # sentence punctuation after an unquoted path: `specs/x.` / `specs/x:`
    return [t.rstrip(".:") for t in TOKEN.findall(_first_line(path, decl))]


# Both layouts are real and neither is wrong: some repos keep `specs/` at the root, others nest it
# under `docs/`. Hardcoding the first made this resolver return "none declared" FOREVER in the
# second — and because a skipped gate is silent, that reads identically to "this project has no
# active spec". Measured 2026-09-16 (S258): [redacted] declares
# `docs/specs/06-po-push-notifications/` and every spec-specific wrap gate had been skipping since
# the spec was created. The containment check is still load-bearing — it is what stops a declaration
# line from pointing the gates at an arbitrary path — so it is widened, not removed.
SPEC_ROOTS = ("specs", "docs/specs")


def resolve(root: Path, token: str) -> Path | None:
    here = (root / token).resolve()
    for rel in SPEC_ROOTS:
        specs = (root / rel).resolve()
        if not str(here).startswith(str(specs) + "/"):
            continue
        cur = here
        while cur != specs:
            impl = cur / "implementation.md"
            if impl.is_file():
                return impl
            cur = cur.parent
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n", 1)[0])
    ap.add_argument("--root", type=Path, default=None)
    ap.add_argument("--memory", type=Path, default=None)
    args = ap.parse_args(argv)

    root = (args.root or repo_root(Path.cwd())).resolve()
    memory = args.memory or default_memory(root)
    plan = root / "docs" / "IMPLEMENTATION-PLAN.md"
    sources = [(memory, candidates(memory, DECL_MEMORY)), (plan, candidates(plan, DECL_PLAN))]
    unresolved: list[str] = []
    for path, tokens in sources:
        for token in tokens:
            impl = resolve(root, token)
            if impl is not None:
                if unresolved:
                    print(
                        f"active spec: WARNING — {', '.join(unresolved)} did not resolve; "
                        f"used {path.name}'s declaration instead. Fix the stale line.",
                        file=sys.stderr,
                    )
                print(impl)  # absolute: callers may run from a subdirectory
                return 0
        unresolved.extend(tokens)

    n_specs = len(list((root / "specs").glob("**/implementation.md")))
    # A declaring line that SAYS "no active spec" is a deliberate statement, not a slip.
    said_none = any(NO_SPEC.search(_first_line(f, d)) for f, d in ((memory, DECL_MEMORY), (plan, DECL_PLAN)))
    if said_none:
        n_specs = 0
    level = "WARNING — " if n_specs else ""
    unchecked = f" ({n_specs} spec(s) with implementation.md go unchecked)" if n_specs else ""
    if not unresolved:
        where = "" if memory.is_file() else f", MEMORY.md not found at {memory}"
        print(f"active spec: {level}none declared{where}; spec gates skipped{unchecked}", file=sys.stderr)
        return 3
    print(
        f"active spec: {level}declared {', '.join(dict.fromkeys(unresolved))} but no "
        f"implementation.md resolves; spec gates skipped{unchecked}. Fix the Phase / Active spec line.",
        file=sys.stderr,
    )
    return 4


if __name__ == "__main__":
    sys.exit(main())
