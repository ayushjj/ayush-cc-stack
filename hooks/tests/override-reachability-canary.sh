#!/usr/bin/env bash
# override-reachability-canary.sh
#
# Guards the fix for: every gate hook printed `CLAUDE_X_SKIP=1 git commit ...` as its
# escape hatch and then tested `process.env.CLAUDE_X_SKIP`. A PreToolUse hook is a
# SEPARATE process spawned before the command runs — it inherits Claude Code's
# environment, never the command's inline assignment prefix. So the printed escape
# could not work for any hook, ever, and an agent that hit a gate mid-/wrap had no way
# past it. Several wraps died at the final commit for a human to finish by hand.
#
# This canary asserts the override is REACHABLE (§1-§3) and, just as importantly, that
# it is not reachable by ACCIDENT (§4-§7) — the override direction fails OPEN, so a
# false positive silently disarms a live gate. §8 proves the canary has teeth.
set -uo pipefail

HOOKS="$HOME/.claude/hooks"
LIB="$HOOKS/lib/hook-input.js"
pass=0; fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }

# Evaluate overrideRequested() with a given command, with a CLEAN env (no var set),
# so we are testing the command-parsing path specifically and not the env path.
req() {
  env -u CLAUDE_TEST_SKIP node -e '
    const { overrideRequested } = require(process.argv[1]);
    process.stdout.write(String(overrideRequested("CLAUDE_TEST_SKIP", process.argv[2])));
  ' "$LIB" "$1"
}

# Same, but with the appliesTo:['git'] narrowing the real git-commit gates use.
reqgit() {
  env -u CLAUDE_TEST_SKIP node -e '
    const { overrideRequested } = require(process.argv[1]);
    process.stdout.write(String(overrideRequested("CLAUDE_TEST_SKIP", process.argv[2], { appliesTo: ["git"] })));
  ' "$LIB" "$1"
}

echo "== §1 REACHABLE: a plain inline prefix is honoured =="
[ "$(req 'CLAUDE_TEST_SKIP=1 git commit -m "x"')" = "true" ] \
  && ok "CLAUDE_TEST_SKIP=1 git commit → override" \
  || bad "inline prefix NOT honoured — the whole point of the fix"

echo "== §2 REACHABLE: =true, and stacked with other assignments =="
[ "$(req 'CLAUDE_TEST_SKIP=true git commit')" = "true" ] \
  && ok "=true honoured" || bad "=true not honoured"
[ "$(req 'FOO=bar CLAUDE_TEST_SKIP=1 git commit')" = "true" ] \
  && ok "honoured after a preceding assignment" || bad "stacked assignment missed"

echo "== §3 REACHABLE: after a shell separator =="
[ "$(req 'git add -A && CLAUDE_TEST_SKIP=1 git commit -m x')" = "true" ] \
  && ok "honoured after &&" || bad "not honoured after &&"
[ "$(req 'cd /tmp; CLAUDE_TEST_SKIP=1 git commit')" = "true" ] \
  && ok "honoured after ;" || bad "not honoured after ;"

echo "== §4 NOT BY ACCIDENT: a bare mention is not an override =="
[ "$(req 'grep -n CLAUDE_TEST_SKIP hooks/*.js')" = "false" ] \
  && ok "grepping for the token does NOT disarm the gate" \
  || bad "FAIL-OPEN: merely naming the token disarmed the gate"
[ "$(req 'echo CLAUDE_TEST_SKIP=1')" = "false" ] \
  && ok "assignment with no following command word is not an override" \
  || bad "FAIL-OPEN: dangling assignment counted"

echo "== §5 NOT BY ACCIDENT: quoted text is not shell syntax =="
[ "$(req "git commit -m 'use CLAUDE_TEST_SKIP=1 git commit to override'")" = "false" ] \
  && ok "single-quoted commit message does NOT disarm the gate" \
  || bad "FAIL-OPEN: a commit MESSAGE mentioning the escape disarmed it"
