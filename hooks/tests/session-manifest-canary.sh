#!/usr/bin/env bash
# session-manifest-canary.sh — canary for the S46 per-session wrap staging stack.
#
# Covers:
#   1. session-manifest.js record/stage/claim/prune against a throwaway repo,
#      piping REAL stdin JSON (P72: test the channel production uses).
#   2. The five S46-revived stdin readers (they sat silently dead on the
#      never-set CLAUDE_TOOL_INPUT env var): check-skill-slug, memory-size-gate,
#      check-destructive, check-freeze, and the settings.json inline git-push
#      warn (extracted from settings.json so we test the REAL registered string).
#      check-wrap-collision's stdin revival is covered by wrap-mutex-race-test.sh.
#   3. Mode-off => silent-pass for the two mode-gated blockers (they were dead
#      while registered; prove they stay quiet with no flag before trusting them).
#
# macOS bash 3.2 compatible. Never touches the real ~/.claude repo state.

set -u
SM="$HOME/.claude/hooks/session-manifest.js"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/smcanary.XXXXXX" 2>/dev/null || mktemp -d)"
REPO="$WORK/repo"
MDIR="$REPO/.session-manifests"
NODETMP="$(node -e 'process.stdout.write(require("os").tmpdir())')"
CAREFUL_FLAG="$NODETMP/.claude-careful-mode"
FREEZE_FLAG="$NODETMP/.claude-freeze-dir"
CAREFUL_WAS=0; FREEZE_WAS=""
[ -f "$CAREFUL_FLAG" ] && CAREFUL_WAS=1
[ -f "$FREEZE_FLAG" ] && FREEZE_WAS="$(cat "$FREEZE_FLAG")"
cleanup(){
  rm -rf "$WORK"
  # restore mode flags exactly as found — a leaked flag would block the LIVE session
  if [ "$CAREFUL_WAS" = "1" ]; then touch "$CAREFUL_FLAG"; else rm -f "$CAREFUL_FLAG"; fi
  if [ -n "$FREEZE_WAS" ]; then printf '%s' "$FREEZE_WAS" > "$FREEZE_FLAG"; else rm -f "$FREEZE_FLAG"; fi
}
trap cleanup EXIT

pass=0; fail=0
ok(){ pass=$((pass+1)); printf '  PASS  %s\n' "$1"; }
no(){ fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; }

export CLAUDE_MANIFEST_REPO="$REPO"
export CLAUDE_SESSION_MANIFEST_DIR="$MDIR"

fresh_repo(){
  rm -rf "$REPO"; mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t; git -C "$REPO" config user.name t
  printf 'base\n' > "$REPO/tracked.md"
  git -C "$REPO" add -A >/dev/null 2>&1; git -C "$REPO" commit -qm base >/dev/null 2>&1
}

rec(){ # $1=session $2=abs-path [$3=field (default file_path)]
  printf '{"session_id":"%s","tool_input":{"%s":"%s"}}' "$1" "${3:-file_path}" "$2" | node "$SM" record
}

echo "== 1. record =="
fresh_repo
echo A > "$REPO/mine.md"
rec sessA "$REPO/mine.md"
grep -qx 'mine.md' "$MDIR/sessA" && ok "repo path => repo-relative manifest row" || no "no manifest row for repo path"

rec sessA "/etc/hosts"
[ "$(grep -c . "$MDIR/sessA")" = "1" ] && ok "outside path => no row" || no "outside path recorded"

rec sessA "$REPO/nb.ipynb" notebook_path
grep -qx 'nb.ipynb' "$MDIR/sessA" && ok "notebook_path variant => row" || no "notebook_path not recorded"

printf 'not json at all' | node "$SM" record; rc=$?
[ "$rc" -eq 0 ] && ok "garbage stdin => exit 0 (fail-silent)" || no "garbage stdin rc=$rc"

touch -t 202001010000 "$MDIR/sessA"
rec sessA "/outside/elsewhere.md"
y="$(node -e "process.stdout.write(String(new Date(require('fs').statSync('$MDIR/sessA').mtimeMs).getFullYear()))")"
[ "$y" != "2020" ] && ok "record touches manifest mtime even for non-repo path (liveness beacon)" || no "liveness touch missing"

