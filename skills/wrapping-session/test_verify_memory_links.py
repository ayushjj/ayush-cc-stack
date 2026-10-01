#!/usr/bin/env python3
"""Both-directions tests for verify_memory_links.py.

An anti-drift gate whose failure mode is "allow everything" must be proven to
BLOCK the bad case (dangling pointer, real SPLIT) and PERMIT the good one
(tracked pointer, exempted SPLIT, untracked WARN-not-FAIL). Every assertion
here comes in that pair where the check under test has one.

Coverage: is_real_pointer, check_links, check_split are covered directly
(function-level). Exit-code / mode behavior (--strict vs default, IS_GLOBAL
root/memdir derivation, HOME-prefix resolution) is covered end-to-end via the
CLI (subprocess) because it depends on argparse defaults, cwd, and the HOME
env var that only a fresh process observes correctly.

Fixtures use real (tempdir) git repos: `git init` + `git add` is enough to
make `git ls-files --error-unmatch` report a file as tracked — no commit, no
git identity/config needed, so this file never touches git config (global or
local).

Run: python3 test_verify_memory_links.py
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path
import importlib.util

TARGET_DIR = Path(__file__).resolve().parent
TARGET = TARGET_DIR / "verify_memory_links.py"

spec = importlib.util.spec_from_file_location("vml", TARGET)
vml = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vml)

results = []


def check(name, cond):
    results.append((name, bool(cond)))


def fails(issues):
    return [i for i in issues if i.startswith("FAIL:")]


def untracked(issues):
    return [i for i in issues if i.startswith("UNTRACKED:")]


def newdir() -> Path:
    return Path(tempfile.mkdtemp()).resolve()


def git_init(path: Path):
    subprocess.run(["git", "init", "-q"], cwd=str(path), check=True, capture_output=True)


def git_add(path: Path, rel: str):
    subprocess.run(["git", "add", rel], cwd=str(path), check=True, capture_output=True)


def run_cli(args, env=None, cwd=None):
    return subprocess.run(
        [sys.executable, str(TARGET)] + args,
        capture_output=True, text=True, env=env, cwd=cwd,
    )


# ── is_real_pointer: prose/shorthand tokens are skipped ─────────────────────
check("brace token skipped", not vml.is_real_pointer("{something}.md"))
check("glob-star token skipped", not vml.is_real_pointer("some/*glob*.md"))
check("unicode-ellipsis token skipped", not vml.is_real_pointer("…/07-strategy.md"))
check("ascii-ellipsis token skipped", not vml.is_real_pointer(".../deep/path.md"))
check("bare-name (no slash) token skipped", not vml.is_real_pointer("implementation.md"))
check("http url token skipped", not vml.is_real_pointer("http://example.com/x.md"))
check("https url token skipped", not vml.is_real_pointer("https://example.com/x.md"))
check("space-containing token skipped", not vml.is_real_pointer("some path/with space.md"))
check("legit slash token NOT skipped (contrast)", vml.is_real_pointer("learnings/x.md"))

# ── dangling pointer: FAILs; strict exit 1, warn exit 0 ─────────────────────
root1 = newdir()
git_init(root1)
memdir1 = newdir()
(memdir1 / "MEMORY.md").write_text("See `learnings/gone.md` for detail.\n")

issues = vml.check_links(memdir1, root1)
check("dangling pointer: direct check_links FAILs", fails(issues))

warn = run_cli(["--root", str(root1), "--memory-dir", str(memdir1)])
strict = run_cli(["--strict", "--root", str(root1), "--memory-dir", str(memdir1)])
check("dangling pointer: warn mode exits 0", warn.returncode == 0)
check("dangling pointer: strict mode exits 1", strict.returncode == 1)

# ── pointer resolving at repo root AND git-tracked -> clean, strict exit 0 ──
root2 = newdir()
git_init(root2)
(root2 / "learnings").mkdir()
(root2 / "learnings" / "x.md").write_text("content")
git_add(root2, "learnings/x.md")
memdir2 = newdir()
(memdir2 / "MEMORY.md").write_text("Pointer: `learnings/x.md`\n")

issues = vml.check_links(memdir2, root2)
check("tracked in-root pointer: no FAIL", not fails(issues))
check("tracked in-root pointer: no UNTRACKED", not untracked(issues))

r = run_cli(["--strict", "--root", str(root2), "--memory-dir", str(memdir2)])
check("tracked in-root pointer: strict exit 0", r.returncode == 0)

# ── pointer resolving under root but NOT git-tracked -> UNTRACKED, exit 0 ───
# even under --strict (WARN-only by design, assert this explicitly).
root3 = newdir()
git_init(root3)
(root3 / "learnings").mkdir()
(root3 / "learnings" / "y.md").write_text("content")  # deliberately NOT git-added
memdir3 = newdir()
(memdir3 / "MEMORY.md").write_text("Pointer: `learnings/y.md`\n")

issues = vml.check_links(memdir3, root3)
check("untracked in-root pointer: UNTRACKED present", untracked(issues))
check("untracked in-root pointer: no FAIL", not fails(issues))

r_strict = run_cli(["--strict", "--root", str(root3), "--memory-dir", str(memdir3)])
check("untracked in-root pointer: exit 0 EVEN under --strict (WARN-only by design)",
      r_strict.returncode == 0)

# ── pointer resolving OUTSIDE the project root -> existence-only, clean ─────
# even though the file is untracked (not even inside a git work-tree).
outside_dir = newdir()
outside_file = outside_dir / "external.md"
outside_file.write_text("external content")
root4 = newdir()
git_init(root4)
memdir4 = newdir()
(memdir4 / "MEMORY.md").write_text(f"Pointer: `{outside_file}`\n")

issues = vml.check_links(memdir4, root4)
check("outside-root absolute pointer: no FAIL", not fails(issues))
check("outside-root absolute pointer: no UNTRACKED (existence-only contract)",
      not untracked(issues))

r = run_cli(["--strict", "--root", str(root4), "--memory-dir", str(memdir4)])
check("outside-root absolute pointer: strict exit 0", r.returncode == 0)

# ── ~/-prefixed token resolution: needs a fresh process with HOME overridden
# (Path.home() / the module's HOME constant is read at import time). ────────
fake_home = newdir()
fixture_name = "zz_verify_memory_links_fixture_9f3d.md"
(fake_home / fixture_name).write_text("fixture content")
root5 = newdir()
git_init(root5)
memdir5 = newdir()
(memdir5 / "MEMORY.md").write_text(f"Pointer: `~/{fixture_name}`\n")

env_home = {**os.environ, "HOME": str(fake_home)}
r = run_cli(["--strict", "--root", str(root5), "--memory-dir", str(memdir5)], env=env_home)
check("~/ prefix resolves under overridden HOME: strict exit 0", r.returncode == 0)
check("~/ prefix resolves under overridden HOME: no FAIL in stderr", "FAIL:" not in r.stderr)

# Negative control (falsifiability, P72): point HOME somewhere the fixture file
# does NOT exist -- the same token must now dangle. Proves the positive result
# above is actually driven by HOME resolution, not a tautology.
env_wrong_home = {**os.environ, "HOME": str(root5)}
r_wrong = run_cli(["--strict", "--root", str(root5), "--memory-dir", str(memdir5)], env=env_wrong_home)
check("~/ prefix: WRONG HOME dangles (proves the override matters)",
      r_wrong.returncode == 1 and "FAIL:" in r_wrong.stderr)

# ── SPLIT: both repo-root and memory-dir learnings/ populated -> FAIL ───────
rootS = newdir()
git_init(rootS)
(rootS / "learnings").mkdir()
(rootS / "learnings" / "a.md").write_text("x")
memdirS = newdir()
(memdirS / "learnings").mkdir()
(memdirS / "learnings" / "b.md").write_text("x")

issues = vml.check_split(memdirS, rootS)
check("SPLIT: both populated FAILs", fails(issues))

# ── SPLIT: only one populated -> clean ───────────────────────────────────────
rootS2 = newdir()
git_init(rootS2)
(rootS2 / "learnings").mkdir()
(rootS2 / "learnings" / "a.md").write_text("x")
memdirS2 = newdir()  # no learnings/ dir at all

issues = vml.check_split(memdirS2, rootS2)
check("SPLIT: only one populated -> clean (no FAIL)", not fails(issues))

# ── IS_GLOBAL: root anchors to ~/.claude, memdir anchors to the HOME slug ───
fake_home2 = newdir()
claude_dir2 = fake_home2 / ".claude"
claude_dir2.mkdir(parents=True)
git_init(claude_dir2)
(claude_dir2 / "learnings").mkdir()
(claude_dir2 / "learnings" / "x.md").write_text("content")
git_add(claude_dir2, "learnings/x.md")

slug = str(fake_home2).replace("/", "-")
memdir_g = claude_dir2 / "projects" / slug / "memory"
memdir_g.mkdir(parents=True)
(memdir_g / "MEMORY.md").write_text("Pointer: `learnings/x.md`\n")

env_g = {**os.environ, "HOME": str(fake_home2)}
r = run_cli(["--strict"], env=env_g, cwd=str(claude_dir2))
check("IS_GLOBAL: token resolves CLEAN (root=~/.claude, memdir=HOME slug), strict exit 0",
      r.returncode == 0)
check("IS_GLOBAL: no FAIL in stderr", "FAIL:" not in r.stderr)

# Same fixture, now also populate memdir's learnings/ -> split-exemption path.
(memdir_g / "learnings").mkdir()
(memdir_g / "learnings" / "y.md").write_text("content")  # untracked; irrelevant to split glob

r2 = run_cli(["--strict"], env=env_g, cwd=str(claude_dir2))
check("IS_GLOBAL split-exemption: still strict exit 0 (no SPLIT FAIL)", r2.returncode == 0)
check("IS_GLOBAL split-exemption: no FAIL in stderr", "FAIL:" not in r2.stderr)
check("IS_GLOBAL split-exemption: INFO line present",
      "global project — learnings/ SPLIT check skipped" in r2.stderr)

# ── strict exit 0 on a fully clean fixture (permits the good case) ──────────
root9 = newdir()
git_init(root9)
(root9 / "learnings").mkdir()
(root9 / "learnings" / "clean.md").write_text("x")
git_add(root9, "learnings/clean.md")
memdir9 = newdir()
(memdir9 / "MEMORY.md").write_text("Pointer: `learnings/clean.md`\n")

r = run_cli(["--strict", "--root", str(root9), "--memory-dir", str(memdir9)])
check("fully clean fixture: strict exit 0 (permits good case)", r.returncode == 0)
check("fully clean fixture: OK message printed",
      "OK: MEMORY link integrity holds" in r.stdout)

# ── report ─────────────────────────────────────────────────────────────────
passed = sum(1 for _, ok in results if ok)
for name, ok in results:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
