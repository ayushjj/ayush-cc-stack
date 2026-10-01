#!/usr/bin/env bash
# Hook LIVENESS canary — does each wired guard still *fire*?
#
# WHY THIS EXISTS
#   A guard that fails open is silent when it works and silent when it is dead.
#   There is no observable difference, so a dead guard reads exactly like a clean
#   week. Guards in this repo have sat wired, documented as blocking, and
#   enforcing nothing for weeks at a time.
#   Incident history: learnings/2026-07-09-hook-liveness-fail-open.md
#
# WHAT IT ASSERTS  (both directions — a guard that blocks everything is as broken
#   as one that blocks nothing)
#     1. block-case → hook must exit 2
#     2. allow-case → hook must exit 0
#   with CLAUDE_TOOL_INPUT and the guards' skip/warn env valves stripped, so a
#   hook that reads the env instead of stdin, or that is silently skip-flagged,
#   FAILS here.
#
# ISOLATION (do not remove)
#   /careful and /freeze read their flag files from os.tmpdir(). That path is
#   machine-global and shared by every concurrent session. An earlier version of
#   this canary wrote those live flags and restored them from a snapshot; under
#   concurrency that lost-updates a real /freeze boundary, and a SIGKILL between
#   write and restore strands a flag that silently activates a mode the user never
#   invoked. A test must never borrow the production control plane it is testing.
#   Instead we hand each guard a private TMPDIR, so it reads a sandbox flag and the
#   real flags are never opened. No snapshot, no restore, nothing to leak.
#
# FALSIFIABILITY (a check you have never seen fail is not evidence)
#   §5 runs a reconstructed env-var-reading (always-dead) hook through the REAL
#      probe() and asserts it FAILS its block-case. CLAUDE_TOOL_INPUT is exported
#      first, so if probe() ever stops stripping it, §5 goes red.
#   §6 runs a reconstructed O_NONBLOCK-racing hook through the REAL slow_probe and
#      asserts it fails open. If it does not, the delay no longer exceeds node's
#      startup on this machine and §6 has no teeth — that is reported as a FAILURE,
#      not passed over in silence.
#   §8 was mutation-tested on 2026-08-07: three mutations to precompact-guard.js
#      (ownership check → false; drop `&& dirtyCount > 0`; TTL 10min → 10000min) all
#      turn it RED, and the file restores byte-identical. The TTL mutation initially
#      SURVIVED because the stale fixture's marker was unowned, so the ownership branch
#      produced the same "allow" by another route — two clauses covering for each other.
#      The fixture now uses a LIVE matching owner, which is what makes the TTL the only
#      clause under test. Re-run those three before trusting §8 after any hook edit.
#
# WHAT IT DOES **NOT** COVER (named, never silently dropped)
#     check-anticheat.js, check-eval-first.js, check-review-gate.js
#         → covered by hooks/tests/gate-hooks-canary.sh (they need fake git repos).
#           One ruler per hook; not duplicated here.
#     check-wrap-collision.js, git-sync-lock.js
#         → covered by hooks/tests/wrap-mutex-race-test.sh (stdin-fed bidirectional
#           smoke for the former; the latter is a CLI, driven as /wrap Step 8 drives it).
#     context-wrap-trigger.js
#         → covered by gate-hooks-canary.sh §7 (model→window denominator pairs).
#     memory-size-gate.js, session-manifest.js
#         → covered by hooks/tests/session-manifest-canary.sh.
#     check-read-size.js
#         → covered by hooks/tests/read-size-canary.sh (Read/Bash oversized-read gate:
#           positive control, quote trap, hostile filename, valves, telemetry, no-hang).
#     precompact-guard.js
#         → NOW COVERED, §8 below. This entry used to read "observer: no exit-2 path
#           reachable from a stdin payload. UNCOVERED." That was true and misleading:
#           the hook reads NO stdin at all, so "no stdin payload reaches it" describes
#           one channel, not testability. Its inputs are the wrap marker file, cwd git
#           state, and two env valves — four exit-2 branches reachable through those.
#           Lesson: enumerate a hook's ACTUAL inputs before recording it uncoverable.
#
# Exit: 0 all green · 1 a guard is not firing · 3 canary infrastructure broken

