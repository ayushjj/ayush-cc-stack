#!/usr/bin/env bash
# Canary for challenge-check.js (UserPromptSubmit) and checkin-due.js (Stop) — automate-me 2026-10-24.
# Both directions: each hook must fire on a past-shaped case and stay silent on a plain one.
set -u
H="$HOME/.claude/hooks"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }; no() { echo "  FAIL $1"; fail=$((fail+1)); }
cc() { printf '%s' "$1" | jq -Rs '{prompt: .}' | node "$H/challenge-check.js"; }

echo "challenge-check"
for p in "why do you need the key now? wouldn't we need it later?" "have you really checked?" \
         "help me understand why you emphasise that section" "this is the cheaper model, right?"; do
  cc "$p" | grep -q 'questioning a claim' && ok "fires: $p" || no "should fire: $p"
done
for p in "yes go ahead" "status?" "<pasted_content>it is fine, right?</pasted_content> ok"; do
  [ -z "$(cc "$p")" ] && ok "silent: $p" || no "should be silent: $p"
done
[ -z "$(printf 'not json' | node "$H/challenge-check.js")" ] && ok "bad input → silent, exit 0" || no "bad input"

echo "checkin-due"
rep() { printf '{"type":"user","message":{"role":"user","content":"<agent-message from=\\"x\\"> report %s"}}\n' "$1"; }
chk() { printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"**Done**\\n- a\\n**Where we are**: 3 of 5"}]}}\n'; }
for i in 1 2 3 4 5 6; do rep $i; done > "$tmp/six.jsonl"
for i in 1 2 3 4 5; do rep $i; done > "$tmp/five.jsonl"
{ for i in 1 2 3 4 5 6; do rep $i; done; chk; rep 7; } > "$tmp/reset.jsonl"
st() { printf '{"transcript_path":"%s","stop_hook_active":%s}' "$1" "${2:-false}" | node "$H/checkin-due.js"; }
st "$tmp/six.jsonl" | grep -q '"decision":"block"' && ok "6 reports, no check-in → block" || no "6 reports should block"
[ -z "$(st "$tmp/five.jsonl")" ] && ok "5 reports → silent" || no "5 reports should be silent"
[ -z "$(st "$tmp/reset.jsonl")" ] && ok "check-in resets the count" || no "check-in should reset"
[ -z "$(st "$tmp/six.jsonl" true)" ] && ok "stop_hook_active → never blocks twice" || no "must not block twice"
[ -z "$(st /nonexistent)" ] && ok "missing transcript → silent" || no "missing transcript"

echo "RESULT: $pass passed, $fail failed"; [ "$fail" -eq 0 ]
