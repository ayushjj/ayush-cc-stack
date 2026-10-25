#!/usr/bin/env bash
# Canary for hooks/check-read-size.js — the whole-file-read gate (matcher `Read|Bash`).
#
# Bidirectional by construction: every MUST-BLOCK case has MUST-PASS siblings, so a
# "fix" that guts the gate fails this suite instead of passing it. The gate exists to
# stop 66K chars/session of whole-file reads flooding main context (S66b), but the
# expensive failure is the OTHER direction — /hook-review 2026-08-21 measured 31 of 37
# check-cd-persistence fires as false positives from one loose regex. Hence cases 6-9.
#
# Input arrives the way the harness sends it: JSON on stdin. NEVER via CLAUDE_TOOL_INPUT
# — gate-hooks-canary.sh exists because env-fed smokes went green on dead stdin wiring.
#
# HOME is redirected to a temp dir for every case so telemetry and the override log
# land there, not in the real ~/.claude. Every valve is scrubbed from the child env,
# so an operator who has CLAUDE_READ_SIZE_SKIP=1 set cannot make all 15 pass for the
# wrong reason.
#
# Run:  bash ~/.claude/hooks/tests/read-size-canary.sh
set -u
HOOK="${READ_SIZE_HOOK:-$HOME/.claude/hooks/check-read-size.js}"  # overridable so the gate can be mutation-tested against a copy
PASS=0; FAIL=0
pass(){ PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
fail(){ FAIL=$((FAIL+1)); printf '  ❌ %s (got %s, wanted %s)\n' "$1" "$2" "$3"; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/.claude"
TELEM="$T/.claude/telemetry/read-size-gate.jsonl"

seq 1 400 > "$T/big.txt"
seq 1 400 > "$T/a.txt"
seq 1 400 > "$T/b.txt"
seq 1 100 > "$T/small.txt"
STDERR="$T/stderr.log"

# run <expected_exit> <label> <json> [env assignments...]
# Absolute paths everywhere: a relative path would resolve against the hook process's
# cwd, which the harness sets to the session cwd, not to this script's.
run(){ local want="$1" label="$2" json="$3"; shift 3
  local got
  env -u CLAUDE_READ_SIZE_SKIP -u CLAUDE_READ_SIZE_WARN_ONLY -u CLAUDE_READ_SIZE_LIMIT \
      HOME="$T" "$@" node "$HOOK" <<<"$json" >/dev/null 2>"$STDERR"; got=$?
  [ "$got" = "$want" ] && pass "$label" || fail "$label" "exit $got" "exit $want"; }

echo "== 0. Syntax =="
node --check "$HOOK" 2>/dev/null && pass "syntax check-read-size.js" || fail "syntax check-read-size.js" 1 0

echo "== 1-4. Read tool =="
run 2 "1. Read 400-line file, no limit → BLOCK (POSITIVE CONTROL)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}"
run 0 "2. Read 100-line file → allow" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/small.txt\"}}"
run 0 "3. Read 400-line file with limit:50 → allow" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/big.txt\",\"limit\":50}}"
run 0 "3b. Read 400-line file with offset:395, no limit → allow (remainder 6 lines)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/big.txt\",\"offset\":395}}"
run 2 "3c. Read 400-line file with offset:1, no limit → block (whole file from here)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/big.txt\",\"offset\":1}}"
run 0 "4. Read nonexistent path → allow (fail open)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/nope.txt\"}}"
run 0 "4b. Read 400-line file with pages:\"1-2\" → allow (PDF range == limit)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/big.txt\",\"pages\":\"1-2\"}}"
# allow_large lifts the Read TOOL's own size cap; it is not a range choice and does NOT
# exempt this gate (hook-review 2026-10-15). Only live case since 09-20: a 4,376-line JSON
# read with allow_large:true was blocked, and the model switched to targeted python
# queries — a true positive. Honouring it would have put 4,376 lines in main context.
run 2 "4n. Read 400-line file with allow_large:true → BLOCK (tool cap ≠ this gate)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/big.txt\",\"allow_large\":true}}"
# The escape must be reachable from where the model stands. Read has no command
# string, so an inline VAR=1 prefix is impossible there and env-only is unsettable
# per call — the message must point at the Bash form, which IS honoured (case 10).
run 2 "4c. Read block message names a REACHABLE escape" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}"
grep -qF "CLAUDE_READ_SIZE_SKIP=1 cat '$T/big.txt'" "$STDERR" \
  && pass "4d. ...specifically the Bash-prefix form" \
  || fail "4d. Read message names the Bash-prefix escape" "$(cat "$STDERR")" "CLAUDE_READ_SIZE_SKIP=1 cat <path>"

echo "== 4e. Hostile filename must be quoted in the printed override =="
seq 1 400 > "$T/n;touch PWNED;#.md"
run 2 "4e. Read hostile-named 400-line file → block" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/n;touch PWNED;#.md\"}}"
grep -q "cat '$T/n;touch PWNED;#.md'" "$STDERR" && pass "4f. override line single-quotes the path" \
  || fail "4f. override line single-quotes the path" "$(cat "$STDERR")" "cat '<path>'"
[ ! -e PWNED ] && pass "4g. nothing executed" || fail "4g. nothing executed" "PWNED exists" "absent"

echo "== 4h. Inside a subagent the gate stands down =="
# Fixtures mirror payloads CAPTURED 2026-09-15 (P3 Step 0). The old 4h used a
# `/subagents/` transcript_path the harness never sends — green while every real
# subagent read was blocked. A subagent payload = PARENT transcript_path + agent_id.
run 0 "4h. real subagent payload (parent transcript_path + agent_id) → allow" \
      "{\"tool_name\":\"Read\",\"transcript_path\":\"/x/projects/p/abc.jsonl\",\"agent_id\":\"a7196d46309b5bf01\",\"agent_type\":\"general-purpose\",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}"
run 2 "4i. real main payload (same transcript_path, no agent_id) → block" \
      "{\"tool_name\":\"Read\",\"transcript_path\":\"/x/projects/p/abc.jsonl\",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}"
run 2 "4j. blank agent_id fails closed → block" \
      "{\"tool_name\":\"Read\",\"transcript_path\":\"/x/projects/p/abc.jsonl\",\"agent_id\":\"  \",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}"
run 2 "4k. non-string agent_id fails closed → block" \
      "{\"tool_name\":\"Read\",\"agent_id\":true,\"tool_input\":{\"file_path\":\"$T/big.txt\"}}"
run 2 "4m. agent_type WITHOUT agent_id (main session started with --agent) → block" \
      "{\"tool_name\":\"Read\",\"transcript_path\":\"/x/projects/p/abc.jsonl\",\"agent_type\":\"security-reviewer\",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}"
run 2 "4l. the old /subagents/ path shape alone no longer exempts → block" \
      "{\"tool_name\":\"Read\",\"transcript_path\":\"/x/projects/p/abc/subagents/agent-1.jsonl\",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}"

echo "== 3d. Inexact-count band (2-20 MB) must not be bypassed by a large offset =="
yes "$(printf 'x%.0s' $(seq 1 80))" | head -n 40000 > "$T/mid.txt"
run 2 "3d. Read 3 MB / 40000-line file with offset:600, no limit → block (regression 2026-09-08)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/mid.txt\",\"offset\":600}}"
run 2 "5c. Bash cat -nA bigfile → block (combined flags are still a bare dump)" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat -nA $T/big.txt\"}}"

echo "== 5-9. Bash tool (block ONLY a bare dump) =="
run 2 "5. cat <400-line> → BLOCK" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $T/big.txt\"}}"
run 2 "5b. cat -n <400-line> → BLOCK" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat -n $T/big.txt\"}}"
run 0 "6. cat <400-line> | head -20 → allow" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $T/big.txt | head -20\"}}"
run 0 "7. sed -n '1,40p' <400-line> → allow" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"sed -n '1,40p' $T/big.txt\"}}"
run 0 "8. grep -n \\\"cat big.txt\\\" <400-line> → allow (quote trap)" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"grep -n \\\"cat big.txt\\\" $T/big.txt\"}}"
run 0 "9. cat a.txt b.txt (both 400) → allow (multi-file, conservative)" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $T/a.txt $T/b.txt\"}}"
run 0 "9b. cat <400-line> > out → allow (redirect)" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $T/big.txt > $T/out.txt\"}}"
run 0 "9c. head -50 <400-line> → allow" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"head -50 $T/big.txt\"}}"
run 0 "9d. wc -l <400-line> → allow" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"wc -l $T/big.txt\"}}"

echo "== 10-11. Valves =="
run 0 "10. CLAUDE_READ_SIZE_SKIP=1 inline prefix on case 5 → allow" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"CLAUDE_READ_SIZE_SKIP=1 cat $T/big.txt\"}}"
run 0 "11. CLAUDE_READ_SIZE_WARN_ONLY=1 env on case 1 → exit 0" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}" CLAUDE_READ_SIZE_WARN_ONLY=1
grep -q 'READ-SIZE GATE' "$STDERR" \
  && pass "11b. warn-only still writes the message to stderr" \
  || fail "11b. warn-only still writes the message to stderr" "no message" "READ-SIZE GATE"