set -uo pipefail

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
PASS=0; FAIL=0
RED=$'\033[31m'; GRN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'

# Infrastructure failure must be distinguishable from a dead guard, or the wrapper
# cries "enforcement OFF" when the real problem is that node is not on PATH.
command -v node >/dev/null 2>&1 || { echo "INFRA: node not on PATH — canary cannot run."; exit 3; }

SANDBOX="$(mktemp -d)" || { echo "INFRA: cannot create sandbox tmpdir."; exit 3; }
trap 'rm -rf "$SANDBOX"' EXIT INT TERM

BLOCK_CD='{"tool_name":"Bash","tool_input":{"command":"cd scripts && ls"}}'

# probe <label> <want-exit> <hook> <payload> [extra env assignments…]
#   Strips CLAUDE_TOOL_INPUT (stdin is the only legal channel) and the
#   cd-guard's documented escape valves (else an exported valve = false red).
probe() {
  local label="$1" want="$2" hook="$3" payload="$4"; shift 4
  if [ ! -f "$hook" ]; then
    printf "  ${RED}✗ MISSING${OFF} %s ${DIM}(%s)${OFF}\n" "$label" "$hook"; FAIL=$((FAIL+1)); return
  fi
  local got
  printf '%s' "$payload" | env -u CLAUDE_TOOL_INPUT \
      -u CLAUDE_CD_PERSISTENCE_SKIP -u CLAUDE_CD_PERSISTENCE_WARN_ONLY \
      "$@" node "$hook" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$want" ]; then
    printf "  ${GRN}✅${OFF} %s ${DIM}(exit %s)${OFF}\n" "$label" "$got"; PASS=$((PASS+1))
  else
    printf "  ${RED}❌ %s — expected exit %s, got %s${OFF}\n" "$label" "$want" "$got"; FAIL=$((FAIL+1))
  fi
}

# slow_probe <label> <want-exit> <hook> <payload> [extra env…]
#   Delays the first byte on stdin. `process.stdin.isTTY` flips fd 0 to O_NONBLOCK,
#   so readFileSync(0) then EAGAINs, the catch swallows it, and the guard exits 0.
#   A normal pipe delivers byte 0 instantly and never triggers this — which is why
#   §1-§4 stay green on a guard that is wide open in the real harness.
slow_probe() {
  local label="$1" want="$2" hook="$3" payload="$4"; shift 4
  local got
  # Capture NODE's exit code, not the pipeline's: a fail-open hook exits immediately,
  # the writer then hits a closed pipe, and pipefail would report SIGPIPE (141) —
  # a true failure with a false reason.
  got=$( ( sleep 0.3; printf '%s' "$payload" ) \
         | { env -u CLAUDE_TOOL_INPUT -u CLAUDE_CD_PERSISTENCE_SKIP \
                 -u CLAUDE_CD_PERSISTENCE_WARN_ONLY "$@" node "$hook" >/dev/null 2>&1; echo $?; } )
  if [ "$got" -eq "$want" ]; then
    printf "  ${GRN}✅${OFF} %s ${DIM}(exit %s)${OFF}\n" "$label" "$got"; PASS=$((PASS+1))
  else
    printf "  ${RED}❌ %s — expected exit %s, got %s${OFF}\n" "$label" "$want" "$got"; FAIL=$((FAIL+1))
  fi
}

echo "═══ hook liveness canary ═══"

echo; echo "§1 check-cd-persistence.js"
H="$CLAUDE_DIR/hooks/check-cd-persistence.js"
probe "BLOCK relative cd"    2 "$H" "$BLOCK_CD"
probe "ALLOW absolute cd"    0 "$H" '{"tool_name":"Bash","tool_input":{"command":"cd /tmp && ls"}}'
probe "ALLOW subshell cd"    0 "$H" '{"tool_name":"Bash","tool_input":{"command":"(cd scripts && ls)"}}'
probe "ALLOW benign command" 0 "$H" '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}'

