#!/usr/bin/env bash
# Bidirectional canary for cadence-check.js (S65, 2026-08-22).
# MUST-BE-SILENT + MUST-PRINT cases. A suite with only one direction cannot
# distinguish a working checker from a deleted one (S64).
set -u
SCRIPT="$HOME/.claude/skills/catchup/scripts/cadence-check.js"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
mk() { R="$TMP/$1"; rm -rf "$R"; mkdir -p "$R/.claude/skills/hook-review" "$R/.claude/skills/skill-audit"
  printf 'last_run: "2999-01-01"\n' > "$R/.claude/automate-me-state.yaml"
  printf 'last_run: "2999-01-01"\n' > "$R/.claude/level-up-state.yaml"
  printf 'Next review due: **2999-01-01.**\n' > "$R/.claude/skills/hook-review/SKILL.md"
  printf 'Next review due: ~2999-01-01\n'      > "$R/.claude/skills/skill-audit/SKILL.md"
  printf '| `/prune-memory` | 90 days | x | 2999-01-01 | 2999-01-02 |\n| `/publish-stack` | 90 days | x | 2999-01-01 | 2999-01-02 |\n' > "$R/.claude/governance.md"
  printf '{"model": "opus[1m]", "advisorModel": "fable"}\n' > "$R/.claude/settings.json"
  printf -- '- **Model allocation** (owner, 2999-01-01): main session **Opus 5.5** (`opus[1m]`); `advisorModel: fable` escalates.\n' > "$R/.claude/CLAUDE.md"; }
chk() { # name expect-pattern ("" = must be silent)
  out=$(env -u ANTHROPIC_MODEL HOME="$TMP/$1" node "$SCRIPT" 2>&1)
  if [ -z "$2" ]; then [ -z "$out" ] && { echo "  ok   $1 (silent)"; pass=$((pass+1)); } || { echo "  FAIL $1 expected silence, got: $out"; fail=$((fail+1)); }
  else echo "$out" | grep -q "$2" && { echo "  ok   $1"; pass=$((pass+1)); } || { echo "  FAIL $1 expected /$2/, got: $out"; fail=$((fail+1)); }; fi; }

echo "LEAK SENTINEL — a past date MUST print, else every other case is vacuous"
mk sentinel; printf 'Next review due: **2020-01-01.**\n' > "$TMP/sentinel/.claude/skills/hook-review/SKILL.md"
if ! HOME="$TMP/sentinel" node "$SCRIPT" | grep -q 'hook-review'; then echo "  ABORT: sentinel did not fire — checker is dead"; exit 1; fi
echo "  ok   sentinel fires"; echo

echo "MUST BE SILENT"; mk t1; chk t1 ""
echo "MUST PRINT"
mk t2; printf 'Next review due: **2020-01-01.**\n' > "$TMP/t2/.claude/skills/hook-review/SKILL.md"; chk t2 'hook-review.*overdue'
mk t3; rm "$TMP/t3/.claude/level-up-state.yaml";                                                    chk t3 'level-up.*CANNOT CHECK'
mk t4; printf 'no date\n' > "$TMP/t4/.claude/skills/skill-audit/SKILL.md";                          chk t4 'skill-audit.*CANNOT CHECK'
mk t5; printf 'nothing\n' > "$TMP/t5/.claude/governance.md";                                        chk t5 'prune-memory.*CANNOT CHECK'
mk t6; printf 'last_run: null\n' > "$TMP/t6/.claude/automate-me-state.yaml";                        chk t6 'automate-me: never run'
mk t7; printf 'last_run: "2020-01-01"\n' > "$TMP/t7/.claude/level-up-state.yaml";                   chk t7 'level-up.*overdue'
mk t8; printf '{"model": "claude-fable-5-1[1m]", "advisorModel": "fable"}\n' > "$TMP/t8/.claude/settings.json"; chk t8 'drift: model is'
mk t9; printf '{"model": "opus[1m]"}\n' > "$TMP/t9/.claude/settings.json";                     chk t9 'model-config drift.*advisorModel'
mk t10; printf '# no allocation line\n' > "$TMP/t10/.claude/CLAUDE.md";                           chk t10 'CANNOT CHECK: no "- \*\*Model allocation'
mk t11; printf '{"model": "claude-opus-5[1m]", "advisorModel": "fable"}\n' > "$TMP/t11/.claude/settings.json"; chk t11 'drift: model is "claude-opus-5\[1m\]"'
mk t12; printf '{"model": "opusplan", "advisorModel": "fable"}\n' > "$TMP/t12/.claude/settings.json";          chk t12 'drift: model is "opusplan"'
mk t13; printf -- '- **Model allocation** (owner): main session **Opus 5.5** (`opus[1m]`). `advisorModel` stays `fable`.\n' > "$TMP/t13/.claude/CLAUDE.md"; chk t13 'CANNOT CHECK: no `advisorModel: X`'
mk t14; printf '{bad' > "$TMP/t14/.claude/settings.json";                                                         chk t14 'CANNOT CHECK: settings.json invalid JSON'
mk t15; printf '{"model": "claude-fable-5-1"}\n' > "$TMP/t15/.claude/settings.local.json";                        chk t15 'drift: model is "claude-fable-5-1"'
mk t16; printf '{"model": "opus[1m]", "advisorModel": "claude-fable-5-1"}\n' > "$TMP/t16/.claude/settings.json"; chk t16 ""
mk t17; head -1 "$TMP/t17/.claude/CLAUDE.md" > "$TMP/t17/x"; cat "$TMP/t17/x" "$TMP/t17/x" > "$TMP/t17/.claude/CLAUDE.md"; chk t17 'CANNOT CHECK: 2 "- \*\*Model allocation'
mk t18; grep '^- \*\*Model allocation\*\*' "$HOME/.claude/CLAUDE.md" > "$TMP/t18/.claude/CLAUDE.md"; out=$(env -u ANTHROPIC_MODEL HOME="$TMP/t18" node "$SCRIPT" 2>&1); echo "$out" | grep -q 'model-config — CANNOT CHECK' && { echo "  FAIL t18 live rule line no longer parses: $out"; fail=$((fail+1)); } || { echo "  ok   t18 (live rule parses)"; pass=$((pass+1)); }   # parse-only: live CONFIG drift is the live run's job
mk t19; out=$(ANTHROPIC_MODEL=claude-sonnet-5 HOME="$TMP/t19" node "$SCRIPT" 2>&1); echo "$out" | grep -q 'ANTHROPIC_MODEL' && { echo "  ok   t19"; pass=$((pass+1)); } || { echo "  FAIL t19 expected ANTHROPIC_MODEL override line, got: $out"; fail=$((fail+1)); }
mk t20; printf -- '- **Model allocation** (owner): main session **Opus 5.5** (`opus[1m]`); `advisorModel: none` (off).\n' > "$TMP/t20/.claude/CLAUDE.md"; printf '{"model": "opus[1m]"}\n' > "$TMP/t20/.claude/settings.json"; chk t20 ""
mk t21; printf -- '- **Model allocation** (owner): main session **Opus 5.5** (`opus[1m]`); `advisorModel: none` (off).\n' > "$TMP/t21/.claude/CLAUDE.md"; printf '{"model": "opus[1m]", "advisorModel": "fable"}\n' > "$TMP/t21/.claude/settings.json"; chk t21 'drift: advisorModel is "fable" but CLAUDE.md says none'
echo; echo "pass=$pass fail=$fail"; [ "$fail" -eq 0 ] || exit 1