grep -q '"action":"warn"' "$TELEM" \
  && pass "11c. warn-only logs action:warn" \
  || fail "11c. warn-only logs action:warn" "missing" "action:warn"

echo "== 12. Telemetry (this file IS the week's measurement) =="
rm -f "$TELEM"
run 2 "12a. re-run case 1 → BLOCK"  "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}"
N=$(wc -l < "$TELEM" 2>/dev/null | tr -d ' ')
[ "$N" = 1 ] && pass "12b. one telemetry line after a block" || fail "12b. one telemetry line after a block" "$N" "1"
grep -q '"action":"block"' "$TELEM" && grep -q '"tool":"Read"' "$TELEM" && grep -q '"lines":400' "$TELEM" \
  && pass "12c. line carries tool/path/lines/action" \
  || fail "12c. line carries tool/path/lines/action" "$(cat "$TELEM")" 'action=block tool=Read lines=400'
run 0 "12d. case 2 (100 lines) → allow"  "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/small.txt\"}}"
N=$(wc -l < "$TELEM" 2>/dev/null | tr -d ' ')
[ "$N" = 1 ] && pass "12e. NO telemetry line for a pass" || fail "12e. NO telemetry line for a pass" "$N" "1"
# Subagent exemption is LOGGED at the would-block point (review 2026-09-15): the exempt rate
# is the only signal that survives a harness renaming agent_id.
run 0 "12f. subagent 400-line read → allow" \
      "{\"tool_name\":\"Read\",\"agent_id\":\"a1\",\"agent_type\":\"Explore\",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}"