echo; echo "§2 check-skill-slug.js"
H="$CLAUDE_DIR/hooks/check-skill-slug.js"
probe "BLOCK shorthand slug" 2 "$H" '{"tool_name":"Skill","tool_input":{"skill":"wrap"}}'
probe "ALLOW real slug"      0 "$H" '{"tool_name":"Skill","tool_input":{"skill":"wrapping-session"}}'

echo; echo "§3 check-destructive.js ${DIM}(sandboxed /careful — real flag untouched)${OFF}"
H="$CLAUDE_DIR/skills/careful/scripts/check-destructive.js"
: > "$SANDBOX/.claude-careful-mode"
probe "BLOCK git push --force" 2 "$H" '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' TMPDIR="$SANDBOX"
probe "ALLOW benign command"   0 "$H" '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}'                        TMPDIR="$SANDBOX"

echo; echo "§4 check-freeze.js ${DIM}(sandboxed /freeze — real flag untouched)${OFF}"
H="$CLAUDE_DIR/skills/freeze/scripts/check-freeze.js"
printf '%s' "$SANDBOX/frozen-dir" > "$SANDBOX/.claude-freeze-dir"
probe "BLOCK write outside frozen" 2 "$H" "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$SANDBOX/elsewhere/x.ts\"}}"  TMPDIR="$SANDBOX"
probe "ALLOW write inside frozen"  0 "$H" "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$SANDBOX/frozen-dir/x.ts\"}}" TMPDIR="$SANDBOX"

echo; echo "§5 DEAD-HOOK DETECTION ${DIM}(does probe() strip CLAUDE_TOOL_INPUT?)${OFF}"
# The pre-fix reader: env var only, never stdin. Wired, documented, inert.
DEAD="$SANDBOX/dead-env-reader.js"
cat > "$DEAD" <<'DEADHOOK'
let command = '';
try { const p = JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}');
      command = (p.tool_input && p.tool_input.command) || ''; } catch {}
if (!command) process.exit(0);                       // ← the silent fail-open
if (/(^|[;&|])\s*cd\s+[^/~$-]/.test(command)) process.exit(2);
process.exit(0);
DEADHOOK
# Export it: if probe() ever stops stripping CLAUDE_TOOL_INPUT, this dead hook
# reads the env, exits 2, and §5 goes RED. That is the falsification.
export CLAUDE_TOOL_INPUT="$BLOCK_CD"
probe "dead env-var reader FAILS its block-case → canary can go red" 0 "$DEAD" "$BLOCK_CD"
unset CLAUDE_TOOL_INPUT

echo; echo "§6 SLOW-FIRST-BYTE RACE ${DIM}(the bug a fast pipe cannot see)${OFF}"
# Self-proof FIRST: a reconstructed racing hook must fail open under slow_probe.
# If it blocks, the 300ms delay no longer exceeds node's startup here and §6 is
# a decorative always-green tripwire — report that as a FAILURE.
RACY="$SANDBOX/racy-reader.js"
cat > "$RACY" <<'RACYHOOK'
let raw = '';
try { if (!process.stdin.isTTY) raw = require('fs').readFileSync(0, 'utf8'); } catch {}
let command = '';
try { const p = raw.trim() ? JSON.parse(raw) : {};
      command = (p.tool_input && p.tool_input.command) || ''; } catch {}
if (!command) process.exit(0);
if (/(^|[;&|])\s*cd\s+[^/~$-]/.test(command)) process.exit(2);
process.exit(0);
RACYHOOK
slow_probe "racing reader fails open under a slow first byte → §6 has teeth" 0 "$RACY" "$BLOCK_CD"

slow_probe "check-cd-persistence still blocks" 2 "$CLAUDE_DIR/hooks/check-cd-persistence.js" "$BLOCK_CD"
slow_probe "check-skill-slug still blocks"     2 "$CLAUDE_DIR/hooks/check-skill-slug.js" \
           '{"tool_name":"Skill","tool_input":{"skill":"wrap"}}'
