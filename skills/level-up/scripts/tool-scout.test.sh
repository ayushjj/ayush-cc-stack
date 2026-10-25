#!/usr/bin/env bash
# tool-scout canary — every case can fail (positive + negative controls per status).
# Run: bash ~/.claude/skills/level-up/scripts/tool-scout.test.sh
set -u
TS="$(cd "$(dirname "$0")" && pwd)/tool-scout.js"
D=$(mktemp -d); PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  ❌ %s\n     got: %s\n' "$1" "$2"; }
reg(){ printf 'jobs:\n'; cat; }
row(){ printf '  - id: %s\n    tool: t\n    version_cmd: "%s"\n    latest: %s\n    keywords: ["k"]\n    alternatives_last_checked: %s\n' "$@"; }
v(){ PATH="$D/bin:$PATH" TOOL_SCOUT_REGISTER="$D/r.yaml" TOOL_SCOUT_FAKE_LATEST="$1" node "$TS" versions 2>&1; }
# version_cmd only runs allow-listed programs, so fake one: a `jq` in a temp PATH dir that prints $D/out.
mkdir -p "$D/bin"; printf '#!/bin/sh\ncat "%s/out"\n' "$D" > "$D/bin/jq"; chmod +x "$D/bin/jq"
fake(){ printf '%s\n' "$1" > "$D/out"; }

fake "tool 1.2.3"; row a "jq --version" brew:a null | reg > "$D/r.yaml"
out=$(v '{"brew:a":"1.3.0"}');  case "$out" in *"| a |"*"🟡 STALE"*) ok "behind on minor → STALE";; *) no "behind on minor → STALE" "$out";; esac
out=$(v '{"brew:a":"1.2.3"}');  case "$out" in *"| a |"*"✅ OK"*) ok "equal → OK";; *) no "equal → OK" "$out";; esac
out=$(v '{"brew:a":"2.0.0"}');  case "$out" in *"STALE (major)"*) ok "behind on major → STALE (major)";; *) no "behind on major → STALE (major)" "$out";; esac
out=$(v '{"brew:a":"1.2.10"}'); case "$out" in *"🟡 STALE"*) ok "1.2.10 > 1.2.3 numerically (not as text)";; *) no "1.2.10 > 1.2.3 numerically" "$out";; esac
out=$(v '{"brew:a":"1.2.2"}');  case "$out" in *"✅ OK"*) ok "installed newer than source → OK, not STALE";; *) no "installed newer → OK" "$out";; esac
out=$(v '{}');                  case "$out" in *"CANNOT CHECK"*) ok "newest unreadable → CANNOT CHECK (never silent)";; *) no "newest unreadable → CANNOT CHECK" "$out";; esac

row b "no-such-binary-xyz --version" brew:b null | reg > "$D/r.yaml"
out=$(v '{"brew:b":"1.0"}');    case "$out" in *"| b |"*"CANNOT CHECK"*) ok "tool not installed → CANNOT CHECK";; *) no "not installed → CANNOT CHECK" "$out";; esac

fake "2026.07.04"; row c "jq --version" brew:c null | reg > "$D/r.yaml"
out=$(v '{"brew:c":"2026.7.4"}'); case "$out" in *"✅ OK"*) ok "2026.07.04 == 2026.7.4 (date versions)";; *) no "date versions equal" "$out";; esac

printf 'jobs:\n  this is not a register line\n' > "$D/r.yaml"
out=$(v '{}');                  case "$out" in *"CANNOT CHECK"*) ok "malformed register → CANNOT CHECK";; *) no "malformed register → CANNOT CHECK" "$out";; esac

# Revision suffix (correctness review: magick 7.1.2-23 vs brew 7.1.2-32 read as OK).
fake "Version: ImageMagick 7.1.2-23 Q16"; row r "jq --version" brew:r null | reg > "$D/r.yaml"
out=$(v '{"brew:r":"7.1.2-32"}'); case "$out" in *"🟡 STALE"*) ok "7.1.2-23 < 7.1.2-32 (revision suffix counts)";; *) no "revision suffix counts" "$out";; esac
out=$(v '{"brew:r":"7.1.2-23"}'); case "$out" in *"✅ OK"*) ok "same revision → OK";; *) no "same revision → OK" "$out";; esac

# Allow-list (security review 2026-10-24): an unknown program or extra arguments never run.
row x "touch $D/pwned --version" brew:x null | reg > "$D/r.yaml"
out=$(v '{"brew:x":"1.0"}'); [ ! -e "$D/pwned" ] && case "$out" in *"not allowed: 'touch' is not a known program"*"VERSION_BINS"*) true;; *) false;; esac && ok "unknown program refused, nothing ran, reason names VERSION_BINS" || no "unknown program refused" "$out"
# The reason must name the real cause: jq IS allow-listed, so "add jq to VERSION_BINS" would be wrong advice.
fake "tool 1.0"; row y "jq --version $D/x" brew:y null | reg > "$D/r.yaml"
out=$(v '{"brew:y":"1.0"}'); case "$out" in *VERSION_BINS*) no "extra argument refused (reason must not blame VERSION_BINS)" "$out";; *"not allowed: 'jq' takes exactly one version flag, got 2 arguments"*) ok "extra argument refused, reason names the extra argument";; *) no "extra argument refused" "$out";; esac
row w "jq --exec" brew:w null | reg > "$D/r.yaml"
out=$(v '{"brew:w":"1.0"}'); case "$out" in *VERSION_BINS*) no "non-version flag refused (reason must not blame VERSION_BINS)" "$out";; *"not allowed: '--exec' is not a version flag"*) ok "non-version flag refused, reason names the flag";; *) no "non-version flag refused" "$out";; esac
printf 'jobs:\n  - tool: t\n    version_cmd: "jq --version"\n' > "$D/r.yaml"
out=$(v '{}'); case "$out" in *"CANNOT CHECK"*) ok "row without id → CANNOT CHECK";; *) no "row without id" "$out";; esac