echo "== 2. stage =="
fresh_repo
echo A > "$REPO/mine.md"; rec sessA "$REPO/mine.md"
echo reverted > "$REPO/gone.md"; rec sessA "$REPO/gone.md"; rm "$REPO/gone.md"   # recorded then reverted (untracked created+deleted)
echo B > "$REPO/theirs.md"; rec sessB "$REPO/theirs.md"                          # fresh sibling
echo C > "$REPO/unclaimed.md"                                                     # nobody's
echo D > "$REPO/dead.md"; rec sessDead "$REPO/dead.md"; touch -t 202001010000 "$MDIR/sessDead"  # dead session's file
git -C "$REPO" add tracked.md >/dev/null 2>&1 && echo polluted >> "$REPO/tracked.md" && git -C "$REPO" add tracked.md  # index pollution (staged foreign change)
git -C "$REPO" reset -q tracked.md; echo polluted2 > "$WORK/x"; # keep pollution simpler below
out="$(CLAUDE_CODE_SESSION_ID=sessA node "$SM" stage 2>"$WORK/stage.err")"
echo "$out" | grep -q 'mine.md' && ok "own dirty file staged" || no "mine.md not staged: $out"
echo "$out" | grep -q 'gone.md' && no "reverted entry staged" || ok "reverted entry dropped (porcelain filter)"
echo "$out" | grep -q 'theirs.md — claimed by live session sessB' && ok "fresh sibling annotated claimed+LEAVE" || no "sibling annotation missing"
echo "$out" | grep -q 'unclaimed.md — unclaimed; first seen' && ok "unclaimed leftover gets first-seen aging note" || no "first-seen note missing"
echo "$out" | grep -q 'dead.md — ORPHAN-ADOPTED' && ok "dead session's file ORPHAN-ADOPTED" || no "stale-owner adoption missing"
[ ! -f "$MDIR/sessDead" ] && ok "stale manifest GC'd after adoption" || no "stale manifest not GC'd"
staged="$(git -C "$REPO" diff --cached --name-only)"
echo "$staged" | grep -q 'theirs.md' && no "sibling file staged" || ok "sibling file NOT staged"

# pathspec commit immunity: pre-stage a foreign edit, commit via pathspec file
echo polluted >> "$REPO/tracked.md"; git -C "$REPO" add tracked.md
git -C "$REPO" commit -q --pathspec-from-file="$MDIR/sessA.commit-pathspec" -m wrapA
files="$(git -C "$REPO" show --name-only --format= HEAD)"
echo "$files" | grep -q 'tracked.md' && no "polluted index entry leaked into commit" || ok "pathspec commit ignores polluted index"
echo "$files" | grep -q 'mine.md' && ok "own file in own commit" || no "own file missing from commit"
git -C "$REPO" diff --cached --name-only | grep -q 'tracked.md' && ok "foreign staged entry left intact for its owner" || no "foreign staged entry vanished"

echo "== 3. WARN + first-seen adoption + claim + prune =="
fresh_repo
echo X > "$REPO/orphan.md"
out2="$(CLAUDE_CODE_SESSION_ID=sessNew node "$SM" stage 2>&1 1>/dev/null)"
echo "$out2" | grep -q 'manifest is EMPTY but the repo has' && ok "empty-manifest + dirty repo => loud WARN (dead-recorder tell)" || no "missing dead-recorder WARN"
sleep 1.2
out3="$(CLAUDE_CODE_SESSION_ID=sessNew CLAUDE_MANIFEST_ORPHAN_MS=1000 node "$SM" stage 2>/dev/null)"
echo "$out3" | grep -q 'orphan.md — ORPHAN-ADOPTED' && ok "unclaimed leftover adopted after ORPHAN_MS via first-seen ledger" || no "first-seen adoption failed: $out3"