slow_probe "check-destructive still blocks"    2 "$CLAUDE_DIR/skills/careful/scripts/check-destructive.js" \
           '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' TMPDIR="$SANDBOX"
slow_probe "check-freeze still blocks"         2 "$CLAUDE_DIR/skills/freeze/scripts/check-freeze.js" \
           "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$SANDBOX/elsewhere/x.ts\"}}" TMPDIR="$SANDBOX"

echo; echo "§7 SHARED-READER LOAD FAILURE ${DIM}(one module, five guards)${OFF}"
# The five migrated guards hard-depend on lib/hook-input.js. Consolidation traded
# eight independent copies for one shared point of failure: if the module cannot
# load, `require` throws, node exits 1 — and exit 1 is NOT a block. Unfixed, that
# fails OPEN for the two guards whose whole job is to block danger.
#
# The opt-in safety guards must fail CLOSED: the user explicitly asked for
# protection, and deactivating the mode is a trivial escape. "Fails closed" is only
# safe when you can say closed onto WHAT — here, onto a state the user can exit.
#
# No test-only branch in production code (a branch no real caller passes is dead
# code that ships green). Instead: copy the guard where its relative require truly
# cannot resolve, and watch what it does.
mkdir -p "$SANDBOX/skills/careful/scripts" "$SANDBOX/skills/freeze/scripts"
cp "$CLAUDE_DIR/skills/careful/scripts/check-destructive.js" "$SANDBOX/skills/careful/scripts/"
cp "$CLAUDE_DIR/skills/freeze/scripts/check-freeze.js"       "$SANDBOX/skills/freeze/scripts/"
: > "$SANDBOX/.claude-careful-mode"
printf '%s' "$SANDBOX/frozen-dir" > "$SANDBOX/.claude-freeze-dir"
probe "check-destructive fails CLOSED when the shared reader cannot load" 2 \
      "$SANDBOX/skills/careful/scripts/check-destructive.js" \
      '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' TMPDIR="$SANDBOX"
probe "check-freeze fails CLOSED when the shared reader cannot load" 2 \
      "$SANDBOX/skills/freeze/scripts/check-freeze.js" \
      "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$SANDBOX/frozen-dir/x.ts\"}}" TMPDIR="$SANDBOX"

echo; echo "§8 PRECOMPACT-GUARD ${DIM}(marker decision matrix + block-on-dirty)${OFF}"
# ADDED 2026-08-07. This hook was listed above as UNCOVERED, described as an
# "observer: no exit-2 path reachable from a stdin payload". That wording is exactly
# right and was read for years as "untestable" — which it is not. precompact-guard
# reads no stdin at all: its inputs are the WRAP MARKER FILE, the cwd's git state,
# and two env valves. Four documented exit-2 branches are reachable through those.
# The lesson is narrow and reusable: "no stdin payload reaches it" is a statement
# about ONE input channel, not about testability. Enumerate a hook's actual inputs
# before recording it as uncoverable.
#
# ISOLATION: the marker lives at $HOME/.claude/.wrap-in-progress<cwd-slug>, and the
# hook resolves it from process.env.HOME. So a private HOME + a private cwd is total
# isolation — the real marker is never opened, never written, never raced. Same
# doctrine as the TMPDIR sandbox above: never borrow the production control plane.
PCHOME="$SANDBOX/pchome"; PCWD="$SANDBOX/pcwd"
mkdir -p "$PCHOME/.claude" "$PCWD"
PCHOOK="$CLAUDE_DIR/hooks/precompact-guard.js"
# The slug MUST be built from the CANONICAL cwd. `mktemp -d` returns /var/folders/... on
# macOS, which is a symlink to /private/var/folders/...; node's process.cwd() reports the
# resolved path while the shell variable holds the unresolved one. Building the slug from
# $PCWD produced a marker filename the hook never looks at, so every marker case hit
# ENOENT and exited 0 — a test that silently asserted nothing. Same canonicalization trap
# verify_memory_links.py already carries a symlink case for.
PCWD="$(cd "$PCWD" && pwd -P)"
PCSLUG="$(printf '%s' "$PCWD" | tr '/' '-')"
PCMARK="$PCHOME/.claude/.wrap-in-progress$PCSLUG"

