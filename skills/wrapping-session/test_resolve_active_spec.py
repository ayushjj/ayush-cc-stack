#!/usr/bin/env python3
"""Both-directions tests for resolve_active_spec.py.

The resolver replaced a first-alphabetical glob that picked a dormant spec silently.
So every case here asserts WHICH file is picked, never just "something was picked",
and the positive control proves the old glob would have picked a different one.

Run: python3 test_resolve_active_spec.py   (also under /usr/bin/python3 — 3.9)
"""
from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGET = HERE / "resolve_active_spec.py"

passed = failed = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {detail}")


def repo(tmp: Path, specs: list[str], memory: str, plan: str | None = None) -> tuple[Path, Path]:
    root = tmp / "repo"
    for s in specs:
        (root / s).mkdir(parents=True, exist_ok=True)
        (root / s / "implementation.md").write_text("# impl\n")
    (root / "specs").mkdir(parents=True, exist_ok=True)
    if plan is not None:
        (root / "docs").mkdir(exist_ok=True)
        (root / "docs" / "IMPLEMENTATION-PLAN.md").write_text(plan)
    mem = tmp / "MEMORY.md"
    mem.write_text(memory)
    return root, mem


def run(root: Path, mem: Path) -> tuple[int, str, str]:
    p = subprocess.run(
        [sys.executable, str(TARGET), "--root", str(root), "--memory", str(mem)],
        capture_output=True, text=True,
    )
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def case(name, specs, memory, want_rc, want_out="", plan=None, want_err=""):
    with tempfile.TemporaryDirectory() as t:
        root, mem = repo(Path(t), specs, memory, plan)
        rc, out, err = run(root, mem)
        want = str((root / want_out).resolve()) if want_out else ""
        check(f"{name}: rc", rc == want_rc, f"(got {rc}, err={err!r})")
        check(f"{name}: stdout", out == want, f"(got {out!r})")
        if want_err:
            check(f"{name}: stderr names it", want_err in err, f"(got {err!r})")


print("== picks the DECLARED spec, not the first alphabetical one ==")
case("phase line wins over glob order",
     ["specs/dormant-spec", "specs/master-identity"],
     "- **Phase**: `specs/master-identity/` T9.\n", 0, "specs/master-identity/implementation.md")
# positive control: the replaced loop picks the dormant one in the same layout
with tempfile.TemporaryDirectory() as t:
    root, _ = repo(Path(t), ["specs/dormant-spec", "specs/master-identity"], "")
    old = subprocess.run(
        "for f in specs/*/implementation.md; do [ -f \"$f\" ] && echo \"$f\" && break; done",
        shell=True, cwd=root, capture_output=True, text=True, executable="/bin/bash",
    ).stdout.strip()
    check("control: old glob picks the dormant spec here", old == "specs/dormant-spec/implementation.md", f"(got {old!r})")

print("== two-level paths ==")
case("companies/<co>/ resolves", ["specs/companies/acme", "specs/aaa"],
     "- **Phase**: `specs/companies/acme/` ledger\n", 0, "specs/companies/acme/implementation.md")

print("== token inside a spec walks up to the spec ==")
case("learnings subdir -> parent spec", ["specs/18-pilot"],
     "- **Phase**: see `specs/18-pilot/learnings/` notes\n", 0, "specs/18-pilot/implementation.md")

print("== fallback to IMPLEMENTATION-PLAN Active spec ==")
case("plan line used when MEMORY has none", ["specs/aaa", "specs/zzz"],
     "# memory without a phase\n", 0, "specs/zzz/implementation.md",
     plan="> **Status**: x. Active spec: `specs/zzz/` (impl.md S1).\n")
case("MEMORY beats plan", ["specs/aaa", "specs/zzz"],
     "- **Phase**: `specs/aaa/`\n", 0, "specs/aaa/implementation.md",
     plan="Active spec: `specs/zzz/`\n")

print("== no declaration -> skip (exit 3), not a pick ==")
case("phase line says no active spec", ["specs/aaa"],
     "- **Phase**: no active spec. prod redeploying\n", 3, want_err="none declared")
with tempfile.TemporaryDirectory() as tt:
    r_, m_ = repo(Path(tt), ["specs/aaa"], "- **Phase**: no active spec. prod redeploying\n")
    check("explicit 'no active spec' is NOT a WARNING", "WARNING" not in run(r_, m_)[2])
case("token on a NON-declaration line is ignored", ["specs/aaa"],
     "- [link](specs/aaa/design.md) reference only\n", 3, want_err="none declared")

print("== declared but unresolvable -> loud skip (exit 4) ==")
case("abbreviated token", ["specs/18-pilot"],
     "- **Phase**: pilot `specs/18-…/`. D71\n", 4, want_err="specs/18-…/")
case("stale token, dir gone", ["specs/aaa"],
     "- **Phase**: `specs/renamed-away/`\n", 4, want_err="specs/renamed-away/")
case("spec dir without implementation.md", [],
     "- **Phase**: `specs/design-only/`\n", 4, want_err="design-only")