fresh_repo
echo bashmade > "$REPO/bash-created.md"
CLAUDE_CODE_SESSION_ID=sessA node "$SM" claim bash-created.md >/dev/null
grep -qx 'bash-created.md' "$MDIR/sessA.commit-pathspec" && ok "claim => pathspec entry" || no "claim missing from pathspec"
git -C "$REPO" diff --cached --name-only | grep -q 'bash-created.md' && ok "claim => staged" || no "claim did not stage"

git -C "$REPO" rm -q tracked.md   # staged deletion: nothing on disk nor index for `git add`
CLAUDE_CODE_SESSION_ID=sessA node "$SM" claim tracked.md >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 0 ] && grep -qx 'tracked.md' "$MDIR/sessA.commit-pathspec"; } && ok "claim tolerates already-staged deletion" || no "claim failed on staged deletion rc=$rc"
CLAUDE_CODE_SESSION_ID=sessA node "$SM" claim no-such-file.md >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok "claim still fails loudly on a bogus path (typo protection)" || no "claim swallowed a bogus path"

echo stilldirty > "$REPO/uncommitted.md"; rec sessA "$REPO/uncommitted.md"
git -C "$REPO" commit -q --pathspec-from-file="$MDIR/sessA.commit-pathspec" -m wrap
CLAUDE_CODE_SESSION_ID=sessA node "$SM" prune >/dev/null
grep -qx 'uncommitted.md' "$MDIR/sessA" && ok "prune keeps still-dirty entries" || no "prune dropped a dirty entry"
grep -qx 'bash-created.md' "$MDIR/sessA" 2>/dev/null && no "prune kept committed entry" || ok "prune drops committed entries"
[ ! -f "$MDIR/sessA.commit-pathspec" ] && ok "prune removes pathspec file" || no "pathspec file survives prune"

echo "== 4. deletion staging =="
fresh_repo
rec sessA "$REPO/tracked.md"   # session 'edited' it earlier; then deletes via rm
rm "$REPO/tracked.md"
CLAUDE_CODE_SESSION_ID=sessA node "$SM" stage >/dev/null 2>&1
git -C "$REPO" commit -q --pathspec-from-file="$MDIR/sessA.commit-pathspec" -m del
git -C "$REPO" show --name-status --format= HEAD | grep -q '^D.*tracked.md' && ok "manifested deletion staged + committed" || no "deletion not committed"

fresh_repo                     # INDEX-side deletion (git rm --cached): nothing on disk nor in index
git -C "$REPO" rm -q --cached tracked.md; rm "$REPO/tracked.md"
rec sessA "$REPO/tracked.md"   # manifested (e.g. claimed earlier or recorded pre-delete)
CLAUDE_CODE_SESSION_ID=sessA node "$SM" stage >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 0 ] && grep -qx 'tracked.md' "$MDIR/sessA.commit-pathspec"; } && ok "stage tolerates index-side (rm --cached) deletion" || no "stage failed on index-side deletion rc=$rc"

fresh_repo                     # staged deletion RECREATED on disk (mutex-owner lifecycle) => resurrection risk
git -C "$REPO" rm -q --cached tracked.md            # deletion staged, file still on disk
rec sessA "$REPO/tracked.md"
out8="$(CLAUDE_CODE_SESSION_ID=sessA node "$SM" stage 2>&1 1>/dev/null)"
echo "$out8" | grep -qi 'resurrect' && ok "stage WARNs on staged-deletion recreated on disk" || no "missing resurrection warn: $out8"
grep -qx 'tracked.md' "$MDIR/sessA.commit-pathspec" 2>/dev/null && no "resurrection-risk path leaked into pathspec" || ok "resurrection-risk path EXCLUDED from pathspec"
rm "$REPO/tracked.md"
CLAUDE_CODE_SESSION_ID=sessA node "$SM" stage >/dev/null 2>&1
grep -qx 'tracked.md' "$MDIR/sessA.commit-pathspec" && ok "deletion re-enters pathspec once truly absent (self-healing)" || no "deletion still excluded after file gone"

