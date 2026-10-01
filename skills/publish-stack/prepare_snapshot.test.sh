#!/usr/bin/env bash
# Known-answer tests for prepare_snapshot.py's copy-time sanitizer (fake tokens only — none
# of them match a real denylist class, so this file survives its own sanitize unchanged).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$HERE/prepare_snapshot.py"
pass=0; fail=0; TMPS=()
trap 'rm -rf "${TMPS[@]}"' EXIT
ok()  { echo "  PASS $1"; pass=$((pass+1)); }
bad() { echo "  FAIL $1"; fail=$((fail+1)); }
setpat() { python3 - "$T/patterns" "$1" "$2" <<'PYEOF'
import sys, re
path, key, val = sys.argv[1:]
txt = open(path).read()
open(path, "w").write(re.sub(rf"^{key}=.*$", f"{key}='{val}'", txt, flags=re.M))
PYEOF
}

setup() {
  T="$(mktemp -d)"; TMPS+=("$T"); S="$T/src"; D="$T/dst"
  mkdir -p "$S/skills/demo" "$S/principles" "$S/hooks" "$D"
  cat > "$T/patterns" <<'P'
D1='acmewidgets'
D2='\bQ[0-9]{3}\b'
D2_PUB='\bQ[0-9]{3}\b'
D3='prod_schema_x'
D4='/home/[a-z]+/'
D5='\bZZ-[0-9]{4}\b'
P
  printf 'file:CLAUDE.md\nfile:settings.json\ndir:principles\ndir:hooks\nskill:demo\n' > "$T/manifest"
  printf 'Built for AcmeWidgets in Q123.\n' > "$S/CLAUDE.md"
  printf '{"note": "part ZZ-1234 in prod_schema_x"}\n' > "$S/settings.json"
  printf 'see Q456 and acmewidgets at /home/bob/x\n' > "$S/skills/demo/SKILL.md"
  printf 'echo zz-9999\n' > "$S/skills/demo/run.sh"
  printf 'principle for acmewidgets\n' > "$S/principles/P50-demo.md"
  printf 'hook\n' > "$S/hooks/h.sh"
}
run() { python3 "$PY" --source "$S" --target "$D" --manifest "$T/manifest" --patterns "$T/patterns" --quiet "$@"; }

