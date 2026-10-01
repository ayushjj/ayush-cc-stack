#!/usr/bin/env python3
"""Regression canary for /hook-review 2026-08-21's three defects.

WHY A CANARY AND NOT A NOTE
  All three defects were live for weeks while every existing suite stayed green, because
  no suite asserted what a hook must NOT block. A guard is only specified by both
  directions: the cases it fires on AND the cases it must stay silent for.

WHY EVERY SECTION HAS MUST-BLOCK CASES
  The cheapest way to "fix" a false positive is to weaken the detector until it fires on
  nothing. That passes a MUST-PASS-only suite perfectly. The MUST-BLOCK half is the
  positive control (P72) — it is what makes this file able to fail.

  Learned the hard way while writing the fix: the first run of this harness reported
  24/24 green with the guard entirely dead, because the shell exported
  CLAUDE_CD_PERSISTENCE_SKIP=1 and every child node process inherited it. Hence the
  scrubbed env below and the LEAK SENTINEL that runs first.
"""
import json, os, shutil, subprocess, sys, tempfile

# CANARY_HOOKS_DIR points the canary at a COPY (mutation runs); without it a mutated copy
# silently tests the live hooks.
HOOKS = os.environ.get("CANARY_HOOKS_DIR") or os.path.expanduser("~/.claude/hooks")
CD_HOOK = os.path.join(HOOKS, "check-cd-persistence.js")
EF_HOOK = os.path.join(HOOKS, "check-eval-first.js")
# The project hook lives OUTSIDE ~/.claude and its path names a real repo, so it is read
# from the gitignored .canary-paths instead of being hardcoded here — published copies of
# this file then carry no project name. Absent/unset => the branch-guard block below prints
# a VISIBLE skip. It must never look like a pass: an unrun check is not a passed check.
def _canary_path(key):
    f = os.path.expanduser("~/.claude/.canary-paths")
    if not os.path.exists(f):
        return ""
    for line in open(f):
        line = line.split("#", 1)[0].strip()
        if line.startswith(key + "="):
            return os.path.expanduser(line.split("=", 1)[1].strip())
    return ""

BG_HOOK = os.environ.get("CANARY_BRANCH_GUARD") or _canary_path("BRANCH_GUARD")

# Every escape valve scrubbed: a valve inherited from the caller's shell silences the
# hook under test and turns this whole file into theatre.
ENV = {k: v for k, v in os.environ.items() if not k.startswith(
    ("CLAUDE_CD_PERSISTENCE", "CLAUDE_EVAL_FIRST", "IP_ALLOW_BRANCH_OP"))}

passed = failed = skipped = 0


def report(ok, got, want, label):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ok   {got:<7} {label}")
    else:
        failed += 1
        print(f"  FAIL {got:<7} want={want:<7} {label}")


def run_hook(argv, command, cwd=None):
    p = subprocess.run(argv, input=json.dumps({"tool_input": {"command": command}}),
                       text=True, capture_output=True, cwd=cwd, env=ENV)
    return p.returncode, p.stderr


# --- LEAK SENTINEL --------------------------------------------------------------
# If a skip valve is still reaching the child, the canonical violation exits 0 and
# every MUST-PASS case below would pass for the wrong reason. Abort rather than report.
code, _ = run_hook(["node", CD_HOOK], "cd rel && ls")
if code != 2:
    print("CONTROL FAILED: `cd rel` did not block — a skip valve is leaking into the")
    print("child process, so every result in this file would be meaningless. Aborting.")
    sys.exit(2)
print("control: `cd rel` blocks — no valve leaking\n")

