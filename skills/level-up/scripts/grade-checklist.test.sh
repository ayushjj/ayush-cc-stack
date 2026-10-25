#!/usr/bin/env bash
# Canary for grade-checklist.py: bars pass and fail, bad input is exit 2 (never 1 = "a bar failed").
set -u
G="$HOME/.claude/skills/level-up/scripts/grade-checklist.py"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
t(){ printf '%s' "$2" > "$T/k.json"; printf '%s\n' "$3" > "$T/o.jsonl"; python3 -I "$G" $4 "$T/k.json" "$T/o.jsonl" >/dev/null 2>&1; rc=$?
     [ "$rc" = "$5" ] && { echo "  ok   $1"; pass=$((pass+1)); } || { echo "  FAIL $1 rc=$rc want $5"; fail=$((fail+1)); }; }
K='[{"id":"1","rating":"HIGH"},{"id":"2","rating":"SKIP"}]'
t pass         "$K" '{"id":"1","survived_fast":true,"routes":["note"]}
{"id":"2","survived_fast":false,"routes":["drop"]}' "" 0
t high-dropped "$K" '{"id":"1","survived_fast":false,"routes":["drop"]}
{"id":"2","survived_fast":false,"routes":["drop"]}' "" 1
t skip-kept    "$K" '{"id":"1","survived_fast":true,"routes":["note"]}
{"id":"2","survived_fast":true,"routes":["note"]}' "" 1
t rejected-card '[{"id":"1","rating":"SKIP","reject_terms":["hooks"]}]' '{"id":"1","survived_fast":false,"routes":["setup card — owner"],"card":"Add hooks gate"}' "" 1
t misspelled-rating '[{"id":"1","rating":"Skip"}]' '{"id":"1","survived_fast":false,"routes":["drop"]}' "" 2
t no-rating    '[{"id":"1"}]' '{"id":"1","survived_fast":false,"routes":["drop"]}' "" 2
t string-terms '[{"id":"1","rating":"SKIP","reject_terms":"hooks"}]' '{"id":"1","survived_fast":false,"routes":["drop"]}' "" 2
t empty-key    '[]' '{"id":"1","survived_fast":false,"routes":["drop"]}' "--subset" 2
t list-row     "$K" '["x"]' "" 2
t dict-card    '[{"id":"1","rating":"HIGH"}]' '{"id":"1","survived_fast":true,"routes":["note"],"card":{"a":1}}' "" 2
t dup-row      '[{"id":"1","rating":"HIGH"}]' '{"id":"1","survived_fast":true,"routes":["note"]}
{"id":"1","survived_fast":true,"routes":["note"]}' "" 2
t subset-ignores-other-bad '[{"id":"1","rating":"HIGH"}]' '{"id":"1","survived_fast":true,"routes":["note"]}
{"id":"9","survived_fast":"partial"}' "--subset" 0
t skip-bar-alone "$K" '{"id":"1","survived_fast":true,"routes":["note"]}
{"id":"2","survived_fast":true,"routes":["note"]}' "--subset" 1
t survival-bar-alone '[{"id":"1","rating":"HIGH"},{"id":"3","rating":"MEDIUM"},{"id":"2","rating":"SKIP"}]' '{"id":"1","survived_fast":true,"routes":["note"]}
{"id":"3","survived_fast":true,"routes":["note"]}
{"id":"2","survived_fast":false,"routes":["drop"]}' "" 1
t survival-off-in-subset '[{"id":"1","rating":"HIGH"},{"id":"3","rating":"MEDIUM"},{"id":"2","rating":"SKIP"}]' '{"id":"1","survived_fast":true,"routes":["note"]}
{"id":"3","survived_fast":true,"routes":["note"]}
{"id":"2","survived_fast":false,"routes":["drop"]}' "--subset" 0
t dup-key-id   '[{"id":"1","rating":"HIGH"},{"id":"1","rating":"SKIP"}]' '{"id":"1","survived_fast":false,"routes":["drop"]}' "" 2
t empty-term   '[{"id":"1","rating":"SKIP","reject_terms":[""]}]' '{"id":"1","survived_fast":false,"routes":["drop"]}' "" 2
t no-routes    '[{"id":"1","rating":"HIGH"}]' '{"id":"1","survived_fast":true}' "" 2
t word-boundary '[{"id":"1","rating":"SKIP","reject_terms":["hooks"]}]' '{"id":"1","survived_fast":false,"routes":["setup-card"],"card":"wire up webhooks"}' "" 0
t plural-term  '[{"id":"1","rating":"SKIP","reject_terms":["decision card"]}]' '{"id":"1","survived_fast":false,"routes":["setup-card"],"card":"Add decision cards to the queue"}' "" 1
t symbol-term  '[{"id":"1","rating":"SKIP","reject_terms":["C++"]}]' '{"id":"1","survived_fast":false,"routes":["setup-card"],"card":"port it to c++ now"}' "" 1
t wrapped-term '[{"id":"1","rating":"SKIP","reject_terms":["risk tier"]}]' '{"id":"1","survived_fast":false,"routes":["setup-card"],"card":"a risk\ntier gate"}' "" 1
t blank-term   '[{"id":"1","rating":"SKIP","reject_terms":["  "]}]' '{"id":"1","survived_fast":false,"routes":["drop"]}' "" 2
python3 -I "$G" >/dev/null 2>&1; [ $? = 2 ] && { echo "  ok   no-args"; pass=$((pass+1)); } || { echo "  FAIL no-args"; fail=$((fail+1)); }
# exit codes alone can't tell BAD INPUT from a crash (both 2): check the printed label too (review 2026-10-24)
tl(){ printf '%s' "$2" > "$T/k.json"; printf '%s\n' "$3" > "$T/o.jsonl"; o=$(python3 -I "$G" "$T/k.json" "$T/o.jsonl" 2>&1); rc=$?
     [ "$rc" = "$4" ] && printf '%s' "$o" | grep -q "$5" && { echo "  ok   $1"; pass=$((pass+1)); } || { echo "  FAIL $1 rc=$rc want $4 + '$5'"; fail=$((fail+1)); }; }
KR='[{"id":"1","rating":"SKIP","reject_terms":["hooks"]}]'
tl card-route-no-text "$KR" '{"id":"1","survived_fast":false,"routes":["setup-card"],"card_text":"Add hooks"}' 2 'BAD INPUT'
tl dropped-row-with-card-text "$KR" '{"id":"1","survived_fast":false,"routes":["drop"],"card":"no hooks here"}' 0 'overall survival'
tl rejected-card-label "$KR" '{"id":"1","survived_fast":false,"routes":["setup-card"],"card":"Add hooks"}' 1 'FAIL:.*rejected'
tl pass-label '[{"id":"1","rating":"HIGH"},{"id":"2","rating":"SKIP"}]' '{"id":"1","survived_fast":true,"routes":["note"]}
{"id":"2","survived_fast":false,"routes":["drop"]}' 0 'RESULT: PASS'
o=$(python3 -I "$G" 2>&1); [ $? = 2 ] && printf '%s' "$o" | grep -q 'BAD INPUT' && { echo "  ok   usage-label"; pass=$((pass+1)); } || { echo "  FAIL usage-label"; fail=$((fail+1)); }

echo; echo "pass=$pass fail=$fail"; [ "$fail" -eq 0 ]