echo "t1 tokens replaced in every class + file type"
setup; run; rc=$?
if [ $rc -eq 0 ] && ! grep -RqiE 'acmewidgets|prod_schema_x|ZZ-[0-9]{4}|Q456|/home/bob' "$D"; then ok t1; else bad "t1 rc=$rc"; fi
echo "t2 CLAUDE.md keeps session provenance (D2_PUB scoped) but loses D1"
if grep -q 'Q123' "$D/CLAUDE.md" && ! grep -qi acmewidgets "$D/CLAUDE.md"; then ok t2; else bad t2; fi
echo "t3 settings.json still valid JSON"
if python3 -c "import json;json.load(open('$D/settings.json'))"; then ok t3; else bad t3; fi
echo "t4 refuse when manifest publishes the patterns file"
setup; cp "$T/patterns" "$S/.skill-audit-patterns"; echo 'file:.skill-audit-patterns' >> "$T/manifest"
run --patterns "$S/.skill-audit-patterns" 2>/dev/null; rc=$?
if [ $rc -eq 2 ] && [ ! -e "$D/CLAUDE.md" ]; then ok t4; else bad "t4 rc=$rc"; fi
echo "t5 refuse when a published dir contains the patterns file"
setup; cp "$T/patterns" "$S/hooks/p"; run --patterns "$S/hooks/p" 2>/dev/null; rc=$?
[ $rc -eq 2 ] && ok t5 || bad "t5 rc=$rc"
echo "t5b refuse on a symlink to the patterns file inside a published dir"
setup; ln -s "$T/patterns" "$S/hooks/link"; run 2>/dev/null; rc=$?
[ $rc -eq 2 ] && ok t5b || bad "t5b rc=$rc"
echo "t6 refuse on missing patterns file"
setup; run --patterns "$T/nope" 2>/dev/null; rc=$?
[ $rc -eq 2 ] && ok t6 || bad "t6 rc=$rc"
echo "t7 refuse on an empty class"
setup; setpat D5 ''; run 2>/dev/null; rc=$?
[ $rc -eq 2 ] && ok t7 || bad "t7 rc=$rc"
echo "t8 residual check fires (pattern that matches its own placeholder)"
setup; setpat D3 'redact'; printf 'redact me\n' >> "$S/skills/demo/SKILL.md"
run 2>/dev/null; rc=$?
[ $rc -eq 1 ] && ok t8 || bad "t8 rc=$rc"
echo "t9 protected public file untouched"
setup; printf 'acmewidgets readme\n' > "$D/README.md"; run
grep -q acmewidgets "$D/README.md" && ok t9 || bad t9
echo "t10 files the run did not copy are never rewritten (top-level specs/, nested hand-kept README)"
setup; mkdir -p "$D/specs" "$D/hooks"
printf 'private acmewidgets notes ~/x\n' > "$D/specs/notes.md"
printf 'hand acmewidgets readme\n' > "$D/hooks/README.md"; run
if grep -q 'acmewidgets notes ~/' "$D/specs/notes.md" && grep -q acmewidgets "$D/hooks/README.md"; then ok t10; else bad t10; fi
echo "t11 never writes through a symlink in the target"
setup; printf 'outside acmewidgets\n' > "$T/outside.md"; mkdir -p "$D/skills/demo"; ln -s "$T/outside.md" "$D/skills/demo/SKILL.md"
run 2>/dev/null; rc=$?
if [ $rc -eq 2 ] && grep -q 'outside acmewidgets' "$T/outside.md"; then ok t11; else bad "t11 rc=$rc"; fi
echo "t12 non-UTF-8 file with a token fails the run; .pyc/__pycache__ never copied"
setup; printf '\xff\xfe acmewidgets\n' > "$S/skills/demo/blob.bin"
mkdir -p "$S/skills/demo/__pycache__"; printf 'x' > "$S/skills/demo/__pycache__/m.pyc"
run 2>/dev/null; rc=$?
if [ $rc -eq 1 ] && [ ! -e "$D/skills/demo/__pycache__" ]; then ok t12; else bad "t12 rc=$rc"; fi
echo "t13 overlapping alternatives leave no tail (a|ab on 'AB')"
setup; setpat D1 'acme|acmewidgets'; run; rc=$?
if [ $rc -eq 0 ] && ! grep -qi widgets "$D/skills/demo/SKILL.md"; then ok t13; else bad "t13 rc=$rc"; fi
echo "t14 principles not copied when dir:principles is absent from the manifest"
setup; printf 'file:CLAUDE.md\nskill:demo\n' > "$T/manifest"; run
[ ! -e "$D/principles/P01-demo.md" ] && ok t14 || bad t14
echo "t15 manifest entry with .. is refused before any copy"
setup; echo 'file:../escape.txt' >> "$T/manifest"; printf 'x\n' > "$T/escape.txt"; run 2>/dev/null; rc=$?
if [ $rc -eq 2 ] && [ ! -e "$D/CLAUDE.md" ]; then ok t15; else bad "t15 rc=$rc"; fi

echo "t16 dash-form username in project slugs is normalized (fixture built at run time so the
#     published copy of this file, itself normalized, still carries a real username to test)"
setup; u=bob; printf 'see ~/.claude/projects/-Users-%s-dev-x/memory; Power-Users-Group stays\n' "$u" >> "$S/skills/demo/SKILL.md"; run
if grep -q -- '-dev-x/memory' "$D/skills/demo/SKILL.md" && ! grep -q -- "-Users-$u" "$D/skills/demo/SKILL.md" && grep -q 'Power-Users-Group stays' "$D/skills/demo/SKILL.md"; then ok t16; else bad t16; fi
echo "t17 private principle numbers rewritten in every copied file, overlapping numbers safe"
setup; printf 'second\n' > "$S/principles/P60-second.md"
printf 'cite P50-demo and P60-second\n' > "$S/skills/demo/refs.md"; run
if grep -q 'cite P01-demo and P02-second' "$D/skills/demo/refs.md" && head -1 "$D/principles/P02-second.md" | grep -q '^second'; then ok t17; else bad t17; cat "$D/skills/demo/refs.md"; fi

echo "t18 principle title shows public and private number"
setup; printf '# P50 — demo title\n' > "$S/principles/P50-demo.md"; run
head -1 "$D/principles/P01-demo.md" | grep -qx '# P01 (private P50) — demo title' && ok t18 || bad t18

echo "== $pass passed, $fail failed"; [ $fail -eq 0 ]