print("== declaration shapes the first version missed ==")
case("no trailing slash", ["specs/x"], "- **Phase**: specs/x T9\n", 0, "specs/x/implementation.md")
case("file token", ["specs/x"], "- **Phase**: see specs/x/implementation.md\n", 0, "specs/x/implementation.md")
case("sentence full stop", ["specs/x"], "- **Phase**: working in specs/x.\n", 0, "specs/x/implementation.md")
case("same spec named twice is not ambiguous", ["specs/x"],
     "- **Phase**: `specs/x/` T9, see specs/x/design.md\n", 0, "specs/x/implementation.md")
case("first spec on the line is the active one; later specs are context", ["specs/x", "specs/y"],
     "- **Phase**: `specs/x/` T9. D-CR7 context in `specs/y/decisions.md`\n", 0, "specs/x/implementation.md")

print("== only the FIRST declaring line counts (archives repeat old declarations) ==")
case("old Phase bullet below the live one is ignored", ["specs/live", "specs/old"],
     "- **Phase**: `specs/live/` T9\n- archive: **Phase** was `specs/old/`\n", 0, "specs/live/implementation.md")
case("plan: first Active spec line wins over old blockquotes", ["specs/live", "specs/old"],
     "# no phase\n", 0, "specs/live/implementation.md",
     plan="> Status. Active spec: `specs/live/`\n\n> S98. Active spec: `specs/old/`\n> S97. Active spec: `specs/old/`\n")
case("bold with the colon inside", ["specs/x"], "- **Phase:** `specs/x/` T9\n", 0, "specs/x/implementation.md")
case("specs/ inside another path is not a declaration", ["specs/live", "specs/old"],
     "- **Phase**: `specs/live/` T3 (backup at ~/spec-backups/specs/old/)\n", 0, "specs/live/implementation.md")

print("== fall-through and skips are LOUD in a repo that has specs ==")
case("stale MEMORY falls to plan WITH a warning", ["specs/planned"],
     "- **Phase**: `specs/renamed-away/`\n", 0, "specs/planned/implementation.md",
     plan="Active spec: `specs/planned/`\n", want_err="specs/renamed-away/")
case("no declaration but specs exist -> WARNING names the count", ["specs/a", "specs/b"],
     "# nothing\n", 3, want_err="WARNING")

print("== never escapes specs/ ==")
case("dot-dot token", ["specs/aaa"],
     "- **Phase**: `specs/../`\n", 4)

print("== default MEMORY location (the path the skills actually run) ==")
def sh(cwd, *a):
    return subprocess.run(list(a), cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()

with tempfile.TemporaryDirectory() as t:
    t = Path(t).resolve()
    home = t / "home"
    root = t / "my.repo"            # a dot: the slug must map it to `-`, like `~/.claude`
    (root / "specs/live").mkdir(parents=True); (root / "specs/live/implementation.md").write_text("x")
    (root / "specs/aaa").mkdir(parents=True); (root / "specs/aaa/implementation.md").write_text("x")
    sh(root, "git", "init", "-q")
    sh(root, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base")
    # Every non-alphanumeric char -> `-` (tmp paths carry `_` as well as `.`). The rule is
    # anchored to real data by the on-disk control below, not only to this fixture.
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(root))
    memdir = home / ".claude" / "projects" / slug / "memory"
    memdir.mkdir(parents=True)
    (memdir / "MEMORY.md").write_text("- **Phase**: `specs/live/`\n")
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"}

    def cli(cwd):
        p = subprocess.run([sys.executable, str(TARGET)], cwd=cwd, env=env, capture_output=True, text=True)
        return p.returncode, p.stdout.strip(), p.stderr.strip()

    rc, out, err = cli(root)
    check("slug with a dot finds MEMORY", rc == 0 and out == str(root / "specs/live/implementation.md"), f"(rc={rc} out={out!r} err={err!r})")
    (root / "sub").mkdir()
    rc, out, err = cli(root / "sub")
    check("run from a subdirectory -> absolute path", rc == 0 and Path(out).is_file(), f"(rc={rc} out={out!r})")

    wt = t / "wt"
    sh(root, "git", "worktree", "add", "-q", "--detach", str(wt))
    (wt / "specs/live").mkdir(parents=True, exist_ok=True); (wt / "specs/live/implementation.md").write_text("x")
    rc, out, err = cli(wt)
    check("linked worktree falls back to the main checkout's MEMORY", rc == 0 and out == str(wt / "specs/live/implementation.md"), f"(rc={rc} out={out!r} err={err!r})")

    (memdir / "MEMORY.md").unlink()
    rc, out, err = cli(root)
    check("missing MEMORY says so, not just 'none declared'", rc == 3 and "MEMORY.md not found" in err, f"(rc={rc} err={err!r})")

print("== slug rule vs the harness's REAL project directories (independent of this file) ==")
import importlib.util
spec = importlib.util.spec_from_file_location("ras", TARGET)
ras = importlib.util.module_from_spec(spec); spec.loader.exec_module(ras)
real = Path.home() / ".claude" / "projects"
dot_home = Path.home() / ".claude"
if real.is_dir() and (real / ras.memory_slug(dot_home)).is_dir():
    check("memory_slug(~/.claude) names an existing harness dir (dot -> '-')", True)
    naive = str(dot_home).replace("/", "-")
    check("control: the slash-only slug does NOT exist there", not (real / naive).is_dir(), f"({naive})")
else:
    print("  skip on-disk control: no ~/.claude/projects entry for ~/.claude on this machine")

print()
print(f"passed {passed}, failed {failed}")
sys.exit(1 if failed else 0)
