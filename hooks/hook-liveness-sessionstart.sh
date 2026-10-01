#!/usr/bin/env bash
# SessionStart hook: is the enforcement layer actually alive?
#
# WHY AT SESSION START, NOT AT WRAP
#   A dead guard discovered at wrap has already been dead for the whole session.
#   Detection has to precede reliance.
#   Incident history: learnings/2026-07-09-hook-liveness-fail-open.md
#
# WHY IT NEVER BLOCKS
#   A canary that can refuse to start your session is a worse failure than the dead
#   guard it hunts. It reports; it does not gate. stdout on SessionStart is added to
#   the model's context, so a red result is seen by agent and human alike.
#
# WHY A FALSE ALARM IS A REAL BUG
#   A canary that cries wolf trains the operator to ignore red — which is exactly how
#   a genuinely dead guard survives. So: (a) the canary sandboxes the /careful and
#   /freeze flag files instead of borrowing the live ones, and (b) infrastructure
#   failure (exit 3 — e.g. node not on PATH, as when a GUI-launched app hands hooks a
#   minimal environment) is reported as infrastructure, never as "a guard is dead".
#
# Cost: ~2s once per session; §6 deliberately delays four probes' first byte by 300ms.

CANARY="$HOME/.claude/hooks/tests/hook-liveness-canary.sh"

if [ ! -f "$CANARY" ]; then
  echo "⚠️  hook-liveness-canary.sh is MISSING — enforcement layer unverified."
  exit 0
fi

out="$(bash "$CANARY" 2>&1)"
status=$?

case "$status" in
  0) : ;;  # green: say nothing
  3)
    echo "⚠️  Hook liveness UNVERIFIED — the canary could not run (infrastructure, not a dead guard):"
    echo "$out" | sed 's/^/   /'
    echo "   Enforcement may be fine; this check could not tell you either way."
    ;;
  *)
    echo "🚨 HOOK LIVENESS FAILURE — a wired guard is not firing. Treat enforcement as OFF."
    if echo "$out" | grep -qE "❌|MISSING"; then
      echo "$out" | grep -E "❌|MISSING" | sed 's/^/   /'
    else
      # Non-zero with no failing assertion = the canary itself broke mid-run.
      echo "   (no failing assertion found — the canary aborted; full output below)"
      echo "$out" | tail -5 | sed 's/^/   /'
    fi
    echo "   Reproduce: bash ~/.claude/hooks/tests/hook-liveness-canary.sh"
    ;;
esac

exit 0