# --- check-cd-persistence.js ----------------------------------------------------
print("check-cd-persistence.js — MUST BLOCK (relative cd genuinely leaks cwd):")
for label, cmd in [
    ("bare relative",            "cd pitch && ls"),
    ("nested relative",          "cd _ayush-notes/specs/02 && grep x y"),
    ("quoted relative",          'cd "pitch" && ls'),
    ("var resolving to relative", "W=pitch; cd $W && ls"),
    ("var with no assignment",   "cd $UNKNOWNVAR && ls"),
    ("var computed at runtime",  "W=$(pwd)/x; cd $W && ls"),
    ("relative after &&",        "echo hi && cd sub && ls"),
    ("dot-relative",             "cd ./scripts && ls"),
    ("parent-relative",          "cd ../sibling && ls"),
    # A subshell assignment never reaches the parent shell, so it must NOT resolve the var.
    # Found by /review on this very diff: resolving against the raw command let this pass
    # as "absolute" while the real cd lands elsewhere.
    ("var assigned only in a subshell", "(W=/abs); cd $W && ls"),
    # Shared resolver (lib resolveAssignedVars, 2026-09-15): the LAST standalone assignment
    # BEFORE the cd wins. The hook's old first-match-anywhere regex allowed both of these.
    ("reassigned to relative before cd", "W=/abs; W=rel; cd $W && ls"),
    ("assigned only AFTER the cd",       "cd $W && ls; W=/abs"),
    ("assignment inside a comment",      "# W=/abs\ncd $W && ls"),
    # Review of that change (2026-09-15, correctness + adversarial): an assignment the shell
    # may SKIP must not resolve — the var keeps its earlier relative value.
    ("conditional && assignment",        "W=sub; false && W=/abs; cd $W && ls"),
    ("test-guarded assignment",          "D=build; [ -d /repo/build ] && D=/repo/build; cd $D"),
    ("|| assignment",                    "W=rel; true || W=/abs; cd $W"),
    ("if/then assignment over relative", "W=rel\nif false; then\nW=/abs\nfi\ncd $W"),
    ("conditional inside nested var",    "S=rel; false && S=/abs; R=$S/x; cd $R"),
    ("backtick reassignment with space", "W=/abs; W=`echo rel`; cd $W"),
    # Quote-blind subshell stripping deleted real code between a quoted `(` and `)`.
    ("quoted parens hide a real cd",     'grep -n "foo(" a.py; cd sub; grep -n ")" b'),
    ("quoted parens hide reassignment",  'W=/abs; echo "(" ; W=rel; echo ")"; cd $W'),
]:
    code, _ = run_hook(["node", CD_HOOK], cmd)
    report(code == 2, str(code), "2", label)

print("\ncheck-cd-persistence.js — MUST NOT BLOCK (measured false positives):")
for label, cmd in [
    ("bare absolute",              "cd /abs/path && ls"),
    ("QUOTED absolute",            'cd "/private/tmp/x/scratch" && sed -i s/a/b/ f'),
    ("single-quoted absolute",     "cd '/abs/path' && ls"),
    ("quoted tilde",               'cd "~/foo" && ls'),
    ("quoted $HOME",               'cd "$HOME/x" && ls'),
    ("var resolving to absolute",  "W=/srv/work/app-1; cd $W && bundle exec rspec"),
    ("quoted var + suffix",        'S=/private/tmp/s; cd "$S/hf" && ffmpeg -i a b'),
    ("braced var",                 "W=/abs/p; cd ${W} && ls"),
    # Nested literal assignments resolve recursively in the shared resolver; the old
    # hook refused any value containing `$` and blocked this absolute cd.
    ("var built from another var", 'S=/private/tmp/s; R="$S"/sub; cd "$R" && ls'),
    ("exported var",               "export W=/abs/p; cd $W && ls"),
    # Offsets from findCdArgs index into `stripped` (subshells removed); resolving against
    # the raw command with them would land before the assignment and block this safe cd.
    ("subshell earlier, then abs var", "(cd rel && ls); W=/abs/p; cd $W && ls"),
    # Only assignments BEFORE the cd count — pins that a later relative one is ignored.
    ("later relative reassignment ignored", "W=/abs; cd $W && ls; W=rel"),
    ("unconditional assignment after &&",   "W=/abs && cd $W && ls"),
    ("quoted parens, real subshell after",  'echo "(" ; (cd rel && ls); W=/abs/p; cd $W'),
    ("cd inside a grep PATTERN",   "grep -n 'cd \\$' file.js"),
    ("cd inside quoted prose",     'echo "run cd foo first"'),
    ("cd -",                       "cd - && ls"),
    ("bare tilde",                 "cd ~ && ls"),
    ("subshell relative",          "(cd rel && ls)"),
    ("git -C instead of cd",       "git -C scripts log"),
    ("word merely ending in cd",   "abcd foo && ls"),
]:
    code, _ = run_hook(["node", CD_HOOK], cmd)
    report(code == 0, str(code), "0", label)

