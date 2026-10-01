#!/usr/bin/env bash
# Alignment-gate canary — proves check-alignment-gate.js discriminates.
#
# WHY THIS EXISTS: the gate WARNS rather than blocks, so a silent regression
# would look exactly like a well-aligned session. Two mutants survived the
# first /harden pass on this hook (2026-08-21): it was unregistered in
# settings.json, and it failed OPEN when its state file could not be written.
# Both are asserted here in BOTH directions -- a test that only checks the
# firing case cannot tell "gate works" from "gate never fires".
#
# Feeds input the way the harness does: JSON on stdin. Never via env vars.

set -uo pipefail
HOOK="${HOME}/.claude/hooks/check-alignment-gate.js"
pass=0; fail=0

fire() { # $1=session $2=path [$3=TMPDIR override] -> "WARN" | "silent"
  local out
  if [ -n "${3:-}" ]; then
    out=$(printf '{"tool_name":"Edit","session_id":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2" \
          | TMPDIR="$3" node "$HOOK" 2>&1 >/dev/null)
  else
    out=$(printf '{"tool_name":"Edit","session_id":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2" \
          | node "$HOOK" 2>&1 >/dev/null)
  fi
  [ -n "$out" ] && echo "WARN" || echo "silent"
}

check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then printf '  ok    %-52s %s\n' "$1" "$3"; pass=$((pass+1))
  else printf '  FAIL  %-52s got %s want %s\n' "$1" "$3" "$2"; fail=$((fail+1)); fi
}

S="canary-$$"

# --- Direction 1: it FIRES on genuine multi-file work -----------------------
check "1st source file is silent"        silent "$(fire "${S}a" /repo/a.ts)"
check "2nd source file WARNS"            WARN   "$(fire "${S}a" /repo/b.ts)"
check "3rd source file silent (once)"    silent "$(fire "${S}a" /repo/c.ts)"

# --- Direction 2: it STAYS QUIET where it should ----------------------------
check "same file 2x does not fire"       silent "$(fire "${S}b" /repo/a.ts >/dev/null; fire "${S}b" /repo/a.ts)"
check "2 markdown files do not fire"     silent "$(fire "${S}c" /r/a.md >/dev/null; fire "${S}c" /r/b.md)"
check "2 scratchpad files do not fire"   silent "$(fire "${S}d" /tmp/x/scratchpad/a.ts >/dev/null; fire "${S}d" /tmp/x/scratchpad/b.ts)"
check "sessions are isolated"            silent "$(fire "${S}e" /repo/a.ts)"

# --- Direction 3: the escape valve works ------------------------------------
fire "${S}f" /repo/a.ts >/dev/null
out=$(printf '{"tool_name":"Edit","session_id":"%sf","tool_input":{"file_path":"/repo/b.ts"}}' "$S" \
      | CLAUDE_ALIGNMENT_SKIP=1 node "$HOOK" 2>&1 >/dev/null)
check "CLAUDE_ALIGNMENT_SKIP=1 silences"  silent "$([ -n "$out" ] && echo WARN || echo silent)"

# --- Direction 4: a dead recorder ANNOUNCES itself (M6 regression) ----------
dead=$(fire "${S}g" /repo/a.ts /nonexistent-dir-xyz)
check "unwritable state dir announces"    WARN   "$dead"

# --- Direction 5: enforcement is actually WIRED (M10 regression) ------------
wired=$(node -e '
const d=require(process.env.HOME+"/.claude/settings.json");
const all=Object.values(d.hooks||{}).flat().flatMap(m=>m.hooks||[]).map(h=>h.command||"");
console.log(all.some(c=>c.includes("check-alignment-gate"))?"WIRED":"UNWIRED");
')
check "registered in settings.json"       WIRED  "$wired"

# --- Positive control: the harness would notice a dead hook -----------------
ctl=$(printf '{"tool_name":"Edit","session_id":"ctl-%s","tool_input":{"file_path":"/repo/x.ts"}}' "$$" \
      | node "$HOOK" >/dev/null 2>&1; echo $?)
check "hook exits 0 (never blocks)"       0      "$ctl"

echo
echo "alignment-gate-canary: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