tail -1 "$TELEM" | grep -q '"action":"exempt-subagent"' && tail -1 "$TELEM" | grep -q '"lines":400' \
  && pass "12g. exempt subagent read logs action:exempt-subagent with lines" \
  || fail "12g. exempt subagent read logs action:exempt-subagent with lines" "$(tail -1 "$TELEM")" 'action=exempt-subagent lines=400'
run 0 "12h. subagent SMALL read → allow" \
      "{\"tool_name\":\"Read\",\"agent_id\":\"a1\",\"tool_input\":{\"file_path\":\"$T/small.txt\"}}"
run 0 "12i. subagent ordinary Bash → allow" \
      "{\"tool_name\":\"Bash\",\"agent_id\":\"a1\",\"tool_input\":{\"command\":\"ls\"}}"
N=$(wc -l < "$TELEM" 2>/dev/null | tr -d ' ')
[ "$N" = 2 ] && pass "12j. NO exempt row for a subagent call that would not have blocked" \
  || fail "12j. NO exempt row for a subagent call that would not have blocked" "$N" "2"

echo "== 13. Malformed / absent input =="
run 0 "13. malformed stdin JSON → allow (fails open)"  '{"tool_name":"Read","tool_input":{'
run 0 "13b. empty stdin → allow"                       ''
run 0 "13c. unknown tool → allow"                      "{\"tool_name\":\"Grep\",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}"

echo "== 14. Threshold is live, not decorative =="
run 0 "14a. CLAUDE_READ_SIZE_LIMIT=1000 on case 1 → allow" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/big.txt\"}}" CLAUDE_READ_SIZE_LIMIT=1000
run 2 "14b. CLAUDE_READ_SIZE_LIMIT=50 on the 100-line file → BLOCK" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/small.txt\"}}" CLAUDE_READ_SIZE_LIMIT=50

echo "== 15. Big/binary files must not hang =="
# NUL-free TEXT over 20 MB: /dev/zero hit the binary check, not the size check (mutation-proven 2026-09-08).
yes "$(head -c 100 /dev/urandom | base64)" | head -c 22000000 > "$T/huge.txt"
S=$(date +%s)
run 0 "15a. Read a 21 MB file → allow (size check before counting)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/huge.txt\"}}"
E=$(( $(date +%s) - S ))
[ "$E" -le 2 ] && pass "15b. ...and returns in ${E}s (<=2s)" || fail "15b. 21 MB returns fast" "${E}s" "<=2s"
printf 'a\0b\n' > "$T/bin.dat"; seq 1 400 >> "$T/bin.dat"
run 0 "15c. binary file over threshold → allow" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/bin.dat\"}}"
run 0 "15d. directory path → allow" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T\"}}"

