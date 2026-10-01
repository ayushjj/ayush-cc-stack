#!/usr/bin/env python3
"""Verify MEMORY.md / MEMORY-archive.md link integrity (anti-drift gate).

Background: a project's auto-memory files accumulate file-pointers over many
sessions — session-delta `→ learnings/...md` links, a Memory Files index of
`feedback_*.md` / `project_*.md` nodes, and `docs/` / `reference/` / `specs/`
cross-refs. Three drift modes rot these silently:

  1. RELOCATION DRIFT — the repo moves (e.g. Desktop→dev) and every relative
     pointer that crossed the moved boundary now resolves to a dead path.
     A whole session's worth of `../../../../desktop/<proj>/learnings/...`
     pointers went stale this way and no wrap/catchup caught them for weeks.
  2. ORPHAN SPLIT — a learnings file lands in the *memory-dir* `learnings/`
     while the project's canonical home is *repo-root* `learnings/` (or vice
     versa). The lone stray is unreachable by the convention's resolver.
  3. MISSING-PREFIX TYPO — a pointer drops a path segment the file actually
     lives under (e.g. `specs/.../x.md` when the file is `<notes-dir>/specs/.../x.md`).

All three present as the same symptom: a pointer that does not resolve. This
gate makes them loud at wrap time instead of surfacing as a stale link weeks
later (P57: bake the check into a step that already runs — don't rely on an
agent remembering to audit).

THE CORRECTNESS BIT (P42, learned the hard way): a link check must resolve the
FULL token by its OWN prefix convention. A tail-only / base-blind resolver
(grabbing just `learnings/x.md` out of `~/.claude/learnings/x.md`) produces BOTH
false alarms AND false all-clears. The per-prefix resolver below is the fix.

Resolution conventions (mirrors /catchup SKILL.md Step 1.5 + the memory-file
index layout):
  ~/...            -> $HOME-relative
  /...             -> absolute
  projects/...     -> ~/.claude-relative (cross-project / global memory)
  ../...           -> memory-dir-relative
  has '/' else     -> PROJECT REPO ROOT (learnings/ docs/ reference/ specs/)
  bare name        -> memory-dir (feedback_*.md / project_*.md / reference_*.md nodes)

Scope: the CURRENT project only (repo root = `git rev-parse --show-toplevel`,
memory dir = that root's harness slug). A wrap is per-project; it must not fail
project A's wrap because project B has drift.

Modes: --strict exits 1 on any FAIL; default is WARN (exit 0, diagnostics only).
ENFORCING since 2026-07-09: wrap Step 7a invokes --strict before the project
commit. (The prior "wire in after 3 consecutive clean wraps" activation was the
same unreachable condition that left verify_claude_md.py dead for 66 days —
a gate can't wait for the backlog it exists to prevent to clear itself.)

POINTER HYGIENE (category rule, learned from the 2026-07-09 backlog sweep): never
link `~/.claude/plans/*` plan-mode artifacts from MEMORY files — they are ephemeral
by design and were 6 of the 14 dangling pointers found across all projects.

Checks:
  1. DANGLING — every `.md` pointer in MEMORY.md + MEMORY-archive.md resolves.
     Skips shorthand/prose tokens (containing { } * ... \\ space, or http...).
  2. SPLIT — if BOTH repo-root `learnings/` and memory-dir `learnings/` hold
     .md files, the minority location is likely orphaned; consolidate to the
     canonical (majority) one. Fires ONLY on genuine coexistence, so a project
     that canonically uses the memory-dir (repo-root empty) does NOT trip it.
  3. UNTRACKED (WARN-only, S47 §3) — a pointer that resolves on disk but whose
     file is NOT git-tracked in its work-tree: present locally, DEAD on any fresh
     clone. Scoped by CONTAINMENT — checked only when the file resolves INSIDE the
     project root (which, for the home/global project, IS ~/.claude); refs resolving
     outside root keep pure-existence semantics.

Usage:
  python verify_memory_links.py [--strict] [--root PATH] [--memory-dir PATH]
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
CLAUDE = HOME / ".claude"

# markdown-link target  ](path.md)  OR  backtick token  `path.md`
TOKEN_RE = re.compile(r"\]\(([^)\s]+\.md)\)|`([^`\s]+\.md)`")
# tokens that are shorthand / prose / non-resolvable, not real local pointers.
# Includes both ASCII '...' and the Unicode ellipsis '…' (U+2026) — prose uses
# both to abbreviate a path (e.g. `…/07-strategy.md`, `~/.claude/.../x.md`).
SKIP_SUBSTR = ("{", "}", "*", "...", "…", "\\")


def project_root(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit.resolve()
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        if out:
            return Path(out).resolve()
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    return Path.cwd().resolve()


def memory_dir_for(root: Path, explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit.resolve()
    slug = str(root).replace("/", "-")  # harness convention; leading '/' -> leading '-'
    return CLAUDE / "projects" / slug / "memory"


def candidate_paths(token: str, memdir: Path, root: Path) -> list[Path]:
    """Plausible on-disk locations a pointer could resolve to, by prefix.

    Anchored prefixes (~/, /, projects/, ../) have ONE unambiguous base — this
    keeps relocation-drift strict: a stale `../../../../desktop/<proj>/...`
    resolves to exactly one (dead) path and is correctly flagged.

    Ambiguous relative slash-tokens (learnings/ docs/ reference/ specs/ memory/
    <notes-dir>/...) vary by project convention — some are repo-root-relative,
    some are written relative to the harness project dir (e.g. `memory/x.md`
    points INTO the memory folder). Try all plausible bases; a file reachable at
    ANY of them is not 'dangling'. Genuinely-gone files exist at none and still
    flag. (The orphan-SPLIT case — a learnings file present but in the wrong
    one of two dirs — is caught separately by check_split, not here.)"""
    if token.startswith("~/"):
        return [HOME / token[2:]]
    if token.startswith("/"):
        return [Path(token)]
    if token.startswith("projects/"):
        return [CLAUDE / token]
    if token.startswith("../"):
        return [(memdir / token).resolve()]
    # repo-root | memory-dir | harness-project-dir (parent of memory/)
    return [root / token, memdir / token, memdir.parent / token]


def git_tracked(path: Path) -> bool | None:
    """True if `path` is git-tracked in its work-tree; False if inside a work-tree but
    untracked; None if not inside any work-tree (or git unavailable) — in which case we do
    NOT flag (can't prove dead-on-clone, so don't false-alarm). Queries the CANONICAL path
    (path.resolve()) so a symlinked directory component can't make `ls-files --error-unmatch`
    miss a genuinely-tracked file and raise a false UNTRACKED."""
    p = path.resolve()
    try:
        top = subprocess.run(
            ["git", "-C", str(p.parent), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    if not top:
        return None
    try:
        subprocess.run(
            ["git", "-C", top, "ls-files", "--error-unmatch", str(p)],
            capture_output=True, text=True, check=True,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def _under(root: Path, p: Path) -> bool:
    """Is `p` inside the project work-tree `root`? Canonical compare (resolves symlinks and
    macOS /var↔/private/var so containment isn't defeated by a non-canonical component)."""
    try:
        rp, rr = p.resolve(), root.resolve()
        return rp == rr or rr in rp.parents
    except OSError:
        return False


def resolve_status(token: str, memdir: Path, root: Path) -> tuple[str, Path | None]:
    """('dangling', None) | ('tracked', hit) | ('untracked', hit).

    'untracked' = the file EXISTS on disk but is not git-tracked in its work-tree, so the
    pointer is DEAD on any fresh clone (S47 §3: project-repo learnings ride manual `git add`
    and are easily left unstaged). Scoped by CONTAINMENT — only pointers resolving UNDER the
    project `root` ride the clone; refs resolving outside it keep pure-existence semantics.
    NOT a `~/`/`/` prefix test: the home/global project's own repo IS ~/.claude, so a
    `~/.claude/…` hit there is in-repo and MUST be tracked-checked (the prefix form silently
    exempted exactly that case). When a token resolves under more than one base, the verdict
    is 'tracked' if ANY in-repo copy is tracked — order-independent, so a first-exists pick
    can't misattribute the verdict to the wrong same-name sibling."""
    existing = [p for p in candidate_paths(token, memdir, root) if p.exists()]
    if not existing:
        return ("dangling", None)
    in_repo = [p for p in existing if _under(root, p)]
    if not in_repo:
        return ("tracked", existing[0])   # all copies external to the project repo → existence is the contract
    for p in in_repo:
        if git_tracked(p) is True:
            return ("tracked", p)
    return ("untracked", in_repo[0])


def is_real_pointer(token: str) -> bool:
    """A checkable pointer: an explicit local path (contains '/'), not prose
    shorthand or an external/ambiguous ref.

    SCOPE NOTE (deliberate, low-false-positive): only tokens with a '/' are
    checked. The three drift modes this gate prevents — relocation
    (`../../../../desktop/<proj>/learnings/x.md`), orphan-split (`learnings/x.md`),
    and missing-prefix-typo (`specs/.../x.md`) — ALL contain a slash, so nothing
    on the target classes is lost. Bare names (no slash) are EITHER memory-dir
    node-index files (`feedback_x.md`, governed by /prune-memory) OR prose
    shorthand (`implementation.md`, a repo-root top-level doc) — both ambiguous
    to resolve and high-false-positive, so out of scope here."""
    if token.startswith(("http://", "https://")):
        return False
    if " " in token or "/" not in token:
        return False
    return not any(s in token for s in SKIP_SUBSTR)


def check_links(memdir: Path, root: Path) -> list[str]:
    issues: list[str] = []
    checked = 0
    for name in ("MEMORY.md", "MEMORY-archive.md"):
        fp = memdir / name
        if not fp.exists():
            continue
        for lineno, line in enumerate(fp.read_text().splitlines(), 1):
            for m in TOKEN_RE.finditer(line):
                token = m.group(1) or m.group(2)
                if not is_real_pointer(token):
                    continue
                checked += 1
                status, hit = resolve_status(token, memdir, root)
                if status == "dangling":
                    issues.append(
                        f"FAIL: {name}:{lineno} dangling pointer `{token}` "
                        f"(file exists at no plausible base — repo-root, memory-dir, or "
                        f"project-dir). Fix the path, relocate the file to its canonical "
                        f"dir, or remove the link."
                    )
                elif status == "untracked":
                    issues.append(
                        f"UNTRACKED: {name}:{lineno} `{token}` exists on disk ({hit}) but is "
                        f"NOT git-tracked in its work-tree — the pointer is DEAD on any fresh "
                        f"clone. `git add` the file (or remove the link)."
                    )
    if checked == 0 and not issues:
        issues.append("INFO: no resolvable .md pointers found in MEMORY files (nothing to check).")
    return issues


def check_split(memdir: Path, root: Path) -> list[str]:
    root_l = list((root / "learnings").glob("*.md")) if (root / "learnings").is_dir() else []
    mem_l = list((memdir / "learnings").glob("*.md")) if (memdir / "learnings").is_dir() else []
    if root_l and mem_l:
        canonical = "repo-root" if len(root_l) >= len(mem_l) else "memory-dir"
        minority = "memory-dir" if canonical == "repo-root" else "repo-root"
        n_min = len(mem_l) if minority == "memory-dir" else len(root_l)
        return [
            f"FAIL: learnings/ SPLIT — repo-root has {len(root_l)} file(s), memory-dir has "
            f"{len(mem_l)}. The {minority} ({n_min} file(s)) are likely orphans; consolidate "
            f"to the canonical {canonical} learnings/ (the majority). A lone file in the "
            f"non-canonical dir is unreachable by the pointer convention."
        ]
    return []


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--strict", action="store_true",
                   help="Exit 1 on any FAIL (default: WARN, exit 0 — incremental adoption).")
    p.add_argument("--root", type=Path, default=None,
                   help="Project repo root (default: git toplevel, else cwd).")
    p.add_argument("--memory-dir", type=Path, default=None,
                   help="Project memory dir (default: derive from root's harness slug).")
    args = p.parse_args()

    root = project_root(args.root)

    # Global / OS-meta sessions (mirrors verify_wrap_artifacts.py's is_global —
    # P51: these siblings drifted once already). The home project's work-tree IS
    # ~/.claude (so `learnings/x.md` tokens resolve there), but its auto-memory
    # lives under the HOME-dir slug, NOT the ~/.claude slug. Without this, a run
    # from ~/.claude derives a memory dir that doesn't exist and silently
    # INFO-skips (a dead gate); a run from ~ uses root=$HOME and manufactures
    # dangling-pointer false alarms. Explicit --root/--memory-dir always win.
    cwd = Path.cwd().resolve()
    home = HOME.resolve()
    claude_dir = CLAUDE.resolve()
    is_global = args.root is None and (
        root in (home, claude_dir)
        or cwd == home or cwd == claude_dir or claude_dir in cwd.parents
    )
    if is_global:
        root = claude_dir
        if args.memory_dir is None:
            args.memory_dir = CLAUDE / "projects" / str(home).replace("/", "-") / "memory"

    memdir = memory_dir_for(root, args.memory_dir)

    if not memdir.is_dir():
        print(f"  ·  INFO: no auto-memory dir at {memdir} (skipping link check).", file=sys.stderr)
        return 0

    issues = check_links(memdir, root)
    if is_global:
        # For the global project BOTH learnings/ locations are canonical by design
        # (memory-dir = harness user-memory learnings; ~/.claude/learnings/ = OS
        # archives), so the majority/minority orphan heuristic is invalid there.
        issues.append("INFO: global project — learnings/ SPLIT check skipped "
                      "(both locations are canonical by design).")
    else:
        issues += check_split(memdir, root)
    fails = [m for m in issues if m.startswith("FAIL:")]
    untracked = [m for m in issues if m.startswith("UNTRACKED:")]
    for msg in issues:
        warn = msg.startswith("FAIL:") or msg.startswith("UNTRACKED:")
        print(("  ⚠  " if warn else "  ·  ") + msg, file=sys.stderr)

    if untracked:
        # WARN-only BY DESIGN (S47 §3), even under --strict: this gate runs BEFORE the
        # project commit, and the wrap's own commit step may legitimately stage the file
        # it flags — failing here would false-positive on exactly the normal flow. If
        # this class keeps shipping dead-on-clone pointers, the correct promotion point
        # is a POST-commit re-check, not this pre-commit one.
        print(
            f"\n  → {len(untracked)} UNTRACKED pointer(s): present locally but not git-tracked "
            f"→ dead on any clone. `git add` them. (WARN-only; not blocking.)",
            file=sys.stderr,
        )

    if fails:
        if args.strict:
            print(f"\n  → {len(fails)} link FAIL(s) — wrap aborted (--strict mode).", file=sys.stderr)
            return 1
        print(
            f"\n  → {len(fails)} link FAIL(s) — WARN mode, wrap continues. "
            f"Re-run with --strict (or upgrade the Step 7a invocation) to enforce.",
            file=sys.stderr,
        )
        return 0

    if not untracked:
        print(f"OK: MEMORY link integrity holds (all pointers resolve and are git-tracked; no learnings/ split).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