# --- check-eval-first.js --------------------------------------------------------
def eval_first_verdict(files):
    d = tempfile.mkdtemp()
    try:
        subprocess.run(["git", "-C", d, "init", "-q"], check=True)
        for f in files:
            p = os.path.join(d, f)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w").write("x\n")
        subprocess.run(["git", "-C", d, "add", "-A"], check=True)
        _, err = run_hook(["node", EF_HOOK], "git commit -m x", cwd=d)
        return "WARN" if "EVAL-FIRST" in err else "silent"
    finally:
        shutil.rmtree(d, ignore_errors=True)

print("\ncheck-eval-first.js — a test-SHAPED directory is not a test:")
for want, label, files in [
    ("WARN",   "THE FAIL-OPEN CASE: tests/ dir, zero real tests", ["app.py", "tests/README.md"]),
    ("WARN",   "spec/ dir holding only a fixture",       ["app.rb", "spec/fixtures/data.yml"]),
    ("WARN",   "test/ dir holding only a note",          ["app.js", "test/notes.md"]),
    ("WARN",   "no tests at all (positive control)",     ["app.py"]),
    ("WARN",   "_latest_ file is NOT a test (old bug)",  ["app.rb", "app/views/_latest_enquiries.html.erb"]),
    ("silent", "real pytest file",                       ["app.py", "tests/test_app.py"]),
    ("silent", "real rspec file",                        ["app.rb", "spec/models/user_spec.rb"]),
    ("silent", "real jest file",                         ["app.ts", "src/app.test.ts"]),
    ("silent", "jest __tests__ convention",              ["app.ts", "__tests__/app.tsx"]),
    ("silent", "go test",                                ["app.go", "pkg/thing_test.go"]),
    ("silent", "shell canary suite",                     ["hook.js", "hooks/tests/x-canary.sh"]),
    ("silent", "docs-only commit is never gated",        ["README.md"]),
]:
    got = eval_first_verdict(files)
    report(got == want, got, want, label)

# --- branch-guard.sh (project hook; skipped if the repo is absent) --------------
if os.path.exists(BG_HOOK):
    print("\nbranch-guard.sh — pathspec restores are not branch mutations:")
    for want, label, cmd in [
        (2, "plain checkout of a branch",       "git checkout master"),
        (2, "checkout -b",                      "git checkout -b feature/x origin/master"),
        (2, "git switch",                       "git switch production"),
        (2, "worktree add",                     "git worktree add ../wt feature/x"),
        (2, "FAIL-OPEN TRAP: -- appears later", 'git checkout main && echo "-- done"'),
        (2, "FAIL-OPEN TRAP: after semicolon",  'git checkout main; echo " -- restored"'),
        (2, "FAIL-OPEN TRAP: after a pipe",     'git checkout main | tee " -- log"'),
        (0, "restore one file",                 "git checkout -- Gemfile.lock"),
        (0, "restore then chain",               "git checkout -- Gemfile.lock && git status --short"),
        (0, "restore with redirect",            "git checkout -- Gemfile.lock 2>/dev/null; echo hi"),
        (0, "restore everything",               "git checkout -- ."),
        (0, "restore from a tree-ish",          "git checkout origin/master -- config/routes.rb"),
        (0, "unrelated git command",            "git status --short"),
    ]:
        code, _ = run_hook(["bash", BG_HOOK], cmd)
        report(code == want, str(code), str(want), label)
else:
    # An unrun check is not a passed check — and a printed line is not an assertion.
    # These 13 never reach report(), so without this counter `passed`/`failed` and the
    # exit code are byte-identical to a full green run (measured: 54/0 exit 0 skipped
    # vs 67/0 exit 0 complete). /hook-review and the .sh wrapper read the exit code.
    skipped += 13
    _cfg = os.path.expanduser("~/.claude/.canary-paths")
    if os.path.exists(_cfg):
        # Config present but unusable: a typo'd key, an empty value, or a path that
        # has moved. That is never a legitimate skip — fail loudly, like the LEAK
        # SENTINEL above, rather than degrading to a green run.
        print(f"\nERROR: {_cfg} exists but yielded no usable BRANCH_GUARD "
              f"(got {BG_HOOK!r}) — 13 branch-guard assertions could not run.")
        print(f"\nRESULT: {passed} passed, {failed} failed, {skipped} SKIPPED")
        sys.exit(2)
    print("\nskipped: branch-guard.sh (no ~/.claude/.canary-paths — set BRANCH_GUARD=<path> to enable)")

print(f"\nRESULT: {passed} passed, {failed} failed, {skipped} SKIPPED")
sys.exit(1 if failed else 0)