[ "$(req 'git commit -m "CLAUDE_TEST_SKIP=1 git commit"')" = "false" ] \
  && ok "double-quoted message does NOT disarm the gate" \
  || bad "FAIL-OPEN: double-quoted mention counted"

echo "== §6 NOT BY ACCIDENT: heredoc bodies are documentation, not commands =="
# This is the realistic regression: writing the hook's own help text, or a commit
# message that quotes it, through a heredoc.
hd=$'git commit -F - <<\'EOF\'\nOverride with:\n  CLAUDE_TEST_SKIP=1 git commit ...\nEOF'
[ "$(req "$hd")" = "false" ] \
  && ok "terminated heredoc body does NOT disarm the gate" \
  || bad "FAIL-OPEN: heredoc body counted as an override"
hd2=$'cat <<EOF\nCLAUDE_TEST_SKIP=1 git commit\n'
[ "$(req "$hd2")" = "false" ] \
  && ok "UNterminated heredoc body does NOT disarm the gate" \
  || bad "FAIL-OPEN: unterminated heredoc body counted"

echo "== §6b REGRESSION: the six inputs a security review PROVED exploitable =="
# Every one of these returned TRUE against the first implementation, and two were
# demonstrated end-to-end flipping a live hook from exit 2 to exit 0. The canary was
# 13/13 green at the time and caught NONE of them: §6 tested only the two heredoc
# shapes the parser already handled. Each string below is the reviewer's verbatim
# attack input; all must be FALSE.
a1=$'cat > notes.md <<EOF\nGate notes:\n  EOF\nCLAUDE_TEST_SKIP=1 git commit -m x\nEOF\ngit commit -m real'
[ "$(req "$a1")" = "false" ] && ok "SEC-1 indented terminator on << (bash needs col 0)" || bad "SEC-1 REGRESSED — fail-open"
a2=$'cat > d.md <<-EOF\n\tsome doc\n  EOF\nCLAUDE_TEST_SKIP=1 git commit -m x\n\tEOF'
[ "$(req "$a2")" = "false" ] && ok "SEC-2 <<- strips TABS only, not spaces" || bad "SEC-2 REGRESSED — fail-open"
a3=$'cat > d.md <<\x27DOC.md\x27\nCLAUDE_TEST_SKIP=1 git commit\nDOC.md'
[ "$(req "$a3")" = "false" ] && ok "SEC-3 quoted delimiter with non-identifier chars" || bad "SEC-3 REGRESSED — fail-open"
a4=$'cat <<A > f1; cat <<B > f2\nbodyA\nA\nCLAUDE_TEST_SKIP=1 git commit\nB'
[ "$(req "$a4")" = "false" ] && ok "SEC-4 two heredocs on one command line" || bad "SEC-4 REGRESSED — fail-open"
a5=$'cat > d9.txt <<EOF\ndoc\nEOF\r\nCLAUDE_TEST_SKIP=1 git commit\nEOF'
[ "$(req "$a5")" = "false" ] && ok "SEC-5 lone \\r is a JS line terminator, not a bash one" || bad "SEC-5 REGRESSED — fail-open"
# SEC-6 uses reqgit deliberately: the scope narrowing only exists for gates that
# name the program they guard (appliesTo:['git']). check-cd-persistence guards `cd`,
# a shell builtin with no program word, so it stays unscoped by design — and for it
# the wide grant is the correct reading, since the whole command shares one cwd.
[ "$(reqgit 'CLAUDE_TEST_SKIP=1 npm test | tee log && git commit -m x')" = "false" ] \
  && ok "SEC-6 prefix on a sibling command does not ungate git" || bad "SEC-6 REGRESSED — scope over-grant"

