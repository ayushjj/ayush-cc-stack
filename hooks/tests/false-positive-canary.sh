#!/usr/bin/env bash
# Regression canary for the three false-positive / fail-open defects found by
# /hook-review 2026-08-21. Each case is bidirectional on purpose: every hook has
# MUST-BLOCK cases alongside MUST-PASS ones, so a "fix" that simply guts the guard
# fails this suite instead of passing it.
#
# Provenance (all measured, not inferred — see the review's fire audit):
#   check-cd-persistence.js  31 of 37 fires in 14 days were false positives
#   branch-guard.sh          16 of 21 fires were `git checkout -- <file>` restores
#   check-eval-first.js      failed OPEN on a tests/-shaped dir holding no tests
#
# Run:  bash ~/.claude/hooks/tests/false-positive-canary.sh
exec python3 "$(dirname "$0")/false_positive_canary.py"