echo "== 16. Prompt-file exemption (40% of blocks, measured 2026-09-16) =="
# Bidirectional by construction, like the rest of this suite. The exemption is a WIDENING of
# the pass set, so the cases that matter are the ones that must STILL BLOCK. The exemption has
# FOUR conjuncts and each has its own positive control — delete any one and exactly one of
# these goes red: 16d ceiling · 16e extension · 16f basename · 16j counted.exact.
# (An earlier version of this comment said THREE and omitted counted.exact; the suite stayed
# 62/62 with that conjunct deleted while a 12,000-line file passed. Review 2026-09-16.)
seq 1 500 > "$T/maker_prompt.txt"          # name ✔ ext ✔ exact ✔ ceiling ✔ → exempt
seq 1 500 > "$T/report_template.txt"       # bare `template`, no separator   → exempt
seq 1 1200 > "$T/huge_prompt.txt"          # name ✔ ext ✔ OVER ceiling ✘     → block
seq 1 500 > "$T/promptBuilder.ts"          # name ✔ ext ✘ (code, not prose)  → block
seq 1 500 > "$T/notes.txt"                 # name ✘ ext ✔                    → block
seq 1 500 > "$T/prompt-restructure.md"     # name ✔ but .md is NOT exempt    → block
rm -f "$TELEM"
run 0 "16a. Read 500-line maker_prompt.txt → allow (exempt)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/maker_prompt.txt\"}}"
tail -1 "$TELEM" | grep -q '"action":"exempt-prompt"' && tail -1 "$TELEM" | grep -q '"lines":500' \
  && tail -1 "$TELEM" | grep -q '"exact":true' \
  && pass "16b. ...and logs action:exempt-prompt with lines + exact" \
  || fail "16b. logs action:exempt-prompt with lines + exact" "$(tail -1 "$TELEM")" 'action=exempt-prompt lines=500 exact=true'
run 0 "16c. Read 500-line report_template.txt → allow (bare 'template', no separator)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/report_template.txt\"}}"
run 2 "16d. Read 1200-line huge_prompt.txt → BLOCK (ceiling is live, POSITIVE CONTROL)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/huge_prompt.txt\"}}"
run 2 "16e. Read 500-line promptBuilder.ts → BLOCK (code ext, POSITIVE CONTROL)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/promptBuilder.ts\"}}"
run 2 "16f. Read 500-line notes.txt → BLOCK (name condition, POSITIVE CONTROL)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/notes.txt\"}}"
run 0 "16g. Bash \`cat maker_prompt.txt\` → allow (exemption covers the Bash path too)" \
      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $T/maker_prompt.txt\"}}"
# Placement proof: exempt-prompt is evaluated AFTER the would-block decision, so a SMALL
# prompt file must produce no row at all. Placed earlier it would log every prompt read and
# the exemption rate would stop being a measurement.
seq 1 100 > "$T/tiny_prompt.txt"
rm -f "$TELEM"
run 0 "16h. Read 100-line tiny_prompt.txt → allow" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/tiny_prompt.txt\"}}"
if [ -f "$TELEM" ]; then N=$(wc -l < "$TELEM" | tr -d ' '); else N=0; fi
[ "$N" = 0 ] && pass "16i. NO exempt row for a prompt read that would not have blocked" \
  || fail "16i. NO exempt row for a prompt read that would not have blocked" "$N" "0"

# --- 16j: positive control for the FOURTH conjunct, `counted.exact` --------------------
# LINE WIDTH is the whole trick, and a fixture built with `seq` CANNOT reach the failing state.
# countLines stops early once lines > limit when the file is over EXACT_COUNT_BYTES (2 MB), and
# reports whatever it had counted in that partial chunk. With ~60-byte lines the first 64 KB
# chunk already holds ~1090 lines, which overshoots the 1050 ceiling, so the mutant blocks too
# and the case passes for the wrong reason. At ~100 bytes/line the partial count lands ~655 —
# under the ceiling — so the guard is the ONLY thing standing between a 30,000-line file and a
# pass. Verified: with `counted.exact &&` deleted this file exits 0 and logs "exact":true.
python3 -c "
import sys
with open(sys.argv[1],'w') as f:
    for i in range(30000): f.write('%06d ' % i + 'x'*92 + '\n')