# pcprobe <label> <want-exit> [env assignments…] — runs the hook with a private HOME
# inside a private cwd. No stdin is supplied because the hook reads none.
#
# `env`'s -u flags MUST precede any name=value assignment: env stops option parsing at
# the first non-option argument, so `env HOME=x -u FOO node` treats `-u` as the utility
# and exits 127. All eight cases returned 127 on the first run — caught because the
# expected exits were 0 and 2, and 127 matches neither. An assertion that only checked
# "non-zero" would have scored the four BLOCK cases as PASSING on a hook that never ran.
pcprobe() {
  local label="$1" want="$2"; shift 2
  local got
  ( cd "$PCWD" && env -u CLAUDE_FORCE_COMPACT -u CLAUDE_PRECOMPACT_BLOCK \
      HOME="$PCHOME" "$@" node "$PCHOOK" >/dev/null 2>&1 )
  got=$?
  if [ "$got" -eq "$want" ]; then
    printf "  ${GRN}✅${OFF} %s ${DIM}(exit %s)${OFF}\n" "$label" "$got"; PASS=$((PASS+1))
  else
    printf "  ${RED}❌ %s — expected exit %s, got %s${OFF}\n" "$label" "$want" "$got"; FAIL=$((FAIL+1))
  fi
}

# This canary has no pass/fail helpers (those live in gate-hooks-canary.sh); §8 asserts
# marker side-effects too, so it needs them. Scoped here, same counters.
pcok()  { printf "  ${GRN}✅${OFF} %s\n" "$1"; PASS=$((PASS+1)); }
pcno()  { printf "  ${RED}❌ %s — expected %s, got %s${OFF}\n" "$1" "$2" "$3"; FAIL=$((FAIL+1)); }

# --- PAIR 1: live owner vs dead owner. Same marker, same TTL window, opposite
# verdicts, differing ONLY in whether the recorded pid is alive. An implementation
# that ignored the ownership token would return the SAME code for both, so at least
# one of these must fail — the pair cannot pass for the wrong reason.
sleep 45 & LIVEPID=$!
LIVESTART="$(ps -p "$LIVEPID" -o lstart= 2>/dev/null | sed 's/^ *//')"
printf '%s\t%s\n' "$LIVEPID" "$LIVESTART" > "$PCMARK"
pcprobe "live wrap owner within TTL → BLOCK" 2
[ -f "$PCMARK" ] && pcok "BLOCK leaves the marker in place (wrap still owns it)" \
                 || pcno "BLOCK must not delete the marker" "present" "deleted"

# Dead pid: 2^31-ish pid that cannot exist. `ps` returns empty → stillOwned=false.
printf '%s\t%s\n' 2147480000 "$LIVESTART" > "$PCMARK"
pcprobe "DEAD owner pid → clean & ALLOW" 0
[ ! -f "$PCMARK" ] && pcok "orphan marker was CLEARED by the allow path" \
                   || pcno "orphan marker should be unlinked" "deleted" "present"

# RECYCLED pid: the owner pid is ALIVE but its start-time does not match. This is the
# third state in precompact-guard's matrix ("owner dead OR PID recycled") and the entire
# reason the marker stores lstart at all.
#
# ADDED 2026-08-07 by review — it was missing, and its absence was a SECOND instance of
# the two-clauses-covering-for-each-other trap in this same section. Proven by mutation:
#   stillOwned = currentStart !== '' && currentStart === recordedStart
#     → stillOwned = currentStart !== ''
# survives the nine-case suite 29/0, because "dead pid" exercises the `!== ''` half and
# nothing exercises the `===` half. Real consequence of that regression: after a PID
# recycle, a stale marker from a long-dead wrap blocks EVERY compaction for its full TTL,
# and the canary stays green while it happens.
printf '%s\t%s\n' "$LIVEPID" "Mon Jan  1 00:00:00 2000" > "$PCMARK"
pcprobe "live pid + start-time MISMATCH (recycled) → clean & ALLOW" 0
[ ! -f "$PCMARK" ] && pcok "recycled-pid marker was CLEARED" \
                   || pcno "recycled-pid marker should be unlinked" "deleted" "present"