fresh_repo                     # GITIGNORED-but-kept staged deletion => manual-untracking WARN, NOT the self-heal lie (S50/Phase4)
printf 'kept.log\n' > "$REPO/.gitignore"
printf 'x\n' > "$REPO/kept.log"
git -C "$REPO" add -f kept.log .gitignore >/dev/null 2>&1
git -C "$REPO" commit -qm 'track kept.log then ignore it' >/dev/null 2>&1  # now tracked AND matched by .gitignore
git -C "$REPO" rm -q --cached kept.log                                     # stage untracking; file stays on disk; check-ignore now rc=0
rec sessA "$REPO/kept.log"
out9="$(CLAUDE_CODE_SESSION_ID=sessA node "$SM" stage 2>&1 1>/dev/null)"
echo "$out9" | grep -qi 'gitignored-but-kept' && ok "gitignored-kept deletion => WARN" || no "missing gitignored-kept warn: $out9"
echo "$out9" | grep -qi 'do NOT re-run' && ok "WARN steers away from the broken rm --cached retry" || no "WARN missing do-NOT-re-run guidance: $out9"
echo "$out9" | grep -qi 'commit once the path is truly absent' && no "gitignored-kept path got the misleading self-heal WARN" || ok "gitignored-kept path NOT given the self-heal lie"
grep -qx 'kept.log' "$MDIR/sessA.commit-pathspec" 2>/dev/null && no "gitignored-kept path leaked into pathspec" || ok "gitignored-kept path EXCLUDED from pathspec"
# P72 real teeth (would have caught the broken recipe): the OLD recipe's first command MUST fatal on an already-staged deletion
git -C "$REPO" rm --cached kept.log >/dev/null 2>&1 && no "git rm --cached on already-untracked path SUCCEEDED (broken-recipe precondition changed)" || ok "old recipe's 'git rm --cached' fatals on already-staged deletion (as the WARN says)"
# P72 real teeth: the PRESCRIBED plain whole-index commit records the untracking AND keeps the file on disk
git -C "$REPO" commit -qm "untrack gitignored files" >/dev/null 2>&1
{ ! git -C "$REPO" ls-files --error-unmatch kept.log >/dev/null 2>&1 && [ -f "$REPO/kept.log" ]; } && ok "prescribed plain commit records untracking AND keeps kept.log on disk" || no "prescribed recipe did not untrack-and-keep"

fresh_repo                     # staged RENAME (git mv): origin is in neither worktree nor index —
                               # `git add origin` fatals; dirtySnapshot must key origin 'D ' (S47 catch)
git -C "$REPO" mv tracked.md archived.md
CLAUDE_CODE_SESSION_ID=sessA node "$SM" claim tracked.md archived.md >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 0 ] && grep -qx 'tracked.md' "$MDIR/sessA.commit-pathspec" && grep -qx 'archived.md' "$MDIR/sessA.commit-pathspec"; } && ok "claim tolerates rename origin (git mv), pathspecs both sides" || no "claim failed on rename origin rc=$rc"
git -C "$REPO" commit -q --pathspec-from-file="$MDIR/sessA.commit-pathspec" -m mv
tree="$(git -C "$REPO" ls-tree --name-only HEAD)"
{ echo "$tree" | grep -qx 'archived.md' && ! echo "$tree" | grep -qx 'tracked.md'; } && ok "rename commits whole (add + delete), no half-rename" || no "half-rename committed: $tree"

fresh_repo                     # same via stage (the systematic wrap path)
git -C "$REPO" mv tracked.md archived.md
rec sessA "$REPO/tracked.md"; rec sessA "$REPO/archived.md"
CLAUDE_CODE_SESSION_ID=sessA node "$SM" stage >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 0 ] && grep -qx 'tracked.md' "$MDIR/sessA.commit-pathspec" && grep -qx 'archived.md' "$MDIR/sessA.commit-pathspec"; } && ok "stage tolerates manifested rename origin" || no "stage failed on rename origin rc=$rc"

