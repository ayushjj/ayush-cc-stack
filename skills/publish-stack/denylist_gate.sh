#!/usr/bin/env bash
# denylist_gate.sh — agent-side safety-net leak scan for /publish-stack (B4).
#
# NOT a substitute for the human D7 sweep (decisions.md D7: the user runs the
# final sweep personally on a fresh terminal). This is the Option-Y early-warning
# net: it catches known tokens before the human sweep so prep doesn't waste a
# fresh-terminal pass on an obviously-dirty tree.
#
# Universal by construction (P68): contains NO business tokens. All denylist
# tokens are sourced from ~/.claude/.skill-audit-patterns (private; not in the publish manifest)
# (D1-D5). The self-test seed is extracted from that file at runtime, so this
# script passes its own /skill-audit.
#
# Falsifiable by construction (P72): a self-test seeds a known token into an
# isolated temp dir and asserts the scanner catches it BEFORE trusting any
# "clean" result on the real target. A misconfigured/empty patterns file aborts
# (exit 1) rather than silently passing — the false-negative class that bit the
# authoring session.
#
# Usage: denylist_gate.sh --target /path/to/public/repo
# Exit:  0 = PASS (no hits), 1 = FAIL/abort (hits or missing patterns), 3 = self-test broken.

set -uo pipefail
# Byte-wise matching: under a UTF-8 locale macOS grep silently skips any line holding an
# invalid byte, so a token beside one stray byte passed the gate (measured S78).
export LC_ALL=C

TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$TARGET" ] && [ -d "$TARGET" ] || { echo "ERROR: --target must be an existing dir" >&2; exit 1; }

PATTERNS_FILE="${SKILL_AUDIT_PATTERNS:-$HOME/.claude/.skill-audit-patterns}"
if [ ! -f "$PATTERNS_FILE" ]; then
  echo "ERROR: missing patterns file at $PATTERNS_FILE — refusing to pass silently." >&2
  echo "       (A scan with no patterns is a false all-clear — the false-negative class.)" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$PATTERNS_FILE"

# ---- The scanner ---------------------------------------------------------------
# SCAN_ROOT is what report() sweeps. It is the real target for the live pass and a seeded
# temp dir for the self-test, so the SELF-TEST EXERCISES THE SAME CODE PATH the clean result
# is trusted from. The old self-test grepped $D1 directly in an isolated dir and never
# touched report(): it printed "OK" in every one of the four mutations that then rubber-
# stamped a leak (empty pattern, empty scope, bad regex, excluded dir). A positive control
# that tests a different path than the one under test is P72's "both sides derived from the
# same predicate" in its sibling form.
SCAN_ROOT=""
fails=0
report() {  # name, pattern, "scoped"|"full"
  local name="$1" pattern="$2" mode="$3"
  # An UNSCANNED class is not a PASSED class. This printed SKIP and returned 0, so deleting
  # any of D2_PUB/D3/D4/D5 from the patterns file yielded a green gate over an unswept tree.
  if [ -z "$pattern" ]; then
    printf '  %-28s FAIL (pattern empty — class was never scanned)\n' "$name"
    fails=$((fails+1)); return 0
  fi
  local hits rc
  if [ "$mode" = "scoped" ]; then
    local scope=()
    # governance.md/settings.json/statusline.sh are manifest-published (publish_manifest.txt)
    # and were silently outside every scoped sweep. Only CLAUDE.md has a documented reason to
    # be excluded (its mistake table intentionally carries Nx counts + dates, F-checklist:28).
    for d in skills principles hooks learnings README.md governance.md settings.json statusline.sh; do
      [ -e "$SCAN_ROOT/$d" ] && scope+=("$SCAN_ROOT/$d")
    done
    # bash 3.2 (macOS) errors on "${empty[@]}" under `set -u`; the error went to stderr, grep
    # got nothing, hits was empty and the class reported PASS. A target with none of these
    # paths is not a target that has been cleared — it is a target that was never read.
    if [ "${#scope[@]}" -eq 0 ]; then
      printf '  %-28s FAIL (no scoped paths exist under %s — nothing was scanned)\n' "$name" "$SCAN_ROOT"
      fails=$((fails+1)); return 0
    fi
    hits=$(grep -RniE "$pattern" "${scope[@]}" 2>/dev/null); rc=$?
  else
    # -R rather than -r for portability (GNU grep follows symlinked dirs with -R). On macOS
    # /usr/bin/grep does NOT descend into a symlinked directory under EITHER flag — measured,
    # not assumed, and it contradicts the usual -r/-R folklore. That gap is therefore closed
    # by the symlinked-directory PRECHECK above, which refuses to run rather than under-scan.
    # --exclude-dir=specs was REMOVED: it hid a published directory from ALL FIVE classes at
    # once. If specs/ legitimately trips a pattern, the human must see it and decide — a
    # blanket exclusion on a leak gate is indistinguishable from a leak.
    hits=$(grep -RniE "$pattern" "$SCAN_ROOT" --exclude-dir=.git 2>/dev/null); rc=$?
  fi
  # grep exits 0=match, 1=no match, >=2=ERROR (bad regex, unreadable file, missing binary).
  # rc was discarded entirely, so an error was indistinguishable from "clean" — a malformed
  # pattern made all five classes report PASS.
  if [ "$rc" -ge 2 ]; then
    printf '  %-28s FAIL (grep error rc=%s — scan did not complete)\n' "$name" "$rc"
    fails=$((fails+1)); return 0
  fi
  if [ -z "$hits" ]; then
    printf '  %-28s PASS\n' "$name"
  else
    printf '  %-28s FAIL\n' "$name"
    printf '%s\n' "$hits" | sed 's/^/      /' | head -30
    fails=$((fails+1))
  fi
}