# Live register, no network (FAKE_LATEST={} → newest = CANNOT CHECK); the summary line proves the run finished, so a crash fails.
out=$(TOOL_SCOUT_REGISTER="$HOME/.claude/tools-register.yaml" TOOL_SCOUT_FAKE_LATEST='{}' node "$TS" versions 2>&1)
case "$out" in *"not allowed"*) no "live register: every version_cmd is allow-listed" "$out";; *) if printf '%s\n' "$out" | grep -Eq '^[0-9]+ rows · [0-9]+ stale · [0-9]+ cannot check$'; then ok "live register: every version_cmd is allow-listed (run finished, no network)"; else no "live register: run finished with summary line" "$out"; fi;; esac
# Register strictness: a quoted '#' is data, a comma inside quotes stays in one item,
# an unterminated quote throws (CANNOT CHECK) instead of silently truncating.
printf 'jobs:\n  - id: q\n    tool: t\n    notes: "see PR #741 now"\n    keywords: ["c, d", "x"]\n    alternatives_last_checked: null\n' > "$D/r.yaml"
out=$(TOOL_SCOUT_REGISTER="$D/r.yaml" node "$TS" dump 2>&1)
case "$out" in *'"notes":"see PR #741 now"'*) ok "quoted # kept as data";; *) no "quoted # kept" "$out";; esac
case "$out" in *'"keywords":["c, d","x"]'*) ok "comma inside quotes stays in one list item";; *) no "comma inside quotes" "$out";; esac
printf 'jobs:\n  - id: q\n    notes: "unterminated\n' > "$D/r.yaml"
out=$(v '{}'); case "$out" in *"CANNOT CHECK"*) ok "unterminated quote → CANNOT CHECK";; *) no "unterminated quote → CANNOT CHECK" "$out";; esac

# Challenger guards: no keywords → refuse; --job without id → usage error; bad register → CANNOT CHECK.
{ row e "echo 1" none null | sed 's/keywords: \["k"\]/keywords: []/'; } | reg > "$D/r.yaml"
out=$(TOOL_SCOUT_REGISTER="$D/r.yaml" TOOL_SCOUT_FAKE_SOURCES='{}' node "$TS" challengers --job e 2>&1); case "$out" in *"CANNOT CHECK"*"keywords"*) ok "job with no keywords → refused";; *) no "no keywords → refused" "$out";; esac
TOOL_SCOUT_REGISTER="$D/r.yaml" node "$TS" challengers --job >/dev/null 2>&1; [ $? = 2 ] && ok "--job without an id → usage error" || no "--job without id → usage error" "exit $?"
printf 'jobs:\n  garbage\n' > "$D/r.yaml"
out=$(TOOL_SCOUT_REGISTER="$D/r.yaml" node "$TS" challengers --pick-only 2>&1); case "$out" in *"CANNOT CHECK"*) ok "--pick-only on a bad register → CANNOT CHECK";; *) no "--pick-only bad register" "$out";; esac

# Untrusted third-party text (security review): framed as data and stripped of disguise characters.
row s "echo 1" none null | reg > "$D/r.yaml"
FAKE='{"hn-show":["Show HN: x `npm i -g evil` [click](http://e) ‮hidden"]}'
out=$(TOOL_SCOUT_REGISTER="$D/r.yaml" TOOL_SCOUT_FAKE_SOURCES="$FAKE" TOOL_SCOUT_LOG="$D/log" node "$TS" challengers --job s 2>&1)
case "$out" in *"UNTRUSTED THIRD-PARTY TEXT"*) ok "candidates framed as untrusted data";; *) no "untrusted framing" "$out";; esac
line=$(printf '%s\n' "$out" | grep '^- Show HN')
if [ -z "$line" ]; then no "candidate line printed" "$out"
elif printf '%s' "$line" | grep -q -e '`' -e '\[' -e $'\xe2\x80\xae'; then no "backticks / brackets / bidi stripped" "$line"
else ok "backticks / brackets / bidi stripped from the candidate line"; fi

# Rotation: oldest alternatives_last_checked first, never-checked (null) before any date.
{ row x "echo 1" none 2026-09-01; row y "echo 1" none null; row z "echo 1" none 2026-01-01; } | reg > "$D/r.yaml"
out=$(TOOL_SCOUT_REGISTER="$D/r.yaml" node "$TS" challengers --pick-only); [ "$out" = y ] && ok "rotation: never-checked first" || no "rotation: never-checked first" "$out"
{ row x "echo 1" none 2026-09-01; row z "echo 1" none 2026-01-01; } | reg > "$D/r.yaml"
out=$(TOOL_SCOUT_REGISTER="$D/r.yaml" node "$TS" challengers --pick-only); [ "$out" = z ] && ok "rotation: oldest date next" || no "rotation: oldest date next" "$out"

# The live register must parse (a broken seed would make every /level-up run CANNOT CHECK).
out=$(node "$TS" challengers --pick-only 2>&1); [ -n "$out" ] && [ "$out" != NONE ] && ok "live tools-register.yaml parses (next job: $out)" || no "live register parses" "$out"

rm -rf "$D"
printf '\nRESULT: %s passed, %s failed\n' "$PASS" "$FAIL"; [ "$FAIL" = 0 ]