echo "== 5. revived stdin readers =="
SLUG="$HOME/.claude/hooks/check-skill-slug.js"
printf '{"session_id":"x","tool_input":{"skill":"/wrap"}}' | node "$SLUG" >/dev/null 2>"$WORK/slug.err"; rc=$?
{ [ "$rc" -eq 2 ] && grep -q 'SKILL-SLUG' "$WORK/slug.err"; } && ok "skill-slug: unknown slug via stdin => BLOCK(2) + did-you-mean" || no "skill-slug block rc=$rc"
printf '{"session_id":"x","tool_input":{"skill":"wrapping-session"}}' | node "$SLUG" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "skill-slug: valid slug => allow" || no "skill-slug blocked valid slug rc=$rc"
# Harness BUILT-INS live in the CLI, not on disk — no installed skill resembles
# them, so no shorthand evidence => fail OPEN, harness is the judge (S256).
printf '{"session_id":"x","tool_input":{"skill":"fewer-permission-prompts"}}' | node "$SLUG" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "skill-slug: built-in-shaped unknown (no resemblance) => allow" || no "skill-slug blocked built-in rc=$rc"
# Built-ins that EXTEND an installed slug (`code-review` ⊃ `review`) must also
# pass — the first S256 fix missed this shape (arch-review catch):
printf '{"session_id":"x","tool_input":{"skill":"code-review"}}' | node "$SLUG" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "skill-slug: built-in extending installed slug (code-review⊃review) => allow" || no "skill-slug blocked extension-shape built-in rc=$rc"
# ...but real shorthand (fragment) and typos must STILL block with did-you-mean:
printf '{"session_id":"x","tool_input":{"skill":"catchp"}}' | node "$SLUG" >/dev/null 2>"$WORK/slug2.err"; rc=$?
{ [ "$rc" -eq 2 ] && grep -q 'catchup' "$WORK/slug2.err"; } && ok "skill-slug: typo of installed slug => BLOCK + did-you-mean" || no "skill-slug typo rc=$rc"

MSG="$HOME/.claude/hooks/memory-size-gate.js"
big="$(node -e 'process.stdout.write("x".repeat(60*1024))')"
out5="$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"%s"}}' "$HOME/.claude/CLAUDE.md" "$big" | node "$MSG" 2>&1 1>/dev/null)"; rc=$?
{ [ "$rc" -eq 0 ] && echo "$out5" | grep -q 'memory-size-gate'; } && ok "memory-size-gate: oversize CLAUDE.md write => WARN, no block" || no "memory-size-gate rc=$rc out=$out5"
out5b="$(printf '{"tool_name":"Write","tool_input":{"file_path":"/tmp/other.md","content":"hi"}}' | node "$MSG" 2>&1)";
[ -z "$out5b" ] && ok "memory-size-gate: non-memory file => silent" || no "memory-size-gate noisy: $out5b"

# --- authoring-time ENTRY-size budget (S47; caps ported from verify_claude_md.py) ---
# node materializes each payload in command-substitution FIRST, then printf (a
# fast builtin) is the pipe producer. A `node -e | node hook` producer races the
# hook's fs.readFileSync(0): the slow producer isn't ready, the read hits EAGAIN,
# the hook's try/catch swallows it, and it reads empty. printf-fed (as the
# existing memory-size-gate tests do) delivers stdin reliably.
pA="$(node -e 'const cell="Oversized mistake-row canary — "+"blah ".repeat(60);const row="| "+cell+" | 1x | — | 2026-07-04 |";process.stdout.write(JSON.stringify({tool_name:"Edit",tool_input:{file_path:process.env.HOME+"/.claude/CLAUDE.md",new_string:row}}))')"
oA="$(printf '%s' "$pA" | node "$MSG" 2>&1 1>/dev/null)"; rc=$?
{ [ "$rc" -eq 0 ] && echo "$oA" | grep -q 'oversized mistake-table'; } && ok "entry-budget: oversized 1x mistake row (no pointer) => WARN, no block" || no "mistake-row warn missing rc=$rc out=$oA"

