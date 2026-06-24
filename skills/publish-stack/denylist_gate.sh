#!/usr/bin/env bash
# denylist_gate.sh — agent-side safety-net leak scan for /publish-stack (B4).
#
# NOT a substitute for the human D7 sweep (decisions.md D7: the user runs the
# final sweep personally on a fresh terminal). This is the Option-Y early-warning
# net: it catches known tokens before the human sweep so prep doesn't waste a
# fresh-terminal pass on an obviously-dirty tree.
#
# Universal by construction (P68): contains NO business tokens. All denylist
# tokens are sourced from the gitignored ~/.claude/.skill-audit-patterns
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

# ---- Self-test (P72): prove the scanner actually catches a known token --------
SEED="$(printf '%s' "${D1-}" | cut -d'|' -f1)"
if [ -z "$SEED" ]; then
  echo "ERROR: D1 empty in patterns file — cannot self-test the scanner." >&2
  exit 1
fi
ST="$(mktemp -d)"
printf 'synthetic leak %s here\n' "$SEED" > "$ST/selftest.txt"
if ! grep -riE "${D1}" "$ST" >/dev/null 2>&1; then
  echo "SELF-TEST FAILED: scanner did not catch a seeded token — gate is broken, do NOT trust a clean result." >&2
  rm -rf "$ST"; exit 3
fi
rm -rf "$ST"
echo "self-test: OK (scanner catches a seeded token)"

# ---- Real sweep on the target -------------------------------------------------
# D2 (session/record IDs) is scoped to non-provenance dirs — CLAUDE.md's mistake
# table intentionally carries Nx counts + dates and must NOT be swept (F-checklist:28).
fails=0
report() {  # name, pattern, "scoped"|"full"
  local name="$1" pattern="$2" mode="$3"
  [ -z "$pattern" ] && { printf '  %-28s SKIP (empty)\n' "$name"; return 0; }
  local hits
  if [ "$mode" = "scoped" ]; then
    local scope=()
    for d in skills principles hooks learnings README.md; do
      [ -e "$TARGET/$d" ] && scope+=("$TARGET/$d")
    done
    hits=$(grep -rniE "$pattern" "${scope[@]}" 2>/dev/null)
  else
    hits=$(grep -rniE "$pattern" "$TARGET" --exclude-dir=.git --exclude-dir=specs 2>/dev/null)
  fi
  if [ -z "$hits" ]; then
    printf '  %-28s PASS\n' "$name"
  else
    printf '  %-28s FAIL\n' "$name"
    printf '%s\n' "$hits" | sed 's/^/      /' | head -30
    fails=$((fails+1))
  fi
}

echo "publish-stack denylist gate (safety-net) — target: $TARGET"
report "D1 business/project names" "${D1-}"  full
# D2_PUB (not D2): publish session-ID set without the D/R label collisions — matches
# F-prepublish-checklist grep #4. Falls back to D2 if D2_PUB is undefined.
report "D2 session/record IDs"     "${D2_PUB-${D2-}}"  scoped
report "D3 production schema"      "${D3-}"  full
report "D4 absolute user paths"    "${D4-}"  full
report "D5 part codes / internal"  "${D5-}"  full

echo ""
if [ "$fails" -eq 0 ]; then
  echo "GATE: PASS (safety-net only — the human still runs F-prepublish-checklist Part 1 on a fresh terminal)."
  exit 0
else
  echo "GATE: FAIL ($fails class(es) hit). Investigate per match (omit-the-file beats scrub-the-line). Re-run after fixing."
  exit 1
fi
