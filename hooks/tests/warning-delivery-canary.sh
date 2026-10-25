#!/usr/bin/env bash
# Warning-delivery canary (S81) — proves the WARN-ONLY hooks emit their warning on the
# one channel that reaches the model: stdout JSON hookSpecificOutput.additionalContext.
#
# WHY: probed 2026-10-04 (claude -p, Claude Code 2.1.289, positive + negative controls,
# 2 runs): for PreToolUse/PostToolUse, exit-0 stdout AND stderr never reach the model
# (docs: code.claude.com/docs/en/hooks — "Claude never sees it"); additionalContext does.
# All three hooks below wrote plain stderr, so every warning they ever issued was invisible
# to the model (the alignment warning was cited 0/159 times — that was delivery, not neglect).
# Each hook is asserted BOTH ways: fires → valid JSON with the warning; quiet → no stdout.
# Note: transcripts record stderr too, so grepping transcripts for a warning cannot tell
# delivered from undelivered — this canary checks the channel instead.
set -uo pipefail
H="$HOME/.claude/hooks"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  ❌ %s\n     got: %s\n' "$1" "${2:0:200}"; }
# ctx <stdout> <needle> → 0 if stdout is ONE JSON object whose PreToolUse additionalContext contains needle
ctx(){ printf '%s' "$1" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
  const h=j.hookSpecificOutput||{};process.exit(h.hookEventName==="PreToolUse"&&String(h.additionalContext||"").includes(process.argv[1])?0:1)}catch{process.exit(1)}})' "$2"; }

echo "== alignment gate =="
S="wdc-$$"
fire(){ printf '{"tool_name":"Edit","session_id":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2" | node "$H/check-alignment-gate.js" 2>/dev/null; }
out=$(fire "$S" /repo/a.ts); [ -z "$out" ] && ok "1st source file → no stdout" || no "1st file → no stdout" "$out"
out=$(fire "$S" /repo/b.ts); ctx "$out" "ALIGN" && ok "2nd source file → additionalContext carries the ALIGN warning" || no "2nd file → additionalContext" "$out"

echo "== memory-size gate =="
D=$(mktemp -d); mkdir -p "$D/memory"
big=$(node -e 'console.log("x".repeat(25*1024))')
mw(){ printf '%s' "$1" | node "$H/memory-size-gate.js" 2>/dev/null; }
out=$(mw "$(node -e 'console.log(JSON.stringify({tool_name:"Write",tool_input:{file_path:process.argv[1],content:process.argv[2]}}))' "$D/memory/MEMORY.md" "$big")")
ctx "$out" "memory-size-gate" && ok "MEMORY.md write over soft cap → additionalContext warning" || no "over cap → additionalContext" "$out"
out=$(mw "$(node -e 'console.log(JSON.stringify({tool_name:"Write",tool_input:{file_path:process.argv[1],content:"small"}}))' "$D/memory/MEMORY.md")")
[ -z "$out" ] && ok "small MEMORY.md write → no stdout" || no "small write → no stdout" "$out"
rm -rf "$D"

echo "== wrap-collision warning =="
LOCKDIR=$(mktemp -d)/lock; sleep 60 & OWNPID=$!; OWNSTART="$(ps -p $OWNPID -o lstart=)"
mkdir -p "$LOCKDIR"; printf 'owner_sess\t%s\t%s\n' "$OWNPID" "$OWNSTART" > "$LOCKDIR/owner"
wr(){ printf '{"session_id":"%s","cwd":"%s","tool_input":{"command":"git add -A"}}' "$1" "$HOME/.claude" | \
  CLAUDE_CODE_SESSION_ID="$1" CLAUDE_GIT_SYNC_LOCK_DIR="$LOCKDIR" node "$H/check-wrap-collision.js" 2>/dev/null; }
out=$(wr other_sess); ctx "$out" "WRAP-COLLISION" && ok "another live session holds the lock → additionalContext warning" || no "collision → additionalContext" "$out"
out=$(wr owner_sess); [ -z "$out" ] && ok "my own lock → no stdout" || no "own lock → no stdout" "$out"
kill "$OWNPID" 2>/dev/null; wait "$OWNPID" 2>/dev/null; rm -rf "$(dirname "$LOCKDIR")"

printf '\nRESULT: %s passed, %s failed\n' "$PASS" "$FAIL"; [ "$FAIL" = 0 ]