# S255 policy: an archive pointer does NOT exempt an oversized row (archive-first
# drain — the row itself must fit ≤250c; the pointer carries the narrative). This
# test previously asserted the RETIRED pointer-exemption and sat red (P62 drift,
# fixed S256): pointered oversized rows must warn exactly like unpointered ones.
pB="$(node -e 'const cell="Pointered row — "+"blah ".repeat(60)+" → learnings/2026-07-04-x-archive.md";const row="| "+cell+" | 1x | — | 2026-07-04 |";process.stdout.write(JSON.stringify({tool_name:"Edit",tool_input:{file_path:process.env.HOME+"/.claude/CLAUDE.md",new_string:row}}))')"
oB="$(printf '%s' "$pB" | node "$MSG" 2>&1 1>/dev/null)"
echo "$oB" | grep -q 'oversized mistake-table' && ok "entry-budget: oversized row WITH pointer => still warns (pointer does NOT exempt, S255)" || no "pointered oversized row NOT warned (retired exemption resurfaced?): $oB"

pC="$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Edit",tool_input:{file_path:process.env.HOME+"/.claude/CLAUDE.md",new_string:"| Short benign row | 1x | — | 2026-07-04 |"}}))')"
oC="$(printf '%s' "$pC" | node "$MSG" 2>&1 1>/dev/null)"
echo "$oC" | grep -q 'oversized mistake-table' && no "small mistake row warned: $oC" || ok "entry-budget: small mistake row => no row warn (happy path)"

pD="$(node -e 'const body="73. Some new principle rule body that is deliberately long — "+"detection and applies-to scope words ".repeat(12)+"Example: "+"a substantial inline worked example running well past one hundred characters to trip the T3 externalization cap ".repeat(2)+".";process.stdout.write(JSON.stringify({tool_name:"Edit",tool_input:{file_path:process.env.HOME+"/.claude/CLAUDE.md",new_string:body}}))')"
oD="$(printf '%s' "$pD" | node "$MSG" 2>&1 1>/dev/null)"; rc=$?
{ [ "$rc" -eq 0 ] && echo "$oD" | grep -q 'oversized principle'; } && ok "entry-budget: oversized principle w/ inline Example => WARN" || no "principle warn missing rc=$rc out=$oD"

pE="$(node -e 'const body="74. A long T1+T2-only principle rule body with no worked example at all — "+"multiple detection signals and applies-to scopes stacked here ".repeat(12)+"end of rule body.";process.stdout.write(JSON.stringify({tool_name:"Edit",tool_input:{file_path:process.env.HOME+"/.claude/CLAUDE.md",new_string:body}}))')"
oE="$(printf '%s' "$pE" | node "$MSG" 2>&1 1>/dev/null)"
echo "$oE" | grep -q 'oversized principle' && no "T1+T2-only principle warned: $oE" || ok "entry-budget: long T1+T2-only principle (no Example) => no principle warn (governance.md:144)"

pF="$(node -e 'const body="9. **Some new command rule**: a deliberately long command-discipline rule body — "+"imperative clauses stacked to exceed six hundred characters here ".repeat(12)+"Example: an inline example too, well past one hundred chars to prove the discriminator excludes command rules.";process.stdout.write(JSON.stringify({tool_name:"Edit",tool_input:{file_path:process.env.HOME+"/.claude/CLAUDE.md",new_string:body}}))')"
oF="$(printf '%s' "$pF" | node "$MSG" 2>&1 1>/dev/null)"
echo "$oF" | grep -q 'oversized principle' && no "command rule warned as principle: $oF" || ok "entry-budget: long ** command rule => no principle warn (discriminator)"

LB="$(node -e 'process.stdout.write("y".repeat(41*1024))')"
oG="$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"%s"}}' "$HOME/.claude/learnings/2026-07-04-canary-oversize.md" "$LB" | node "$MSG" 2>&1 1>/dev/null)"; rc=$?
{ [ "$rc" -eq 0 ] && echo "$oG" | grep -q 'learnings/ files are'; } && ok "entry-budget: >40KB learnings Write => WARN (split nudge)" || no "learnings warn missing rc=$rc out=$oG"

oH="$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"%s"}}' "$HOME/.claude/projects/test-slug/memory/learnings/2026-07-04-canary.md" "$LB" | node "$MSG" 2>&1 1>/dev/null)"
echo "$oH" | grep -q 'learnings/ files are' && ok "entry-budget: memory/learnings path also detected => WARN" || no "memory learnings not detected: $oH"