sweep() {  # runs every class against SCAN_ROOT
  report "D1 business/project names" "${D1-}"  full
  # D2_PUB (not D2): publish session-ID set without the D/R label collisions — matches
  # F-prepublish-checklist grep #4. Falls back to D2 if D2_PUB is undefined.
  report "D2 session/record IDs"     "${D2_PUB-${D2-}}"  scoped
  report "D3 production schema"      "${D3-}"  full
  report "D4 absolute user paths"    "${D4-}"  full
  report "D5 part codes / internal"  "${D5-}"  full
}

# ---- Self-test (P72): prove the scanner catches a seeded token in EVERY class -------------
# Seeds one real token per class into a temp tree shaped like a target, then runs the SAME
# sweep() the live pass uses and requires all five to go red. If any class cannot be made to
# fail, its clean result on the real target means nothing.
ST="$(mktemp -d)"
mkdir -p "$ST/skills"
SEEDER="$(dirname "$0")/regex_seed.py"
seed_one() {  # varname pattern -> writes a file containing a string the pattern MATCHES
  local nm="$1" pat="$2" seed
  [ -z "$pat" ] && { echo "ERROR: $nm empty in patterns file — cannot self-test that class." >&2; rm -rf "$ST"; exit 1; }
  # SAMPLE the regex; do not mangle it. Stripping metacharacters was tried and is WRONG:
  # `/Users/[a-zA-Z]+/` strips to `~/`, which the pattern does NOT match, so the
  # self-test declared a working scanner broken and the gate exited 3 on every input --
  # including a clean tree. Caught by the clean-target positive control in the mutation
  # harness; without that control this would have shipped as a gate that can never pass.
  seed="$(python3 "$SEEDER" "$pat" 2>/dev/null)"
  if [ -z "$seed" ] || ! printf '%s' "$seed" | grep -qiE "$pat"; then
    echo "ERROR: cannot construct a seed matching $nm — its self-test would be vacuous." >&2
    echo "       Simplify the pattern or extend regex_seed.py; do NOT trust a clean result." >&2
    rm -rf "$ST"; exit 3
  fi
  printf 'synthetic leak %s here\n' "$seed" > "$ST/skills/selftest_$nm.txt"
}
seed_one D1 "${D1-}"
seed_one D2 "${D2_PUB-${D2-}}"
seed_one D3 "${D3-}"
seed_one D4 "${D4-}"
seed_one D5 "${D5-}"
SCAN_ROOT="$ST"
echo "self-test: seeding one token per class and requiring all five to FAIL..."
sweep >/dev/null 2>&1
if [ "$fails" -ne 5 ]; then
  echo "SELF-TEST FAILED: seeded 5 classes, scanner caught $fails — gate is broken, do NOT trust a clean result." >&2
  rm -rf "$ST"; exit 3
fi
rm -rf "$ST"
fails=0
echo "self-test: OK (all 5 classes caught a seeded token through the real sweep path)"

# ---- Coverage precheck: refuse to scan a tree we cannot fully read ----------------------
# A symlinked DIRECTORY inside the target is invisible to `grep -R` on macOS (measured: BSD
# grep declines to descend into one under both -r and -R, even when the link is named
# directly). Under-scanning silently is the exact false-all-clear this gate exists to prevent,
# so an unreadable shape is a FAILURE, not a PASS. Costs nothing on a normal copied snapshot.
symlinked_dirs="$(find "$TARGET" -type l -not -path '*/.git/*' 2>/dev/null | while IFS= read -r l; do
  [ -d "$l" ] && printf '%s\n' "$l"; done)"
if [ -n "$symlinked_dirs" ]; then
  echo "GATE: FAIL (symlinked directories in the target are not swept by grep -R on this platform):" >&2
  printf '%s\n' "$symlinked_dirs" | sed 's/^/      /' >&2
  echo "      Replace each with a real copy, or scan it separately, then re-run." >&2
  exit 1
fi

echo "publish-stack denylist gate (safety-net) — target: $TARGET"
SCAN_ROOT="$TARGET"
sweep

echo ""
if [ "$fails" -eq 0 ]; then
  echo "GATE: PASS (safety-net only — the human still runs F-prepublish-checklist Part 1 on a fresh terminal)."
  exit 0
else
  echo "GATE: FAIL ($fails class(es) hit). Investigate per match (omit-the-file beats scrub-the-line). Re-run after fixing."
  exit 1
fi