" "$T/huge_wide_prompt.txt"
rm -f "$TELEM"
run 2 "16j. Read a 3 MB / 30000-line wide-line prompt.txt → BLOCK (counted.exact, POSITIVE CONTROL)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/huge_wide_prompt.txt\"}}"
tail -1 "$TELEM" | grep -q '"exact":false' && tail -1 "$TELEM" | grep -q '"lines":null' \
  && pass "16k. ...and logs lines:null, never a partial count as if exact" \
  || fail "16k. logs lines:null on a capped count" "$(tail -1 "$TELEM")" 'exact=false lines=null'

# --- 16l: the exemption honours `offset`, like the would-block rule it sits behind -----
seq 1 1200 > "$T/offset_prompt.txt"
run 0 "16l. Read 1200-line prompt.txt with offset:600 → allow (remainder 601 ≤ 1050)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/offset_prompt.txt\",\"offset\":600}}"

# --- 16m: ceiling boundary. Catches an off-by-one flip of `<=` to `<`. -----------------
seq 1 1050 > "$T/edge_ok_prompt.txt"
seq 1 1051 > "$T/edge_no_prompt.txt"
run 0 "16m. Read exactly 1050-line prompt.txt → allow (ceiling is inclusive)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/edge_ok_prompt.txt\"}}"
run 2 "16n. Read 1051-line prompt.txt → BLOCK (one over the ceiling)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/edge_no_prompt.txt\"}}"

# --- 16o: the ceiling tracks CLAUDE_READ_SIZE_LIMIT (3x), it is not frozen at 1050 -----
# Pins the coupling either way: a future change to an absolute ceiling must update this case
# deliberately rather than shipping green. 1700 lines blocks at the default limit (>1050) and
# exempts at limit=600 (ceiling 1800).
seq 1 1700 > "$T/k17_prompt.txt"
run 2 "16p. 1700-line prompt.txt at default limit → BLOCK (over 1050)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/k17_prompt.txt\"}}"
run 0 "16q. ...same file at CLAUDE_READ_SIZE_LIMIT=600 → allow (ceiling tracks limit → 1800)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/k17_prompt.txt\"}}" CLAUDE_READ_SIZE_LIMIT=600

# --- 16r: .md is NOT exempt. The measured cluster was 210/210 .txt; .md is the extension
# of learnings/, specs/ and research/, where delegating to a subagent is the RIGHT move.
run 2 "16r. Read 500-line prompt-restructure.md → BLOCK (.md deliberately not exempt)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/prompt-restructure.md\"}}"

# --- 16s: rename laundering. basename comes from realpath, not the symlink. ------------
# S69 (2026-08-27) closed 5 review-gate evasions, one of them rename laundering; the exemption
# must not reopen a one-symlink version of it.
seq 1 900 > "$T/schema.rb"
ln -sf "$T/schema.rb" "$T/schema_prompt.txt"
run 2 "16s. Read a *_prompt.txt symlink pointing at a 900-line .rb → BLOCK (realpath, not link name)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$T/schema_prompt.txt\"}}"

echo "== 17. Session-spill exemption (7 of 11 post-tune fires were friction, measured 2026-10-04) =="
# Shapes copied from the real fires (telemetry/read-size-gate.jsonl, traced to transcripts):
#   5 × /private/tmp/claude-501/<project-slug>/<session_id>/scratchpad/<file>  (3 subagent
#       reports Written by a subagent, 2 extraction dumps from a main-session Bash redirect)
#   1 × ~/.claude/projects/<project-slug>/<session_id>/tool-results/<id>.txt  (harness spill)
# Every one was then read whole in 2-3 chunks, so the block saved nothing and cost a turn.
# The 4 true catches were project files (a .py, a _spec.rb, a .py via cat, a results.md) —
# 17f keeps that shape blocking. The 7th friction fire (a project-dir coverage.md) is NOT
# exempted: no path rule separates it from the results.md true catch.
#
# Positive controls, one per conjunct: 17d session match · 17e session present · 17g ceiling ·
# 17h tool-results session match · 17i realpath · 17j tmp-root anchor · 17f project file.
SID="11111111-2222-3333-4444-555555555555"
OTHER="99999999-8888-7777-6666-555555555555"
SPROOT="/tmp/claude-$(id -u)/read-size-canary-$$"   # same root the harness uses for scratchpads
trap 'rm -rf "$T" "$SPROOT"' EXIT
SP="$SPROOT/$SID/scratchpad"
TR="$T/.claude/projects/-canary-slug/$SID/tool-results"
TRO="$T/.claude/projects/-canary-slug/$OTHER/tool-results"
mkdir -p "$SP/laneD" "$TR" "$TRO" "$T/proj" "$T/$SID/scratchpad"
seq 1 423 > "$SP/report.md"            # subagent report shape
seq 1 622 > "$SP/laneD/options.html"   # nested subdir under scratchpad
seq 1 979 > "$SP/dump.txt"                # largest observed friction fire
seq 1 1200 > "$SP/huge.txt"                # over the 3x ceiling
seq 1 389 > "$TR/bshdrwkm4.txt"            # tool-results spill shape
seq 1 389 > "$TRO/bshdrwkm4.txt"
seq 1 656 > "$T/proj/script.py"    # true-catch shape (project code file)
seq 1 500 > "$T/$SID/scratchpad/notes.md"  # right tail, wrong root
ln -sf "$T/proj/script.py" "$SP/linked.py"
rm -f "$TELEM"
run 0 "17a. Read own-session scratchpad report (423) → allow" \
      "{\"tool_name\":\"Read\",\"session_id\":\"$SID\",\"tool_input\":{\"file_path\":\"$SP/report.md\"}}"