LS="$(node -e 'process.stdout.write("y".repeat(1024))')"
oI="$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"%s"}}' "$HOME/.claude/learnings/2026-07-04-small.md" "$LS" | node "$MSG" 2>&1 1>/dev/null)"
[ -z "$oI" ] && ok "entry-budget: small (<40KB) learnings Write => silent" || no "small learnings warned: $oI"

pJ="$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Edit",tool_input:{file_path:process.env.HOME+"/.claude/CLAUDE.md",new_string:"A short, ordinary edit to CLAUDE.md with no table row and no numbered principle."}}))')"
oJ="$(printf '%s' "$pJ" | node "$MSG" 2>&1 1>/dev/null)"
[ -z "$oJ" ] && ok "entry-budget: benign small CLAUDE.md edit => fully silent (happy path, no false positive)" || no "benign edit warned: $oJ"

DEST="$HOME/.claude/skills/careful/scripts/check-destructive.js"
rm -f "$CAREFUL_FLAG"
printf '{"tool_input":{"command":"rm -rf /tmp/x"}}' | node "$DEST" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "check-destructive: mode OFF => silent pass even on rm -rf" || no "destructive blocked with mode off rc=$rc"
touch "$CAREFUL_FLAG"
printf '{"tool_input":{"command":"rm -rf /tmp/x"}}' | node "$DEST" >/dev/null 2>"$WORK/dest.err"; rc=$?
{ [ "$rc" -eq 2 ] && grep -q 'CAREFUL MODE BLOCKED' "$WORK/dest.err"; } && ok "check-destructive: mode ON + rm -rf via stdin => BLOCK(2)" || no "destructive mode-on rc=$rc"
printf '{"tool_input":{"command":"ls -la"}}' | node "$DEST" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "check-destructive: mode ON + benign => allow" || no "destructive blocked benign rc=$rc"
rm -f "$CAREFUL_FLAG"

FRZ="$HOME/.claude/skills/freeze/scripts/check-freeze.js"
rm -f "$FREEZE_FLAG"
printf '{"tool_input":{"file_path":"/anywhere/at/all.md"}}' | node "$FRZ" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "check-freeze: mode OFF => silent pass" || no "freeze blocked with mode off rc=$rc"
printf '%s' "$WORK" > "$FREEZE_FLAG"
printf '{"tool_input":{"file_path":"/outside/file.md"}}' | node "$FRZ" >/dev/null 2>"$WORK/frz.err"; rc=$?
{ [ "$rc" -eq 2 ] && grep -q 'FREEZE MODE BLOCKED' "$WORK/frz.err"; } && ok "check-freeze: mode ON + outside path via stdin => BLOCK(2)" || no "freeze mode-on rc=$rc"
printf '{"tool_input":{"file_path":"%s/inside.md"}}' "$WORK" | node "$FRZ" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "check-freeze: mode ON + inside path => allow" || no "freeze blocked inside path rc=$rc"
rm -f "$FREEZE_FLAG"

# the REAL registered inline git-push warn string, extracted from settings.json
PUSHCMD="$(node -e "const s=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.claude/settings.json','utf8'));const h=s.hooks.PreToolUse.flatMap(m=>m.hooks||[]).find(h=>h.command&&h.command.includes('git push'));process.stdout.write(h?h.command:'')")"
if [ -n "$PUSHCMD" ]; then
  out6="$(printf '{"tool_input":{"command":"git push origin master"}}' | bash -c "$PUSHCMD")"
  echo "$out6" | grep -q 'About to push' && ok "inline git-push warn fires via stdin (real registered string)" || no "inline push warn silent: $out6"
  out7="$(printf '{"tool_input":{"command":"git status"}}' | bash -c "$PUSHCMD")"
  [ -z "$out7" ] && ok "inline git-push warn silent on non-push" || no "inline warn noisy: $out7"
else
  no "could not extract inline git-push command from settings.json"
fi

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && exit 0 || exit 1