echo "== §6c the hardening must not break the shape a wrap actually uses =="
w1=$'CLAUDE_TEST_SKIP=1 git commit -F - <<EOF\nmsg body\nEOF'
[ "$(reqgit "$w1")" = "true" ] && ok "prefix BEFORE a heredoc still overrides" || bad "the real wrap form broke"
[ "$(reqgit 'git add -A && CLAUDE_TEST_SKIP=1 git commit -m x')" = "true" ] \
  && ok "add && prefixed-commit still overrides" || bad "the common commit form broke"

echo "== §7 ENV PATH STILL WORKS (unchanged behaviour) =="
got=$(CLAUDE_TEST_SKIP=1 node -e '
  const { overrideRequested } = require(process.argv[1]);
  process.stdout.write(String(overrideRequested("CLAUDE_TEST_SKIP", "git commit")));
' "$LIB")
[ "$got" = "true" ] && ok "process.env path preserved" || bad "env path REGRESSED"

echo "== §8 TEETH: a mutant that ignores the command must be CAUGHT =="
# Reconstruct the OLD env-only behaviour and assert §1 would fail against it.
mut=$(env -u CLAUDE_TEST_SKIP node -e '
  const oldBehaviour = (v) => process.env[v] === "1";
  process.stdout.write(String(oldBehaviour("CLAUDE_TEST_SKIP")));
')
[ "$mut" = "false" ] \
  && ok "env-only mutant fails §1 — this canary has teeth" \
  || bad "canary is toothless: the old behaviour also passes"

echo "== §9 END-TO-END: the real hooks, executed, with a real stdin payload =="
# The sections above only require() the lib. A security review pointed out that this
# cannot catch a WIRING regression — deleting a hookLib.bypassed(...) call, or the
# review gate's homedir require breaking, restores the original bug with the canary
# still green. These assertions run the actual hook entrypoints.
E2E=$(mktemp -d); trap 'rm -rf "$E2E"' EXIT
git -C "$E2E" init -q 2>/dev/null
git -C "$E2E" config user.email t@t.t; git -C "$E2E" config user.name t
mkdir -p "$E2E/learnings"
printf '### D999 — probe\n' > "$E2E/decisions.md"
printf 'x\n' > "$E2E/learnings/2026-01-01-probe.md"
git -C "$E2E" add -A 2>/dev/null

# Feed a PreToolUse payload and report the hook's exit code.
hook_exit() { # $1=hook path  $2=command string
  printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$2")" \
    | env -u CLAUDE_D_ENTRY_TIMING_WARN_ONLY node "$1" >/dev/null 2>&1; echo $?
}
# env -u: settings.json:6 sets CLAUDE_D_ENTRY_TIMING_WARN_ONLY=1 for every live session (S81,
# owner-approved, b244f70), and this script inherits it — so without the unset the hook is in
# warn mode, nothing can exit 2, and the control + heredoc cases fail for an env reason, not a
# wiring one (hook-review 2026-10-15). Same unset as d-entry-timing-canary.sh:17. Warn mode
# itself is asserted there (WARN_ONLY=1 allows + warning reaches the model).
H="$HOOKS/check-d-entry-timing.js"
ctl="git -C $E2E commit -m probe"
[ "$(hook_exit "$H" "$ctl")" = "2" ] \
  && ok "control: d-entry-timing BLOCKS the wrap-shaped commit (exit 2)" \
  || bad "control did not block — §9 proves nothing (positive control failed)"
[ "$(hook_exit "$H" "CLAUDE_D_ENTRY_TIMING_SKIP=1 $ctl")" = "0" ] \
  && ok "prefixed: the SAME commit passes (exit 0) — override reaches the real hook" \
  || bad "the override does NOT reach the live hook — the original bug is back"
hd9=$'git -C '"$E2E"$' commit -F - <<\'EOF\'\nsee CLAUDE_D_ENTRY_TIMING_SKIP=1 git commit\nEOF'
[ "$(hook_exit "$H" "$hd9")" = "2" ] \
  && ok "a heredoc commit message quoting the escape still BLOCKS" \
  || bad "FAIL-OPEN end-to-end: a doc heredoc disarmed the live hook"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ] || exit 1