tail -1 "$TELEM" | grep -q '"action":"exempt-spill"' && tail -1 "$TELEM" | grep -q '"lines":423' \
  && pass "17a2. ...and logs action:exempt-spill with lines" \
  || fail "17a2. logs action:exempt-spill" "$(tail -1 "$TELEM")" 'action=exempt-spill lines=423'
run 0 "17b. Read own-session tool-results spill (389) → allow" \
      "{\"tool_name\":\"Read\",\"session_id\":\"$SID\",\"tool_input\":{\"file_path\":\"$TR/bshdrwkm4.txt\"}}"
run 0 "17c. Read own-session scratchpad 979-line dump → allow (under 3x ceiling)" \
      "{\"tool_name\":\"Read\",\"session_id\":\"$SID\",\"tool_input\":{\"file_path\":\"$SP/dump.txt\"}}"
run 0 "17c2. Read own-session scratchpad nested subdir (622) → allow" \
      "{\"tool_name\":\"Read\",\"session_id\":\"$SID\",\"tool_input\":{\"file_path\":\"$SP/laneD/options.html\"}}"
run 0 "17k. Bash \`cat\` own-session scratchpad report → allow" \
      "{\"tool_name\":\"Bash\",\"session_id\":\"$SID\",\"tool_input\":{\"command\":\"cat $SP/report.md\"}}"
run 2 "17d. ANOTHER session's scratchpad → BLOCK (session match, POSITIVE CONTROL)" \
      "{\"tool_name\":\"Read\",\"session_id\":\"$OTHER\",\"tool_input\":{\"file_path\":\"$SP/report.md\"}}"
run 2 "17e. scratchpad with NO session_id in payload → BLOCK (fails closed)" \
      "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$SP/report.md\"}}"
run 2 "17f. 656-line project .py (true-catch shape) → BLOCK (POSITIVE CONTROL)" \
      "{\"tool_name\":\"Read\",\"session_id\":\"$SID\",\"tool_input\":{\"file_path\":\"$T/proj/script.py\"}}"
run 2 "17g. 1200-line own-session scratchpad file → BLOCK (ceiling, POSITIVE CONTROL)" \
      "{\"tool_name\":\"Read\",\"session_id\":\"$SID\",\"tool_input\":{\"file_path\":\"$SP/huge.txt\"}}"
run 2 "17h. ANOTHER session's tool-results → BLOCK (session match, POSITIVE CONTROL)" \
      "{\"tool_name\":\"Read\",\"session_id\":\"$SID\",\"tool_input\":{\"file_path\":\"$TRO/bshdrwkm4.txt\"}}"
run 2 "17i. scratchpad symlink → 656-line project .py → BLOCK (realpath, not link location)" \
      "{\"tool_name\":\"Read\",\"session_id\":\"$SID\",\"tool_input\":{\"file_path\":\"$SP/linked.py\"}}"
run 2 "17j. <sid>/scratchpad/ outside the tmp root → BLOCK (root anchor, POSITIVE CONTROL)" \
      "{\"tool_name\":\"Read\",\"session_id\":\"$SID\",\"tool_input\":{\"file_path\":\"$T/$SID/scratchpad/notes.md\"}}"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] && exit 0 || exit 1