kill "$LIVEPID" 2>/dev/null; wait "$LIVEPID" 2>/dev/null

# --- Stale by mtime: age >= 10min TTL wins BEFORE ownership is consulted.
#
# The owner here must be GENUINELY ALIVE with a MATCHING start-time. That is the whole
# point: if the marker were unowned, "allow" could be produced by either the TTL branch
# or the ownership branch, and the assertion would not name which one it tested.
#
# Measured 2026-08-07 — the first version of this case wrote `$$\tirrelevant`, and
# mutating WRAP_MARKER_TTL_MS 10min → 10000min SURVIVED (29/29 still green): with the
# TTL raised, the ownership check took over and returned "clean & allow" by a different
# route, same exit code. Two clauses covering for each other, which reads as an
# equivalent mutant and is not one. With a live matching owner, raising the TTL now
# flips this case 0 → 2, so the assertion binds to the TTL specifically.
sleep 45 & STALEPID=$!
STALESTART="$(ps -p "$STALEPID" -o lstart= 2>/dev/null | sed 's/^ *//')"
printf '%s\t%s\n' "$STALEPID" "$STALESTART" > "$PCMARK"
python3 -c "import os,sys,time; t=time.time()-660; os.utime(sys.argv[1],(t,t))" "$PCMARK"
pcprobe "marker older than the 10min TTL → clean & ALLOW (even though owner is LIVE)" 0
[ ! -f "$PCMARK" ] && pcok "stale marker was CLEARED" || pcno "stale marker should be unlinked" "deleted" "present"
kill "$STALEPID" 2>/dev/null; wait "$STALEPID" 2>/dev/null

# --- Malformed (legacy 0-byte `touch` marker) inside TTL → BLOCK. This is the
# backwards-compatibility branch; if it ever silently flips to allow, an in-flight
# wrap spanning a hook upgrade loses its protection.
: > "$PCMARK"
pcprobe "malformed/legacy 0-byte marker inside TTL → BLOCK (TTL fallback)" 2

# --- Escape valve outranks a genuine block. Falsifiable against the case above:
# same marker state, opposite verdict, differing only by the env valve.
pcprobe "CLAUDE_FORCE_COMPACT=1 over a blocking marker → ALLOW (valve wins)" 0 CLAUDE_FORCE_COMPACT=1
rm -f "$PCMARK"

# --- PAIR 2: block-on-dirty. Same env valve, same repo, opposite verdicts,
# differing ONLY in whether the tree is dirty. A hook that ignored dirtyCount would
# return the same code twice.
git -C "$PCWD" init -q 2>/dev/null
git -C "$PCWD" config user.email t@t; git -C "$PCWD" config user.name t
printf 'x\n' > "$PCWD/tracked.txt"
git -C "$PCWD" add tracked.txt; git -C "$PCWD" commit -qm base 2>/dev/null
pcprobe "PRECOMPACT_BLOCK=1 + CLEAN tree → ALLOW" 0 CLAUDE_PRECOMPACT_BLOCK=1
printf 'dirty\n' > "$PCWD/untracked.txt"
pcprobe "PRECOMPACT_BLOCK=1 + DIRTY tree → BLOCK" 2 CLAUDE_PRECOMPACT_BLOCK=1
pcprobe "dirty tree WITHOUT the valve → ALLOW (default is warn, never block)" 0

echo
echo "───────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  printf "${GRN}RESULT: %s passed, 0 failed${OFF}\n" "$PASS"; exit 0
else
  printf "${RED}RESULT: %s passed, %s FAILED — a wired guard is not firing.${OFF}\n" "$PASS" "$FAIL"; exit 1
fi
